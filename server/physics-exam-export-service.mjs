import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const training = require("../exam-engine/exam-training.js");
const FORMATS = {
  docx: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", audience: "teacher", section: "all" },
  "student-pdf": { ext: "pdf", mime: "application/pdf", audience: "student", section: "main" },
  "retest-pdf": { ext: "pdf", mime: "application/pdf", audience: "student", section: "retest" },
  "teacher-pdf": { ext: "pdf", mime: "application/pdf", audience: "teacher", section: "all" },
};
let activeExports = 0;

function fail(response, status, message) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ error: "training_export_failed", message }));
}

async function bodyJSON(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error("导出参数过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function exportPhysicsExamTraining({ plan, format, dataDir, root,
  pythonPath = process.env.EXAM_EXPORT_PYTHON || resolve(root, ".venv", "bin", "python") }) {
  const spec = FORMATS[format];
  if (!spec) throw new Error("未知导出格式");
  const dto = training.exportPlanDTO(plan, spec);
  let imageBytes = 0;
  for (const item of dto.items) for (const image of item.question.imageAssets) {
    const id = image.assetId || image.id;
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id || "") || image.kind === "page" || !image.teachingSafe) throw new Error("题图未经审核或未持久保存");
    const meta = JSON.parse(await readFile(join(dataDir, "exam-assets", `${id}.json`), "utf8"));
    if (!["question-crop", "diagram", "table-crop"].includes(meta.kind)) throw new Error("教学导出只允许已审核的题目区域图");
    const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[meta.mimeType];
    if (!ext || !/^\.(png|jpe?g|webp)$/.test(meta.extension || "")) throw new Error("教学导出只接受已保存的题区图片");
    const bytes = await readFile(join(dataDir, "exam-assets", `${id}${meta.extension}`));
    if (bytes.length > 25 * 1024 * 1024) throw new Error("单张题图过大");
    imageBytes += bytes.length;
    if (imageBytes > 64 * 1024 * 1024) throw new Error("训练包题图总量超过64MB");
    image.dataBase64 = bytes.toString("base64");
  }
  await access(pythonPath).catch(() => { throw new Error("缺少文档导出运行环境，请配置 EXAM_EXPORT_PYTHON"); });
  const workDir = await mkdtemp(join(tmpdir(), "physics-exam-export-"));
  try {
    const output = join(workDir, `training.${spec.ext}`);
    const script = resolve(root, "exam-engine", "export-training.py");
    await new Promise((resolveExport, reject) => {
      const child = spawn(pythonPath, [script, "--format", spec.ext, "--output", output], { stdio: ["pipe", "ignore", "pipe"] });
      let error = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("导出超过120秒，请检查题图大小")); }, 120000);
      child.stderr.on("data", data => { error = (error + data.toString()).slice(-4000); });
      child.on("error", errorEvent => { clearTimeout(timer); reject(errorEvent); });
      child.on("close", code => { clearTimeout(timer); code === 0 ? resolveExport() : reject(new Error(`导出程序失败：${error}`)); });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(dto));
    });
    return { bytes: await readFile(output), mime: spec.mime, filename: `changsha-${format}.${spec.ext}` };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function handlePhysicsExamExport({ request, response, url, store, dataDir, root }) {
  const match = /^\/api\/physics-exam\/training-plans\/([^/]+)\/exports?$/.exec(url.pathname);
  if (!match) return false;
  if (request.method !== "POST") { fail(response, 405, "请使用 POST 导出"); return true; }
  if (activeExports >= 2) { fail(response, 429, "正在导出，请稍后重试"); return true; }
  activeExports++;
  try {
    const { format } = await bodyJSON(request);
    const snapshot = store.getEngine();
    const plan = snapshot.engine?.trainingPlans?.find(item => item.id === decodeURIComponent(match[1]));
    if (!plan) { fail(response, 404, "训练包不存在"); return true; }
    const sourceCheck = training.validatePlanAgainstEngine(plan, snapshot.engine);
    if (!sourceCheck.passed) throw new Error(sourceCheck.errors.join("；"));
    const result = await exportPhysicsExamTraining({ plan, format, dataDir, root });
    response.writeHead(200, { "Content-Type": result.mime, "Content-Disposition": `attachment; filename="${result.filename}"`, "Content-Length": result.bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(result.bytes);
  } catch (error) {
    fail(response, 422, error.message);
  } finally {
    activeExports--;
  }
  return true;
}
