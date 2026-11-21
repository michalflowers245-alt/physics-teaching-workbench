import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import StudentQuestionSets from "../exam-engine/student-question-set.js";
import { studentQuestionSetPayload } from "../server/physics-exam-routes.mjs";
import { EngineStore } from "../server/physics-exam-store.mjs";

const CROP_ID = "asset_questioncrop_12345678";
const PAGE_ID = "asset_fullpage_12345678";
const QUESTION_ID = "question_12345678";
const SET_ID = "studentset_12345678";

function reviewedQuestion(overrides = {}) {
  return {
    id: QUESTION_ID,
    questionNo: "12",
    score: 3,
    type: "选择题",
    stem: "如图所示，判断电路中电流表的示数变化。",
    options: [
      { label: "A", text: "变大" },
      { label: "B", text: "变小" },
    ],
    dataTables: [{ headers: ["电压/V", "电流/A"], rows: [["3", "0.2"]] }],
    imageReviewRequired: true,
    imageReviewed: true,
    imageAssets: [
      { id: CROP_ID, kind: "question-crop", exportApproved: true },
      { id: PAGE_ID, kind: "page", teachingSafe: true },
    ],
    reviewed: true,
    reviewedBy: "local_teacher",
    reviewedAt: "2026-09-12T08:00:00.000Z",
    // Teacher-only sentinels are intentionally present in the input.  They
    // must never cross the student projection boundary.
    answer: "ANSWER_SENTINEL",
    sourceExplanation: "SOURCE_EXPLANATION_SENTINEL",
    teacherExplanation: "TEACHER_EXPLANATION_SENTINEL",
    teacherNotes: "TEACHER_NOTES_SENTINEL",
    originalPdf: "ORIGINAL_PDF_SENTINEL",
    tags: ["TAG_SENTINEL"],
    ...overrides,
  };
}

function readySet(question) {
  return {
    id: SET_ID,
    title: "动态电路练习",
    status: "ready",
    publishedAt: "2026-09-12T08:01:00.000Z",
    publishedBy: "local_teacher",
    questionRefs: [{ questionId: question.id, contentHash: StudentQuestionSets.contentHash(question) }],
  };
}

test("撤出或合并的题目即使保留旧审核也不能选入或导出", () => {
  for (const state of [{excluded:true}, {mergedIntoQuestionId:"question_parent_12345"}]) {
    const question=reviewedQuestion(state);
    assert.equal(StudentQuestionSets.draftEligibility(question).selectable,false);
    assert.equal(StudentQuestionSets.readiness(question).ready,false);
    assert.throws(()=>StudentQuestionSets.studentSetDTO(readySet(question),[question]),/撤出或合并/);
  }
});

function installAsset(dataDir, { id = CROP_ID, kind = "question-crop", extension = ".png", ...metadata } = {}) {
  const dir = join(dataDir, "exam-assets");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, kind, extension, mimeType: "image/png", ...metadata }));
  writeFileSync(join(dir, `${id}${extension}`), "fixture image");
}

function assertStudentQuestionShape(question) {
  assert.deepEqual(Object.keys(question).sort(), ["imageAssets", "options", "questionNo", "score", "stem", "tables"].sort());
  for (const option of question.options) assert.deepEqual(Object.keys(option).sort(), ["label", "text"]);
  for (const table of question.tables) assert.deepEqual(Object.keys(table).sort(), ["headers", "rows"]);
  for (const image of question.imageAssets) assert.deepEqual(Object.keys(image).sort(), ["alt", "assetId", "url"]);
}

test("学生题单使用严格白名单，原解析、答案、PDF和教师字段绝不泄露", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "student-set-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  installAsset(dataDir);
  const question = reviewedQuestion();
  const payload = await studentQuestionSetPayload({ questions: [question], questionSets: [readySet(question)] }, SET_ID, dataDir);

  assert.deepEqual(Object.keys(payload).sort(), ["id", "questionCount", "questions", "schemaVersion", "title"].sort());
  assert.equal(payload.questionCount, 1);
  assertStudentQuestionShape(payload.questions[0]);
  assert.deepEqual(payload.questions[0].imageAssets, [{
    assetId: CROP_ID,
    url: `/api/physics-exam/assets/${CROP_ID}`,
    alt: "题目必要图示 1",
  }]);

  const serialized = JSON.stringify(payload);
  for (const forbidden of ["ANSWER_SENTINEL", "SOURCE_EXPLANATION_SENTINEL", "TEACHER_EXPLANATION_SENTINEL", "TEACHER_NOTES_SENTINEL", "ORIGINAL_PDF_SENTINEL", "TAG_SENTINEL", PAGE_ID]) {
    assert.ok(!serialized.includes(forbidden), `student payload leaked ${forbidden}`);
  }
});

test("未审核、缺答案或缺必要题图的题不能进入学生题单", () => {
  const unreviewed = reviewedQuestion({ reviewed: false, reviewedBy: "", reviewedAt: "" });
  assert.equal(StudentQuestionSets.readiness(unreviewed).ready, false);
  assert.throws(() => StudentQuestionSets.studentQuestionDTO(unreviewed), /教师逐题确认/);

  const missingAnswer = reviewedQuestion({ answer: "" });
  assert.equal(StudentQuestionSets.readiness(missingAnswer).ready, false);

  const missingCrop = reviewedQuestion({ imageAssets: [{ id: PAGE_ID, kind: "page", teachingSafe: true }] });
  assert.equal(StudentQuestionSets.readiness(missingCrop).ready, false);
  assert.match(StudentQuestionSets.readiness(missingCrop).issues.join("；"), /必要题图/);
});

test("原卷题必须为每一个来源页保留经审核的单题裁图", () => {
  const question = reviewedQuestion({
    imageReviewRequired: false,
    imageReviewed: true,
    sourceFileId: "source_12345678",
    sourceSpans: [{ pageNo: 1 }, { pageNo: 2 }],
    imageAssets: [{ id: CROP_ID, kind: "question-crop", pageNo: 1, exportApproved: true }],
  });
  const incomplete = StudentQuestionSets.readiness(question);
  assert.equal(incomplete.ready, false);
  assert.match(incomplete.issues.join("；"), /第 2 页裁图/);

  question.imageAssets.push({ id: "asset_questioncrop_87654321", kind: "question-crop", pageNo: 2, exportApproved: true });
  assert.equal(StudentQuestionSets.readiness(question).ready, true);
});

test("跨页题丢失的中间图页必须补齐，异常长页码范围不能绕过核验", () => {
  const question = reviewedQuestion({ sourceFileId: "source_12345678", sourceSpans: [{ pageNo: 8 }, { pageNo: 10 }], imageAssets: [
    { id: CROP_ID, kind: "question-crop", pageNo: 8, exportApproved: true },
    { id: "asset_questioncrop_87654321", kind: "question-crop", pageNo: 10, exportApproved: true },
  ] });
  assert.deepEqual(StudentQuestionSets.sourcePageNumbers(question), [8, 9, 10]);
  assert.equal(StudentQuestionSets.draftEligibility(question).selectable, false);
  assert.match(StudentQuestionSets.readiness(question).issues.join("；"), /第 9 页/);
  question.imageAssets.push({ id: "asset_middlecrop_12345678", kind: "question-crop", pageNo: 9, exportApproved: true });
  assert.equal(StudentQuestionSets.readiness(question).ready, true);
  const abnormal = { ...question, sourceSpans: [{ pageNo: 8 }, { pageNo: 1000000 }] };
  assert.ok(StudentQuestionSets.sourcePageNumbers(abnormal).length < 100);
  assert.match(StudentQuestionSets.readiness(abnormal).issues.join("；"), /跨页范围异常/);
  assert.equal(StudentQuestionSets.draftEligibility(abnormal).selectable, false);
});

test("完整原题可先选入草稿，缺答案分值和教师确认会进入集中核验清单", () => {
  const question = reviewedQuestion({
    sourceFileId: "source_12345678", sourceSpans: [{ pageNo: 1 }, { pageNo: 2 }],
    reviewed: false, reviewedBy: "", reviewedAt: "", answer: "", score: null, imageReviewed: false,
    imageAssets: [
      { id: "asset_questioncrop_87654321", kind: "question-crop", pageNo: 2, exportApproved: false },
      { id: CROP_ID, kind: "question-crop", pageNo: 1, exportApproved: false },
    ],
  });
  const originalState = JSON.stringify(question);
  const selection = StudentQuestionSets.draftEligibility(question);
  assert.equal(selection.selectable, true);
  assert.equal(selection.ready, false);
  assert.deepEqual(selection.imageAssets.map(asset => asset.pageNo), [1, 2]);
  assert.match(selection.reviewIssues.join("；"), /教师逐题确认/);
  assert.match(selection.reviewIssues.join("；"), /教师答案缺失/);
  assert.match(selection.reviewIssues.join("；"), /分值缺失/);
  assert.deepEqual(StudentQuestionSets.safeImageAssets(question), []);
  assert.throws(() => StudentQuestionSets.studentQuestionDTO(question), /教师逐题确认/);
  const set = { id: SET_ID, title: "先选后审", status: "draft", questionRefs: [{ questionId: question.id, contentHash: "" }] };
  assert.deepEqual(StudentQuestionSets.questionSetIssues(set, new Map([[question.id, question]])), []);
  const summary = StudentQuestionSets.questionSetReviewSummary(set, [question]);
  assert.equal(summary.totalCount, 1);
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.contentReady, false);
  assert.equal(summary.items[0].checklist.find(item => item.code === "answer").done, false);
  assert.equal(JSON.stringify(question), originalState, "selection must never grant or mutate review status");

  const incomplete = { ...question, imageAssets: question.imageAssets.slice(0, 1) };
  assert.equal(StudentQuestionSets.draftEligibility(incomplete).selectable, false);
  assert.match(StudentQuestionSets.draftEligibility(incomplete).issues.join("；"), /第 1 页/);
  const spoofedPage = { ...question, imageAssets: question.imageAssets.map(asset => ({ ...asset, kind: "page" })) };
  assert.equal(StudentQuestionSets.draftEligibility(spoofedPage).selectable, false);
});

test("零题号及小数误切不能选入或发布学生题单", () => {
  for (const questionNo of ["0", "0-1", "0.02", "-1", "ABC"]) {
    const question = reviewedQuestion({ questionNo });
    assert.equal(StudentQuestionSets.draftEligibility(question).selectable, false, questionNo);
    assert.match(StudentQuestionSets.readiness(question).issues.join("；"), /疑似切题异常/);
  }
  for (const questionNo of ["1", "20-2", "20(2)", "20（2）", "第 20 题"]) {
    assert.equal(StudentQuestionSets.validQuestionNo(questionNo), true, questionNo);
  }
});

test("原题显示模式取决于逐页来源裁图并纳入题单内容版本", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "student-set-original-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const question = reviewedQuestion({
    sourceFileId: "source_12345678", sourceSpans: [{ pageNo: 1 }, { pageNo: 2 }],
    imageAssets: [
      { id: "asset_questioncrop_87654321", kind: "question-crop", pageNo: 2, exportApproved: true, generatedBy: "page-assets-backfill-v3" },
      { id: CROP_ID, kind: "question-crop", pageNo: 1, exportApproved: true, generatedBy: "page-assets-backfill-v2" },
    ],
  });
  for (const image of question.imageAssets) installAsset(dataDir, {
    id: image.id, immutable: true, pageNo: image.pageNo,
    sourceDocumentId: question.sourceFileId,
    extractionRunId: `${image.generatedBy}:${question.sourceFileId}`,
    fileName: `${question.id}-p${image.pageNo}.png`,
  });
  const set = readySet(question);
  const payload = await studentQuestionSetPayload({ questions: [question], questionSets: [set] }, SET_ID, dataDir);
  assert.equal(payload.questions[0].contentMode, "original");
  assert.deepEqual(payload.questions[0].imageAssets.map(asset => asset.assetId), [CROP_ID, "asset_questioncrop_87654321"]);
  assert.ok(!JSON.stringify(payload).includes("generatedBy"));
  assert.ok(!JSON.stringify(payload).includes("sourceDocumentId"));
  const diagramOnly = { ...question, imageAssets: question.imageAssets.map(asset => ({ ...asset, generatedBy: "manual-diagram" })) };
  assert.equal(StudentQuestionSets.contentMode(diagramOnly), "structured");
  assert.notEqual(StudentQuestionSets.contentHash(diagramOnly), StudentQuestionSets.contentHash(question));

  // A client label cannot promote an arbitrary persisted image to a complete
  // original crop, even if the question claims the trusted tool's name.
  installAsset(dataDir, { id: CROP_ID, pageNo: 1 });
  await assert.rejects(studentQuestionSetPayload({ questions: [question], questionSets: [set] }, SET_ID, dataDir), /已变更/);
});

test("未审题单草稿可保存并恢复，发布前仍需真实逐题与题单确认", t => {
  const dataDir = mkdtempSync(join(tmpdir(), "student-set-draft-"));
  const store = new EngineStore(dataDir);
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const question = reviewedQuestion({
    generated: true, sourceLayer: "D", countedInFrequency: false, canonicalExamId: "",
    reviewed: false, reviewedBy: "", reviewedAt: "", answer: "", score: null,
    imageReviewRequired: false, imageAssets: [],
  });
  const set = { id: SET_ID, title: "我的选题草稿", status: "draft", questionRefs: [{ questionId: question.id, contentHash: "" }] };
  store.commit({ baseRevision: 0, requestId: "save-unreviewed-selection", changes: [
    { collection: "questions", id: question.id, value: question },
    { collection: "questionSets", id: set.id, value: set },
  ], meta: { action: "question_set_draft" } });
  assert.equal(store.getEngine().engine.questionSets[0].status, "draft");
  assert.equal(store.getEngine().engine.questions[0].reviewed, false);
  assert.equal(store.getEngine().engine.auditEvents.some(event => event.status === "confirmed"), false);
  assert.throws(() => StudentQuestionSets.studentSetDTO(set, [question]), /尚未经教师确认/);
  assert.throws(() => store.commit({ baseRevision: 1, requestId: "reject-premature-publication", changes: [
    { collection: "questionSets", id: set.id, value: readySet(question) },
  ], meta: { action: "question_set_publish" } }), /教师逐题确认/);
  assert.equal(store.getEngine().revision, 1);
});

test("伪装成学生题图的整页资产和题目改动均会阻止学生卷输出", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "student-set-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  // The database asset metadata wins over a question record's claimed kind.
  installAsset(dataDir, { id: CROP_ID, kind: "page" });
  const question = reviewedQuestion();
  await assert.rejects(
    studentQuestionSetPayload({ questions: [question], questionSets: [readySet(question)] }, SET_ID, dataDir),
    /必要题图/,
  );

  installAsset(dataDir, { id: CROP_ID, kind: "question-crop" });
  const set = readySet(question);
  const changedQuestion = { ...question, stem: "教师后来改过的题干" };
  await assert.rejects(
    studentQuestionSetPayload({ questions: [changedQuestion], questionSets: [set] }, SET_ID, dataDir),
    /已变更，需重新确认题单/,
  );
});

test("服务端只接受带逐题审核和题单确认事件的可用学生题单", t => {
  const dataDir = mkdtempSync(join(tmpdir(), "student-set-store-"));
  const store = new EngineStore(dataDir);
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const question = reviewedQuestion({
    generated: true,
    sourceLayer: "D",
    countedInFrequency: false,
    canonicalExamId: "",
    imageReviewRequired: false,
    imageAssets: [],
  });
  const set = readySet(question);
  const questionReview = { id: "audit_question_12345678", entityType: "question_review", entityId: question.id, status: "confirmed", reviewer: "local_teacher", at: question.reviewedAt };
  const baseChanges = [
    { collection: "questions", id: question.id, value: question },
    { collection: "questionSets", id: set.id, value: set },
    { collection: "auditEvents", id: questionReview.id, value: questionReview },
  ];
  assert.throws(
    () => store.commit({ baseRevision: 0, requestId: "student-set-missing-confirmation", changes: baseChanges, meta: { action: "test" } }),
    /student question set publication requires an explicit local teacher review event/,
  );

  const setReview = { id: "audit_set_12345678", entityType: "question_set", entityId: set.id, status: "confirmed", reviewer: "local_teacher", at: set.publishedAt };
  const result = store.commit({
    baseRevision: 0,
    requestId: "student-set-with-confirmation",
    changes: [...baseChanges, { collection: "auditEvents", id: setReview.id, value: setReview }],
    meta: { action: "test" },
  });
  assert.equal(result.revision, 1);
  assert.equal(store.getEngine().engine.questionSets[0].status, "ready");
});

test("已发布题单改标题或换题必须追加新的确认事件，日常更新时间无需重审", t => {
  const dataDir = mkdtempSync(join(tmpdir(), "student-set-republish-"));
  const store = new EngineStore(dataDir);
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const question = reviewedQuestion({ generated: true, sourceLayer: "D", countedInFrequency: false, canonicalExamId: "", imageReviewRequired: false, imageAssets: [] });
  const second = { ...question, id: "question_second_12345678", stem: "另一道电路题" };
  const set = readySet(question);
  const review = { id: "audit_set_publish_12345678", entityType: "question_set", entityId: set.id, status: "confirmed", reviewer: "local_teacher", at: set.publishedAt };
  store.commit({ baseRevision: 0, requestId: "initial-publication", changes: [
    ...[question, second].map(value => ({ collection: "questions", id: value.id, value })),
    { collection: "questionSets", id: set.id, value: set },
    { collection: "auditEvents", id: review.id, value: review },
  ], meta: { action: "teacher_review", reviewer: "local_teacher" } });
  const renamed = { ...set, title: "教师改过的练习单" };
  const swapped = { ...set, questionRefs: [{ questionId: second.id, contentHash: StudentQuestionSets.contentHash(second) }] };
  for (const [name, changed] of [["rename", renamed], ["swap", swapped], ["reviewer", { ...set, publishedBy: "another_teacher" }]]) {
    assert.throws(() => store.commit({ baseRevision: 1, requestId: `reject-unconfirmed-${name}`, changes: [
      { collection: "questionSets", id: set.id, value: changed },
    ] }), /explicit local teacher review event/);
  }
  assert.throws(() => store.commit({ baseRevision: 1, requestId: "reject-old-review-replay", changes: [
    { collection: "questionSets", id: set.id, value: renamed },
    { collection: "auditEvents", id: review.id, value: review },
  ] }), /explicit local teacher review event/);
  store.commit({ baseRevision: 1, requestId: "allow-bookkeeping", changes: [
    { collection: "questionSets", id: set.id, value: { ...set, updatedAt: "2026-09-13T08:00:00Z" } },
  ] });
  const newReview = { ...review, id: "audit_set_republish_12345678", at: "2026-09-13T08:01:00Z" };
  store.commit({ baseRevision: 2, requestId: "confirmed-republication", changes: [
    { collection: "questionSets", id: set.id, value: renamed },
    { collection: "auditEvents", id: newReview.id, value: newReview },
  ] });
  assert.equal(store.getEngine().engine.questionSets[0].title, renamed.title);
});

test("原卷题缺来源页或伪装原创题均不可用于学生卷", () => {
  for (const source of [{ sourceFileId: "source_12345678" }, { canonicalExamId: "exam_12345678" }]) {
    const question = reviewedQuestion({ ...source, sourceSpans: [], pageNo: null, imageReviewRequired: false, imageAssets: [] });
    assert.equal(StudentQuestionSets.readiness(question).ready, false);
    assert.match(StudentQuestionSets.readiness(question).issues.join("；"), /来源页码缺失/);
    assert.equal(StudentQuestionSets.draftEligibility(question).selectable, false);
    const forged = { ...question, generated: true };
    assert.match(StudentQuestionSets.readiness(forged).issues.join("；"), /来源冲突/);
  }
});

test("服务端拒绝将原题原地改为原创题来绕过原图核验", t => {
  const dataDir = mkdtempSync(join(tmpdir(), "student-set-source-identity-"));
  const store = new EngineStore(dataDir);
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const exam = { id: "exam_source_12345678", sourceLayer: "D", region: "长沙", examType: "练习", duplicateGroupId: "group_12345678" };
  const source = reviewedQuestion({ canonicalExamId: exam.id, sourceLayer: "D", reviewed: false, reviewedAt: "", reviewedBy: "", imageAssets: [] });
  store.commit({ baseRevision: 0, requestId: "seed-source-question", changes: [
    { collection: "canonicalExams", id: exam.id, value: exam },
    { collection: "questions", id: source.id, value: source },
  ] });
  assert.throws(() => store.commit({ baseRevision: 1, requestId: "reject-source-relabel", changes: [
    { collection: "questions", id: source.id, value: { ...source, generated: true, canonicalExamId: "", countedInFrequency: false } },
  ] }), /cannot be converted to generated in place/);
  const generated = { ...source, id: "generated_question_12345678", generated: true, canonicalExamId: "", countedInFrequency: false, sourceFileId: "source_12345678" };
  assert.throws(() => store.commit({ baseRevision: 1, requestId: "reject-generated-source-pages", changes: [
    { collection: "questions", id: generated.id, value: generated },
  ] }), /cannot claim original source pages/);
});

test("可信备份恢复已发布题单会追加恢复确认，保持可用而不绕过发布规则", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "student-set-restore-"));
  const store = new EngineStore(dataDir);
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const question = reviewedQuestion({ generated: true, sourceLayer: "D", countedInFrequency: false, canonicalExamId: "", imageReviewRequired: false, imageAssets: [] });
  const set = readySet(question);
  const review = { id: "audit_sheet_backup_12345678", entityType: "question_set", entityId: set.id, status: "confirmed", reviewer: "local_teacher", at: set.publishedAt };
  store.commit({ baseRevision: 0, requestId: "prepare-sheet-backup", changes: [
    { collection: "questions", id: question.id, value: question },
    { collection: "questionSets", id: set.id, value: set },
    { collection: "auditEvents", id: review.id, value: review },
  ], meta: { action: "teacher_review", reviewer: "local_teacher" } });
  const backup = await store.backup({ baseRevision: 1, requestId: "backup-published-sheet" });
  const renamed = { ...set, title: "后续修改的标题" };
  const renameReview = { ...review, id: "audit_sheet_rename_12345678" };
  store.commit({ baseRevision: 1, requestId: "rename-before-restore", changes: [
    { collection: "questionSets", id: set.id, value: renamed },
    { collection: "auditEvents", id: renameReview.id, value: renameReview },
  ] });
  await store.restoreBackup(backup.id, { baseRevision: 2, requestId: "restore-published-sheet" });
  const restored = store.getEngine().engine;
  assert.equal(restored.questionSets[0].title, set.title);
  assert.equal(StudentQuestionSets.studentSetDTO(restored.questionSets[0], restored.questions).questionCount, 1);
  assert.ok(restored.auditEvents.some(event => event.entityType === "question_set" && event.entityId === set.id && event.payload?.operation === "restore_trusted_local_backup"));
});
