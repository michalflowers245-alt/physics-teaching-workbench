/*
 * 长沙初中物理中考真题专题分析引擎
 *
 * 这是课前测面板之外的独立数据域：轻量 UI 状态仍在浏览器，真题快照和
 * 审计投影由 local-server.mjs 写入 SQLite，原卷/页图写入不可变资产目录。
 * 统计函数始终先按来源层级过滤，A/B/C/D/E 不会混合成一张频次榜。
 */
(() => {
  "use strict";

  const ENGINE_STORAGE_KEY = "physics-exam-analysis-engine-v1";
  const ENGINE_ENDPOINT = "/api/physics-exam/engine";
  const PERSIST_DELAY = 420;
  const SOURCE_LAYERS = {
    A: { name: "A. 长沙中考原卷", usage: "长沙高频、趋势与原题证据的唯一核心样本" },
    B: { name: "B. 湖南其他地市中考原卷", usage: "仅用于湖南共同趋势和长沙特色对照" },
    C: { name: "C. 长沙学校/集团联考试卷", usage: "仅反映本地教学重点，不计为中考频次" },
    D: { name: "D. 教材/讲义/专题/练习册", usage: "仅补充训练素材与变式，不计为中考频次" },
    E: { name: "E. 学生作答与错题记录", usage: "仅教师人工校验确认后进入真实易错统计" },
  };
  const REQUIRED_QUESTION_FIELDS = [
    "questionNo",
    "pageNo",
    "score",
    "type",
    "stem",
    "mainPoint",
    "abilities",
    "physicalModel",
    "method",
    "traps",
    "estimatedDifficulty",
  ];
  const RISK_LABELS = [
    [78, "高风险"],
    [50, "中风险"],
    [0, "提示关注"],
  ];

  // 这是可解释的规则初筛，不是把 AI 判断伪装成事实。人工审核可随时修改。
  const POINT_RULES = [
    [/热敏|压敏|力敏|敏感电阻|传感器.*电路/i, "敏感电阻与动态电路"],
    [/动态电路|电表示数|滑动变阻器.*(变化|接入)|电阻.*变化/i, "动态电路中的电表示数变化"],
    [/高低挡|加热|保温|电热器|电功率.*挡/i, "多挡电热器的电路状态判断"],
    [/电流表|电压表|滑动变阻器.*(接线|故障)|故障.*电路/i, "电学实验接线与故障判断"],
    [/小灯泡.*(电阻|电功率)|伏安法.*小灯泡/i, "小灯泡电阻或电功率实验的数据判断"],
    [/凸透镜|物距|像距|成像/i, "凸透镜物距、像距和成像性质"],
    [/浮力|浮沉|漂浮|悬浮|沉底/i, "浮力与物体浮沉状态"],
    [/液体压强|压强.*深度|p.?ρgh/i, "液体压强与深度"],
    [/密度.*浮力|压强.*浮力|浮力.*密度/i, "压强、浮力、密度联合计算"],
    [/杠杆|平衡条件|动力臂|阻力臂/i, "杠杆平衡条件"],
    [/滑轮|机械效率|有用功|额外功/i, "杠杆、滑轮、机械效率联合计算"],
    [/控制变量/i, "控制变量法"],
    [/实验.*(数据|表格|图像)|数据.*(异常|分析)|图像.*(斜率|变化)/i, "实验数据异常识别"],
    [/平衡力|相互作用力/i, "平衡力与相互作用力辨别"],
    [/惯性|运动状态|受力.*关系/i, "惯性、运动状态和受力关系"],
    [/音调|响度|音色/i, "音调、响度、音色辨别"],
    [/物态变化|熔化|凝固|汽化|液化|升华|凝华|吸热|放热/i, "物态变化及吸放热判断"],
    [/电动机|发电机|电磁感应|磁场.*力/i, "电动机、发电机和电磁感应辨别"],
  ];
  const ABILITY_RULES = [
    [/图像|图表|表格|曲线|读图/i, "图表与实验数据提取"],
    [/实验.*(设计|步骤|探究)|控制变量/i, "科学探究与控制变量"],
    [/故障|接线|改正|电路图/i, "实验操作与故障诊断"],
    [/计算|求|质量|功率|效率|压强|密度|电阻/i, "物理建模与定量推理"],
    [/判断|辨别|原因|解释|分析/i, "概念辨析与证据推理"],
  ];

  let persistTimer = null;
  let persistQueue = Promise.resolve();
  let bootstrapPreview = null;
  const materialLibrary = {
    stats: null,
    query: "",
    effectiveQuery: "",
    requestedCount: null,
    appliedFilters: {},
    filters: { layer: "", grade: "", year: "", region: "", role: "", includeDuplicates: false },
    items: [], total: 0, offset: 0, limit: 20, searched: false, loading: false, error: "",
  };
  const curriculumState = { bookId: "grade8_up", sectionId: "8u-1-1", query: "" };
  let questionBrowseReturnFilters = null;

  function defaultEngine() {
    return {
      version: 2,
      uiVersion: 4,
      activeTab: "overview",
      questionFilters: { search: "", layer: "", year: "", region: "", type: "", status: "", curriculumNodeId: "", focus: "", page: 0, view: "browse", preview: "", setId: "" },
      answerQuery: "",
      answerQuestionId: "",
      manualQuestionDraft: {
        sourceFileId: "",
        questionNo: "",
        pageNo: "1",
        score: "",
        type: "选择题",
        stem: "",
        optionsText: "",
        answer: "",
        mainPoint: "",
        secondaryPoints: "",
        abilities: "",
        physicalModel: "",
        method: "",
        confusedConcepts: "",
        traps: "",
        estimatedDifficulty: "",
      },
      importDraft: {
        sourceLayer: "A",
        year: "",
        region: "长沙",
        examType: "中考原卷",
        sourceUrl: "",
        copyrightNote: "",
        paperOriginId: "",
        paperOriginName: "",
        applicableRegions: "",
      },
      files: [],
      canonicalExams: [],
      questions: [],
      attempts: [],
      lessonMappings: {},
      trainingPlans: [],
      questionSets: [],
      auditEvents: [],
      questionAliases: [],
      analysisRuns: [],
      importJobs: [],
      masteryRecords: [],
      settings: { classErrorMinStudents: 3, classErrorRateThreshold: 0.2, thresholdVersion: 1 },
      lastSavedAt: "",
    };
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function ensure(state) {
    if (!state.examEngine || typeof state.examEngine !== "object" || Array.isArray(state.examEngine)) {
      state.examEngine = defaultEngine();
    }
    const engine = state.examEngine;
    const priorUiVersion = Number(engine.uiVersion || 0);
    const fallback = defaultEngine();
    Object.keys(fallback).forEach((key) => {
      if (engine[key] == null) engine[key] = deepClone(fallback[key]);
    });
    ["files", "canonicalExams", "questions", "attempts", "trainingPlans", "questionSets", "auditEvents", "questionAliases", "analysisRuns", "importJobs", "masteryRecords"].forEach((key) => {
      if (!Array.isArray(engine[key])) engine[key] = [];
    });
    if (!engine.lessonMappings || typeof engine.lessonMappings !== "object") engine.lessonMappings = {};
    if (!engine.importDraft || typeof engine.importDraft !== "object") engine.importDraft = deepClone(fallback.importDraft);
    if (!engine.questionFilters || typeof engine.questionFilters !== "object") engine.questionFilters = deepClone(fallback.questionFilters);
    if (!engine.manualQuestionDraft || typeof engine.manualQuestionDraft !== "object") engine.manualQuestionDraft = deepClone(fallback.manualQuestionDraft);
    Object.keys(fallback.questionFilters).forEach((key) => { if (engine.questionFilters[key] == null) engine.questionFilters[key] = fallback.questionFilters[key]; });
    Object.keys(fallback.manualQuestionDraft).forEach((key) => { if (engine.manualQuestionDraft[key] == null) engine.manualQuestionDraft[key] = fallback.manualQuestionDraft[key]; });
    if (typeof engine.answerQuery !== "string") engine.answerQuery = "";
    if (typeof engine.answerQuestionId !== "string") engine.answerQuestionId = "";
    if (priorUiVersion < 3 && !(engine.files || []).length) engine.activeTab = "overview";
    engine.uiVersion = 4;
    Object.keys(fallback.importDraft).forEach((key) => {
      if (engine.importDraft[key] == null) engine.importDraft[key] = fallback.importDraft[key];
    });
    engine.importDraft.sourceLayer = SOURCE_LAYERS[engine.importDraft.sourceLayer] ? engine.importDraft.sourceLayer : "A";
    if (!["overview", "library", "curriculum", "data", "questions", "questionSets", "reports", "errors", "bridge"].includes(engine.activeTab)) engine.activeTab = "overview";
    engine.version = 2;
    return engine;
  }

  async function restore(state, onPreview) {
    // Show real, paged source records before the large recovery snapshot is loaded.
    // This view is explicitly read-only: no partial state can enter a write or analysis.
    if(onPreview){
      bootstrapPreview={items:[],total:null};
      try{const response=await fetch("/api/physics-exam/questions?limit=20",{cache:"no-store",signal:AbortSignal.timeout(1500)});if(response.ok){const page=await response.json();bootstrapPreview.items=Array.isArray(page.items)?page.items.slice(0,20):[];bootstrapPreview.total=Number.isFinite(page.total)?page.total:null;}}catch{}
      onPreview();
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    try{
      await window.ExamSync.restore(state, ensure);
      for (const job of state.examEngine.importJobs) if (["running", "queued"].includes(job.status)) { job.status = "paused"; job.error = "页面已重新打开，可从已保存的检查点恢复"; }
      await loadMaterialStats();
    }finally{bootstrapPreview=null;}
  }

  function schedulePersist(engine) { if(bootstrapPreview)return;invalidateReport(engine); window.ExamSync?.schedule(engine); }

  function view(state) {
    const engine = ensure(state);
    if(bootstrapPreview)return `<section class="exam-engine"><section class="section"><h3>正在恢复本机工作台</h3><p class="hint">先展示数据库中真实的首批题目。完整题库、审核历史和未同步副本正在后台恢复，此时只读，不进行分析或写入。</p>${bootstrapPreview.total==null?'<p>正在连接本机数据库；离线副本也会保留。</p>':`<p>共 ${bootstrapPreview.total} 题 · 首批 ${bootstrapPreview.items.length} 题</p><div class="table-wrap" data-engine-first-list><table class="compact-table"><thead><tr><th>年份／地区</th><th>题号</th><th>题干</th><th>审核状态</th></tr></thead><tbody>${bootstrapPreview.items.map(q=>`<tr><td>${escapeHtml(q.year||"待核对")} ${escapeHtml(q.region||"")}</td><td>${escapeHtml(q.questionNo)}</td><td>${escapeHtml(String(q.stem||"待提取").slice(0,160))}</td><td>${q.reviewed?"已确认":"待审核"}</td></tr>`).join("")}</tbody></table></div>`}</section></section>`;
    const report = engine.activeTab==="questions"?null:buildReport(engine);
    const tabs = [
      ["overview", "开始"],
      ["library", "资料总库"],
      ["curriculum", "知识大纲"],
      ["data", "导入与去重"],
      ["questions", "真题题库"],
      ["questionSets", "学生题单"],
      ["bridge", "课前测接入"],
    ];
    return `
      <section class="exam-engine">
        <section class="engine-intro section">
          <div>
            <p class="eyebrow">真题与练习</p>
            <h3>按知识点找原题，核验后直接给学生用</h3>
            <p class="hint">按章节、考点或年份检索原题，选进题单后核验并下载。</p>
          </div>
          <div class="engine-save-status"><span data-engine-sync-status>${escapeHtml(({saved:"已保存",pending:"待同步",saving:"保存中",conflict:"保存冲突",error:"保存失败",offline:"离线待同步"})[engine.syncStatus] || "连接本机数据服务中")}${engine.syncMessage ? ` · ${escapeHtml(engine.syncMessage)}` : ""}</span><div class="actions compact-actions"><button type="button" class="ghost" data-engine-retry-save>重试保存</button><button type="button" class="ghost" data-engine-private-backup>下载私人恢复副本</button>${engine.syncStatus === "conflict" ? '<button type="button" class="secondary" data-engine-reload-server>保留副本并载入服务器版本</button>' : ''}</div></div>
        </section>
        <nav class="engine-tabs" aria-label="中考分析引擎分区">
          ${tabs.map(([id, label]) => `<button type="button" data-engine-tab="${id}" aria-selected="${engine.activeTab === id}">${label}</button>`).join("")}
          <details class="engine-analysis-more" ${["reports","errors"].includes(engine.activeTab) ? "open" : ""}>
            <summary>趋势与专题</summary>
            <div>${[["reports","趋势分析"],["errors","易错与专题"]].map(([id,label]) => `<button type="button" data-engine-tab="${id}" aria-selected="${engine.activeTab === id}">${label}</button>`).join("")}</div>
          </details>
        </nav>
        ${
          {
            overview: overviewView,
            library: libraryView,
            curriculum: curriculumView,
            data: dataView,
            questions: questionsView,
            questionSets: studentQuestionSetsView,
            reports: reportsView,
            errors: errorsView,
            bridge: bridgeView,
          }[engine.activeTab](state, engine, report)
        }
      </section>`;
  }

  async function loadMaterialStats() {
    try {
      const response = await fetch("/api/physics-exam/library/stats", { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`资料索引返回 ${response.status}`);
      materialLibrary.stats = await response.json();
      materialLibrary.error = "";
    } catch (error) {
      materialLibrary.error = `资料索引暂不可用：${errorMessage(error)}`;
    }
    return materialLibrary.stats;
  }

  async function searchMaterialLibrary({ query, offset = 0 } = {}) {
    materialLibrary.query = query == null ? materialLibrary.query : String(query).trim();
    materialLibrary.offset = Math.max(0, Number(offset) || 0);
    materialLibrary.loading = true;
    materialLibrary.error = "";
    const params = new URLSearchParams({ q: materialLibrary.query, limit: String(materialLibrary.limit), offset: String(materialLibrary.offset) });
    for (const key of ["layer", "grade", "year", "region", "role"]) if (materialLibrary.filters[key]) params.set(key, materialLibrary.filters[key]);
    if (materialLibrary.filters.includeDuplicates) params.set("includeDuplicates", "1");
    try {
      const response = await fetch(`/api/physics-exam/library/search?${params}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || data.error || `检索返回 ${response.status}`);
      materialLibrary.items = Array.isArray(data.items) ? data.items : [];
      materialLibrary.total = Number(data.total || 0);
      materialLibrary.searched = true;
      materialLibrary.searchMode = data.searchMode || "";
      materialLibrary.effectiveQuery = String(data.effectiveQuery || "");
      materialLibrary.requestedCount = Number(data.requestedCount) || null;
      materialLibrary.appliedFilters = data.appliedFilters && typeof data.appliedFilters === "object" ? data.appliedFilters : {};
      if (!materialLibrary.stats) await loadMaterialStats();
    } catch (error) {
      materialLibrary.items = [];
      materialLibrary.total = 0;
      materialLibrary.searched = true;
      materialLibrary.effectiveQuery = "";
      materialLibrary.requestedCount = null;
      materialLibrary.appliedFilters = {};
      materialLibrary.error = `检索失败：${errorMessage(error)}`;
    } finally { materialLibrary.loading = false; }
    return materialLibrary.items;
  }

  function libraryResultCard(item) {
    const layer = SOURCE_LAYERS[item.sourceLayer]?.name || item.sourceLayer || "待分类";
    const meta = [item.grade, item.year ? `${item.year}年` : "", item.region, roleLabel(item.role), item.pageCount ? `${item.pageCount}页` : "", Number(item.familyVersionCount || 1) > 1 ? `同源 ${item.familyVersionCount} 个版本` : ""].filter(Boolean).join(" · ");
    const warnings = (item.warnings || []).slice(0, 2);
    return `<article class="material-result-card"><div class="material-result-head"><div><span class="status-pill ${item.sourceLayer === "A" ? "good" : item.sourceLayer === "C" ? "warn" : ""}">${escapeHtml(layer)}</span><h4>${escapeHtml(item.title || item.fileName)}</h4></div><a class="secondary link-button" target="_blank" rel="noreferrer" href="/api/physics-exam/library/items/${encodeURIComponent(item.id)}/source">${item.extension === "pdf" ? "打开原件" : "下载原件"}</a></div><p class="hint">${escapeHtml(meta || "元数据待核验")} · 约 ${Number(item.questionCountEstimate || 0)} 道编号题</p>${item.snippet ? `<p class="material-snippet">${escapeHtml(item.snippet).replaceAll("【", "<mark>").replaceAll("】", "</mark>")}</p>` : '<p class="hint">该文件暂未提取到可搜索文字；可打开原件人工核对。</p>'}${warnings.length ? `<p class="warning-note">${escapeHtml(warnings.join("；"))}</p>` : ""}<small>来源：${escapeHtml(item.archiveEntry || item.sourcePath || item.fileName)}</small></article>`;
  }

  function libraryResultsView() {
    if (materialLibrary.loading) return '<section class="section material-results"><p class="hint">正在检索本机资料，不会上传文件…</p></section>';
    if (materialLibrary.error) return `<section class="section material-results"><p class="warning-note">${escapeHtml(materialLibrary.error)}</p></section>`;
    if (!materialLibrary.searched) return '<section class="section material-results"><p class="hint">输入题型、知识点、题干中的一句话，或只用筛选条件浏览资料。</p></section>';
    if (!materialLibrary.items.length) return `<section class="section material-results">${emptyState("没有匹配资料", "可缩短关键词，例如把“动态电路中电压表示数变化题”改为“动态电路”或“电压表”。")}</section>`;
    const start = materialLibrary.offset + 1, end = materialLibrary.offset + materialLibrary.items.length;
    const applied = materialLibrary.appliedFilters || {};
    const scope = [applied.layer ? `${applied.layer} 类` : "", applied.grade, applied.year ? `${applied.year} 年` : "", applied.region].filter(Boolean).join(" · ");
    const interpretation = materialLibrary.query && (materialLibrary.effectiveQuery !== materialLibrary.query || scope)
      ? `<p class="search-interpretation">已理解为：<strong>${escapeHtml(materialLibrary.effectiveQuery || "按条件浏览")}</strong>${scope ? `；范围：${escapeHtml(scope)}` : ""}${materialLibrary.requestedCount ? `；希望选 ${materialLibrary.requestedCount} 道题` : ""}</p>` : "";
    return `<section class="section material-results"><div class="section-title-row"><div><h3>找到 ${materialLibrary.total} 份来源资料</h3><p class="hint">当前显示 ${start}–${end}；完全重复以及同源同角色版本默认合并展示，教师版、学生版和答案版仍分开保留。</p>${interpretation}</div></div><div class="material-result-list">${materialLibrary.items.map(libraryResultCard).join("")}</div><div class="actions"><button class="ghost" data-library-page="${Math.max(0, materialLibrary.offset - materialLibrary.limit)}" ${materialLibrary.offset === 0 ? "disabled" : ""}>上一页</button><button class="ghost" data-library-page="${materialLibrary.offset + materialLibrary.limit}" ${end >= materialLibrary.total ? "disabled" : ""}>下一页</button></div></section>`;
  }

  function libraryView() {
    const stats = materialLibrary.stats || {};
    return `<section class="metric-grid">
      ${metricCard("已收录来源", `${Number(stats.total || 0)} 份`, `${Number(stats.uniqueFiles || 0)} 份字节唯一；约 ${Number(stats.uniqueFamilies || 0)} 个同源版本组`)}
      ${metricCard("可全文搜索", `${Number(stats.textDocuments || 0)} 份`, stats.totalPages ? `累计 ${Number(stats.totalPages).toLocaleString("zh-CN")} 页` : "等待建立文字索引")}
      ${metricCard("编号题估计", `${Number(stats.questionCountEstimate || 0).toLocaleString("zh-CN")} 道`, "用于找题，不等同于已审核题数")}
      ${metricCard("A/B/C/D 分层", `${Number(stats.byLayer?.A || 0)}/${Number(stats.byLayer?.B || 0)}/${Number(stats.byLayer?.C || 0)}/${Number(stats.byLayer?.D || 0)}`, "各层独立，默认隐藏字节重复副本")}
    </section>
    <section class="section library-search-workbench"><div class="section-title-row"><div><p class="eyebrow">本机全文检索</p><h3>直接说题型、考点或题干关键词</h3><p class="hint">中考原卷、长沙校考、八九年级讲义与练习资料已分层搜索。收录只代表“能找到”，未审核的题不会进入高频结论。</p></div><button class="ghost" data-library-refresh>刷新收录统计</button></div>
      <div class="engine-question-bar"><input data-library-query value="${escapeAttr(materialLibrary.query)}" placeholder="例如：动态电路 电表示数变化／凸透镜成像／机械效率" /><button class="primary" data-library-search>搜索全部资料</button></div>
      <div class="catalog-search-grid"><div class="field"><label>来源层级</label><select data-library-filter="layer"><option value="">A–D 全部</option>${["A", "B", "C", "D"].map(value => `<option value="${value}" ${materialLibrary.filters.layer === value ? "selected" : ""}>${escapeHtml(SOURCE_LAYERS[value].name)}</option>`).join("")}</select></div><div class="field"><label>年级</label><select data-library-filter="grade"><option value="">全部年级</option>${["八年级", "九年级", "初中物理"].map(value => `<option ${materialLibrary.filters.grade === value ? "selected" : ""}>${value}</option>`).join("")}</select></div><div class="field"><label>年份</label><input data-library-filter="year" inputmode="numeric" value="${escapeAttr(materialLibrary.filters.year)}" placeholder="如 2025" /></div><div class="field"><label>地区</label><input data-library-filter="region" value="${escapeAttr(materialLibrary.filters.region)}" placeholder="如 长沙／株洲" /></div><div class="field"><label>资料角色</label><select data-library-filter="role"><option value="">全部版本</option>${[["original_with_source_analysis", "中考原卷+来源解析"], ["original", "原卷版"], ["paper", "试卷/测试卷"], ["student", "学生版"], ["teacher_answer", "教师/答案版"], ["practice", "练习/刷题"], ["handout", "讲义/教材"], ["topic", "专题资料"]].map(([value, label]) => `<option value="${value}" ${materialLibrary.filters.role === value ? "selected" : ""}>${label}</option>`).join("")}</select></div></div>
      <div class="actions"><label class="library-duplicate-toggle"><input type="checkbox" data-library-duplicates ${materialLibrary.filters.includeDuplicates ? "checked" : ""}/> 展开显示同源版本与重复副本</label><button class="ghost" data-library-clear>清除条件</button></div>
    </section>${libraryResultsView()}`;
  }

  function curriculumEligibleQuestions(engine) {
    const merged = new Set((engine.canonicalExams || []).filter(exam => exam.mergedInto).map(exam => exam.id));
    return (engine.questions || []).filter(question => !question.generated && !question.excluded && !merged.has(question.canonicalExamId));
  }

  function curriculumQuestionReviewed(question) {
    return window.ExamDomain?.reviewed ? window.ExamDomain.reviewed(question) : window.PhysicsTaxonomy?.questionIsReviewed?.(question) === true;
  }

  function buildCurriculumIndex(engine, bookId) {
    const taxonomy = window.PhysicsTaxonomy;
    const book = taxonomy?.outline?.find(item => item.id === bookId) || taxonomy?.outline?.[0];
    const sections = book?.chapters?.flatMap(item => item.sections) || [];
    const stats = new Map(sections.map(item => [item.id, { questions: [], questionReviewed: 0, mappingConfirmed: 0, sourceIds: new Set(), layers: { A: 0, B: 0, C: 0, D: 0 }, aiRisk: 0, actualWrong: 0 }]));
    const activeWrong = new Set((window.ExamDomain?.activeAttempts?.(engine) || []).filter(attempt => attempt.isCorrect === false).map(attempt => attempt.questionId));
    let unclassified = 0;
    for (const question of curriculumEligibleQuestions(engine)) {
      const matches = taxonomy?.classifyQuestion?.(question, { bookId: book?.id, limit: 10 }) || [];
      if (!matches.length) { unclassified++; continue; }
      for (const match of matches) {
        const row = stats.get(match.id);
        if (!row) continue;
        row.questions.push(question);
        if (curriculumQuestionReviewed(question)) row.questionReviewed++;
        if (match.confirmed) row.mappingConfirmed++;
        row.sourceIds.add(question.canonicalExamId || question.sourceFileId || question.id);
        if (row.layers[question.sourceLayer] != null) row.layers[question.sourceLayer]++;
        if ((question.traps || []).length || (question.confusedConcepts || []).length || Number(question.estimatedDifficulty || 0) >= 4) row.aiRisk++;
        if (activeWrong.has(question.id)) row.actualWrong++;
      }
    }
    return { book, sections, stats, unclassified };
  }

  function curriculumList(items, emptyText) {
    return items?.length ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="hint">${escapeHtml(emptyText)}</p>`;
  }

  function curriculumQuestionSummary(question) {
    const point = String(question?.mainPoint || "").trim();
    if (curriculumQuestionReviewed(question) && point && point !== "待人工标注") return point;
    const stem = String(question?.stem || "").replace(/\s+/g, " ").trim();
    if (!stem) return "题干待核对";
    return `题干候选：${stem.slice(0, 54)}${stem.length > 54 ? "…" : ""}`;
  }

  function curriculumMappingConfirmed(question, sectionId) {
    return curriculumQuestionReviewed(question) && question?.curriculumMappingStatus === "confirmed" && Array.isArray(question?.curriculumNodeIds) && question.curriculumNodeIds.includes(sectionId);
  }

  function curriculumView(state, engine) {
    const taxonomy = window.PhysicsTaxonomy;
    if (!taxonomy?.outline?.length) return emptyState("知识大纲正在加载", "请刷新本页；题库和原始资料不会受影响。");
    if (!taxonomy.outline.some(item => item.id === curriculumState.bookId)) curriculumState.bookId = taxonomy.outline[0].id;
    let index = buildCurriculumIndex(engine, curriculumState.bookId);
    const book = index.book;
    if (!index.sections.some(item => item.id === curriculumState.sectionId)) curriculumState.sectionId = index.sections[0]?.id || "";
    let selected = taxonomy.getSection(curriculumState.sectionId) || index.sections[0];
    const query = curriculumState.query.toLocaleLowerCase("zh-CN").trim();
    const visibleChapters = book.chapters.map(chapterItem => ({ ...chapterItem, sections: chapterItem.sections.filter(item => !query || [item.code, item.title, item.contents, item.mistakes, item.questionTypes, item.keywords].flat(Infinity).join(" ").toLocaleLowerCase("zh-CN").includes(query)) })).filter(item => item.sections.length);
    const visibleSections = visibleChapters.flatMap(chapterItem => chapterItem.sections);
    if (query && visibleSections.length && !visibleSections.some(item => item.id === selected?.id)) {
      curriculumState.sectionId = visibleSections[0].id;
      selected = taxonomy.getSection(curriculumState.sectionId) || visibleSections[0];
    }
    const selectedStats = index.stats.get(selected?.id) || { questions: [], questionReviewed: 0, mappingConfirmed: 0, sourceIds: new Set(), layers: { A: 0, B: 0, C: 0, D: 0 }, aiRisk: 0, actualWrong: 0 };
    const totalCandidates = new Set([...index.stats.values()].flatMap(row => row.questions.map(question => question.id))).size;
    const bookButtons = taxonomy.outline.map(item => {
      const sectionCount = item.chapters.reduce((sum, chapterItem) => sum + chapterItem.sections.length, 0);
      const countLabel = item.id === "exam_topics" ? `${item.chapters.length}专题组 · ${sectionCount}题型模型` : `${item.chapters.length}章 · ${sectionCount}节`;
      return `<button type="button" data-outline-book="${escapeAttr(item.id)}" aria-selected="${item.id === book.id}"><strong>${escapeHtml(item.title)}</strong><small>${countLabel}</small></button>`;
    }).join("");
    const nodeUnit = book.id === "exam_topics" ? "模型" : "节";
    const tree = visibleChapters.length ? visibleChapters.map(chapterItem => `<details open><summary><span>${escapeHtml(chapterItem.code)} ${escapeHtml(chapterItem.title)}</span><small>${chapterItem.sections.length}${nodeUnit}</small></summary><div>${chapterItem.sections.map(item => { const row = index.stats.get(item.id); return `<button type="button" class="outline-section-button ${item.id === selected.id ? "is-selected" : ""}" data-outline-section="${escapeAttr(item.id)}"><span><b>${escapeHtml(item.code)}</b> ${escapeHtml(item.title)}</span><small>${row?.questions.length || 0}题</small></button>`; }).join("")}</div></details>`).join("") : `<p class="hint">没有匹配的${nodeUnit}，请缩短关键词。</p>`;
    const layerText = Object.entries(selectedStats.layers).filter(([, count]) => count).map(([layer, count]) => `${layer}${count}`).join(" · ") || "尚无候选题";
    const related = selectedStats.questions.slice().sort((a, b) => Number(curriculumMappingConfirmed(b, selected.id)) - Number(curriculumMappingConfirmed(a, selected.id)) || Number(curriculumQuestionReviewed(b)) - Number(curriculumQuestionReviewed(a)) || String(b.year || "").localeCompare(String(a.year || ""))).slice(0, 8);
    return `<section class="section outline-hero"><div><p class="eyebrow">教材知识树 · 错误模型</p><h3>按年级、章节和小节找知识与题型</h3><p class="hint">${escapeHtml(taxonomy.version)}。八下采用人教版2025目录；大纲归类用于浏览和组题，不直接改变正式频次，高频榜仍按已审主、次具体考法统计。</p></div><div class="outline-book-tabs">${bookButtons}</div></section>
      <section class="outline-summary-grid">
        ${metricCard("当前范围", book.title, `${book.catalogVersion} · ${book.chapters.length}${book.id === "exam_topics" ? "专题组" : "章"}`)}
        ${metricCard(book.id === "exam_topics" ? "中考题型模型" : "教材小节", `${index.sections.length} ${nodeUnit}`, `每${nodeUnit}拆分内容、易错知识点和易错题型`)}
        ${metricCard("已归类候选题", `${totalCandidates} 道`, "同一道题可关联多个知识小节")}
        ${metricCard("本范围未命中", `${index.unclassified} 道`, "可能属于其他年级，或题干证据不足")}
      </section>
      <section class="outline-layout">
        <aside class="section outline-tree"><div class="outline-search"><label>搜索本范围</label><div><input data-outline-query value="${escapeAttr(curriculumState.query)}" placeholder="如：内能／凸透镜／机械效率"/><button type="button" class="secondary" data-outline-query-go>查找</button></div></div>${tree}</aside>
        <article class="section outline-detail">
          <div class="outline-breadcrumb">${escapeHtml(selected.bookTitle)} <span>›</span> ${escapeHtml(selected.chapterCode)} ${escapeHtml(selected.chapterTitle)}</div>
          <div class="section-title-row"><div><p class="eyebrow">${escapeHtml(selected.code)} · ${escapeHtml(book.catalogVersion)}</p><h3>${escapeHtml(selected.title)}</h3><p class="hint">归类关键词：${escapeHtml(selected.keywords.slice(0, 8).join("、"))}</p></div><div class="actions"><button type="button" class="primary" data-outline-view-questions="${escapeAttr(selected.id)}">查看候选题</button><button type="button" class="secondary" data-outline-search-material="${escapeAttr(selected.id)}">搜索全部资料</button></div></div>
          <div class="outline-node-metrics"><div><span>候选题</span><strong>${selectedStats.questions.length}</strong><small>${escapeHtml(layerText)}</small></div><div><span>题目已审 / 归类确认</span><strong>${selectedStats.questionReviewed} / ${selectedStats.mappingConfirmed}</strong><small>两步分开审核</small></div><div><span>独立来源</span><strong>${selectedStats.sourceIds.size}</strong><small>按 canonical 试卷／资料去重</small></div><div><span>长沙 A 类</span><strong>${selectedStats.layers.A || 0}</strong><small>当前仍可能待逐题确认</small></div><div><span>AI结构风险</span><strong>${selectedStats.aiRisk}</strong><small>不是学生错误率</small></div><div><span>真实错题证据</span><strong>${selectedStats.actualWrong}</strong><small>仅人工核验 E 类作答</small></div></div>
          <div class="outline-knowledge-grid"><section><h4>本节分为什么内容</h4>${curriculumList(selected.contents, "本节内容待补充")}</section><section class="is-warning"><h4>易错知识点</h4><p class="outline-label">教学预警／AI预计，不是实测错误率</p>${curriculumList(selected.mistakes, "易错知识点待补充")}</section><section class="is-model"><h4>易错题型</h4><p class="outline-label">按错误模型组织训练</p>${curriculumList(selected.questionTypes, "易错题型待补充")}</section></div>
          <section class="outline-related"><div class="section-title-row"><div><h4>对应候选题</h4><p class="hint">规则归类与题目审核分开；只有点击“确认归类”后，才会成为正式知识节点映射。</p></div>${selectedStats.questionReviewed ? `<button type="button" class="ghost" data-outline-reviewed="${escapeAttr(selected.id)}">只看题目已审</button>` : ""}</div>${related.length ? `<div>${related.map(question => { const confirmed = curriculumMappingConfirmed(question, selected.id); const reviewed = curriculumQuestionReviewed(question); const badge = confirmed ? "归类已确认" : reviewed ? "题目已审 · 归类候选" : "归类候选"; return `<div class="outline-question-row"><button type="button" class="outline-question-main" data-engine-open-question="${escapeAttr(question.id)}"><span><strong>${escapeHtml(questionDisplay(question))}</strong><small>${escapeHtml(curriculumQuestionSummary(question))} · ${escapeHtml(question.type || "题型待核对")}</small></span></button><div class="outline-question-actions"><span class="status-pill ${confirmed ? "good" : "warn"}">${badge}</span>${reviewed ? `<button type="button" class="ghost" data-outline-map-${confirmed ? "revoke" : "confirm"}="${escapeAttr(question.id)}|${escapeAttr(selected.id)}">${confirmed ? "撤销归类" : "确认归类"}</button>` : ""}</div></div>`; }).join("")}</div>` : emptyState("本节暂未匹配到结构化题", "可搜索全部资料定位讲义和试卷；文件级命中不会自动冒充完整题目。")}</section>
        </article>
      </section>`;
  }

  function overviewView(state, engine, report) {
    const actualCount = report.samples.actualAttempts;
    const evidenceAnswer = answerEngineQuestion(engine, report);
    const sourceQuestions = curriculumEligibleQuestions(engine);
    const originalCount = sourceQuestions.filter(hasCompleteOriginalQuestionPreview).length;
    const importedExams = (engine.canonicalExams || []).filter(exam => !exam.mergedInto);
    const rawA = importedExams.filter(exam => exam.sourceLayer === "A").length;
    const rawB = importedExams.filter(exam => exam.sourceLayer === "B").length;
    return `
      <section class="metric-grid">
        ${metricCard("完整原题可查看", `${originalCount} 道`, `已整理 ${sourceQuestions.length} 道有效题目；原题可先看、先选，教师确认后打印`)}
        ${metricCard("长沙中考原卷", `${rawA} 套`, "在真题题库按年份检索")}
        ${metricCard("湖南地市原卷", `${rawB} 套`, "在真题题库按地区检索")}
        ${metricCard("教师确认作答", `${actualCount} 条`, actualCount ? "可用于真实易错统计" : "未确认数据不参与统计")}
        ${metricCard("待人工审核", `${report.quality.reviewPending} 项`, "题目字段、重复判定或来源仍待核验")}
        ${metricCard("本机资料总库", `${Number(materialLibrary.stats?.total || 0)} 份`, materialLibrary.stats?.textDocuments ? `${Number(materialLibrary.stats.textDocuments)} 份可全文检索` : "尚未建立资料索引")}
      </section>
      <section class="section engine-quickstart">
        ${sourceQuestions.length ? `<div class="section-title-row"><div><p class="eyebrow">资料已在本机，不必重复上传</p><h3>找题 → 看原题 → 加入学生题单</h3><p class="hint">${originalCount} 道完整原题可以直接查看。八上、八下、九年级和中考知识点分开浏览，每节列出知识内容、易错点与题型。</p></div></div>
        <div class="engine-step-grid">
          <article><span>01</span><h4>按知识点找题</h4><p>从年级、章节、小节进入，也可以直接搜索“内能”“动态电路”等内容。</p><button class="primary" data-engine-go="curriculum">打开知识大纲</button></article>
          <article><span>02</span><h4>看完整原题并选题</h4><p>直接查看题干、选项、电路图和表格；跨页题连续展示，找到就能加入草稿。</p><button class="secondary" data-engine-go="questions">查看原题题库</button></article>
          <article><span>03</span><h4>集中核验后打印</h4><p>核对选中题的内容、答案和分值。缺项逐条提示，确认后导出不含答案的学生卷。</p><button class="ghost" data-engine-go="questionSets">打开学生题单</button></article>
        </div>` : `
        <div class="section-title-row"><div><p class="eyebrow">从一份原卷开始</p><h3>按教学节奏完成，不需要先理解所有统计口径</h3><p class="hint">原卷先留存，再识别、核对、分析；没有真实资料时，系统会明确提示数据不足。</p></div></div>
        <div class="engine-step-grid">
          <article><span>01</span><h4>导入原卷</h4><p>选择 A–E 来源，拖入 PDF。原件和页面图会留在本机。</p><button class="primary" data-engine-go="data">导入一份试卷</button></article>
          <article><span>02</span><h4>核对每一道题</h4><p>补全题干、答案、考点和图表，再确认重复版本与整卷完整性。</p><button class="secondary" data-engine-go="questions">打开题库审核</button></article>
          <article><span>03</span><h4>生成可用结论</h4><p>只用已核验数据生成趋势、错因和专题；结论都能回到原卷页。</p><button class="ghost" data-engine-go="reports">查看分析规则</button></article>
        </div>`}
      </section>
      <section class="section engine-evidence-search">
        <div class="section-title-row"><div><h3>向本机题库提问</h3><p class="hint">输入考点、题干关键词或教学问题。系统只基于已导入题目与审核状态给出证据，不会编造长沙结论。</p></div><button class="ghost" data-engine-refresh-bridge>刷新课前测确认数据</button></div>
        <div class="engine-question-bar"><input data-engine-answer-query value="${escapeAttr(engine.answerQuery || "")}" placeholder="例如：动态电路近年如何考？／搜索“滑动变阻器故障”" /><button class="primary" data-engine-answer>查题库与资料</button><button class="secondary" data-engine-search-from-answer>只看结构化真题</button><button class="ghost" data-engine-go="library">打开资料总库</button></div>
        <div class="engine-answer-card ${evidenceAnswer.hasQuery ? "" : "is-empty"}"><strong>${escapeHtml(evidenceAnswer.title)}</strong><p>${escapeHtml(evidenceAnswer.message)}</p>${evidenceAnswer.details ? `<p class="hint">${escapeHtml(evidenceAnswer.details)}</p>` : ""}${evidenceAnswer.matches.length ? `<div class="engine-answer-evidence">${evidenceAnswer.matches.map(question => `<button class="ghost" data-engine-open-question="${escapeAttr(question.id)}">${escapeHtml(questionDisplay(question))} · ${escapeHtml(question.mainPoint || "待标注")}</button>`).join("")}</div>` : ""}</div>
      </section>
      ${materialLibrary.searched && materialLibrary.query === String(engine.answerQuery || "").trim() ? libraryResultsView() : ""}`;
  }

  function dataView(state, engine, report) {
    const d = engine.importDraft;
    return `
      <section class="section import-workbench">
        <div class="section-title-row"><div><p class="eyebrow">原卷建档</p><h3>先描述这份资料，再把 PDF 拖进来</h3><p class="hint">系统会保存原始 PDF、逐页原图、文本层、SHA-256 与去重证据。扫描卷没有文字层也可以先入库，随后进入人工/AI 解析队列。</p></div></div>
        <div class="import-kind-picker" role="group" aria-label="快速选择资料类型">
          <button type="button" class="${d.sourceLayer === "A" ? "is-selected" : ""}" data-engine-import-preset="A">长沙中考原卷</button><button type="button" class="${d.sourceLayer === "B" ? "is-selected" : ""}" data-engine-import-preset="B">湖南其他地市原卷</button><button type="button" class="${d.sourceLayer === "C" ? "is-selected" : ""}" data-engine-import-preset="C">长沙学校/联考</button><button type="button" class="${d.sourceLayer === "D" ? "is-selected" : ""}" data-engine-import-preset="D">教材/专题资料</button>
        </div>
        <div class="import-dropzone" data-engine-dropzone tabindex="0" role="button" aria-label="选择或拖入 PDF 文件"><strong>拖入 PDF，或点击选择文件</strong><span>可连续导入多个版本；同卷不会因重复文件增加频次</span><small>先在下方确认年份、地区与资料层级</small><input class="hidden" type="file" accept="application/pdf,.pdf" multiple data-engine-import-pdf /></div>
        <div class="grid three" style="margin-top:14px">
          <div class="field"><label>资料层级</label><select data-engine-import-field="sourceLayer">${Object.entries(SOURCE_LAYERS).map(([code, meta]) => `<option value="${code}" ${d.sourceLayer === code ? "selected" : ""}>${escapeHtml(meta.name)}</option>`).join("")}</select></div>
          <div class="field"><label>试卷年份</label><input data-engine-import-field="year" value="${escapeAttr(d.year || "")}" placeholder="例如 2025" inputmode="numeric" /></div>
          <div class="field"><label>地区</label><input data-engine-import-field="region" value="${escapeAttr(d.region || "")}" placeholder="A 类必须为长沙" /></div>
          <div class="field"><label>考试类型</label><select data-engine-import-field="examType">${["中考原卷", "中考模拟/联考", "学校期中", "学校期末", "教材/练习资料"].map((value) => `<option ${d.examType === value ? "selected" : ""}>${value}</option>`).join("")}</select></div>
        </div>
        <details class="import-advanced"><summary>补充来源、版权与命题信息（可稍后填写）</summary><div class="grid three">
          <div class="field"><label>原始来源链接或馆藏说明</label><input data-engine-import-field="sourceUrl" value="${escapeAttr(d.sourceUrl || "")}" placeholder="可留空，后续人工补充" /></div>
          <div class="field"><label>版权/解析说明</label><input data-engine-import-field="copyrightNote" value="${escapeAttr(d.copyrightNote || "")}" placeholder="例如：仅限校内教研使用" /></div>
          <div class="field"><label>命题方案 ID（共用同卷填同一 ID）</label><input data-engine-import-field="paperOriginId" value="${escapeAttr(d.paperOriginId||"")}" placeholder="未确认可留空；不是命题单位名称" /></div>
          <div class="field"><label>命题来源名称</label><input data-engine-import-field="paperOriginName" value="${escapeAttr(d.paperOriginName||"")}" placeholder="按原卷和教师证据填写" /></div>
          <div class="field"><label>适用地市（逗号分隔）</label><input data-engine-import-field="applicableRegions" value="${escapeAttr(Array.isArray(d.applicableRegions)?d.applicableRegions.join("，"):d.applicableRegions||"")}" placeholder="适用地区不等于多个独立命题样本" /></div>
        </div></details>
        <details class="layer-rules"><summary>查看 A–E 数据使用边界</summary><div>${Object.entries(SOURCE_LAYERS).map(([code, meta]) => `<article><strong>${escapeHtml(meta.name)}</strong><span>${escapeHtml(meta.usage)}</span></article>`).join("")}</div></details>
        <div class="actions">
          <label class="primary action-button">选择 PDF 文件<input class="hidden" type="file" accept="application/pdf,.pdf" multiple data-engine-import-pdf /></label>
          <button type="button" class="ghost" data-engine-export="quality">导出数据质量报告</button>
          <button type="button" class="ghost" data-engine-export="duplicates">导出重复试卷报告</button>
          <button type="button" class="ghost" data-engine-export="all">导出完整分析快照</button>
          <button type="button" class="secondary" data-engine-backup>本机完整备份</button>
          <button type="button" class="ghost" data-engine-backup-list>查看可恢复备份</button>
          <button type="button" class="ghost" data-engine-recovery-list>查找其他标签页的未同步副本</button>
        </div>
        <p class="copyright-note">版权保护：原解析、AI 原创解析、教师解析将分开保存；导出的统计与专题清单不包含受版权保护的原解析正文。</p>
      </section>
      ${manualQuestionEntryView(engine)}
      ${qualityReportView(report)}
      ${duplicateReportView(engine, report)}
      ${sourceFileView(engine)}
      ${engine.recoveryList?`<section class="section"><h3>未同步的标签页副本</h3><p class="hint">各标签页独立保留；不会自动合并。下载副本含学生数据和原解析，仅私人使用。</p>${engine.recoveryList.map(r=>`<p>${escapeHtml(formatDate(r.at))} · 版本 ${r.revision} · ${r.questionCount}题／${r.attemptCount}次作答 ${r.current?"（当前页）":""}<button class="ghost" data-engine-recovery-export="${escapeAttr(r.recoveryId)}">下载私人副本</button>${!r.current?`<button class="secondary" data-engine-recovery-restore="${escapeAttr(r.recoveryId)}">显式载入此副本</button>`:""}</p>`).join("")||'<p>未发现待恢复副本</p>'}</section>`:""}
      ${engine.backupList ? `<section class="section"><h3>本机完整备份</h3><p class="hint">包含数据库、原件、学生记录和原解析，仅私人使用。恢复前会自动再备份当前版本；要防磁盘损坏，请另行复制备份目录到其他磁盘。</p>${engine.backupList.map(b=>`<p>${escapeHtml(formatDate(b.createdAt))} · 版本 ${b.revision} · ${b.assetFiles} 份资产 <button class="ghost" data-engine-restore-backup="${escapeAttr(b.id)}">恢复此版本</button></p>`).join("")||"暂无备份"}</section>` : ""}
    `;
  }

  function questionsView(state, engine, report) {
    if (engine.questionFilters?.view === "overview") return questionTypeOverviewView(engine);
    const f = engine.questionFilters || {}, reviewing = f.view === "review", pageSize = reviewing ? 1 : 12;
    const all = filterCatalogQuestions(engine, f);
    const facets = catalogFacets(engine);
    const curriculumNode = window.PhysicsTaxonomy?.getSection?.(f.curriculumNodeId);
    const page = Math.max(0, Math.min(Number(f.page)||0,Math.ceil(all.length/pageSize)-1)), questions=all.slice(page*pageSize,(page+1)*pageSize);
    const selectedSet = (engine.questionSets || []).find(set => set.id === f.setId);
    const previewCount = all.filter(hasCompleteOriginalQuestionPreview).length;
    if (reviewing) return `<section class="section"><div class="section-title-row"><div><p class="eyebrow">逐题核验</p><h3>${selectedSet ? escapeHtml(selectedSet.title) : "原卷对照与题目核验"}</h3><p class="hint">${all.length ? `第 ${page + 1} / ${all.length} 题` : "暂无待核验题目"}。核对原题、答案、分值和标签后确认；修改仍会保留审核历史。</p></div><div class="actions"><button type="button" class="secondary" data-engine-browse-return>返回找题</button>${selectedSet ? '<button type="button" class="ghost" data-engine-go="questionSets">返回题单</button>' : ""}</div></div><div class="actions"><button class="ghost" data-engine-page="${page-1}" ${page===0?"disabled":""}>上一题</button><button class="secondary" data-engine-page="${page+1}" ${page+1>=all.length?"disabled":""}>下一题</button></div></section>${questions.map(q => questionEditorView(q, engine, true)).join("")}${studentSelectionTray(engine)}`;
    return `<section class="section"><div class="section-title-row"><div><h3>看原题，选进练习单</h3><p class="hint">按知识点、题型或年份找题，先加入题单草稿，再集中核验准备发给学生的题。</p></div><div class="actions"><button type="button" class="primary" data-question-overview>${f.fromOverview ? "返回题型总览" : "题型总览"}</button><button type="button" class="secondary" data-engine-go="curriculum">按年级与章节找题</button><button class="ghost" data-engine-export="questions">导出审核清单</button></div></div>
      <div class="catalog-search-grid"><div class="field catalog-search-main"><label>题库搜索</label><input data-engine-filter="search" value="${escapeAttr(f.search||"")}" placeholder="题干、答案、考点、能力、模型、方法、年份或题号"/></div><div class="field"><label>年份</label><select data-engine-filter="year"><option value="">全部年份</option>${facets.years.map(value=>`<option value="${escapeAttr(value)}" ${f.year===value?"selected":""}>${escapeHtml(value)} 年</option>`).join("")}</select></div><div class="field"><label>来源层级</label><select data-engine-filter="layer"><option value="">全部来源</option>${["A","B","C","D"].map(x=>`<option value="${x}" ${f.layer===x?"selected":""}>${escapeHtml(SOURCE_LAYERS[x].name)}</option>`).join("")}</select></div><div class="field"><label>题型</label><select data-engine-filter="type"><option value="">全部题型</option>${facets.types.map(value=>`<option value="${escapeAttr(value)}" ${f.type===value?"selected":""}>${escapeHtml(value)}</option>`).join("")}</select></div><div class="field"><label>审核状态</label><select data-engine-filter="status"><option value="">全部</option><option value="pending" ${f.status==="pending"?"selected":""}>待审核</option><option value="reviewed" ${f.status==="reviewed"?"selected":""}>已确认</option></select></div></div>
      <div class="actions"><button class="primary" data-engine-search-go>搜索题库</button><button class="ghost" data-engine-search-clear>清除筛选</button>${curriculumNode?`<span class="outline-filter-pill">${escapeHtml(curriculumNode.bookTitle)} · ${escapeHtml(curriculumNode.code)} ${escapeHtml(curriculumNode.title)} <button type="button" aria-label="清除知识节筛选" data-outline-filter-clear>×</button></span>`:""}${f.focus?`<span class="hint">当前定位到 1 道题</span>`:""}</div>
      <div class="question-availability-filters" aria-label="原题完整性筛选">${[["", "全部题目"], ["complete", "原题图齐全"], ["incomplete", "待补齐原题"], ["ready", "已审可打印"]].map(([value,label])=>`<button type="button" class="${(f.preview||"")===value?"is-selected":""}" aria-pressed="${(f.preview||"")===value}" data-engine-preview-filter="${value}">${label}</button>`).join("")}</div>
      <p class="hint">${all.length} 道符合筛选 · ${previewCount} 道原题图齐全 · 第 ${page+1}/${Math.max(1,Math.ceil(all.length/pageSize))} 页。知识归类在教师确认前为候选。</p><div class="actions"><button class="ghost" data-engine-page="${page-1}" ${page===0?"disabled":""}>上一页</button><button class="ghost" data-engine-page="${page+1}" ${(page+1)*pageSize>=all.length?"disabled":""}>下一页</button></div></section>
      ${questions.length ? questions.map((q,index)=>questionBrowseCard(q,engine,index===0)).join("") : emptyState("暂无符合条件的题目","可清除筛选，或从知识大纲中的其他小节继续找题。")}${studentSelectionTray(engine)}`;
  }

  function questionTypeOverviewView(engine) {
    const view = engine.questionOverview ||= { filters: {}, selected: "", page: 0 };
    const picked = view.picked ||= new Set();
    const { filters } = view;
    const { dimensions, build } = window.QuestionOverview;
    const result = build(engine, filters);
    const group = result.sections.flatMap(section => section.groups).find(group => group.id === view.selected);
    const draft = activeStudentQuestionSet(engine);
    const alreadyPicked = studentQuestionSetQuestionIds(draft?.status === "draft" ? draft : null);
    const size = 20;
    const page = group ? Math.min(view.page, Math.ceil(group.items.length / size) - 1) : 0;
    const filterSelect = (name, label, options) => `<label class="field"><span>${label}</span><select data-overview-filter="${name}"><option value="">全部${label}</option>${options.map(value => `<option value="${escapeAttr(value)}" ${filters[name] === value ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select></label>`;
    return `<section class="section overview-filters">
      <div class="section-title-row"><div><h3>题型总览</h3><p class="hint">找到历年同一考法，点开看卷面和原题。卷数按同一份试卷计。</p></div>
        <button class="ghost" type="button" data-overview-back>返回原题浏览</button></div>
      <div class="actions" aria-label="分类维度">${Object.entries(dimensions).map(([id, label]) => `<button type="button" data-overview-dimension="${id}" class="${id === result.dimension ? "primary" : "secondary"}" aria-pressed="${id === result.dimension}">${label}</button>`).join("")}</div>
      <div class="overview-pickers">
        ${filterSelect("region", "地区", result.facets.regions)}${filterSelect("year", "年份", result.facets.years)}
        <label class="field"><span>来源</span><select data-overview-filter="layer"><option value="">全部来源</option>${Object.entries(SOURCE_LAYERS).filter(([id]) => id !== "E").map(([id, layer]) => `<option value="${id}" ${filters.layer === id ? "selected" : ""}>${escapeHtml(layer.name)}</option>`).join("")}</select></label>
      </div>
      <p class="hint" data-overview-count>当前 ${result.count} 道 / 题库 ${result.total} 道。AI 对照原卷整理分类，题目审核进度另计。</p>
    </section>
    ${group ? `<section class="section overview-group-items" tabindex="-1" data-overview-group-items>
      <div class="section-title-row"><div><h3>${escapeHtml(group.label)}</h3><p class="hint">${group.papers} 套 · ${group.questions} 道 · 已对照原卷分类 ${group.checked} 道</p></div>
        <button class="ghost" type="button" data-overview-group="">返回分类</button></div>
      <div class="overview-practice-bar actions">
        <span data-overview-picked-count role="status">已选 ${picked.size} 道</span>
        <button type="button" class="primary" data-overview-build-practice ${picked.size ? "" : "disabled"}>加入练习草稿</button>
        ${draft?.status === "draft" ? '<button type="button" class="secondary" data-engine-go="questionSets">查看当前草稿</button>' : ""}
      </div>
      <div class="overview-question-list">${group.items.slice(page * size, (page + 1) * size).map(({ question, year, region, source }) => {
        const pdf = safeAssetUrl(source?.originalAsset?.url);
        const sourceNo = Number(question.pageNo);
        const hasSourcePage = Number.isInteger(sourceNo) && sourceNo > 0;
        const added = alreadyPicked.has(question.id);
        const ready = studentQuestionReadiness(question).ready;
        const eligibility = questionDraftEligibility(question);
        const title = `${year} · ${region} · 第 ${question.questionNo} 题`;
        const checkLabel = added ? "已加入草稿" : !eligibility.selectable ? "原题待补齐" : "选择本题";
        return `<article><div><strong>${escapeHtml(title)}</strong>
          <p class="hint">${escapeHtml([question.type, question.mainPoint, question.physicalModel].filter(Boolean).join(" · "))}</p>
          <p>${escapeHtml(String(question.stem || "").replace(/\s+/g, " ").slice(0, 92))}</p></div>
          <div class="actions"><span class="status-pill ${ready ? "good" : "warn"}">${ready ? "已核验可打印" : "待审核"}</span>
          <button type="button" class="secondary" data-overview-question="${escapeAttr(question.id)}">看原题</button>
          <label class="overview-pick" title="${escapeAttr(eligibility.issues.join("、"))}"><input type="checkbox" data-overview-pick="${escapeAttr(question.id)}" aria-label="${escapeAttr(title + ' · ' + checkLabel)}" ${added || !eligibility.selectable ? "disabled" : ""} ${added || picked.has(question.id) ? "checked" : ""}>${checkLabel}</label>
          ${pdf ? `<a class="source-link" href="${escapeAttr(hasSourcePage ? pdf + "#page=" + sourceNo : pdf)}" target="_blank" rel="noreferrer">${hasSourcePage ? "原卷第 " + sourceNo + " 页" : "打开原卷"} ↗</a>` : ""}</div></article>`;
      }).join("")}</div>
      ${group.items.length > size ? `<div class="actions"><button class="ghost" data-overview-page="${page - 1}" ${page ? "" : "disabled"}>上一页</button><span>第 ${page + 1}/${Math.ceil(group.items.length / size)} 页</span><button class="ghost" data-overview-page="${page + 1}" ${(page + 1) * size < group.items.length ? "" : "disabled"}>下一页</button></div>` : ""}
      </section>` : result.sections.map(section => `<section class="section overview-section"><div class="section-title-row"><div>
        <h3>${escapeHtml(SOURCE_LAYERS[section.layer]?.name || section.examType)}</h3>
        <p class="hint">${escapeHtml(section.examType)} · ${section.papers} 套 · ${section.questions} 道 · 已对照原卷分类 ${section.checked} 道</p></div></div>
        <div class="overview-group-grid">${section.groups.map(group => `<button type="button" class="secondary" data-overview-group="${escapeAttr(group.id)}"><strong>${escapeHtml(group.label)}</strong><span>${group.papers} 套 · ${group.questions} 道</span></button>`).join("")}</div>
      </section>`).join("") || emptyState("当前条件没有题目", "调整地区、年份或来源后查看。")}${studentSelectionTray(engine)}`;
  }

  function questionDraftEligibility(question) {
    return studentQuestionSetApi().draftEligibility(question);
  }

  function questionPickAction(question, engine) {
    const currentSet = activeStudentQuestionSet(engine);
    if (studentQuestionSetQuestionIds(currentSet).has(question.id)) return '<span class="status-pill good">已选入题单</span>';
    const check = questionDraftEligibility(question);
    return `<button type="button" class="primary" data-engine-question-set-add="${escapeAttr(question.id)}" ${check.selectable ? "" : `disabled title="${escapeAttr(check.issues.join("；"))}"`}>加入题单草稿</button>`;
  }

  function questionSourceEvidence(question, engine) {
    const source = engine.files.find(file => file.id === question.sourceFileId);
    if (!source) return "";
    const pdf = safeAssetUrl(source.originalAsset?.url);
    const page = Number(question.pageNo);
    const hasPage = Number.isInteger(page) && page > 0;
    const originalUrl = hasPage ? pdf + "#page=" + page : pdf;
    const linkText = hasPage ? "打开原卷第 " + page + " 页" : "打开原卷";
    const hash = /^[a-f0-9]{64}$/i.test(source.sha256 || "") ? source.sha256 : "";
    const sourceName = source.fileName || "原卷";
    return `<details class="overview-source-evidence"><summary>来源与核对状态</summary>
      <p>${escapeHtml(sourceName)} · 原题第 ${escapeHtml(question.questionNo)} 题</p>
      <p class="hint">${escapeHtml([question.type, question.mainPoint, question.physicalModel].filter(Boolean).join(" · "))}</p>
      <p class="hint">答案核验：${window.ExamDomain.reviewed(question) ? "教师已确认" : "待教师核对"}</p>
      ${pdf ? `<a class="source-link" href="${escapeAttr(originalUrl)}" target="_blank" rel="noreferrer">${linkText} ↗</a>` : ""}
      ${hash ? `<small class="hint">原文件 SHA-256 <code>${hash}</code></small>` : ""}</details>`;
  }

  function questionBrowseCard(question, engine, open = false) {
    const crops = (question.imageAssets || []).filter(asset => asset.kind === "question-crop").sort((a,b) => Number(a.pageNo)-Number(b.pageNo));
    const complete = hasCompleteOriginalQuestionPreview(question);
    const ready = studentQuestionReadiness(question).ready;
    return `<article class="section question-browse-card" data-browse-question="${escapeAttr(question.id)}"><div class="section-title-row"><div><h3>${escapeHtml(questionDisplay(question))}</h3><p class="hint">${escapeHtml(question.type || "题型待核验")} · ${escapeHtml(SOURCE_LAYERS[question.sourceLayer]?.name || "来源待核验")}</p></div><span class="status-pill ${ready?"good":"warn"}">${ready?"已审可打印":complete?"原题图齐全 · 待核验":"原题待补齐"}</span></div><p class="question-browse-excerpt">${escapeHtml(String(question.stem || "题干待补充").replace(/\s+/g," ").slice(0,210))}</p>${questionSourceEvidence(question, engine)}<details class="question-original-view" ${open?"open":""}><summary>查看原题${crops.length > 1 ? `（${crops.length} 段，按原卷页序）` : ""}</summary>${crops.map(asset => `<figure><a href="${escapeAttr(safeAssetUrl(asset.url))}" target="_blank" rel="noreferrer"><img loading="lazy" src="${escapeAttr(safeAssetUrl(asset.url))}" alt="${escapeAttr(questionDisplay(question))} · 原卷第 ${asset.pageNo} 页单题裁图" /></a><figcaption>原卷第 ${asset.pageNo} 页 · 点击放大</figcaption></figure>`).join("")}${complete?"":'<p class="question-missing-note">部分原题区域尚待补齐，请在核验页对照原卷。当前不可作为完整学生题发出。</p>'}</details><div class="actions">${questionPickAction(question,engine)}<button type="button" class="secondary" data-engine-review-question="${escapeAttr(question.id)}">核验与编辑</button><button type="button" class="ghost" data-engine-ask-question="${escapeAttr(question.id)}">问这道题</button></div></article>`;
  }

  function studentSelectionTray(engine) {
    const set = activeStudentQuestionSet(engine);
    if (!set || !(set.questionRefs || []).length) return "";
    const selectedIds = studentQuestionSetQuestionIds(set);
    const readyCount = (engine.questions || []).filter(q => selectedIds.has(q.id) && studentQuestionReadiness(q).ready).length;
    return `<aside class="question-selection-tray" aria-label="当前题单"><div><strong>${escapeHtml(set.title)}</strong><span>已选 ${selectedIds.size} 题 · ${readyCount} 题已审可打印</span></div><div class="actions"><button type="button" class="secondary" data-engine-question-set-review="${escapeAttr(set.id)}">集中核验</button><button type="button" class="primary" data-engine-go="questionSets">查看题单</button></div></aside>`;
  }

  function studentQuestionSetApi() {
    if (!window.StudentQuestionSets) throw new Error("学生题单组件尚未加载，请刷新页面");
    return window.StudentQuestionSets;
  }

  function studentQuestionReadiness(question) {
    return studentQuestionSetApi().readiness(question);
  }

  // A preview is not the same thing as a student-ready question.  This
  // deliberately counts only source questions whose every source page has a
  // dedicated single-question crop, so the library can honestly show that
  // the original question is visible before the teacher finishes reviewing
  // its answer, score and tags.
  function hasCompleteOriginalQuestionPreview(question) {
    if (!question || question.generated || question.excluded || !question.sourceFileId || !studentQuestionSetApi().validQuestionNo(question.questionNo)) return false;
    const sourcePages = studentQuestionSetApi().sourcePageNumbers(question);
    if (!sourcePages.length) return false;
    const cropPages = new Set((question.imageAssets || [])
      .filter(asset => asset?.kind === "question-crop")
      .map(asset => Number(asset.pageNo))
      .filter(pageNo => Number.isInteger(pageNo) && pageNo > 0));
    return sourcePages.every(pageNo => cropPages.has(pageNo));
  }

  function activeStudentQuestionSet(engine) {
    const id = String(engine.settings?.activeQuestionSetId || "");
    return (engine.questionSets || []).find(set => set.id === id && set.status !== "archived") || null;
  }

  function studentQuestionSetQuestionIds(set) {
    return new Set((set?.questionRefs || []).map(ref => String(ref?.questionId || ref?.id || ref || "")).filter(Boolean));
  }

  function studentQuestionSetIssues(engine, set) {
    if (!set) return ["尚未创建学生题单"];
    return studentQuestionSetApi().questionSetIssues(set, new Map((engine.questions || []).map(question => [question.id, question])));
  }

  function studentQuestionSetStatus(engine, set) {
    if (!set) return { label: "未创建", className: "warn", issues: ["尚未创建学生题单"] };
    const issues = studentQuestionSetIssues(engine, set);
    if (set.status === "ready" && !issues.length) return { label: "可交给学生", className: "good", issues };
    if (set.status === "ready") return { label: "内容已变更，需重审", className: "warn", issues };
    return { label: "编辑中", className: "warn", issues };
  }

  function createStudentQuestionSet(engine) {
    const date = new Date().toLocaleDateString("zh-CN").replaceAll("/", "-");
    const set = {
      id: makeId("studentset"),
      title: `学生练习单 ${date}`,
      questionRefs: [],
      status: "draft",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: "local_teacher",
      publishedAt: "",
      publishedBy: "",
    };
    engine.questionSets.push(set);
    engine.settings ||= {};
    engine.settings.activeQuestionSetId = set.id;
    addAudit(engine, "question_set", set.id, "created", {});
    return set;
  }

  function resetStudentQuestionSetForEdit(set) {
    if (set.status !== "ready") return;
    set.status = "draft";
    set.publishedAt = "";
    set.publishedBy = "";
    set.unpublishedAt = new Date().toISOString();
  }

  function addQuestionToStudentSet(engine, questionId) {
    const question = (engine.questions || []).find(item => item.id === questionId);
    if (!question) throw new Error("找不到题目");
    const check = questionDraftEligibility(question);
    if (!check.selectable) throw new Error(`这道题需先补齐原题：${check.issues.join("、")}`);
    const set = activeStudentQuestionSet(engine) || createStudentQuestionSet(engine);
    const ids = studentQuestionSetQuestionIds(set);
    if (ids.has(question.id)) return set;
    if ((set.questionRefs || []).length >= 100) throw new Error("一份学生题单最多100题");
    resetStudentQuestionSetForEdit(set);
    set.questionRefs.push({ questionId: question.id, contentHash: studentQuestionSetApi().contentHash(question, { imageAssets: check.imageAssets }) });
    set.updatedAt = new Date().toISOString();
    addAudit(engine, "question_set", set.id, "question_added", { questionId: question.id });
    return set;
  }

  function batchAddOverviewDraft(engine, ids) {
    const current = activeStudentQuestionSet(engine);
    const draft = current?.status === "draft" ? current : null;
    const existing = studentQuestionSetQuestionIds(draft);
    const questions = new Map(engine.questions.map(question => [question.id, question]));
    const refs = [];
    for (const id of new Set(ids)) {
      if (existing.has(id)) continue;
      const question = questions.get(id);
      if (!question) throw new Error("有选中的题已不存在，请重新选择");
      const check = questionDraftEligibility(question);
      if (!check.selectable) throw new Error(`第 ${question.questionNo} 题尚不能加入草稿：${check.issues.join("、")}`);
      refs.push({ questionId: id, contentHash: studentQuestionSetApi().contentHash(question, { imageAssets: check.imageAssets }) });
    }
    if (!refs.length) return 0;
    if (existing.size + refs.length > 100) throw new Error("一份学生题单最多 100 题，请减少选题");
    const set = draft || createStudentQuestionSet(engine);
    set.questionRefs.push(...refs);
    set.updatedAt = new Date().toISOString();
    addAudit(engine, "question_set", set.id, "questions_added", { questionIds: refs.map(ref => ref.questionId) });
    return refs.length;
  }

  function removeQuestionFromStudentSet(engine, setId, questionId) {
    const set = (engine.questionSets || []).find(item => item.id === setId);
    if (!set) return;
    resetStudentQuestionSetForEdit(set);
    set.questionRefs = (set.questionRefs || []).filter(ref => String(ref?.questionId || ref?.id || ref) !== questionId);
    set.updatedAt = new Date().toISOString();
    addAudit(engine, "question_set", set.id, "question_removed", { questionId });
  }

  function studentQuestionSetsView(state, engine) {
    const active = activeStudentQuestionSet(engine);
    const activeIds = studentQuestionSetQuestionIds(active);
    const status = studentQuestionSetStatus(engine, active);
    const byId = new Map((engine.questions || []).map(question => [question.id, question]));
    const selected = (active?.questionRefs || []).map(ref => byId.get(String(ref?.questionId || ref?.id || ref))).filter(Boolean);
    const readyCount = (engine.questions || []).filter(question => {
      try { return studentQuestionReadiness(question).ready; } catch { return false; }
    }).length;
    const originalPreviewCount = (engine.questions || []).filter(hasCompleteOriginalQuestionPreview).length;
    const ready = active?.status === "ready" && !status.issues.length;
    const selectedReady = selected.filter(question => studentQuestionReadiness(question).ready).length;
    const pending = selected.length - selectedReady;
    const setCards = (engine.questionSets || []).filter(set => set.status !== "archived").map(set => {
      const itemStatus = studentQuestionSetStatus(engine, set);
      return `<button type="button" class="question-set-choice ${set.id === active?.id ? "is-selected" : ""}" data-engine-question-set-select="${escapeAttr(set.id)}"><strong>${escapeHtml(set.title)}</strong><small>${(set.questionRefs || []).length} 题 · ${escapeHtml(itemStatus.label)}</small></button>`;
    }).join("");
    return `<section class="metric-grid">
      ${metricCard("原题单题预览", `${originalPreviewCount} 道`, "每个来源页均已保留单题裁图；可在真题题库直接查看")}
      ${metricCard("可直接给学生的题", `${readyCount} 道`, "已逐题确认，题图已确认安全（如需要）")}
      ${metricCard("当前题单", active ? `${selected.length} 道` : "未创建", active ? status.label : "从真题题库加入已审核题")}
    </section>
    <section class="section question-set-workbench"><div class="section-title-row"><div><p class="eyebrow">选题草稿 → 集中核验 → 学生打印卷</p><h3>学生题单</h3><p class="hint">在题库找到原题即可加入草稿，然后集中核验选中的题。全部确认后开放学生打印卷，学生只看到题目内容。</p></div><div class="actions"><button type="button" class="secondary" data-engine-question-set-new>新建题单</button>${active ? `<button type="button" class="primary" data-engine-question-set-open="${escapeAttr(active.id)}" ${ready ? "" : "disabled"}>打开学生打印版</button>` : ""}</div></div>
      ${setCards ? `<div class="question-set-choices">${setCards}</div>` : emptyState("还没有学生题单", "到“真题题库”看原题，点击“加入题单草稿”即可开始选题。")}
      ${active ? `<div class="question-set-editor"><div class="grid two"><div class="field"><label>题单标题</label><input data-engine-question-set-title="${escapeAttr(active.id)}" value="${escapeAttr(active.title)}" maxlength="120" /></div><div class="field"><label>学生可用状态</label><div class="question-set-status"><span class="status-pill ${status.className}">${escapeHtml(status.label)}</span><small>${ready ? "可打开并打印；学生端不返回教师信息。" : escapeHtml(status.issues.slice(0, 2).join("；") || "选择题目后由教师确认。")}</small></div></div></div>
        <div class="question-set-progress"><strong>核验进度 ${selectedReady} / ${selected.length} 题</strong><progress max="${Math.max(1,selected.length)}" value="${selectedReady}" aria-label="题单核验进度"></progress><span>${pending ? `${pending} 题待核验，草稿已保留` : selected.length ? "全部题目已核验，可以确认题单" : "请先选题"}</span></div>
        <div class="actions"><button type="button" class="secondary" data-engine-question-set-review="${escapeAttr(active.id)}" ${selected.length?"":"disabled"}>集中核验选中题</button><button type="button" class="primary" data-engine-question-set-publish="${escapeAttr(active.id)}" ${selected.length && !pending ? "" : "disabled"}>确认题单内容，开放给学生</button><button type="button" class="ghost" data-engine-browse-return>继续找题</button></div>
        ${selected.length ? `<div class="question-set-items">${selected.map((question, index) => { const check = studentQuestionReadiness(question); return `<article><div><strong>${index + 1}. ${escapeHtml(questionDisplay(question))}</strong><p>${escapeHtml(String(question.stem || "").replace(/\s+/g, " ").slice(0, 180))}</p><small>${check.ready ? "内容已核验" : escapeHtml(`待核验：${check.issues.join("、")}`)}</small></div><div class="actions"><button type="button" class="secondary" data-engine-review-question="${escapeAttr(question.id)}">看原题与核验</button><button type="button" class="ghost" data-engine-question-set-move="${escapeAttr(active.id+"|"+question.id+"|-1")}" ${index===0?"disabled":""} aria-label="上移第 ${index+1} 题">上移</button><button type="button" class="ghost" data-engine-question-set-move="${escapeAttr(active.id+"|"+question.id+"|1")}" ${index===selected.length-1?"disabled":""} aria-label="下移第 ${index+1} 题">下移</button><button type="button" class="ghost" data-engine-question-set-remove="${escapeAttr(active.id + "|" + question.id)}">移出</button></div></article>`; }).join("")}</div>` : emptyState("当前题单没有题", "在题库中看原题后，点击“加入题单草稿”。")}
      </div>` : ""}
    </section>`;
  }

  function manualQuestionEntryView(engine) {
    const sources = (engine.files || []).filter(file => {
      const exam = engine.canonicalExams.find(item => item.id === file.canonicalExamId);
      return file.canonicalExamId && !exam?.mergedInto && ["A", "B", "C", "D"].includes(file.sourceLayer);
    });
    if (!sources.length) return `<section class="section manual-question-empty"><div class="section-title-row"><div><h3>手工录入一题</h3><p class="hint">需要先导入一份原卷或训练资料，才能让题目与来源页、原图和版权信息保持可追溯。</p></div><button class="ghost" data-engine-go="data">先导入资料</button></div></section>`;
    const draft = engine.manualQuestionDraft || {};
    const source = sources.find(file => file.id === draft.sourceFileId) || sources[0];
    const pages = source?.pageAssets || [];
    return `<section class="section manual-question-entry"><div class="section-title-row"><div><p class="eyebrow">补录与修订</p><h3>手工录入一题</h3><p class="hint">用于 PDF 识别遗漏、图文混排或教师已经核对过的题目。保存后仍需在题库中逐题确认，才会进入正式分析。</p></div><button class="ghost" data-engine-go="questions">返回题库审核</button></div>
      <div class="grid three"><div class="field"><label>所属资料</label><select data-engine-manual-field="sourceFileId">${sources.map(file => `<option value="${escapeAttr(file.id)}" ${file.id === source.id ? "selected" : ""}>${escapeHtml(file.fileName)} · ${escapeHtml(file.year || "待核对")} ${escapeHtml(file.region || "")}</option>`).join("")}</select></div><div class="field"><label>题号</label><input data-engine-manual-field="questionNo" value="${escapeAttr(draft.questionNo || "")}" placeholder="例如 12 或 20-2" /></div><div class="field"><label>来源页码</label><select data-engine-manual-field="pageNo">${pages.map(page => `<option value="${page.pageNo}" ${String(draft.pageNo || "1") === String(page.pageNo) ? "selected" : ""}>第 ${page.pageNo} 页</option>`).join("")}</select></div><div class="field"><label>题型</label><select data-engine-manual-field="type">${["选择题", "填空题", "实验探究题", "计算题", "综合题"].map(value => `<option value="${value}" ${draft.type === value ? "selected" : ""}>${value}</option>`).join("")}</select></div><div class="field"><label>分值（未知可留空）</label><input type="number" min="0" step="0.5" data-engine-manual-field="score" value="${escapeAttr(draft.score || "")}" /></div><div class="field"><label>AI预计难度 1–5</label><input type="number" min="1" max="5" data-engine-manual-field="estimatedDifficulty" value="${escapeAttr(draft.estimatedDifficulty || "")}" placeholder="可留空，后续补充" /></div></div>
      <div class="field"><label>题干</label><textarea data-engine-manual-field="stem" placeholder="可直接粘贴题干；图、电路图和表格仍以本页原图为证据。">${escapeHtml(draft.stem || "")}</textarea></div><div class="grid two"><div class="field"><label>选项（每行一项，例如 A. 内容）</label><textarea data-engine-manual-field="optionsText" placeholder="非选择题可留空">${escapeHtml(draft.optionsText || "")}</textarea></div><div class="field"><label>答案</label><textarea data-engine-manual-field="answer" placeholder="例如 A；或填写完整结论/数值">${escapeHtml(draft.answer || "")}</textarea></div></div>
      <details class="manual-question-tags"><summary>补充考点、能力与解题信息</summary><div class="grid three"><div class="field"><label>主考点（具体考法）</label><input data-engine-manual-field="mainPoint" value="${escapeAttr(draft.mainPoint || "")}" placeholder="例如：动态电路中的电表示数变化" /></div><div class="field"><label>次考点（逗号分隔）</label><input data-engine-manual-field="secondaryPoints" value="${escapeAttr(draft.secondaryPoints || "")}" /></div><div class="field"><label>考查能力（逗号分隔）</label><input data-engine-manual-field="abilities" value="${escapeAttr(draft.abilities || "")}" placeholder="例如：概念辨析与证据推理" /></div><div class="field"><label>物理模型</label><input data-engine-manual-field="physicalModel" value="${escapeAttr(draft.physicalModel || "")}" /></div><div class="field"><label>解题方法</label><input data-engine-manual-field="method" value="${escapeAttr(draft.method || "")}" /></div><div class="field"><label>易混概念</label><input data-engine-manual-field="confusedConcepts" value="${escapeAttr(draft.confusedConcepts || "")}" /></div><div class="field"><label>常见陷阱</label><input data-engine-manual-field="traps" value="${escapeAttr(draft.traps || "")}" /></div></div></details>
      <div class="actions"><button class="primary" data-engine-manual-submit>保存到待审核题库</button><button class="ghost" data-engine-manual-clear>清空本题</button><span class="hint">不会把手工录入题自动计入高频统计。</span></div></section>`;
  }

  function catalogQuestionText(question, engine) {
    const source = (engine.files || []).find(file => file.id === question.sourceFileId);
    return [
      question.questionNo, question.pageNo, question.id, question.year, question.region, question.examType, question.sourceLayer, source?.fileName,
      question.type, question.stem, question.answer, question.mainPoint, question.secondaryPoints,
      question.abilities, question.physicalModel, question.method, question.confusedConcepts, question.traps,
      (question.options || []).map(item => typeof item === "string" ? item : `${item.label || ""} ${item.text || ""}`),
      (question.dataTables || []).map(item => typeof item === "string" ? item : JSON.stringify(item)),
    ].flat(Infinity).filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
  }

  function teacherSearchIntent(value) {
    const raw = String(value || "").toLocaleLowerCase("zh-CN").trim();
    const countText = raw.match(/([0-9]{1,3}|[一二两三四五六七八九十]{1,3})\s*道/)?.[1] || "";
    const countDigits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const count = /^\d+$/.test(countText) ? Number(countText) : countText === "十" ? 10 : countText.includes("十")
      ? (countText.split("十")[0] ? countDigits[countText.split("十")[0]] : 1) * 10 + (countText.split("十")[1] ? countDigits[countText.split("十")[1]] : 0)
      : countDigits[countText] || null;
    const year = raw.match(/(?:19|20)\d{2}/)?.[0] || "";
    const regions = ["长沙", "株洲", "湘潭", "衡阳", "邵阳", "岳阳", "常德", "张家界", "益阳", "郴州", "永州", "怀化", "娄底", "湘西"];
    const region = regions.find(name => raw.includes(name)) || "";
    const grade = /八年级|初二/.test(raw) ? "八年级" : /九年级|初三/.test(raw) ? "九年级" : "";
    const trendIntent = /近三年|近五年|历年|近年|如何考(?:查)?|怎么考(?:查)?|考什么/.test(raw);
    const layer = region === "长沙" && /中考|真题|原卷/.test(raw) ? "A"
      : /湖南(?:省)?其他地市|其他地市/.test(raw) ? "B"
        : /校考|期中|期末|联考|集团卷/.test(raw) && (!region || region === "长沙") ? "C"
          : /讲义|练习册|专题资料|训练资料/.test(raw) ? "D" : trendIntent ? "A" : "";
    const effectiveQuery = raw
      .replace(/(?:19|20)\d{2}\s*年?/g, " ").replace(/\d{1,3}\s*道/g, " ").replace(/[一二两三四五六七八九十]{1,3}\s*道/g, " ")
      .replace(/请问|麻烦|帮我|给我|我要|我想要|想找|找一下|找|查一下|搜一下|查找|查询|搜索|筛选|推荐|来点|出几道|看一下|看看|有没有|关于|相关的?/g, " ")
      .replace(/近三年|近五年|历年|近年|如何考(?:查)?|怎么考(?:查)?|考什么/g, " ")
      .replace(/湖南(?:省)?其他地市|其他地市|长沙(?:市)?|株洲(?:市)?|湘潭(?:市)?|衡阳(?:市)?|邵阳(?:市)?|岳阳(?:市)?|常德(?:市)?|张家界(?:市)?|益阳(?:市)?|郴州(?:市)?|永州(?:市)?|怀化(?:市)?|娄底(?:市)?|湘西(?:州)?/g, " ")
      .replace(/八年级|九年级|初二|初三|中考原卷|中考真题|原卷|真题|中考|物理|题目|题型|习题|试题|题/g, " ")
      .replace(/[“”"'‘’《》【】()（）：:，,。！？!?；;、/\\|]+/g, " ").replace(/\s+/g, " ").trim();
    return { raw, effectiveQuery: effectiveQuery || raw, requestedCount: count, filters: { layer, year, region: region || (trendIntent ? "长沙" : ""), grade } };
  }

  function searchTokens(value) {
    return teacherSearchIntent(value).effectiveQuery.split(/\s+/).map(token => token.trim()).filter(Boolean);
  }

  function filterCatalogQuestions(engine, filters = {}) {
    const excludedExams = new Set((engine.canonicalExams || []).filter(exam => exam.mergedInto).map(exam => exam.id));
    const tokens = searchTokens(filters.search);
    const selectedSet = filters.setId ? (engine.questionSets || []).find(set => set.id === filters.setId) : null;
    const setOrder = new Map((selectedSet?.questionRefs || []).map((ref,index) => [ref.questionId,index]));
    return (engine.questions || []).filter(question => {
      if (question.generated || question.excluded || excludedExams.has(question.canonicalExamId)) return false;
      if (filters.setId && !setOrder.has(question.id)) return false;
      if (filters.focus && question.id !== filters.focus) return false;
      if (filters.layer && question.sourceLayer !== filters.layer) return false;
      if (filters.year && String(question.year) !== String(filters.year)) return false;
      if (filters.region && String(question.region || "").trim() !== String(filters.region).trim()) return false;
      if (filters.type && question.type !== filters.type) return false;
      if (filters.status && (filters.status === "pending" ? question.reviewed : !question.reviewed)) return false;
      if (filters.preview === "complete" && !hasCompleteOriginalQuestionPreview(question)) return false;
      if (filters.preview === "incomplete" && hasCompleteOriginalQuestionPreview(question)) return false;
      if (filters.preview === "ready" && !studentQuestionReadiness(question).ready) return false;
      if (filters.curriculumNodeId && !window.PhysicsTaxonomy?.matchesQuestion?.(question, filters.curriculumNodeId)) return false;
      const text = catalogQuestionText(question, engine);
      return tokens.every(token => text.includes(token));
    }).sort((a, b) => (filters.setId ? setOrder.get(a.id) - setOrder.get(b.id) : 0) || String(b.year).localeCompare(String(a.year)) || questionOrder(a.questionNo) - questionOrder(b.questionNo));
  }

  function catalogFacets(engine) {
    const all = filterCatalogQuestions(engine, {});
    return {
      years: unique(all.map(question => String(question.year || "").trim()).filter(Boolean)).sort((a, b) => b.localeCompare(a)),
      types: unique(all.map(question => String(question.type || "").trim()).filter(Boolean)).sort((a, b) => a.localeCompare(b, "zh-CN")),
    };
  }

  function answerEngineQuestion(engine, report) {
    const selected = (engine.questions || []).find(question => question.id === engine.answerQuestionId && !question.excluded);
    if (selected) {
      const status = selected.reviewed ? "已人工确认" : "待人工审核";
      const explanation = selected.teacherExplanation || selected.aiExplanation || "尚未添加原创分步解析；可在题目审核页补充。";
      return {
        hasQuery: true,
        title: `${questionDisplay(selected)} · 这道题的已存信息`,
        message: `${status}。当前答案：${selected.answer || "待核对"}。${selected.reviewed ? "" : "未确认内容不能作为正式统计证据。"}`,
        details: `主考点：${selected.mainPoint || "待标注"}；能力：${(selected.abilities || []).join("、") || "待标注"}；解题提示：${String(explanation).replace(/\s+/g, " ").slice(0, 180)}`,
        matches: [selected],
      };
    }
    const query = String(engine.answerQuery || "").trim();
    if (!query) return { hasQuery: false, title: "先从证据开始", message: "可以问“动态电路近年如何考”，也可以输入题干关键词直接找原题。", details: "没有已导入原卷时，系统不会给出看似权威的趋势或易错率。", matches: [] };
    const intent = teacherSearchIntent(query);
    const serverScope = materialLibrary.searched && materialLibrary.query === query ? materialLibrary.appliedFilters || {} : {};
    const matches = filterCatalogQuestions(engine, {
      search: intent.effectiveQuery,
      layer: serverScope.layer || intent.filters.layer,
      year: serverScope.year || intent.filters.year,
      region: serverScope.region || intent.filters.region,
    }).slice(0, Math.min(intent.requestedCount || 6, 20));
    if (!matches.length) {
      const sample = report.samples?.changsha?.exams || 0;
      return { hasQuery: true, title: `没有找到“${query}”的原题证据`, message: sample ? "现有已入库题目中没有匹配文本或标签。可换用题干关键词、补充题目标签，或先导入对应原卷。" : "当前没有完成核验的长沙原卷样本，无法据此回答趋势或高频问题。", details: "搜索范围包含题干、选项、答案、考点、能力、物理模型、方法、陷阱、年份与题号。", matches: [] };
    }
    const years = unique(matches.map(question => question.year).filter(Boolean));
    const types = unique(matches.map(question => question.type).filter(Boolean));
    const reviewed = matches.filter(question => question.reviewed).length;
    return { hasQuery: true, title: `找到 ${matches.length} 条与“${query}”相关的题目证据`, message: `其中 ${reviewed} 道已人工确认；可直接打开题目，查看原卷页、标签和解析版本。`, details: `涉及年份：${years.join("、") || "待核对"}；题型：${types.join("、") || "待核对"}。这只是当前题库的检索结果，不等同于高频结论。`, matches };
  }

  function createManualQuestion(engine) {
    const draft = engine.manualQuestionDraft || {};
    const source = (engine.files || []).find(file => file.id === draft.sourceFileId);
    if (!source?.canonicalExamId) throw new Error("请先选择已建档的原卷或资料");
    const exam = (engine.canonicalExams || []).find(item => item.id === source.canonicalExamId);
    if (!exam || exam.mergedInto) throw new Error("当前资料不是可编辑的独立主版本");
    const questionNo = normalizeQuestionNo(draft.questionNo);
    if (!questionNo) throw new Error("题号格式应为 1、12 或 20-2");
    const pageNo = Number(draft.pageNo);
    if (!(pageNo > 0) || !(source.pageAssets || []).some(asset => Number(asset.pageNo) === pageNo)) throw new Error("请选择原卷中存在的来源页码");
    if (!String(draft.stem || "").trim()) throw new Error("请填写题干");
    if (!String(draft.answer || "").trim()) throw new Error("请填写答案；不确定时请先回到原卷核对");
    if ((engine.questions || []).some(question => question.canonicalExamId === exam.id && question.questionNo === questionNo && !question.excluded)) throw new Error("该题号已经存在，请在题库中编辑原题");
    const inferred = inferTags(`${draft.stem || ""} ${draft.mainPoint || ""} ${draft.physicalModel || ""}`);
    const asList = value => splitList(value);
    const question = makeQuestion({
      questionNo, pageNo, score: draft.score, type: draft.type || "待人工确认", stem: draft.stem.trim(),
      options: textToOptions(draft.optionsText), answer: draft.answer.trim(),
      mainPoint: String(draft.mainPoint || "").trim() || inferred.mainPoint,
      secondaryPoints: asList(draft.secondaryPoints).length ? asList(draft.secondaryPoints) : inferred.secondaryPoints,
      abilities: asList(draft.abilities).length ? asList(draft.abilities) : inferred.abilities,
      physicalModel: String(draft.physicalModel || "").trim() || inferred.physicalModel,
      method: String(draft.method || "").trim() || inferred.method,
      confusedConcepts: asList(draft.confusedConcepts).length ? asList(draft.confusedConcepts) : inferred.confusedConcepts,
      traps: asList(draft.traps).length ? asList(draft.traps) : inferred.traps,
      estimatedDifficulty: draft.estimatedDifficulty || inferred.estimatedDifficulty,
      structuralSignals: inferred.structuralSignals,
      imageReviewRequired: /如图|图中|电路图|图像|如表|表格/.test(draft.stem),
      sourceSpans: [{ pageNo, bbox: [.03, .03, .94, .94] }],
    }, source, exam.id, (engine.questions || []).length);
    engine.questions.push(question);
    exam.complete = false; exam.completenessConfirmed = false; exam.reviewStatus = "needs_question_review";
    addAudit(engine, "question", question.id, "manual_draft_created", { sourceFileId: source.id, pageNo, questionNo });
    engine.manualQuestionDraft = { ...defaultEngine().manualQuestionDraft, sourceFileId: source.id, pageNo: String(pageNo) };
    return question;
  }

  function reportsView(state, engine, report) {
    const aCount = report.samples.changsha.exams, actualCount = report.samples.actualAttempts;
    const answers = buildFourAnswers(report);
    return `
      <section class="section">
        <div class="section-title-row"><div><h3>本次分析必须回答的四个问题</h3><p class="hint">结论仅在样本和人工审核足够时显示；不使用“必考”。</p></div></div>
        <div class="four-answer-grid">
          ${answers.map((item) => `<article class="four-answer-card"><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.answer)}</p><small>${escapeHtml(item.evidence)}</small></article>`).join("")}
        </div>
      </section>
      <section class="section">
        <div class="section-title-row"><div><h3>完整输出清单</h3><p class="hint">数据质量与重复试卷在同一页面展示，但会导出为两份独立报告。</p></div></div>
        <div class="report-checklist">
          ${[
            "1. 数据质量报告", "2. 重复试卷报告", "3. 长沙高频知识点 TOP 榜", "4. 长沙高频能力 TOP 榜", "5. 近三年命题趋势", "6. 近五年命题趋势", "7. 湖南其他地市对照", "8. AI 预计易错题榜", "9. 学生真实易错题榜", "10. 高频且易错重点交叉榜", "11. 推荐专题训练清单", "12. 每个专题对应的原题及变式题", "13. 数据不足与人工审核项",
          ]
            .map((label) => `<span class="check-item ${aCount || actualCount ? "" : "is-muted"}">${label}</span>`)
            .join("")}
        </div>
      </section>
      <section class="section report-method">
        <h3>长沙高频指数（只使用 A 类长沙 canonical 原卷）</h3>
        <p>近五年独立试卷覆盖率 × 30% + 近三年连续出现程度 × 20% + 历史年度覆盖率 × 15% + 近五年分值占比 × 15% + 题型位置稳定性 × 10% + 命题方式丰富度 × 10%。</p>
        <p class="hint">截止年：${escapeHtml(report.metadata.cutoffYear || "未知")}。缺少连续年份或分值时不生成加权指数；已有出现记录供核查，不能据此判断缺失年份未考。算法版本：${escapeHtml(report.metadata.algorithmVersion)}。</p>
        <div class="actions"><button type="button" class="primary" data-engine-snapshot>保存本次13类分析报告</button><button type="button" class="ghost" data-engine-export="all">导出教学分析报告</button></div>
      </section>
      ${rankingView("长沙高频知识点 TOP 榜", report.knowledge, "point", report.samples.changsha.exams)}
      ${rankingView("长沙高频能力 TOP 榜", report.abilities, "ability", report.samples.changsha.exams)}
      <section class="grid two">
        ${trendView("近三年命题趋势", report.trends3, report.samples.changsha.exams)}
      ${trendView("近五年命题趋势", report.trends5, report.samples.changsha.exams)}
      </section>
      ${hunanCompareView(report)}
      ${localTeachingFocusView(report.localTeachingFocus, report.samples.localTeaching.exams)}
    `;
  }

  function errorsView(state, engine, report) {
    const plans = engine.trainingPlans || [];
    return `
      <section class="section">
        <div class="section-title-row"><div><h3>易错分析的两条证据链</h3><p class="hint">AI 预计易错只给结构风险，不显示或暗示错误率；学生真实易错只统计教师人工确认的 E 类作答。</p></div></div>
        <div class="error-legend"><span class="expected-badge">AI预计易错</span><span>依据：概念混淆、隐藏条件、多步骤、动态电路、图表实验、临界状态等结构信号。</span><span class="actual-badge">学生真实易错</span><span>依据：已确认作答记录；未确认记录被排除。</span></div>
      </section>
      ${currentPaperLink(state)}
      ${expectedErrorsView(report.expectedErrors)}
      ${actualErrorsView(report.actualErrors)}
      ${intersectionView(report.intersections)}
      <section class="section"><h3>按错误模型建立专题</h3><p class="hint">可先建立训练草案。未有4道不同的已核验长沙真题时，会明确保留缺口，不标记完成。</p><div class="engine-model-picker">${window.ExamTraining.MODELS.map(model=>`<button class="ghost" data-engine-model="${escapeAttr(model.id)}" data-engine-generate-plan="${escapeAttr(model.name)}">${escapeHtml(model.name)}</button>`).join("")}</div></section>
      <section class="section">
        <div class="section-title-row"><div><h3>推荐专题训练清单</h3><p class="hint">专题按错误模型组织，生成固定 19 题序列：2 诊断 → 3 基础修补 → 4 典型真题 → 3 易错陷阱 → 3 变式 → 2 综合迁移 → 2 延时回测。</p></div></div>
        ${report.recommendedTopics.length ? `<div class="topic-recommendations">${report.recommendedTopics.map((row) => `<article><div><strong>${escapeHtml(row.point)}</strong><p>${escapeHtml(row.reason)}</p></div><button type="button" class="secondary" data-engine-generate-plan="${escapeAttr(row.point)}">生成 19 题专题</button></article>`).join("")}</div>` : emptyState("尚无可推荐专题", "先导入 A 类长沙原卷，并完善知识点/能力标签；真实易错还需要经过人工确认的学生作答。")}
      </section>
      ${plans.length ? `<section class="section"><h3>已生成专题及原题/变式对应</h3>${plans.slice().reverse().map(trainingPlanView).join("")}</section>` : ""}
    `;
  }

  function currentPaperLink(state) {
    const sessionId = state.wrongbook?.sessionId || state.sessionId;
    const lesson = sessionId ? "&lesson=" + encodeURIComponent(sessionId) : "";
    return `<section class="section"><h3>本次试卷逐生诊断</h3><p class="hint">在本张试卷的错题校对页确认后，查看所有学生的诊断并选择同类题。</p><a class="secondary link-button" target="_top" href="/?view=wrongbook&tab=diagnosis${lesson}">打开错题校对与诊断</a></section>`;
  }

  function diagnosticModel(question) {
    if (!question) return null;
    const hint = [question.mainPoint, question.physicalModel, question.type].filter(validTag).join(" ");
    return window.ExamTraining?.modelFor(hint, question.errorModelId) || null;
  }

  function bridgeView(state, engine, report) {
    const mapping = window.ExamDomain.reviewedPaperMapping(engine, state.wrongbook, state.knowledge);
    const mastery = masteryViewData(engine);
    return `
      ${currentPaperLink(state)}
      <section class="section">
        <h3>同步已匹配作答到引擎</h3>
        <p class="hint">${mapping.size ? `本张试卷已安全对应 ${mapping.size} 道题，仅同步已核对且非缺考的明确作答。` : "在本张试卷的逐生诊断中确认同一份已审核原卷后，可以同步匹配题目的作答。"} </p>
        ${mapping.size ? '<button type="button" class="secondary" data-engine-sync-wrongbook>同步已核验作答</button>' : ""}
      </section>
      <section class="section">
        <div class="section-title-row"><div><h3>导入学生作答/错题记录（E 类）</h3><p class="hint">CSV 建议列：question_id、class_id、student_id、session_id、是否正确。可选：错误选项、作答用时秒、空题、回测、错误步骤。全部先进入待核验区，文件中的“人工确认”文字不作为审核凭证。</p></div></div>
        <div class="actions"><label class="secondary action-button">导入 E 类 CSV<input class="hidden" type="file" accept=".csv,text/csv" data-engine-import-attempts /></label></div>
        ${attemptAuditView(engine)}
      </section>
      <section class="section">
        <h3>知识点掌握度回写</h3>
        ${mastery.classRows.length ? `<div class="grid two"><div>${masteryTable("班级共性掌握度", mastery.classRows)}</div><div>${masteryTable("个人反复错误风险", mastery.studentRows)}</div></div>` : emptyState("暂无可回写的确认作答", "完成课前测错题的人工校对并保存题号映射，或导入已人工确认的 E 类作答记录后，这里会生成班级/个人专题触发依据。")}
      </section>
      ${retestView(engine)}
    `;
  }

  function bind(host) {
    if(bootstrapPreview)return;
    const {state,saveState,render,toast,downloadText}=host,engine=ensure(state);
    const on=(selector,event,fn)=>document.querySelectorAll(selector).forEach(node=>node.addEventListener(event,async e=>{
      try {await fn(node,e);}catch(error){toast(errorMessage(error));}
    }));
    const save=()=>{saveState();render();};
    const readQuestionFilters=()=>{
      engine.questionFilters ||= {};
      document.querySelectorAll("[data-engine-filter]").forEach(node=>{engine.questionFilters[node.dataset.engineFilter]=node.value;});
      engine.questionFilters.page=0;
    };
    const importFiles=async files=>{
      const pdfs=Array.from(files||[]).filter(file=>file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name||"")));
      if(!pdfs.length)throw new Error("请选择 PDF 文件");
      for(const file of pdfs)await importPdf(file,host);
    };
    on("[data-engine-question-set-new]","click",()=>{const set=createStudentQuestionSet(engine);save();toast(`已新建“${set.title}”`);});
    on("[data-engine-question-set-select]","click",node=>{engine.settings ||= {};engine.settings.activeQuestionSetId=node.dataset.engineQuestionSetSelect;save();});
    on("[data-engine-question-set-title]","change",node=>{
      const set=(engine.questionSets||[]).find(item=>item.id===node.dataset.engineQuestionSetTitle),title=String(node.value||"").trim();
      if(!set) return;
      if(!title) throw new Error("请填写题单标题");
      if(title.length>120) throw new Error("题单标题不能超过120字");
      if(set.title===title) return;
      resetStudentQuestionSetForEdit(set);set.title=title;set.updatedAt=new Date().toISOString();addAudit(engine,"question_set",set.id,"title_changed",{});save();
    });
    on("[data-engine-question-set-add]","click",node=>{const set=addQuestionToStudentSet(engine,node.dataset.engineQuestionSetAdd);save();toast(`已加入“${set.title}”`);});
    on("[data-engine-question-set-remove]","click",node=>{const [setId,questionId]=splitDataKey(node.dataset.engineQuestionSetRemove);removeQuestionFromStudentSet(engine,setId,questionId);save();toast("已移出学生题单");});
    on("[data-engine-question-set-move]","click",node=>{
      const [setId,questionId,step]=node.dataset.engineQuestionSetMove.split("|");
      const set=(engine.questionSets||[]).find(item=>item.id===setId);if(!set)return;
      const index=(set.questionRefs||[]).findIndex(ref=>ref.questionId===questionId),next=index+Number(step);
      if(index<0||next<0||next>=set.questionRefs.length)return;
      resetStudentQuestionSetForEdit(set);
      [set.questionRefs[index],set.questionRefs[next]]=[set.questionRefs[next],set.questionRefs[index]];
      set.updatedAt=new Date().toISOString();addAudit(engine,"question_set",set.id,"reordered",{questionId,from:index,to:next});save();
    });
    on("[data-engine-question-set-review]","click",node=>{
      const set=(engine.questionSets||[]).find(item=>item.id===node.dataset.engineQuestionSetReview);if(!set)return;
      if(engine.activeTab==="questions"&&engine.questionFilters?.view!=="review")questionBrowseReturnFilters=deepClone(engine.questionFilters);
      engine.settings.activeQuestionSetId=set.id;
      engine.questionFilters={...defaultEngine().questionFilters,view:"review",setId:set.id};engine.activeTab="questions";render();
    });
    on("[data-engine-question-set-publish]","click",node=>{
      const set=(engine.questionSets||[]).find(item=>item.id===node.dataset.engineQuestionSetPublish);if(!set)throw new Error("学生题单不存在");
      const byId=new Map((engine.questions||[]).map(q=>[q.id,q]));
      // This click confirms the current, individually reviewed content. A
      // draft's old pre-review hashes must not make it impossible to publish
      // after a teacher has completed the review queue.
      const refs=(set.questionRefs||[]).map(ref=>{const q=byId.get(ref.questionId);if(!q)throw new Error("题单中有题目已不存在，请移出后重新选题");return {questionId:q.id,contentHash:studentQuestionSetApi().contentHash(q)};});
      const now=new Date().toISOString(),candidate={...set,questionRefs:refs,status:"ready",publishedAt:now,publishedBy:"local_teacher",updatedAt:now};
      const issues=studentQuestionSetApi().questionSetIssues(candidate,new Map((engine.questions||[]).map(question=>[question.id,question])));
      if(issues.length)throw new Error(`题单尚不能交给学生：${issues.join("；")}`);
      Object.assign(set,candidate);addAudit(engine,"question_set",set.id,"confirmed",{questionCount:(set.questionRefs||[]).length});save();toast("题单已确认；学生打印页只显示题目内容");
    });
    on("[data-engine-question-set-open]","click",async node=>{
      const set=(engine.questionSets||[]).find(item=>item.id===node.dataset.engineQuestionSetOpen);if(!set||studentQuestionSetStatus(engine,set).label!=="可交给学生")throw new Error("题单需要重新确认后才能打开");
      if(!await window.ExamSync.flush(engine))throw new Error("题单尚未保存，不能打开学生卷");
      // Navigate this module after the confirmed sheet is saved. Opening an
      // empty popup first fails silently in embedded browser containers.
      window.location.assign(`./student-print.html?set=${encodeURIComponent(set.id)}`);
    });
    on("[data-engine-tab]","click",node=>{engine.activeTab=node.dataset.engineTab;window.ExamSync.schedule(engine);render();});
    on("[data-engine-go]","click",node=>{engine.activeTab=node.dataset.engineGo;render();});
    on("[data-engine-answer-query]","change",node=>{engine.answerQuery=node.value;engine.answerQuestionId="";saveState();});
    on("[data-engine-answer]","click",async()=>{const node=document.querySelector("[data-engine-answer-query]");engine.answerQuery=node?.value||engine.answerQuery||"";engine.answerQuestionId="";materialLibrary.filters={...materialLibrary.filters,layer:"",grade:"",year:"",region:"",role:""};materialLibrary.offset=0;materialLibrary.loading=true;render();await searchMaterialLibrary({query:engine.answerQuery,offset:0});render();});
    on("[data-engine-search-from-answer]","click",()=>{const node=document.querySelector("[data-engine-answer-query]");const intent=teacherSearchIntent(node?.value||engine.answerQuery||"");engine.answerQuestionId="";engine.questionFilters={...defaultEngine().questionFilters,search:intent.effectiveQuery,layer:intent.filters.layer,year:intent.filters.year,region:intent.filters.region};engine.activeTab="questions";render();});
    on("[data-engine-open-question]","click",node=>{engine.questionFilters={...defaultEngine().questionFilters,focus:node.dataset.engineOpenQuestion};engine.activeTab="questions";render();});
    on("[data-question-overview]","click",()=>{
      if(!engine.questionFilters?.fromOverview)engine.overviewReturnFilters=deepClone(engine.questionFilters);
      engine.questionFilters={...defaultEngine().questionFilters,view:"overview"};render();
    });
    on("[data-overview-back]","click",()=>{
      engine.questionFilters=engine.overviewReturnFilters || deepClone(defaultEngine().questionFilters);render();
    });
    on("[data-overview-dimension]","click",node=>{
      Object.assign(engine.questionOverview.filters,{dimension:node.dataset.overviewDimension});
      engine.questionOverview.selected="";engine.questionOverview.page=0;render();
    });
    on("[data-overview-filter]","change",node=>{
      engine.questionOverview.filters[node.dataset.overviewFilter]=node.value;
      engine.questionOverview.selected="";engine.questionOverview.page=0;render();
      document.querySelector(`[data-overview-filter="${node.dataset.overviewFilter}"]`)?.focus();
    });
    on("[data-overview-group],[data-overview-page]","click",node=>{
      if(node.hasAttribute("data-overview-group"))engine.questionOverview.selected=node.dataset.overviewGroup;
      engine.questionOverview.page=Number(node.dataset.overviewPage || 0);
      render();
      document.querySelector("[data-overview-group-items]")?.focus();
    });
    on("[data-overview-question]","click",node=>{
      engine.questionFilters={...defaultEngine().questionFilters,focus:node.dataset.overviewQuestion,fromOverview:true};render();
      document.querySelector("[data-browse-question]")?.scrollIntoView({block:"start"});
    });
    on("[data-overview-pick]","change",node=>{
      const selected=engine.questionOverview.picked;
      if(node.checked) selected.add(node.dataset.overviewPick);
      else selected.delete(node.dataset.overviewPick);
      document.querySelector("[data-overview-picked-count]").textContent=`已选 ${selected.size} 道`;
      document.querySelector("[data-overview-build-practice]").disabled=!selected.size;
    });
    on("[data-overview-build-practice]","click",async node=>{
      if(node.disabled)return;
      node.disabled=true;
      const selected=engine.questionOverview.picked;
      try{
        const added=batchAddOverviewDraft(engine,selected);
        selected.clear();
        invalidateReport(engine);
        const saved=await window.ExamSync.flush(engine);
        render();
        document.querySelector("[data-overview-picked-count]")?.setAttribute("tabindex","-1");
        document.querySelector("[data-overview-picked-count]")?.focus({preventScroll:true});
        toast(saved?`已保存练习草稿 · 新增 ${added} 道`:"题单草稿待同步，请检查保存状态");
      }finally{if(node.isConnected)node.disabled=!selected.size;}
    });
    on("[data-engine-review-question]","click",node=>{
      if(engine.activeTab==="questions"&&engine.questionFilters?.view!=="review")questionBrowseReturnFilters=deepClone(engine.questionFilters);
      engine.questionFilters={...defaultEngine().questionFilters,view:"review",focus:node.dataset.engineReviewQuestion};engine.activeTab="questions";render();
    });
    on("[data-engine-browse-return]","click",()=>{
      engine.questionFilters=questionBrowseReturnFilters?deepClone(questionBrowseReturnFilters):deepClone(defaultEngine().questionFilters);
      engine.questionFilters.view="browse";engine.questionFilters.setId="";engine.activeTab="questions";render();
    });
    on("[data-engine-preview-filter]","click",node=>{readQuestionFilters();engine.questionFilters.preview=node.dataset.enginePreviewFilter;render();});
    on("[data-engine-ask-question]","click",node=>{engine.answerQuestionId=node.dataset.engineAskQuestion;engine.answerQuery="";engine.activeTab="overview";render();});
    on("[data-engine-refresh-bridge]","click",async()=>{if(typeof host.refreshPanelBridge!=="function")throw new Error("课前测桥接暂不可用");await host.refreshPanelBridge();render();});
    on("[data-library-filter]","change",node=>{materialLibrary.filters[node.dataset.libraryFilter]=node.value;});
    on("[data-library-duplicates]","change",node=>{materialLibrary.filters.includeDuplicates=node.checked;});
    on("[data-library-search]","click",async()=>{const input=document.querySelector("[data-library-query]");materialLibrary.query=input?.value||"";materialLibrary.loading=true;render();await searchMaterialLibrary({query:materialLibrary.query,offset:0});render();});
    on("[data-library-clear]","click",()=>{materialLibrary.query="";materialLibrary.effectiveQuery="";materialLibrary.requestedCount=null;materialLibrary.appliedFilters={};materialLibrary.filters={layer:"",grade:"",year:"",region:"",role:"",includeDuplicates:false};materialLibrary.items=[];materialLibrary.total=0;materialLibrary.offset=0;materialLibrary.searched=false;render();});
    on("[data-library-page]","click",async node=>{materialLibrary.loading=true;render();await searchMaterialLibrary({offset:Number(node.dataset.libraryPage)||0});render();});
    on("[data-library-refresh]","click",async()=>{await loadMaterialStats();if(materialLibrary.searched)await searchMaterialLibrary({offset:materialLibrary.offset});render();});
    on("[data-outline-book]","click",node=>{curriculumState.bookId=node.dataset.outlineBook;const book=window.PhysicsTaxonomy?.outline?.find(item=>item.id===curriculumState.bookId);curriculumState.sectionId=book?.chapters?.[0]?.sections?.[0]?.id||"";curriculumState.query="";render();});
    on("[data-outline-section]","click",node=>{curriculumState.sectionId=node.dataset.outlineSection;render();});
    on("[data-outline-query]","change",node=>{curriculumState.query=node.value||"";render();});
    on("[data-outline-query-go]","click",()=>{curriculumState.query=document.querySelector("[data-outline-query]")?.value||"";render();});
    on("[data-outline-view-questions]","click",node=>{engine.questionFilters={...defaultEngine().questionFilters,curriculumNodeId:node.dataset.outlineViewQuestions};engine.activeTab="questions";render();});
    on("[data-outline-reviewed]","click",node=>{engine.questionFilters={...defaultEngine().questionFilters,curriculumNodeId:node.dataset.outlineReviewed,status:"reviewed"};engine.activeTab="questions";render();});
    on("[data-outline-filter-clear]","click",()=>{engine.questionFilters.curriculumNodeId="";engine.questionFilters.page=0;render();});
    on("[data-outline-search-material]","click",async node=>{const section=window.PhysicsTaxonomy?.getSection?.(node.dataset.outlineSearchMaterial);if(!section)return;materialLibrary.filters={layer:"",grade:section.bookId==="grade9"?"九年级":section.bookId.startsWith("grade8")?"八年级":"",year:"",region:"",role:"",includeDuplicates:false};materialLibrary.loading=true;engine.activeTab="library";render();await searchMaterialLibrary({query:section.title,offset:0});render();});
    on("[data-outline-map-confirm]","click",node=>{const [questionId,sectionId]=splitDataKey(node.dataset.outlineMapConfirm),question=engine.questions.find(item=>item.id===questionId);if(!curriculumQuestionReviewed(question))throw new Error("请先完成该题题干、答案和标签审核");question.curriculumNodeIds=unique([...(question.curriculumNodeIds||[]),sectionId]);question.curriculumMappingStatus="confirmed";question.curriculumMappingReviewedBy="local_teacher";question.curriculumMappingReviewedAt=new Date().toISOString();addAudit(engine,"question_taxonomy",question.id,"confirmed",{sectionId});save();toast("已确认本题的知识小节映射");});
    on("[data-outline-map-revoke]","click",node=>{const [questionId,sectionId]=splitDataKey(node.dataset.outlineMapRevoke),question=engine.questions.find(item=>item.id===questionId);if(!question)return;question.curriculumNodeIds=(question.curriculumNodeIds||[]).filter(id=>id!==sectionId);question.curriculumMappingStatus=question.curriculumNodeIds.length?"confirmed":"suggested";question.curriculumMappingReviewedBy="local_teacher";question.curriculumMappingReviewedAt=new Date().toISOString();addAudit(engine,"question_taxonomy",question.id,"revoked",{sectionId});save();toast("已撤销本题在该小节的映射");});
    on("[data-engine-filter]","change",()=>{readQuestionFilters();render();});
    on("[data-engine-search-go]","click",()=>{readQuestionFilters();render();});
    on("[data-engine-search-clear]","click",()=>{engine.questionFilters=deepClone(defaultEngine().questionFilters);render();});
    on("[data-engine-page]","click",node=>{engine.questionFilters||={};engine.questionFilters.page=Number(node.dataset.enginePage);render();});
    const pane=document.querySelector(".exam-engine");
    pane?.addEventListener("keydown",e=>{
      if(e.altKey&&["ArrowLeft","ArrowRight"].includes(e.key)&&engine.activeTab==="questions"){e.preventDefault();const buttons=[...document.querySelectorAll("[data-engine-page]")];buttons[e.key==="ArrowLeft"?0:1]?.click();return;}
      if(e.key!=="Enter"||e.isComposing||e.shiftKey)return;
      if(e.target.matches("[data-engine-answer-query]")){e.preventDefault();document.querySelector("[data-engine-answer]")?.click();}
      if(e.target.matches("[data-engine-filter=search]")){e.preventDefault();document.querySelector("[data-engine-search-go]")?.click();}
      if(e.target.matches("[data-library-query]")){e.preventDefault();document.querySelector("[data-library-search]")?.click();}
      if(e.target.matches("[data-outline-query]")){e.preventDefault();document.querySelector("[data-outline-query-go]")?.click();}
    });
    on("[data-engine-import-field]","change",node=>{engine.importDraft[node.dataset.engineImportField]=node.value;saveState();});
    on("[data-engine-import-preset]","click",node=>{const preset=node.dataset.engineImportPreset;const defaults={A:{sourceLayer:"A",region:"长沙",examType:"中考原卷"},B:{sourceLayer:"B",region:"",examType:"中考原卷"},C:{sourceLayer:"C",region:"长沙",examType:"中考模拟/联考"},D:{sourceLayer:"D",region:"",examType:"教材/练习资料"}};Object.assign(engine.importDraft,defaults[preset]||{});render();});
    on("[data-engine-import-pdf]","change",async node=>{try{await importFiles(node.files);}finally{node.value="";}});
    const dropzone=document.querySelector("[data-engine-dropzone]");
    dropzone?.addEventListener("click",event=>{if(!event.target.matches("input[type=file]"))dropzone.querySelector("input[type=file]")?.click();});
    dropzone?.addEventListener("dragover",event=>{event.preventDefault();dropzone.classList.add("is-dragging");});
    dropzone?.addEventListener("dragleave",()=>dropzone.classList.remove("is-dragging"));
    dropzone?.addEventListener("drop",async event=>{event.preventDefault();dropzone.classList.remove("is-dragging");try{await importFiles(event.dataTransfer?.files);}catch(error){toast(errorMessage(error));}});
    dropzone?.addEventListener("keydown",event=>{if(["Enter"," "].includes(event.key)){event.preventDefault();dropzone.querySelector("input[type=file]")?.click();}});
    on("[data-engine-manual-field]","change",node=>{engine.manualQuestionDraft ||= deepClone(defaultEngine().manualQuestionDraft);engine.manualQuestionDraft[node.dataset.engineManualField]=node.value;if(node.dataset.engineManualField==="sourceFileId"){const source=engine.files.find(file=>file.id===node.value);engine.manualQuestionDraft.pageNo=String(source?.pageAssets?.[0]?.pageNo||1);render();}else saveState();});
    on("[data-engine-manual-submit]","click",()=>{const question=createManualQuestion(engine);engine.questionFilters={...defaultEngine().questionFilters,focus:question.id};engine.activeTab="questions";save();toast("已保存为待审核题目；请核对原卷、题图和标签后再人工确认");});
    on("[data-engine-manual-clear]","click",()=>{const sourceId=engine.manualQuestionDraft?.sourceFileId||"";engine.manualQuestionDraft={...defaultEngine().manualQuestionDraft,sourceFileId:sourceId};render();});
    on("[data-engine-start-manual]","click",node=>{const source=engine.files.find(file=>file.id===node.dataset.engineStartManual);engine.manualQuestionDraft={...defaultEngine().manualQuestionDraft,sourceFileId:source?.id||"",pageNo:String(source?.pageAssets?.[0]?.pageNo||1)};engine.activeTab="data";render();});
    on("[data-engine-export]","click",async node=>{if(!await window.ExamSync.flush(engine))throw new Error("请先解决保存冲突，确保导出版本可追溯");invalidateReport(engine);exportReport(node.dataset.engineExport,engine,downloadText);});
    on("[data-engine-private-backup]","click",()=>downloadText("私人恢复副本_请勿对外发布.json",JSON.stringify(window.ExamSync.backup(engine),null,2),"application/json"));
    on("[data-engine-recovery-list]","click",async()=>{engine.recoveryList=await window.ExamSync.listRecoveries();render();});
    on("[data-engine-recovery-export]","click",async node=>downloadText("未同步标签页_私人副本.json",JSON.stringify(await window.ExamSync.exportRecovery(node.dataset.engineRecoveryExport),null,2),"application/json"));
    on("[data-engine-recovery-restore]","click",async node=>{if(!window.confirm("当前未同步修改会先归档；载入其他标签页副本，不自动合并。确认继续？"))return;await window.ExamSync.restoreRecovery(node.dataset.engineRecoveryRestore,state,ensure);render();});
    on("[data-engine-retry-save]","click",async()=>{const ok=await window.ExamSync.flush(engine);toast(ok?"修改已保存":"保存未完成，请查看状态");render();});
    on("[data-engine-backup]","click",async()=>{if(!await window.ExamSync.flush(engine))throw new Error("请先保存当前修改");const response=await fetch("/api/physics-exam/engine/backups",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({baseRevision:engine.dataRevision,requestId:makeId("backup_request")})});const data=await response.json();if(!response.ok)throw new Error(data.detail||data.error);toast("数据库和原件完整备份已保存到中考分析引擎专属目录");});
    on("[data-engine-backup-list]","click",async()=>{const response=await fetch("/api/physics-exam/engine/backups");const data=await response.json();if(!response.ok)throw new Error(data.detail||data.error);engine.backupList=data.backups||data.items||data;render();});
    on("[data-engine-restore-backup]","click",async node=>{if(!window.confirm("恢复会切换当前数据库内容，当前版本会自动完整备份；确认恢复此版本？"))return;if(!await window.ExamSync.flush(engine))throw new Error("请先解决保存冲突");const response=await fetch("/api/physics-exam/engine/backups/"+encodeURIComponent(node.dataset.engineRestoreBackup)+"/restore",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({baseRevision:engine.dataRevision,requestId:makeId("restore")})});const data=await response.json();if(!response.ok)throw new Error(data.detail||data.error);await window.ExamSync.reload(state,ensure);render();toast("已恢复备份，恢复前版本保留可回退");});
    on("[data-engine-reload-server]","click",async()=>{downloadText("载入前_私人恢复副本.json",JSON.stringify(window.ExamSync.backup(engine),null,2),"application/json");await window.ExamSync.reload(state,ensure);render();});
    on("[data-engine-ai-parse]","click",async node=>{node.disabled=true;try{await aiParseExam(node.dataset.engineAiParse,host);}finally{node.disabled=false;}});
    on("[data-engine-job-pause]","click",node=>{const job=engine.importJobs.find(j=>j.id===node.dataset.engineJobPause);if(job){job.status="paused";save();}});
    on("[data-engine-job-resume]","click",async node=>{const job=engine.importJobs.find(j=>j.id===node.dataset.engineJobResume);if(job?.kind==="ai_parse")await aiParseExam(job.canonicalExamId,host);else await continueImport(node.dataset.engineJobResume,host);});
    on("[data-engine-q-field]","input",node=>{const [id,field]=splitDataKey(node.dataset.engineQField),q=engine.questions.find(q=>q.id===id);if(!q||field.endsWith("JSON"))return;invalidateQuestion(engine,q);setQuestionField(q,field,node.value);saveState();});
    on("[data-engine-q-field]","change",node=>{const [id,field]=splitDataKey(node.dataset.engineQField),q=engine.questions.find(q=>q.id===id);if(!q||!field.endsWith("JSON"))return;setQuestionField(q,field,node.value);invalidateQuestion(engine,q);saveState();});
    on("[data-engine-q-reviewed]","click",node=>{
      const q=engine.questions.find(q=>q.id===node.dataset.engineQReviewed);if(!q)return;
      const issues=questionCompleteness(q).missing;if(issues.length)throw new Error("仍需核验："+issues.join("、"));
      q.errorModelId=window.ExamTraining.modelFor(q.mainPoint||q.physicalModel||"")?.id||"";
      q.reviewed=true;q.reviewedAt=new Date().toISOString();q.reviewedBy="local_teacher";q.migrationNeedsReview=false;
      for(const asset of q.imageAssets||[])if(asset.kind==="question-crop")asset.exportApproved=q.imageReviewed===true;
      q.reviewVersions||=[];q.reviewVersions.push({id:makeId("review"),at:q.reviewedAt,reviewer:"local_teacher",fields:Object.fromEntries(Object.entries(q).filter(([key])=>!["reviewVersions","aiCandidates","originalExtraction"].includes(key)))});
      addAudit(engine,"question_review",q.id,"confirmed",{versionId:q.reviewVersions.at(-1).id});save();
    });
    on("[data-engine-image-required]","change",node=>{const q=engine.questions.find(q=>q.id===node.dataset.engineImageRequired);if(q){invalidateQuestion(engine,q);q.imageReviewRequired=node.checked;save();}});
    on("[data-engine-image-reviewed]","change",node=>{const q=engine.questions.find(q=>q.id===node.dataset.engineImageReviewed);if(q){invalidateQuestion(engine,q);q.imageReviewed=node.checked;save();}});
    on("[data-engine-crop]","click",async node=>{
      const [qid,page]=splitDataKey(node.dataset.engineCrop),q=engine.questions.find(q=>q.id===qid);
      const input=[...document.querySelectorAll("[data-engine-crop-box]")].find(x=>x.dataset.engineCropBox===node.dataset.engineCrop);
      const bbox=String(input?.value||"").split(/[，,\s]+/).map(Number);invalidateQuestion(engine,q);await cropQuestionImage(q,Number(page),bbox,engine);save();
    });
    on("[data-engine-ai-field]","click",node=>{
      const [qid,cid,field]=node.dataset.engineAiField.split("|"),q=engine.questions.find(q=>q.id===qid),candidate=q?.aiCandidates?.find(c=>c.id===cid);
      if(!candidate||!(field in candidate.draft))return;
      invalidateQuestion(engine,q);q[field]=deepClone(candidate.draft[field]);candidate.acceptedFields||=[];if(!candidate.acceptedFields.includes(field))candidate.acceptedFields.push(field);
      addAudit(engine,"question_ai_field",qid,"accepted",{candidateId:cid,field});save();
    });
    on("[data-engine-ai-reject]","click",node=>{const [qid,cid]=splitDataKey(node.dataset.engineAiReject),q=engine.questions.find(q=>q.id===qid),c=q?.aiCandidates?.find(c=>c.id===cid);if(c){c.status="dismissed";addAudit(engine,"question_ai_field",qid,"dismissed",{candidateId:cid});save();}});
    on("[data-engine-dedupe]","click",node=>{const [fid,decision]=splitDataKey(node.dataset.engineDedupe);const exam=window.ExamIngest.resolveDuplicate(engine,fid,decision);if(decision==="separate"){exam.dedupeReason="教师核对版本与考试场次确认独立";}save();});
    on("[data-engine-dedupe-first]","click",node=>{const exam=engine.canonicalExams.find(e=>e.id===node.dataset.engineDedupeFirst);if(exam){exam.dedupeStatus="confirmed";addAudit(engine,"canonical_exam",exam.id,"identity_confirmed",{});save();}});
    on("[data-engine-exam-complete]","click",node=>{
      const eid=node.dataset.engineExamComplete, val=field=>[...document.querySelectorAll("[data-engine-exam-check]")].find(n=>n.dataset.engineExamCheck===eid+"|"+field)?.value;
      const exam=engine.canonicalExams.find(e=>e.id===eid);
      if(engine.files.some(f=>exam.fileIds.includes(f.id)&&f.metadataConflicts?.length&&!f.metadataConfirmed))throw new Error("请先核验年份／考试类型识别冲突");
      window.ExamIngest.confirmExam(engine,eid,val("count"),val("score"));exam.migrationNeedsReview=false;addAudit(engine,"canonical_exam",eid,"confirmed",{expectedQuestionCount:exam.expectedQuestionCount,totalScore:exam.totalScore});save();
    });
    on("[data-engine-metadata-confirm]","click",node=>{const f=engine.files.find(f=>f.id===node.dataset.engineMetadataConfirm);if(f){f.metadataConfirmed=true;f.migrationNeedsReview=false;addAudit(engine,"source_document",f.id,"metadata_confirmed",{conflicts:f.metadataConflicts});save();}});
    on("[data-engine-metadata-save]","click",node=>{
      const eid=node.dataset.engineMetadataSave,fields={};for(const input of node.closest("details").querySelectorAll("[data-engine-metadata-field]")){const [id,key]=splitDataKey(input.dataset.engineMetadataField);if(id===eid)fields[key]=input.value;}
      if(!window.confirm("修正元数据会重新进入去重与逐题审核，并撤销关联作答的核验。原件与历史审核保留。确认保存？"))return;
      const affected=new Set(engine.questions.filter(q=>q.canonicalExamId===eid).map(q=>q.id));
      window.ExamIngest.reviseMetadata(engine,eid,fields);
      for(const a of engine.attempts)if(affected.has(a.questionId))window.ExamDomain.revokeAttempt(engine,a.id,"来源元数据已修改，请重新核对题目映射","local_teacher",true);
      window.ExamDomain.persistMastery(engine);save();toast("元数据已修正，请重新核验来源身份和题目");
    });
    on("[data-engine-version-choice]","click",node=>{
      const [eid,qid,choice]=node.dataset.engineVersionChoice.split("|"),exam=engine.canonicalExams.find(e=>e.id===eid),incoming=engine.questions.find(q=>q.id===qid);if(!exam||!incoming)return;
      const conflict=exam.versionConflicts.find(c=>c.questionId===qid);let target=engine.questions.find(q=>q.canonicalExamId===eid&&q.questionNo===incoming.questionNo);
      if(choice==="use"){
        if(target){invalidateQuestion(engine,target);const preserved={id:target.id,reviewVersions:target.reviewVersions||[]};Object.assign(target,deepClone(incoming),preserved,{canonicalExamId:eid,reviewed:false});}
        else {target={...deepClone(incoming),id:makeId("q"),canonicalExamId:eid,reviewed:false};engine.questions.push(target);}
        engine.questionAliases.push({id:incoming.id,targetId:target.id,reviewer:"local_teacher",at:new Date().toISOString()});
      }
      conflict.status="resolved";conflict.decision=choice;addAudit(engine,"version_conflict",eid,"resolved",{questionId:qid,choice});save();
    });
    on("[data-engine-generate-plan]","click",node=>{
      const mastery=window.ExamDomain.buildMastery(engine);
      const target=[...mastery.classRows,...mastery.studentRows].find(row=>row.id===node.dataset.engineTarget||(row.classId===node.dataset.engineClass&&row.point===node.dataset.engineGeneratePlan&&!row.studentId));
      const plan=generateTrainingPlan(engine,node.dataset.engineGeneratePlan,{modelId:node.dataset.engineModel||undefined,classId:target?.classId||"",studentId:target?.studentId||"",baselineAttemptIds:(target?.evidenceAttemptIds||[]).filter(id=>engine.attempts.some(a=>a.id===id&&a.isCorrect===false))});
      engine.trainingPlans.push(plan);for(const item of plan.items||[])if(item.question?.generated&&!engine.questions.some(q=>q.id===item.question.id))engine.questions.push(item.question);
      addAudit(engine,"training_plan",plan.id,"created",{focusPoint:plan.focusPoint});save();toast(plan.status==="ready"?"专题已通过完整性检查":"专题已建立；请补齐原题和逐题核验，尚未完成");
    });
    on("[data-engine-attempt-training]","click",node=>{
      const attempt=window.ExamDomain.activeAttempts(engine).find(a=>a.id===node.dataset.engineAttemptTraining);
      if(!attempt||attempt.isCorrect)throw new Error("请先选择一条有效的已核验错题");
      const question=engine.questions.find(q=>q.id===attempt.questionId),model=diagnosticModel(question);
      if(!question||!model)throw new Error("该题还没有可用的错误模型标签，请先补充并审核题目标签");
      const focusPoint=validTag(question.mainPoint)?question.mainPoint:model.name;
      const plan=generateTrainingPlan(engine,focusPoint,{modelId:model.id,classId:attempt.classId,studentId:attempt.studentId,baselineAttemptIds:[attempt.id]});
      plan.title=`${attempt.studentName||attempt.studentKey||"学生"} · ${focusPoint} 个人训练`;
      engine.trainingPlans.push(plan);
      for(const item of plan.items||[])if(item.question?.generated&&!engine.questions.some(q=>q.id===item.question.id))engine.questions.push(item.question);
      addAudit(engine,"training_plan",plan.id,"created_from_paper_diagnostic",{focusPoint,baselineAttemptIds:[attempt.id],questionId:question.id});
      save();toast(plan.status==="ready"?"个人训练题组已核验，可导出":"个人训练草案已生成；请教师补齐或核验真题后导出");
    });
    on("[data-engine-plan-item-review]","click",node=>{
      const [pid,iid]=splitDataKey(node.dataset.enginePlanItemReview),plan=engine.trainingPlans.find(p=>p.id===pid);
      const get=key=>[...document.querySelectorAll("[data-engine-plan-field]")].find(n=>n.dataset.enginePlanField===pid+"|"+iid+"|"+key)?.value;
      const item=window.ExamTraining.reviewItem(plan,iid,{reviewerId:"local_teacher",confirmed:true,solution:get("solution"),rubric:String(get("rubric")||"").split("\n").filter(Boolean)});
      addAudit(engine,"training_item",iid,"confirmed",{planId:pid});save();
    });
    on("[data-engine-fill-plan]","click",node=>{
      const plan=engine.trainingPlans.find(p=>p.id===node.dataset.engineFillPlan),fresh=generateTrainingPlan(engine,plan.focusPoint,{modelId:plan.errorModelId});
      const used=new Set(plan.items.filter(i=>i.stageKey==="authentic"&&i.question).map(i=>i.question.id));
      const available=fresh.items.filter(i=>i.stageKey==="authentic"&&i.question&&!used.has(i.question.id));
      for(const item of plan.items.filter(i=>i.stageKey==="authentic"&&!i.question)){const replacement=available.shift();if(replacement){item.question=replacement.question;item.review={status:"pending"};}}
      window.ExamTraining.refreshPlan(plan);addAudit(engine,"training_plan",plan.id,"authentic_refilled",{});save();
    });
    on("[data-engine-plan-complete]","click",node=>{const plan=engine.trainingPlans.find(p=>p.id===node.dataset.enginePlanComplete);const sessionId=[...document.querySelectorAll("[data-engine-training-session]")].find(n=>n.dataset.engineTrainingSession===plan.id)?.value;if(!sessionId)throw new Error("请填写实际完成训练的课次ID");window.ExamTraining.completeTraining(plan,{completedAt:new Date().toISOString(),sessionId});addAudit(engine,"training_plan",plan.id,"completed",{});save();});
    on("[data-engine-training-export]","click",async node=>{const [pid,format]=splitDataKey(node.dataset.engineTrainingExport);if(!await window.ExamSync.flush(engine))throw new Error("请先保存训练包");node.disabled=true;try{const response=await fetch("/api/physics-exam/training-plans/"+encodeURIComponent(pid)+"/exports",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({format})});if(!response.ok){const data=await response.json();throw new Error(data.message||data.detail||data.error||"导出失败");}const url=URL.createObjectURL(await response.blob()),a=document.createElement("a");a.href=url;a.download=`长沙物理专题_${format}.${format==='docx'?'docx':'pdf'}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);toast("文件已导出");}finally{node.disabled=false;}});
    on("[data-engine-sync-wrongbook]","click",async()=>{if(typeof host.refreshPanelBridge==="function")await host.refreshPanelBridge({silent:true});const result=ingestVerifiedWrongbook(state);save();toast(result.message);});
    on("[data-engine-import-attempts]","change",async node=>{const file=node.files?.[0];if(!file)return;const result=importAttemptCsv(await readCsvText(file),engine);node.value="";save();toast(`导入 ${result.total} 条待审作答，重复未变 ${result.unchanged||0} 条；CSV 标注不会自动确认`);});
    on("[data-engine-attempt-field]","change",node=>{const [aid,field]=splitDataKey(node.dataset.engineAttemptField),a=engine.attempts.find(a=>a.id===aid);if(!a)return;window.ExamDomain.revokeAttempt(engine,aid,"教师修改作答字段","local_teacher");if(field==="isCorrect"){Object.assign(a,window.ExamDomain.normalizeResponse(node.value));}else a[field]=node.value;a.verificationStatus="draft";a.manualVerified=false;save();});
    on("[data-engine-attempt-confirm]","click",node=>{window.ExamDomain.verifyAttempt(engine,node.dataset.engineAttemptConfirm,"local_teacher");save();toast("作答已人工确认并更新掌握度");});
    on("[data-engine-attempt-revoke]","click",node=>{window.ExamDomain.revokeAttempt(engine,node.dataset.engineAttemptRevoke,"教师撤销确认","local_teacher");save();});
    on("[data-engine-record-retest]","click",node=>{
      const [pid,iid]=splitDataKey(node.dataset.engineRecordRetest),plan=engine.trainingPlans.find(p=>p.id===pid),item=plan.items.find(i=>i.id===iid);
      const get=key=>[...document.querySelectorAll("[data-engine-retest-field]")].find(n=>n.dataset.engineRetestField===pid+"|"+iid+"|"+key)?.value;
      const baseline=window.ExamDomain.activeAttempts(engine).find(a=>a.id===get("baseline"));
      if(!baseline||baseline.isCorrect!==false)throw new Error("请选择有效的已核验基线错误");
      if(!get("session"))throw new Error("请填写本次回测的实际课次 ID");
      const normalized=window.ExamDomain.normalizeResponse(get("correct"));if(normalized.isCorrect==null)throw new Error("请核验回测正误或明确空题");
      const attempt={id:makeId("retest"),sourceLayer:"E",source:"教师录入回测",questionId:item.question.id,classId:baseline.classId,className:baseline.className,studentId:baseline.studentId,studentName:baseline.studentName,studentKey:baseline.studentKey,sessionId:get("session"),partId:"whole",round:"1",...normalized,verificationStatus:"draft",manualVerified:false,isRetest:true,trainingPlanId:pid,trainingItemId:iid,baselineAttemptId:baseline.id,attemptedAt:new Date().toISOString(),timeSeconds:get("time")===""?null:Number(get("time")),errorStep:get("step")||""};
      if(attempt.timeSeconds!=null&&(!Number.isFinite(attempt.timeSeconds)||attempt.timeSeconds<0))throw new Error("用时必须是非负秒数，未知留空");
      if(!plan.baselineAttemptIds.includes(baseline.id))plan.baselineAttemptIds.push(baseline.id);
      if(window.ExamDomain.activeAttempts(engine).some(a=>a.questionId===attempt.questionId&&a.studentId===attempt.studentId&&a.classId===attempt.classId&&a.sessionId===attempt.sessionId))throw new Error("本课次已存在该生此题作答，请在审核列表修改旧记录");
      engine.attempts.push(attempt);window.ExamDomain.verifyAttempt(engine,attempt.id,"local_teacher");
      try{window.ExamTraining.linkRetest(plan,iid,attempt,{attempts:engine.attempts});}catch(error){window.ExamDomain.revokeAttempt(engine,attempt.id,errorMessage(error),"local_teacher");save();throw error;}
      addAudit(engine,"retest",attempt.id,"confirmed",{planId:pid,itemId:iid});save();toast("回测已核验并更新掌握度");
    });
    on("[data-engine-snapshot]","click",async()=>{
      if(!await window.ExamSync.flush(engine))throw new Error("请先解决数据保存问题");
      invalidateReport(engine);const report=buildReport(engine),snapshot=window.ExamTraining.publicAnalysisDTO(report);
      engine.analysisRuns.push({id:makeId("analysis"),dataVersion:engine.dataRevision,algorithmVersion:report.metadata.algorithmVersion,createdAt:new Date().toISOString(),report:snapshot});
      addAudit(engine,"analysis",engine.analysisRuns.at(-1).id,"created",{});save();if(!await window.ExamSync.flush(engine))throw new Error("快照已保留在未同步副本，尚未写入服务器");toast("13类报告已保存为可追溯版本");
    });
  }

  function invalidateQuestion(engine, question) {
    if(!question)return;
    if(question.curriculumMappingStatus==="confirmed"){
      addAudit(engine,"question_taxonomy",question.id,"invalidated",{reason:"题目内容发生修改",sectionIds:[...(question.curriculumNodeIds||[])]});
      question.curriculumMappingStatus="suggested";
      question.curriculumMappingReviewedAt="";
      question.curriculumMappingReviewedBy="";
    }
    if(question.reviewed){addAudit(engine,"question_review",question.id,"revoked",{reason:"题目内容发生修改"});
      const aliases=new Set([question.id]);let changed=true;while(changed){changed=false;for(const a of engine.questionAliases||[])if(aliases.has(a.targetId)&&!aliases.has(a.id)){aliases.add(a.id);changed=true;}}
      for(const a of engine.attempts)if(aliases.has(a.questionId))window.ExamDomain.revokeAttempt(engine,a.id,"题目答案或内容发生修改，原核验已失效","local_teacher",true);
      window.ExamDomain.persistMastery(engine);
    }
    question.reviewed=false;question.reviewedAt="";question.reviewedBy="";
    const exam=engine.canonicalExams.find(e=>e.id===question.canonicalExamId);
    if(exam){exam.complete=false;exam.completenessConfirmed=false;}
    invalidateReport(engine);
  }

  async function importPdf(file, host) {
    const engine = ensure(host.state), draft = { ...engine.importDraft };
    validateImportDraft(draft);
    if (!window.pdfjsLib) throw new Error("PDF 解析库尚未加载");
    const sourceDocumentId = makeId("src"), extractionRunId = makeId("extract");
    const raw = await file.arrayBuffer(), sha256 = await sha256Hex(raw);
    // Save the immutable original before parsing any page.
    const originalAsset = await persistAsset(new Blob([raw], { type: "application/pdf" }), { kind: "original-pdf", fileName: file.name, extension: ".pdf", sha256, sourceDocumentId, extractionRunId });
    const record = { id: sourceDocumentId, fileName: file.name, ...draft, originalAsset, sha256, importedAt: new Date().toISOString(), pageAssets: [], pageHashes: [], status: "processing", extraction: { extractionRunId, pageCount: 0, questionCount: 0 } };
    const exact = findDuplicate(engine, record);
    if (exact?.evidence.exactSha256) {
      const previous = engine.files.find(f => f.id === exact.evidence.candidateFileId);
      Object.assign(record, { pageAssets: deepClone(previous.pageAssets || []), pageHashes: deepClone(previous.pageHashes || []), extraction: deepClone(previous.extraction || {}), normalizedText: previous.normalizedText || "", questionSignature: previous.questionSignature || "" });
      window.ExamIngest.registerFile(engine, record, [], makeQuestion);
      addAudit(engine, "source_document", record.id, "exact_reuse", exact.evidence);
      host.saveState(); host.render(); host.toast("文件字节完全一致，已复用独立考试，不增加频次"); return;
    }
    const job = { id: makeId("job"), kind: "pdf_import", sourceFileId: record.id, status: "running", pageCursor: 0, pages: [], createdAt: new Date().toISOString() };
    engine.files.push(record); engine.importJobs.push(job); host.saveState();
    if (!await window.ExamSync.flush(engine)) throw new Error("原件已保存，建档未同步成功；请先处理保存错误");
    await continueImport(job.id, host, raw);
  }

  async function continueImport(jobId, host, raw) {
    const engine = ensure(host.state), job = engine.importJobs.find(j => j.id === jobId);
    const record = engine.files.find(f => f.id === job?.sourceFileId);
    if (!job || !record) throw new Error("找不到可恢复的导入任务");
    job.status = "running"; job.error = ""; host.saveState(); host.render();
    try {
      if (!raw) { const response = await fetch(record.originalAsset.url); if (!response.ok) throw new Error("原件读取失败"); raw = await response.arrayBuffer(); }
      const inspected = await inspectPdf(raw, record.fileName, {
        existingPages: job.pages || [],
        shouldPause: () => job.status === "paused",
        onPage: async page => {
          const asset = await persistAsset(page.imageBlob, { kind: "rendered-page", fileName: `${safeBaseName(record.fileName)}-p${page.pageNo}.jpg`, extension: ".jpg", parentAssetId: record.originalAsset.id, pageNo: page.pageNo, perceptualHash: page.perceptualHash, sourceDocumentId: record.id, extractionRunId: record.extraction.extractionRunId });
          record.pageAssets.push({ ...asset, pageNo: page.pageNo, kind: "page", width: page.width, height: page.height, perceptualHash: page.perceptualHash });
          const { imageBlob, ...data } = page;
          job.pages.push(data); job.pageCursor = page.pageNo; record.extraction.pageCount = page.totalPages;
          host.saveState();
          if (!await window.ExamSync.flush(engine)) throw new Error("页面已保存，任务进度同步失败");
          host.toast(`${record.fileName}：已保存第 ${page.pageNo}/${page.totalPages} 页`);
        }
      });
      const detected = detectMetadata(`${record.fileName}\n${inspected.fullText.slice(0,5000)}`, record);
      record.metadataConflicts = detected.conflicts;
      const drafts = segmentQuestions(inspected.pages, record);
      Object.assign(record, { normalizedText: normalizeExamText(inspected.fullText), pageHashes: inspected.pages.map(p => ({ pageNo: p.pageNo, hash: p.perceptualHash })), questionSignature: buildQuestionSignature(drafts), extraction: { ...record.extraction, hasTextLayer: inspected.pages.some(p => p.text.trim()), questionCount: drafts.length, detector: "positioned-pdf-text+aligned-dhash", pageCount: inspected.pages.length } });
      // Replace only this unfinished source record; other versions and their drafts survive.
      engine.files.splice(engine.files.findIndex(f => f.id === record.id), 1);
      window.ExamIngest.registerFile(engine, record, drafts, makeQuestion);
      for (const q of engine.questions.filter(q => q.sourceFileId === record.id && q.imageReviewRequired)) {
        for (const span of q.sourceSpans || []) if(!q.imageAssets.some(a=>a.kind==="question-crop"&&Number(a.pageNo)===Number(span.pageNo))) await cropQuestionImage(q, span.pageNo, span.cropBBox || span.bbox || [.03,.03,.94,.94], engine);
      }
      job.status = "completed"; job.completedAt = new Date().toISOString();
      addAudit(engine, "source_document", record.id, "import_completed", { questionCount: drafts.length, metadataConflicts: record.metadataConflicts });
      host.toast(record.status === "duplicate_candidate" ? "发现重复候选：已保留两个版本，请人工裁决" : `已保存 ${drafts.length} 道草稿；请逐题核验并确认整卷完整性`);
    } catch (error) {
      job.status = job.status === "paused" ? "paused" : "failed"; job.error = errorMessage(error);
      host.toast(job.status === "paused" ? "任务已暂停，已完成页面可恢复" : `导入任务保留在待处理队列：${job.error}`);
    } finally { host.saveState(); await window.ExamSync.flush(engine); host.render(); }
  }

  async function cropQuestionImage(question, pageNo, bbox, engine) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some(v => !Number.isFinite(v)) || bbox[0] < 0 || bbox[1] < 0 || bbox[2] <= 0 || bbox[3] <= 0 || bbox[0]+bbox[2] > 1.001 || bbox[1]+bbox[3] > 1.001) throw new Error("裁切区域须为 0-1 的 x,y,宽,高，且不得越界");
    const source = engine.files.find(f => f.id === question.sourceFileId), page = source?.pageAssets.find(a => Number(a.pageNo) === Number(pageNo));
    if (!page) throw new Error("找不到对应来源页");
    const image = new Image(); image.src = page.url;
    await new Promise((resolve,reject) => { image.onload=resolve;image.onerror=()=>reject(new Error("原图读取失败")); });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1,Math.round(bbox[2]*image.naturalWidth)); canvas.height = Math.max(1,Math.round(bbox[3]*image.naturalHeight));
    canvas.getContext("2d").drawImage(image,bbox[0]*image.naturalWidth,bbox[1]*image.naturalHeight,canvas.width,canvas.height,0,0,canvas.width,canvas.height);
    const blob = await canvasToBlob(canvas,"image/png",1);
    const asset = await persistAsset(blob,{kind:"question-crop",extension:".png",fileName:`${question.id}-p${pageNo}.png`,parentAssetId:page.id,pageNo,crop:JSON.stringify(bbox),perceptualHash:perceptualHash(canvas),sourceDocumentId:source.id,extractionRunId:source.extraction.extractionRunId});
    question.imageHistory ||= []; question.imageHistory.push(...(question.imageAssets||[]).filter(a=>a.kind==="question-crop"&&Number(a.pageNo)===Number(pageNo)));
    question.imageAssets = (question.imageAssets||[]).filter(a=>a.kind!=="question-crop"||Number(a.pageNo)!==Number(pageNo));
    question.imageAssets.unshift({...asset,kind:"question-crop",pageNo,crop:bbox,exportApproved:false});
    question.imageReviewed=false; question.reviewed=false;
    return asset;
  }

  function validateImportDraft(draft) { Object.assign(draft, window.ExamIngest.validateMetadata(draft)); }

  async function inspectPdf(raw, fileName, hooks = {}) {
    const task = window.pdfjsLib.getDocument({ data: raw.slice(0), isEvalSupported: false }), pdf = await task.promise;
    const pages = [...(hooks.existingPages || [])];
    try {
      for (let index = pages.length + 1; index <= pdf.numPages; index++) {
        if (hooks.shouldPause?.()) throw new Error("任务已暂停");
        const page = await pdf.getPage(index), content = await page.getTextContent(), logical = page.getViewport({ scale: 1 });
        const layout = window.ExamIngest.pageBlocks(content.items, logical.width, logical.height);
        const viewport = page.getViewport({ scale: 1.4 }), canvas = document.createElement("canvas");
        canvas.width = Math.max(1,Math.round(viewport.width)); canvas.height = Math.max(1,Math.round(viewport.height));
        await page.render({ canvasContext: canvas.getContext("2d",{willReadFrequently:true}), viewport }).promise;
        const result = { ...layout, pageNo:index,totalPages:pdf.numPages,imageBlob:await canvasToBlob(canvas,"image/jpeg",.92),perceptualHash:perceptualHash(canvas) };
        if (hooks.onPage) await hooks.onPage(result);
        const { imageBlob, ...data } = result; pages.push(data);
        canvas.width=1;canvas.height=1;page.cleanup();
      }
    } finally { await task.destroy(); }
    return {pages,fullText:pages.map(p=>`\n[[PAGE:${p.pageNo}]]\n${p.text}`).join("\n")};
  }

  function detectMetadata(sourceText, fallback) { return window.ExamIngest.detectMetadata(sourceText, fallback); }

  function segmentQuestions(pages, metadata) { return window.ExamIngest.segmentQuestions(pages, metadata, inferQuestionFromText); }

  function inferQuestionFromText(raw) {
    const compact = String(raw || "").replace(/\s+/g, " ").trim();
    const options = extractOptions(compact);
    const answerMatch = compact.match(/(?:参考)?答案\s*[:：]?\s*([A-D]|[^。；;]{1,48})/i);
    const scoreMatch = compact.match(/(?:本题|每题|共)?\s*(\d+(?:\.\d+)?)\s*分/);
    const type = options.length >= 2 ? "选择题" : /(?:填空|填写)/.test(compact) ? "填空题" : /(?:实验|探究)/.test(compact) ? "实验探究题" : /(?:计算|求)/.test(compact) ? "计算题" : "待人工确认";
    const tags = inferTags(compact);
    return {
      stem: stripEmbeddedSolution(compact),
      options,
      dataTables: /(?:如表|表\s*[\d一二三四五六七八九]|下表|数据表)/.test(compact) ? ["页面包含待人工审核的数据表格"] : [],
      answer: answerMatch ? answerMatch[1].trim() : "",
      sourceExplanation: extractSourceExplanation(compact),
      type,
      score: scoreMatch ? Number(scoreMatch[1]) : null,
      ...tags,
    };
  }

  function extractOptions(text) {
    const regex = /(?:^|\s)([A-D])\s*[.．、:：]\s*([\s\S]*?)(?=(?:\s+[A-D]\s*[.．、:：])|(?:\s*(?:答案|解析)\s*[:：])|$)/g;
    const options = [];
    let match;
    while ((match = regex.exec(text))) {
      const label = match[1];
      const value = match[2].replace(/\s+/g, " ").trim();
      if (value) options.push({ label, text: value });
    }
    return options;
  }

  function inferTags(text) {
    const matches = (rules) => rules.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
    const points = unique(matches(POINT_RULES));
    const abilities = unique(matches(ABILITY_RULES));
    const structuralSignals = inferStructuralSignals(text, points, abilities);
    const physicalModel = inferPhysicalModel(text, points);
    const method = inferMethod(text, abilities);
    const traps = inferTraps(text, structuralSignals);
    return {
      mainPoint: points[0] || "待人工标注",
      secondaryPoints: points.slice(1),
      abilities: abilities.length ? abilities : ["待人工标注"],
      physicalModel,
      method,
      confusedConcepts: inferConfusions(text),
      traps,
      structuralSignals,
      estimatedDifficulty: estimateDifficulty(structuralSignals),
    };
  }

  function inferPhysicalModel(text, points) {
    if (/热敏|压敏|力敏|动态电路|电表示数/.test(text)) return "传感器/动态电路模型";
    if (/高低挡|加热|保温|电热/.test(text)) return "多状态电热模型";
    if (/浮力|浮沉/.test(text)) return "浮力—重力平衡模型";
    if (/杠杆|滑轮|机械效率/.test(text)) return "简单机械功与平衡模型";
    if (/凸透镜/.test(text)) return "凸透镜成像模型";
    if (/压强|密度/.test(text)) return "压强/密度关系模型";
    return points[0] || "待人工标注";
  }

  function inferMethod(text, abilities) {
    if (/控制变量/.test(text)) return "控制变量法";
    if (/图像|表格|数据/.test(text)) return "图表数据归纳";
    if (/故障|接线/.test(text)) return "电路状态排查";
    if (/计算|求/.test(text)) return "列关系式与单位校验";
    if (abilities.includes("概念辨析与证据推理")) return "条件辨析";
    return "待人工标注";
  }

  function inferStructuralSignals(text, points, abilities) {
    const signal = [];
    if (/相同|不同|分别|只有|恰好|至少|最大|最小|不计|忽略/.test(text)) signal.push("条件隐藏/临界状态");
    if (/热敏|压敏|力敏|动态电路|滑动变阻器/.test(text)) signal.push("电路状态变化");
    if (/图像|表格|数据|曲线/.test(text)) signal.push("图表信息提取");
    if (/实验|探究|控制变量/.test(text)) signal.push("实验设计与控制变量");
    if (/\d+\s*(?:cm|m|g|kg|Pa|kPa|W|V|A|Ω)/i.test(text)) signal.push("单位/比例关系");
    if (/计算|求|若|则|同时|并且/.test(text)) signal.push("多步骤推理");
    if (points.length >= 2) signal.push("多知识点综合");
    if (abilities.includes("概念辨析与证据推理")) signal.push("概念易混");
    return unique(signal);
  }

  function inferTraps(text, signals) {
    const traps = [];
    if (signals.includes("电路状态变化")) traps.push("先后状态未分开画等效电路");
    if (signals.includes("条件隐藏/临界状态")) traps.push("忽略题干限定条件或临界点");
    if (signals.includes("图表信息提取")) traps.push("只读单个数据，未比较变量关系");
    if (signals.includes("实验设计与控制变量")) traps.push("同时改变多个变量");
    if (signals.includes("单位/比例关系")) traps.push("单位未统一或比例方向颠倒");
    if (/平衡力|相互作用力/.test(text)) traps.push("混淆同体受力与异体相互作用");
    return unique(traps);
  }

  function inferConfusions(text) {
    const values = [];
    if (/平衡力|相互作用力/.test(text)) values.push("平衡力 / 相互作用力");
    if (/音调|响度|音色/.test(text)) values.push("音调 / 响度 / 音色");
    if (/电动机|发电机|电磁感应/.test(text)) values.push("电动机 / 发电机 / 电磁感应");
    if (/浮力|重力|压力/.test(text)) values.push("浮力 / 重力 / 压力");
    return values;
  }

  function estimateDifficulty(signals) {
    const score = signals.reduce((total, signal) => total + ({ "概念易混": 1, "条件隐藏/临界状态": 1, "多步骤推理": 1, "电路状态变化": 1, "图表信息提取": 1, "实验设计与控制变量": 1, "单位/比例关系": 1, "多知识点综合": 1 }[signal] || 0), 0);
    return score >= 5 ? 4 : score >= 3 ? 3 : score >= 1 ? 2 : 1;
  }

  function makeQuestion(draft, file, canonicalExamId, index) {
    const pageAsset = file.pageAssets.find((asset) => Number(asset.pageNo) === Number(draft.pageNo));
    return {
      id: window.ExamDomain.stableId("question",canonicalExamId,String(draft.questionNo || index + 1)),
      canonicalExamId,
      sourceLayer: file.sourceLayer,
      year: file.year,
      region: file.region,
      examType: file.examType,
      questionNo: draft.questionNo || String(index + 1),
      pageNo: Number(draft.pageNo) || 1,
      score: safeScore(draft.score),
      type: draft.type || "待人工确认",
      stem: draft.stem || "",
      options: Array.isArray(draft.options) ? draft.options : [],
      dataTables: Array.isArray(draft.dataTables) ? draft.dataTables : [],
      answer: draft.answer || "",
      sourceExplanation: draft.sourceExplanation || "",
      aiExplanation: draft.aiExplanation || "",
      teacherExplanation: "",
      mainPoint: draft.mainPoint || "待人工标注",
      secondaryPoints: draft.secondaryPoints || [],
      abilities: draft.abilities || ["待人工标注"],
      physicalModel: draft.physicalModel || "待人工标注",
      errorModelId: window.ExamTraining.modelFor(draft.mainPoint || "")?.id || "",
      method: draft.method || "待人工标注",
      confusedConcepts: draft.confusedConcepts || [],
      traps: draft.traps || [],
      structuralSignals: draft.structuralSignals || [],
      estimatedDifficulty: Number(draft.estimatedDifficulty) || 0,
      imageAssets: pageAsset ? [pageAsset] : [],
      sourceSpans: (draft.sourceSpans || [{ pageNo: Number(draft.pageNo) || 1, bbox: null }]).map(span => ({ ...span, assetId: file.pageAssets.find(a => Number(a.pageNo) === Number(span.pageNo))?.id || null })),
      answerSpans: draft.answerSpans || [],
      tableStructure: draft.tableStructure || null,
      parts: draft.parts || [],
      imageReviewRequired: Boolean(draft.imageReviewRequired),
      imageReviewed: false,
      originalExtraction: deepClone(draft),
      reviewVersions: [],
      aiCandidates: [],
      sourceFileId: file.id,
      reviewed: false,
      reviewedAt: "",
      createdAt: new Date().toISOString(),
    };
  }

  function findDuplicate(engine, incoming) { return window.ExamIngest.findDuplicate(engine, incoming); }

  async function aiParseExam(canonicalExamId, host) {
    const {state,saveState,render,toast,callVisionModel}=host,engine=ensure(state);
    const canonical=engine.canonicalExams.find(e=>e.id===canonicalExamId), source=engine.files.find(f=>f.id===canonical?.fileIds?.[0]);
    if(!canonical||!source)throw new Error("未找到原卷");
    if(typeof callVisionModel!=="function")throw new Error("AI 接口未配置");
    let job=engine.importJobs.find(j=>j.kind==="ai_parse"&&j.canonicalExamId===canonicalExamId&&j.status!=="completed");
    if(!job){job={id:makeId("job"),kind:"ai_parse",sourceFileId:source.id,canonicalExamId,status:"running",pageCursor:0,createdAt:new Date().toISOString()};engine.importJobs.push(job);}
    job.status="running";job.error="";let count=0;saveState();render();
    try {
      for(const asset of (source.pageAssets||[]).filter(p=>p.pageNo>job.pageCursor)) {
        if(job.status==="paused")throw new Error("任务已暂停");
        const image=await assetToDataUrl(asset);if(!image)throw new Error(`第${asset.pageNo}页图读取失败`);
        toast(`AI 提议第 ${asset.pageNo} 页结构化字段；不会覆盖教师定稿`);
        const reply=await callVisionModel(aiQuestionPrompt(canonical,asset.pageNo),image), parsed=parseModelJson(reply);
        if(!Array.isArray(parsed?.questions))throw new Error("模型未返回合法 questions 数组，已保留之前进度");
        for(const [index,item] of parsed.questions.entries()) {
          const no=normalizeQuestionNo(item.question_no??item.questionNo);if(!no)continue;
          const draft=aiItemToDraft(item);draft.pageNo=asset.pageNo;draft.imageReviewRequired=/如图|图中|如表|电路|图像/.test(draft.stem);
          let q=engine.questions.find(q=>q.canonicalExamId===canonicalExamId&&q.questionNo===no);
          if(!q){q=makeQuestion({...draft,questionNo:no},source,canonicalExamId,index);engine.questions.push(q);if(draft.imageReviewRequired)await cropQuestionImage(q,asset.pageNo,[.03,.03,.94,.94],engine);}
          else window.ExamIngest.proposeAi(q,draft,{pageNo:asset.pageNo,assetId:asset.id,kind:item.page_kind==="answer"?"answer":"candidate"});
          count++;
        }
        job.pageCursor=asset.pageNo;saveState();if(!await window.ExamSync.flush(engine))throw new Error("AI 建议保存失败，请先重试保存");
      }
      job.status="completed";job.completedAt=new Date().toISOString();
      canonical.complete=false;canonical.completenessConfirmed=false;
      addAudit(engine,"ai_parse",canonical.id,"suggestions_created",{count});
      toast(`已生成 ${count} 条候选；原教师定稿保持不变，请查看字段差异`);
    }catch(error){job.status=job.status==="paused"?"paused":"failed";job.error=errorMessage(error);throw error;}
    finally{saveState();render();}
  }

  function aiQuestionPrompt(canonical, pageNo) {
    return `你正在解析一页长沙/湖南初中物理试卷。只返回 JSON，不要 Markdown。严格按页面可见信息，不确定填空字符串或空数组，不能编造。
考试：${canonical.year} ${canonical.region} ${canonical.examType}；当前第 ${pageNo} 页。
输出：
{"questions":[{"question_no":"1","score":2,"type":"选择题","stem":"题干","options":[{"label":"A","text":"..."}],"tables":["表格的列名、变量和数据结构摘要"],"answer":"A","source_explanation":"仅当本页明确有解析时摘录，不确定为空","main_point":"具体考法，不写大章节","secondary_points":["..."],"abilities":["..."],"physical_model":"...","method":"...","confused_concepts":["..."],"traps":["..."],"estimated_difficulty":1,"ai_explanation":"基于题目重新写的原创分步解析"}]}
若本页有图、电路图、表格，题干中用简短结构描述，并保留本页原图作为题目资产。`;
  }

  function aiItemToDraft(item) {
    const tags = inferTags(String(item?.stem || ""));
    return {
      score: safeScore(item?.score),
      type: stringValue(item?.type) || "待人工确认",
      stem: stringValue(item?.stem),
      options: normalizeOptions(item?.options),
      dataTables: stringArray(item?.tables ?? item?.data_tables ?? item?.dataTables),
      answer: stringValue(item?.answer),
      sourceExplanation: stringValue(item?.source_explanation ?? item?.sourceExplanation),
      aiExplanation: stringValue(item?.ai_explanation ?? item?.aiExplanation),
      mainPoint: stringValue(item?.main_point ?? item?.mainPoint) || tags.mainPoint,
      secondaryPoints: stringArray(item?.secondary_points ?? item?.secondaryPoints).length ? stringArray(item?.secondary_points ?? item?.secondaryPoints) : tags.secondaryPoints,
      abilities: stringArray(item?.abilities).length ? stringArray(item?.abilities) : tags.abilities,
      physicalModel: stringValue(item?.physical_model ?? item?.physicalModel) || tags.physicalModel,
      method: stringValue(item?.method) || tags.method,
      confusedConcepts: stringArray(item?.confused_concepts ?? item?.confusedConcepts),
      traps: stringArray(item?.traps),
      estimatedDifficulty: Number(item?.estimated_difficulty ?? item?.estimatedDifficulty) || tags.estimatedDifficulty,
      structuralSignals: tags.structuralSignals,
    };
  }

  function applyAiDraft(question, draft) { window.ExamIngest.proposeAi(question, draft, { pageNo: draft.pageNo || question.pageNo }); }

  function questionEditorView(question, engine, open = false) {
    const completeness=questionCompleteness(question),source=engine.files.find(f=>f.id===question.sourceFileId);
    const pageAssets=(source?.pageAssets||[]).filter(p=>(question.sourceSpans||[{pageNo:question.pageNo}]).some(s=>Number(s.pageNo)===Number(p.pageNo)));
    const displayAssets=pageAssets.length?pageAssets:(question.imageAssets||[]).filter(a=>a.kind==="page");
    // The crop is the fastest way to confirm that a searched result is the
    // exact question a teacher wants.  Full source pages remain available as
    // evidence, but never have to be used as a substitute for a student-safe
    // question region.
    const questionCrops=[...(question.imageAssets||[])].filter(a=>a.kind==="question-crop").sort((a,b)=>Number(a.pageNo)-Number(b.pageNo));
    const cropReviewNote=questionCrops.length
      ? (question.imageReviewed&&questionCrops.every(asset=>asset.exportApproved===true)
        ? "题区已核验，可随题单交给学生。"
        : "裁图区已生成，仍需确认完整且不含答案后才能交给学生。")
      : "尚未生成可核验的单题裁图区；不能用整页原卷代替学生题。";
    const reviewed=curriculumQuestionReviewed(question);
    const status=reviewed?'<span class="status-pill good">人工确认</span>':`<span class="status-pill warn">待核验 ${completeness.missing.length?"· 缺 "+completeness.missing.length+" 项":""}</span>`;
    const candidates=(question.aiCandidates||[]).filter(c=>c.status==="pending");
    const summary=reviewed?(question.mainPoint||"已审题目"):curriculumQuestionSummary(question);
    let studentCheck={ready:false,issues:["学生题单组件尚未加载"]};
    try { studentCheck=studentQuestionReadiness(question); } catch {}
    const studentAction=questionPickAction(question,engine);
    return `<details class="question-editor" ${open?"open":""} data-question-id="${escapeAttr(question.id)}"><summary><span><strong>${escapeHtml(questionDisplay(question))}</strong><small>${escapeHtml(summary)} · ${escapeHtml((question.abilities||[]).join("、"))}</small></span>${status}</summary>
      <div class="question-review-layout"><aside class="question-evidence"><h4>单题原题预览</h4><p class="hint">${escapeHtml(cropReviewNote)}</p>${questionCrops.map(asset=>`<a class="question-crop-evidence" target="_blank" rel="noreferrer" href="${escapeAttr(safeAssetUrl(asset.url))}"><img loading="lazy" src="${escapeAttr(safeAssetUrl(asset.url))}" alt="第 ${asset.pageNo} 页单题原题裁图" /></a><p class="hint">第 ${asset.pageNo} 页单题裁图 · 点击放大</p>`).join("") || '<p class="hint">待批量补齐或人工裁图</p>'}
      ${displayAssets.length?`<details class="question-page-evidence"><summary>查看对应原卷页（教师核对用）</summary>${displayAssets.map(asset=>`<a target="_blank" rel="noreferrer" href="${escapeAttr(safeAssetUrl(asset.url))}"><img loading="lazy" src="${escapeAttr(safeAssetUrl(asset.url))}" alt="原试卷第 ${asset.pageNo} 页" /></a><p class="hint">第 ${asset.pageNo} 页 · 点击原图放大</p>`).join("")}</details>`:'<p class="hint">请补充原件页图</p>'}
      ${source?.originalAsset?.url?`<a class="source-link" target="_blank" rel="noreferrer" href="${escapeAttr(safeAssetUrl(source.originalAsset.url))}#page=${question.pageNo}">打开原始 PDF</a>`:""}
      <p class="hint">题目 ID：${escapeHtml(question.id)}</p></aside>
      <div class="question-editor__body">${completeness.missing.length?`<div class="question-review-issues"><strong>本题还需核验</strong><ul>${completeness.missing.map(item=>`<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`:""}<div class="grid three">${[["questionNo","题号"],["pageNo","页码","number"],["score","分值 未知留空","number"],["type","题型"],["mainPoint","主考点 具体考法"],["physicalModel","物理模型"],["abilities","考查能力 逗号分隔"],["secondaryPoints","次考点"],["method","解题方法"],["confusedConcepts","易混概念"],["traps","常见陷阱"],["estimatedDifficulty","AI预计难度 1-5","number"]].map(([field,label,type])=>fieldInput(question,field,label,type||"text")).join("")}</div>
      ${fieldTextArea(question,"stem","题干")}${fieldTextArea(question,"optionsText","选项 每行 A. 内容",optionsToText(question.options))}
      <div class="grid two">${fieldTextArea(question,"answer","答案")}${fieldTextArea(question,"dataTables","表格结构与数据",(question.dataTables||[]).map(t=>typeof t==="string"?t:JSON.stringify(t)).join("\n"))}</div>
      <details><summary>小问分值与分值归属</summary><p class="hint">按小问编号记录 parts；知识或能力分值归属之和必须等于本题分值。留空时主考点独占、能力等分。</p>${fieldTextArea(question,"partsJSON","小问 JSON",JSON.stringify(question.parts||[],null,2))}${fieldTextArea(question,"scoreAllocationsJSON","分值归属 JSON",JSON.stringify(question.scoreAllocations||{},null,2))}</details>
      <div class="image-review"><label><input type="checkbox" data-engine-image-required="${escapeAttr(question.id)}" ${question.imageReviewRequired?"checked":""}/> 本题需要图像或表格原图</label>
      ${displayAssets.length?`<details class="question-crop-adjust"><summary>调整原题裁切区域</summary>${displayAssets.map(asset=>{const crop=(question.imageAssets||[]).find(a=>a.kind==="question-crop"&&Number(a.pageNo)===Number(asset.pageNo));return `<div class="crop-review"><p>第 ${asset.pageNo} 页完整题区（x,y,宽,高，范围 0-1）</p><input data-engine-crop-box="${escapeAttr(question.id+"|"+asset.pageNo)}" value="${escapeAttr((crop?.crop||[.03,.03,.94,.94]).join(","))}"/><button type="button" class="secondary" data-engine-crop="${escapeAttr(question.id+"|"+asset.pageNo)}">重新裁切</button>${crop?`<img loading="lazy" src="${escapeAttr(safeAssetUrl(crop.url))}" alt="待核验题区"/>`:""}</div>`;}).join("")}</details>`:""}
      <label><input type="checkbox" data-engine-image-reviewed="${escapeAttr(question.id)}" ${question.imageReviewed?"checked":""}/> 已核验题图完整，裁图不含答案、原解析及其他题目</label></div>
      <details><summary>解析与评分点</summary>${fieldTextArea(question,"sourceExplanation","原解析 仅本地溯源禁止教学导出")}${fieldTextArea(question,"aiExplanation","AI 原创分步解析")}${fieldTextArea(question,"teacherExplanation","教师原创分步解析")}${fieldTextArea(question,"rubric","评分点 每行一点",(question.rubric||[]).join("\n"))}</details>
      ${candidates.length?`<details class="ai-differences" open><summary>AI 建议与当前定稿差异 · ${candidates.length} 份</summary>${candidates.map(c=>`<div><p class="hint">候选来自第 ${c.sourceSpan?.pageNo||"?"} 页；仅接受所需字段，不自动确认</p>${Object.entries(c.draft).filter(([k,v])=>!["pageNo","sourceSpans"].includes(k)&&v!=null&&v!==""&&JSON.stringify(v)!==JSON.stringify(question[k])).map(([k,v])=>`<details><summary>${escapeHtml(k)} ${c.acceptedFields?.includes(k)?"已采纳":""}</summary><div class="grid two"><pre>${escapeHtml(typeof question[k]==="string"?question[k]:JSON.stringify(question[k],null,2))}</pre><pre>${escapeHtml(typeof v==="string"?v:JSON.stringify(v,null,2))}</pre></div><button class="secondary" type="button" data-engine-ai-field="${escapeAttr(question.id+"|"+c.id+"|"+k)}">仅采纳此字段</button></details>`).join("")}<button class="ghost" type="button" data-engine-ai-reject="${escapeAttr(question.id+"|"+c.id)}">关闭这份候选</button></div>`).join("")}</details>`:""}
      <div class="actions"><button type="button" class="ghost" data-engine-ask-question="${escapeAttr(question.id)}">问这道题</button>${studentAction}<button type="button" class="primary" data-engine-q-reviewed="${escapeAttr(question.id)}">人工确认此题</button><span class="hint">${studentCheck.ready?"可加入学生题单；学生端只显示题目内容。":"未完成题图/答案/分值/逐题审核前，不能交给学生。"}</span><span class="hint">修改已确认内容会撤销本题与整卷审核；历史定稿保留。</span></div></div></div></details>`;
  }

  function fieldInput(question, field, label, type = "text") {
    const value = Array.isArray(question[field]) ? question[field].join("，") : question[field] ?? "";
    return `<div class="field"><label>${escapeHtml(label)}</label><input type="${type}" data-engine-q-field="${escapeAttr(`${question.id}|${field}`)}" value="${escapeAttr(value)}" /></div>`;
  }

  function fieldTextArea(question, field, label, override) {
    const value = override !== undefined ? override : question[field] || "";
    return `<div class="field"><label>${escapeHtml(label)}</label><textarea data-engine-q-field="${escapeAttr(`${question.id}|${field}`)}">${escapeHtml(value)}</textarea></div>`;
  }

  function setQuestionField(question, field, value) {
    if (field.endsWith("JSON")) {
      const data=JSON.parse(value|| (field==="partsJSON"?"[]":"{}"));
      if(field==="partsJSON"&&!Array.isArray(data))throw new Error("小问必须填写 JSON 数组");
      if(field==="scoreAllocationsJSON"&&(!data||typeof data!=="object"||Array.isArray(data)))throw new Error("分值归属必须填写 JSON 对象");
      question[field.replace(/JSON$/, "")]=data;return;
    }
    const arrayFields = ["abilities", "secondaryPoints", "confusedConcepts", "traps"];
    if (["dataTables", "rubric"].includes(field)) { question[field]=value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);return; }
    if (arrayFields.includes(field)) {
      question[field] = splitList(value);
      return;
    }
    if (field === "optionsText") {
      question.options = textToOptions(value);
      return;
    }
    if (["score", "pageNo", "estimatedDifficulty"].includes(field)) {
      question[field] = value === "" ? null : Number(value);
      return;
    }
    question[field] = value;
  }

  function qualityReportView(report) {
    const q = report.quality;
    return `
      <section class="section">
        <div class="section-title-row"><div><h3>数据质量报告</h3><p class="hint">统计前置条件：来源分层、文件资产、去重、题目结构、人工审核、E 类校验门槛。</p></div></div>
        <div class="metric-grid small">
          ${metricCard("已建档文件", `${q.files} 份`, `${q.assetsPersistent}/${q.files} 份原卷持久保存`)}
          ${metricCard("独立 canonical 试卷", `${q.canonicalExams} 套`, `重复版本 ${q.duplicateFiles} 份不计频次`)}
          ${metricCard("题目字段完整率", `${q.fieldCompleteness}%`, `${q.reviewedQuestions}/${q.questions} 道已人工确认`)}
          ${metricCard("E 类有效作答", `${q.confirmedAttempts} 条`, `${q.unconfirmedAttempts} 条未确认已排除`)}
        </div>
        ${q.issues.length ? `<div class="quality-issues">${q.issues.map((issue) => `<p>${escapeHtml(issue)}</p>`).join("")}</div>` : `<p class="success-note">当前没有阻止统计的质量问题；仍建议抽查题目切分与重复判定。</p>`}
      </section>`;
  }

  function duplicateReportView(engine, report) {
    const files=engine.files||[];
    return `<section class="section"><h3>版本去重核验</h3><p class="hint">SHA完全相同自动复用；其他版本必须由教师核验。合并仍保留两份原件与提取结果；图片差异及答案冲突需逐项裁决。</p>
      ${files.length?`<div class="table-wrap"><table class="compact-table"><thead><tr><th>文件与考试</th><th>比对证据</th><th>状态与操作</th></tr></thead><tbody>${files.map(f=>{
        const e=engine.canonicalExams.find(e=>e.id===f.canonicalExamId);
        return `<tr><td>${escapeHtml(f.fileName)}<small>${escapeHtml(f.year)} ${escapeHtml(f.region)} · ${escapeHtml(f.sourceLayer)}</small></td><td>${escapeHtml(dedupeEvidenceText(f.dedupeEvidence))}<details><summary>追溯标识</summary><code>${escapeHtml(f.canonicalExamId||"建档中")}</code><br><code>${escapeHtml(f.duplicateGroupId||"")}</code></details></td><td>${f.status==="duplicate_candidate"?`<span class="status-pill warn">重复候选 不计频次</span><div class="actions"><button class="secondary" data-engine-dedupe="${escapeAttr(f.id+"|merge")}">同一次考试 合并版本</button><button class="ghost" data-engine-dedupe="${escapeAttr(f.id+"|separate")}">不同考试 独立保留</button></div>`:["duplicate","duplicate_confirmed"].includes(f.status)?`<span class="status-pill good">重复版本 不增加频次</span>${f.status==="duplicate_confirmed"?`<button class="ghost" data-engine-dedupe="${escapeAttr(f.id+"|undo")}">撤销合并</button>`:""}`:`<span class="status-pill">${e?.dedupeStatus==="confirmed"?"独立身份已确认":"待核验"}</span>`}</td></tr>`;
      }).join("")}</tbody></table></div>`:emptyState("暂无版本可比对","2023年2份、2024年2份、2025年3份资料须经实际导入和比对后，才能确认3次独立考试。")}
      <p class="hint">${escapeHtml((report.quality.expectedDuplicateChecks||[]).join("；"))}</p></section>`;
  }

  function sourceFileView(engine) {
    const files=engine.files||[],jobs=engine.importJobs||[];
    return `<section class="section"><h3>导入与解析任务</h3>${jobs.length?`<div class="task-queue">${jobs.slice().reverse().map(job=>`<article><strong>${escapeHtml(files.find(f=>f.id===job.sourceFileId)?.fileName||"来源文件")}</strong><span>${job.kind==="ai_parse"?"AI补全":"PDF结构提取"} · 已处理 ${job.pageCursor||0} 页 · ${escapeHtml(({running:"处理中",queued:"待处理",paused:"已暂停",failed:"失败可恢复",completed:"完成"})[job.status]||job.status)}</span>${job.error?`<p class="warning-note">${escapeHtml(job.error)}</p>`:""}${job.status!=="completed"?`<button class="secondary" data-engine-job-${job.status==="running"?"pause":"resume"}="${escapeAttr(job.id)}">${job.status==="running"?"暂停":"恢复任务"}</button>`:""}</article>`).join("")}</div>`:'<p class="hint">暂无导入任务</p>'}</section>
      ${files.length?`<section class="section"><h3>原件与整卷完整性核验</h3><div class="source-file-grid">${files.slice().reverse().map(file=>{
        const exam=engine.canonicalExams.find(e=>e.id===file.canonicalExamId),qs=engine.questions.filter(q=>q.canonicalExamId===exam?.id);
        return `<article><strong>${escapeHtml(file.fileName)}</strong><p>${escapeHtml(SOURCE_LAYERS[file.sourceLayer]?.name||file.sourceLayer)} · ${escapeHtml(file.year)} ${escapeHtml(file.region)}</p>
        <p class="hint">${file.pageAssets?.length||0} 页原图 · ${qs.length} 道题 · ${qs.filter(q=>q.reviewed).length} 道已核验</p>
        <p class="hint">命题来源：${escapeHtml(exam?.paperOriginName||"待核对")} · 命题方案 ${escapeHtml(exam?.paperOriginId||"未指定")} · 适用地区 ${escapeHtml((exam?.applicableRegions||[]).join("、")||file.region)}</p>
        ${exam&&!exam.mergedInto?examMetadataEditor(exam):""}
        <div class="actions">${file.originalAsset?.url?`<a class="ghost link-button" target="_blank" rel="noreferrer" href="${escapeAttr(safeAssetUrl(file.originalAsset.url))}">原始 PDF</a>`:""}${safeExternalLink(file.sourceUrl,"来源")}${exam&&!exam.mergedInto?`<button class="secondary" data-engine-ai-parse="${escapeAttr(exam.id)}">AI 补全候选</button><button class="ghost" data-engine-start-manual="${escapeAttr(file.id)}">逐题录入</button>`:""}</div>
        ${file.metadataConflicts?.length?`<p class="warning-note">识别与填写信息存在差异：${escapeHtml(file.metadataConflicts.map(c=>c.field+" "+c.confirmed+" / "+c.detected).join("；"))}</p>${file.metadataConfirmed?'<p class="hint">教师已确认以填写信息为准</p>':`<button class="secondary" data-engine-metadata-confirm="${escapeAttr(file.id)}">核对原卷后确认填写信息</button>`}`:""}
        ${exam&&!exam.mergedInto?`<p class="hint">去重身份：${exam.dedupeStatus==="confirmed"?"已确认":"待确认"}</p>${!exam.candidateOf&&exam.dedupeStatus!=="confirmed"?`<button class="secondary" data-engine-dedupe-first="${escapeAttr(exam.id)}">确认这是独立原卷</button>`:""}
          ${(exam.versionConflicts||[]).filter(c=>c.status==="pending").map(c=>{const incoming=engine.questions.find(q=>q.id===c.questionId);const existing=qs.find(q=>q.questionNo===c.questionNo);return `<details class="version-conflict"><summary>第 ${escapeHtml(c.questionNo)} 题版本差异 待处理</summary><div class="grid two"><pre>主版本：${escapeHtml(existing?.stem||"无此题")}\n答案：${escapeHtml(existing?.answer||"")}</pre><pre>新版本：${escapeHtml(incoming?.stem||"")}\n答案：${escapeHtml(incoming?.answer||"")}</pre></div>${sourceLink(incoming,"新版本原图")}<div class="actions"><button class="secondary" data-engine-version-choice="${escapeAttr(exam.id+"|"+c.questionId+"|use")}">采用新版本并重新审题</button><button class="ghost" data-engine-version-choice="${escapeAttr(exam.id+"|"+c.questionId+"|keep")}">保留主版本</button></div></details>`;}).join("")}
          <div class="grid two"><div class="field"><label>原卷实际题数</label><input type="number" min="1" data-engine-exam-check="${escapeAttr(exam.id+"|count")}" value="${exam.expectedQuestionCount||""}" placeholder="${qs.length} 道已识别"/></div><div class="field"><label>物理总分 未知可留空</label><input type="number" min="1" data-engine-exam-check="${escapeAttr(exam.id+"|score")}" value="${exam.totalScore??""}"/></div></div>
          <button class="${exam.complete?"ghost":"primary"}" data-engine-exam-complete="${escapeAttr(exam.id)}">${exam.complete?"整卷已确认 可重新核验":"逐题完成后确认整卷完整性"}</button>`:""}
        ${file.copyrightNote?`<p class="copyright-note">${escapeHtml(file.copyrightNote)}</p>`:""}</article>`;
      }).join("")}</div></section>`:""}`;
  }

  function examMetadataEditor(exam) {
    const fields=[["sourceLayer","资料层级 A/B/C/D"],["year","试卷年份"],["region","来源地区"],["examType","考试类型"],["paperOriginId","命题方案 ID（共用同卷保持一致）"],["paperOriginName","命题来源名称"],["applicableRegions","适用地市（逗号分隔）"]];
    return `<details class="exam-metadata"><summary>修正来源与命题元数据</summary><p class="warning-note">修正后重新审核，不覆盖旧定稿。已合并的版本需先撤销合并。</p><div class="grid two">${fields.map(([key,label])=>`<div class="field"><label>${escapeHtml(label)}</label><input data-engine-metadata-field="${escapeAttr(exam.id+"|"+key)}" value="${escapeAttr(Array.isArray(exam[key])?exam[key].join("，"):exam[key]||"")}"/></div>`).join("")}</div><button class="secondary" data-engine-metadata-save="${escapeAttr(exam.id)}">核对原卷后保存修正</button></details>`;
  }

  function rankingView(title, rows, field, sampleSize) {
    return `<section class="section"><h3>${escapeHtml(title)}</h3><p class="hint">${sampleSize} 套完整核验的独立原卷。缺年或缺分时仅展示观察到的出现记录，不形成正式指数。</p>${rows.length?`<div class="table-wrap"><table class="compact-table ranking-table"><thead><tr><th>序号</th><th>${field==="ability"?"能力":"具体考法"}</th><th>高频指数</th><th>样本与年份</th><th>连续出现</th><th>证据入口</th><th>题型与分值</th><th>证据充分度</th></tr></thead><tbody>${rows.slice(0,20).map((r,i)=>`<tr><td>${i+1}</td><td><strong>${escapeHtml(r.point)}</strong></td><td>${r.index==null?"数据不足":r.index}<details><summary>六项组成</summary><pre>${escapeHtml(Object.entries({fiveCoverage:"近五年覆盖率",continuity:"近三年连续程度",historicalCoverage:"历史年度覆盖率",scoreShare:"近五年分值占比",stability:"题型位置稳定性",diversity:"命题方式丰富度"}).map(([k,label])=>label+"："+(r.raw?.[k]==null?"未知":percent(r.raw[k]))).join("\n"))}</pre></details></td><td>${r.examCount} 套<br>${escapeHtml(r.years.join("、"))}</td><td>${r.consecutiveYears} 年</td><td><details><summary>${r.questionRefs.length} 条原题证据</summary>${r.questionRefs.map(ref=>sourceLink(ref.question,`${ref.year}年第${ref.questionNo}题`)).join("、")}</details></td><td>${escapeHtml(r.typeDistribution)}<small>${escapeHtml(r.scoreDistribution)}</small></td><td>${confidencePill(r.confidence)}</td></tr>`).join("")}</tbody></table></div>`:emptyState("样本不足","请先完成原卷导入、逐题审核、版本去重及整卷完整性确认。")}</section>`;
  }

  function trendView(title, rows, sampleSize) {
    return `<section class="section"><h3>${escapeHtml(title)}</h3>${sampleSize ? (rows.length ? `<div class="trend-list">${rows.map((row) => `<article><strong>${escapeHtml(row.point)}</strong><span class="trend-status ${row.direction}">${escapeHtml(row.label)}</span><p>${escapeHtml(row.evidence)}</p></article>`).join("")}</div>` : `<p class="hint">已有样本，但尚未形成可标注趋势的具体考法。</p>`) : `<p class="hint">数据不足：需要对应窗口内 A 类长沙原卷，才会判断“稳定出现”“上升”或“新出现”。</p>`}</section>`;
  }

  function hunanCompareView(report) {
    const rows = report.hunanCompare;
    return `<section class="section"><div class="section-title-row"><div><h3>湖南其他地市对照</h3><p class="hint">仅 B 类原卷，按城市等权，不并入长沙频次。特色指数需至少3个其他城市具有完整同窗数据与独立命题来源；共用试卷不增加独立样本。</p></div></div>${report.samples.hunan.exams ? `<div class="table-wrap"><table class="compact-table"><thead><tr><th>具体考法</th><th>湖南共同高频指数</th><th>对照样本</th><th>长沙相对特色指数</th><th>说明与城市证据</th></tr></thead><tbody>${rows.slice(0,20).map(row=>`<tr><td>${escapeHtml(row.point)}</td><td>${row.commonIndex==null?"数据不足":row.commonIndex}</td><td>${row.hunanExamCount} 套独立命题 / ${row.regions.length} 个适用地市</td><td>${row.specialtyIndex==null?"样本不足":row.specialtyIndex+" 分"}</td><td>${escapeHtml(row.note)}<details><summary>同窗城市对照</summary>${(row.sampleCoverageByCity||[]).map(c=>`<p>${escapeHtml(c.city)}：样本覆盖 ${c.coverage==null?"未知":percent(c.coverage)}；${c.missingYears?.length?"缺 "+escapeHtml(c.missingYears.join("、"))+" 年":"年份完整"}；指数 ${(row.comparisonCities||[]).find(x=>x.city===c.city)?.index??"数据不足"}</p>`).join("")}</details></td></tr>`).join("")}</tbody></table></div>`:emptyState("尚未导入 B 类对照卷","导入湖南其他地市中考原卷后单独分析，不会改变长沙 A 类分母。")}</section>`;
  }

  function localTeachingFocusView(rows, sampleSize) {
    return `<section class="section"><div class="section-title-row"><div><h3>长沙学校/集团联考教学重点（C 类）</h3><p class="hint">只用于观察本地教学强调点；它不进入长沙中考高频、近年趋势或湖南对照的任何分母。</p></div></div>${sampleSize ? (rows.length ? `<div class="table-wrap"><table class="compact-table"><thead><tr><th>本地教学重点</th><th>C 类覆盖指数</th><th>学校卷样本</th><th>题型/分值</th><th>审核置信度</th></tr></thead><tbody>${rows.slice(0, 10).map((row) => `<tr><td>${escapeHtml(row.point)}</td><td>${row.index==null?"数据不足":row.index}</td><td>${row.examCount} 套 · ${escapeHtml(row.years.join("、"))}</td><td>${escapeHtml(row.typeDistribution)}<br><small>${escapeHtml(row.scoreDistribution)}</small></td><td>${confidencePill(row.confidence)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="hint">已有 C 类卷，但尚未标注到具体考法。</p>`) : `<p class="hint">尚未导入 C 类长沙学校/集团试卷。</p>`}</section>`;
  }

  function expectedErrorsView(rows) {
    return `<section class="section"><div class="section-title-row"><div><h3>AI 预计易错题榜</h3><p class="hint">固定标识“AI预计易错”。风险指数来自题目结构，不是学生错误率。</p></div></div>${rows.length ? `<div class="table-wrap"><table class="compact-table"><thead><tr><th>题目</th><th>风险等级</th><th>触发信号</th><th>典型错误原因</th><th>原题入口</th></tr></thead><tbody>${rows.slice(0, 15).map((row) => `<tr><td>${escapeHtml(questionDisplay(row.question))}<br><small>${escapeHtml(row.question.mainPoint)}</small></td><td><span class="expected-badge">AI预计易错 · ${escapeHtml(riskLabel(row.score))}</span><br><strong>${row.score}/100</strong></td><td>${escapeHtml(row.signals.join("、") || "待人工标注")}</td><td>${escapeHtml(row.traps.join("；") || "请人工补充陷阱")}</td><td>${sourceLink(row.question, "原题页")}</td></tr>`).join("")}</tbody></table></div>` : emptyState("尚无可评估题目", "导入 A 类长沙题目并保留题干/图表后，系统将用结构规则生成预计风险，不会给出虚构错误率。")}</section>`;
  }

  function actualErrorsView(rows) {
    return `<section class="section"><h3>学生真实易错题榜</h3><p class="hint">每名学生对该题首次有效核验作答；未得满分含明确空题计错。小样本与95% Wilson区间一起展示，缺测用时不补零。</p>${rows.length?`<div class="table-wrap"><table class="compact-table"><thead><tr><th>题目</th><th>人数与作答次数</th><th>错误率与区间</th><th>错误选项</th><th>平均用时</th><th>空题</th><th>重复错误</th><th>回测失败</th><th>错误步骤</th></tr></thead><tbody>${rows.slice(0,20).map(r=>`<tr><td>${escapeHtml(questionDisplay(r.question))}<small>${escapeHtml(r.question.mainPoint)}</small></td><td>${r.total} 人 / ${r.attemptCount} 次</td><td>${percent(r.wrongRate)}（${r.wrongCount}/${r.total}）<small>${r.wrongRateInterval?percent(r.wrongRateInterval.lower)+"—"+percent(r.wrongRateInterval.upper):"—"} ${r.smallSample?"小样本":""}</small></td><td>${escapeHtml(r.optionDistribution||"—")}</td><td>${r.averageTime==null?"—":round1(r.averageTime)+" 秒"}<small>${r.timeSampleSize} 条用时记录</small></td><td>${r.blankRate==null?"—":percent(r.blankRate)+`（${r.blankNumerator}/${r.blankDenominator}）`}</td><td>${r.repeatRate==null?"—":percent(r.repeatRate)+`（${r.repeatNumerator}/${r.repeatDenominator}）`}</td><td>${r.retestFailureRate==null?"—":percent(r.retestFailureRate)+`（${r.retestNumerator}/${r.retestDenominator}）`}</td><td>${escapeHtml(r.errorSteps||"—")}</td></tr>`).join("")}</tbody></table></div>`:emptyState("没有可用的真实易错数据","只有身份已匹配、教师核验确认且未被撤销的E类作答参与。")}</section>`;
  }

  function intersectionView(rows) {
    return `<section class="section"><h3>高频且易错的重点交叉榜</h3>${rows.length ? `<div class="table-wrap"><table class="compact-table"><thead><tr><th>具体考法</th><th>长沙高频指数</th><th>易错证据</th><th>专题优先理由</th></tr></thead><tbody>${rows.map((row) => `<tr><td><strong>${escapeHtml(row.point)}</strong></td><td>${row.frequencyIndex==null?"数据不足":row.frequencyIndex}</td><td>${escapeHtml(row.errorEvidence)}</td><td>${escapeHtml(row.reason)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("交叉证据尚不足", "需要 A 类长沙频次和已确认 E 类真实错误同时存在；AI 预计易错可辅助排序，但不会替代真实错误证据。")}</section>`;
  }

  function trainingPlanView(plan) {
    window.ExamTraining.refreshPlan(plan);
    const ready=["ready","completed"].includes(plan.status),labels={incomplete:"未完成 有缺口",review:"待逐题核验",ready:"可使用",completed:"训练已完成"};
    return `<details class="training-plan"><summary><span><strong>${escapeHtml(plan.title)}</strong><small>已核验 ${plan.readyCount||0}/19 题 · ${escapeHtml(plan.classId||"通用专题")}${plan.studentId?" · 个人专题":""}</small></span><span class="status-pill ${ready?"good":"warn"}">${labels[plan.status]||"方案"}</span></summary>
      <div class="training-plan__body"><p>错误模型：${escapeHtml(plan.errorModel)}</p><p class="hint">${escapeHtml(plan.basis||"")} 学生主卷17题；回测2题独立发放。</p>
      ${plan.gaps?.length?`<p class="warning-note">${escapeHtml(plan.gaps.map(g=>g.errors.join("、")).join("；"))}</p><button class="secondary" data-engine-fill-plan="${escapeAttr(plan.id)}">从新审核题库补齐真题位置</button>`:""}
      <div class="actions">${[["docx","可编辑教师讲义"],["student-pdf","学生主卷 PDF"],["retest-pdf","独立回测卷 PDF"],["teacher-pdf","教师解析 PDF"]].map(([format,label])=>`<button class="secondary" data-engine-training-export="${escapeAttr(plan.id+"|"+format)}" ${ready?"":"disabled"}>${label}</button>`).join("")}</div>
      ${(plan.items||[]).map((item,index)=>{const q=item.question;return `<details class="training-item"><summary>${index+1}. ${escapeHtml(item.stage)} · ${item.review?.status==="confirmed"?"已核验":q?"待核验":"缺题"}</summary>
        <p class="hint">为何选入：${escapeHtml(item.reason)}<br>检测漏洞：${escapeHtml(item.detects)}</p>
        ${q?`<p class="question-stem">${escapeHtml(q.stem)}</p>${(q.options||[]).map(o=>`<p>${escapeHtml(typeof o==="string"?o:o.label+". "+o.text)}</p>`).join("")}
        ${(q.tables||[]).map(t=>`<div class="table-wrap"><table class="compact-table"><thead><tr>${(t.headers||[]).map(h=>`<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${(t.rows||[]).map(row=>`<tr>${row.map(c=>`<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`).join("")}
        ${(q.imageAssets||[]).filter(a=>a.kind!=="page").map(a=>`<img class="training-question-image" loading="lazy" src="${escapeAttr(safeAssetUrl(a.url||("/api/physics-exam/assets/"+(a.id||a.assetId))))}" alt="题目必要图示"/>`).join("")}
        <p><strong>答案：</strong>${escapeHtml(q.answer)}</p>
        <div class="field"><label>教师核验或修改原创解析</label><textarea data-engine-plan-field="${escapeAttr(plan.id+"|"+item.id+"|solution")}">${escapeHtml(q.teacherExplanation||q.aiExplanation||q.solution||"")}</textarea></div>
        <div class="field"><label>评分点 每行一点</label><textarea data-engine-plan-field="${escapeAttr(plan.id+"|"+item.id+"|rubric")}">${escapeHtml((q.rubric||[]).join("\n"))}</textarea></div>
        <p class="hint">来源：${q.generated?"本地参数化原创 非真题证据":escapeHtml(questionDisplay(q))} · ${q.generated?"结构与数值校验："+(item.validation?.passed?"通过":"未通过"):"需核验解析与题图"}</p>
        <button class="primary" data-engine-plan-item-review="${escapeAttr(plan.id+"|"+item.id)}">确认本题题意答案与评分点</button>`:'<p class="warning-note">缺少不同的已核验长沙原题，不能用重复题或占位符凑数。</p>'}</details>`;}).join("")}
        ${ready&&!plan.completedAt?`<div class="field"><label>实际完成训练的课次 ID</label><input data-engine-training-session="${escapeAttr(plan.id)}" placeholder="例如 classA_20260912_topic1"/></div><button class="primary" data-engine-plan-complete="${escapeAttr(plan.id)}">确认已实际完成训练 安排第3及第7天回测</button>`:""}
        ${plan.completedAt?`<p class="hint">实际训练完成时间：${escapeHtml(formatDate(plan.completedAt))}；回测结果必须由教师核验后回写。</p>`:""}
      </div></details>`;
  }

  function attemptAuditView(engine) {
    const attempts=(engine.attempts||[]).slice().reverse().slice(0,30);
    return attempts.length?`<p class="hint">显示最近30条。每条需明确班级、学生、课次和题目后核验；旧版本与撤销记录保留供审计。</p><div class="attempt-review-list">${attempts.map(a=>{
      const field=(key,label)=>`<div class="field"><label>${label}</label><input data-engine-attempt-field="${escapeAttr(a.id+"|"+key)}" value="${escapeAttr(a[key]||"")}"/></div>`;
      return `<details><summary>${escapeHtml(a.studentName||a.studentKey||"学生待匹配")} · ${escapeHtml(a.questionId||"题目待匹配")} · ${escapeHtml(({verified:"已确认",draft:"待核验",revoked:"已撤销",superseded:"旧版本"})[a.verificationStatus]||"旧数据待核验")}</summary><div class="grid three">${field("classId","班级 ID")}${field("studentId","学生 ID 不使用姓名代替")}${field("sessionId","课次 ID")}${field("questionId","统一题目 ID")}${field("partId","小问 ID 默认 whole")}${field("round","轮次")}</div><div class="field"><label>正误</label><select data-engine-attempt-field="${escapeAttr(a.id+"|isCorrect")}"><option value="">未知</option><option value="正确" ${a.isCorrect===true?"selected":""}>正确</option><option value="错误" ${a.isCorrect===false&&!a.isBlank?"selected":""}>错误</option><option value="空题" ${a.isBlank?"selected":""}>明确空题</option></select></div><p class="hint">${escapeHtml(a.validationBlockedReason||"")} 错误选项：${escapeHtml(a.errorOption||"未记录")}</p><div class="field"><label>错因核查：记录孩子的关键错误步骤</label><textarea data-engine-attempt-field="${escapeAttr(a.id+"|errorStep")}" placeholder="如：把电压表测量对象认错；未考虑滑片位置变化；算功率时误用总电阻……">${escapeHtml(a.errorStep||"")}</textarea><small>修改后需要重新确认，这样诊断才会使用这条步骤证据。</small></div><div class="actions">${a.verificationStatus==="verified"?`<button class="ghost" data-engine-attempt-revoke="${escapeAttr(a.id)}">撤销确认并重算</button>`:a.verificationStatus!=="superseded"?`<button class="primary" data-engine-attempt-confirm="${escapeAttr(a.id)}">教师核验确认</button>`:""}</div></details>`;
    }).join("")}</div>`:'<p class="hint">尚未导入 E 类作答</p>';
  }

  function masteryTable(title, rows) {
    return `<div class="mastery-table"><h4>${escapeHtml(title)}</h4><table class="compact-table"><thead><tr><th>对象</th><th>知识点</th><th>掌握度与证据</th><th>建议</th></tr></thead><tbody>${rows.slice(0,30).map(row=>`<tr><td>${escapeHtml(row.subject)}</td><td>${escapeHtml(row.point)}</td><td>${row.mastery==null?"—":row.mastery+"%"}<small>${row.total} 条核验作答</small></td><td>${escapeHtml(row.advice)}${row.recommended||row.recurring?`<button class="secondary" data-engine-generate-plan="${escapeAttr(row.point)}" data-engine-target="${escapeAttr(row.id||"")}" data-engine-class="${escapeAttr(row.classId)}">生成${row.studentId?"个人":"班级"}专题</button>`:""}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function buildReport(engine) {
    const stamp = engine.changeCounter || 0;
    if (engine._reportCache?.stamp === stamp) return engine._reportCache.report;
    const report = window.ExamDomain.buildReport(engine);
    Object.defineProperty(engine, "_reportCache", { value: { stamp, report }, writable: true, configurable: true, enumerable: false });
    return report;
  }

  function retestView(engine) {
    const queue=window.ExamTraining.retestQueue(engine.trainingPlans,new Date().toISOString(),{attempts:engine.attempts});
    const active=window.ExamDomain.activeAttempts(engine);
    return `<section class="section"><h3>延时回测待办</h3><p class="hint">第3天、第7天各一题；不自动发送外部通知。只有关联基线错误、实际训练和教师核验的回测才计入统计。</p>${queue.length?queue.map(task=>{
      const plan=engine.trainingPlans.find(p=>p.id===task.planId),item=plan.items.find(i=>i.id===task.itemId);
      const candidates=active.filter(a=>a.isCorrect===false&&(!plan.classId||a.classId===plan.classId)&&(!plan.studentId||a.studentId===plan.studentId)&&(!plan.baselineAttemptIds.length||plan.baselineAttemptIds.includes(a.id))&&(!task.pendingBaselineAttemptIds||task.pendingBaselineAttemptIds.includes(a.id)));
      const key=plan.id+"|"+item.id;
      return `<details class="retest-entry"><summary>${escapeHtml(plan.focusPoint)} · ${item.retestOffsetDays}天回测 · ${escapeHtml(formatDate(task.dueAt))} · ${task.overdue?"已到期":"未到期"}</summary><p>${escapeHtml(item.question?.stem||"")}</p><div class="field"><label>关联已核验的基线错误</label><select data-engine-retest-field="${escapeAttr(key+"|baseline")}"><option value="">请选择</option>${candidates.map(a=>`<option value="${escapeAttr(a.id)}">${escapeHtml(a.className||a.classId)} ${escapeHtml(a.studentName||a.studentKey||a.studentId)} · ${escapeHtml(a.questionId)}</option>`).join("")}</select></div><div class="grid three"><div class="field"><label>本次实际回测课次 ID</label><input data-engine-retest-field="${escapeAttr(key+"|session")}"/></div><div class="field"><label>教师核验结果</label><select data-engine-retest-field="${escapeAttr(key+"|correct")}"><option value="">未核验</option><option>正确</option><option>错误</option><option>空题</option></select></div><div class="field"><label>用时秒 未测量留空</label><input type="number" min="0" data-engine-retest-field="${escapeAttr(key+"|time")}"/></div></div><div class="field"><label>典型错误步骤</label><textarea data-engine-retest-field="${escapeAttr(key+"|step")}"></textarea></div><button class="primary" data-engine-record-retest="${escapeAttr(key)}">核验回测结果并回写</button></details>`;
    }).join(""):emptyState("暂无待回测专题","专题19题通过审核后，记录实际训练完成课次，即生成第3天和第7天待办。")}</section>`;
  }










  function buildFourAnswers(report) { return window.ExamDomain.buildFourAnswers(report); }

  function generateTrainingPlan(engine, focusPoint, options = {}) { return window.ExamTraining.generateTrainingPlan(engine, focusPoint, options); }

  function ingestVerifiedWrongbook(state, archive = null) { const result = window.ExamDomain.ingestVerifiedWrongbook(state, archive); invalidateReport(ensure(state)); return result; }

  function importAttemptCsv(text, engine) { const result = window.ExamDomain.importAttemptCsv(text, engine); invalidateReport(engine); return result; }

  function masteryViewData(engine) { return window.ExamDomain.buildMastery(engine); }



  function exportReport(kind, engine, downloadText) {
    const report=buildReport(engine);
    if(kind==="questions") {
      const rows=[["question_id","canonical_exam_id","来源层级","年份","地区","题号","页码","分值","题型","题干","选项","答案","主考点","次考点","能力","模型","方法","人工确认","原题入口"]];
      for(const q of engine.questions)rows.push([q.id,q.canonicalExamId,q.sourceLayer,q.year,q.region,q.questionNo,q.pageNo,q.score,q.type,q.stem,optionsToText(q.options),q.answer,q.mainPoint,(q.secondaryPoints||[]).join("；"),(q.abilities||[]).join("；"),q.physicalModel,q.method,q.reviewed?"是":"否",q.imageAssets?.[0]?.url||""]);
      downloadText("长沙物理真题_题目审核清单.csv",toCsv(rows),"text/csv;charset=utf-8");return;
    }
    const safe=window.ExamTraining.publicAnalysisDTO(report);
    const payload=kind==="quality"?{metadata:safe.metadata,quality:safe.quality}:kind==="duplicates"?{metadata:safe.metadata,duplicates:safe.sections?.duplicates}:safe;
    downloadText(`长沙物理真题_${kind==="quality"?"数据质量报告":kind==="duplicates"?"重复试卷报告":"分析报告"}.json`,JSON.stringify(payload,null,2),"application/json;charset=utf-8");
  }

  function questionCompleteness(question) {
    const labels={questionNo:"核对原卷题号",stem:"补齐题干",type:"确认题型",answer:"补齐并核对答案",mainPoint:"确认具体主考点",physicalModel:"确认物理模型",method:"确认解题方法",abilities:"确认考查能力",options:"补齐选项",pageNo:"核对来源页码",sourceSpans:"补齐原卷来源",imageReviewed:"勾选确认：完整题区、无其他题目和答案","question-crop":"补齐单题原卷裁图"};
    const missing=window.ExamIngest.reviewIssues(question).map(issue=>labels[issue] || (/^page-(\d+)-crop$/.test(issue)?`补齐原卷第 ${issue.match(/^page-(\d+)-crop$/)[1]} 页的单题裁图`:issue));
    if(!(Number(question.score)>0))missing.push("补齐题目分值");
    if(!studentQuestionSetApi().validQuestionNo(question.questionNo))missing.push("题号异常，请对照原卷修正切题");
    return { missing:unique(missing) };
  }

  function addAudit(engine, entityType, entityId, status, payload) {
    engine.auditEvents.push({ id: makeId("audit"), entityType, entityId, status, payload, reviewer: "local_teacher", at: new Date().toISOString() });
    invalidateReport(engine);
  }

  function invalidateReport(engine) { if (engine) { engine.changeCounter = (engine.changeCounter || 0) + 1; delete engine._reportCache; } }

  async function persistAsset(blob, meta) {
    const extension=meta.extension||extensionFromName(meta.fileName||"");
    const response=await fetch("/api/physics-exam/assets",{method:"POST",headers:{
      "Content-Type":blob.type||(extension===".pdf"?"application/pdf":"image/jpeg"),"X-Asset-Filename":encodeURIComponent(meta.fileName||"source"),"X-Asset-Extension":extension,"X-Asset-Kind":meta.kind||"source","X-Asset-Sha256":meta.sha256||"","X-Asset-Parent-Id":meta.parentAssetId||"","X-Asset-Page-No":meta.pageNo?String(meta.pageNo):"","X-Asset-Crop":meta.crop||"","X-Asset-Phash":meta.perceptualHash||"","X-Asset-Source-Document-Id":meta.sourceDocumentId||"","X-Asset-Extraction-Run":meta.extractionRunId||""
    },body:blob});
    if(!response.ok){const detail=await response.json().catch(()=>({}));throw new Error(`原件／图片保存失败 ${response.status}：${detail.detail||detail.error||"请启动本机服务"}`);}
    return {...(await response.json()),pageNo:meta.pageNo||null,perceptualHash:meta.perceptualHash||""};
  }

  async function assetToDataUrl(asset) {
    if (!asset?.url) return "";
    try {
      const response = await fetch(asset.url);
      if (!response.ok) return "";
      const blob = await response.blob();
      return blobToDataUrl(blob);
    } catch {
      return "";
    }
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("无法生成页面图片"))), type, quality));
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function perceptualHash(canvas) {
    const tiny = document.createElement("canvas");
    tiny.width = 9;
    tiny.height = 8;
    const context = tiny.getContext("2d", { willReadFrequently: true });
    context.drawImage(canvas, 0, 0, 9, 8);
    const data = context.getImageData(0, 0, 9, 8).data;
    let bits = "";
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const left = grayscaleAt(data, y * 9 + x);
        const right = grayscaleAt(data, y * 9 + x + 1);
        bits += left > right ? "1" : "0";
      }
    }
    return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
  }

  function grayscaleAt(data, index) {
    const offset = index * 4;
    return data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;
  }

  async function sha256Hex(value) {
    try {
      const buffer = typeof value === "string" ? new TextEncoder().encode(value) : value;
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    } catch {
      return `fallback-${simpleHash(typeof value === "string" ? value : String(value?.byteLength || ""))}`;
    }
  }

  function normalizeExamText(value) {
    return normalizeDigits(String(value || ""))
      .replace(/\[\[PAGE:\d+\]\]/g, " ")
      .replace(/(?:第\s*)?\d+\s*页\s*(?:共\s*\d+\s*页)?/g, " ")
      .replace(/(?:版权所有|版权归属|仅供[^。\n]{0,80}|www\.[\w.-]+|https?:\/\/\S+|\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日)/g, " ")
      .replace(/[\u200b\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function stripEmbeddedSolution(text) {
    return String(text || "").replace(/(?:参考)?答案\s*[:：][\s\S]*$/i, "").replace(/(?:解析|详解)\s*[:：][\s\S]*$/i, "").trim();
  }

  function extractSourceExplanation(text) {
    const match = String(text || "").match(/(?:解析|详解)\s*[:：]\s*([\s\S]+)$/i);
    return match ? match[1].trim() : "";
  }

  function buildQuestionSignature(questions) {
    return questions
      .map((question) => `${question.questionNo}|${(question.options || []).map((option) => `${option.label}:${option.text}`).join("|")}|${question.answer || ""}`)
      .join("\n")
      .toLowerCase();
  }






  function confidencePill(confidence) { return `<span class="status-pill ${confidence?.label === "较高" ? "good" : "warn"}" title="${escapeAttr(confidence?.reason || "")}">${escapeHtml(confidence?.label || "证据不足")}</span>`; }

  function sourceLink(question, label) {
    const asset = question?.imageAssets?.[0];
    const url=safeAssetUrl(asset?.url);
    return url ? `<a class="source-link" target="_blank" rel="noreferrer" href="${escapeAttr(url)}">${escapeHtml(label)}</a>` : "—";
  }

  function safeAssetUrl(value) { return /^\/api\/physics-exam\/assets\/[a-zA-Z0-9_-]{8,80}$/.test(String(value||"")) ? String(value) : ""; }

  function safeExternalLink(url, label) {
    const value = String(url || "").trim();
    if (!/^https?:\/\//i.test(value)) return "";
    return `<a class="ghost link-button" target="_blank" rel="noreferrer" href="${escapeAttr(value)}">${escapeHtml(label)}</a>`;
  }

  function metricCard(label, value, note) {
    return `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></article>`;
  }

  function emptyState(title, note) {
    return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(note)}</p></div>`;
  }



  function parseModelJson(value) {
    const text = String(value || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try {
      return JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return {};
      try {
        return JSON.parse(match[0]);
      } catch {
        return {};
      }
    }
  }


  async function readCsvText(file) {
    const buffer = await file.arrayBuffer();
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      return new TextDecoder("gb18030").decode(buffer);
    }
  }

  function toCsv(rows) {
    return `\uFEFF${rows
      .map((row) => row.map((value) => `"${String(value ?? "").replace(/^[=+@-]/, "'$&").replace(/"/g, '""')}"`).join(","))
      .join("\r\n")}`;
  }

  function textToOptions(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^\s*([A-D])\s*[.．、:：]\s*(.*)$/i);
        return match ? { label: match[1].toUpperCase(), text: match[2].trim() } : null;
      })
      .filter(Boolean);
  }

  function optionsToText(options) {
    return (options || []).map((option) => `${option.label}. ${option.text}`).join("\n");
  }

  function normalizeOptions(options) {
    if (!Array.isArray(options)) return [];
    return options
      .map((option) => {
        if (typeof option === "string") {
          const match = option.match(/^\s*([A-D])\s*[.．、:：]?\s*(.*)$/i);
          return match ? { label: match[1].toUpperCase(), text: match[2].trim() } : null;
        }
        const label = String(option?.label ?? option?.option ?? "").trim().toUpperCase();
        const text = String(option?.text ?? option?.content ?? "").trim();
        return /^[A-D]$/.test(label) ? { label, text } : null;
      })
      .filter(Boolean);
  }

  function normalizeQuestionNo(value) {
    const match = normalizeDigits(String(value ?? "")).replace(/\s/g, "").match(/^(?:第)?([1-9]\d?)(?:[-_](\d+))?(?:题)?$/);
    return match ? (match[2] ? `${Number(match[1])}-${Number(match[2])}` : String(Number(match[1]))) : "";
  }

  function normalizeDigits(value) {
    const full = "０１２３４５６７８９";
    return String(value || "").replace(/[０-９]/g, (char) => String(full.indexOf(char))).replace(/．/g, ".");
  }

  function splitList(value) {
    return unique(String(value || "").split(/[，,、；;\n]/).map((item) => item.trim()).filter(Boolean));
  }

  function splitDataKey(value) {
    const index = String(value || "").indexOf("|");
    return index < 0 ? ["", ""] : [value.slice(0, index), value.slice(index + 1)];
  }


  function parseLessonQuestionSpec(spec) {
    return String(spec || "")
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .flatMap((item) => {
        const match = item.match(/^(.+?)x(\d+)$/i);
        return match ? Array.from({ length: Number(match[2]) }, (_, index) => `${match[1]}-${index + 1}`) : [item];
      });
  }


  function questionDisplay(question) {
    return `${question.year || "—"} ${question.region || ""} 第${question.questionNo || "?"}题`;
  }

  function dedupeEvidenceText(evidence) {
    if (!evidence) return "待比对";
    if (evidence.method === "new_canonical") return "首个 canonical";
    return `${evidence.method || "比对"}；文本 ${percent(evidence.textSimilarity || 0)}，图像 ${percent(evidence.imageSimilarity || 0)}，题签名 ${percent(evidence.questionSignatureSimilarity || 0)}`;
  }





  function safeScore(value) { return value != null && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null; }

  function safeBaseName(value) {
    return String(value || "source").replace(/\.[^.]+$/, "").replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 90) || "source";
  }

  function extensionFromName(value) {
    const match = String(value || "").match(/(\.[a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : ".bin";
  }


  function makeId(prefix) {
    const id = typeof crypto?.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    return `${prefix}_${id.replace(/-/g, "")}`;
  }

  function simpleHash(value) {
    let hash = 2166136261;
    String(value || "").split("").forEach((char) => {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    });
    return (hash >>> 0).toString(16);
  }

  function validTag(value) {
    return Boolean(value && String(value).trim() && !/^待人工(?:标注|确认)?$/.test(String(value).trim()));
  }

  function unique(values) {
    return [...new Set(values)];
  }

  function stringValue(value) {
    return value == null ? "" : String(value).trim();
  }

  function stringArray(value) {
    return Array.isArray(value) ? unique(value.map(stringValue).filter(Boolean)) : splitList(value);
  }





  function round1(value) {
    return Math.round(Number(value) * 10) / 10;
  }

  function round2(value) {
    return Math.round(Number(value) * 100) / 100;
  }

  function percent(value) {
    return `${Math.round((Number(value) || 0) * 100)}%`;
  }

  function riskLabel(score) {
    return RISK_LABELS.find(([limit]) => score >= limit)?.[1] || "提示关注";
  }

  function questionOrder(value) {
    const parts = String(value || "").split("-").map(Number);
    return (parts[0] || 999) * 100 + (parts[1] || 0);
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "—";
  }

  function roleLabel(value) {
    return ({
      original_with_source_analysis: "中考原卷＋来源解析",
      province_exam_pending: "省级卷待核验",
      original: "原卷版",
      analysis: "来源解析版",
      teacher_answer: "教师／答案版",
      student: "学生版",
      paper: "试卷／测试卷",
      practice: "练习／刷题",
      handout: "讲义／教材",
      topic: "专题资料",
      material: "训练资料",
    })[value] || value || "资料";
  }

  function errorMessage(error) {
    return String(error?.message || error || "未知错误").replace(/^Error:\s*/, "");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  window.ExamAnalysisEngine = {
    ensure,
    restore,
    schedulePersist,
    view,
    bind,
    ingestVerifiedWrongbook,
    buildReport,
    generateTrainingPlan,
  };
})();
