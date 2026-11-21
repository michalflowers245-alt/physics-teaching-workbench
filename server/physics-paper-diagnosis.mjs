import { randomUUID } from "node:crypto";
import { confirmationCurrent, fingerprint } from "../shared/domain.mjs";
import ExamDomain from "../exam-engine/exam-domain.js";
import StudentQuestionSets from "../exam-engine/student-question-set.js";
import { AppError } from "./store.mjs";

const clean = (value) => String(value ?? "").trim();
const tag = (value) => clean(value) && !/^(无|未知|待确认|待标注|待核验|待补充)$/.test(clean(value)) ? clean(value) : "";

export function paperContext(record, sessionId) {
  const state = record.state;
  const session = state.sessions?.[sessionId || state.sessionId];
  if (sessionId && !session) throw new AppError("找不到指定课次", 404);
  const lesson = session?.lesson || state.lesson || {};
  const grade = state.grades?.find(({ id }) => id === lesson.gradeId);
  const knowledge = confirmationCurrent(session || {}, "knowledge") ? session.confirmations.knowledge.snapshot : {};
  const confirmation = session?.confirmations?.wrongbook;
  const paperIdentity = fingerprint({
    sessionId: session?.id, materialId: session?.pdf?.materialId || "",
    answerMaterialId: state.ui?.answerMaterialId?.[session?.id] || "", questionSpec: lesson.questionSpec || "",
    answers: Object.fromEntries(Object.entries(knowledge).map(([number, item]) => [number, clean(item?.answer ?? item)])),
  });
  const book = { sessionId: session?.id || "", classId: lesson.gradeId || "", paperIdentity,
    columns: [], rows: [], confirmed: false };
  const context = { panelRevision: record.revision, lesson, grades: grade ? [{ id: grade.id, name: grade.name }] : [],
    knowledge, confirmationVersion: confirmation?.version ?? null, confirmedAt: confirmation?.at || "",
    wrongbook: book, available: false, reason: "" };
  if (!session || !confirmation?.snapshot?.confirmed || !confirmationCurrent(session, "wrongbook")) {
    return { ...context, reason: "请先完成并确认本张试卷的错题校对" };
  }
  if (!confirmationCurrent(session, "scores")) return { ...context, reason: "请先确认本次成绩与缺考情况" };
  if (session.pdf?.materialId && !confirmationCurrent(session, "pdf")) {
    return { ...context, reason: "原卷分组或学生匹配已变化，请重新确认分组与错题校对" };
  }
  if (session.confirmations.knowledge && !confirmationCurrent(session, "knowledge")) {
    return { ...context, reason: "标准答案已修改，请重新确认答案和错题校对" };
  }
  const scores = new Map(session.confirmations.scores.snapshot.map(row => [row.studentId, row]));
  const rows = confirmation.snapshot.rows || [];
  if (!rows.length || rows.some(row => !row.checked || !row.studentId) || new Set(rows.map(row => row.studentId)).size !== rows.length) {
    return { ...context, reason: "错题表需要逐行校对，并关联不同的学生档案" };
  }
  if (rows.some(row => {
    const score = scores.get(row.studentId);
    return !score || clean(row.score) !== clean(score.score) || clean(row.status) !== clean(score.status);
  }) || rows.length !== scores.size) return { ...context, reason: "成绩或名单已更新，请同步并重新确认错题表" };
  book.columns = confirmation.snapshot.columns || [];
  book.rows = rows.map(row => ({
    studentId: row.studentId, name: state.students?.[row.studentId]?.name || row.name,
    checked: true, status: scores.get(row.studentId).status, score: scores.get(row.studentId).score,
    answers: row.answers || {}, checkReason: row.checkReason || "",
  }));
  book.confirmed = true;
  book.attemptedAt = context.confirmedAt;
  return { ...context, available: true };
}

export function assignDiagnosticCorrections(store, record, context, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("请求格式无效", 400);
  if (body.expectedRevision !== record.revision) throw new AppError("课次已更新，请重新读取校对结果", 409);
  if (!context.available) throw new AppError(context.reason, 422);
  if (body.confirmationVersion != null && body.confirmationVersion !== context.confirmationVersion) {
    throw new AppError("错题校对版本已变更，请重新打开逐生诊断", 422);
  }
  const { sessionId, rows, columns } = context.wrongbook;
  const studentId = clean(body.studentId);
  if (studentId && !rows.some(row => row.studentId === studentId)) {
    throw new AppError("这个学生不在本次确认的名单中", 422);
  }
  const selected = studentId ? rows.filter(row => row.studentId === studentId) : rows;
  let created = 0, existing = 0;
  const result = store.transact(record.revision, state => {
    const session = state.sessions[sessionId];
    const pairs = new Map((session.confirmations.pdf?.snapshot?.pairs || []).map(pair => [pair.studentId, pair]));
    const materialId = session.confirmations.pdf?.snapshot?.materialId || "";
    const known = new Set(session.corrections.map(task => JSON.stringify([task.studentId, String(task.question)])));
    for (const row of selected) for (const column of columns) {
      const { outcome } = ExamDomain.reviewedRowResponse(row, column);
      if (outcome !== "incorrect" && outcome !== "blank") continue;
      const key = JSON.stringify([row.studentId, String(column)]);
      if (known.has(key)) { existing++; continue; }
      const pair = pairs.get(row.studentId);
      session.corrections.push({
        id: randomUUID(), studentId: row.studentId, question: String(column), originalAnswer: outcome === "blank" ? "空题" : clean(row.answers[column]),
        standard: structuredClone(context.knowledge[column] || {}), materialId: pair ? materialId : "",
        page: pair ? pair.start + 1 : 1, sourceVersion: context.confirmationVersion,
        status: "pending", attempts: [], draft: ""
      });
      known.add(key);
      created++;
    }
  }, { skipIfEqual: true });
  return { ...result, created, existing };
}

export function engineWithPanelEvidence(stored, panelRecord) {
  const engine = stored.engine;
  const sessions = new Set(engine.attempts.filter(attempt =>
    attempt.source === "E-课前测人工校对" && attempt.paperIdentity && attempt.manualVerified).map(attempt => attempt.sessionId));
  engine.panelEvidence = Object.create(null);
  for (const sessionId of sessions) {
    if (!panelRecord.state.sessions?.[sessionId]) continue;
    const paper = paperContext(panelRecord, sessionId);
    if (paper.available) engine.panelEvidence[sessionId] = ExamDomain.panelAttemptEvidence({ ...paper, examEngine: engine });
  }
  return stored;
}

function sourceExams(engine) {
  const eligibleCounts = new Map();
  const sources = new Map(engine.files.map(file => [file.id, file]));
  for (const question of engine.questions) if (ExamDomain.eligiblePaperQuestion(question)) {
    eligibleCounts.set(question.canonicalExamId, (eligibleCounts.get(question.canonicalExamId) || 0) + 1);
  }
  return engine.canonicalExams
    .filter(exam => !exam.mergedInto && !exam.candidateOf && !exam.migrationNeedsReview && eligibleCounts.has(exam.id))
    .map(exam => ({
      id: exam.id,
      label: [...new Set([exam.year, exam.region, exam.examType, exam.paperOriginName].filter(Boolean))].join(" · "),
      reviewed: eligibleCounts.get(exam.id),
      originalUrl: (exam.fileIds || []).map(id => sources.get(id)?.originalAsset?.url)
        .find(url => /^\/api\/physics-exam\/assets\/[\w-]+$/.test(url || "")) || "",
    }))
    .sort((a, b) => b.label.localeCompare(a.label, "zh-CN", { numeric: true }));
}

function similarQuestions(engine, source) {
  if (!source) return [];
  const model = tag(source.physicalModel), point = tag(source.mainPoint), errorModel = tag(source.errorModelId);
  if (!model && !point && !errorModel) return [];
  return engine.questions.flatMap(question => {
    if (!ExamDomain.activeQuestion(question) || question.generated || !question.sourceFileId ||
        question.canonicalExamId === source.canonicalExamId) return [];
    const match = errorModel && errorModel === tag(question.errorModelId) ? "同错误模型"
      : model && model === tag(question.physicalModel) ? "同物理模型"
      : point && [question.mainPoint, ...(question.secondaryPoints || [])].some(label => tag(label) === point) ? "同考点" : "";
    if (!match || !StudentQuestionSets.draftEligibility(question).selectable) return [];
    return [{ id: question.id, number: question.questionNo, stem: clean(question.stem).slice(0, 160),
      source: [question.year, question.region, question.examType].filter(Boolean).join(" · "), match,
      ready: StudentQuestionSets.readiness(question).ready }];
  }).sort((a, b) => Number(b.ready) - Number(a.ready) ||
    ["同错误模型", "同物理模型", "同考点"].indexOf(a.match) - ["同错误模型", "同物理模型", "同考点"].indexOf(b.match)).slice(0, 3);
}

export function buildPaperDiagnosis(context, stored) {
  const { engine, revision } = stored, { wrongbook: book, knowledge } = context;
  const { sessionId, paperIdentity, columns } = book;
  const currentBinding = engine.settings?.reviewedPaperBindings?.[sessionId];
  const examId = currentBinding?.paperIdentity === paperIdentity ? currentBinding.examId : "";
  const result = { available: context.available, reason: context.reason, revision, panelRevision: context.panelRevision,
    confirmationVersion: context.confirmationVersion, confirmedAt: context.confirmedAt,
    examId, exams: [], mapped: [], unmapped: [], students: [], questionStats: [], questions: Object.create(null) };
  if (!context.available) return result;
  const mapping = ExamDomain.reviewedPaperMapping(engine, book, knowledge);
  result.exams = sourceExams(engine);
  result.mapped = [...mapping.keys()];
  result.unmapped = columns.filter(column => !mapping.has(column));
  for (const column of columns) {
    const question = mapping.get(column), standard = knowledge[column] || {};
    result.questions[column] = {
      correctAnswer: clean(standard.answer ?? (typeof standard === "string" ? standard : question?.answer)),
      type: tag(question?.type), point: tag(question?.mainPoint), model: tag(question?.physicalModel),
      method: tag(question?.method || question?.teacherExplanation || standard.explanation),
      similar: similarQuestions(engine, question),
    };
  }
  result.students = book.rows.map(row => {
    const attendance = ExamDomain.reviewedRowAttendance(row);
    const outcomes = { correct: [], incorrect: [], blank: [], unknown: [] };
    if (attendance === "present") for (const column of columns) {
      const outcome = ExamDomain.reviewedRowResponse(row, column);
      outcomes[outcome.outcome].push({ column, answer: clean(row.answers[column]) });
    }
    return { id: row.studentId, name: row.name, attendance, score: row.score, outcomes };
  });
  const stats = new Map(columns.map(column => [column, { column, correct: 0, incorrect: 0, blank: 0, unknown: 0 }]));
  for (const student of result.students) {
    for (const [outcome, items] of Object.entries(student.outcomes)) for (const { column } of items) stats.get(column)[outcome]++;
  }
  result.questionStats = [...stats.values()].sort((a, b) => (b.incorrect + b.blank) - (a.incorrect + a.blank));
  return result;
}

export function savePaperBinding(store, context, stored, body) {
  if (!context.available) throw new AppError(context.reason, 409);
  if (body.panelRevision !== context.panelRevision || body.baseRevision !== stored.revision) {
    throw new AppError("试卷或题库已更新，请刷新诊断后再确认", 409);
  }
  const { engine } = stored, { sessionId, paperIdentity } = context.wrongbook;
  const examId = clean(body.examId);
  const bindings = { ...engine.settings.reviewedPaperBindings };
  if (examId) {
    if (body.confirmSamePaper !== true || !sourceExams(engine).some(exam => exam.id === examId)) {
      throw new AppError("请核对并确认与本次试卷使用同一份已审核原卷", 422);
    }
    bindings[sessionId] = { examId, paperIdentity };
  } else delete bindings[sessionId];
  const settings = { ...engine.settings, reviewedPaperBindings: bindings };
  if (examId && !ExamDomain.reviewedPaperMapping({ ...engine, settings }, context.wrongbook, context.knowledge).size) {
    throw new AppError("所选原卷没有可安全对应的题目，请核对题号、小问和标准答案", 422);
  }
  store.commit({ baseRevision: stored.revision, requestId: randomUUID(),
    changes: [{ collection: "meta", id: "settings", value: settings }],
    meta: { action: "confirm_assessment_paper", sessionId, examId, reviewer: "local_teacher" } });
  return buildPaperDiagnosis(context, store.getEngine());
}

export function createSimilarQuestionSet(store, context, stored, body) {
  const diagnosis = buildPaperDiagnosis(context, stored);
  if (!diagnosis.available || body.panelRevision !== diagnosis.panelRevision || body.baseRevision !== diagnosis.revision) {
    throw new AppError("校对或题库版本已变化，请刷新诊断后重试", 409);
  }
  const student = diagnosis.students.find(row => row.id === body.studentId && row.attendance === "present");
  const wrong = student ? [...student.outcomes.incorrect, ...student.outcomes.blank] : [];
  const eligible = new Set(wrong.flatMap(({ column }) => diagnosis.questions[column].similar.map(question => question.id)));
  const selected = Array.isArray(body.questionIds) ? [...new Set(body.questionIds)] : [];
  if (!selected.length || selected.length > 30 || selected.some(id => !eligible.has(id))) {
    throw new AppError("请选择该生本次错题对应的同类题", 422);
  }
  const source = fingerprint([context.wrongbook.sessionId, diagnosis.confirmationVersion, student.id, selected]);
  const existing = stored.engine.questionSets.find(set => set.similarSelectionKey === source && set.status !== "archived" &&
    JSON.stringify(set.questionRefs.map(ref => ref.questionId)) === JSON.stringify(selected));
  if (existing) return { id: existing.id, revision: stored.revision };
  const byId = new Map(stored.engine.questions.map(question => [question.id, question]));
  const time = new Date().toISOString();
  const id = "studentset_" + randomUUID();
  const set = { id, title: "错题同类练习", status: "draft", createdAt: time, updatedAt: time, createdBy: "local_teacher",
    similarSelectionKey: source, questionRefs: selected.map(questionId => ({
      questionId, contentHash: StudentQuestionSets.contentHash(byId.get(questionId)),
    })) };
  const { revision } = store.commit({ baseRevision: stored.revision, requestId: randomUUID(),
    changes: [{ collection: "questionSets", id, value: set }], meta: { action: "assessment_practice_draft" } });
  return { id, revision };
}
