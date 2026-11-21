import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import StudentQuestionSets from "../exam-engine/student-question-set.js";
import { routePhysicsExam } from "../server/physics-exam-routes.mjs";
import { exportStudentQuestionPdf, studentPdfProjection } from "../server/physics-student-pdf.mjs";

const root = resolve(import.meta.dirname, "..");
const python = process.env.EXAM_EXPORT_PYTHON || join(root, ".venv", "bin", "python");
const setId = "studentset_pdf_12345678";
const cropId = "asset_pdf_crop_12345678";
const sentinel = "SECRET_SOURCE_EXPLANATION_SENTINEL";
const sample = () => ({ title: "PDF 学生卷验收", questions: [{ questionNo: "24", score: 3, stem: "水的温度为20℃。判断下列说法。", options: [{ label: "A", text: "温度相同，内能可能不同。" }], tables: [{ headers: ["时间/s", "温度/℃"], rows: [["10", "20"]] }], imageAssets: [] }] });

function directory(t) { const dir = mkdtempSync(join(tmpdir(), "student-pdf-test-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function installImage(dataDir) {
  mkdirSync(join(dataDir, "exam-assets"), { recursive: true });
  writeFileSync(join(dataDir, "exam-assets", `${cropId}.json`), JSON.stringify({ kind: "question-crop", extension: ".png" }));
  execFileSync(python, ["-c", "from PIL import Image,ImageDraw; import sys; im=Image.new('RGB',(600,800),'white'); d=ImageDraw.Draw(im); d.rectangle((20,20,580,780),outline='black'); d.text((40,40),'ORIGINAL QUESTION IMAGE',fill='black'); im.save(sys.argv[1])", join(dataDir, "exam-assets", `${cropId}.png`)]);
}
function pdfText(bytes, dir) {
  const path = join(dir, "result.pdf"); writeFileSync(path, bytes);
  return JSON.parse(execFileSync(python, ["-c", "from pypdf import PdfReader; import json,sys; r=PdfReader(sys.argv[1]); print(json.dumps({'text':'\\n'.join(p.extract_text() for p in r.pages),'pages':len(r.pages),'sizes':[[float(p.mediabox.width),float(p.mediabox.height)] for p in r.pages]}))", path], { encoding: "utf8" }));
}
function response() { return { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value) { this.body = value; } }; }

test("学生 PDF 投影在所有嵌套层只接受学生字段，不透传解析/答案/元数据", () => {
  const payload = sample(); payload.sourceExplanation = sentinel;
  const q = payload.questions[0]; q.answer = sentinel; q.originalExtraction = { analysis: sentinel }; q.options[0].explanation = sentinel; q.tables[0].analysis = sentinel; q.tables[0].rows.push([{ sourceExplanation: sentinel }]);
  q.imageAssets = [{ assetId: cropId, url: sentinel, sourceExplanation: sentinel, private: { explanation: sentinel } }];
  const projected = studentPdfProjection(payload);
  assert.ok(!JSON.stringify(projected).includes(sentinel));
  assert.deepEqual(Object.keys(projected).sort(), ["questions", "title"]);
  assert.deepEqual(projected.questions[0].images, [{ assetId: cropId }]);
  q.contentMode = "original";
  const original = studentPdfProjection(payload).questions[0];
  assert.equal(original.stem, ""); assert.deepEqual(original.options, []); assert.deepEqual(original.tables, []);
});

test("PDF 拒绝过量题目、过量图片、过长内容和非法资源路径", async t => {
  assert.throws(() => studentPdfProjection({ title: "test", questions: Array(101).fill(sample().questions[0]) }), /1 至 100/);
  let payload = sample(); payload.questions[0].imageAssets = Array(201).fill({ assetId: cropId });
  assert.throws(() => studentPdfProjection(payload), /200/);
  payload = sample(); payload.questions[0].stem = "长".repeat(20001);
  assert.throws(() => studentPdfProjection(payload), /文字过长/);
  payload = sample(); payload.questions[0].imageAssets = [{ assetId: "../../private-key" }];
  assert.throws(() => studentPdfProjection(payload), /标识无效/);
  payload = sample(); payload.questions[0].imageAssets = [{ assetId: cropId }];
  await assert.rejects(exportStudentQuestionPdf({ payload, dataDir: directory(t), root }), /第 1 题的题图缺失/);
});

test("学生 PDF 路由复用既有审核门禁：未审核、已过期版本、非 GET 全部拒绝", async t => {
  const dataDir = directory(t);
  const question = { id: "question_pdf_12345678", questionNo: "1", score: 2, generated: true, stem: "水是液体。", answer: "正确", reviewed: true, reviewedBy: "local_teacher", reviewedAt: "2026-09-13T01:00:00Z" };
  const set = { id: setId, title: "验收题单", status: "ready", publishedAt: "2026-09-13T01:01:00Z", publishedBy: "local_teacher", questionRefs: [{ questionId: question.id, contentHash: StudentQuestionSets.contentHash(question) }] };
  const engine = { questions: [question], questionSets: [set] };
  const context = { root, dataDir, getStore: () => ({ getEngine: () => ({ engine }) }) };
  const url = new URL(`http://localhost/api/physics-exam/question-sets/${setId}/student.pdf`);
  let res = response(); await routePhysicsExam({ method: "POST" }, res, url, context); assert.equal(res.status, 405);
  question.reviewed = false; res = response(); await routePhysicsExam({ method: "GET" }, res, url, context); assert.equal(res.status, 409); assert.match(res.body, /教师逐题确认/);
  question.reviewed = true; question.stem = "内容已经变更"; res = response(); await routePhysicsExam({ method: "GET" }, res, url, context); assert.equal(res.status, 409); assert.match(res.body, /已变更/);
  question.stem = "水是液体。"; set.status = "draft"; res = response(); await routePhysicsExam({ method: "GET" }, res, url, context); assert.equal(res.status, 409); assert.match(res.body, /未经教师确认/);
});

test("真实 PDF 为 A4、连续编号，原题仅打印裁图，跨页有续题标识", { skip: !existsSync(python) }, async t => {
  const dataDir = directory(t); installImage(dataDir);
  const payload = sample(); payload.questions[0].answer = sentinel;
  const original = { ...sample().questions[0], stem: "OCR_MUST_NOT_PRINT", contentMode: "original", questionNo: "8", imageAssets: [{ assetId: cropId }, { assetId: cropId }] };
  payload.questions.push(original);
  const result = await exportStudentQuestionPdf({ payload, dataDir, root });
  assert.equal(result.mime, "application/pdf"); assert.equal(result.bytes.subarray(0, 5).toString(), "%PDF-");
  const inspection = pdfText(result.bytes, dataDir);
  assert.match(inspection.text, /第 1 题/); assert.match(inspection.text, /第 2 题/); assert.match(inspection.text, /续题 2\/2/);
  assert.match(inspection.text, /温度相同/); assert.ok(!inspection.text.includes("OCR_MUST_NOT_PRINT")); assert.ok(!inspection.text.includes(sentinel));
  assert.ok(inspection.pages >= 2);
  assert.ok(inspection.sizes.every(([width, height]) => Math.abs(width - 595.28) < .1 && Math.abs(height - 841.89) < .1));
});

test("PDF 超时终止可恢复，错误不会永久占住并发名额", { skip: !existsSync(python) }, async t => {
  const dataDir = directory(t);
  await assert.rejects(exportStudentQuestionPdf({ payload: sample(), dataDir, root, timeoutMs: 1 }), /超时/);
  const result = await exportStudentQuestionPdf({ payload: sample(), dataDir, root });
  assert.equal(result.bytes.subarray(0, 5).toString(), "%PDF-");
});

test("最多同时生成两份 PDF，期间撤销核验不会交付旧版本", { skip: !existsSync(python) }, async t => {
  const dataDir = directory(t);
  const first = exportStudentQuestionPdf({ payload: sample(), dataDir, root });
  const second = exportStudentQuestionPdf({ payload: sample(), dataDir, root });
  await assert.rejects(exportStudentQuestionPdf({ payload: sample(), dataDir, root }), error => error.status === 429);
  await Promise.all([first, second]);
  const question = { id: "question_pdf_12345678", questionNo: "1", score: 2, generated: true, stem: "水是液体。", answer: "正确", reviewed: true, reviewedBy: "local_teacher", reviewedAt: "2026-09-13T01:00:00Z" };
  const set = { id: setId, title: "验收题单", status: "ready", publishedAt: "2026-09-13T01:01:00Z", publishedBy: "local_teacher", questionRefs: [{ questionId: question.id, contentHash: StudentQuestionSets.contentHash(question) }] };
  let snapshots = 0;
  const context = { root, dataDir, getStore: () => ({ getEngine: () => ({ engine: { questionSets: [set], questions: [{ ...question, reviewed: ++snapshots === 1 }] } }) }) };
  const res = response();
  await routePhysicsExam({ method: "GET" }, res, new URL(`http://localhost/api/physics-exam/question-sets/${setId}/student.pdf`), context);
  assert.equal(res.status, 409); assert.match(res.body, /教师逐题确认/); assert.ok(!res.body.includes("%PDF-"));
});

test("PDF 排版只移除上下纯白外边，原宽度、浅色像素、页脚与源文件保持不变", { skip: !existsSync(python) }, () => {
  const check = JSON.parse(execFileSync(python, ["-c", [
    "import importlib.util,json,hashlib",
    "from PIL import Image,ImageDraw",
    "spec=importlib.util.spec_from_file_location('sheet','exam-engine/export-student-sheet.py')",
    "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)",
    "im=Image.new('RGB',(200,400),'white');draw=ImageDraw.Draw(im)",
    "draw.rectangle((20,60,180,110),fill='black')",
    "draw.line((5,290,190,290),fill=(254,255,255))",
    "draw.text((60,310),'Page 8',fill=(200,200,200))",
    "before=hashlib.sha256(im.tobytes()).hexdigest()",
    "trimmed=module.trim_vertical_white_borders(im)",
    "def content_rows(image): return [row for y in range(image.height) if (row:=image.crop((0,y,image.width,y+1)).tobytes())!=bytes([255])*(image.width*3)]",
    "print(json.dumps({'beforeSize':im.size,'afterSize':trimmed.size,'sourceUnchanged':before==hashlib.sha256(im.tobytes()).hexdigest(),'contentUnchanged':content_rows(im)==content_rows(trimmed),'whiteImageSize':module.trim_vertical_white_borders(Image.new('RGB',(200,400),'white')).size}))",
  ].join("\n")], { cwd: root, encoding: "utf8" }));
  assert.equal(check.afterSize[0], check.beforeSize[0]);
  assert.ok(check.afterSize[1] < check.beforeSize[1]);
  assert.equal(check.sourceUnchanged, true); assert.equal(check.contentUnchanged, true);
  assert.deepEqual(check.whiteImageSize, [200, 400]);
});
