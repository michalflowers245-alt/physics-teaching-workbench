/* 课程关卡：资料驱动的任务生成、教师锁定与学生逐项通关。 */

const GATE_SOURCE_CHAR_LIMIT = 160000;
const GATE_FILE_CHAR_LIMIT = 55000;

function gateId(prefix) {
  const suffix = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
  return prefix + "-" + suffix;
}

function gateEnsure() {
  state.gate ||= {};
  state.gate.mode = state.gate.mode === "student" ? "student" : "admin";
  state.gate.sources = Array.isArray(state.gate.sources) ? state.gate.sources : [];
  state.gate.draftSource = String(state.gate.draftSource || "");
  state.gate.studentName = String(state.gate.studentName || "");
  state.gate.progress = state.gate.progress && typeof state.gate.progress === "object" ? state.gate.progress : {};
  state.gate.plan ||= {};
  state.gate.plan.lessons = Array.isArray(state.gate.plan.lessons) ? state.gate.plan.lessons : [];
  state.gate.plan.locked = Boolean(state.gate.plan.locked);
  state.gate.plan.lockedAt = String(state.gate.plan.lockedAt || "");
  state.gate.plan.version = Number(state.gate.plan.version || 0);
  state.gate.plan.lastValidation = Array.isArray(state.gate.plan.lastValidation) ? state.gate.plan.lastValidation : [];
  return state.gate;
}

function gatePlan() {
  return gateEnsure().plan;
}

function gateLessonHeading(lesson, index) {
  const title = String(lesson.title || "").trim() || "未命名课程";
  if (/^第\s*\d+\s*节\s*[：:]/.test(title)) return "【" + title + "】";
  return "【第" + (index + 1) + "节：" + title + "】";
}

function gateTaskTypeLabel(type) {
  return {
    knowledge: "知识点",
    exercise: "习题",
    oral: "口头问答",
    experiment: "实验操作",
    review: "错题复盘",
  }[type] || "过关项";
}

function gateTaskDescription(task) {
  if (task.type === "exercise") {
    const subject = [task.source, task.question].filter(Boolean).join(" + ") || "未填写题目";
    return subject + "（" + (task.questionType || "题型待填") + "，" + (task.threshold || "门槛待填") + "）";
  }
  return task.label || "未命名任务";
}

function gateTaskShortName(task) {
  return gateTaskTypeLabel(task.type) + "：" + gateTaskDescription(task);
}

function gateLessonById(lessonId) {
  return gatePlan().lessons.find(function (lesson) {
    return lesson.id === lessonId;
  });
}

function gateTaskById(lesson, taskId) {
  return (lesson && lesson.tasks || []).find(function (task) {
    return task.id === taskId;
  });
}

function gateTaskTemplate(type) {
  const base = {
    id: gateId("task"),
    type: type,
    label: "",
    standard: "",
    source: "",
    question: "",
    questionType: "",
    threshold: "",
  };
  if (type === "knowledge") {
    base.label = "新增知识点";
    base.standard = "能在不看资料的情况下清楚说明，并指出至少一个易错点";
  } else if (type === "exercise") {
    base.source = "资料名称";
    base.question = "题号";
    base.questionType = "选择题";
    base.threshold = "100%";
  } else if (type === "oral") {
    base.label = "口头问答";
    base.standard = "能不看资料完整口述，且回答追问时无关键错误";
  } else if (type === "experiment") {
    base.label = "实验操作";
    base.standard = "能按资料中的步骤完成，并说明现象、结论与注意事项";
  } else if (type === "review") {
    base.label = "错题复盘";
    base.standard = "能订正并写出错误原因、正确思路和避免再错的方法";
  }
  return base;
}

function gateNewLesson(index) {
  return {
    id: gateId("lesson"),
    title: "第" + (index + 1) + "节：未命名课程",
    skipLock: false,
    tasks: [gateTaskTemplate("knowledge")],
  };
}

function gateThresholdNumber(value) {
  const text = String(value || "").trim();
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number)) return null;
  if (!text.includes("%") && number >= 0 && number <= 1) return Math.round(number * 100);
  return Math.max(0, Math.min(100, number));
}

function gateHasKnownSource(citation) {
  const text = String(citation || "").trim();
  if (!text) return false;
  return gateEnsure().sources.some(function (source) {
    const name = String(source.name || "").trim();
    const baseName = name.replace(/\.[^.]+$/, "");
    return (name && text.includes(name)) || (baseName && baseName.length >= 2 && text.includes(baseName));
  });
}

function gateSourceCorpus(limit) {
  const sources = gateEnsure().sources;
  const max = Number(limit || GATE_SOURCE_CHAR_LIMIT);
  let result = "";
  for (const source of sources) {
    const block = "【资料：" + source.name + "】\n" + String(source.content || "").trim() + "\n\n";
    if (result.length + block.length > max) {
      result += block.slice(0, Math.max(0, max - result.length));
      break;
    }
    result += block;
  }
  return result.trim();
}

function gatePlanMarkdown() {
  const plan = gatePlan();
  const parts = [];
  plan.lessons.forEach(function (lesson, index) {
    const tasks = lesson.tasks || [];
    const knowledge = tasks.filter(function (task) { return task.type === "knowledge"; });
    const exercises = tasks.filter(function (task) { return task.type === "exercise"; });
    const extra = tasks.filter(function (task) { return task.type !== "knowledge" && task.type !== "exercise"; });
    parts.push(gateLessonHeading(lesson, index));
    if (lesson.skipLock) {
      parts.push("■ 本节不锁：管理员明确设置，本节不设通关门槛。");
      parts.push("■ 过关判定：本节不锁，可直接进入下一节。");
      parts.push("");
      return;
    }
    parts.push("■ 知识点过关（必须全部掌握）：");
    knowledge.forEach(function (task, taskIndex) {
      parts.push("  " + (taskIndex + 1) + ". " + (task.label || "未填写知识点") + " —— " + (task.standard || "未填写掌握标准"));
    });
    parts.push("■ 习题过关（必须全部完成且达标）：");
    exercises.forEach(function (task, taskIndex) {
      const sourceAndQuestion = [task.source, task.question].filter(Boolean).join(" + ") || "未填写题目来源和题号";
      parts.push("  " + (taskIndex + 1) + ". " + sourceAndQuestion + " —— " + (task.questionType || "未填写题型") + " —— " + (task.threshold || "未填写正确率要求"));
    });
    if (extra.length) {
      parts.push("■ 其他过关项（必须全部完成且达标）：");
      extra.forEach(function (task, taskIndex) {
        parts.push("  " + (taskIndex + 1) + ". " + gateTaskTypeLabel(task.type) + "：" + (task.label || "未填写任务") + " —— " + (task.standard || "未填写标准"));
      });
    }
    parts.push("■ 过关判定：以上知识点全部通过 + 习题全部达标 = 本节通关，解锁下一节");
    parts.push("");
  });
  if (plan.locked) parts.push("已锁定，后续严格执行。");
  return parts.join("\n").trim();
}

function gateValidationErrors() {
  const plan = gatePlan();
  const errors = [];
  if (!plan.lessons.length) {
    errors.push("至少添加一节课");
    return errors;
  }
  plan.lessons.forEach(function (lesson, lessonIndex) {
    const prefix = "第" + (lessonIndex + 1) + "节";
    if (!String(lesson.title || "").trim()) errors.push(prefix + "缺少课程名称");
    if (lesson.skipLock) return;
    const tasks = Array.isArray(lesson.tasks) ? lesson.tasks : [];
    const knowledge = tasks.filter(function (task) { return task.type === "knowledge"; });
    const exercises = tasks.filter(function (task) { return task.type === "exercise"; });
    if (!knowledge.length) errors.push(prefix + "至少需要 1 个知识点过关项");
    if (exercises.length < 3) errors.push(prefix + "习题过关项不足 3 道");
    tasks.forEach(function (task, taskIndex) {
      const taskPrefix = prefix + "第" + (taskIndex + 1) + "项";
      if (task.type === "exercise") {
        if (!String(task.source || "").trim()) errors.push(taskPrefix + "缺少题目来源");
        else if (!gateHasKnownSource(task.source)) errors.push(taskPrefix + "题目来源未对应已上传资料名称");
        if (!String(task.question || "").trim()) errors.push(taskPrefix + "缺少题号");
        if (!String(task.questionType || "").trim()) errors.push(taskPrefix + "缺少题型");
        if (gateThresholdNumber(task.threshold) === null) errors.push(taskPrefix + "缺少有效正确率门槛");
      } else {
        if (!String(task.label || "").trim()) errors.push(taskPrefix + "缺少任务名称");
        if (!String(task.standard || "").trim()) errors.push(taskPrefix + "缺少可检验标准");
        if (!String(task.source || "").trim()) errors.push(taskPrefix + "缺少资料来源标注");
        else if (!gateHasKnownSource(task.source)) errors.push(taskPrefix + "资料来源未对应已上传资料名称");
      }
    });
  });
  return errors;
}

function gateMarkPlanEdited() {
  const gate = gateEnsure();
  if (!gate.plan.locked) return;
  gate.plan.locked = false;
  gate.plan.lockedAt = "";
  gate.plan.lastValidation = ["管理员已修改锁定内容，需重新锁定后才会对学生生效。"];
  gate.progress = {};
  toast("管理员已修改任务，已解除锁定并清空学生进度，请重新锁定");
}

function gateProgressKey() {
  const grade = currentGrade();
  const student = String(gateEnsure().studentName || "").trim();
  return (grade && grade.id || "default") + "::" + student;
}

function gateStudentProgress(create) {
  const gate = gateEnsure();
  const key = gateProgressKey();
  if (!key.endsWith("::") && create && !gate.progress[key]) gate.progress[key] = {};
  return gate.progress[key] || {};
}

function gateLessonPassed(lesson, progress) {
  if (lesson.skipLock) return true;
  const tasks = lesson.tasks || [];
  if (!tasks.length) return false;
  const record = progress[lesson.id] || {};
  return tasks.every(function (task) {
    return record[task.id] && record[task.id].status === "passed";
  });
}

function gateCurrentLesson(progress) {
  return gatePlan().lessons.find(function (lesson) {
    return !gateLessonPassed(lesson, progress);
  }) || null;
}

function gateMissingTasks(lesson, progress) {
  const record = progress[lesson.id] || {};
  return (lesson.tasks || [])
    .filter(function (task) {
      return !(record[task.id] && record[task.id].status === "passed");
    })
    .map(gateTaskShortName);
}

function gateBlockedMessage(lesson, progress) {
  const missing = gateMissingTasks(lesson, progress);
  return "本节课过关任务尚未完成，还差：" + (missing.join("、") || "全部过关项") + "。请完成全部要求后再继续，无法直接进入下一课。";
}

function gateAdminView() {
  const gate = gateEnsure();
  const plan = gate.plan;
  const validation = plan.lastValidation || [];
  return [
    '<section class="section gate-intro">',
    '<div class="section-title-row"><div><h3>课程关卡过关任务</h3><p class="hint">上传试卷、教学大纲或讲义后自动生成初版。任务只能引用已上传资料；锁定后，学生必须逐项达标才能进入下一课。</p></div>',
    '<span class="status-pill ' + (plan.locked ? "good" : "warn") + '">' + (plan.locked ? "已锁定" : "未锁定") + '</span></div>',
    '<div class="gate-mode-tabs"><button type="button" class="' + (gate.mode === "admin" ? "active" : "") + '" data-gate-mode="admin">管理员任务</button><button type="button" class="' + (gate.mode === "student" ? "active" : "") + '" data-gate-mode="student">学生执行</button></div>',
    '</section>',
    '<section class="section">',
    '<div class="section-title-row"><div><h3>1. 上传或粘贴课程资料</h3><p class="hint">支持 PDF、图片、TXT、Markdown、CSV、DOCX。上传后会自动读取并生成初版；旧版 DOC 请另存为 PDF 或 DOCX。</p></div></div>',
    '<div class="gate-upload-row"><label class="secondary gate-upload-button">选择资料<input type="file" data-gate-source-files multiple accept=".pdf,.txt,.md,.csv,.docx,.doc,image/*"></label>',
    '<button type="button" class="secondary" data-gate-generate ' + (!gate.sources.length ? "disabled" : "") + '>根据当前资料重新生成</button></div>',
    '<div class="field"><label>或直接粘贴资料内容</label><textarea data-gate-draft-source placeholder="粘贴试卷、教学大纲、讲义或答案要点。请保留课程名称、题号和题目内容。">' + escapeHtml(gate.draftSource) + '</textarea></div>',
    '<div class="actions"><button type="button" class="primary" data-gate-add-text>保存文本并生成初版</button></div>',
    gateSourceListView(gate.sources),
    aiProgressView("gate", "课程关卡生成"),
    '</section>',
    '<section class="section">',
    '<div class="section-title-row"><div><h3>2. 编辑过关任务</h3><p class="hint">管理员可以增删改任务、调整正确率门槛，或明确将某节设为“不锁”。锁定后的修改会自动解除锁定，需重新锁定。</p></div>',
    '<div class="actions gate-actions"><button type="button" class="secondary" data-gate-add-lesson>新增一节课</button><button type="button" class="secondary" data-gate-export ' + (!plan.lessons.length ? "disabled" : "") + '>导出任务清单</button><button type="button" class="primary" data-gate-lock ' + (!plan.lessons.length ? "disabled" : "") + '>' + (plan.locked ? "重新锁定任务" : "确认并锁定任务") + '</button></div></div>',
    validation.length ? '<div class="gate-alert"><strong>锁定前还需补齐：</strong>' + escapeHtml(validation.slice(0, 8).join("；")) + (validation.length > 8 ? "；其余 " + (validation.length - 8) + " 项" : "") + '</div>' : "",
    plan.locked ? '<div class="gate-locked-note">已锁定，后续严格执行。学生端将按全部任务逐项核验。</div>' : "",
    plan.lessons.length ? plan.lessons.map(gateLessonEditorView).join("") : '<p class="hint gate-empty">还没有课程任务。上传资料后会自动生成，也可以手动新增一节课。</p>',
    '</section>',
  ].join("");
}

function gateSourceListView(sources) {
  if (!sources.length) return '<p class="hint gate-empty">尚未添加资料。资料将作为生成和判定的唯一依据。</p>';
  return '<div class="gate-source-list">' + sources.map(function (source) {
    const size = String(source.content || "").length;
    return '<article class="gate-source"><div><strong>' + escapeHtml(source.name) + '</strong><p>' + escapeHtml(source.kind || "文本") + " · " + size + ' 字</p></div><button type="button" class="icon-text" data-gate-delete-source="' + escapeAttr(source.id) + '">移除</button></article>';
  }).join("") + '</div>';
}

function gateLessonEditorView(lesson, lessonIndex) {
  const tasks = lesson.tasks || [];
  const title = "第" + (lessonIndex + 1) + "节";
  return [
    '<article class="gate-lesson-editor" data-gate-lesson-card="' + escapeAttr(lesson.id) + '">',
    '<div class="gate-lesson-head"><div class="field"><label>' + title + '：课程名称</label><input data-gate-lesson-title="' + escapeAttr(lesson.id) + '" value="' + escapeAttr(lesson.title || "") + '"></div>',
    '<div class="gate-lesson-controls"><label class="gate-check"><input type="checkbox" data-gate-skip-lock="' + escapeAttr(lesson.id) + '" ' + (lesson.skipLock ? "checked" : "") + '> 这节不锁</label><button type="button" class="icon-text danger-text" data-gate-delete-lesson="' + escapeAttr(lesson.id) + '">删除本节</button></div></div>',
    lesson.skipLock ? '<p class="gate-skip-note">本节已由管理员明确设为“不锁”，学生可以直接进入下一节；本节任务不作为通关条件。</p>' : '<p class="hint">知识点和习题都必须标明资料来源。每节至少 1 个知识点、3 道习题才可锁定。</p>',
    '<div class="gate-task-list">' + tasks.map(function (task, taskIndex) { return gateTaskEditorView(lesson.id, task, taskIndex); }).join("") + '</div>',
    '<div class="gate-add-task"><span>新增过关项：</span><button type="button" class="ghost" data-gate-add-task="' + escapeAttr(lesson.id) + '" data-gate-task-type="knowledge">知识点</button><button type="button" class="ghost" data-gate-add-task="' + escapeAttr(lesson.id) + '" data-gate-task-type="exercise">习题</button><button type="button" class="ghost" data-gate-add-task="' + escapeAttr(lesson.id) + '" data-gate-task-type="oral">口头问答</button><button type="button" class="ghost" data-gate-add-task="' + escapeAttr(lesson.id) + '" data-gate-task-type="experiment">实验操作</button><button type="button" class="ghost" data-gate-add-task="' + escapeAttr(lesson.id) + '" data-gate-task-type="review">错题复盘</button></div>',
    '</article>',
  ].join("");
}

function gateTaskEditorView(lessonId, task, taskIndex) {
  const prefix = "第" + (taskIndex + 1) + "项 · " + gateTaskTypeLabel(task.type);
  let fields = "";
  if (task.type === "exercise") {
    fields = [
      '<div class="grid three">',
      '<div class="field"><label>题目来源</label><input data-gate-task-field="source" data-gate-lesson-id="' + escapeAttr(lessonId) + '" data-gate-task-id="' + escapeAttr(task.id) + '" value="' + escapeAttr(task.source || "") + '" placeholder="如：试卷 A"></div>',
      '<div class="field"><label>题号</label><input data-gate-task-field="question" data-gate-lesson-id="' + escapeAttr(lessonId) + '" data-gate-task-id="' + escapeAttr(task.id) + '" value="' + escapeAttr(task.question || "") + '" placeholder="如：第 3 题"></div>',
      '<div class="field"><label>题型</label><input data-gate-task-field="questionType" data-gate-lesson-id="' + escapeAttr(lessonId) + '" data-gate-task-id="' + escapeAttr(task.id) + '" value="' + escapeAttr(task.questionType || "") + '" placeholder="选择 / 填空 / 计算 / 实验"></div>',
      '</div>',
      '<div class="field"><label>正确率要求</label><input data-gate-task-field="threshold" data-gate-lesson-id="' + escapeAttr(lessonId) + '" data-gate-task-id="' + escapeAttr(task.id) + '" value="' + escapeAttr(task.threshold || "") + '" placeholder="如：100%"></div>',
    ].join("");
  } else {
    fields = [
      '<div class="grid two">',
      '<div class="field"><label>任务名称</label><input data-gate-task-field="label" data-gate-lesson-id="' + escapeAttr(lessonId) + '" data-gate-task-id="' + escapeAttr(task.id) + '" value="' + escapeAttr(task.label || "") + '" placeholder="如：能区分质量与重力"></div>',
      '<div class="field"><label>资料来源</label><input data-gate-task-field="source" data-gate-lesson-id="' + escapeAttr(lessonId) + '" data-gate-task-id="' + escapeAttr(task.id) + '" value="' + escapeAttr(task.source || "") + '" placeholder="如：讲义第 2 页"></div>',
      '</div>',
      '<div class="field"><label>可检验的掌握标准</label><textarea data-gate-task-field="standard" data-gate-lesson-id="' + escapeAttr(lessonId) + '" data-gate-task-id="' + escapeAttr(task.id) + '" placeholder="写清楚学生要能复述、区分、推导、识别易错点或完成操作的具体要求。">' + escapeHtml(task.standard || "") + '</textarea></div>',
    ].join("");
  }
  return [
    '<article class="gate-task-editor">',
    '<div class="gate-task-head"><strong>' + escapeHtml(prefix) + '</strong><button type="button" class="icon-text danger-text" data-gate-delete-task="' + escapeAttr(task.id) + '" data-gate-lesson-id="' + escapeAttr(lessonId) + '">删除</button></div>',
    fields,
    '</article>',
  ].join("");
}

function gateStudentView() {
  const gate = gateEnsure();
  const plan = gate.plan;
  const roster = currentGrade() && currentGrade().students || [];
  const selected = String(gate.studentName || "").trim();
  const options = ['<option value="">选择学生</option>'].concat(roster.map(function (name) {
    return '<option value="' + escapeAttr(name) + '" ' + (name === selected ? "selected" : "") + '>' + escapeHtml(name) + '</option>';
  })).join("");
  let body = "";
  if (!plan.locked) {
    body = '<section class="section"><h3>学生端暂未开放</h3><p class="hint">管理员需要先完成任务编辑并点击“确认并锁定任务”。锁定后，学生只能按顺序完成当前课的全部任务。</p></section>';
  } else if (!selected) {
    body = '<section class="section"><h3>选择学生后开始</h3><p class="hint">选择当前学生，系统会分别保存其通关进度。没有名单时也可以手动填入学生姓名。</p></section>';
  } else {
    body = gateStudentExecutionView(selected);
  }
  return [
    '<section class="section gate-intro">',
    '<div class="section-title-row"><div><h3>学生端：课程通关</h3><p class="hint">仅显示当前可执行的课程；未达标的题目订正后必须重新提交。</p></div><span class="status-pill ' + (plan.locked ? "good" : "warn") + '">' + (plan.locked ? "锁课执行中" : "待管理员锁定") + '</span></div>',
    '<div class="gate-mode-tabs"><button type="button" class="' + (gate.mode === "admin" ? "active" : "") + '" data-gate-mode="admin">管理员任务</button><button type="button" class="' + (gate.mode === "student" ? "active" : "") + '" data-gate-mode="student">学生执行</button></div>',
    '<div class="gate-student-picker"><div class="field"><label>当前学生</label><select data-gate-student-select>' + options + '</select></div><div class="field"><label>或手动填写学生姓名</label><input data-gate-student-custom value="' + escapeAttr(selected) + '" placeholder="用于本机保存该学生进度"></div><button type="button" class="secondary" data-gate-use-student>切换学生</button></div>',
    '</section>',
    body,
  ].join("");
}

function gateStudentExecutionView(studentName) {
  const plan = gatePlan();
  const progress = gateStudentProgress(true);
  const current = gateCurrentLesson(progress);
  const allPassed = !current;
  return [
    '<section class="section gate-student-summary">',
    '<h3>' + escapeHtml(studentName) + '的通关进度</h3>',
    '<p class="' + (allPassed ? "gate-pass-message" : "gate-block-message") + '">' + (allPassed ? "全部课程关卡已通过，课程任务完成。" : escapeHtml(gateBlockedMessage(current, progress))) + '</p>',
    '</section>',
    '<section class="section gate-student-lessons">',
    plan.lessons.map(function (lesson, index) {
      const passed = gateLessonPassed(lesson, progress);
      const isCurrent = current && lesson.id === current.id;
      const status = lesson.skipLock ? "本节不锁" : (passed ? "已通关" : (isCurrent ? "当前关卡" : "未解锁"));
      const cls = lesson.skipLock || passed ? "good" : (isCurrent ? "warn" : "");
      let detail = "";
      if (isCurrent) detail = gateStudentLessonPanel(lesson, progress);
      else if (!passed && !lesson.skipLock) detail = '<p class="hint">请先完成上一节课的全部过关任务。</p>';
      else if (passed && !lesson.skipLock) detail = '<p class="hint">本节全部任务已通过。</p>';
      else if (lesson.skipLock) detail = '<p class="hint">管理员已明确设置本节不锁，可直接进入下一节。</p>';
      return '<article class="gate-student-lesson ' + (isCurrent ? "current" : "") + '"><div class="gate-lesson-status"><strong>' + escapeHtml(gateLessonHeading(lesson, index).replace(/[【】]/g, "")) + '</strong><span class="status-pill ' + cls + '">' + status + '</span></div>' + detail + '</article>';
    }).join(""),
    '</section>',
  ].join("");
}

function gateStudentLessonPanel(lesson, progress) {
  const record = progress[lesson.id] || {};
  return [
    '<div class="gate-student-task-list">',
    (lesson.tasks || []).map(function (task, index) {
      const taskRecord = record[task.id] || {};
      const status = taskRecord.status || "pending";
      const label = status === "passed" ? "已通过" : (status === "checking" ? "核验中" : (status === "failed" ? "未达标，需订正" : "待提交"));
      const cls = status === "passed" ? "good" : (status === "failed" ? "bad" : "warn");
      const description = task.type === "exercise"
        ? "题目：" + (task.source || "未填写来源") + " + " + (task.question || "未填写题号") + "；题型：" + (task.questionType || "未填写") + "；正确率要求：" + (task.threshold || "未填写")
        : "资料来源：" + (task.source || "未填写") + "；掌握标准：" + (task.standard || "未填写");
      const evidence = taskRecord.evidence || "";
      return [
        '<article class="gate-student-task">',
        '<div class="gate-task-head"><div><strong>' + (index + 1) + ". " + escapeHtml(gateTaskTypeLabel(task.type) + "：" + (task.type === "exercise" ? gateTaskDescription(task) : task.label || "未命名任务")) + '</strong><p class="hint">' + escapeHtml(description) + '</p></div><span class="status-pill ' + cls + '">' + label + '</span></div>',
        taskRecord.feedback ? '<p class="gate-task-feedback">' + escapeHtml(taskRecord.feedback) + '</p>' : "",
        status === "passed" ? '<p class="gate-task-passed">已核验通过。</p>' : '<div class="field"><label>提交你的答案、过程、口述记录或订正说明</label><textarea data-gate-evidence="' + escapeAttr(task.id) + '" data-gate-lesson-id="' + escapeAttr(lesson.id) + '" placeholder="请写清楚你的作答或完成情况；系统会按任务标准严格核验。">' + escapeHtml(evidence) + '</textarea></div><div class="actions"><button type="button" class="primary" data-gate-verify="' + escapeAttr(task.id) + '" data-gate-lesson-id="' + escapeAttr(lesson.id) + '" ' + (status === "checking" ? "disabled" : "") + '>' + (status === "checking" ? "正在核验…" : "提交核验") + '</button></div>',
        '</article>',
      ].join("");
    }).join(""),
    '</div>',
  ].join("");
}

function gateView() {
  gateEnsure();
  return '<div class="gate-view">' + (state.gate.mode === "student" ? gateStudentView() : gateAdminView()) + '</div>';
}

function bindGate() {
  gateEnsure();
  document.querySelectorAll("[data-gate-mode]").forEach(function (button) {
    button.addEventListener("click", function () {
      state.gate.mode = button.dataset.gateMode;
      saveState();
      render();
    });
  });
  document.querySelectorAll("[data-gate-source-files]").forEach(function (input) {
    input.addEventListener("change", async function () {
      const files = Array.from(input.files || []);
      input.value = "";
      if (!files.length) return;
      await gateIngestFiles(files);
    });
  });
  document.querySelectorAll("[data-gate-draft-source]").forEach(function (textarea) {
    textarea.addEventListener("input", function () {
      state.gate.draftSource = textarea.value;
      saveState();
    });
  });
  document.querySelectorAll("[data-gate-add-text]").forEach(function (button) {
    button.addEventListener("click", async function () {
      const text = String(state.gate.draftSource || "").trim();
      if (!text) return toast("请先粘贴资料内容");
      gateMarkPlanEdited();
      state.gate.sources.push({
        id: gateId("source"),
        name: "手动粘贴资料",
        kind: "文本",
        content: text.slice(0, GATE_FILE_CHAR_LIMIT),
        addedAt: new Date().toISOString(),
      });
      state.gate.draftSource = "";
      saveState();
      render();
      await gateGeneratePlan();
    });
  });
  document.querySelectorAll("[data-gate-delete-source]").forEach(function (button) {
    button.addEventListener("click", function () {
      gateMarkPlanEdited();
      state.gate.sources = state.gate.sources.filter(function (source) {
        return source.id !== button.dataset.gateDeleteSource;
      });
      saveState();
      render();
    });
  });
  document.querySelectorAll("[data-gate-generate]").forEach(function (button) {
    button.addEventListener("click", async function () {
      if (button.disabled || !state.gate.sources.length) return;
      await gateGeneratePlan();
    });
  });
  document.querySelectorAll("[data-gate-add-lesson]").forEach(function (button) {
    button.addEventListener("click", function () {
      gateMarkPlanEdited();
      gatePlan().lessons.push(gateNewLesson(gatePlan().lessons.length));
      saveState();
      render();
    });
  });
  document.querySelectorAll("[data-gate-delete-lesson]").forEach(function (button) {
    button.addEventListener("click", function () {
      gateMarkPlanEdited();
      gatePlan().lessons = gatePlan().lessons.filter(function (lesson) {
        return lesson.id !== button.dataset.gateDeleteLesson;
      });
      saveState();
      render();
    });
  });
  document.querySelectorAll("[data-gate-lesson-title]").forEach(function (input) {
    input.addEventListener("input", function () {
      gateMarkPlanEdited();
      const lesson = gateLessonById(input.dataset.gateLessonTitle);
      if (lesson) lesson.title = input.value;
      saveState();
    });
  });
  document.querySelectorAll("[data-gate-skip-lock]").forEach(function (input) {
    input.addEventListener("change", function () {
      gateMarkPlanEdited();
      const lesson = gateLessonById(input.dataset.gateSkipLock);
      if (lesson) lesson.skipLock = input.checked;
      saveState();
      render();
    });
  });
  document.querySelectorAll("[data-gate-add-task]").forEach(function (button) {
    button.addEventListener("click", function () {
      gateMarkPlanEdited();
      const lesson = gateLessonById(button.dataset.gateAddTask);
      if (lesson) lesson.tasks.push(gateTaskTemplate(button.dataset.gateTaskType));
      saveState();
      render();
    });
  });
  document.querySelectorAll("[data-gate-delete-task]").forEach(function (button) {
    button.addEventListener("click", function () {
      gateMarkPlanEdited();
      const lesson = gateLessonById(button.dataset.gateLessonId);
      if (lesson) lesson.tasks = lesson.tasks.filter(function (task) {
        return task.id !== button.dataset.gateDeleteTask;
      });
      saveState();
      render();
    });
  });
  document.querySelectorAll("[data-gate-task-field]").forEach(function (input) {
    input.addEventListener("input", function () {
      gateMarkPlanEdited();
      const lesson = gateLessonById(input.dataset.gateLessonId);
      const task = gateTaskById(lesson, input.dataset.gateTaskId);
      if (task) task[input.dataset.gateTaskField] = input.value;
      saveState();
    });
  });
  document.querySelectorAll("[data-gate-lock]").forEach(function (button) {
    button.addEventListener("click", function () {
      gateLockPlan();
    });
  });
  document.querySelectorAll("[data-gate-export]").forEach(function (button) {
    button.addEventListener("click", function () {
      downloadText("课程关卡过关任务.md", gatePlanMarkdown(), "text/markdown;charset=utf-8");
      toast("任务清单已导出");
    });
  });
  document.querySelectorAll("[data-gate-student-select]").forEach(function (select) {
    select.addEventListener("change", function () {
      state.gate.studentName = select.value;
      saveState();
      render();
    });
  });
  document.querySelectorAll("[data-gate-use-student]").forEach(function (button) {
    button.addEventListener("click", function () {
      const input = document.querySelector("[data-gate-student-custom]");
      const value = String(input && input.value || "").trim();
      if (!value) return toast("请先填写学生姓名");
      state.gate.studentName = value;
      saveState();
      render();
    });
  });
  document.querySelectorAll("[data-gate-verify]").forEach(function (button) {
    button.addEventListener("click", async function () {
      await gateVerifyTask(button.dataset.gateLessonId, button.dataset.gateVerify);
    });
  });
}

function gateLockPlan() {
  const gate = gateEnsure();
  const errors = gateValidationErrors();
  gate.plan.lastValidation = errors;
  if (errors.length) {
    saveState();
    render();
    toast("暂不能锁定：" + errors.slice(0, 2).join("；"));
    return;
  }
  gate.plan.locked = true;
  gate.plan.lockedAt = new Date().toISOString();
  gate.plan.version = Number(gate.plan.version || 0) + 1;
  gate.plan.lastValidation = [];
  gate.progress = {};
  saveState();
  render();
  toast("已锁定，后续严格执行");
}

async function gateIngestFiles(files) {
  const gate = gateEnsure();
  gateMarkPlanEdited();
  const accepted = [];
  let failures = 0;
  setAiProgress("gate", 0, files.length, "active", "正在读取资料");
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    setAiProgress("gate", index, files.length, "active", "读取 " + file.name);
    try {
      const content = await gateReadFile(file);
      if (String(content || "").trim().length < 20) throw new Error("资料内容过短，未读取到可用文字");
      accepted.push({
        id: gateId("source"),
        name: file.name,
        kind: gateFileKind(file),
        content: String(content).slice(0, GATE_FILE_CHAR_LIMIT),
        addedAt: new Date().toISOString(),
      });
    } catch (error) {
      failures += 1;
      toast(file.name + " 未导入：" + String(error && error.message || error));
    }
  }
  gate.sources = gate.sources.concat(accepted).slice(-12);
  if (!accepted.length) {
    setAiProgress("gate", 0, files.length, "failed", "未读取到可用资料");
    saveState();
    render();
    return;
  }
  setAiProgress("gate", accepted.length, files.length, "active", "资料读取完成，准备生成");
  saveState();
  render();
  if (failures) toast("已读取 " + accepted.length + " 份资料，另有 " + failures + " 份未能读取");
  await gateGeneratePlan();
}

function gateFileKind(file) {
  const name = String(file.name || "").toLowerCase();
  if (file.type.startsWith("image/")) return "图片";
  if (name.endsWith(".pdf")) return "PDF";
  if (name.endsWith(".docx")) return "DOCX";
  return "文本";
}

async function gateReadFile(file) {
  const name = String(file.name || "").toLowerCase();
  if (file.type.startsWith("image/")) {
    const image = await gateReadAsDataUrl(file);
    return await callVisionModel("请逐字提取这张教学资料中的文字、题号、题目和课程标题。不要补充、解释或编造内容；仅输出可读的原始文字。", image);
  }
  if (name.endsWith(".pdf")) return await gateReadPdf(file);
  if (name.endsWith(".docx")) return await gateReadDocx(file);
  if (name.endsWith(".doc")) throw new Error("旧版 DOC 请另存为 PDF 或 DOCX 后上传");
  return await file.text();
}

function gateReadAsDataUrl(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result || "")); };
    reader.onerror = function () { reject(new Error("图片读取失败")); };
    reader.readAsDataURL(file);
  });
}

async function gateReadPdf(file) {
  if (!window.pdfjsLib) throw new Error("PDF 识别库尚未加载，请稍后重试");
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({isEvalSupported:false, data: data });
  const pdf = await task.promise;
  const parts = [];
  const pageCount = Math.min(pdf.numPages, 30);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent();
    parts.push("【第" + pageNumber + "页】\n" + text.items.map(function (item) { return item.str; }).join(" "));
  }
  const result = parts.join("\n").trim();
  if (result.length >= 80) return result;
  const scanParts = [];
  const scanPageCount = Math.min(pdf.numPages, 8);
  for (let pageNumber = 1; pageNumber <= scanPageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d", { alpha: false });
    await page.render({ canvasContext: context, viewport: viewport }).promise;
    const image = canvas.toDataURL("image/jpeg", 0.88);
    const text = await callVisionModel("请逐字提取这页教学 PDF 扫描件中的文字、题号、题目和课程标题。不要补充、解释或编造内容；仅输出可读的原始文字。", image);
    scanParts.push("【第" + pageNumber + "页扫描识别】\n" + text);
  }
  const scanned = scanParts.join("\n").trim();
  if (scanned.length < 20) throw new Error("PDF 未读取到可用文字，请检查文件是否清晰");
  return scanned;
}

async function gateReadDocx(file) {
  if (!window.JSZip) throw new Error("DOCX 读取库尚未加载，请稍后重试");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const item = zip.file("word/document.xml");
  if (!item) throw new Error("未找到 DOCX 正文");
  const xml = await item.async("string");
  return xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function gateGenerationPrompt() {
  return [
    "你是张老师物理课程的关卡任务生成器。只能依据下方提供的资料，不得补充资料中没有的知识点、题目、题号、实验或结论。",
    "请识别资料里的每一节课、课程标题、知识点和原题，并输出严格 JSON，不要 Markdown 或任何解释。",
    "JSON 格式：",
    '{"lessons":[{"title":"课程名称","knowledge":[{"label":"知识点名称","standard":"可检验的掌握标准，必须包含能复述/能区分/能推导/能识别易错点等具体动作","source":"资料名称+页码或章节"}],"exercises":[{"source":"资料名称+页码或章节","question":"题号","questionType":"选择/填空/计算/实验等","threshold":"100%"}],"extra":[{"type":"oral|experiment|review","label":"任务名称","standard":"可检验标准","source":"资料名称+页码或章节"}]}],"notes":"若某节资料中不足 3 道可引用习题，明确写出原因，不可编造题目"}',
    "规则：每节课优先列出所有已给出的知识点和原题；每节习题默认不少于 3 道，但资料没有足够原题时宁可少列，并在 notes 说明。每个任务必须有资料来源，且 source 必须以资料区块中“资料：”后的原始名称（或去掉扩展名的名称）开头，再写页码或章节。不要把答案、讲解或额外题目当作新的课程内容。",
    "资料如下：",
    gateSourceCorpus(GATE_SOURCE_CHAR_LIMIT),
  ].join("\n\n");
}

function gateNormalizePlan(raw) {
  const rawLessons = Array.isArray(raw && raw.lessons) ? raw.lessons : [];
  return rawLessons.map(function (item, index) {
    const knowledgeItems = item.knowledge || item.knowledgePoints || [];
    const exerciseItems = item.exercises || item.questions || [];
    const extraItems = item.extra || item.extraTasks || [];
    const tasks = [];
    (Array.isArray(knowledgeItems) ? knowledgeItems : []).forEach(function (task) {
      tasks.push({
        id: gateId("task"),
        type: "knowledge",
        label: String(task.label || task.name || task.title || "").trim(),
        standard: String(task.standard || task.mastery || task.requirement || "").trim(),
        source: String(task.source || task.citation || "").trim(),
        question: "",
        questionType: "",
        threshold: "",
      });
    });
    (Array.isArray(exerciseItems) ? exerciseItems : []).forEach(function (task) {
      tasks.push({
        id: gateId("task"),
        type: "exercise",
        label: "",
        standard: "",
        source: String(task.source || task.citation || "").trim(),
        question: String(task.question || task.number || task.questionNo || "").trim(),
        questionType: String(task.questionType || task.type || "").trim(),
        threshold: String(task.threshold || task.accuracy || "100%").trim(),
      });
    });
    (Array.isArray(extraItems) ? extraItems : []).forEach(function (task) {
      const type = ["oral", "experiment", "review"].includes(task.type) ? task.type : "oral";
      tasks.push({
        id: gateId("task"),
        type: type,
        label: String(task.label || task.name || "").trim(),
        standard: String(task.standard || task.mastery || task.requirement || "").trim(),
        source: String(task.source || task.citation || "").trim(),
        question: "",
        questionType: "",
        threshold: "",
      });
    });
    return {
      id: gateId("lesson"),
      title: String(item.title || item.name || "第" + (index + 1) + "节：未命名课程").trim(),
      skipLock: false,
      tasks: tasks,
    };
  });
}

async function gateGeneratePlan() {
  const gate = gateEnsure();
  if (!gate.sources.length) return toast("请先添加至少一份资料");
  setAiProgress("gate", 0, 1, "active", "正在按资料生成初版任务");
  saveState();
  render();
  try {
    const result = await callVisionModel(gateGenerationPrompt());
    const parsed = parseModelJson(result);
    const lessons = gateNormalizePlan(parsed);
    if (!lessons.length) throw new Error("模型没有识别到课程结构，请检查资料或手动新增课程");
    gate.plan = {
      lessons: lessons,
      locked: false,
      lockedAt: "",
      version: Number(gate.plan.version || 0),
      lastValidation: [],
    };
    gate.progress = {};
    setAiProgress("gate", 1, 1, "done", "初版已生成，可编辑后锁定");
    saveState();
    render();
    toast("初版过关任务已生成，请检查后锁定");
  } catch (error) {
    setAiProgress("gate", 0, 1, "failed", progressErrorMessage(error));
    saveState();
    render();
    toast("初版生成失败：" + progressErrorMessage(error));
  }
}

function gateVerificationPrompt(lesson, task, evidence) {
  const threshold = task.type === "exercise" ? gateThresholdNumber(task.threshold) : null;
  return [
    "你是严格的学生关卡核验器。只能依据下方课程资料和锁定任务判定，绝不能降低标准、默认放行或补充资料外内容。",
    "学生必须完成全部要求。若答案、过程、订正或口述记录不足以证明达标，或资料无法支持判定，result 必须为 fail。",
    "对习题：判断学生提交是否完成题目并按资料核验；correctRate 必须给 0 到 100 的数字。若正确率低于门槛，result 必须为 fail，要求订正后重新提交。",
    "只返回 JSON：",
    '{"result":"pass 或 fail","reason":"简短明确的判定原因和下一步","correctRate":0}',
    "锁定任务：",
    "课程：" + lesson.title,
    "任务类型：" + gateTaskTypeLabel(task.type),
    "任务：" + gateTaskDescription(task),
    "资料来源：" + (task.source || "未填写"),
    "标准：" + (task.type === "exercise" ? "正确率要求 " + (task.threshold || "未填写") + "；题型 " + (task.questionType || "未填写") : task.standard || "未填写"),
    "习题门槛：" + (threshold === null ? "不适用" : threshold + "%"),
    "学生提交：",
    evidence,
    "资料：",
    gateSourceCorpus(60000),
  ].join("\n\n");
}

function gateNormalizeRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number >= 0 && number <= 1 ? Math.round(number * 100) : Math.max(0, Math.min(100, number));
}

async function gateVerifyTask(lessonId, taskId) {
  const gate = gateEnsure();
  const plan = gate.plan;
  if (!plan.locked) return toast("任务尚未锁定，学生端不能执行");
  const lesson = gateLessonById(lessonId);
  const task = gateTaskById(lesson, taskId);
  const progress = gateStudentProgress(true);
  if (!lesson || !task || !gate.studentName) return toast("未找到当前任务或学生");
  if (gateCurrentLesson(progress) && gateCurrentLesson(progress).id !== lesson.id) return toast("请先完成当前课程关卡，无法直接进入下一课");
  const evidenceInput = document.querySelector('[data-gate-evidence="' + CSS.escape(taskId) + '"][data-gate-lesson-id="' + CSS.escape(lessonId) + '"]');
  const evidence = String(evidenceInput && evidenceInput.value || "").trim();
  if (!evidence) return toast("请先填写答案、过程或订正说明");
  progress[lessonId] ||= {};
  progress[lessonId][taskId] = {
    status: "checking",
    evidence: evidence,
    feedback: "",
    attempts: Number(progress[lessonId][taskId] && progress[lessonId][taskId].attempts || 0) + 1,
    correctRate: null,
    updatedAt: new Date().toISOString(),
  };
  setAiProgress("gate", 0, 1, "active", "正在核验 " + gateTaskTypeLabel(task.type));
  saveState();
  render();
  try {
    const result = await callVisionModel(gateVerificationPrompt(lesson, task, evidence));
    const parsed = parseModelJson(result) || {};
    const rawResult = String(parsed.result || "").toLowerCase();
    const rate = gateNormalizeRate(parsed.correctRate);
    const threshold = task.type === "exercise" ? gateThresholdNumber(task.threshold) : null;
    let passed = rawResult === "pass" || rawResult === "passed" || rawResult === "通过";
    let feedback = String(parsed.reason || "").trim() || "未提供明确判定理由";
    if (task.type === "exercise" && (rate === null || threshold === null || rate < threshold)) {
      passed = false;
      const rateText = rate === null ? "未给出有效正确率" : "正确率 " + rate + "%";
      feedback = feedback + "；" + rateText + "，未达到 " + (task.threshold || "设定") + " 的门槛，请订正后重新提交。";
    }
    if (rawResult !== "pass" && rawResult !== "passed" && rawResult !== "通过") passed = false;
    progress[lessonId][taskId] = {
      status: passed ? "passed" : "failed",
      evidence: evidence,
      feedback: feedback,
      attempts: Number(progress[lessonId][taskId].attempts || 1),
      correctRate: rate,
      updatedAt: new Date().toISOString(),
    };
    setAiProgress("gate", 1, 1, "done", passed ? "任务已通过" : "未达标，需订正");
    saveState();
    const completed = gateLessonPassed(lesson, progress);
    render();
    toast(completed ? "本节通关，已解锁下一节" : (passed ? "本项已通过，继续完成其余任务" : "本项未达标，请订正后重新提交"));
  } catch (error) {
    progress[lessonId][taskId] = {
      status: "failed",
      evidence: evidence,
      feedback: "核验失败：" + progressErrorMessage(error) + "。请稍后重新提交。",
      attempts: Number(progress[lessonId][taskId].attempts || 1),
      correctRate: null,
      updatedAt: new Date().toISOString(),
    };
    setAiProgress("gate", 0, 1, "failed", progressErrorMessage(error));
    saveState();
    render();
    toast("核验失败，请稍后重新提交");
  }
}
