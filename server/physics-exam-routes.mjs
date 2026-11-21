import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { AppError } from "./store.mjs";
import { StoreError } from "./physics-exam-store.mjs";
import { handlePhysicsExamExport } from "./physics-exam-export-service.mjs";
import { readBody, sendJson } from "./routes.mjs";
import StudentQuestionSets from "../exam-engine/student-question-set.js";
import { exportStudentQuestionPdf } from "./physics-student-pdf.mjs";
import { paperContext, engineWithPanelEvidence, buildPaperDiagnosis, savePaperBinding, createSimilarQuestionSet, assignDiagnosticCorrections } from "./physics-paper-diagnosis.mjs";

const ROOT = "/api/physics-exam";
const MAX_ASSET_BYTES = 80 * 1024 * 1024;
const MAX_ENGINE_BYTES = 45 * 1024 * 1024;
const assetIdPattern = /^[a-zA-Z0-9_-]{8,80}$/;
const collections = { exams: "canonicalExams", questions: "questions", attempts: "attempts", "training-plans": "trainingPlans", "question-sets": "questionSets", analyses: "analysisRuns", sources: "files", "dedupe-groups": "canonicalExams" };

export function isPhysicsExamPath(pathname) {
  return pathname === ROOT || pathname.startsWith(ROOT + "/");
}

export async function routePhysicsExam(request, response, url, context) {
  if (!isPhysicsExamPath(url.pathname)) return false;
  const path = url.pathname.slice(ROOT.length) || "/";
  if (path === "/bridge") {
    if (request.method !== "GET") throw new AppError("不支持的操作", 405);
    sendJson(response, 200, paperContext(context.panelStore.get(), url.searchParams.get("sessionId") || ""));
    return true;
  }
  if (path === "/assets" || path.startsWith("/assets/")) {
    await routeAssets(request, response, path, context.dataDir);
    return true;
  }
  if (path === "/library/stats" || path === "/library/report" || path === "/library/search" || path.startsWith("/library/items/")) {
    await routeMaterialLibrary(request, response, path, url, context);
    return true;
  }
  const diagnosis = /^\/assessments\/([^/]+)\/diagnosis(?:\/(binding|practice|corrections))?$/.exec(path);
  if (diagnosis) {
    const [, encodedSession, operation] = diagnosis;
    const sessionId = decodeURIComponent(encodedSession);
    if ((!operation && request.method !== "GET") || (operation && request.method !== "POST")) {
      throw new AppError("不支持的操作", 405);
    }
    const body = operation ? await jsonBody(request, 64 * 1024) : null;
    const record = context.panelStore.get(), paper = paperContext(record, sessionId);
    if (operation === "corrections") {
      sendJson(response, 200, assignDiagnosticCorrections(context.panelStore, record, paper, body));
      return true;
    }
    const store = context.getStore(), stored = store.getEngine();
    const result = operation === "binding" ? savePaperBinding(store, paper, stored, body)
      : operation === "practice" ? createSimilarQuestionSet(store, paper, stored, body)
      : buildPaperDiagnosis(paper, stored);
    sendJson(response, operation === "practice" ? 201 : 200, result);
    return true;
  }
  const store = context.getStore();
  const studentPdf = path.match(/^\/question-sets\/([a-zA-Z0-9_-]{8,250})\/student\.pdf$/);
  if (studentPdf) {
    if (request.method !== "GET") { sendJson(response, 405, { error: "method_not_allowed" }); return true; }
    try {
      // Exactly the same gate as the browser sheet: reviewed content, approved
      // immutable assets and the teacher-confirmed current question hashes.
      const payload = await studentQuestionSetPayload(store.getEngine().engine, studentPdf[1], context.dataDir);
      const result = await exportStudentQuestionPdf({ payload, dataDir: context.dataDir, root: context.root });
      const current = await studentQuestionSetPayload(store.getEngine().engine, studentPdf[1], context.dataDir);
      if (JSON.stringify(current) !== JSON.stringify(payload)) throw new Error("生成期间题单已变更，请重新确认后下载");
      response.writeHead(200, { "Content-Type": result.mime, "Content-Disposition": `attachment; filename="${result.filename}"`, "Content-Length": result.bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(result.bytes);
    } catch (error) { sendJson(response, error.status || 409, { error: "student_pdf_unavailable", message: error instanceof Error ? error.message : "学生 PDF 暂不可用" }); }
    return true;
  }
  const studentSet = path.match(/^\/question-sets\/([a-zA-Z0-9_-]{8,250})\/student$/);
  if (studentSet) {
    if (request.method !== "GET") { sendJson(response, 405, { error: "method_not_allowed" }); return true; }
    try { sendJson(response, 200, await studentQuestionSetPayload(store.getEngine().engine, studentSet[1], context.dataDir)); }
    catch (error) { sendJson(response, 409, { error: "student_question_set_unavailable", message: error instanceof Error ? error.message : "学生题单暂不可用" }); }
    return true;
  }
  if (await handlePhysicsExamExport({ request, response, url, store, dataDir: context.dataDir, root: context.root })) return true;
  if (path === "/engine" && request.method === "GET") {
    sendJson(response, 200, engineWithPanelEvidence(store.getEngine(), context.panelStore.get()));
    return true;
  }
  if (path === "/engine" && request.method === "PUT") { sendJson(response, 405, { error: "snapshot_write_disabled", message: "请使用带版本与幂等键的增量接口" }); return true; }
  if (path === "/engine/changes" && request.method === "POST") { sendJson(response, 200, store.commit(await jsonBody(request, MAX_ENGINE_BYTES))); return true; }
  if (path === "/engine/backups") {
    if (request.method === "GET") { sendJson(response, 200, { items: await store.backups(), revision: store.revision }); return true; }
    if (request.method === "POST") { sendJson(response, 201, await store.backup(await jsonBody(request))); return true; }
  }
  const restore = path.match(/^\/engine\/backups\/(backup_[a-f0-9]{32})\/restore$/);
  if (restore && request.method === "POST") { sendJson(response, 200, await store.restoreBackup(restore[1], await jsonBody(request))); return true; }
  if (path === "/imports/jobs") {
    if (request.method === "GET") { sendJson(response, 200, store.list("importJobs", page(url))); return true; }
    if (request.method === "POST") {
      const body = await jsonBody(request);
      const job = { ...(body.job || {}), id: body.job?.id || randomUUID(), status: "queued", createdAt: new Date().toISOString(), checkpoint: body.job?.checkpoint || null };
      const result = store.commit({ baseRevision: body.baseRevision, requestId: body.requestId, changes: [{ collection: "importJobs", id: job.id, value: job }], meta: { action: "import_queued" } });
      sendJson(response, 201, { ...result, job });
      return true;
    }
  }
  const parts = path.split("/").filter(Boolean);
  const collection = collections[parts[0]] || (parts[0] === "imports" && parts[1] === "jobs" ? "importJobs" : null);
  const id = collection === "importJobs" ? parts[2] : parts[1];
  const action = collection === "importJobs" ? parts[3] : parts[2];
  if (collection && request.method === "GET") {
    if (!id) { sendJson(response, 200, store.list(collection, page(url))); return true; }
    const entity = store.get(collection, id);
    if (!entity) { sendJson(response, 404, { error: "entity_not_found" }); return true; }
    sendJson(response, 200, action === "history" ? { items: store.history(collection, id), revision: store.revision } : { entity, revision: store.revision });
    return true;
  }
  if (collection && id && request.method === "POST" && ["verify", "revoke", "pause", "resume", "cancel"].includes(action)) {
    const body = await jsonBody(request), entity = store.get(collection, id);
    if (!entity) { sendJson(response, 404, { error: "entity_not_found" }); return true; }
    const at = new Date().toISOString();
    let value = { ...entity };
    if (collection === "importJobs") {
      if (!["pause", "resume", "cancel"].includes(action)) throw new StoreError(422, "invalid_job_action");
      value.status = { pause: "paused", resume: "queued", cancel: "cancelled" }[action];
      value.updatedAt = at;
    } else if (collection === "attempts") {
      value.manualVerified = action === "verify";
      value.verificationStatus = action === "verify" ? "verified" : "revoked";
      value.status = value.verificationStatus;
      value.verifiedAt = action === "verify" ? at : entity.verifiedAt;
      value.verifiedBy = "local_teacher";
      value.reviewedBy = "local_teacher";
      value.migrationNeedsReview = false;
      value.revokedAt = action === "revoke" ? at : "";
    } else if (collection === "questions") {
      value.reviewed = action === "verify";
      value.reviewedAt = at;
      value.reviewedBy = "local_teacher";
      value.migrationNeedsReview = false;
    } else throw new StoreError(422, "unsupported_review_target");
    const event = { id: randomUUID(), entityType: collection, entityId: id, status: action === "verify" ? "confirmed" : action, reviewer: "local_teacher", at };
    sendJson(response, 200, { ...store.commit({ baseRevision: body.baseRevision, requestId: body.requestId, changes: [{ collection, id, value }, { collection: "auditEvents", id: event.id, value: event }], meta: { action: "teacher_review", reviewer: "local_teacher" } }), entity: value });
    return true;
  }
  sendJson(response, 405, { error: "method_not_allowed" });
  return true;
}

/**
 * This is intentionally an allow-list projection, not a clone-and-delete
 * projection. Full questions hold teacher-only answers, analyses, source PDFs,
 * tags and audit metadata; none of those fields can reach a student sheet.
 */
export async function studentQuestionSetPayload(engine, setId, dataDir) {
  if (!StudentQuestionSets.ID.test(String(setId || ""))) throw new Error("题单标识无效");
  const set = (engine.questionSets || []).find(item => item.id === setId);
  if (!set) throw new Error("学生题单不存在");
  const assetsByQuestion = new Map();
  for (const question of (engine.questions || [])) assetsByQuestion.set(question.id, await approvedStudentAssets(question, dataDir));
  const payload = StudentQuestionSets.studentSetDTO(set, engine.questions || [], { assetLookup: question => assetsByQuestion.get(question.id) || [] });
  for (const question of payload.questions) {
    question.imageAssets = question.imageAssets.map(image => ({
      assetId: image.assetId,
      url: `${ROOT}/assets/${image.assetId}`,
      alt: image.alt,
    }));
  }
  return payload;
}

async function approvedStudentAssets(question, dataDir) {
  const safe = StudentQuestionSets.safeImageAssets(question);
  const allowed = [];
  for (const image of safe) {
    const metaPath = join(dataDir, "exam-assets", `${image.assetId}.json`);
    if (!existsSync(metaPath)) continue;
    let meta;
    try { meta = JSON.parse(await readFile(metaPath, "utf8")); } catch { continue; }
    const extension = extensionSafe(meta.extension);
    if (meta.kind !== "question-crop" || extension === ".bin" || !existsSync(join(dataDir, "exam-assets", `${image.assetId}${extension}`))) continue;
    // The stored asset provenance, not client-supplied generatedBy/pageNo,
    // decides whether a crop contains the complete original question. A
    // generic diagram may still be used alongside structured text.
    if (meta.sourceDocumentId && meta.sourceDocumentId !== question.sourceFileId) continue;
    const pageNo = Number(meta.pageNo || image.pageNo);
    const version = String(meta.extractionRunId || "").split(":")[0];
    const originalCrop = meta.immutable === true && /^page-assets-backfill-v[23]$/.test(version)
      && meta.extractionRunId === `${version}:${question.sourceFileId}`
      && meta.sourceDocumentId === question.sourceFileId
      && Number.isInteger(pageNo) && pageNo > 0
      && meta.fileName === `${question.id}-p${pageNo}${extension}`;
    // Only internal readiness metadata; the student DTO strips these fields.
    allowed.push({ assetId: image.assetId, alt: image.alt, pageNo, generatedBy: originalCrop ? version : "" });
  }
  return allowed;
}

async function routeMaterialLibrary(request, response, path, url, context) {
  if (request.method !== "GET") { sendJson(response, 405, { error: "method_not_allowed" }); return; }
  const library = context.getMaterialLibrary();
  if (path === "/library/stats") { sendJson(response, 200, library.stats()); return; }
  if (path === "/library/report") {
    const reportPath = join(context.dataDir, "corpus-import-report.json");
    if (!existsSync(reportPath)) { sendJson(response, 404, { error: "corpus_not_indexed", message: "资料库尚未执行批量收录" }); return; }
    try { sendJson(response, 200, JSON.parse(await readFile(reportPath, "utf8"))); }
    catch { sendJson(response, 500, { error: "corpus_report_invalid" }); }
    return;
  }
  if (path === "/library/search") {
    const result = library.search({
      q: url.searchParams.get("q") || "", layer: url.searchParams.get("layer") || "",
      grade: url.searchParams.get("grade") || "", year: url.searchParams.get("year") || "",
      region: url.searchParams.get("region") || "", role: url.searchParams.get("role") || "",
      includeDuplicates: url.searchParams.get("includeDuplicates") === "1",
      limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset"),
    });
    sendJson(response, 200, result); return;
  }
  const match = path.match(/^\/library\/items\/([a-zA-Z0-9_-]{8,250})(\/source)?$/);
  if (!match) { sendJson(response, 404, { error: "library_item_not_found" }); return; }
  const item = library.get(match[1]);
  if (!item) { sendJson(response, 404, { error: "library_item_not_found" }); return; }
  if (!match[2]) {
    const { textContent, ...metadata } = item;
    sendJson(response, 200, { item: metadata, textPreview: String(textContent || "").slice(0, 20_000), textTruncated: String(textContent || "").length > 20_000 });
    return;
  }
  await streamLibrarySource(response, item, context.root, context.env || process.env);
}

function librarySourcePath(path, allowedDirectory) {
  if (!allowedDirectory) return null;
  try {
    const source = realpathSync(path);
    const allowedRoot = realpathSync(allowedDirectory);
    return source.startsWith(allowedRoot + sep) && statSync(source).isFile() ? source : null;
  } catch {
    return null;
  }
}

async function streamLibrarySource(response, item, root, env) {
  const extension = String(item.extension || "").replace(/^\./, "").toLowerCase();
  const contentType = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword" }[extension] || "application/octet-stream";
  const disposition = extension === "pdf" ? "inline" : "attachment";
  const headers = { "Content-Type": contentType, "Cache-Control": "private, max-age=0, no-store", "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(String(item.fileName || "source"))}`, "X-Content-Type-Options": "nosniff" };
  if (item.sourcePath) {
    const sourcePath = librarySourcePath(item.sourcePath, env.EXAM_LIBRARY_SOURCE_DIR);
    if (!sourcePath) { sendJson(response, 404, { error: "source_file_unavailable" }); return; }
    headers["Content-Length"] = String(statSync(sourcePath).size);
    response.writeHead(200, headers); createReadStream(sourcePath).on("error", () => response.destroy()).pipe(response); return;
  }
  if (item.archivePath && item.archiveEntry) {
    const archivePath = librarySourcePath(item.archivePath, env.EXAM_LIBRARY_ARCHIVE_DIR);
    if (!archivePath) { sendJson(response, 404, { error: "source_archive_unavailable" }); return; }
    const python = env.EXAM_IMPORT_PYTHON || resolve(root, ".venv", "bin", "python");
    if (!existsSync(python)) { sendJson(response, 503, { error: "archive_runtime_unavailable" }); return; }
    headers["Content-Length"] = String(item.bytes || "");
    response.writeHead(200, headers);
    const child = spawn(python, [join(root, "scripts", "stream-physics-archive-entry.py"), archivePath, item.archiveEntry], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.pipe(response); child.on("error", () => response.destroy()); child.on("close", code => { if (code && !response.writableEnded) response.destroy(); });
    return;
  }
  sendJson(response, 404, { error: "source_file_unavailable" });
}

function page(url) { return { limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset") }; }

async function jsonBody(request, maxBytes) {
  try { return JSON.parse((await readBody(request, maxBytes)).toString("utf8")); }
  catch (error) {
    if (error instanceof StoreError || error instanceof AppError) throw error;
    throw new StoreError(400, "invalid_json", "JSON 格式不正确");
  }
}

async function routeAssets(request, response, path, dataDir) {
  const assetId = path === "/assets" ? "" : path.slice("/assets/".length);
  const dir = join(dataDir, "exam-assets");
  if (request.method === "GET") {
    if (!assetIdPattern.test(assetId)) { sendJson(response, 404, { error: "asset_not_found" }); return; }
    const metaPath = join(dir, `${assetId}.json`);
    if (!existsSync(metaPath)) { sendJson(response, 404, { error: "asset_not_found" }); return; }
    let meta;
    try { meta = JSON.parse(await readFile(metaPath, "utf8")); } catch { sendJson(response, 404, { error: "asset_not_found" }); return; }
    const extension = extensionSafe(meta.extension);
    const assetPath = join(dir, `${assetId}${extension}`);
    if (!existsSync(assetPath)) { sendJson(response, 404, { error: "asset_not_found" }); return; }
    response.writeHead(200, { "Content-Type": String(meta.mimeType || "application/octet-stream"), "Content-Length": String(meta.bytes || 0), "Cache-Control": "private, max-age=0, no-store", "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(String(meta.fileName || "source"))}`, "X-Content-Type-Options": "nosniff" });
    createReadStream(assetPath).on("error", () => response.destroy()).pipe(response);
    return;
  }
  if (request.method !== "POST" || assetId) { sendJson(response, 405, { error: "method_not_allowed" }); return; }
  const bytes = await readBody(request, MAX_ASSET_BYTES);
  const mime = String(request.headers["content-type"] || "application/octet-stream").split(";")[0].trim().toLowerCase();
  const extension = extensionSafe(request.headers["x-asset-extension"] || extensionForMime(mime));
  const detected = inspectAsset(bytes);
  if (!detected || detected.mime !== mime || !detected.extensions.includes(extension)) throw new StoreError(415, "asset_signature_mismatch", "仅支持真实 PDF、PNG、JPEG 或 WebP");
  if (detected.width && (detected.width > 30000 || detected.height > 30000 || detected.width * detected.height > 100000000)) throw new StoreError(422, "image_dimensions_exceeded");
  const parentAssetId = String(request.headers["x-asset-parent-id"] || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  const pageNo = Number(request.headers["x-asset-page-no"] || 0) || null;
  const kind = String(request.headers["x-asset-kind"] || "source").slice(0, 40);
  if (pageNo != null && (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > 5000)) throw new StoreError(422, "invalid_page_number");
  if (parentAssetId && !existsSync(join(dir, `${parentAssetId}.json`))) throw new StoreError(422, "unknown_parent_asset");
  if (!["source", "original-pdf"].includes(kind) && (!parentAssetId || !pageNo)) throw new StoreError(422, "derived_asset_requires_parent_and_page");
  const crop = String(request.headers["x-asset-crop"] || "").slice(0, 500);
  if (crop) validateCrop(crop);
  const declaredFile = String(request.headers["x-asset-filename"] || `source${extension}`);
  let fileName;
  try { fileName = decodeURIComponent(declaredFile); } catch { fileName = declaredFile; }
  fileName = safeFileName(fileName);
  const id = `asset_${randomUUID().replace(/-/g, "")}`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const meta = { id, fileName, mimeType: mime, extension, kind, bytes: bytes.length, sha256, declaredSha256: String(request.headers["x-asset-sha256"] || "").replace(/[^a-f0-9]/gi, "").slice(0, 64) || null, parentAssetId, sourceDocumentId: String(request.headers["x-asset-source-document-id"] || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100), extractionRunId: String(request.headers["x-asset-extraction-run"] || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100), pageNo, crop, perceptualHash: String(request.headers["x-asset-phash"] || "").replace(/[^a-f0-9]/gi, "").slice(0, 128), immutable: true, width: detected.width || null, height: detected.height || null, savedAt: new Date().toISOString() };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, `${id}${extension}`), bytes, { mode: 0o600 });
  await writeFile(join(dir, `${id}.json`), JSON.stringify(meta, null, 2), { encoding: "utf8", mode: 0o600 });
  sendJson(response, 201, { id, url: `${ROOT}/assets/${id}`, fileName, mimeType: mime, kind, bytes: bytes.length, sha256, parentAssetId, sourceDocumentId: meta.sourceDocumentId, extractionRunId: meta.extractionRunId, pageNo, perceptualHash: meta.perceptualHash, persistent: true });
}

function extensionSafe(value) { return /^\.(?:pdf|png|jpe?g|webp)$/i.test(String(value || "")) ? String(value).toLowerCase() : ".bin"; }
function extensionForMime(mime) { return { "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[mime] || ".bin"; }
function safeFileName(value) { return String(value || "source").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").slice(0, 180) || "source"; }
function validateCrop(value) { let data; try { data = JSON.parse(value); } catch { throw new StoreError(422, "invalid_crop"); } const values = Array.isArray(data) ? data : [data.x, data.y, data.width, data.height]; if (values.length !== 4 || !values.every(Number.isFinite) || values[0] < 0 || values[1] < 0 || values[2] <= 0 || values[3] <= 0) throw new StoreError(422, "invalid_crop_bounds"); }
function inspectAsset(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 5).toString() === "%PDF-" && bytes.subarray(-2048).includes(Buffer.from("%%EOF"))) return { mime: "application/pdf", extensions: [".pdf"] };
  if (bytes.length >= 57 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.subarray(12,16).toString() === "IHDR" && bytes.includes(Buffer.from("IDAT")) && bytes.subarray(-8,-4).toString() === "IEND") return { mime: "image/png", extensions: [".png"], width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) { let offset = 2; while (offset + 8 < bytes.length) { if (bytes[offset] !== 255) break; const marker = bytes[offset + 1]; offset += 2; if (marker === 0xd9 || marker === 0xda) break; const length = bytes.readUInt16BE(offset); if (length < 2 || offset + length > bytes.length) break; if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) return { mime: "image/jpeg", extensions: [".jpg", ".jpeg"], height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) }; offset += length; } return null; }
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") { const type = bytes.subarray(12, 16).toString(); if (type === "VP8X") return { mime: "image/webp", extensions: [".webp"], width: 1 + bytes.readUIntLE(24,3), height: 1 + bytes.readUIntLE(27,3) }; if (type === "VP8 " && bytes.length >= 30) return { mime: "image/webp", extensions: [".webp"], width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }; if (type === "VP8L" && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); return { mime: "image/webp", extensions: [".webp"], width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; } }
  return null;
}
