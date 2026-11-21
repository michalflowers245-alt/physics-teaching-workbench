import test from "node:test";
import assert from "node:assert/strict";
import QuestionOverview from "../exam-engine/question-overview.js";

const exams = [
  { id: "a-2024", region: "长沙", year: 2024, sourceLayer: "A", examType: "中考原卷" },
  { id: "a-2025", region: "长沙", year: 2025, sourceLayer: "A", examType: "中考原卷" },
  { id: "b-2024", region: "岳阳", year: 2024, sourceLayer: "B", examType: "中考原卷", paperOriginId: "shared" },
  { id: "b-2024-2", region: "湘潭", year: 2024, sourceLayer: "B", examType: "中考原卷", paperOriginId: "shared" },
  { id: "archive", mergedInto: "a-2024" },
];
const label = { type: "单项选择题", mainPoint: "光的反射", physicalModel: "平面镜成像" };
const question = (id, exam, overrides = {}) => ({ id, canonicalExamId: exam, sourceFileId: "file-1", ...label, ...overrides });
const one = question("first", "a-2024", { questionNo: "1", classificationReview: { status: "source_checked", labels: label } });
const two = question("second", "a-2024", { questionNo: "2", physicalModel: "反射光路作图" });
const data = {
  canonicalExams: exams,
  files: [{ id: "file-1" }],
  questions: [one, two, question("third", "a-2025", { type: "作图题", physicalModel: "反射光路作图" }),
    question("fourth", "b-2024"), question("fifth", "b-2024-2", { mainPoint: "扩散", physicalModel: "待人工标注" }),
    question("fragment", "a-2024", { excluded: true }), question("merged", "archive"), question("invented", "a-2024", { generated: true })]
};

test("同一套卷的两道题只计一套，各来源单独汇总", () => {
  const result = QuestionOverview.build(data, { dimension: "mainPoint" });
  assert.equal(result.total, 5);
  assert.deepEqual(result.sections.map(section => [section.layer, section.papers, section.questions]), [["A", 2, 3], ["B", 1, 2]]);
  assert.equal(result.sections[0].groups[0].checked, 1);
  assert.equal(result.sections[0].groups[0].papers, 2);
  assert.equal(result.sections[0].groups[0].items[0].source.id, "file-1");
});

test("按地区年份筛选并切换三种分类，分类修订后原核验状态失效", () => {
  const filters = { region: "长沙", year: "2024" };
  const all = QuestionOverview.build(data, { ...filters, dimension: "physicalModel" });
  assert.equal(all.count, 2);
  assert.equal(all.sections[0].papers, 1);
  assert.equal(all.sections[0].groups.length, 2);
  assert.equal(QuestionOverview.build(data, { ...filters, dimension: "type" }).sections[0].groups.length, 1);
  assert.equal(QuestionOverview.build(data, { region: "湘潭" }).sections[0].groups[0].label, "尚未分类");
  const changed = { ...data, questions: [{ ...one, mainPoint: "修改后" }] };
  assert.equal(QuestionOverview.build(changed, filters).sections[0].checked, 0);
});
