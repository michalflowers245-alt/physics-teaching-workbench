/* Local, deterministic training domain. Generated questions never count as exam evidence. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ExamTraining = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const VERSION = "training-2.0.0";
  const MODEL_ROWS = [
    ["sensor", "热敏压敏力敏电阻与动态电路", "动态电路|传感|热敏|压敏|力敏", "把局部电阻变化误当作总电压变化", "先画串联等效电路，再分别求电流和分压", "欧姆定律", "电路建模"],
    ["heater", "加热保温与高低挡电功率", "加热|保温|电热|挡|电功率计算", "把串联大电阻误判为高功率挡", "固定电源电压，比较各挡等效电阻", "电功率", "电路状态判断"],
    ["wiring", "电表滑动变阻器接线与故障", "接线|故障|电流表|电压表|滑动变阻器", "忽视电压表测量位置和断路两端电压", "按电流路径和电压表两端逐一排查", "电路故障", "实验故障判断"],
    ["lamp", "小灯泡电阻与电功率实验数据", "灯泡|灯丝|测电阻|伏安", "用恒定电阻处理温度变化的灯丝", "逐组计算电阻和功率，额定值对应额定电压", "伏安法", "实验数据分析"],
    ["buoyancy", "压强浮力密度联合计算", "浮力|浮沉|密度|压强", "混用物体体积与排液体积", "先判断浮沉状态，再求排液体积和液体压强", "阿基米德原理", "联合建模"],
    ["machine", "杠杆滑轮机械效率联合计算", "杠杆|滑轮|机械效率", "把绳端路程当作物体升高高度", "辨认承重绳段，区分有用功与总功", "机械效率", "受力与能量计算"],
    ["graph", "实验表格和物理图像分析", "表格|图像|数据|控制变量|异常", "忽略控制变量或把异常点直接取平均", "先核对控制量，再验证数据趋势与异常点", "控制变量法", "数据异常识别"],
    ["forces", "平衡力与相互作用力辨别", "平衡力|相互作用", "忽视两个力是否作用于同一物体", "标明施力物体与受力物体", "二力平衡", "概念辨析"],
    ["inertia", "惯性运动状态和受力关系", "惯性|运动状态|受力关系", "误认为运动必须有同向合力维持", "区分速度与速度变化，惯性只与质量有关", "牛顿第一定律", "因果推理"],
    ["sound", "音调响度音色辨别", "音调|响度|音色|声音", "将频率改变误判为响度改变", "将频率振幅波形分别对应声音特性", "声音特性", "信息对应"],
    ["phase", "物态变化与吸放热判断", "物态变化|吸热|放热|熔化|凝固|汽化|液化|升华|凝华", "把温度不变误认为没有吸热", "先判断前后状态，再判断能量转移", "物态变化", "概念与能量分析"],
    ["electromagnet", "电动机发电机与电磁感应", "电动机|发电机|电磁感应|电磁", "把通电受力与切割磁感线生电混为一谈", "检查电源及能量转化方向", "电磁感应", "装置原理辨析"],
  ];
  const MODELS = MODEL_ROWS.map(([id, name, pattern, misconception, repair, concept, ability]) => Object.freeze({ id, name, pattern, misconception, repair, concept, ability }));
  const STAGES = [
    { key: "diagnosis", name: "概念识别 · 诊断题", count: 2, detects: "核心概念及条件边界" },
    { key: "repair", name: "单一规律应用 · 基础修补题", count: 3, detects: "单一规律与单位换算" },
    { key: "authentic", name: "典型模型 · 真题", count: 4, detects: "长沙原题模型迁移" },
    { key: "trap", name: "易错辨析 · 易错陷阱题", count: 3, detects: "隐藏条件和典型错误步骤" },
    { key: "variation", name: "条件变化 · 变式题", count: 3, detects: "改变条件后的关系重建" },
    { key: "transfer", name: "综合迁移 · 综合题", count: 2, detects: "模型选择与多步骤表达" },
    { key: "retest", name: "回测验证 · 延时回测题", count: 2, detects: "延时保持与纠错稳定性" },
  ];
  const str = value => typeof value === "string" || typeof value === "number" ? String(value) : "";
  const list = value => Array.isArray(value) ? value.map(str).filter(Boolean) : [];
  function options(value) { return Array.isArray(value) ? value.map((v, i) => typeof v === "object" && v ? `${str(v.label || v.key || String.fromCharCode(65 + i))}. ${str(v.text || v.content || v.value)}` : str(v)).filter(Boolean) : value && typeof value === "object" ? Object.entries(value).map(([k, v]) => `${k}. ${str(v)}`) : []; }
  function tablesOf(q) { const raw = q.tables || q.dataTables || q.tableStructure || []; const rows = Array.isArray(raw) ? raw : [raw]; return rows.filter(t => Array.isArray(t?.rows)).map(t => ({ headers: list(t.headers), rows: t.rows.map(list) })); }
  const clone = value => JSON.parse(JSON.stringify(value));
  const fmt = n => Number(n.toFixed(4)).toString();
  function stableId(text) { let h = 2166136261; for (const cp of String(text)) { h ^= cp.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  function modelFor(point, explicit) { return MODELS.find(m => m.id === explicit) || MODELS.find(m => new RegExp(m.pattern).test(point)) || null; }
  function questionId(q) { return str(q.questionId || q.question_id || q.id); }
  function sourceId(q) { return str(q.canonicalExamId || q.canonical_exam_id); }
  function sameQuestion(a, b) { return questionId(a) === questionId(b) || str(a.stem).replace(/\s/g, "") === str(b.stem).replace(/\s/g, ""); }
  function solutionFor(q) { return str(q.teacherExplanation || q.aiExplanation || (q.explanationOrigin === "teacher" || q.explanationOrigin === "ai" ? q.solution : "")); }
  function solutionOrigin(q) { return q.teacherExplanation ? "teacher" : q.aiExplanation ? "ai" : ["teacher", "ai"].includes(q.explanationOrigin) ? q.explanationOrigin : ""; }
  function explanationHash(text) { const normalized = str(text).replace(/\s/g, ""); return normalized ? `${normalized.length}:${stableId(normalized)}:${stableId([...normalized].reverse().join(""))}` : ""; }
  function reviewedOriginal(q) { return q?.reviewed === true && Boolean(q.reviewedBy) && Boolean(q.reviewedAt) && !q.excluded && !q.mergedInto && !q.migrationNeedsReview; }
  function qualifiedExams(engine) {
    const groups = new Map();
    for (const q of (engine.questions || []).filter(q => !q.excluded && !q.mergedInto)) { const id = sourceId(q); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(q); }
    return new Map((engine.canonicalExams || []).filter(e => {
      const questions = groups.get(str(e.id || e.canonical_exam_id)) || [];
      return !e.mergedInto && e.sourceLayer === "A" && ["长沙", "长沙市"].includes(e.region) && e.examType === "中考原卷" && Number.isInteger(Number(e.year)) && Number(e.year) >= 1980 && Number(e.year) <= new Date().getFullYear() + 1 && e.dedupeStatus === "confirmed" && (e.completenessConfirmed === true || e.completeConfirmed === true || e.complete === true) && questions.length > 0 && questions.every(reviewedOriginal);
    }).map(e => [str(e.id || e.canonical_exam_id), e]));
  }
  function sourceContentHash(q) { return stableId(JSON.stringify({ id: questionId(q), exam: sourceId(q), fileId: str(q.sourceFileId || q.fileId), year: str(q.year), region: str(q.region), questionNo: str(q.questionNo), pageNo: q.pageNo, mainPoint: str(q.mainPoint), secondaryPoints: list(q.secondaryPoints), errorModelId: str(q.errorModelId), stem: str(q.stem), options: options(q.options), answer: str(q.answer), score: q.score, tables: tablesOf(q), images: (q.imageAssets || []).filter(i => i.kind !== "page").map(imageDTO), requiresImage: q.requiresImage === true || q.imageReviewRequired === true })); }
  function imageDTO(image) {
    const result = {};
    for (const key of ["id", "assetId", "fileId", "mimeType", "pageNo", "width", "height", "alt", "caption", "kind"]) if (image && image[key] != null) result[key] = typeof image[key] === "number" ? image[key] : str(image[key]);
    // A full page may include answers; a teacher must confirm every teaching crop.
    result.teachingSafe = image?.kind !== "page" && (image?.teachingSafe === true || image?.exportApproved === true);
    result.exportApproved = result.teachingSafe;
    if (Array.isArray(image?.crop) && image.crop.length === 4 && image.crop.every(Number.isFinite)) result.crop = image.crop.slice();
    if (Array.isArray(image?.bbox) && image.bbox.length === 4 && image.bbox.every(Number.isFinite)) result.bbox = image.bbox.slice();
    return result;
  }
  function questionDTO(q, teacher = true) {
    const result = { id: questionId(q), questionId: questionId(q), stem: str(q.stem), options: options(q.options), type: str(q.type), score: Number.isFinite(q.score) ? q.score : null,
      sourceLayer: str(q.sourceLayer), generated: q.generated === true, explanationOrigin: solutionOrigin(q), imageAssets: (q.imageAssets || []).filter(img => img.kind !== "page").map(imageDTO),
      tables: tablesOf(q),
      source: { canonicalExamId: sourceId(q), fileId: str(q.sourceFileId || q.fileId), year: str(q.year), region: str(q.region), questionNo: str(q.questionNo), pageNo: Number(q.pageNo) || null },
      derivedFromQuestionId: str(q.derivedFromQuestionId), mainPoint: str(q.mainPoint), abilities: list(q.abilities) };
    if (teacher) Object.assign(result, { answer: str(q.answer), solution: solutionFor(q), rubric: list(q.rubric), mainPoint: str(q.mainPoint) });
    return result;
  }
  function numericProblem(kind, p, stem, values, units, steps) {
    return { stem, answer: values.map((n, i) => `${fmt(n)}${units[i]}`).join("；"), solution: steps.join("\n"), check: { kind, params: p, expected: values, units }, rubric: steps.map((text, i) => `${i + 1}. ${text}（1分）`) };
  }
  function conceptProblem(stem, answer, solution, check) { return { stem, answer, solution, rubric: ["概念判断正确（1分）", "说明物理依据并指出混淆点（1分）"], check: { kind: "concept", ...check, expectedAnswer: answer } }; }
  function buildProblem(model, n, stage) {
    const s = n + 1, p = {}, subject = ["实验记录", "课堂诊断", "装置改进", "条件对照", "独立回测"][Math.floor(n / 3) % 5];
    let x;
    switch (model.id) {
      case "sensor": {
        Object.assign(p, { u: 6 + s, r0: 10 + s, r1: 20 + 2 * s, r2: 10 + s });
        x = numericProblem("sensor", p, `一传感器与${p.r0}Ω定值电阻串联接在${p.u}V恒压电源上，理想电压表并联在定值电阻两端。传感器电阻由${p.r1}Ω变为${p.r2}Ω。求变化前后电流和电压表示数，说明电流和示数如何变化。`, [p.u / (p.r0 + p.r1), p.u / (p.r0 + p.r2), p.u * p.r0 / (p.r0 + p.r1), p.u * p.r0 / (p.r0 + p.r2)], ["A", "A", "V", "V"], ["两状态分别列 I=U/(R0+R传感器)。", "电压表读数 U0=IR0；传感器电阻减小，总电流增大。", "R0不变，U0随电流增大；电源总电压不变。"]); break;
      }
      case "heater": {
        Object.assign(p, { u: 24 + 2 * s, r: 12 + s, t: 30 + 5 * s });
        x = numericProblem("heater", p, `两个相同的${p.r}Ω电热丝接在${p.u}V恒压电源上，可串联或并联，两种接法均安全。求两挡总功率及并联工作${p.t}s的电能，判断高功率挡。忽略温度对电阻的影响。`, [p.u ** 2 / (2 * p.r), 2 * p.u ** 2 / p.r, 2 * p.u ** 2 / p.r * p.t], ["W", "W", "J"], ["串联等效电阻2R，并联等效电阻R/2。", "用P=U²/R等效计算，得并联功率是串联的4倍。", "并联为高挡，电能W=Pt。"]); break;
      }
      case "wiring": {
        Object.assign(p, { u: 5 + s, fault: s % 2 ? "lamp-open" : "lamp-short" });
        const open = p.fault === "lamp-open";
        x = conceptProblem(`电源为${p.u}V，电流表、小灯泡、滑动变阻器串联；电压表只并联在灯泡两端。仪表理想、导线完好。闭合开关后灯泡不亮，电流表${open ? "无示数" : "有示数"}，电压表${open ? `接近${p.u}V` : "为0"}。已知故障仅在灯泡处，判断断路或短路，并说明变阻器接入应采用哪类接线柱。`, `${open ? "灯泡断路" : "灯泡短路"}；变阻器接线一上一下`, open ? "灯泡断路使主回路无电流，电压表跨在断路两端，示数接近电源电压。变阻器一上一下接入，闭合前阻值调至最大。" : "灯泡短路后其两端电压为0，电路仍导通。变阻器一上一下接入，闭合前阻值调至最大。", { model: model.id, params: p }); break;
      }
      case "lamp": {
        const lowVoltage = Number((.8 + (s % 8) * .05).toFixed(2));
        Object.assign(p, { u1: lowVoltage, i1: .1, u2: Number((lowVoltage + 1).toFixed(2)), i2: .16, u3: Number((lowVoltage + 2).toFixed(2)), i3: .2 });
        x = numericProblem("lamp", p, `测同一小灯泡的三组数据为：(${p.u1}V,0.10A)、(${p.u2}V,0.16A)、(${p.u3}V,0.20A)。额定电压为${p.u3}V。求第一组电阻和额定电阻、额定功率。能否把各组电阻取平均作为恒定电阻？说明理由。`, [p.u1 / p.i1, p.u3 / p.i3, p.u3 * p.i3], ["Ω", "Ω", "W"], ["逐组用R=U/I，电阻随灯丝温度变化。", "额定功率取额定电压对应电流，P额=U额I额。", "灯丝不是本实验温度范围内的恒定电阻，不宜对各温度电阻求平均冒充恒定值。"]); x.tables = [{ headers: ["电压 / V", "电流 / A"], rows: [[p.u1, .1], [p.u2, .16], [p.u3, .2]].map(row => row.map(fmt)) }]; break;
      }
      case "buoyancy": {
        Object.assign(p, { volume: 100 + 10 * s, density: 600, depth: 10 + s });
        x = numericProblem("buoyancy", p, `体积${p.volume}cm³、密度600kg/m³的实心物体漂浮在水面。水密度1000kg/m³，g取10N/kg。求物体所受浮力、排水体积及距水面${p.depth}cm处水产生的压强（不含大气压）。`, [p.volume * 1e-6 * p.density * 10, p.volume * .6, p.depth * .01 * 1000 * 10], ["N", "cm³", "Pa"], ["先换算体积，m=ρ物V物，漂浮时F浮=mg。", "由F浮=ρ水gV排求排液体积，注意不是物体全部体积。", "深度换算为m，液体压强p=ρ水gh。"]); break;
      }
      case "machine": {
        Object.assign(p, { g: 100 + 10 * s, h: .5 + s / 10, force: 70 + 5 * s, n: 2 });
        x = numericProblem("machine", p, `滑轮组由两段绳子承重，将重${p.g}N的物体匀速提升${fmt(p.h)}m，拉力恒为${p.force}N。求绳端移动距离、有用功和机械效率。若用杠杆以${p.g}N为阻力且阻力臂0.2m，施力臂0.5m，求杠杆平衡所需动力。`, [p.h * 2, p.g * p.h, p.g / (p.force * 2) * 100, p.g * .2 / .5], ["m", "J", "%", "N"], ["绳端路程s=nh=2h。", "W有=Gh，W总=Fs，η=W有/W总×100%。", "杠杆平衡时F动l动=F阻l阻，求动力；不能把该动力代入滑轮效率式。"]); break;
      }
      case "graph": {
        Object.assign(p, { r: 10 + s, currents: [.1, .2, .3, .4], badIndex: s % 4 });
        const rows = p.currents.map((i, j) => [fmt(i * p.r * (j === p.badIndex ? 2 : 1)), fmt(i)]);
        x = numericProblem("graph", p, `研究同一恒温定值电阻，电流与电压的四组读数如下。已知仅一组电压记录被误记为真实值的2倍。指出异常数据是第几组，利用其余数据求电阻，并说明应重测还是直接把四组电阻取平均。`, [p.badIndex + 1, p.r], ["组", "Ω"], ["恒温定值电阻满足U/I不变，逐组比较比值。", "异常组U/I为正常值的2倍，应复核并重测。", "不能把已确认异常值与有效数据直接取平均。"]); x.tables = [{ headers: ["电压 / V", "电流 / A"], rows }]; break;
      }
      case "forces": {
        Object.assign(p, { mass: 1 + s / 10 });
        x = conceptProblem(`质量${fmt(p.mass)}kg的书静止在水平桌面，g取10N/kg。请分别找出书所受重力的平衡力、桌面对书支持力的相互作用力，并写出支持力大小。`, `桌面对书的支持力；书对桌面的压力；${fmt(p.mass * 10)}N`, "书所受重力与桌面对书支持力作用于同一物体，是平衡力。支持力与书对桌面的压力作用于不同物体，是相互作用力。静止时支持力等于mg。", { model: model.id, params: p }); break;
      }
      case "inertia": {
        Object.assign(p, { mass: 2 + s, speed: 1 + s / 2 });
        x = conceptProblem(`质量${p.mass}kg的小车以${p.speed}m/s在水平直轨道上匀速运动，水平方向受力平衡。若所有外力同时消失，小车将怎样运动？若质量不变、速度变为原来的2倍，惯性是否改变？`, `以${p.speed}m/s做匀速直线运动；惯性不变`, "外力全部消失后保持原来的运动状态。惯性大小只与质量有关，不能把速度大或动能大说成惯性大。", { model: model.id, params: p }); break;
      }
      case "sound": {
        Object.assign(p, { f: 200 + (s % 300) * 20, amplitude: 1 + (s % 20) / 10 });
        x = conceptProblem(`在同一位置比较三段声音。甲与乙波形相同、振幅都为${fmt(p.amplitude)}mm，频率分别为${p.f}Hz和${p.f * 2}Hz；甲与丙频率和振幅相同但波形不同。判断乙与甲音调高低，以及丙与甲主要在哪种声音特性上不同。相同传播条件下只增大振幅主要改变什么？`, "乙音调更高；丙与甲音色不同；响度", "频率决定音调，乙频率较高。波形差异对应音色差异。相同传播和接收条件下，增大振幅主要增大响度。", { model: model.id, params: p }); break;
      }
      case "phase": {
        const cases = [["冰变成水", "熔化", "吸热"], ["水蒸气在冷玻璃上变成小水滴", "液化", "放热"], ["水结成冰", "凝固", "放热"], ["干冰直接变成气体", "升华", "吸热"], ["水蒸气直接形成霜", "凝华", "放热"], ["水逐渐变成水蒸气", "汽化", "吸热"]];
        Object.assign(p, { index: n % 6, mass: 10 + 5 * s }); const c = cases[p.index];
        x = conceptProblem(`观察${p.mass}g样品发生“${c[0]}”。写出物态变化名称及吸热或放热。另一份晶体正在熔化，温度保持不变，能否据此说它没有吸热？`, `${c[1]}；${c[2]}；不能，晶体熔化仍然吸热`, `根据前后状态可判断为${c[1]}，该过程${c[2]}。晶体熔化吸收的能量用于物态变化，温度不变不等于没有能量转移。`, { model: model.id, params: p }); break;
      }
      case "electromagnet": {
        Object.assign(p, { mode: n % 2, turns: 10 + s });
        const motor = p.mode === 0;
        x = conceptProblem(`某装置有${p.turns}匝线圈置于磁场中。实验时${motor ? "接通直流电源后线圈转动" : "不接电源，用手转动线圈切割磁感线，闭合回路中的灵敏电流计有偏转"}。判断它演示电动机还是发电机原理，写出能量转化方向，并说明另一个装置的原理。`, motor ? "电动机；电能转化为机械能；发电机利用电磁感应" : "发电机；机械能转化为电能；电动机利用通电导体在磁场中受力", motor ? "外电源提供电流，磁场对通电导体作用使其转动。发电机通过闭合电路的一部分导体切割磁感线产生感应电流。" : "手做功驱动导体切割磁感线产生感应电流。电动机由电源供电，通电导体在磁场中受力运动。", { model: model.id, params: p }); break;
      }
    }
    x = stageProblem(x, model, p, stage.key, n);
    const instruction = stage.key === "diagnosis" ? "只作概念与条件判断，不要求多步计算。" : stage.key === "trap" ? "请指出错误发生在哪一步，并给出正确依据。" : stage.key === "variation" ? "条件或信息表征已经改变，请重新建立关系。" : stage.key === "transfer" ? "请列出完整推理过程，检查量纲或能量方向，说明结论成立的条件。" : stage.key === "retest" ? "不查阅前次讲义，独立写出物理依据和答案。" : "写出使用的规律和必要步骤。";
    x.stem = `${subject} ${s}。${x.stem}\n${instruction}`;
    x.score = x.rubric.length;
    return x;
  }
  const DIAGNOSES = {
    sensor: ["理想恒压电源给定值电阻与传感器串联供电。传感器阻值减小时，电源电压是否变小？主回路电流怎样变化？", "电源电压不变；总电阻减小，电流增大"],
    heater: ["两相同电热丝在同一恒压电源下，可串联或并联。不计算数值，判断哪种接法是高功率挡，并说明比较的物理量。", "并联是高功率挡；相同电压下，等效电阻越小，总功率越大"],
    wiring: ["测小灯泡电功率时，电流表与电压表分别怎样接入？滑动变阻器为什么要一上一下接线？", "电流表串联，电压表并联；一上一下使接入电阻随滑片移动改变"],
    lamp: ["小灯泡的电阻随温度改变。能否用任意一次测出的电阻直接计算另一电压下的功率？额定功率应选哪组数据？", "不能；应选额定电压对应的电流，使用P额=U额I额"],
    buoyancy: ["实心物体漂浮在水面。浮力是否等于物体重力？计算浮力时排水体积是否一定等于物体总体积？", "浮力等于重力；排水体积不一定等于总体积，漂浮时通常只有部分浸入"],
    machine: ["滑轮组有两段绳子承重，匀速提升物体。不计算数值，写出绳端路程与物体升高高度的关系，并指出有用功和总功。", "s=2h；有用功Gh，总功Fs"],
    graph: ["研究电流与电压关系时使用同一定值电阻。需要控制什么量？发现孤立异常点，应立即取平均还是先复核？", "控制电阻和温度条件；先复核并重测异常点"],
    forces: ["判断一对力是平衡力还是相互作用力，最先应检查哪项对象关系？两类力的大小是否都可以相等？", "先检查是否作用于同一物体；两类力都可以大小相等"],
    inertia: ["物体做匀速直线运动，是否必须受到同向合力？质量不变而速度改变，惯性大小是否改变？", "不必须，合力为零也能匀速直线运动；惯性不变"],
    sound: ["声音的频率、振幅、波形分别主要对应音调、响度、音色中的哪一项？比较响度时应保持哪些外部条件相同？", "频率对应音调，振幅对应响度，波形对应音色；传播和接收条件相同"],
    phase: ["晶体正在熔化且温度不变。它是否吸热？说明温度变化与热量传递能否被简单视为同一件事。", "仍然吸热；温度不变不能说明没有热量传递"],
    electromagnet: ["一个装置接电源后转动，另一个装置不接电源而靠手摇产生电流。它们分别演示哪种原理？", "前者演示通电导体在磁场中受力，后者演示电磁感应"],
  };
  const TRAPS = {
    sensor: "串联传感器阻值减小，恒压电源的电压也减小，所以电流不变。",
    heater: "相同电源下，两个相同电热丝串联的总电阻更大，所以发热总功率更大。",
    wiring: "只看到小灯泡不亮，就能断定小灯泡断路，不必查看电流表和电压表。",
    lamp: "把不同温度下小灯泡的电阻取平均，就可以得到它在所有电压下不变的电阻。",
    buoyancy: "漂浮物体的浮力始终应把全部物体体积代入F浮=ρ液gV排。",
    machine: "两段绳子承重时，绳端移动距离就是物体升高高度，可直接写总功Fh。",
    graph: "实验有一个明显偏离其余规律的数据点，把所有结果平均就自动消除了异常。",
    forces: "大小相等、方向相反的两个力，无论作用在几个物体上都叫平衡力。",
    inertia: "同一辆车的速度越大，惯性一定越大。",
    sound: "同一声源的频率增大说明它的响度一定增大。",
    phase: "晶体熔化时温度不变，所以不吸收热量。",
    electromagnet: "电动机和发电机都有磁场与线圈，所以二者都依靠电磁感应驱动线圈转动。",
  };
  const DIAGNOSIS_ALT = {
    sensor: ["串联电路中，电压表并联在定值电阻两端。判断该电表测量的是电源电压还是定值电阻电压，并写出示数与电流的关系。", "测定值电阻电压；U0=IR0"],
    heater: ["电热器铭牌同时标有功率和电能消耗。功率与电能是否同一物理量？在功率恒定时如何求一段时间消耗的电能？", "不是同一物理量；电能W=Pt，时间用秒时单位为焦耳"],
    wiring: ["排查一个串联电路中的断路，只测量灯泡亮灭够不够？应同时记录哪些电表信息及测量位置？", "不够；应记录电流表、电压表示数及电压表连接的两端"],
    lamp: ["测小灯泡额定功率时，应先调节电压表达到额定电压，还是先把电流调到任意固定值？为什么？", "先使灯泡两端达到额定电压；额定功率对应额定工作状态"],
    buoyancy: ["比较静止液体内部压强，同一种液体中应比较到液面的竖直深度还是沿容器壁的距离？是否取决于容器形状？", "比较竖直深度；同种液体同深度的压强不取决于容器形状"],
    machine: ["杠杆平衡时，力臂是支点到施力点的距离，还是支点到力作用线的垂直距离？写出平衡条件。", "力臂是到力作用线的垂直距离；F1l1=F2l2"],
    graph: ["物理图像中，横纵轴单位不同或刻度不从零开始，能否直接用图上的线段长度求物理量之比？", "不能；必须读取坐标的实际物理值和单位"],
    forces: ["相互作用的两个力为什么不能被画在同一个物体的受力图中并抵消？", "它们分别作用于两个不同物体，单个物体受力图只画作用在该物体上的力"],
    inertia: ["乘客随车向前运动，汽车突然刹车时乘客为何前倾？惯性是否是一种向前的力？", "身体因惯性倾向保持原运动状态；惯性不是力"],
    sound: ["两种乐器演奏同一个音，频率相同而波形不同，主要用哪个声音特性辨认乐器？", "音色；相同频率不代表相同音色"],
    phase: ["冬天窗上的霜由水蒸气直接变成固体。写出变化名称与吸放热，并区别于露水形成。", "霜是凝华并放热；露是液化并放热"],
    electromagnet: ["导体在磁场中运动一定能产生感应电流吗？指出闭合电路和切割磁感线这两个条件。", "不一定；需要闭合电路的一部分导体做切割磁感线运动"],
  };
  const TRAP_ALT = {
    sensor: ["电压表并联在定值电阻两端，因为该电阻不变，所以任何串联电流下电压表示数都不变。", "串联传感器阻值变小时，它分得的电源电压一定增大。"],
    heater: ["总电压不变时，电热丝并联后的总功率等于任意一根电热丝的功率。", "电热器工作时间越长，其额定功率就越大。"],
    wiring: ["电流表并联在电源两端可以安全地测电源电流。", "滑动变阻器的两个上接线柱接入即可随着滑片移动改变电阻。"],
    lamp: ["用额定电压乘任意一次测得的电流都能得到额定功率。", "温度变化的灯丝两次电压之比必定等于电流之比。"],
    buoyancy: ["同一种液体中，容器越宽，同深度处液体压强越大。", "浸没在水中的物体受到的浮力必定等于它的重力。"],
    machine: ["杠杆的力臂就是支点到施力点的距离，无须判断力的方向。", "机械效率可以超过100%，只要采用足够多的滑轮。"],
    graph: ["图像横轴起点不是0也不影响直接使用图上线段长度比代替物理量比。", "研究电流与电压关系时，同时改变电压和电阻仍能唯一判断电压的影响。"],
    forces: ["桌面对书的支持力与书对桌面的压力能在书的受力图中互相抵消。", "静止物体受到重力，因此一定还存在一个与重力构成相互作用力的支持力。"],
    inertia: ["汽车刹车时乘客受到向前的惯性力，所以前倾。", "物体合力为零时，它的速度一定为零。"],
    sound: ["两种乐器频率相同，所以一定具有相同音色。", "听声音更响就能断定其频率更大。"],
    phase: ["冬天窗上形成的霜是水蒸气先直接变成液态水形成的。", "水沸腾温度保持不变，继续沸腾就无需吸热。"],
    electromagnet: ["只要导体在磁场中静止，就会持续产生感应电流。", "发电机把电能转化为机械能，电动机把机械能转化为电能。"],
  };
  const TRAP_CORRECTIONS = {
    sensor: ["恒压电源电压不变；传感器阻值减小使总电阻减小，由I=U/R总可知电流增大。", "定值电阻不变不代表分压不变；由U0=IR0可知，电流改变时其两端电压也改变。", "电源电压和其余串联电阻不变时，U传=U总R传/(R0+R传)，传感器阻值减小反而使其分压减小。"],
    heater: ["恒定电压下P=U²/R总；串联总电阻更大，总功率反而更小。", "并联总功率是各支路功率之和；两根相同电热丝的总功率是单根的2倍。", "额定功率由额定工作条件决定，不随工作时间增加；时间增长增加的是电能W=Pt。"],
    wiring: ["灯不亮可能由断路、短路或电流过小等导致；须结合电流表、电压表及其测量位置判断。", "电流表内阻很小，直接并联电源会造成近似短路；应与待测支路串联并选择合适量程。", "两个上接线柱之间通常为金属杆，移动滑片不能改变接入电阻；应选一上一下接线柱。"],
    lamp: ["灯丝电阻随温度变化，不同温度数据的平均不能代表所有电压下的恒定电阻。", "额定功率P额=U额I额，电流必须是额定电压下的对应电流，不能与任意一次电流配对。", "由U=IR可知，两次电阻相同才有电压比等于电流比；灯丝温度变化时不能直接套用。"],
    buoyancy: ["阿基米德原理使用排液体积；漂浮时通常只有部分浸入，不能用全部物体体积代替。", "静止液体压强p=ρgh；同种液体、相同竖直深度处压强相等，与容器宽度无关。", "浸没只说明V排=V物，不保证F浮=G；密度不同或另受拉力、支持力时二者可不等。"],
    machine: ["两段承重绳的绳端路程s=2h，总功W总=Fs=2Fh；Gh才是提升重物的有用功。", "力臂是支点到力作用线的垂直距离，只有特定垂直施力情形才等于支点到施力点的距离。", "机械效率η=W有/W总不超过100%；增加滑轮不能创造能量，实际还会增加额外功。"],
    graph: ["平均不能消除已确认的异常记录；应核查条件、读数和记录过程，复测后再处理有效数据。", "坐标起点或刻度变化时，图上线段长度不等于实际物理量；须读出坐标数值与单位后求比。", "电压和电阻同时改变会混入两个因素；研究电压影响须控制电阻及温度条件不变。"],
    forces: ["平衡力必须作用于同一物体；相互作用力分别作用于两个物体，大小相等反向不足以区分二者。", "支持力作用于书，压力作用于桌面，不能在书的受力图中相抵；书的支持力与重力可平衡。", "静止书的支持力与重力是平衡力；重力的相互作用力是书对地球的引力，不是支持力。"],
    inertia: ["惯性大小只由质量决定；同一辆车质量不变，速度增大时惯性不变。", "惯性不是力；刹车时身体倾向保持原来的向前运动状态，不能添加所谓向前惯性力。", "合力为零表示运动状态不变，可以静止，也可以做非零速度的匀速直线运动。"],
    sound: ["频率决定音调；频率增大意味着音调升高，不足以判断响度，响度还与振幅等有关。", "频率相同主要说明音调相同；乐器波形可不同，音色仍可不同。", "听起来更响反映响度变化，不必伴随频率增大；应区分响度与音调。"],
    phase: ["晶体熔化仍需吸热；吸收的能量用于物态变化，温度不变不等于没有热量传递。", "霜是水蒸气直接凝华成固体并放热；先变液态是液化，不能作为霜的直接形成过程。", "水沸腾时保持沸点但仍需吸热；停止供热通常会停止持续沸腾，温度不变不代表无需能量。"],
    electromagnet: ["电动机利用通电导体在磁场中受力，发电机利用电磁感应；相同部件不代表相同工作原理。", "磁场不变化、导体静止时不会仅因处于磁场而持续产生感应电流；本模型要求闭合回路且导体切割磁感线。", "发电机主要把机械能转化为电能，电动机主要把电能转化为机械能，原说法把方向颠倒。"],
  };
  const REPAIR_TARGETS = { sensor: "只求传感器变化前的电流。", heater: "只求串联挡的总功率。", lamp: "只求第一组数据对应的电阻。", buoyancy: "只求漂浮物体所受浮力。", machine: "只求绳端移动距离。", graph: "只指出哪一组数据异常。" };
  function stageProblem(x, model, p, stage, n) {
    if (stage === "diagnosis") {
      const alternate = n % 2 === 1;
      const [prompt, answer] = (alternate ? DIAGNOSIS_ALT : DIAGNOSES)[model.id];
      return conceptProblem(prompt, answer, answer + "。" + model.repair + "。", { kind: "stage-concept", model: model.id, task: alternate ? "diagnosis-alt" : "diagnosis", params: {} });
    }
    if (stage === "trap") {
      const trapIndex = n % 3, correction = TRAP_CORRECTIONS[model.id][trapIndex];
      const answer = `不正确；${correction}`;
      const claim = [TRAPS[model.id], ...TRAP_ALT[model.id]][trapIndex];
      return conceptProblem(`请判断下列说法并纠正：“${claim}”`, answer, `先核对该说法的物理条件，再检查它使用的关系。${correction}`, { kind: "stage-concept", model: model.id, task: "trap", trapIndex, params: {} });
    }
    if (stage === "repair" && REPAIR_TARGETS[model.id]) {
      const setup = x.stem.split(/求变化|求两挡|求第一|求物体|求绳端|指出异常/)[0];
      const val = x.check.expected[0], unit = x.check.units[0];
      return { ...x, stem: setup + REPAIR_TARGETS[model.id], answer: fmt(val) + unit, solution: `本题只检测单一关系。${x.rubric[0]}结果为${fmt(val)}${unit}。`, rubric: ["选对单一规律（1分）", "结果及单位正确（1分）"], check: { ...x.check, targetIndices: [0], expected: [val], units: [unit] } };
    }
    if (stage === "variation") {
      switch (model.id) {
        case "sensor": return numericProblem("sensor-measure-sensor", p, `传感器与${p.r0}Ω定值电阻串联接在${p.u}V恒压电源上，电压表改接在传感器两端。传感器阻值由${p.r1}Ω变为${p.r2}Ω。求两状态电压表示数，并说明为什么它与定值电阻两端电压的变化方向不同。`, [p.u * p.r1 / (p.r0 + p.r1), p.u * p.r2 / (p.r0 + p.r2)], ["V", "V"], ["测量对象已改变，应求传感器分压。", "用U传=U总-U0，或I乘传感器电阻计算。", "总电压不变，U0增大时U传减小。"]);
        case "heater": return numericProblem("heater-unequal", p, `电热器改用${p.r}Ω与${p.r * 2}Ω两根不同电热丝，接在${p.u}V恒压电源上。求串联和并联两挡总功率，并判断还能否直接套用两根相同电热丝的4倍关系。`, [p.u ** 2 / (p.r * 3), p.u ** 2 * 1.5 / p.r], ["W", "W"], ["串联电阻3R，并联电阻2R/3。", "用P=U²/R计算，两挡比为4.5，不能套用4倍关系。"]);
        case "wiring": return conceptProblem(`电源${p.u}V，定值电阻与灯泡串联。电压表现在改接在定值电阻两端，电表理想。灯泡不亮，电压表示数${p.fault === "lamp-open" ? "为0且电流表无示数" : `为${p.u}V且电流表有示数`}，故障仅在灯泡处。判断故障，并说明变阻器改变阻值时应如何选接线柱。`, x.answer, "测量位置改变后，不能套用电压表原先跨在灯泡两端的结论。断路时无电流、定值电阻无分压；灯泡短路时定值电阻承担全部电源电压。变阻器应一上一下接入。", x.check);
        case "lamp": return { ...x, stem: `实验记录改为给出电压与功率：第一组${p.u1}V和${fmt(p.u1 * p.i1)}W，额定组${p.u3}V和${fmt(p.u3 * p.i3)}W。请先由P=UI恢复电流，再求第一组电阻、额定电阻和额定功率。`, tables: [] };
        case "buoyancy": return numericProblem("buoyancy-submerged", p, `体积${p.volume}cm³、密度600kg/m³的物体被细线向下拉住，全部浸没水中且不接触容器。水密度1000kg/m³，g取10N/kg。求此时浮力及使物体静止所需的向下拉力。与自由漂浮时相比，排液体积发生什么变化？`, [p.volume * .01, p.volume * .004], ["N", "N"], ["全部浸没时V排=V物，不再使用漂浮时的部分体积。", "物体平衡时F浮=G+F拉，故F拉=F浮-G。"]);
        case "machine": { const changed = { ...p, n: 3 }; return numericProblem("machine-three", changed, `滑轮组改为三段绳子承重，提升重${p.g}N的物体${p.h}m，拉力${p.force}N。求绳端路程、有用功和机械效率。`, [3 * p.h, p.g * p.h, p.g / (3 * p.force) * 100], ["m", "J", "%"], ["承重绳段数改为3，s=3h。", "用η=Gh/(Fs)计算，不沿用两段绳子的位移关系。"]); }
        case "graph": return { ...x, stem: "数据表改为功率与电流。同一恒温定值电阻有一组功率误记为真实值2倍。指出异常组并求电阻，写出使用的关系。", tables: [{ headers: ["功率 / W", "电流 / A"], rows: p.currents.map((i, j) => [fmt(i * i * p.r * (j === p.badIndex ? 2 : 1)), fmt(i)]) }], solution: "使用P=I²R，逐组计算P/I²。异常组为正常电阻的2倍，不能直接计算P/I。" };
        case "forces": return conceptProblem(`质量${p.mass}kg的物体改为悬挂在弹簧测力计下静止，g取10N/kg。指出重力的平衡力、弹簧拉力的相互作用力及测力计示数。`, `弹簧对物体的拉力；物体对弹簧的拉力；${fmt(p.mass * 10)}N`, "支撑方式改变不影响二力平衡条件。前一对力作用于物体，后一对力分别作用于物体和弹簧。", { kind: "force-suspended", params: p });
        case "inertia": return conceptProblem(`质量${p.mass}kg的小球原先以${p.speed}m/s做圆周运动。若在某位置所有外力突然消失，小球将如何运动？速度不变时，质量增为2倍，惯性如何变化？`, `沿该位置的切线方向做匀速直线运动；惯性增大`, "外力消失后保持瞬时速度，而不是继续转弯。惯性随质量增大而增大。", { kind: "inertia-tangent", params: p });
        case "sound": return { ...x, stem: `记录声音的方式改为振动周期：甲为${fmt(1000 / p.f)}ms，乙为${fmt(500 / p.f)}ms。两者振幅和波形相同；丙与甲周期和振幅相同、波形不同。比较乙与甲音调，判断丙与甲的差异；同条件下只增大振幅主要改变什么？`, solution: "频率是周期的倒数，乙周期更短，频率更高，音调更高。波形差别对应音色，振幅主要影响响度。" };
        case "phase": { const answer = x.answer + "；" + [["凝固", "放热"], ["汽化", "吸热"], ["熔化", "吸热"], ["凝华", "放热"], ["升华", "吸热"], ["液化", "放热"]][p.index].join("，"); return { ...x, stem: x.stem + "现在调整环境使样品发生相反方向的物态变化。请补充相反过程的名称及吸放热，并解释能量方向如何改变。", answer, check: { ...x.check, kind: "phase-reverse", expectedAnswer: answer }, solution: x.solution + "相反物态变化的吸放热方向也相反。" }; }
        case "electromagnet": return { ...x, stem: x.stem + "再把装置换为一根直导体，保持题述的供电或运动方式，其原理判断是否改变？说明决定原理的是线圈匝数还是电流产生与受力过程。", solution: x.solution + "改为直导体不改变两种原理的判据，匝数不决定电流来源和能量方向。" };
      }
    }
    return x;
  }
  function solveCheck(check) {
    const p = check.params;
    if (!p || Object.values(p).some(v => typeof v === "number" && !Number.isFinite(v))) throw new Error("非法物理参数");
    if (check.targetIndices) { const solved = solveCheck({ ...check, targetIndices: null }); return check.targetIndices.map(i => solved[i]); }
    switch (check.kind) {
      case "stage-concept": return check.task === "diagnosis" ? DIAGNOSES[check.model][1] : check.task === "diagnosis-alt" ? DIAGNOSIS_ALT[check.model][1] : `不正确；${TRAP_CORRECTIONS[check.model][check.trapIndex]}`;
      case "sensor-measure-sensor": return [p.u - p.u / (p.r0 + p.r1) * p.r0, p.u - p.u / (p.r0 + p.r2) * p.r0];
      case "heater-unequal": return [p.u * (p.u / (p.r + p.r * 2)), p.u * (p.u / p.r + p.u / (2 * p.r))];
      case "buoyancy-submerged": return [1000 * 10 * p.volume / 1e6, (1000 - p.density) * 10 * p.volume / 1e6];
      case "machine-three": return [p.h * p.n, p.g * p.h, p.g * p.h / (p.force * p.h * p.n) * 100];
      case "force-suspended": return `弹簧对物体的拉力；物体对弹簧的拉力；${fmt(p.mass * 10)}N`;
      case "inertia-tangent": return "沿该位置的切线方向做匀速直线运动；惯性增大";
      case "phase-reverse": return solveCheck({ ...check, kind: "concept" }) + "；" + [["凝固", "放热"], ["汽化", "吸热"], ["熔化", "吸热"], ["凝华", "放热"], ["升华", "吸热"], ["液化", "放热"]][p.index].join("，");
      case "sensor": { const i1 = p.u / (p.r0 + p.r1), i2 = p.u / (p.r0 + p.r2); return [i1, i2, p.u - i1 * p.r1, p.u - i2 * p.r2]; }
      case "heater": { const one = p.u / p.r; return [one * p.u / 2, one * p.u * 2, one * p.u * 2 * p.t]; }
      case "lamp":
        if (!(p.u1 > 0 && p.u1 < p.u2 && p.u2 < p.u3 && p.i1 > 0 && p.i1 < p.i2 && p.i2 < p.i3 && p.u1 / p.i1 < p.u2 / p.i2 && p.u2 / p.i2 < p.u3 / p.i3)) throw new Error("灯丝温度升高时电阻变化不符合本模型条件");
        return [p.u1 * (1 / p.i1), p.u3 * (1 / p.i3), p.i3 * p.u3];
      case "buoyancy": return [p.volume * p.density / 100000, p.volume * p.density / 1000, p.depth * 100];
      case "machine": return [p.n * p.h, p.g * p.h, (p.g * p.h) / (p.force * p.n * p.h) * 100, p.g * 2 / 5];
      case "graph": return [p.badIndex + 1, p.r];
      case "concept": {
        switch (check.model) {
          case "wiring": return `${p.fault === "lamp-open" ? "灯泡断路" : "灯泡短路"}；变阻器接线一上一下`;
          case "forces": return `桌面对书的支持力；书对桌面的压力；${fmt(10 * p.mass)}N`;
          case "inertia": return `以${p.speed}m/s做匀速直线运动；惯性不变`;
          case "sound": return "乙音调更高；丙与甲音色不同；响度";
          case "phase": return [["熔化", "吸热"], ["液化", "放热"], ["凝固", "放热"], ["升华", "吸热"], ["凝华", "放热"], ["汽化", "吸热"]][p.index].join("；") + "；不能，晶体熔化仍然吸热";
          case "electromagnet": return p.mode === 0 ? "电动机；电能转化为机械能；发电机利用电磁感应" : "发电机；机械能转化为电能；电动机利用通电导体在磁场中受力";
          default: throw new Error("未知概念校验器");
        }
      }
      default: throw new Error("未知校验器");
    }
  }
  function validateQuestion(q) {
    const errors = [];
    if (!questionId(q) || !str(q.stem).trim()) errors.push("题干或统一题目ID缺失");
    if (!str(q.answer).trim()) errors.push("答案缺失");
    if (!solutionFor(q).trim()) errors.push("缺少原创或教师解析，不能使用原解析代替");
    const protectedHash = q.sourceExplanationHash || explanationHash(q.sourceExplanation);
    if (protectedHash && explanationHash(solutionFor(q)) === protectedHash) errors.push("教学解析与原解析完全相同，请重新撰写原创分步解析");
    if (!list(q.rubric).length) errors.push("评分点缺失");
    if (!Number.isFinite(q.score) || q.score <= 0) errors.push("分值缺失或无效");
    if (q.requiresImage && !q.imageAssets?.length) errors.push("必要题图缺失");
    if ((q.imageAssets || []).some(img => img.kind === "page" || !(img.teachingSafe || img.exportApproved))) errors.push("题图尚未确认不含答案或原解析");
    if (q.generated) {
      try {
        const solved = solveCheck(q.validationSpec);
        const expected = typeof solved === "string" ? q.validationSpec.expectedAnswer : q.validationSpec.expected;
        if (Array.isArray(solved) ? !Array.isArray(expected) || solved.length !== expected.length || solved.some((v, i) => !Number.isFinite(v) || Math.abs(v - expected[i]) > 1e-8 * Math.max(1, Math.abs(v))) : solved !== expected) errors.push("独立求解与预期答案不一致");
        const computedAnswer = Array.isArray(solved) ? solved.map((v, i) => fmt(v) + q.validationSpec.units[i]).join("；") : solved;
        if (q.answer !== computedAnswer) errors.push("展示答案与求解结果不一致");
      } catch (e) { errors.push(`物理校验失败：${e.message}`); }
    }
    return { passed: errors.length === 0, errors, automated: q.generated === true, requiresTeacher: true };
  }
  function contentHash(item) { return stableId(JSON.stringify({ question: item.question, stage: item.stageKey, reason: item.reason, detects: item.detects })); }
  function refreshPlan(plan) {
    const ids = new Set(), stems = new Set();
    plan.gaps = [];
    for (const item of plan.items || []) {
      item.validation = item.question ? validateQuestion(item.question) : { passed: false, errors: ["题目不足"], requiresTeacher: true };
      if (item.stageKey === "authentic" && item.question && (item.question.sourceLayer !== "A" || item.question.generated || !item.question.reviewed || !sourceId(item.question))) { item.validation.passed = false; item.validation.errors.push("典型真题必须为不同的已核验A类原题"); }
      if (item.question) {
        const id = questionId(item.question), stem = str(item.question.stem).replace(/\s/g, "");
        if (ids.has(id) || stems.has(stem)) { item.validation.passed = false; item.validation.errors.push("专题中题目重复"); }
        ids.add(id); stems.add(stem);
      }
      if (item.review?.status === "confirmed" && item.review.contentHash !== contentHash(item)) item.review = { ...item.review, status: "revoked", reason: "题目内容已修改，需重新审核" };
      if (!item.validation.passed) plan.gaps.push({ itemId: item.id, stage: item.stage, errors: item.validation.errors.slice() });
    }
    const countsValid = STAGES.every(s => plan.items?.filter(i => i.stageKey === s.key).length === s.count);
    if (!countsValid || plan.items?.length !== 19) plan.gaps.push({ errors: ["必须满足19题各阶段固定配额"] });
    if (plan.gaps.length) plan.status = "incomplete";
    else if (!plan.items.every(i => i.review?.status === "confirmed" && i.review.reviewerId)) plan.status = "review";
    else plan.status = plan.completedAt ? "completed" : "ready";
    plan.readyCount = (plan.items || []).filter(i => i.validation?.passed && i.review?.status === "confirmed").length;
    return plan;
  }
  function generateTrainingPlan(engine, focusPoint, opts = {}) {
    const model = modelFor(focusPoint, opts.modelId);
    const now = opts.now || new Date().toISOString();
    const plan = { id: opts.planId || `training_${stableId(focusPoint + now + Math.random())}`, version: VERSION, title: `${focusPoint} 错误模型专题训练`, focusPoint, errorModelId: model?.id || "", errorModel: model?.name || focusPoint, createdAt: now, items: [], auditEvents: [], classId: str(opts.classId), studentId: str(opts.studentId), baselineAttemptIds: list(opts.baselineAttemptIds), isSynthetic: opts.isSynthetic === true, generationLabel: "本地参数化原创，待教师核验" };
    const exams = qualifiedExams(engine);
    const candidates = (engine.questions || []).filter(q => {
      const e = exams.get(sourceId(q));
      return e && q.sourceLayer === "A" && reviewedOriginal(q) && (q.mainPoint === focusPoint || (q.secondaryPoints || []).includes(focusPoint) || (model && q.errorModelId === model.id));
    }).filter((q, i, arr) => !arr.slice(0, i).some(other => sameQuestion(q, other)));
    let originalIndex = 0, generatedIndex = 0;
    const priorStems = new Set((engine.trainingPlans || []).flatMap(p => (p.items || []).map(i => str(i.question?.stem).replace(/\s/g, ""))));
    const offset = opts.variantSeed != null ? Math.max(0, Math.floor(Number(opts.variantSeed) || 0)) : parseInt(stableId(plan.id), 36) % 100;
    for (const stage of STAGES) for (let i = 0; i < stage.count; i++) {
      let question = null;
      const parent = candidates[generatedIndex % Math.max(1, candidates.length)];
      if (stage.key === "authentic") {
        const q = candidates[originalIndex++];
        if (q) { question = { ...questionDTO(q, true), canonicalExamId: sourceId(q), fileId: str(q.sourceFileId || q.fileId), year: str(q.year), region: str(q.region), questionNo: str(q.questionNo), pageNo: Number(q.pageNo) || null, reviewed: true, reviewedBy: str(q.reviewedBy), reviewedAt: str(q.reviewedAt), ...(solutionOrigin(q) === "teacher" ? { teacherExplanation: solutionFor(q) } : { aiExplanation: solutionFor(q) }), rubric: list(q.rubric), requiresImage: q.requiresImage === true || q.imageReviewRequired === true, sourceContentHash: sourceContentHash(q), sourceExplanationHash: explanationHash(q.sourceExplanation), generated: false }; }
      } else if (model) {
        let serial = offset * 15 + generatedIndex;
        let problem = buildProblem(model, serial, stage);
        while (priorStems.has(problem.stem.replace(/\s/g, ""))) problem = buildProblem(model, ++serial, stage);
        priorStems.add(problem.stem.replace(/\s/g, ""));
        const id = `generated_${plan.id}_${generatedIndex + 1}`;
        question = { id, questionId: id, sourceLayer: "D", generated: true, countedInFrequency: false, type: "简答计算题", mainPoint: focusPoint, abilities: [model.ability], physicalModel: model.name, errorModelId: model.id, derivedFromQuestionId: questionId(parent || {}), stem: problem.stem, options: [], answer: problem.answer, aiExplanation: problem.solution, explanationOrigin: "ai", rubric: problem.rubric, score: problem.score, imageAssets: [], tables: problem.tables || [], validationSpec: problem.check, isSynthetic: plan.isSynthetic };
        generatedIndex++;
      }
      plan.items.push({ id: `${plan.id}_item_${plan.items.length + 1}`, stage: stage.name, stageKey: stage.key, title: `${stage.name} ${i + 1}`, question, derivedFromQuestionId: question?.derivedFromQuestionId || "", detects: `${stage.detects}；${model?.misconception || "需要补充错误模型"}`, reason: stage.key === "authentic" ? "选入经教师核验的长沙独立原题，检测能否迁移到真实命题情境。" : `${model?.repair || "先建立专题错误模型"}；本题负责${stage.detects}。`, review: { status: "pending" }, retestOffsetDays: stage.key === "retest" ? (i === 0 ? 3 : 7) : null });
    }
    plan.basis = `可用且不重复的A类原题${candidates.length}道；原创题不进入中考频次统计。`;
    return refreshPlan(plan);
  }
  function reviewItem(plan, itemId, opts = {}) {
    const item = plan.items.find(i => i.id === itemId); if (!item) throw new Error("训练条目不存在");
    if (!str(opts.reviewerId).trim()) throw new Error("必须记录教师审核身份");
    if (!item.question) throw new Error("请先补齐实际题目");
    if (opts.solution !== undefined) item.question.teacherExplanation = str(opts.solution);
    if (opts.rubric !== undefined) item.question.rubric = list(opts.rubric);
    const validation = validateQuestion(item.question);
    if (opts.confirmed !== false && !validation.passed) throw new Error(validation.errors.join("；"));
    const event = { itemId, reviewerId: str(opts.reviewerId), at: opts.now || new Date().toISOString(), status: opts.confirmed === false ? "revoked" : "confirmed", contentHash: contentHash(item) };
    item.review = event; (plan.auditEvents ||= []).push(clone(event)); return refreshPlan(plan);
  }
  function completeTraining(plan, opts = {}) {
    refreshPlan(plan); if (!["ready", "completed"].includes(plan.status)) throw new Error("训练包尚未逐题核验完成");
    if (!str(opts.sessionId)) throw new Error("完成训练必须关联实际课次");
    const completedAt = opts.completedAt || new Date().toISOString(); if (!Number.isFinite(Date.parse(completedAt))) throw new Error("完成时间无效");
    plan.completedAt = completedAt; plan.trainingSessionId = str(opts.sessionId);
    for (const item of plan.items.filter(i => i.stageKey === "retest")) item.dueAt = new Date(Date.parse(completedAt) + item.retestOffsetDays * 86400000).toISOString();
    return refreshPlan(plan);
  }
  const verifiedEvidence = a => a && a.sourceLayer === "E" && a.manualVerified === true && a.verificationStatus === "verified" && a.verifiedBy && a.verifiedAt && a.studentId && a.classId && a.sessionId && !a.revokedAt && !a.supersededBy && !a.migrationNeedsReview;
  const learnerKey = a => `${str(a.classId)}\u0000${str(a.studentId)}`;
  function retestEvidence(plan, item, attempt, attempts) {
    const ids = [...list(attempt?.baselineAttemptIds), str(attempt?.baselineAttemptId)].filter(Boolean);
    const baseline = ids.filter(id => plan.baselineAttemptIds.includes(id)).map(id => attempts instanceof Map ? attempts.get(id) : attempts.find(a => a.id === id)).find(Boolean);
    const at = Date.parse(attempt?.attemptedAt || attempt?.answeredAt || attempt?.sessionDate || attempt?.createdAt || "");
    if (!plan.completedAt || !item || !verifiedEvidence(attempt) || str(attempt.questionId) !== questionId(item.question || {}) || str(attempt.trainingPlanId) !== plan.id || str(attempt.trainingItemId) !== item.id || !verifiedEvidence(baseline) || baseline.isCorrect !== false || !baseline.studentId || learnerKey(baseline) !== learnerKey(attempt) || (plan.studentId && plan.studentId !== attempt.studentId) || (plan.classId && plan.classId !== attempt.classId) || !Number.isFinite(at) || at < Date.parse(plan.completedAt)) return null;
    return { baseline, at, isDelayed: at >= Date.parse(item.dueAt) };
  }
  function retestQueue(plans, now = new Date().toISOString(), opts = {}) {
    const attempts = opts.attempts || [], rows = [], byId = new Map(attempts.map(a => [a.id, a])), byPlan = new Map();
    for (const a of attempts) if (a.trainingPlanId) { if (!byPlan.has(a.trainingPlanId)) byPlan.set(a.trainingPlanId, []); byPlan.get(a.trainingPlanId).push(a); }
    for (const plan of plans.filter(p => p.completedAt)) {
      const baselines = list(plan.baselineAttemptIds).map(id => byId.get(id)).filter(a => verifiedEvidence(a) && a.isCorrect === false && a.studentId);
      const learners = new Map(baselines.map(a => [learnerKey(a), a]));
      for (const item of (plan.items || []).filter(i => i.stageKey === "retest" && i.dueAt)) {
        const completed = (byPlan.get(plan.id) || []).filter(a => a.trainingItemId === item.id).map(a => ({ attempt: a, evidence: retestEvidence(plan, item, a, byId) })).filter(r => r.evidence?.isDelayed);
        const done = new Set(completed.map(r => learnerKey(r.attempt)));
        const pending = [...learners.entries()].filter(([key]) => !done.has(key)).map(([, a]) => a.id);
        // Recompute from current verified evidence so a revoked attempt reopens the queue.
        item.completedAttemptIds = completed.map(r => r.attempt.id);
        item.completedAttemptId = learners.size && !pending.length ? item.completedAttemptIds.at(-1) : "";
        if (item.completedAttemptId) continue;
        rows.push({ planId: plan.id, itemId: item.id, questionId: questionId(item.question || {}), dueAt: item.dueAt, overdue: Date.parse(item.dueAt) <= Date.parse(now), classId: plan.classId, studentId: plan.studentId, baselineAttemptIds: list(plan.baselineAttemptIds), pendingBaselineAttemptIds: pending, pendingStudentCount: pending.length, completedStudentCount: done.size, needsBaseline: !learners.size });
      }
    }
    return rows.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }
  function linkRetest(plan, itemId, attempt, opts = {}) {
    const item = plan.items.find(i => i.id === itemId && i.stageKey === "retest");
    const attempts = (opts.attempts || []).filter(a => a.id !== attempt?.id).concat(attempt || []);
    const evidence = retestEvidence(plan, item, attempt, attempts);
    if (!evidence) throw new Error("回测必须关联同学生同班级的已核验错误、实际训练和训练完成后的作答");
    item.isDelayedRetest = evidence.isDelayed; item.completedAt = new Date(evidence.at).toISOString();
    retestQueue([plan], item.completedAt, { attempts }); return plan;
  }
  function exportPlanDTO(plan, opts = {}) {
    refreshPlan(plan); if (!["ready", "completed"].includes(plan.status)) throw new Error("导出前必须补齐19题并完成逐题审核");
    const teacher = opts.audience === "teacher", section = opts.section || "all";
    return { schemaVersion: VERSION, id: str(plan.id), title: str(plan.title), isSynthetic: plan.isSynthetic === true, section, audience: teacher ? "teacher" : "student", items: plan.items.filter(i => section === "all" || (section === "retest" ? i.stageKey === "retest" : i.stageKey !== "retest")).map((item, index) => {
      const output = { id: str(item.id), number: index + 1, stage: teacher ? str(item.stage) : "", question: questionDTO(item.question, teacher) };
      if (teacher) output.stageKey = str(item.stageKey);
      if (teacher) Object.assign(output, { reason: str(item.reason), detects: str(item.detects), derivedFromQuestionId: str(item.derivedFromQuestionId) });
      return output;
    }) };
  }
  function validatePlanAgainstEngine(plan, engine) {
    const errors = [], exams = qualifiedExams(engine);
    for (const item of (plan.items || []).filter(i => i.stageKey === "authentic")) {
      const q = (engine.questions || []).find(q => questionId(q) === questionId(item.question || {}));
      const e = exams.get(sourceId(q || {}));
      if (!reviewedOriginal(q) || q.sourceLayer !== "A" || !e) errors.push(`原题${questionId(item.question || {})}的审核或独立试卷资格已失效`);
      if (q && (sourceContentHash(q) !== item.question?.sourceContentHash || sourceId(q) !== sourceId(item.question || {}))) errors.push(`原题${questionId(q)}已有新版本，需更新训练条目并重新核验`);
    }
    return { passed: !errors.length, errors };
  }
  const REPORT_KEYS = new Set("version algorithmVersion dataRevision generatedAt cutoffYear title answer evidence label reason reasons point index rank years examCount questionCount consecutiveYears typeDistribution scoreDistribution confidence confidenceInterval coverage missingYears knownYears window sampleCount sampleSize exams questions files reviewedQuestions pendingQuestions duplicates reviewed unreviewed total wrongCount wrongRate blankRate blankCount attemptCount studentCount averageTime repeatErrorRate repeatEligible repeatWrongCount retestFailureRate retestEligible retestFailed numerator denominator low high status description name score signals riskLabel fileId fileName year region questionNo pageNo canonicalExamId canonical_exam_id id sourceLayer expected actual trend count sufficient gaps warnings deficiencies basis commonIndex specialtyIndex annualCoverage details value weight components sampleCoverage scoreCompleteness".split(" "));
  const REPORT_CONTAINERS = new Set("samples quality duplicates knowledge abilities trends3 trends5 hunan expectedErrors actualErrors intersections recommendations trainingPlans insufficient questions answers summary finalAnswers question refs evidenceRefs byYear annual errors reports distribution breakdown confidence confidenceInterval components missingYears years source files reviewItems issues sourceLayers chapters".split(" "));
  for (const key of "metadata sections hunanCompare localTeachingFocus recommendedTopics fourAnswers questionRefs sourceSpans raw missingComponents sampleFiveCoverage distributions types scores dataQuality knowledgeTop abilityTop hunanComparison aiExpectedErrors trainingItems reviewNeeds groups checks expectedDuplicateChecks items changsha localTeaching draftSamples window3 window5 availableYears cityScores eligibleCities otherCities completeCities cityDetails layers coverageByYear".split(" ")) REPORT_CONTAINERS.add(key);
  for (const key of "dataVersion currentCalendarYear policy sourceExamIds questionIds questionId sourceFileId planId derivedFromQuestionId stage detects evidenceType frequencyIndex priority errorEvidence complete level isProbability fiveCoverage continuity historicalCoverage scoreShare stability diversity regions actualAttempts startYear endYear city changshaIndex hunanIndex hunanCommonIndex relativeFeatureIndex relativeFeature coverageDifference expectedFileCount actualFileCount independentExamCount ok fileIds duplicateGroupId duplicate_group_id pageStart pageEnd bbox crop".split(" ")) REPORT_KEYS.add(key);
  for (const key of "sourceCanonicalExamIds independentSourceKeys cityExamRecords canonicalExams duplicateFiles assetsPersistent fieldCompleteness confirmedAttempts unconfirmedAttempts reviewPending direction hunanExamCount independentSourceGroups comparisonCities sampleCoverageByCity note traps isErrorRate uniqueStudents wrongRateInterval lower upper rateBasis optionDistribution timeSampleSize blankNumerator blankDenominator repeatRate repeatNumerator repeatDenominator retestNumerator retestDenominator errorSteps smallSample".split(" ")) REPORT_KEYS.add(key);
  function publicAnalysisDTO(value) {
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
    if (Array.isArray(value)) return value.map(publicAnalysisDTO);
    if (!value || typeof value !== "object") return null;
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "question" && val && typeof val === "object") { out.question = questionDTO(val, false); continue; }
      if (REPORT_KEYS.has(key) || REPORT_CONTAINERS.has(key)) out[key] = publicAnalysisDTO(val);
    }
    return out;
  }
  return { VERSION, MODELS, STAGES, modelFor, generateTrainingPlan, refreshPlan, reviewItem, validateQuestion, validatePlanAgainstEngine, solveCheck, completeTraining, retestQueue, linkRetest, exportPlanDTO, publicAnalysisDTO, questionDTO };
});
