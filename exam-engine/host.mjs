import { applyBridgeSnapshot, readConfirmedWrongbook } from "./bridge-v2.mjs";

const app = document.querySelector("#exam-engine-app");
const options = new URLSearchParams(location.search);
const state = {
  examEngine: {},
  lesson: {},
  grades: [],
  knowledge: {},
  wrongbook: { columns: [], rows: [], confirmed: false },
  panelBridge: { available: false, reason: "正在读取课前测确认记录…" },
};

function toast(message, level = "info") {
  const stack = document.querySelector(".physics-exam-toast-stack");
  if (!stack) return;
  const node = document.createElement("div");
  node.className = `physics-exam-toast physics-exam-toast--${level}`;
  node.textContent = String(message || "操作已完成");
  stack.appendChild(node);
  setTimeout(() => node.remove(), 4800);
}

function downloadText(name, content, type = "text/plain;charset=utf-8") {
  const href = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 30000);
}

async function callVisionModel(prompt, imageDataUrl = "") {
  const content = imageDataUrl
    ? [{ type: "image_url", image_url: { url: imageDataUrl } }, { type: "text", text: prompt }]
    : prompt;
  const response = await fetch("/.netlify/functions/vision-proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payload: {
        temperature: 0.1,
        messages: [{ role: "user", content }],
      },
    }),
    signal: AbortSignal.timeout(150000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `AI 服务返回 ${response.status}`);
  const answer = data?.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) throw new Error("AI 未返回可用内容");
  return answer.trim();
}

async function refreshPanelBridge({ silent = false } = {}) {
  const snapshot = await readConfirmedWrongbook(options.get("sessionId"));
  const before = JSON.stringify(state.panelBridge || {});
  applyBridgeSnapshot(state, snapshot);
  let revoked = 0;
  if (window.ExamDomain?.reconcileWrongbook) {
    const result = window.ExamDomain.reconcileWrongbook(state);
    revoked = Number(result?.revoked || 0);
    if (revoked) window.ExamAnalysisEngine?.schedulePersist?.(state.examEngine);
  }
  if (!silent) {
    if (snapshot.available) toast(`已读取课前测已确认错题${revoked ? `；已撤销 ${revoked} 条失效旧证据` : ""}`);
    else toast(snapshot.reason || "当前课次没有可同步的已确认错题", "warning");
  }
  return { snapshot, changed: before !== JSON.stringify(state.panelBridge || {}) || revoked > 0 };
}

const host = {
  state,
  render,
  toast,
  downloadText,
  callVisionModel,
  refreshPanelBridge,
  saveState() {
    window.ExamAnalysisEngine?.schedulePersist?.(state.examEngine);
  },
};

function render() {
  if (!window.ExamAnalysisEngine) {
    app.innerHTML = '<section class="section"><h3>中考分析引擎加载失败</h3><p class="hint">请刷新页面；如果仍失败，请检查本机服务是否已重新启动。</p></section>';
    return;
  }
  app.innerHTML = window.ExamAnalysisEngine.view(state);
  window.ExamAnalysisEngine.bind(host);
  const intro = app.querySelector(".engine-intro");
  if (intro && !intro.querySelector("[data-physics-exam-bridge-status]")) {
    const bridge = document.createElement("p");
    bridge.className = "physics-exam-bridge-status hint";
    bridge.dataset.physicsExamBridgeStatus = "";
    bridge.textContent = state.panelBridge.available
      ? `课前测桥接：已读取第 ${state.lesson.lessonNo || "—"} 次课的人工确认快照（不回写主面板）。`
      : `课前测桥接：${state.panelBridge.reason || "暂无可用的已确认错题"}`;
    intro.querySelector("div")?.appendChild(bridge);
  }
}

document.querySelector("[data-physics-exam-refresh]")?.addEventListener("click", async () => {
  try { await refreshPanelBridge(); render(); } catch (error) { toast(error.message, "error"); }
});
document.querySelector("[data-physics-exam-close]")?.addEventListener("click", () => {
  if (window.parent !== window) window.parent.postMessage({ type: "physics-exam-close" }, location.origin);
  else history.back();
});

window.addEventListener("unhandledrejection", event => {
  const message = String(event.reason?.message || event.reason || "未知错误");
  toast(message, "error");
});

async function boot() {
  if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdf.worker.min.js";
  const deadline = Date.now() + 5000;
  while (!window.ExamAnalysisEngine && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 16));
  if (!window.ExamAnalysisEngine) { render(); return; }
  try { await refreshPanelBridge({ silent: true }); } catch (error) { state.panelBridge.reason = error.message; }
  try { await window.ExamAnalysisEngine.restore(state, render); } catch (error) { toast(`引擎数据恢复失败：${error.message}`, "error"); }
  const requestedSet = state.examEngine.questionSets?.find(set => set.id === options.get("set") && set.status !== "archived");
  if (requestedSet) {
    state.examEngine.settings.activeQuestionSetId = requestedSet.id;
    state.examEngine.activeTab = "questionSets";
  } else if (options.get("catalog") === "overview") {
    state.examEngine.activeTab = "questions";
    state.examEngine.overviewReturnFilters = { ...state.examEngine.questionFilters };
    state.examEngine.questionFilters = { ...state.examEngine.questionFilters, view: "overview" };
  }
  render();
  setInterval(() => refreshPanelBridge({ silent: true }).then(result => { if (result.changed) render(); }).catch(() => {}), 60000);
}

boot();
