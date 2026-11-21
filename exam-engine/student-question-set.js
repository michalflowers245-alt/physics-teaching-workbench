/*
 * Shared, deliberately small contract for student-facing question sheets.
 *
 * This module is loaded by the teacher iframe as a browser global and by the
 * local Node server as CommonJS.  It only knows the explicit student-safe
 * fields: it must never become a convenient way to serialize a whole question
 * record (which contains answers, source PDFs and teacher-only notes).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StudentQuestionSets = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const ID = /^[a-zA-Z0-9_-]{8,250}$/;
  const SET_ID = /^[a-zA-Z0-9_-]{8,250}$/;
  const STATUS = new Set(["draft", "ready", "archived"]);

  const str = value => value == null ? "" : String(value).trim();
  const list = value => Array.isArray(value) ? value : [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const stableHash = value => {
    let hash = 2166136261;
    for (const char of String(value || "")) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  const questionId = question => str(question?.questionId || question?.question_id || question?.id);
  const validScore = value => Number.isFinite(Number(value)) && Number(value) > 0;
  const validQuestionNo = value => /^(?:第\s*)?[1-9]\d*(?:[-－—.．][1-9]\d*|[（(][1-9]\d*[）)])?(?:\s*题)?$/.test(str(value));
  const ORIGINAL_CROP_VERSION = /^page-assets-backfill-v[23]$/;
  const MAX_SOURCE_PAGE_RANGE = 20;
  const hasSourceIdentity = question => Boolean(str(question?.sourceFileId) || str(question?.canonicalExamId));
  const hasGeneratedSourceConflict = question => question?.generated === true && (hasSourceIdentity(question) || list(question?.sourceSpans).length > 0 || question?.pageNo != null);

  function normalizeOptions(value) {
    return list(value).map((option, index) => {
      if (typeof option === "string") {
        const match = option.match(/^\s*([A-D])\s*[.．、:：]?\s*(.*)$/i);
        return match ? { label: match[1].toUpperCase(), text: str(match[2]) } : { label: String.fromCharCode(65 + index), text: str(option) };
      }
      const label = str(option?.label || option?.key || String.fromCharCode(65 + index)).toUpperCase();
      const text = str(option?.text || option?.content || option?.value);
      return /^[A-D]$/.test(label) && text ? { label, text } : null;
    }).filter(Boolean);
  }

  function normalizeTables(question) {
    const values = question?.tables || question?.dataTables || question?.tableStructure || [];
    return list(values).flatMap(value => {
      let table = value;
      if (typeof table === "string") {
        try { table = JSON.parse(table); } catch { return []; }
      }
      if (!table || typeof table !== "object" || !Array.isArray(table.rows)) return [];
      const headers = list(table.headers).map(cell => str(cell)).filter(Boolean).slice(0, 30);
      const rows = table.rows.slice(0, 100).map(row => list(row).map(cell => str(cell).slice(0, 1000)).slice(0, 30));
      if (!headers.length && !rows.length) return [];
      return [{ headers, rows }];
    });
  }

  function safeImageAssets(question) {
    // A derived crop is not student-safe merely because it exists.  The
    // teacher must explicitly verify the crop itself (not just the textual
    // fields) before any visual material crosses this boundary.
    if (question?.imageReviewed !== true) return [];
    return list(question?.imageAssets).filter(asset => asset && asset.kind === "question-crop" && ID.test(str(asset.id || asset.assetId)) && (asset.exportApproved === true || asset.teachingSafe === true)).slice().sort((left, right) => (Number(left.pageNo) || 0) - (Number(right.pageNo) || 0)).map((asset, index) => ({
      assetId: str(asset.id || asset.assetId),
      alt: `题目必要图示 ${index + 1}`,
      // Internal readiness metadata only. studentQuestionDTO deliberately
      // strips it so the public sheet contract stays minimal.
      pageNo: Number(asset.pageNo),
      generatedBy: str(asset.generatedBy),
    }));
  }

  function requiresVisual(question) {
    return question?.imageReviewRequired === true || question?.requiresImage === true;
  }

  function sourcePageNumbers(question) {
    const seen = new Set();
    for (const span of list(question?.sourceSpans)) {
      const pageNo = Number(span?.pageNo);
      if (Number.isInteger(pageNo) && pageNo > 0) seen.add(pageNo);
    }
    const fallback = Number(question?.pageNo);
    if (!seen.size && Number.isInteger(fallback) && fallback > 0) seen.add(fallback);
    const pages = [...seen].sort((left, right) => left - right);
    // PDF text extraction can omit an image-only continuation page. Every
    // page between the first and last source span must therefore be covered.
    if (pages.length > 1 && pages.at(-1) - pages[0] < MAX_SOURCE_PAGE_RANGE) {
      return Array.from({ length: pages.at(-1) - pages[0] + 1 }, (_, index) => pages[0] + index);
    }
    return pages;
  }

  // Draft selection is a teacher workflow, not permission to render a
  // student sheet. Original crops may be selected before their visual review
  // as long as the teacher can inspect every part of the original question.
  function previewImageAssets(question) {
    return list(question?.imageAssets).filter(asset => asset && asset.kind === "question-crop" && ID.test(str(asset.id || asset.assetId))).slice().sort((left, right) => (Number(left.pageNo) || 0) - (Number(right.pageNo) || 0)).map((asset, index) => ({
      assetId: str(asset.id || asset.assetId),
      alt: `原题单题预览 ${index + 1}`,
      pageNo: Number(asset.pageNo),
    }));
  }

  function reviewChecklist(question, { imageAssets = safeImageAssets(question) } = {}) {
    const items = [];
    const item = (code, label, done, issue) => items.push({ code, label, done: Boolean(done), issue: done ? "" : issue });
    item("active_question", "题目可用状态", !question?.excluded && !str(question?.mergedIntoQuestionId), "题目已撤出或合并，不能用于学生卷");
    item("teacher_review", "教师逐题确认", question?.reviewed && str(question?.reviewedBy) && str(question?.reviewedAt), "尚未完成教师逐题确认");
    item("question_id", "统一题目编号", ID.test(questionId(question)), "题目ID缺失或无效");
    item("stem", "题干完整", str(question?.stem), "题干缺失");
    item("answer", "教师答案", str(question?.answer), "教师答案缺失");
    item("score", "题目分值", validScore(question?.score), "分值缺失");
    item("question_number", "原题题号", validQuestionNo(question?.questionNo), str(question?.questionNo) ? "题号无效，疑似切题异常" : "题号缺失");
    if (hasGeneratedSourceConflict(question)) item("source_identity", "题目来源身份", false, "原创题与原卷来源冲突，须核对题目身份");
    const cropPages = new Set(imageAssets.map(asset => Number(asset?.pageNo)).filter(Number.isInteger));
    const sourcePages = question?.generated === true ? [] : sourcePageNumbers(question);
    if (sourcePages.length > 1 && sourcePages.at(-1) - sourcePages[0] >= MAX_SOURCE_PAGE_RANGE) {
      item("source_page_range", "跨页题来源范围", false, "题目来源跨页范围异常，须核对页码");
    }
    for (const pageNo of sourcePages) {
      item(`source_crop_${pageNo}`, `原题第 ${pageNo} 页裁图`, cropPages.has(pageNo), `原题第 ${pageNo} 页裁图尚未审核`);
    }
    if (!sourcePages.length && question?.generated !== true && hasSourceIdentity(question)) {
      item("source_pages", "原题来源页码", false, "原题来源页码缺失");
    }
    if (requiresVisual(question) && !sourcePages.length) {
      item("visual", "必要题图", imageAssets.length > 0, "必要题图尚未审核为学生安全裁图");
    }
    return items;
  }

  function draftEligibility(question) {
    const issues = [];
    const imageAssets = previewImageAssets(question);
    const pages = question?.generated === true ? [] : sourcePageNumbers(question);
    const cropPages = new Set(imageAssets.map(asset => asset.pageNo));
    if (question?.excluded || str(question?.mergedIntoQuestionId)) issues.push("题目已撤出或合并，请选择有效原题");
    if (!ID.test(questionId(question))) issues.push("题目ID缺失或无效");
    if (!validQuestionNo(question?.questionNo)) issues.push(str(question?.questionNo) ? "题号无效，疑似切题异常" : "题号缺失");
    if (hasGeneratedSourceConflict(question)) issues.push("原创题与原卷来源冲突，须核对题目身份");
    if (pages.length > 1 && pages.at(-1) - pages[0] >= MAX_SOURCE_PAGE_RANGE) issues.push("题目来源跨页范围异常，须核对页码");
    if (pages.length) {
      const missing = pages.filter(pageNo => !cropPages.has(pageNo));
      if (missing.length) issues.push(`原题第 ${missing.join("、")} 页尚无完整单题预览`);
    } else if (question?.generated !== true && hasSourceIdentity(question)) {
      issues.push("原题来源页码缺失，暂不能确认是否完整");
    } else {
      if (!str(question?.stem)) issues.push("题干缺失");
      if (requiresVisual(question) && !imageAssets.length) issues.push("必要题图缺失");
    }
    const check = readiness(question);
    return { selectable: !issues.length, issues, ready: check.ready, reviewIssues: check.issues, imageAssets };
  }

  function contentMode(question, { imageAssets = safeImageAssets(question) } = {}) {
    if (question?.generated === true || question?.imageReviewed !== true || !str(question?.sourceFileId)) return "structured";
    const pages = sourcePageNumbers(question);
    if (!pages.length || !imageAssets.length || !imageAssets.every(asset => ORIGINAL_CROP_VERSION.test(str(asset.generatedBy)))) return "structured";
    const cropPages = new Set(imageAssets.map(asset => Number(asset.pageNo)));
    return pages.every(pageNo => cropPages.has(pageNo)) ? "original" : "structured";
  }

  /**
   * Student readiness intentionally does not require a teacher explanation or
   * a rubric.  Those are teacher/training requirements, not prerequisites for
   * letting a student work an otherwise complete, reviewed source question.
   */
  function readiness(question, { imageAssets = safeImageAssets(question) } = {}) {
    // A source question is only complete when every source page has its own
    // teacher-approved crop.  This prevents a text-only OCR record from
    // silently dropping a diagram, table, continuation or a small condition.
    const issues = reviewChecklist(question, { imageAssets }).filter(item => !item.done).map(item => item.issue);
    return { ready: !issues.length, issues, imageAssets };
  }

  function contentHash(question, options = {}) {
    const assets = options.imageAssets || safeImageAssets(question);
    return stableHash(JSON.stringify({
      id: questionId(question),
      reviewedAt: str(question?.reviewedAt),
      questionNo: str(question?.questionNo),
      score: validScore(question?.score) ? Number(question.score) : null,
      type: str(question?.type),
      stem: str(question?.stem),
      options: normalizeOptions(question?.options),
      tables: normalizeTables(question),
      images: assets.map(asset => str(asset.assetId || asset.id)),
      contentMode: contentMode(question, { imageAssets: assets }),
    }));
  }

  /** Return an explicit allow-list DTO. Do not add convenience spreads here. */
  function studentQuestionDTO(question, { imageAssets = safeImageAssets(question) } = {}) {
    const check = readiness(question, { imageAssets });
    if (!check.ready) throw new Error(check.issues.join("；"));
    const dto = {
      questionNo: str(question.questionNo),
      score: Number(question.score),
      stem: str(question.stem),
      options: normalizeOptions(question.options),
      tables: normalizeTables(question),
      imageAssets: imageAssets.map((asset, index) => ({ assetId: str(asset.assetId || asset.id), alt: str(asset.alt) || `题目必要图示 ${index + 1}` })),
    };
    if (contentMode(question, { imageAssets }) === "original") dto.contentMode = "original";
    return dto;
  }

  function normalizeRefs(value) {
    const seen = new Set();
    return list(value).flatMap(ref => {
      const questionIdValue = str(ref?.questionId || ref?.id || ref);
      if (!ID.test(questionIdValue) || seen.has(questionIdValue)) return [];
      seen.add(questionIdValue);
      return [{ questionId: questionIdValue, contentHash: str(ref?.contentHash) }];
    });
  }

  function questionSetIssues(set, questionMap, { assetLookup } = {}) {
    const issues = [];
    if (!set || !SET_ID.test(str(set.id))) issues.push("题单ID无效");
    if (!str(set?.title) || str(set.title).length > 120) issues.push("题单标题无效");
    if (!STATUS.has(str(set?.status || "draft"))) issues.push("题单状态无效");
    const refs = normalizeRefs(set?.questionRefs);
    if (refs.length !== list(set?.questionRefs).length) issues.push("题单题目引用重复或无效");
    if (refs.length > 100) issues.push("一份学生题单最多100题");
    for (const ref of refs) {
      const question = questionMap instanceof Map ? questionMap.get(ref.questionId) : questionMap?.[ref.questionId];
      if (!question) { issues.push(`题单引用了不存在的题目 ${ref.questionId}`); continue; }
      const assets = assetLookup ? assetLookup(question) : safeImageAssets(question);
      const check = readiness(question, { imageAssets: assets });
      if (str(set?.status) === "ready" && !check.ready) issues.push(`题目 ${ref.questionId} 不可用于学生卷：${check.issues.join("、")}`);
      if (str(set?.status) === "ready" && ref.contentHash !== contentHash(question, { imageAssets: assets })) issues.push(`题目 ${ref.questionId} 已变更，需重新确认题单`);
    }
    if (str(set?.status) === "ready") {
      if (!refs.length) issues.push("学生题单至少需要1道题");
      if (!str(set?.publishedAt) || !str(set?.publishedBy)) issues.push("学生题单缺少教师确认记录");
    }
    return issues;
  }

  function questionSetReviewSummary(set, questions, { assetLookup } = {}) {
    const questionMap = questions instanceof Map ? questions : Array.isArray(questions)
      ? new Map(questions.map(question => [questionId(question), question])) : questions || {};
    const refs = normalizeRefs(set?.questionRefs);
    const items = refs.map(ref => {
      const question = questionMap instanceof Map ? questionMap.get(ref.questionId) : questionMap[ref.questionId];
      if (!question) return { questionId: ref.questionId, ready: false, selectable: false, issues: ["题目不存在"], checklist: [] };
      const checklist = reviewChecklist(question, assetLookup ? { imageAssets: assetLookup(question) } : {});
      const issues = checklist.filter(item => !item.done).map(item => item.issue);
      return { questionId: ref.questionId, ready: !issues.length, selectable: draftEligibility(question).selectable, issues, checklist };
    });
    const readyCount = items.filter(item => item.ready).length;
    return {
      totalCount: items.length,
      readyCount,
      pendingCount: items.length - readyCount,
      // Publication still needs a new local confirmation and fresh hashes;
      // this flag means the selected content is ready for that final action.
      contentReady: items.length > 0 && readyCount === items.length && refs.length === list(set?.questionRefs).length && refs.length <= 100,
      items,
    };
  }

  function studentSetDTO(set, questions, { assetLookup } = {}) {
    if (!set || str(set.status) !== "ready") throw new Error("题单尚未经教师确认，不能交给学生");
    const questionMap = questions instanceof Map ? questions : new Map(list(questions).map(question => [questionId(question), question]));
    const issues = questionSetIssues(set, questionMap, { assetLookup });
    if (issues.length) throw new Error(issues.join("；"));
    return {
      schemaVersion: "student-question-set-v1",
      id: str(set.id),
      title: str(set.title),
      questionCount: normalizeRefs(set.questionRefs).length,
      questions: normalizeRefs(set.questionRefs).map(ref => {
        const question = questionMap.get(ref.questionId);
        const images = assetLookup ? assetLookup(question) : safeImageAssets(question);
        return studentQuestionDTO(question, { imageAssets: images });
      }),
    };
  }

  return Object.freeze({
    ID,
    STATUS,
    validQuestionNo,
    normalizeOptions,
    normalizeTables,
    safeImageAssets,
    previewImageAssets,
    requiresVisual,
    sourcePageNumbers,
    draftEligibility,
    reviewChecklist,
    contentMode,
    readiness,
    contentHash,
    studentQuestionDTO,
    normalizeRefs,
    questionSetIssues,
    questionSetReviewSummary,
    studentSetDTO,
    clone,
  });
});
