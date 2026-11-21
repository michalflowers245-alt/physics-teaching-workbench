/* Shared local-workbench presentation and interaction layer. Business functions stay in app.js. */
const workbench = {
  revision: 0, persistedRevision: 0, saveTimer: null, browserTimer: null,
  saveStatus: "loading", browserSaved: true, savedAt: "", job: null,
  mounted: false, renderedKey: "", composing: false, deferred: false,
  scrolls: new Map(), retry: null, initialized: false, lastSaveError: "",
};
const wbOriginal = {
  setupView, aiView, agentView, scoresView, wrongbookView, feedbackView,
  homeworkSettingsView, bindSetup, bindFeedback, bindAgent, importPanelState,
  callVisionModel, setAiProgress, saveRosterFromTextarea, gateEnsure, loadPdf,
};
const wbPages = [
  ["scores", "成绩表", "录入成绩，掌握每位学生的学习状态", "table"],
  ["knowledge", "题目解析", "整理标准答案，为错题核对做好准备", "edit"],
  ["pdf", "PDF 拆分", "上传试卷，检查学生与卷面的对应关系", "file"],
  ["wrongbook", "错题汇总", "逐项核对错题，让反馈有据可依", "check"],
  ["feedback", "一对一反馈", "把学习情况整理成清楚、具体的家长反馈", "msg"],
  ["gate", "课程关卡", "从课程资料到逐项过关，每一步都有记录", "check"],
  ["setup", "名单与课程", "管理班级与学生，准备每一次课程", "users"],
  ["ai", "AI 配置", "查看连接状态，按需调整识别设置", "edit"],
  ["agent", "智能助手", "围绕当前课程，和你的教学助手一起思考", "msg"],
  ["recording", "录课快剪", "按知识点剪出完整讲解", "file"],
  ["moments", "语音识别与朋友圈反馈", "上传课堂录音，一次生成报告、复习图和朋友圈文案", "msg"],
];

function wbUI() {
  state.ui ||= {};
  const ui = state.ui;
  ui.filters ||= {};
  ui.details ||= {};
  ui.rosterDrafts ||= {};
  ui.answerDrafts ||= {};
  ui.uploads ||= {};
  ui.scrolls ||= {};
  ui.density = ui.density === "compact" ? "compact" : "comfortable";
  return ui;
}

function initializeWorkbench() {
  if (workbench.initialized) return;
  workbench.initialized = true;
  wbUI();
  if (!wbPages.some(function (page) { return page[0] === state.active; })) state.active = "scores";
  for (const progress of Object.values(state.aiProgress || {})) {
    if (progress.status === "active") {
      progress.status = "failed";
      progress.message = "上次处理已中断，可重新开始；已保存内容仍在。";
    }
  }
  if (state.feedbackProgress) state.feedbackProgress.active = false;
  for (const student of Object.values(state.gate?.progress || {})) {
    for (const lesson of Object.values(student)) {
      for (const record of Object.values(lesson)) {
        if (record.status === "checking") {
          record.status = "pending";
          record.feedback = "上次核验已中断，答案已保留，请重新提交。";
        }
      }
    }
  }
  document.addEventListener("compositionstart", function () { workbench.composing = true; }, true);
  document.addEventListener("compositionend", function () {
    workbench.composing = false;
    if (workbench.deferred) {
      workbench.deferred = false;
      requestAnimationFrame(render);
    }
  }, true);
  window.addEventListener("pagehide", function () {
    wbCapturePosition();
    wbWriteBrowser();
    // LocalStorage is the recovery source if the process exits before this disk write.
    if (workbench.persistedRevision < workbench.revision) {
      // The IndexedDB replica and synchronous per-session journal recover interrupted writes.
      // No unversioned beacon: it could overwrite a newer browser tab.
    }
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { wbCapturePosition(); wbWriteBrowser(); }
  });
  // Opening a second read-only tab must not create a competing server revision.
}

function wbSaveIndicator() {
  const texts = {
    loading: "正在读取本机记录", saving: "正在保存…", saved: "已保存到本机",
    browser: "仅浏览器副本已保存", error: "尚未保存，请重试",
  };
  return '<span class="save-dot"></span><span>' + texts[workbench.saveStatus] + '</span>';
}

function wbUpdateSaveIndicator() {
  document.querySelectorAll("[data-save-indicator]").forEach(function (node) {
    node.innerHTML = wbSaveIndicator();
    node.dataset.status = workbench.saveStatus;
    node.title = workbench.savedAt ? "最近写入本机：" + new Date(workbench.savedAt).toLocaleTimeString("zh-CN") : "学生数据保存在本机";
  });
  document.querySelectorAll("[data-save-retry]").forEach(function (node) {
    node.hidden = !["browser", "error"].includes(workbench.saveStatus);
  });
}

function wbWriteBrowser() {
  clearTimeout(workbench.browserTimer);
  try {
    localStorage.setItem(STORAGE_KEY, serializedState());
    localStorage.setItem(STORAGE_SAVED_AT_KEY, new Date().toISOString());
    localStorage.setItem("physics-workbench-pending", String(workbench.revision > workbench.persistedRevision));
    workbench.browserSaved = true;
  } catch (error) {
    workbench.browserSaved = false;
    workbench.lastSaveError = String(error.message || error);
  }
}

saveState = function () {
  workbench.revision += 1;
  workbench.saveStatus = "saving";
  wbUpdateSaveIndicator();
  clearTimeout(workbench.browserTimer);
  workbench.browserTimer = setTimeout(wbWriteBrowser, 160);
  schedulePanelStateSave(420);
};

schedulePanelStateSave = function (delay = 420) {
  clearTimeout(workbench.saveTimer);
  workbench.saveTimer = setTimeout(function () {
    wbWriteBrowser();
    const revision = workbench.revision;
    const snapshot = panelStateSnapshot();
    panelStateSaveQueue = panelStateSaveQueue.catch(function () {}).then(function () {
      return persistPanelState(snapshot, revision);
    });
  }, delay);
};

persistPanelState = async function (snapshot, revision = workbench.revision) {
  try {
    const response = await fetch(PANEL_STATE_ENDPOINT, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: snapshot }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("保存接口返回 " + response.status);
    const result = await response.json();
    if (!result.ok) throw new Error("未收到保存确认");
    workbench.persistedRevision = Math.max(workbench.persistedRevision, revision);
    workbench.savedAt = result.savedAt;
    if (revision === workbench.revision) {
      workbench.saveStatus = "saved";
      try { localStorage.setItem("physics-workbench-pending", "false"); } catch {}
    }
  } catch (error) {
    if (revision === workbench.revision) {
      workbench.saveStatus = workbench.browserSaved ? "browser" : "error";
      workbench.lastSaveError = String(error.message || error);
    }
  }
  wbUpdateSaveIndicator();
};

restorePanelStateFromDisk = async function () {
  let browserPending = false;
  try { browserPending = localStorage.getItem("physics-workbench-pending") === "true"; } catch {}
  try {
    const response = await fetch(PANEL_STATE_ENDPOINT, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("无法读取本机文件");
    const data = await response.json();
    if (data.state && !browserPending) {
      const key = state.ai?.key || "";
      state = mergeState(structuredClone(defaultState), data.state);
      if (key) state.ai.key = key;
      migrateAiDefaults(); migrateParentTitles(); normalizeLessonMeta();
    }
    workbench.savedAt = data.savedAt || "";
  } catch {
    workbench.saveStatus = "browser";
  }
};

function wbContextKey() {
  return [state.lesson.gradeId, state.lesson.year, state.lesson.term, state.lesson.lessonNo].join("|");
}

function wbViewKey() { return state.active + "|" + wbContextKey() + "|" + (state.active === "gate" ? state.gate?.mode : ""); }

function wbCapturePosition() {
  if (!workbench.renderedKey) return;
  const position = {
    y: window.scrollY,
    areas: Array.from(document.querySelectorAll(".table-wrap,.agent-chat,.gate-course-nav")).map(function (el) {
      return [el.scrollLeft, el.scrollTop];
    }),
  };
  workbench.scrolls.set(workbench.renderedKey, position);
  wbUI().scrolls[workbench.renderedKey] = position;
}

function wbFocusKey(element) {
  if (!element || !element.matches("input,textarea,select,button")) return null;
  const attrs = Array.from(element.attributes).filter(function (attr) { return attr.name.startsWith("data-"); });
  return attrs.length ? attrs.map(function (attr) { return "[" + attr.name + '="' + CSS.escape(attr.value) + '"]'; }).join("") : null;
}

function wbShell() {
  const groups = [["课前测与反馈", wbPages.slice(0, 5)], ["课程学习", wbPages.slice(5, 6)], ["管理与设置", wbPages.slice(6)]];
  return '<div class="app-shell workbench-shell"><aside class="side">' +
    '<div class="editorial-brand-row"><div class="brand"><div class="brand-mark" aria-hidden="true">张</div><div class="brand-copy"><h1>张老师物理</h1><p>教学工作台</p></div></div>' +
    '<button type="button" class="sidebar-toggle" data-collapse aria-label="收起或展开侧栏" title="收起或展开侧栏"><span class="sidebar-toggle-icon" aria-hidden="true"></span></button></div>' +
    '<nav class="nav" aria-label="主导航">' + groups.map(function (group) {
      return '<div class="nav-group"><p class="nav-group-label">' + group[0] + '</p>' + group[1].map(function (page) {
        return '<button type="button" data-nav="' + page[0] + '" title="' + page[1] + '">' + icons[page[3]] + '<span>' + page[1] + '</span><i class="nav-selected-dot"></i></button>';
      }).join("") + '</div>';
    }).join("") + '</nav>' +
    '<div class="side-footer"><div class="local-save-note" data-save-indicator>' + wbSaveIndicator() + '</div><button class="ghost" data-save-retry hidden>重试本机保存</button><details data-detail="backup"><summary>' + icons.download + '<span>数据与备份</span></summary><div class="backup-actions"><button class="ghost" data-export-state>导出面板数据</button><label class="ghost action-button">导入面板数据<input class="sr-file" type="file" accept=".json" data-import-state></label><p class="hint">名单、反馈与进度持续保存在本机。</p></div></details></div></aside>' +
    '<section class="main"><header data-wb-header></header><div data-wb-job aria-live="polite"></div><div data-view-content></div><footer class="workbench-footer">张老师物理 · 本地教学工作台</footer></section></div><div class="notice-stack" aria-live="polite" aria-atomic="false"></div>';
}

function wbLessonMeta(lesson, showLessonNo = true) {
  const parts = [currentGrade()?.name, [lesson.year, lesson.term].filter(Boolean).join(" "), showLessonNo && lesson.lessonNo && "第" + lesson.lessonNo + "讲"];
  const context = parts.filter(Boolean).map(value => '<span>' + escapeHtml(value) + '</span>');
  if (lesson.date) context.push('<time datetime="' + escapeAttr(lesson.date) + '">' + escapeHtml(lesson.date) + '</time>');
  return context.join(" ");
}

function wbUpdateSidebar() {
  const collapsed = !!state.ui.collapsed;
  document.querySelector(".workbench-shell").classList.toggle("is-collapsed", collapsed);
  const toggle = document.querySelector("[data-collapse]");
  const label = collapsed ? "展开侧栏" : "收起侧栏";
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
}

function wbHeader() {
  const page = wbPages.find(function (p) { return p[0] === state.active; }) || wbPages[0];
  const key = page[0];
  const isClass = key === "classroom";
  const lesson = state.lesson;
  const lessonNo = String(lesson.lessonNo || "");
  const displayNo = /^\d+$/.test(lessonNo) ? lessonNo.padStart(2, "0") : "";
  const title = isClass && lesson.topic ? lesson.topic : page[1];
  const lessonMeta = wbLessonMeta(lesson, !isClass || !displayNo);
  const kicker = {classroom:"课程记录", overview:"本次测评", feedback:"课后跟进", outreach:"发布与咨询"}[key];
  const showLesson = !["outreach", "recording", "moments", "setup", "ai", "agent", "exam"].includes(key);
  return '<div class="workbench-topline editorial-topline"><span>教学工作台 <span class="breadcrumb-separator">/</span> ' + escapeHtml(page[1]) +
    '</span><div class="editorial-local"><span class="local-badge"><i></i> 本机使用</span><span class="header-save" data-save-indicator role="status">' + wbSaveIndicator() + '</span><button class="ghost header-retry" data-save-retry hidden>重试保存</button></div></div>' +
    '<div class="topbar editorial-hero" data-editorial-page="' + escapeAttr(key) + '">' +
    '<div class="editorial-hero-copy">' +
    (isClass && displayNo ? '<span class="editorial-classno">第 <b>' + escapeHtml(displayNo) + '</b> 讲</span>' :
     kicker ? '<span class="editorial-kicker">' + kicker + '</span>' : '') +
    '<h2 data-editorial-title>' + escapeHtml(title) + '</h2><p>' + escapeHtml(page[2]) + '</p>' +
    (showLesson && lessonMeta ? '<p class="editorial-lesson">' + lessonMeta + '</p>' : '') +
    (isClass ? '<div class="editorial-hero-actions"><button type="button" class="editorial-jump" data-editorial-jump="classroom-delivery">宣发素材 <span aria-hidden="true">↓</span></button><button type="button" class="editorial-jump" data-editorial-jump="classroom-prepare">备课 <span aria-hidden="true">↓</span></button></div>' : '') +
    '</div></div>' +
    (historyEnabledForActive() ? '<details class="history-drawer" data-detail="history-' + state.active + '"><summary>查看历史记录 <span>按年份、学期与课次查找</span></summary><div class="history-drawer-body"><p class="hint">这里查询历史记录，不会改变当前录入的课程。载入历史需点击对应记录的按钮。</p>' + historyControlsView(state.active) + '</div></details>' : "");
}

render = function () {
  if (workbench.composing) { workbench.deferred = true; return; }
  wbUI();
  if (!state.lesson.gradeId && state.grades[0]) state.lesson.gradeId = state.grades[0].id;
  normalizeLessonMeta();
  const nextKey = wbViewKey();
  const sameView = nextKey === workbench.renderedKey;
  const focused = document.activeElement;
  const focusSelector = sameView ? wbFocusKey(focused) : null;
  const selection = focused && typeof focused.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd] : null;
  wbCapturePosition();
  if (!workbench.mounted || !document.querySelector("[data-view-content]")) {
    document.querySelector("#app").innerHTML = wbShell();
    workbench.mounted = true;
    wbBindShell();
  }
  wbUpdateSidebar();
  document.querySelectorAll(".nav [data-nav]").forEach(function (button) {
    button.setAttribute("aria-current", button.dataset.nav === state.active ? "page" : "false");
    button.setAttribute("aria-selected", String(button.dataset.nav === state.active));
  });
  document.querySelector("[data-wb-header]").innerHTML = wbHeader();
  document.querySelectorAll("[data-editorial-jump]").forEach(function (button) {
    button.addEventListener("click", function () {
      const target = document.getElementById(button.dataset.editorialJump);
      if (!target) return;
      target.focus({preventScroll:true});
      target.scrollIntoView({block:"start",behavior:matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"});
    });
  });
  const view = document.querySelector("[data-view-content]");
  view.dataset.page = state.active;
  view.innerHTML = activeView();
  workbench.renderedKey = nextKey;
  bindView();
  bindHistoryControls();
  wbEnhance();
  const position = workbench.scrolls.get(nextKey) || state.ui.scrolls[nextKey];
  requestAnimationFrame(function () {
    window.scrollTo({ top: position?.y || 0, behavior: "instant" });
    document.querySelectorAll(".table-wrap,.agent-chat,.gate-course-nav").forEach(function (el, index) {
      if (position?.areas?.[index]) { el.scrollLeft = position.areas[index][0]; el.scrollTop = position.areas[index][1]; }
    });
    if (focusSelector) {
      const replacement = document.querySelector(focusSelector);
      if (replacement && !replacement.disabled) {
        replacement.focus({ preventScroll: true });
        if (selection && replacement.setSelectionRange && !["number", "file"].includes(replacement.type)) replacement.setSelectionRange(...selection);
      }
    }
  });
};

function wbBindShell() {
  document.querySelector("#app").addEventListener("click", async function (event) {
    const nav = event.target.closest("[data-nav]");
    if (nav) {
      wbCapturePosition(); state.active = nav.dataset.nav; saveState(); render(); return;
    }
    if (event.target.closest("[data-collapse]")) {
      state.ui.collapsed = !state.ui.collapsed;
      wbUpdateSidebar();
      saveState();
    }
    if (event.target.closest("[data-save-retry]")) { workbench.saveStatus = "saving"; wbUpdateSaveIndicator(); schedulePanelStateSave(0); }
    if (event.target.closest("[data-export-state]")) downloadText("张老师物理-工作台备份.json", JSON.stringify(state, null, 2), "application/json");
  });
  document.querySelector("[data-import-state]").addEventListener("change", async function (event) {
    if (!event.target.files?.length) return;
    if (!await wbConfirm("导入面板数据", "导入将替换当前面板内容。当前数据会先自动下载为备份。", "备份并导入")) { event.target.value = ""; return; }
    downloadText("导入前-工作台备份.json", JSON.stringify(state, null, 2), "application/json");
    await wbRunJob("导入面板数据", function () { return wbOriginal.importPanelState(event); });
  });
  // Lock only business mutations while a job owns the shared course state; navigation remains usable.
  document.querySelector("#app").addEventListener("click", function (event) {
    if (!workbench.job) return;
    const target = event.target.closest("button,label,input,select,textarea,summary");
    if (!target || wbSafeDuringJob(target)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    toast("正在" + workbench.job.label + "，可切换页面查看，完成后再编辑数据。");
  }, true);
}

function wbSafeDuringJob(el) {
  return !!el.closest("[data-nav],[data-collapse],[data-save-retry],[data-export-state],summary,[data-wb-filter],[data-density],[data-wb-status-filter],[data-gate-mode],[data-gate-student-select],[data-gate-use-student],[data-gate-student-custom],[data-gate-evidence],[data-gate-select-lesson],[data-copy-feedback],[data-wb-notice-close]");
}

function wbSetJobUI() {
  const target = document.querySelector("[data-wb-job]");
  if (target) target.innerHTML = workbench.job ? '<div class="job-banner"><span class="spinner"></span><div><strong>' + escapeHtml(workbench.job.label) + '</strong><span>处理中，可切换页面查看。为防止结果混入其他课程，相关编辑暂时停用。</span></div></div>' : "";
  document.querySelectorAll("[data-view-content] input,[data-view-content] select,[data-view-content] textarea,[data-view-content] button,[data-import-state], [data-wb-header] select").forEach(function (el) {
    if (workbench.job && !wbSafeDuringJob(el) && !el.disabled) { el.dataset.jobDisabled = "true"; el.disabled = true; }
    else if (!workbench.job && el.dataset.jobDisabled) { el.disabled = false; delete el.dataset.jobDisabled; }
  });
}

async function wbRunJob(label, fn) {
  if (workbench.job) { toast("已有任务正在进行，请稍候"); return; }
  const token = { id: crypto.randomUUID(), context: wbContextKey(), label: label };
  workbench.job = token; wbSetJobUI();
  try { return await fn(token); }
  finally { if (workbench.job === token) workbench.job = null; wbSetJobUI(); }
}

callVisionModel = async function (prompt, imageDataUrl = "") {
  const context = wbContextKey();
  const reply = await wbOriginal.callVisionModel(prompt, imageDataUrl);
  if (context !== wbContextKey()) throw new Error("课程已切换，本次结果未写入。请回原课程重试。");
  return reply;
};

function wbWrapJob(fn, label) {
  return function (...args) { return wbRunJob(label, function () { return fn(...args); }); };
}
importAnswerPdf = wbWrapJob(importAnswerPdf, "读取题目解析");
aiRecognizeHeaders = wbWrapJob(aiRecognizeHeaders, "识别姓名与分数");
aiFillWrongbookForMatchedPairs = wbWrapJob(aiFillWrongbookForMatchedPairs, "识别错题");
generateFeedbacks = wbWrapJob(generateFeedbacks, "生成家长反馈");
loadPdf = function (event) {
  return wbRunJob("读取与拆分试卷", async function () {
    const previousBytes = sourcePdfBytes;
    const previousPdf = state.pdf;
    try { await wbOriginal.loadPdf(event); }
    catch (error) {
      sourcePdfBytes = previousBytes; state.pdf = previousPdf;
      toast("试卷读取失败，原有拆分记录已保留。请检查 PDF 后重新上传。" + progressErrorMessage(error), "error");
      render();
    }
  });
};
distillAgentMemory = wbWrapJob(distillAgentMemory, "整理助手记忆");

function wbWrapImport(fn, label) {
  return function (...args) {
    return wbRunJob(label, async function () {
      try { return await fn(...args); }
      catch (error) { toast(label + "失败，请检查文件后重试。" + progressErrorMessage(error), "error"); }
    });
  };
}
importScores = wbWrapImport(importScores, "导入成绩");
importWrongbook = wbWrapImport(importWrongbook, "导入错题");
importKnowledge = wbWrapImport(importKnowledge, "导入解析");

bindAi = function () {
  onInput("[data-ai-key]", function (value) { state.ai.key = value.trim(); });
  onInput("[data-ai-model]", function (value) { state.ai.model = value.trim() || OPENAI_MODEL; });
  onInput("[data-ai-base]", function (value) { state.ai.baseUrl = value.trim() || defaultState.ai.baseUrl; });
  document.querySelector("[data-ai-test]").onclick = function () {
    wbRunJob("测试 AI 连接", async function () {
      setAiProgress("config", 0, 1, "active");
      try {
        const reply = await callVisionModel("连接检查：请只回复连接正常。");
        setAiProgress("config", 1, 1, "done");
        toast("连接成功，模型回复：" + reply.slice(0, 40));
      } catch (error) {
        setAiProgress("config", 0, 1, "failed", visionErrorMessage(error));
        toast(visionErrorMessage(error), "error");
      }
      saveState();
    });
  };
};

toast = function (message, kind) {
  const error = kind === "error" || /失败|未保存|校对有误|无法|超时|中断/.test(message);
  const stack = document.querySelector(".notice-stack") || document.body.appendChild(Object.assign(document.createElement("div"), { className: "notice-stack" }));
  const notice = document.createElement("div");
  notice.className = "wb-notice " + (error ? "notice-error" : "notice-success");
  notice.setAttribute("role", error ? "alert" : "status");
  notice.innerHTML = '<span class="notice-symbol">' + (error ? "!" : "✓") + '</span><span>' + escapeHtml(message) + '</span><button type="button" aria-label="关闭提示" data-wb-notice-close>×</button>';
  notice.querySelector("button").onclick = function () { notice.remove(); };
  stack.appendChild(notice);
  while (stack.children.length > 3) stack.firstChild.remove();
  if (!error) setTimeout(function () { notice.remove(); }, 3800);
};

function wbConfirm(title, message, confirmText = "确认") {
  return new Promise(function (resolve) {
    const previous = document.activeElement;
    const dialog = document.createElement("dialog");
    dialog.className = "wb-dialog";
    dialog.innerHTML = '<form method="dialog"><div class="dialog-symbol">' + icons.check + '</div><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(message) + '</p><div class="actions"><button class="ghost" value="cancel" autofocus>取消</button><button class="primary" value="confirm">' + escapeHtml(confirmText) + '</button></div></form>';
    dialog.addEventListener("close", function () { const confirmed = dialog.returnValue === "confirm"; dialog.remove(); previous?.focus?.(); resolve(confirmed); }, { once: true });
    document.body.appendChild(dialog); dialog.showModal();
  });
}

function wbDetails(key, title, content, open = false) {
  return '<details class="section settings-disclosure" data-detail="' + key + '"' + (wbUI().details[key] ?? open ? " open" : "") + '><summary>' + title + '<span>点击展开设置</span></summary><div class="disclosure-body">' + content + '</div></details>';
}

homeworkSettingsView = function () {
  return wbDetails("homework", "评分规则", wbOriginal.homeworkSettingsView());
};
scoreTableDensity = function () {
  return wbUI().density === "compact" ? "--score-row-height:42px;--score-input-height:32px;--score-font-size:14px;--score-cell-padding-y:5px;--score-head-padding-y:10px" :
    "--score-row-height:56px;--score-input-height:40px;--score-font-size:16px;--score-cell-padding-y:8px;--score-head-padding-y:12px";
};

function wbFilterBar(kind, placeholder) {
  return '<div class="filter-toolbar"><label class="search-box"><span aria-hidden="true">⌕</span><input type="search" data-wb-filter="' + kind + '" aria-label="' + placeholder + '" placeholder="' + placeholder + '" value="' + escapeAttr(wbUI().filters[kind] || "") + '"></label>' +
    (kind === "scores" ? '<div class="segmented" aria-label="表格密度"><button data-density="comfortable" aria-pressed="' + (state.ui.density === "comfortable") + '">舒适</button><button data-density="compact" aria-pressed="' + (state.ui.density === "compact") + '">紧凑</button></div>' : "") +
    (kind === "wrongbook" ? '<div class="segmented status-filters">' + [["all","全部"],["pending","待校对"],["diff","有差异"],["checked","已校对"]].map(function (entry) { return '<button data-wb-status-filter="' + entry[0] + '" aria-pressed="' + ((state.ui.wrongbookFilter || "all") === entry[0]) + '">' + entry[1] + '</button>'; }).join("") + '</div>' : "") +
    '<span class="filter-count" data-filter-count="' + kind + '"></span></div><p class="filter-empty" data-filter-empty="' + kind + '" hidden>没有匹配的学生，试试其他姓名或筛选条件。</p>';
}
scoresView = function () {
  const template = document.createElement("template");
  template.innerHTML = wbOriginal.scoresView();
  const rules = template.content.querySelector("[data-detail=homework]");
  if (rules) template.content.appendChild(rules);
  const tableSection = template.content.querySelector(".score-table-wrap")?.closest("section");
  if (tableSection) {
    const toolbar = template.content.querySelector(".score-title-row");
    tableSection.insertAdjacentHTML("afterbegin", wbFilterBar("scores", "搜索学生姓名"));
    if (toolbar) tableSection.prepend(toolbar);
  }
  return template.innerHTML;
};
wrongbookView = function () {
  const template = document.createElement("template");
  template.innerHTML = wbOriginal.wrongbookView();
  const tableSection = template.content.querySelector(".wrongbook-table")?.closest("section");
  const toolbar = template.content.querySelector(".section-title-row");
  if (tableSection && toolbar) tableSection.prepend(toolbar);
  return wbFilterBar("wrongbook", "搜索学生姓名") + template.innerHTML;
};
feedbackView = function () { return wbFilterBar("feedback", "搜索并定位学生反馈") + wbOriginal.feedbackView(); };

setupView = function () {
  const grade = currentGrade();
  const draft = wbUI().rosterDrafts[grade.id];
  return '<section class="section roster-workspace"><div class="section-title-row"><div><h3>我的班级</h3><p class="hint">选择班级，编辑名单。每行一位学生，也可以直接粘贴 Excel 名单。</p></div><span class="status-pill">' + grade.students.length + ' 位学生</span></div>' +
    '<div class="roster-layout"><div class="class-column"><div class="mini-list">' + state.grades.map(function (g) {
      return '<button class="mini-list-item" data-setup-grade="' + g.id + '" aria-selected="' + (g.id === grade.id) + '"><strong>' + escapeHtml(g.name) + '</strong><span>' + g.students.length + ' 人</span></button>';
    }).join("") + '</div><div class="field new-class"><label for="new-grade">新增班级名称</label><input id="new-grade" data-grade-name placeholder="例如：初二周六班"></div><button class="secondary" data-add-grade>' + icons.plus + '新增班级</button></div>' +
    '<div class="roster-editor"><div class="field"><label for="roster-input">' + escapeHtml(grade.name) + ' · 学生名单</label><textarea id="roster-input" data-roster-text placeholder="每行一位学生">' + escapeHtml(draft ?? grade.students.join("\n")) + '</textarea></div><div class="roster-note"><span class="status-pill good">家长称呼统一为「家长」</span><span class="hint">名单草稿自动保存</span></div><div class="actions"><button class="primary" data-save-roster>保存名单</button><button class="secondary" data-build-score>' + icons.table + '生成成绩表</button></div></div></div></section>' +
    wbDetails("course-settings", "课程与评分设置", '<div class="grid three"><div class="field"><label>年份</label><input data-lesson-year value="' + escapeAttr(state.lesson.year) + '" inputmode="numeric"></div><div class="field"><label>学期</label><select data-lesson-term>' + TERMS.map(function (term) { return '<option ' + (term === state.lesson.term ? "selected" : "") + '>' + term + '</option>'; }).join("") + '</select></div><div class="field"><label>总课次</label><input data-total-lessons type="number" min="1" value="' + totalLessons() + '"></div><div class="field"><label>课前测满分</label><input data-max-score type="number" step="0.5" value="' + state.lesson.maxScore + '"></div><div class="field"><label>每个错题单位扣分</label><input data-penalty type="number" step="0.5" value="' + state.lesson.penalty + '"></div></div><div class="actions"><button class="danger" data-delete-grade>删除当前班级</button></div>');
};

bindSetup = function () {
  wbOriginal.bindSetup();
  const input = document.querySelector("[data-roster-text]");
  input.addEventListener("input", function () { wbUI().rosterDrafts[currentGrade().id] = input.value; saveState(); });
  const deletion = document.querySelector("[data-delete-grade]");
  deletion.addEventListener("click", async function (event) {
    if (deletion.dataset.confirmed === "yes") { delete deletion.dataset.confirmed; return; }
    event.preventDefault(); event.stopImmediatePropagation();
    if (await wbConfirm("删除当前班级？", "会移除当前班级和名单。操作前将自动下载一份数据备份，历史记录仍保留。", "备份并删除")) {
      downloadText("删除班级前-备份.json", JSON.stringify(state, null, 2), "application/json");
      deletion.dataset.confirmed = "yes"; deletion.click();
    }
  }, true);
};
saveRosterFromTextarea = function (showToast = true) {
  wbOriginal.saveRosterFromTextarea(false);
  delete wbUI().rosterDrafts[currentGrade().id];
  saveState();
  if (showToast) { toast("名单已保存，共 " + currentGrade().students.length + " 位学生"); render(); }
};

aiView = function () {
  const template = document.createElement("template");
  template.innerHTML = wbOriginal.aiView();
  const fields = template.content.querySelector(".grid");
  fields.outerHTML = wbDetails("ai-advanced", "连接与模型设置", fields.outerHTML);
  template.content.querySelector(".hint").textContent = "当前识别、关卡核验与反馈共用本机 AI 连接。先测试连接，日常使用无需重复设置。";
  return '<div class="ai-summary section"><div class="ai-orb">' + icons.edit + '</div><div><span class="eyebrow">教学 AI 助手</span><h3>' + escapeHtml(state.ai.model || OPENAI_MODEL) + '</h3><p class="hint">服务于解析、核对、反馈与课程过关</p></div><span class="status-pill">本机连接</span></div>' + template.innerHTML;
};

agentView = function () {
  const template = document.createElement("template");
  template.innerHTML = wbOriginal.agentView();
  const sections = Array.from(template.content.children).filter(function (node) { return node.tagName === "SECTION"; });
  const memory = sections[0]; const chat = sections[1];
  const retry = state.agent?.failedDraft ? '<div class="inline-error" role="alert">上次发送失败，内容已保留。<button class="secondary" data-agent-retry>重新发送</button></div>' : "";
  return chat.outerHTML + retry + wbDetails("agent-memory", "助手记忆与课程信息", memory.innerHTML);
};

sendAgentMessage = async function () {
  const draft = String(state.agent?.draft || "").trim();
  if (!draft || workbench.job) return;
  await wbRunJob("等待助手回复", async function () {
    const agent = state.agent;
    agent.failedDraft = "";
    agent.messages.push({ role: "user", content: draft, at: new Date().toISOString() });
    agent.draft = "";
    const prompt = agentPrompt(draft);
    saveState(); render();
    try {
      const reply = await callVisionModel(prompt);
      if (state.agent !== agent) return;
      agent.messages.push({ role: "assistant", content: reply, at: new Date().toISOString() });
    } catch (error) {
      agent.failedDraft = draft; agent.draft ||= draft;
      toast(progressErrorMessage(error), "error");
    }
    saveState(); render();
    document.querySelector(".agent-chat")?.scrollTo({ top: 100000, behavior: "smooth" });
  });
};
bindAgent = function () {
  wbOriginal.bindAgent();
  document.querySelector("[data-agent-draft]")?.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); sendAgentMessage(); }
  });
  document.querySelector("[data-agent-retry]")?.addEventListener("click", function () {
    const failed = state.agent.failedDraft;
    if (!failed) return;
    if (state.agent.messages.at(-1)?.content === failed && state.agent.messages.at(-1)?.role === "user") state.agent.messages.pop();
    state.agent.draft = failed; sendAgentMessage();
  });
};

bindFeedback = function () {
  wbOriginal.bindFeedback();
  document.querySelectorAll("[data-copy-feedback]").forEach(function (button) {
    button.addEventListener("click", async function (event) {
      event.stopImmediatePropagation();
      if (button.dataset.copying) return;
      const item = state.feedbacks[Number(button.dataset.copyFeedback)];
      button.dataset.copying = "true"; button.textContent = "复制中…";
      button.setAttribute("aria-busy", "true");
      try {
        await wbCopyText(item.text);
        button.textContent = "✓ 已复制"; button.classList.add("copied");
        setTimeout(function () { if (button.isConnected) { button.textContent = "复制反馈"; button.classList.remove("copied"); } }, 2400);
      } catch { button.textContent = "重试复制"; toast("复制失败，请选中反馈文字手动复制。", "error"); }
      finally { delete button.dataset.copying; button.removeAttribute("aria-busy"); }
    }, true);
  });
};

async function wbCopyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch {}
  const previous = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text; field.setAttribute("aria-label", "待复制的反馈");
  field.style.cssText = "position:fixed;left:0;top:0;opacity:0;width:1px;height:1px";
  document.body.appendChild(field); field.focus(); field.select();
  let copied = false;
  try { copied = document.execCommand("copy"); }
  finally { field.remove(); previous?.focus({ preventScroll: true }); }
  if (!copied) throw new Error("Clipboard unavailable");
}

function wbApplyFilters() {
  const kind = state.active;
  const q = String(wbUI().filters[kind] || "").trim().toLowerCase();
  let nodes = [], total = 0, checked = 0;
  if (kind === "scores") nodes = Array.from(document.querySelector(".score-table")?.querySelectorAll("tbody tr") || []).filter(function (row) { return !!row.querySelector(".student-name-cell"); });
  if (kind === "wrongbook") nodes = Array.from(document.querySelectorAll(".wrongbook-table tbody tr"));
  if (kind === "feedback") nodes = Array.from(document.querySelectorAll("[data-feedback-list] .feedback-card"));
  nodes.forEach(function (node) {
    let name = node.querySelector("td,h3")?.textContent || "";
    let show = !q || name.toLowerCase().includes(q);
    if (kind === "wrongbook") {
      const index = Number(node.querySelector("[data-wb-row-confirm]")?.dataset.wbRowConfirm);
      const row = state.wrongbook.rows[index];
      const status = state.ui.wrongbookFilter || "all";
      if (row?.checked) checked++;
      if (status === "pending") show &&= !row?.checked;
      if (status === "checked") show &&= !!row?.checked;
      if (status === "diff") show &&= !!row && !wrongbookStatusData(row).ok;
      // Finishing an edit may change its filter status. Keep the active row until
      // focus leaves it, so continuous typing and Tab navigation never disappear.
      if (!show && node.contains(document.activeElement)) show = true;
    }
    node.hidden = !show;
    if (show) total++;
  });
  const count = document.querySelector("[data-filter-count]");
  if (count) count.textContent = (q || (kind === "wrongbook" && state.ui.wrongbookFilter !== "all") ? "显示 " + total + " / " + nodes.length : "共 " + nodes.length + " 位学生") + (kind === "wrongbook" ? " · 已校对 " + checked : "");
  const empty = document.querySelector("[data-filter-empty]");
  if (empty) empty.hidden = !nodes.length || total > 0;
}

function wbEnhance() {
  wbUpdateSaveIndicator();
  document.querySelectorAll("[data-detail]").forEach(function (details) {
    const stored = wbUI().details[details.dataset.detail];
    if (stored !== undefined) details.open = stored;
    if (details.dataset.wbBound) return;
    details.dataset.wbBound = "true";
    details.addEventListener("toggle", function () {
      if (wbUI().details[details.dataset.detail] !== details.open) { state.ui.details[details.dataset.detail] = details.open; saveState(); }
      if (details.classList.contains("history-drawer")) wbShowHistory();
    });
  });
  document.querySelectorAll(".field").forEach(function (field, index) {
    const label = field.querySelector("label");
    const input = field.querySelector("input,select,textarea");
    if (label && input) { input.id ||= "wb-" + state.active + "-" + index; label.htmlFor = input.id; }
  });
  const tableHeadingCache = new WeakMap();
  document.querySelectorAll("td input,td select").forEach(function (input) {
    const row = input.closest("tr"); const cell = input.closest("td");
    const table = input.closest("table");
    if (!tableHeadingCache.has(table)) tableHeadingCache.set(table, Array.from(table.querySelectorAll("thead th"), th => th.textContent));
    const heading = tableHeadingCache.get(table)[cell.cellIndex] || "";
    input.setAttribute("aria-label", row.cells[0].textContent.trim() + " " + heading);
    input.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      const rows = Array.from(row.parentElement.rows).filter(function (item) { return !item.hidden; });
      const next = rows[rows.indexOf(row) + (event.shiftKey ? -1 : 1)]?.cells[cell.cellIndex]?.querySelector("input,select");
      next?.focus(); if (next?.tagName === "INPUT") next.select();
    });
  });
  document.querySelectorAll("[data-wb-filter]").forEach(function (input) {
    input.addEventListener("input", function () { state.ui.filters[input.dataset.wbFilter] = input.value; wbApplyFilters(); saveState(); });
  });
  document.querySelectorAll("[data-density]").forEach(function (button) {
    button.onclick = function () { state.ui.density = button.dataset.density; saveState(); render(); };
  });
  document.querySelectorAll("[data-wb-status-filter]").forEach(function (button) {
    button.onclick = function () {
      state.ui.wrongbookFilter = button.dataset.wbStatusFilter;
      document.querySelectorAll("[data-wb-status-filter]").forEach(function (item) { item.setAttribute("aria-pressed", String(item === button)); });
      wbApplyFilters(); saveState();
    };
  });
  document.querySelectorAll("[data-wb-row-confirm],[data-wb-cell],[data-wb-score]").forEach(function (input) {
    input.addEventListener(input.tagName === "BUTTON" ? "click" : "input", wbApplyFilters);
    input.addEventListener("focusout", function () { setTimeout(wbApplyFilters, 0); });
  });
  const stickyButton = document.querySelector("[data-save-score-archive],[data-confirm-wrongbook],[data-gate-lock]");
  const sticky = stickyButton?.closest(".section-title-row,.gate-admin-toolbar");
  sticky?.classList.add("sticky-actions");
  wbEnhanceUploads();
  wbShowHistory();
  wbEmptyAndDisabled();
  wbApplyFilters();
  wbSetJobUI();
  document.querySelectorAll(".table-wrap").forEach(function (el) { el.tabIndex = 0; el.setAttribute("aria-label", "数据表格，可横向滚动"); });
}

function wbShowHistory() {
  const open = !!document.querySelector(".history-drawer")?.open;
  document.querySelectorAll("[data-view-content] .section").forEach(function (section) {
    const title = section.querySelector("h3")?.textContent || "";
    if (/^历史/.test(title)) { section.hidden = !open; section.classList.add("history-record"); }
  });
  document.querySelectorAll("[data-view-content] p.hint").forEach(function (p) {
    if (p.textContent.includes("右上角年份")) p.textContent = p.textContent.replace("右上角年份、学期、年级和课次", "上方“查看历史记录”");
  });
}

function wbEnhanceUploads() {
  document.querySelectorAll("[data-view-content] input[type=file]").forEach(function (input) {
    if (input.closest(".production-drop")) return;
    input.classList.remove("hidden"); input.classList.add("sr-file");
    const label = input.closest("label") || input.parentElement;
    if (!label || label.dataset.dropReady) return;
    label.dataset.dropReady = "true"; label.classList.add("file-drop-target");
    label.title = "点击选择文件，也可拖拽到此处";
    const status = document.createElement("span"); status.className = "upload-file-status";
    const inputKey = Array.from(input.attributes).find(function (attr) { return attr.name.startsWith("data-") && !attr.name.startsWith("data-job"); })?.name || input.name;
    const uploadRole = input.dataset.teachingUpload;
    const uploadKey = wbContextKey() + "|" + inputKey + (uploadRole ? "|" + uploadRole : "");
    status.textContent = uploadRole === 'knowledge' ? state.lesson.answerPdfName || '' : uploadRole === 'pdf' ? state.pdf.fileName || '' : wbUI().uploads[uploadKey] || "";
    label.after(status);
    ["dragenter", "dragover"].forEach(function (type) {
      label.addEventListener(type, function (event) { event.preventDefault(); if (!input.disabled) label.classList.add("drag-over"); });
    });
    ["dragleave", "drop"].forEach(function (type) { label.addEventListener(type, function () { label.classList.remove("drag-over"); }); });
    input.addEventListener("change", function () {
      if (input.files?.length) {
        status.textContent = Array.from(input.files).map(function (file) { return file.name; }).join("、");
        wbUI().uploads[uploadKey] = status.textContent;
        saveState();
      }
    }, true);
    label.addEventListener("drop", function (event) {
      event.preventDefault();
      if (input.disabled || workbench.job) return;
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) return;
      const accept = input.accept.split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
      const invalid = files.some(function (file) { return accept.length && !accept.some(function (a) { return a.startsWith(".") ? file.name.toLowerCase().endsWith(a) : (a.endsWith("/*") ? file.type.startsWith(a.slice(0, -1)) : file.type === a); }); });
      if (invalid) return toast("文件格式不支持，请按提示选择资料。", "error");
      if (!input.multiple && files.length > 1) return toast("此处一次选择一份文件，请分次导入。");
      const transfer = new DataTransfer();
      files.forEach(function (file) { transfer.items.add(file); });
      input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
}

function wbEmptyAndDisabled() {
  const reasons = [
    ["[data-ai-headers]", "请先上传学生合并 PDF，识别姓名与分数。", "pdf"],
    ["[data-start-wrongbook-ai]", "先准备题目解析和已匹配学生的卷面，再开始识别。", "knowledge"],
    ["[data-download-split]", "上传原卷并确认拆分匹配后，即可下载。", "pdf"],
    ["[data-save-score-archive]", "先保存班级名单，生成成绩表后再录入。", "setup"],
  ];
  for (const [selector, reason, next] of reasons) {
    const button = document.querySelector(selector);
    if (button?.disabled) {
      const note = document.createElement("p"); note.className = "action-explanation";
      note.innerHTML = escapeHtml(reason) + (next !== state.active ? ' <button data-nav="' + next + '">前往处理 →</button>' : "");
      button.closest(".actions,.section-title-row")?.after(note);
    }
  }
  const view = document.querySelector("[data-view-content]");
  view.querySelectorAll("section.section > p.hint:only-child").forEach(function (p) {
    if (/还没有|生成后|尚未/.test(p.textContent)) {
      p.classList.add("empty-state"); p.insertAdjacentHTML("afterbegin", '<span class="empty-symbol" aria-hidden="true">' + icons.file + '</span>');
    }
  });
}

setAiProgress = function (...args) {
  wbOriginal.setAiProgress(...args);
  const [key, current, total, status, message] = args;
  const wrap = document.querySelector('[data-ai-progress="' + key + '"]');
  if (wrap) {
    wrap.setAttribute("role", "status");
    wrap.querySelectorAll(".progress-track").forEach(function (track) {
      track.classList.toggle("indeterminate", status === "active" && (!current || total === 1));
    });
  }
};
