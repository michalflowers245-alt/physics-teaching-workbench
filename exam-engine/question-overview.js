(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QuestionOverview = api;
})(globalThis, function () {
  "use strict";

  const dimensions = { type: "卷面题型", mainPoint: "考点", physicalModel: "具体考法" };
  const clean = value => String(value ?? "").trim();
  const order = (a, b) => b.year.localeCompare(a.year, "zh-CN", { numeric: true })
    || a.region.localeCompare(b.region, "zh-CN")
    || clean(a.question.questionNo).localeCompare(clean(b.question.questionNo), "zh-CN", { numeric: true });

  function build(engine, filters = {}) {
    const exams = new Map((engine.canonicalExams || []).filter(exam => !exam.mergedInto).map(exam => [exam.id, exam]));
    const files = new Map((engine.files || []).map(file => [file.id, file]));
    const dimension = Object.hasOwn(dimensions, filters.dimension) ? filters.dimension : "physicalModel";
    const rows = [];
    for (const question of engine.questions || []) {
      const exam = exams.get(question.canonicalExamId);
      if (!exam || question.generated || question.excluded || question.mergedInto || question.mergedIntoQuestionId) continue;
      const year = clean(exam.year || question.year);
      const region = clean(question.region || exam.region);
      const layer = clean(exam.sourceLayer || question.sourceLayer);
      const examType = clean(exam.examType || question.examType);
      const source = files.get(question.sourceFileId);
      // A shared examination can apply to several cities and should still count once.
      const paper = JSON.stringify([layer, year, exam.paperOriginId || exam.sharedPaperId || exam.originExamId || exam.id]);
      rows.push({ question, year, region, layer, examType, source, paper });
    }
    const facets = {
      years: [...new Set(rows.map(row => row.year).filter(Boolean))].sort((a, b) => Number(b) - Number(a)),
      regions: [...new Set(rows.map(row => row.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"))
    };
    const scoped = rows.filter(row => (!filters.region || row.region === filters.region)
      && (!filters.year || row.year === filters.year) && (!filters.layer || row.layer === filters.layer));
    const sections = new Map();
    for (const row of scoped) {
      const { layer, examType, question } = row;
      const sectionKey = JSON.stringify([layer, examType]);
      if (!sections.has(sectionKey)) sections.set(sectionKey, { layer, examType, items: [], groups: new Map() });
      const section = sections.get(sectionKey);
      section.items.push(row);
      const raw = clean(question[dimension]);
      const label = !raw || /^待|^(无|未知)$/.test(raw) ? "尚未分类" : raw;
      if (!section.groups.has(label)) section.groups.set(label, []);
      section.groups.get(label).push(row);
    }
    const checked = items => items.filter(({ question }) => {
      const review = question.classificationReview;
      return review?.status === "source_checked" && Object.keys(dimensions).every(field => review.labels?.[field] === question[field]);
    }).length;
    const papers = items => new Set(items.map(row => row.paper)).size;
    const grouped = Array.from(sections.values()).sort((a, b) => a.layer.localeCompare(b.layer)).map(section => ({
      layer: section.layer,
      examType: section.examType,
      questions: section.items.length,
      papers: papers(section.items),
      checked: checked(section.items),
      groups: Array.from(section.groups, ([label, items]) => ({
        id: JSON.stringify([section.layer, section.examType, label]), label,
        questions: items.length, papers: papers(items), checked: checked(items), items: items.sort(order)
      })).sort((a, b) => Number(a.label === "尚未分类") - Number(b.label === "尚未分类")
        || b.papers - a.papers || b.questions - a.questions || a.label.localeCompare(b.label, "zh-CN"))
    }));
    return { total: rows.length, count: scoped.length, facets, dimension, sections: grouped };
  }

  return { dimensions, build };
});
