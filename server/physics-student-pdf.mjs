import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const IMAGE_ID = /^[a-zA-Z0-9_-]{8,80}$/;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
let activeExports = 0;

export class StudentPdfError extends Error {
  constructor(message, status = 422) { super(message); this.status = status; }
}

function text(value, max = 20000) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const result = String(value);
  if (result.length > max) throw new StudentPdfError("题目文字过长，请拆分题单后重试");
  return result;
}

/** Defence-in-depth: even a future DTO extension cannot reach the renderer. */
export function studentPdfProjection(payload) {
  if (!Array.isArray(payload?.questions) || !payload.questions.length || payload.questions.length > 100) throw new StudentPdfError("学生题单须包含 1 至 100 道题");
  let imageCount = 0;
  const projected = {
    title: text(payload.title, 120),
    questions: payload.questions.map(question => {
      const images = Array.isArray(question.imageAssets) ? question.imageAssets : [];
      imageCount += images.length;
      if (imageCount > 200) throw new StudentPdfError("题图超过 200 张，请拆分题单");
      if (question.contentMode === "original" && !images.length) throw new StudentPdfError("原题裁图缺失，无法生成学生卷");
      return {
        questionNo: text(question.questionNo, 40),
        score: typeof question.score === "number" && question.score > 0 && Number.isFinite(question.score) ? question.score : null,
        contentMode: question.contentMode === "original" ? "original" : "structured",
        // Original crops already contain the entire stem/options/tables.
        stem: question.contentMode === "original" ? "" : text(question.stem),
        options: question.contentMode === "original" ? [] : (Array.isArray(question.options) ? question.options : []).slice(0, 8).map(option => ({ label: text(option.label, 8), text: text(option.text, 5000) })),
        tables: question.contentMode === "original" ? [] : (Array.isArray(question.tables) ? question.tables : []).slice(0, 10).map(table => ({
          headers: (Array.isArray(table.headers) ? table.headers : []).slice(0, 30).map(cell => text(cell, 1000)),
          rows: (Array.isArray(table.rows) ? table.rows : []).slice(0, 100).map(row => (Array.isArray(row) ? row : []).slice(0, 30).map(cell => text(cell, 1000))),
        })),
        images: images.map(image => {
          if (!IMAGE_ID.test(image.assetId)) throw new StudentPdfError("题图标识无效");
          return { assetId: image.assetId };
        }),
      };
    }),
  };
  if (Buffer.byteLength(JSON.stringify(projected)) > 2 * 1024 * 1024) throw new StudentPdfError("题单内容超过 2MB，请拆分后重试");
  return projected;
}

/** Only call after studentQuestionSetPayload has checked review + current hashes. */
export async function exportStudentQuestionPdf({ payload, dataDir, root,
  pythonPath = process.env.EXAM_EXPORT_PYTHON || resolve(root, ".venv", "bin", "python"), timeoutMs = 60000 }) {
  if (activeExports >= 2) throw new StudentPdfError("已有两份学生卷正在生成，请稍后重试", 429);
  activeExports++;
  let workDir;
  try {
    const dto = studentPdfProjection(payload);
    let totalBytes = 0;
    for (const [index, question] of dto.questions.entries()) for (const image of question.images) {
      try {
        const meta = JSON.parse(await readFile(join(dataDir, "exam-assets", `${image.assetId}.json`), "utf8"));
        if (meta.kind !== "question-crop" || !/^\.(png|jpe?g|webp)$/.test(meta.extension || "")) throw new Error("invalid image metadata");
        const path = join(dataDir, "exam-assets", `${image.assetId}${meta.extension}`);
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new StudentPdfError(`第 ${index + 1} 题的题图超过 16MB`);
        totalBytes += info.size;
        if (totalBytes > MAX_TOTAL_BYTES) throw new StudentPdfError("题图合计超过 64MB，请拆分题单");
        image.dataBase64 = (await readFile(path)).toString("base64");
        delete image.assetId;
      } catch (error) {
        if (error instanceof StudentPdfError) throw error;
        throw new StudentPdfError(`第 ${index + 1} 题的题图缺失或损坏，请回到题目核验后重试`);
      }
    }
    await access(pythonPath).catch(() => { throw new StudentPdfError("缺少 PDF 导出运行环境，请配置 EXAM_EXPORT_PYTHON", 503); });
    workDir = await mkdtemp(join(tmpdir(), "physics-student-pdf-"));
    const output = join(workDir, "student-sheet.pdf");
    await new Promise((done, reject) => {
      const child = spawn(pythonPath, [resolve(root, "exam-engine", "export-student-sheet.py"), "--output", output], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "", expired = false;
      const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, Math.min(60000, Math.max(1, timeoutMs)));
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-1000); });
      child.on("error", () => { clearTimeout(timer); reject(new StudentPdfError("无法启动 PDF 导出程序", 503)); });
      child.on("close", code => {
        clearTimeout(timer);
        if (expired) return reject(new StudentPdfError("PDF 生成超时，请减少题量后重试", 504));
        if (code !== 0 && /font missing/i.test(stderr)) return reject(new StudentPdfError("缺少可嵌入的中文字体，请配置 EXAM_EXPORT_FONT", 503));
        if (code !== 0) return reject(new StudentPdfError(/image|图/i.test(stderr) ? "题图无法读取，请重新核验题图" : "PDF 排版失败，请检查题目内容"));
        done();
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(dto));
    });
    const outputSize = (await stat(output)).size;
    if (outputSize > MAX_TOTAL_BYTES) throw new StudentPdfError("PDF 超过 64MB，请拆分题单");
    const bytes = await readFile(output);
    if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new StudentPdfError("PDF 生成失败");
    return { bytes, mime: "application/pdf", filename: "physics-student-sheet.pdf" };
  } finally {
    try { if (workDir) await rm(workDir, { recursive: true, force: true }); }
    finally { activeExports--; }
  }
}
