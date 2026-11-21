/* Pure, versioned domain rules. No network, storage, or DOM side effects. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ExamDomain = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const ALGORITHM_VERSION = "changsha-evidence-v2.0.0";
  const HUNAN_CITIES = new Set(["株洲", "湘潭", "衡阳", "邵阳", "岳阳", "常德", "张家界", "益阳", "郴州", "永州", "怀化", "娄底", "湘西", "湘西土家族苗族自治州"]);
  const REQUIRED = ["questionNo", "pageNo", "score", "type", "stem", "options", "answer", "mainPoint", "secondaryPoints", "abilities", "physicalModel", "method", "confusedConcepts", "traps", "estimatedDifficulty", "sourceSpans"];
  const uniq = (values) => [...new Set(values)];
  const array = (v) => Array.isArray(v) ? v : [];
  const clean = (v) => String(v == null ? "" : v).trim();
  const validTag = (v) => Boolean(clean(v)) && !/^(待标注|待确认|未知|无|待补充)$/.test(clean(v));
  const points = (q, dimension = "knowledge") => uniq((dimension === "abilities" ? array(q.abilities) : [q.mainPoint, ...array(q.secondaryPoints)]).filter(validTag).map(clean));
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const mean = (xs) => xs.length ? sum(xs) / xs.length : null;
  const number = (v) => v === null || v === undefined || clean(v) === "" || !Number.isFinite(Number(v)) ? null : Number(v);
  const positive = (v) => number(v) > 0 ? number(v) : null;
  const round = (v) => v == null ? null : Math.round(v * 100) / 100;
  const regionName = (v) => clean(v).replace(/^湖南省/, "").replace(/市$/, "");
  const percent = (v) => v == null ? "未知" : `${Math.round(v * 1000) / 10}%`;
  const group = (values, key) => { const m = new Map(); for (const value of values) { const k = key(value); if (!m.has(k)) m.set(k, []); m.get(k).push(value); } return m; };
  const distribution = (values) => [...group(values.filter((v) => v !== null && v !== undefined && v !== ""), (v) => String(v))].map(([label, rows]) => ({ label, count: rows.length }));
  const distributionText = (values) => distribution(values).map((r) => `${r.label}×${r.count}`).join("；");
  const SHA256_K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function sha256(text) {
    const bytes = new TextEncoder().encode(text), length = bytes.length, padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
    padded.set(bytes); padded[length] = 128;
    const view = new DataView(padded.buffer); view.setUint32(padded.length - 8, Math.floor(length / 0x20000000)); view.setUint32(padded.length - 4, (length * 8) >>> 0);
    const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], w = new Uint32Array(64), r = (x,n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < padded.length; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) { const a=w[i-15],b=w[i-2]; w[i] = ((r(a,7)^r(a,18)^(a>>>3)) + w[i-16] + (r(b,17)^r(b,19)^(b>>>10)) + w[i-7]) >>> 0; }
      let [a,b,c,d,e,f,g,k] = h;
      for (let i=0;i<64;i++) { const t1=(k+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+SHA256_K[i]+w[i])>>>0,t2=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))>>>0; k=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
      for (const [i,v] of [a,b,c,d,e,f,g,k].entries()) h[i]=(h[i]+v)>>>0;
    }
    return h.map(x=>x.toString(16).padStart(8,'0')).join('');
  }
  function stableId(prefix, ...parts) {
    // Unicode is never stripped. Bound IDs to SQLite's public 250-character limit.
    const payload = encodeURIComponent(JSON.stringify(parts.map(clean)));
    return `${prefix}_${payload.length <= 180 ? payload : `sha256_${sha256(JSON.stringify(parts.map(clean)))}`}`;
  }
  function stableString(value) {
    if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableString(value[k])}`).join(",")}}`;
    return JSON.stringify(value);
  }
  function fingerprint(value) {
    const text = stableString(value);
    let h1 = 2166136261, h2 = 2654435761;
    for (let i = 0; i < text.length; i++) { h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619); h2 = Math.imul(h2 ^ text.charCodeAt(i), 2246822507); }
    return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}-${text.length}`;
  }
  function longestConsecutive(years) {
    let previous = null, current = 0, best = 0;
    for (const year of uniq(years).sort((a, b) => a - b)) { current = previous === year - 1 ? current + 1 : 1; best = Math.max(best, current); previous = year; }
    return best;
  }
  function validateSource(source) {
    const layer = source.sourceLayer, region = regionName(source.region), errors = [];
    if (!["A", "B", "C", "D", "E"].includes(layer)) errors.push("来源层级必须是 A—E");
    if (layer === "A" && (region !== "长沙" || source.examType !== "中考原卷")) errors.push("A 类必须为长沙中考原卷");
    if (layer === "B" && (!HUNAN_CITIES.has(region) || source.examType !== "中考原卷")) errors.push("B 类必须为湖南其他地市中考原卷");
    if (layer === "C" && region !== "长沙") errors.push("C 类仅包含长沙学校或集团试卷");
    if (["A", "B", "C"].includes(layer) && (!Number.isInteger(number(source.year)) || Number(source.year) < 1980 || Number(source.year) > new Date().getFullYear() + 1)) errors.push("考试年份无效");
    return { valid: !errors.length, errors };
  }
  function reviewed(q) { return q.reviewed === true && Boolean(q.reviewedBy) && Boolean(q.reviewedAt) && !q.excluded && !q.mergedInto && !q.migrationNeedsReview; }
  function sourceYear(q, exams) { return Number(exams.get(q.canonicalExamId)?.year); }
  function resolveQuestionId(id, engine) {
    const aliases = new Map(array(engine.questionAliases).map((a) => [a.id, a.targetId]));
    return resolveAlias(id, aliases);
  }
  function resolveAlias(id, aliases) {
    const seen = new Set();
    while (aliases.has(id) && !seen.has(id)) { seen.add(id); id = aliases.get(id); }
    return seen.has(id) ? "" : id;
  }
  const independentExamKey = (e) => stableId("exam-source", e.year, e.paperOriginId || e.sharedPaperId || e.originExamId || e.id);
  const applicableRegions = (e) => uniq([regionName(e.region), ...array(e.applicableRegions).map(regionName)].filter(Boolean));
  function formalData(engine, layer) {
    const qGroups = group(array(engine.questions).filter((q) => !q.excluded && !q.mergedInto), (q) => q.canonicalExamId);
    const eligible = array(engine.canonicalExams).filter((e) => e.sourceLayer === layer && validateSource(e).valid && !e.mergedInto && e.dedupeStatus === "confirmed" && (e.completenessConfirmed === true || e.complete === true) && (qGroups.get(e.id) || []).length && (qGroups.get(e.id) || []).every(reviewed));
    // Same paper origin/year within a city is one exam, even when multiple reviewed canonical records remain.
    // Across cities retain applicability for comparison, while sample counts use independentExamKey separately.
    const exams = [...group(eligible, (e) => stableId("city-exam", regionName(e.region), independentExamKey(e)))].map(([, members]) => ({ ...members[0], independentExamKey: independentExamKey(members[0]), sourceCanonicalExamIds: members.map((e) => e.id), applicableRegions: uniq(members.flatMap(applicableRegions)) }));
    const ids = new Set(exams.map((e) => e.id)), byId = new Map(exams.map((e) => [e.id, e]));
    const seen = new Set();
    const questions = array(engine.questions).filter((q) => {
      if (!ids.has(q.canonicalExamId) || !reviewed(q) || q.sourceLayer !== layer) return false;
      const key = `${q.canonicalExamId}|${q.id}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    }).map((q) => ({ ...q, year: String(byId.get(q.canonicalExamId).year), region: regionName(byId.get(q.canonicalExamId).region), independentExamKey: byId.get(q.canonicalExamId).independentExamKey, sourceCanonicalExamIds: byId.get(q.canonicalExamId).sourceCanonicalExamIds, applicableRegions: byId.get(q.canonicalExamId).applicableRegions }));
    return { exams, questions };
  }
  function makeWindow(exams, latest, span) {
    const years = latest ? Array.from({ length: span }, (_, i) => latest - span + 1 + i) : [];
    const available = new Set(exams.map((e) => Number(e.year)));
    return { years, missingYears: years.filter((y) => !available.has(y)), complete: years.length === span && years.every((y) => available.has(y)) };
  }
  function allocatedScore(q, point, dimension) {
    const score = positive(q.score);
    if (score == null) return null;
    const explicit = q.scoreAllocations?.[dimension];
    if (explicit && typeof explicit === "object") {
      const tags = points(q, dimension);
      if (Array.isArray(explicit) || Object.keys(explicit).some((key) => !tags.includes(clean(key)))) return null;
      const vals = Object.values(explicit).map(number);
      if (vals.some((v) => v == null || v < 0) || Math.abs(sum(vals) - score) > 0.001) return null;
      return sum(Object.entries(explicit).filter(([key]) => clean(key) === point).map(([, value]) => Number(value)));
    }
    if (dimension === "abilities") { const tags = points(q, dimension); return tags.includes(point) ? score / tags.length : 0; }
    return clean(q.mainPoint) === point ? score : 0;
  }
  function scoreCompleteness(questions, exams, dimension) {
    const grouped = group(questions, (q) => q.canonicalExamId);
    return exams.length > 0 && exams.every((e) => {
      const qs = grouped.get(e.id) || [];
      if (!qs.length || qs.some((q) => positive(q.score) == null || !points(q, dimension).length || points(q, dimension).some((p) => allocatedScore(q, p, dimension) == null))) return false;
      const total = positive(e.totalScore ?? e.physicsTotalScore);
      return total == null || Math.abs(sum(qs.map((q) => Number(q.score))) - total) < 0.001;
    });
  }
  function rankDimension(questions, exams, dimension = "knowledge", cutoff) {
    if (!exams.length) return [];
    const latest = cutoff || Math.max(...exams.map((e) => Number(e.year)));
    const history = exams.filter((e) => Number(e.year) <= latest), examMap = new Map(history.map((e) => [e.id, e]));
    const validQs = questions.filter((q) => examMap.has(q.canonicalExamId));
    const window5 = makeWindow(history, latest, 5), window3 = makeWindow(history, latest, 3);
    const fiveExams = history.filter((e) => window5.years.includes(Number(e.year))), fiveIds = new Set(fiveExams.map((e) => e.id));
    const fiveQs = validQs.filter((q) => fiveIds.has(q.canonicalExamId));
    const historyYears = uniq(history.map((e) => Number(e.year)));
    const fullScores = scoreCompleteness(fiveQs, fiveExams, dimension);
    const allScore = fullScores ? sum(fiveQs.map((q) => Number(q.score))) : null;
    const allByExam = group(validQs, (q) => q.canonicalExamId), position = new Map();
    for (const [examId, rows] of allByExam) rows.slice().sort((a, b) => Number.parseFloat(a.questionNo) - Number.parseFloat(b.questionNo) || String(a.questionNo).localeCompare(String(b.questionNo))).forEach((q, i) => position.set(`${examId}|${q.id}`, Math.min(4, Math.floor(i * 5 / rows.length))));
    const groups = new Map();
    for (const q of validQs) for (const point of points(q, dimension)) { if (!groups.has(point)) groups.set(point, []); groups.get(point).push(q); }
    return [...groups].map(([point, rows]) => {
      const examIds = uniq(rows.map((q) => q.canonicalExamId)), years = uniq(rows.map((q) => sourceYear(q, examMap))).sort((a, b) => a - b);
      const recent = rows.filter((q) => fiveIds.has(q.canonicalExamId));
      const sampleFiveCoverage = fiveExams.length ? uniq(recent.map((q) => q.canonicalExamId)).length / fiveExams.length : null;
      const fiveCoverage = window5.complete ? sampleFiveCoverage : null;
      const continuity = window3.complete ? longestConsecutive(years.filter((y) => window3.years.includes(y))) / 3 : null;
      const historicalCoverage = years.length / historyYears.length;
      const scoreShare = window5.complete && allScore ? sum(recent.map((q) => allocatedScore(q, point, dimension))) / allScore : null;
      const locations = distribution(recent.map((q) => `${q.type}:${position.get(`${q.canonicalExamId}|${q.id}`)}`));
      const stability = window5.complete ? (recent.length ? Math.max(...locations.map((r) => r.count)) / recent.length : 0) : null;
      const modelKeys = recent.filter((q) => validTag(q.type) && validTag(q.physicalModel) && validTag(q.method)).map((q) => `${q.type}|${q.physicalModel}|${q.method}`);
      const diversity = window5.complete ? Math.min(1, new Set(modelKeys).size / 4) : null;
      const raw = { fiveCoverage, continuity, historicalCoverage, scoreShare, stability, diversity };
      const missing = Object.keys(raw).filter((k) => raw[k] == null);
      const index = missing.length ? null : round(100 * (fiveCoverage * 0.3 + continuity * 0.2 + historicalCoverage * 0.15 + scoreShare * 0.15 + stability * 0.1 + diversity * 0.1));
      const confidence = { level: index == null ? "low" : historyYears.length >= 10 ? "high" : "medium", label: index == null ? "证据不足" : historyYears.length >= 10 ? "证据充分" : "证据中等", reasons: [window5.missingYears.length ? `缺少 ${window5.missingYears.join("、")} 年完整原卷` : "五年原卷完整", fullScores ? "分值资料完整" : "分值或分值归属资料不完整", "全部入榜试题经过教师确认"], isProbability: false };
      return { point, index, status: index == null ? "insufficient" : "formal", examCount: examIds.length, sampleSize: history.length, years: years.map(String), consecutiveYears: longestConsecutive(years), questionRefs: rows.slice().sort((a, b) => Number(b.year) - Number(a.year) || Number.parseFloat(a.questionNo) - Number.parseFloat(b.questionNo)).map((question) => ({ question, questionId: question.id, canonicalExamId: question.canonicalExamId, year: question.year, questionNo: question.questionNo, pageNo: question.pageNo, sourceSpans: array(question.sourceSpans), sourceFileId: question.sourceFileId })), typeDistribution: distributionText(rows.map((q) => q.type || "待确认")), scoreDistribution: distributionText(rows.map((q) => positive(q.score) == null ? "分值未知" : `${q.score}分`)), distributions: { types: distribution(rows.map((q) => q.type)), scores: distribution(rows.map((q) => positive(q.score) == null ? "未知" : q.score)) }, confidence, raw, sampleFiveCoverage, missingComponents: missing, questions: rows, window3, window5 };
    }).sort((a, b) => (b.index ?? -1) - (a.index ?? -1) || b.examCount - a.examCount || a.point.localeCompare(b.point, "zh-Hans-CN"));
  }
  function buildTrends(questions, exams, span, cutoff) {
    const window = makeWindow(exams, cutoff, span), known = new Set(exams.map((e) => Number(e.year)));
    const groups = new Map();
    for (const q of questions.filter((q) => window.years.includes(Number(q.year)))) for (const point of points(q)) { if (!groups.has(point)) groups.set(point, []); groups.get(point).push(q); }
    return [...groups].map(([point, rows]) => {
      const byYear = window.years.map((year) => ({ year, count: known.has(year) ? rows.filter((q) => Number(q.year) === year).length : null, status: known.has(year) ? "known" : "unknown" }));
      const active = byYear.filter((r) => r.count > 0).map((r) => r.year);
      let label = "窗口内间歇出现", direction = "sample";
      if (!window.complete) { label = "数据不足，缺失年份未知"; direction = "unknown"; }
      else if (active.length === span) { label = "连续稳定出现"; direction = "stable"; }
      else if (longestConsecutive(active) >= 2 && active.includes(cutoff) && active.includes(cutoff - 1)) { label = "近年持续出现"; direction = "stable"; }
      else if (active.length === 1 && active[0] === cutoff) { label = "本窗口仅最近一年出现"; direction = "sample"; }
      return { point, direction, label, byYear, missingYears: window.missingYears, complete: window.complete, consecutiveYears: longestConsecutive(active), evidence: byYear.map((r) => `${r.year} 年 ${r.count == null ? "未知（缺原卷）" : `${r.count}题`}`).join("；") };
    }).sort((a, b) => b.consecutiveYears - a.consecutiveYears || a.point.localeCompare(b.point, "zh-Hans-CN"));
  }
  function hunanComparison(knowledge, questions, exams, cutoff) {
    const byCity = new Map();
    for (const e of exams.filter((e) => Number(e.year) <= cutoff)) for (const city of applicableRegions(e).filter((city) => HUNAN_CITIES.has(city))) { if (!byCity.has(city)) byCity.set(city, []); if (!byCity.get(city).some((prior) => independentExamKey(prior) === independentExamKey(e))) byCity.get(city).push(e); }
    const cityData = [...byCity].map(([city, cityExams]) => { const ids = new Set(cityExams.map((e) => e.id)); const qs = questions.filter((q) => ids.has(q.canonicalExamId)); return { city, exams: cityExams, questions: qs, complete: makeWindow(cityExams, cutoff, 5).complete && scoreCompleteness(qs.filter((q) => Number(q.year) >= cutoff - 4), cityExams.filter((e) => Number(e.year) >= cutoff - 4), "knowledge"), rows: new Map(rankDimension(qs, cityExams, "knowledge", cutoff).map((r) => [r.point, r])) }; });
    const completeCities = cityData.filter((c) => c.complete);
    const tags = uniq([...knowledge.map((r) => r.point), ...questions.flatMap((q) => points(q))]);
    const cs = new Map(knowledge.map((r) => [r.point, r]));
    return tags.map((point) => {
      const appearances = questions.filter((q) => points(q).includes(point) && Number(q.year) >= cutoff - 4 && Number(q.year) <= cutoff);
      const eligible = completeCities.map((c) => ({ city: c.city, index: c.rows.get(point)?.index ?? 0 }));
      // Shared provincial/joint papers can describe cities but are not independent city evidence.
      const signatures = new Set(completeCities.map((c) => c.exams.filter((e) => Number(e.year) >= cutoff - 4).map(independentExamKey).sort().join("|")));
      const enough = eligible.length >= 3 && signatures.size >= 3;
      const commonIndex = enough ? round(mean(eligible.map((r) => r.index))) : null;
      const specialtyIndex = commonIndex != null && cs.get(point)?.index != null ? round(cs.get(point).index - commonIndex) : null;
      return { point, commonIndex, specialtyIndex, hunanExamCount: uniq(appearances.map((q) => q.independentExamKey || q.canonicalExamId)).length, regions: uniq(appearances.flatMap((q) => applicableRegions(q))).filter((city) => HUNAN_CITIES.has(city)), years: uniq(appearances.map((q) => q.year)).sort(), independentSourceGroups: signatures.size, comparisonCities: eligible, sampleCoverageByCity: cityData.map((c) => ({ city: c.city, coverage: c.rows.get(point)?.sampleFiveCoverage ?? (c.exams.length ? 0 : null), missingYears: makeWindow(c.exams, cutoff, 5).missingYears })), note: enough ? "同一五年窗口、城市等权；特色指数为长沙指数减其他城市均值；同年同命题来源仅计一次独立样本" : "不足3个具有完整同窗资料的独立地市样本，仅展示样本对照；共用卷不增加独立命题样本" };
    }).sort((a, b) => (b.commonIndex ?? -1) - (a.commonIndex ?? -1) || b.hunanExamCount - a.hunanExamCount);
  }
  function expectedRisk(q) {
    const weights = { "概念易混": 14, "条件隐藏/临界状态": 12, "多步骤推理": 12, "电路状态变化": 16, "图表信息提取": 10, "实验设计与控制变量": 11, "单位/比例关系": 8, "多知识点综合": 12 };
    const signals = uniq(array(q.structuralSignals));
    const stem = clean(q.stem);
    for (const [pattern, signal] of [[/易混|辨别|区分|不同/, "概念易混"], [/恰好|刚好|至少|最多|临界/, "条件隐藏/临界状态"], [/滑动|开关|热敏|压敏|力敏/, "电路状态变化"], [/图像|图表|表格|曲线/, "图表信息提取"], [/实验|控制变量|设计/, "实验设计与控制变量"], [/单位|比例|倍/, "单位/比例关系"]]) if (pattern.test(stem) && !signals.includes(signal)) signals.push(signal);
    const score = Math.min(100, sum(signals.map((s) => weights[s] || 0)) + (Number(q.estimatedDifficulty) >= 4 ? 12 : 0) + (array(q.options).length >= 4 ? 5 : 0) + (array(q.confusedConcepts).length ? 7 : 0) + (array(q.traps).length >= 2 ? 6 : 0));
    return { score, label: "AI预计易错", signals, traps: array(q.traps), isErrorRate: false };
  }
  function normalizeResponse(value, options = {}) {
    const text = clean(value), lower = text.toLowerCase();
    if (/^(√|✓|✔|对|正确|ok|-)$/.test(lower) || (!options.wrongOnly && /^(true|是|1)$/.test(lower))) return { outcome: "correct", isCorrect: true, isBlank: false, errorOption: "" };
    if (/^(空|空题|未答|未作答|漏答|blank|x)$/.test(lower)) return { outcome: "blank", isCorrect: false, isBlank: true, errorOption: "" };
    if (/^(\?|？|未知|看不清|待确认|未核对|未识别|待核验|无法确认)$/.test(lower)) return { outcome: "unknown", isCorrect: null, isBlank: null, errorOption: text };
    if (!text) return options.blankMeansCorrect === true ? { outcome: "correct", isCorrect: true, isBlank: false, errorOption: "" } : { outcome: "unknown", isCorrect: null, isBlank: null, errorOption: "" };
    if (/^(×|✗|错|错误|false|否|0)$/.test(lower)) return { outcome: "incorrect", isCorrect: false, isBlank: false, errorOption: "" };
    return options.wrongOnly === true ? { outcome: "incorrect", isCorrect: false, isBlank: false, errorOption: text } : { outcome: "unknown", isCorrect: null, isBlank: null, errorOption: text };
  }
  function outcome(a) {
    const earned = number(a.earnedScore), max = positive(a.maxScore);
    if (clean(a.earnedScore) !== "" && clean(a.maxScore) !== "" && (earned == null || max == null || earned < 0 || earned > max)) return { isCorrect: null, earnedRatio: null };
    if (earned != null && max != null && earned >= 0 && earned <= max) return { isCorrect: earned === max, earnedRatio: earned / max };
    if (a.isBlank === true) return { isCorrect: false, earnedRatio: 0 };
    return { isCorrect: typeof a.isCorrect === "boolean" ? a.isCorrect : null, earnedRatio: typeof a.isCorrect === "boolean" ? Number(a.isCorrect) : null };
  }
  function attemptIdentity(a) { return stableId("response", a.classId, a.studentId, a.sessionId, a.questionId, a.partId || "whole", a.round || "1"); }
  function activeAttempts(engine) {
    const questions = new Map(array(engine.questions).filter(activeQuestion).map((q) => [q.id, q]));
    const aliases = new Map(array(engine.questionAliases).map((a) => [a.id, a.targetId]));
    const active = new Map();
    for (const a of array(engine.attempts)) {
      if (a.sourceLayer !== "E" || a.manualVerified !== true || a.verificationStatus !== "verified" || !a.verifiedBy || !a.verifiedAt || !a.studentId || !a.classId || !a.sessionId || a.revokedAt || a.supersededBy || a.migrationNeedsReview) continue;
      const questionId = resolveAlias(a.questionId, aliases);
      const question = questions.get(questionId);
      if (!question || outcome(a).isCorrect == null) continue;
      if (a.source === "E-课前测人工校对") {
        const binding = engine.settings?.reviewedPaperBindings?.[a.sessionId];
        if (!a.paperIdentity || a.paperIdentity !== binding?.paperIdentity || question.canonicalExamId !== binding.examId ||
            !eligiblePaperQuestion(question) || paperQuestionNo(a.partId) !== paperQuestionNo(question.questionNo)) continue;
        if (engine.panelEvidence && engine.panelEvidence[a.sessionId] !== a.sourceFingerprint) continue;
      }
      const row = { ...a, questionId, ...outcome(a) }, key = attemptIdentity(row), previous = active.get(key);
      if (!previous || Number(a.revision || 1) > Number(previous.revision || 1) || (Number(a.revision || 1) === Number(previous.revision || 1) && String(a.verifiedAt) > String(previous.verifiedAt))) active.set(key, row);
    }
    return [...active.values()];
  }
  function audit(engine, entityId, action, detail = {}) {
    engine.auditEvents ||= [];
    const now = new Date().toISOString();
    engine.auditEvents.push({ id: stableId("audit", entityId, action, now, engine.auditEvents.length), entityId, ...(detail.entityIds ? { entityIds: detail.entityIds } : {}), entityType: "student_attempt", status: action === "verified" || action === "wrongbook_verified" ? "confirmed" : action === "revoked" ? "revoked" : "draft", reviewer: "local_teacher", action, at: now, payload: detail });
  }
  function persistMastery(engine) {
    engine.mastery = buildMastery(engine);
    engine.masteryRecords = [...engine.mastery.studentRows.map((r) => ({ ...r, kind: "student" })), ...engine.mastery.classRows.map((r) => ({ ...r, id: stableId("masteryclass", r.classId, r.point), kind: "class" }))];
    return engine.mastery;
  }
  function verifyAttempt(engine, id, reviewer = "local_teacher") {
    const a = array(engine.attempts).find((item) => item.id === id);
    if (!a) throw new Error("作答记录不存在");
    if (a.sourceLayer !== "E" || !clean(reviewer) || !a.studentId || !a.classId || !a.sessionId || !array(engine.questions).some((q) => q.id === resolveQuestionId(a.questionId, engine) && activeQuestion(q)) || outcome(a).isCorrect == null) throw new Error("请先确认学生、班级、课次、统一题目ID与正误");
    if (a.verificationStatus === "superseded") throw new Error("旧版本不可重新确认，请确认最新草稿");
    const normalizedId = resolveQuestionId(a.questionId, engine);
    if (activeAttempts(engine).some((other) => other.id !== a.id && attemptIdentity(other) === attemptIdentity({ ...a, questionId: normalizedId }))) throw new Error("该班级学生在此课次、题目和轮次已有已核验作答，请修改已有记录，不能重复确认");
    Object.assign(a, outcome(a));
    a.migrationNeedsReview = false;
    a.verificationStatus = "verified"; a.manualVerified = true; a.verifiedAt = new Date().toISOString(); a.verifiedBy = clean(reviewer); a.revokedAt = ""; a.revision = Number(a.revision || 0) + 1;
    audit(engine, a.id, "verified", { reviewer: a.verifiedBy, revision: a.revision, payload: { ...a } });
    persistMastery(engine);
    return a;
  }
  function revokeAttempt(engine, id, reason = "原始数据或映射发生变更", reviewer = "local_teacher", deferMastery = false) {
    const a = array(engine.attempts).find((item) => item.id === id);
    if (!a || a.verificationStatus !== "verified") return false;
    a.manualVerified = false; a.verificationStatus = "revoked"; a.revokedAt = new Date().toISOString(); a.revokedReason = reason;
    audit(engine, id, "revoked", { reason, reviewer, previousVerifiedAt: a.verifiedAt });
    if (!deferMastery) persistMastery(engine);
    return true;
  }
  function wilson(wrong, total) {
    if (!total) return null;
    const z = 1.959963984540054, p = wrong / total, divisor = 1 + z * z / total;
    const centre = (p + z * z / (2 * total)) / divisor, delta = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / divisor;
    return { lower: Math.max(0, centre - delta), upper: Math.min(1, centre + delta), confidence: 0.95, method: "Wilson", numerator: wrong, denominator: total };
  }
  const timeCache = new WeakMap();
  const eventTime = (a) => { const raw = clean(a.attemptedAt || a.answeredAt || a.sessionDate || a.importedAt || a.verifiedAt), cached = timeCache.get(a); if (cached?.raw === raw) return cached.value; const value = Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : raw; timeCache.set(a, { raw, value }); return value; };
  function combineQuestionParts(rows) {
    return [...group(rows, (a) => stableId("sitting", a.classId, a.studentId, a.sessionId, a.questionId, a.round || "1"))].map(([, parts]) => {
      if (parts.length === 1) return parts[0];
      const scored = parts.every((a) => number(a.earnedScore) != null && positive(a.maxScore) != null);
      const timed = parts.every((a) => number(a.timeSeconds) != null);
      return { ...parts[0], isCorrect: parts.every((a) => a.isCorrect), isBlank: parts.every((a) => typeof a.isBlank === "boolean") ? parts.every((a) => a.isBlank) : null, earnedRatio: scored ? sum(parts.map((a) => Number(a.earnedScore))) / sum(parts.map((a) => Number(a.maxScore))) : mean(parts.map((a) => a.earnedRatio ?? Number(a.isCorrect))), timeSeconds: timed ? sum(parts.map((a) => Number(a.timeSeconds))) : null, errorOption: parts.filter((a) => !a.isCorrect).map((a) => `${a.partId}: ${a.errorOption || (a.isBlank ? "空题" : "错误")}`).join("；"), sourceAttemptIds: parts.map((a) => a.id) };
    });
  }
  function rankActualErrors(attempts, questions, engine = {}) {
    const qs = new Map(questions.map((q) => [q.id, q])), baselines = new Map(attempts.map((a) => [a.id, a]));
    const plans = new Map(array(engine.trainingPlans).map((p) => [p.id, p]));
    return [...group(attempts, (a) => a.questionId)].filter(([id]) => qs.has(id)).map(([id, rows]) => {
      const sorted = combineQuestionParts(rows).sort((a, b) => eventTime(a).localeCompare(eventTime(b)) || String(a.id).localeCompare(String(b.id)));
      const studentGroups = group(sorted, (a) => stableId("learner", a.classId, a.studentId));
      const first = [...studentGroups.values()].map((all) => all[0]), wrong = first.filter((a) => !a.isCorrect);
      const timed = first.filter((a) => number(a.timeSeconds) != null && number(a.timeSeconds) >= 0), blank = first.filter((a) => typeof a.isBlank === "boolean");
      const repeatEligible = [...studentGroups.values()].filter((all) => new Set(all.map((a) => a.sessionId)).size >= 2);
      const repeated = repeatEligible.filter((all) => new Set(all.filter((a) => !a.isCorrect).map((a) => a.sessionId)).size >= 2);
      const retests = rows.filter((a) => {
        if (!a.isRetest || !a.trainingPlanId || !a.trainingItemId || !a.baselineAttemptId) return false;
        const baseline = baselines.get(a.baselineAttemptId), plan = plans.get(a.trainingPlanId);
        return baseline && !baseline.isCorrect && baseline.studentId === a.studentId && baseline.classId === a.classId && plan && plan.completedAt && array(plan.baselineAttemptIds).includes(a.baselineAttemptId) && array(plan.items).some((i) => (i.id || i.questionId || i.question?.id) === a.trainingItemId && (i.questionId || i.question?.id) === a.questionId && i.stageKey === "retest" && Number.isFinite(Date.parse(i.dueAt)) && Date.parse(eventTime(a)) >= Date.parse(i.dueAt)) && Date.parse(eventTime(a)) > Date.parse(eventTime(baseline)) && Date.parse(eventTime(a)) >= Date.parse(plan.completedAt);
      });
      const retestWrong = retests.filter((a) => !a.isCorrect).length;
      return { question: qs.get(id), total: first.length, uniqueStudents: first.length, attemptCount: rows.length, wrongCount: wrong.length, wrongRate: first.length ? wrong.length / first.length : null, wrongRateInterval: wilson(wrong.length, first.length), rateBasis: "每名学生对此题首次有效核验作答；未得满分含明确空题计错", optionDistribution: distributionText(wrong.map((a) => a.isBlank ? "空题" : a.errorOption || a.studentAnswer || "未注明")), averageTime: mean(timed.map((a) => Number(a.timeSeconds))), timeSampleSize: timed.length, blankRate: blank.length ? blank.filter((a) => a.isBlank).length / blank.length : null, blankNumerator: blank.filter((a) => a.isBlank).length, blankDenominator: blank.length, repeatRate: repeatEligible.length ? repeated.length / repeatEligible.length : null, repeatNumerator: repeated.length, repeatDenominator: repeatEligible.length, retestFailureRate: retests.length ? retestWrong / retests.length : null, retestNumerator: retestWrong, retestDenominator: retests.length, errorSteps: distributionText(rows.filter((a) => !a.isCorrect).map((a) => a.errorStep)), firstAttemptIds: first.map((a) => a.id), smallSample: first.length < 30 };
    }).sort((a, b) => (b.wrongRateInterval?.lower || 0) - (a.wrongRateInterval?.lower || 0) || b.total - a.total);
  }
  function buildMastery(engine) {
    const qs = new Map(array(engine.questions).map((q) => [q.id, q])), attempts = activeAttempts(engine), groups = new Map();
    for (const a of attempts) for (const point of points(qs.get(a.questionId))) { const key = stableId("mastery", a.classId, a.studentId, point); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(a); }
    const studentRows = [...groups].map(([id, values]) => {
      const rows = values.slice().sort((a, b) => eventTime(b).localeCompare(eventTime(a)) || String(b.id).localeCompare(String(a.id))).slice(0, 10), last = rows[0];
      const mastery = Math.round(mean(rows.map((a) => a.earnedRatio)) * 100);
      const modelGroups = group(rows.filter((a) => !a.isCorrect), (a) => qs.get(a.questionId).errorModelId || qs.get(a.questionId).physicalModel || qs.get(a.questionId).mainPoint);
      const recurringModels = [...modelGroups].filter(([, evidence]) => new Set(evidence.map((a) => a.sessionId)).size >= 2).map(([model]) => model);
      const recurring = recurringModels.length > 0;
      const point = points(qs.get(last.questionId)).find((p) => stableId("mastery", last.classId, last.studentId, p) === id);
      return { id, subject: last.studentName || last.studentKey || last.studentId, classId: last.classId, className: last.className || last.classId, studentId: last.studentId, point, mastery, total: rows.length, totalAvailable: values.length, evidenceAttemptIds: rows.map((a) => a.id), recurring, recurringModels, advice: recurring ? "独立课次反复错误：推荐个人修补＋延时回测" : mastery < 60 ? "优先基础修补＋延时回测" : mastery < 80 ? "安排易错辨析与变式" : "保持回测观察" };
    }).sort((a, b) => a.mastery - b.mastery || b.total - a.total);
    const threshold = number(engine.settings?.classErrorRateThreshold) ?? 0.2, minStudents = positive(engine.settings?.classErrorMinStudents) ?? 3;
    const classRows = [...group(studentRows, (r) => stableId("classpoint", r.classId, r.point))].map(([, rows]) => {
      const wrongStudents = rows.filter((r) => r.mastery < 100).length, errorRate = wrongStudents / rows.length;
      return { subject: rows[0].className, classId: rows[0].classId, point: rows[0].point, mastery: Math.round(mean(rows.map((r) => r.mastery))), total: sum(rows.map((r) => r.total)), students: rows.length, wrongStudents, errorRate, recommended: wrongStudents >= minStudents && errorRate >= threshold, advice: wrongStudents >= minStudents && errorRate >= threshold ? "班级共性错误：推荐班级专题" : "继续诊断；当前未达到班级共性阈值", evidenceAttemptIds: rows.flatMap((r) => r.evidenceAttemptIds) };
    }).sort((a, b) => a.mastery - b.mastery);
    return { version: 1, policy: "最近10次有效核验作答平均得分率；班级按学生等权", classRows, studentRows, thresholds: { version: engine.settings?.thresholdVersion || 1, classErrorRateThreshold: threshold, classErrorMinStudents: minStudents } };
  }
  function lessonKey(state, archive) {
    if (archive?.sessionId) return archive.sessionId;
    const lesson = archive || state.lesson || {};
    return (!archive && state.sessionId) || [lesson.gradeId, lesson.year, lesson.term, lesson.lessonNo].map(value => encodeURIComponent(clean(value))).join("|");
  }
  function activeQuestion(question) {
    return question && !question.excluded && !question.mergedInto && !question.mergedIntoQuestionId && !question.migrationNeedsReview;
  }
  function eligiblePaperQuestion(question) {
    return activeQuestion(question) && reviewed(question) && !question.generated && Boolean(question.sourceFileId) &&
      Boolean(question.canonicalExamId) && validTag(question.stem) && validTag(question.answer) && Boolean(paperQuestionNo(question.questionNo));
  }
  function paperQuestionNo(value) {
    const number = clean(value).normalize("NFKC").replace(/^第\s*/, "").replace(/\s*题$/, "").replace(/\s/g, "");
    const match = /^(\d+)(?:[.(\-](\d+)\)?)?$/.exec(number);
    return match && Number(match[1]) > 0 ? [Number(match[1]), match[2] == null ? null : Number(match[2])].filter(part => part !== null).join(".") : "";
  }
  function reviewedPaperMapping(engine, book, knowledge = {}) {
    const binding = engine.settings?.reviewedPaperBindings?.[book.sessionId];
    const exam = array(engine.canonicalExams).find(item => item.id === binding?.examId);
    if (!binding || !book.paperIdentity || book.paperIdentity !== binding.paperIdentity ||
        !exam || exam.mergedInto || exam.candidateOf || exam.migrationNeedsReview) return new Map();
    const groups = group(array(engine.questions).filter(question => question.canonicalExamId === exam.id && activeQuestion(question)), q => paperQuestionNo(q.questionNo));
    const columns = group(array(book.columns), paperQuestionNo);
    const result = new Map();
    for (const [number, labels] of columns) {
      const candidates = groups.get(number) || [];
      if (!number || labels.length !== 1 || candidates.length !== 1 || !eligiblePaperQuestion(candidates[0])) continue;
      const question = candidates[0], standard = knowledge[labels[0]], answer = clean(standard?.answer ?? standard).normalize("NFKC").toUpperCase();
      const sourceAnswer = clean(question.answer).normalize("NFKC").toUpperCase();
      const choice = /^[A-D]{1,4}$/;
      if (choice.test(answer) && choice.test(sourceAnswer) && [...answer].sort().join("") !== [...sourceAnswer].sort().join("")) continue;
      result.set(labels[0], question);
    }
    return result;
  }
  function reviewedRowAttendance(row) {
    if (/^(请假|缺考|未考|未参加)$/.test(clean(row.status))) return "absent";
    return row.checked && clean(row.score) !== "" && number(row.score) != null ? "present" : "unverified";
  }
  function reviewedRowResponse(row, column) {
    if (reviewedRowAttendance(row) !== "present") return { outcome: "unknown", isCorrect: null, isBlank: null, errorOption: "" };
    const answer = row.answers?.[column];
    // A recorded score and whole-row confirmation give empty wrong-only cells meaning.
    return normalizeResponse(answer, { blankMeansCorrect: true, wrongOnly: true });
  }
  function wrongbookContext(state, archive) {
    const book = archive || state.wrongbook || {}, engine = state.examEngine || {}, lesson = state.lesson || {};
    const key = lessonKey(state, archive), grade = array(state.grades).find((g) => g.id === (archive?.gradeId || lesson.gradeId) || (archive?.gradeName && g.name === archive.gradeName));
    const className = archive?.className || grade?.name || archive?.gradeName || "未选班级";
    const classId = book.classId || archive?.gradeId || grade?.id || lesson.gradeId || "";
    const sessionId = book.sessionId || key;
    const mapping = reviewedPaperMapping(engine, { ...book, sessionId }, state.knowledge);
    return { book, engine, key, classId, className, sessionId, mapping };
  }
  function wrongbookFingerprint(context, state) {
    return fingerprint({ classId: context.classId, sessionId: context.sessionId, paperIdentity: context.book.paperIdentity, columns: array(context.book.columns), mapping: [...context.mapping].map(([key,q]) => [key,q.id,q.reviewedAt]), rows: array(context.book.rows).map((r) => ({ studentId: r.studentId || "", status: r.status, score: r.score, answers: r.answers, checked: r.checked })), confirmed: context.book.confirmed === true, standards: state.knowledge || {}, questionSpec: state.lesson?.questionSpec || "" });
  }
  function panelAttemptEvidence(state) {
    if (!state.wrongbook?.confirmed) return "";
    return wrongbookFingerprint(wrongbookContext(state), state);
  }
  function reconcileWrongbook(state) {
    if (!state.examEngine?.attempts?.length || !state.wrongbook) return { revoked: 0 };
    const context = wrongbookContext(state), signature = wrongbookFingerprint(context, state);
    let revoked = 0;
    for (const a of context.engine.attempts) if (a.source === "E-课前测人工校对" && a.sessionId === context.sessionId && a.verificationStatus === "verified" && (a.sourceFingerprint !== signature || context.book.confirmed !== true || array(context.book.rows).some((r) => !r.checked))) { if (revokeAttempt(context.engine, a.id, "错题表、标准答案、评分或题号映射变更，需重新人工确认", "local_teacher", true)) revoked++; }
    if (revoked) persistMastery(context.engine);
    return { revoked };
  }
  function ingestVerifiedWrongbook(state, archive = null) {
    state.examEngine ||= {}; const engine = state.examEngine; engine.attempts ||= [];
    const context = wrongbookContext(state, archive), { book, key, classId, className, sessionId, mapping } = context;
    const rows = array(book.rows);
    if (!book.confirmed || !rows.length || rows.some((r) => !r.checked)) { const revoked = archive ? 0 : reconcileWrongbook(state).revoked; return { imported: 0, revoked, message: "全表未完成人工校验，未写入真实易错统计。" }; }
    if (!classId) return { imported: 0, message: "缺少班级身份，请先选择班级后重新确认。" };
    const sameNames = group(rows, (r) => clean(r.name));
    if ([...sameNames.values()].some((rs) => rs.length > 1 && rs.some((r) => !r.studentId))) return { imported: 0, message: "同一班级存在同名学生，请先填写独立学生ID，避免误合并。" };
    const studentIds = rows.map((r) => r.studentId || stableId("student", classId, r.name));
    if (studentIds.some((id) => !clean(id)) || new Set(studentIds).size !== rows.length) return { imported: 0, message: "学生ID重复或缺失，请为每名学生填写不同的稳定ID。" };
    const revoked = archive ? 0 : reconcileWrongbook(state).revoked;
    if (!mapping.size) return { imported: 0, revoked, message: "尚无有效题号映射。请回到本次试卷的逐生诊断确认原卷。" };
    for (const row of rows) row.studentId ||= stableId("student", classId, row.name);
    book.classId = classId; book.sessionId = sessionId; book.sessionKey = key;
    // This panel explicitly records wrong answers only; its full-table confirmation gives blanks meaning.
    book.responseSemantics = "wrong-only-blank-correct";
    if (state.wrongbook && lessonKey(state) === key) { state.wrongbook.classId = classId; state.wrongbook.sessionId = sessionId; state.wrongbook.sessionKey = key; state.wrongbook.responseSemantics = book.responseSemantics; for (const row of array(state.wrongbook.rows)) row.studentId ||= rows.find((r) => r.name === row.name)?.studentId; }
    const signature = wrongbookFingerprint(context, state), now = new Date().toISOString();
    if (engine.panelEvidence) engine.panelEvidence[sessionId] = signature;
    let imported = 0, unchanged = 0; const verifiedIds = [];
    const existing = new Map();
    for (const a of engine.attempts.filter((a) => a.sessionId === sessionId)) { const key = attemptIdentity(a), prior = existing.get(key); if (!prior || Number(a.revision || 0) > Number(prior.revision || 0) || (Number(a.revision || 0) === Number(prior.revision || 0) && clean(a.verifiedAt) > clean(prior.verifiedAt))) existing.set(key, a); }
    for (const row of rows) for (const [column, question] of mapping) {
      const questionId = question.id, normalized = reviewedRowResponse(row, column);
      if (normalized.isCorrect == null) continue;
      const candidate = { classId, className, studentId: row.studentId, studentKey: row.name, studentName: row.name, sessionId, questionId, partId: column, round: "1" }, keyId = attemptIdentity(candidate), prior = existing.get(keyId);
      if (prior?.verificationStatus === "verified" && prior.sourceFingerprint === signature) { unchanged++; continue; }
      if (prior && prior.verificationStatus === "verified") revokeAttempt(engine, prior.id, "同一作答已重新人工校验", "local_teacher", true);
      const revision = Number(prior?.revision || 0) + 1;
      const id = stableId("attempt", keyId, revision);
      if (prior) { prior.verificationStatus = "superseded"; prior.manualVerified = false; prior.supersededBy = id; }
      const attempt = { ...candidate, ...normalized, id, revision, sourceLayer: "E", source: "E-课前测人工校对", sourceRecordId: sessionId, sourceFingerprint: signature, paperIdentity: book.paperIdentity, responseSemantics: book.responseSemantics, verificationStatus: "verified", manualVerified: true, verifiedAt: now, verifiedBy: "local_teacher", importedAt: now, attemptedAt: prior?.attemptedAt || prior?.importedAt || book.attemptedAt || archive?.savedAt || now, errorStep: "", timeSeconds: null };
      engine.attempts.push(attempt); existing.set(keyId, attempt); verifiedIds.push(id); imported++;
    }
    // Removed columns or mappings cannot leave the former answer active.
    for (const a of engine.attempts) if (a.source === "E-课前测人工校对" && a.sessionId === sessionId && a.verificationStatus === "verified" && a.sourceFingerprint !== signature) revokeAttempt(engine, a.id, "课次重新核验后映射或学生记录已移除", "local_teacher", true);
    audit(engine, sessionId, "wrongbook_verified", { imported, unchanged, entityIds: verifiedIds, sourceFingerprint: signature });
    persistMastery(engine);
    return { imported, unchanged, message: `已写入 ${imported} 条人工核验作答；${unchanged} 条已存在记录未重复计入。掌握度已更新。` };
  }
  function parseCsv(text) {
    const rows = []; let row = [], cell = "", quoted = false;
    for (let i = 0; i < text.length; i++) { const ch = text[i]; if (ch === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; } else if (!quoted && ch === ",") { row.push(cell); cell = ""; } else if (!quoted && (ch === "\n" || ch === "\r")) { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); if (row.some((s) => clean(s))) rows.push(row); row = []; cell = ""; } else cell += ch; }
    if (quoted) throw new Error("CSV引号未闭合"); row.push(cell); if (row.some((s) => clean(s))) rows.push(row); return rows;
  }
  function importAttemptCsv(text, engine) {
    const rows = parseCsv(String(text).replace(/^\uFEFF/, "")); if (rows.length < 2) throw new Error("CSV内容为空或只有表头");
    const header = rows.shift().map(clean), get = (row, names) => { const index = header.findIndex((h) => names.includes(h)); return index < 0 ? "" : clean(row[index]); };
    if (!header.some((h) => ["question_id", "题目ID", "题目id"].includes(h)) || !header.some((h) => ["student_id", "学生ID", "学生", "姓名"].includes(h))) throw new Error("CSV至少需要 question_id、student_id 或姓名；所有记录将进入待审核区");
    const result = rows.map((row) => {
      const student = get(row, ["student_id", "学生ID"]), name = get(row, ["学生", "姓名", "student_name"]) || student;
      const classId = get(row, ["class_id", "班级ID", "班级"]), sessionId = get(row, ["session_id", "课次ID", "课次"]), questionId = get(row, ["question_id", "题目ID", "题目id"]);
      const normalized = normalizeResponse(get(row, ["是否正确", "is_correct", "作答正确"]));
      const blank = normalizeResponse(get(row, ["空题", "is_blank"]));
      return { questionId, studentId: student || (classId && name ? stableId("student", classId, name) : ""), studentKey: name, studentName: name, classId, sessionId, partId: get(row, ["part_id", "小问ID"]) || "whole", round: get(row, ["round", "轮次"]) || "1", externalRecordId: get(row, ["record_id", "记录ID"]), ...normalized, isBlank: blank.isCorrect === true ? true : blank.isCorrect === false ? false : normalized.isBlank, errorOption: get(row, ["错误选项", "错误答案", "student_answer"]), timeSeconds: number(get(row, ["作答用时秒", "time_seconds", "用时"])), earnedScore: number(get(row, ["earned_score", "得分"])), maxScore: number(get(row, ["max_score", "满分"])), isRetest: normalizeResponse(get(row, ["回测", "is_retest"])).isCorrect === true, trainingPlanId: get(row, ["training_plan_id", "训练ID"]), trainingItemId: get(row, ["training_item_id", "训练题ID"]), baselineAttemptId: get(row, ["baseline_attempt_id", "前测作答ID"]), errorStep: get(row, ["错误步骤", "error_step"]), attemptedAt: get(row, ["attempted_at", "作答时间"]), claimedTeacherVerified: get(row, ["人工校验确认", "teacher_verified", "人工确认"]) };
    });
    return importAttemptRows(result, engine);
  }
  function importAttemptRows(rows, engine) {
    engine.attempts ||= []; let total = 0, unchanged = 0, unmatched = 0;
    const questions = new Set(array(engine.questions).map((q) => q.id)), ids = new Map(engine.attempts.map((a) => [a.importIdentity, a]));
    for (const row of rows) {
      const payload = { ...row }; delete payload.claimedTeacherVerified;
      const importIdentity = row.externalRecordId ? stableId("csvrecord", row.classId, row.sessionId, row.externalRecordId) : (row.classId && row.sessionId && row.studentId && row.questionId ? attemptIdentity(row) : stableId("csvdraft", stableString(payload)));
      const signature = fingerprint(payload), prior = ids.get(importIdentity);
      if (prior?.sourceFingerprint === signature) { unchanged++; continue; }
      const id = stableId("csv", importIdentity, Number(prior?.revision || 0) + 1);
      if (prior) { revokeAttempt(engine, prior.id, "CSV同一作答内容变更", "local_teacher", true); prior.verificationStatus = "superseded"; prior.manualVerified = false; prior.supersededBy = id; }
      const attempt = { ...row, id, importIdentity, sourceFingerprint: signature, revision: Number(prior?.revision || 0) + 1, sourceLayer: "E", source: "E-CSV导入", sourceRecordId: row.sessionId || "csv-draft", manualVerified: false, verificationStatus: "draft", verifiedAt: "", verifiedBy: "", importedAt: new Date().toISOString(), attemptedAt: row.attemptedAt || prior?.attemptedAt || prior?.importedAt || "", validationBlockedReason: !questions.has(row.questionId) ? "question_id未匹配，等待人工映射" : !row.classId || !row.studentId || !row.sessionId ? "请补充班级、学生及课次身份后人工确认" : "CSV中的确认文字不是审核凭证，请教师核验" };
      engine.attempts.push(attempt); ids.set(importIdentity, attempt); total++; if (!questions.has(row.questionId)) unmatched++;
    }
    audit(engine, "csv-import", "draft_imported", { total, unchanged, unmatched }); persistMastery(engine);
    return { total, confirmed: 0, unchanged, unmatched };
  }
  function buildQuality(engine, exams, attempts) {
    const mergedExamIds = new Set(array(engine.canonicalExams).filter((e) => e.mergedInto).map((e) => e.id));
    const questions = array(engine.questions).filter((q) => !q.excluded && !q.mergedInto && !mergedExamIds.has(q.canonicalExamId) && !q.generated), files = array(engine.files), reviewedCount = questions.filter(reviewed).length;
    const draftAttempts = array(engine.attempts).filter((a) => a.verificationStatus === "draft" || !a.verificationStatus);
    const issues = [];
    if (!exams.length) issues.push("A类完整审核、去重确认的长沙中考原卷为0，不能形成正式高频结论。");
    if (reviewedCount < questions.length) issues.push(`${questions.length - reviewedCount}道试题未完成可追溯教师审核，已排除正式统计。`);
    const unresolved = array(engine.canonicalExams).filter((e) => !e.mergedInto && (e.dedupeStatus !== "confirmed" || !(e.complete || e.completenessConfirmed)));
    if (unresolved.length) issues.push(`${unresolved.length}套试卷尚待去重或完整性确认。`);
    if (questions.some((q) => positive(q.score) == null)) issues.push("存在缺失分值；保持未知，不以1分或0分替代。");
    if (files.some((f) => !f.originalAsset?.persistent)) issues.push("存在尚未持久保存的原件；需补齐原件资产。");
    if (draftAttempts.length) issues.push(`${draftAttempts.length}条作答缺少完整审核身份，不进入真实易错统计。`);
    if (!attempts.length) issues.push("没有可用的教师核验E类作答，真实易错榜为空；AI预计不替代实测。");
    const filled = questions.reduce((total, q) => total + REQUIRED.filter((key) => q[key] != null && (Array.isArray(q[key]) ? ["options", "secondaryPoints", "confusedConcepts", "traps"].includes(key) || q[key].length : clean(q[key]) !== "")).length, 0);
    return { files: files.length, canonicalExams: array(engine.canonicalExams).filter((e) => !e.mergedInto).length, duplicateFiles: files.filter((f) => ["duplicate", "duplicate_confirmed"].includes(f.status)).length, assetsPersistent: files.filter((f) => f.originalAsset?.persistent).length, questions: questions.length, reviewedQuestions: reviewedCount, fieldCompleteness: questions.length ? Math.round(filled / (questions.length * REQUIRED.length) * 100) : 0, confirmedAttempts: attempts.length, unconfirmedAttempts: draftAttempts.length, reviewPending: questions.length - reviewedCount + draftAttempts.length + unresolved.length, issues, expectedDuplicateChecks: [["2023", 2], ["2024", 2], ["2025", 3]].map(([year, expected]) => { const matches = files.filter((f) => f.sourceLayer === "A" && regionName(f.region) === "长沙" && String(f.year) === year); const independent = exams.filter((e) => String(e.year) === year).length; return `${year}年：预期${expected}个版本，已导入${matches.length}个，正式独立考试${independent}套；${matches.length >= expected && independent === 1 ? "版本数量及去重结果符合预期" : "待真实资料核验"}`; }) };
  }
  function buildFourAnswers(report) {
    const top = report.knowledge.find((r) => r.index != null), ability = report.abilities.find((r) => r.index != null), actual = report.actualErrors.find((r) => r.wrongCount > 0), topic = report.recommendedTopics[0];
    const hasImportedQuestions = report.quality?.questions > 0;
    return [
      { title: "长沙中考经常考什么？", answer: top ? `截至${report.metadata.cutoffYear}年的已审样本中，“${top.point}”高频指数为${top.index}。` : "当前完整年份或分值数据不足，不能判断长沙长期高频；样本出现记录可供核查。", evidence: top ? `${top.examCount}套独立原卷；${top.years.join("、")}年。` : "请补齐连续年份原卷并完成审核。" },
      { title: "它通常采用什么方式考？", answer: ability ? `已审样本中常见能力为“${ability.point}”，题型分布：${ability.typeDistribution}。` : "当前数据不足以判断通常的命题方式。", evidence: ability ? `${ability.examCount}套独立原卷；${ability.confidence.label}。` : "请核验题型、模型、方法和能力标签。" },
      { title: "学生最可能错在哪里？", answer: actual ? `教师确认的首次作答中，“${actual.question.mainPoint || "此题"}”错误率${percent(actual.wrongRate)}（${actual.wrongCount}/${actual.total}名学生）。` : report.expectedErrors.length ? `当前没有真实错误证据；AI预计“${report.expectedErrors[0].question.mainPoint}”存在结构风险，需诊断题验证。` : hasImportedQuestions ? "题目已收录，仍待教师核验；没有有效学生作答证据，当前不足以判断真实易错。" : "没有可用的作答与题目数据。", evidence: actual ? `95% Wilson区间${percent(actual.wrongRateInterval.lower)}—${percent(actual.wrongRateInterval.upper)}；小样本谨慎解释。` : "AI预计易错不是实测错误率。" },
      { title: "下一步应该生成什么专题训练？", answer: topic ? `建议围绕“${topic.point}”生成19题错误模型专题，先诊断，再修补及延时回测。` : hasImportedQuestions ? "可以先按知识点查看已收录原题并加入题单草稿；核验选中题后再交给学生。专题优先级仍需正式统计证据。" : "先导入、去重并审核原卷；已有作答需完成身份映射和教师核验。", evidence: topic?.reason || "当前不足以给出可靠专题优先级。" },
    ];
  }
  function buildReport(engine) {
    const a = formalData(engine, "A"), b = formalData(engine, "B"), c = formalData(engine, "C");
    const cutoff = positive(engine.settings?.analysisCutoffYear) || (a.exams.length ? Math.max(...a.exams.map((e) => Number(e.year))) : null);
    for (const data of [a, b, c]) if (cutoff) { data.exams = data.exams.filter((e) => Number(e.year) <= cutoff); const ids = new Set(data.exams.map((e) => e.id)); data.questions = data.questions.filter((q) => ids.has(q.canonicalExamId)); }
    const verified = activeAttempts(engine), knowledge = rankDimension(a.questions, a.exams, "knowledge", cutoff), abilities = rankDimension(a.questions, a.exams, "abilities", cutoff);
    const expectedErrors = a.questions.map((question) => ({ question, ...expectedRisk(question) })).sort((x, y) => y.score - x.score);
    const actualErrors = rankActualErrors(verified, array(engine.questions), engine), actualByPoint = new Map();
    for (const row of actualErrors.filter((r) => r.wrongCount > 0)) for (const point of points(row.question)) { if (!actualByPoint.has(point)) actualByPoint.set(point, []); actualByPoint.get(point).push(row); }
    const intersections = knowledge.filter((r) => r.index != null && actualByPoint.has(r.point)).map((row) => { const actual = actualByPoint.get(row.point), wrongCount = sum(actual.map((r) => r.wrongCount)), total = sum(actual.map((r) => r.total)); return { point: row.point, frequencyIndex: row.index, errorEvidence: `教师核验首次作答中有${wrongCount}/${total}条学生—题目错误记录（跨题不视为独立人数）`, reason: "已具备长沙完整窗口频次和真实错误证据；先诊断再针对错因修补", priority: row.index + wrongCount / total * 100, evidenceType: "actual", wrongCount, total }; }).sort((x, y) => y.priority - x.priority);
    const recommendedTopics = [...intersections.map((r) => ({ point: r.point, reason: r.reason, priority: r.priority, evidenceType: "actual" })), ...knowledge.filter((r) => r.index != null && !actualByPoint.has(r.point)).slice(0, 5).map((r) => ({ point: r.point, reason: `完整窗口高频指数${r.index}；先通过诊断验证是否存在漏洞`, priority: r.index, evidenceType: "frequency" }))].sort((x, y) => y.priority - x.priority).slice(0, 12);
    const hunanCompare = cutoff ? hunanComparison(knowledge, b.questions, b.exams, cutoff) : [];
    const quality = buildQuality(engine, a.exams, verified), window3 = makeWindow(a.exams, cutoff, 3), window5 = makeWindow(a.exams, cutoff, 5);
    if (window5.missingYears.length) quality.issues.push(`近五年缺少完整原卷：${window5.missingYears.join("、")}；对应年份未知，加权指数不输出。`);
    const report = { metadata: { algorithmVersion: ALGORITHM_VERSION, dataVersion: engine.revision ?? engine.dataRevision ?? null, cutoffYear: cutoff, generatedAt: new Date().toISOString(), currentCalendarYear: new Date().getFullYear(), window3, window5, policy: "A/B/C/D/E分层；完整教师审核；缺失为未知；非预测概率", sourceExamIds: a.exams.map((e) => e.id), questionIds: a.questions.map((q) => q.id), verifiedAttemptIds: verified.map((a) => a.id) }, samples: { changsha: { exams: a.exams.length, questions: a.questions.length }, hunan: { exams: b.exams.length, questions: b.questions.length, regions: new Set(b.exams.map((e) => regionName(e.region))).size }, localTeaching: { exams: c.exams.length, questions: c.questions.length }, actualAttempts: verified.length }, draftSamples: { exams: array(engine.canonicalExams).filter((e) => !e.mergedInto).length - a.exams.length - b.exams.length - c.exams.length, questions: array(engine.questions).filter((q) => !reviewed(q)).length }, knowledge, abilities, hunan: hunanCompare, hunanCompare, localTeachingFocus: rankDimension(c.questions, c.exams, "knowledge", cutoff).map((r) => ({ ...r, index: Math.round(r.examCount / c.exams.length * 100), status: "local-teaching-only" })), trends3: buildTrends(a.questions, a.exams, 3, cutoff), trends5: buildTrends(a.questions, a.exams, 5, cutoff), expectedErrors, actualErrors, intersections, recommendedTopics, quality, mastery: buildMastery(engine) };
    report.samples.hunan.cityExamRecords = b.exams.length;
    report.samples.hunan.exams = uniq(b.exams.map(independentExamKey)).length;
    report.samples.hunan.regions = uniq(b.exams.flatMap(applicableRegions).filter((city) => HUNAN_CITIES.has(city))).length;
    report.metadata.sourceCanonicalExamIds = uniq(a.exams.flatMap((e) => e.sourceCanonicalExamIds || [e.id]));
    report.metadata.independentSourceKeys = a.exams.map(independentExamKey);
    report.draftSamples.exams = array(engine.canonicalExams).filter((e) => !e.mergedInto && !(e.completenessConfirmed || e.complete)).length;
    report.fourAnswers = buildFourAnswers(report);
    report.sections = { dataQuality: quality, duplicates: { groups: array(engine.duplicateGroups), files: array(engine.files).map((f) => ({ id: f.id, year: f.year, canonicalExamId: f.canonicalExamId, duplicateGroupId: f.duplicateGroupId, status: f.status, evidence: f.dedupeEvidence })), checks: quality.expectedDuplicateChecks }, knowledgeTop: knowledge.slice(0, 20), abilityTop: abilities.slice(0, 20), trends3: report.trends3, trends5: report.trends5, hunanComparison: hunanCompare, aiExpectedErrors: expectedErrors, actualErrors, intersections, recommendedTopics, trainingItems: array(engine.trainingPlans).map((p) => ({ planId: p.id, title: p.title, status: p.status, items: array(p.items).map((i) => ({ id: i.id, questionId: i.questionId || i.question?.id, derivedFromQuestionId: i.derivedFromQuestionId, stage: i.stage, reason: i.reason, detects: i.detects })) })), reviewNeeds: quality.issues };
    return report;
  }
  return { ALGORITHM_VERSION, HUNAN_CITIES: [...HUNAN_CITIES], stableId, fingerprint, validateSource, reviewed, formalData, rankDimension, buildTrends, buildReport, buildFourAnswers, expectedRisk, normalizeResponse, activeAttempts, rankActualErrors, buildMastery, persistMastery, verifyAttempt, revokeAttempt, resolveQuestionId, ingestVerifiedWrongbook, reconcileWrongbook, importAttemptRows, importAttemptCsv, wilson, lessonKey, attemptIdentity, activeQuestion, eligiblePaperQuestion, reviewedPaperMapping, reviewedRowAttendance, reviewedRowResponse, panelAttemptEvidence };
});
