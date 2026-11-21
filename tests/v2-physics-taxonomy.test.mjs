import test from "node:test";
import assert from "node:assert/strict";

await import(`../exam-engine/physics-taxonomy.js?test=${Date.now()}`);
const taxonomy = globalThis.PhysicsTaxonomy;

test("知识大纲覆盖八上、八下2025、九年级和中考专题且每节内容完整", () => {
  assert.ok(taxonomy);
  assert.deepEqual(taxonomy.outline.map(item => item.id), ["grade8_up", "grade8_down", "grade9", "exam_topics"]);
  assert.deepEqual(taxonomy.outline.map(item => item.chapters.flatMap(chapter => chapter.sections).length), [26, 24, 39, 12]);
  const ids = taxonomy.sections.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of taxonomy.sections) {
    assert.ok(item.contents.length >= 2, `${item.id}缺少本节内容`);
    assert.ok(item.mistakes.length >= 2, `${item.id}缺少易错知识点`);
    assert.ok(item.questionTypes.length >= 2, `${item.id}缺少易错题型`);
    assert.ok(item.keywords.length >= 2, `${item.id}缺少归类关键词`);
  }
  assert.equal(taxonomy.getSection("8d-12-3").title, "滑轮");
  assert.equal(taxonomy.getSection("8d-12-4").title, "机械效率");
});

test("内能小节提供完整教学预警并能归类题目", () => {
  const internal = taxonomy.getSection("9-13-2");
  assert.equal(internal.bookTitle, "九年级");
  assert.ok(internal.contents.length >= 8);
  assert.ok(internal.mistakes.length >= 10);
  assert.ok(internal.questionTypes.length >= 8);
  const matches = taxonomy.classifyQuestion({ mainPoint: "内能", stem: "压缩空气和热传递都能改变物体内能，判断温度、热量与内能关系" }, { bookId: "grade9" });
  assert.equal(matches[0].id, "9-13-2");
  const unrelated = taxonomy.classifyQuestion({ mainPoint: "保温材料", stem: "食品包装采用保温材料，比较导热性能" }, { bookId: "exam_topics" });
  assert.ok(!unrelated.some(item => item.id === "exam-multigear"));
});

test("教师确认的知识节点优先于规则候选", () => {
  const matches = taxonomy.classifyQuestion({
    curriculumNodeIds: ["8u-5-3"],
    curriculumMappingStatus: "confirmed",
    reviewed: true,
    reviewedBy: "local_teacher",
    reviewedAt: "2026-09-12T00:00:00.000Z",
    mainPoint: "待人工标注",
    stem: "无关键词",
  }, { bookId: "grade8_up" });
  assert.deepEqual(matches.map(item => item.id), ["8u-5-3"]);
  assert.equal(matches[0].confirmed, true);
});

test("题目审核失效后旧知识映射不再显示为已确认", () => {
  const matches = taxonomy.classifyQuestion({
    curriculumNodeIds: ["9-13-2"],
    curriculumMappingStatus: "confirmed",
    reviewed: false,
    reviewedBy: "",
    reviewedAt: "",
    stem: "修改后的题干暂待重审",
  }, { bookId: "grade9" });
  assert.equal(matches.find(item => item.id === "9-13-2")?.confirmed, false);
});

test("未审核的错误自动标签不会把题串到无关小节", () => {
  const question = {
    reviewed: false,
    mainPoint: "多挡电热器的电路状态判断",
    physicalModel: "多挡电热器的电路状态判断",
    stem: "小伟探究小烧杯中的水能否沸腾，每隔2min记录温度计示数，水沸腾时温度保持不变。",
    answer: "秒表；未沸腾",
  };
  const grade8 = taxonomy.classifyQuestion(question, { bookId: "grade8_up" });
  const grade9 = taxonomy.classifyQuestion(question, { bookId: "grade9" });
  const exam = taxonomy.classifyQuestion(question, { bookId: "exam_topics" });
  assert.ok(grade8.some(item => item.id === "8u-3-3"));
  assert.ok(!grade8.some(item => item.id === "8u-1-1"));
  assert.ok(!grade9.some(item => item.id === "9-18-2"));
  assert.ok(!exam.some(item => item.id === "exam-multigear"));
});

test("通用计算条件和单个选项干扰词不能单独定类", () => {
  const power = taxonomy.classifyQuestion({
    reviewed: false,
    type: "计算题",
    stem: "一台提升机在10s内将质量为50kg的物体提高5m，求功率。",
  }, { bookId: "grade8_up" });
  assert.ok(!power.some(item => item.id === "8u-6-1"), "计算条件中的质量不等于考查质量概念");

  const inertia = taxonomy.classifyQuestion({
    reviewed: false,
    type: "选择题",
    stem: "汽车紧急刹车时乘客向前倾，下列说法正确的是（ ） A．物体的内能一定减少 B．乘客具有惯性 C．汽车不受力 D．速度越大惯性越大",
  }, { bookId: "grade9" });
  assert.ok(!inertia.some(item => item.id === "9-13-2"), "干扰项里单独出现内能不能定类");

  const railgun = taxonomy.classifyQuestion({
    reviewed: false,
    type: "填空题",
    stem: "电磁炮发射后弹丸速度很快，请分析通电导体在磁场中的受力。",
  }, { bookId: "grade8_up" });
  assert.ok(!railgun.some(item => item.id === "8u-1-3"), "情境里的速度条件不等于考查速度");

  const wire = taxonomy.classifyQuestion({
    reviewed: false,
    type: "选择题",
    stem: "把一根导线均匀拉伸到原来长度的两倍，比较它的电阻。",
  }, { bookId: "grade8_up" });
  assert.ok(!wire.some(item => item.id === "8u-1-1"), "材料条件中的长度不等于考查长度测量");
});

test("已审核的具体考法不会被力和功等短标题吞并", () => {
  const buoyancy = taxonomy.classifyQuestion({
    reviewed: true,
    reviewedBy: "local_teacher",
    reviewedAt: "2026-09-12T00:00:00.000Z",
    mainPoint: "浮力与物体浮沉状态",
    stem: "物体浸没在水中，判断浮力与重力的关系。",
  }, { bookId: "grade8_down" });
  assert.ok(buoyancy.some(item => item.id === "8d-10-1"));
  assert.ok(!buoyancy.some(item => item.id === "8d-7-1"));

  const electricPower = taxonomy.classifyQuestion({
    reviewed: true,
    reviewedBy: "local_teacher",
    reviewedAt: "2026-09-12T00:00:00.000Z",
    mainPoint: "电功率",
    stem: "用电器在额定电压下工作，求额定功率。",
  }, { bookId: "grade8_down" });
  assert.ok(!electricPower.some(item => item.id === "8d-11-1"));
  assert.ok(!electricPower.some(item => item.id === "8d-11-2"));
});

test("确认一个教材节点后仍保留其他小节与中考模型候选", () => {
  const question = {
    reviewed: true,
    reviewedBy: "local_teacher",
    reviewedAt: "2026-09-12T00:00:00.000Z",
    curriculumNodeIds: ["9-13-2"],
    curriculumMappingStatus: "confirmed",
    mainPoint: "物态变化及吸放热判断",
    stem: "晶体熔化时继续吸收热量，温度不变，但内能增加。",
  };
  const grade9 = taxonomy.classifyQuestion(question, { bookId: "grade9", limit: 10 });
  const exam = taxonomy.classifyQuestion(question, { bookId: "exam_topics", limit: 10 });
  assert.equal(grade9.find(item => item.id === "9-13-2")?.confirmed, true);
  assert.ok(grade9.some(item => item.id === "9-13-3") || grade9.length > 1);
  assert.ok(exam.some(item => item.id === "exam-thermal"));
});
