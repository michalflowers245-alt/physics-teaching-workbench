import assert from "node:assert/strict";
import test from "node:test";
import ExamDomain from "../exam-engine/exam-domain.js";
import { assessmentReviewSource } from "../shared/domain.mjs";
import { assignDiagnosticCorrections, buildPaperDiagnosis, engineWithPanelEvidence, paperContext, savePaperBinding } from "../server/physics-paper-diagnosis.mjs";

const sessionId = "class-1|2026|term|1";
const question = (id, questionNo, overrides = {}) => ({
  id, questionNo, canonicalExamId: "exam-1", sourceFileId: "paper-1", reviewed: true, reviewedBy: "teacher",
  reviewedAt: "2026-11-21", stem: "示例题", answer: "A", ...overrides,
});
function fixture() {
  const rows = Array.from({ length: 23 }, (_, index) => ({
    studentId: "student-" + (index + 1), name: "匿名" + (index + 1), checked: true,
    status: index === 21 ? "请假" : "A", score: index >= 21 ? "" : "6",
    answers: index === 20 ? { 1: "B", 2: "空", 3: "?" } : {},
  }));
  const lesson = { gradeId: "class-1", year: "2026", term: "term", lessonNo: "1", questionSpec: "1,2,3", maxScore: 9, penalty: 3 };
  const scores = rows.map(({ studentId, name, status, score }) => ({ studentId, name, status, score }));
  const wrongbook = { columns: ["1", "2", "3"], rows, confirmed: true };
  const knowledge = { 1: { answer: "A" }, 2: { answer: "A" }, 3: { answer: "A" } };
  const session = { id: sessionId, lesson, scores, knowledge, wrongbook, scoring: { mode: "legacy" }, pdf: {},
    confirmations: Object.fromEntries(Object.entries({ scores, wrongbook, knowledge }).map(([key, snapshot]) =>
      [key, { snapshot: structuredClone(snapshot), meta: lesson, version: 1 }])) };
  session.confirmations.wrongbook.assessmentSource = assessmentReviewSource(session);
  const state = { sessionId: "other-session", sessions: { [sessionId]: session },
    grades: [{ id: "class-1", name: "任意班名" }] };
  const record = { state, revision: 8 };
  const stored = { revision: 12, engine: { canonicalExams: [{ id: "exam-1" }, { id: "exam-2" }],
    files: [], attempts: [], questions: [question("q1", "1"), question("q2", "2"), question("q3", "3")], settings: {} } };
  const paper = paperContext(record, sessionId);
  stored.engine.settings.reviewedPaperBindings = { [sessionId]: { examId: "exam-1", paperIdentity: paper.wrongbook.paperIdentity } };
  return { record, session, stored, paper };
}

test("逐生诊断按稳定课次读取全名单，缺考和未核实不计入正误", () => {
  const { record, stored, paper } = fixture();
  const result = buildPaperDiagnosis(paper, stored);
  assert.equal(result.students.length, 23);
  assert.deepEqual(result.questionStats[0], { column: "1", correct: 20, incorrect: 1, blank: 0, unknown: 0 });
  assert.deepEqual(result.questionStats.find(row => row.column === "3"), { column: "3", correct: 20, incorrect: 0, blank: 0, unknown: 1 });
  assert.deepEqual(result.students[20].outcomes, {
    correct: [], incorrect: [{ column: "1", answer: "B" }], blank: [{ column: "2", answer: "空" }],
    unknown: [{ column: "3", answer: "?" }],
  });
  for (const [index, attendance] of [[21, "absent"], [22, "unverified"]]) {
    assert.equal(result.students[index].attendance, attendance);
    assert.ok(Object.values(result.students[index].outcomes).every(items => !items.length));
  }
  record.state.grades[0].name = "班级改名";
  assert.deepEqual(buildPaperDiagnosis(paperContext(record, sessionId), stored).mapped, ["1", "2", "3"]);
  assert.throws(() => paperContext(record, "不存在的课次"), { status: 404 });
});

test("按学生布置订正只接收确认过的错题与空题，不重复且不接受旧版本", () => {
  const { record, session, paper } = fixture();
  session.corrections = [];
  // A stray value on a student's absent row must never create an assignment.
  paper.wrongbook.rows[21].answers = { "3": "B" };
  const store = { transact(revision, change) {
    assert.equal(revision, 8);
    change(record.state);
    return record;
  } };
  const body = { expectedRevision: 8, studentId: "student-21", confirmationVersion: 1 };
  assert.equal(assignDiagnosticCorrections(store, record, paper, body).created, 2);
  assert.deepEqual(session.corrections.map(task => [task.question, task.originalAnswer]), [["1", "B"], ["2", "空题"]]);
  assert.equal(assignDiagnosticCorrections(store, record, paper, body).existing, 2);
  assert.equal(assignDiagnosticCorrections(store, record, paper, { expectedRevision: 8 }).created, 0);
  assert.throws(() => assignDiagnosticCorrections(store, record, paper, { ...body, expectedRevision: 7 }), { status: 409 });
  assert.throws(() => assignDiagnosticCorrections(store, record, paper, { ...body, confirmationVersion: 0 }), { status: 422 });
});

test("只匹配同卷且唯一的已审核原题，拒绝主小问混配和答案冲突", () => {
  const { paper, stored } = fixture();
  stored.engine.questions = [
    question("q1", "1", { excluded: true }), question("old-copy", "1", { canonicalExamId: "exam-2" }),
    question("q2", "2"), question("duplicate", "02", { reviewed: false }),
    question("q3", "3", { answer: "B" }), question("part3", "3(1)"),
  ];
  assert.deepEqual(buildPaperDiagnosis(paper, stored).mapped, []);
  assert.deepEqual(buildPaperDiagnosis(paper, stored).unmapped, ["1", "2", "3"]);
  const body = { panelRevision: 8, baseRevision: 12, examId: "exam-1", confirmSamePaper: true };
  assert.throws(() => savePaperBinding({}, paper, stored, body), { status: 422 });
  assert.throws(() => savePaperBinding({}, paper, stored, { ...body, baseRevision: 11 }), { status: 409 });
});

test("课前测回写只接收已核实作答，旧标准或修订前的数据自动失效", () => {
  const { record, session, paper, stored } = fixture();
  const state = { ...paper, examEngine: stored.engine };
  assert.equal(ExamDomain.ingestVerifiedWrongbook(state).imported, 62);
  assert.equal(ExamDomain.ingestVerifiedWrongbook(state).unchanged, 62);
  assert.equal(ExamDomain.activeAttempts(engineWithPanelEvidence(stored, record).engine).length, 62);
  session.confirmations.knowledge.version++;
  assert.equal(paperContext(record, sessionId).available, false);
  assert.equal(ExamDomain.activeAttempts(engineWithPanelEvidence(stored, record).engine).length, 0);
  assert.equal(stored.engine.attempts.length, 62);
});
