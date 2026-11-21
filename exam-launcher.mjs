const launcherId = "physics-exam-workspace";
let previousFocus = null;

function closeWorkspace() {
  const dialog = document.querySelector(`#${launcherId}`);
  if (!dialog) return;
  dialog.close();
  dialog.remove();
  previousFocus?.focus?.({ preventScroll: true });
}

function openWorkspace() {
  if (document.querySelector(`#${launcherId}`)) return;
  previousFocus = document.activeElement;
  const dialog = document.createElement("dialog");
  dialog.id = launcherId;
  dialog.className = "physics-exam-workspace";
  dialog.innerHTML = '<div class="physics-exam-workspace__bar"><span>中考分析引擎</span><button type="button" class="ghost" data-physics-exam-close aria-label="关闭中考分析引擎">关闭</button></div><iframe src="/exam-engine/index.html" title="长沙中考物理分析引擎"></iframe>';
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelector("[data-physics-exam-close]").addEventListener("click", closeWorkspace);
  document.body.appendChild(dialog);
  dialog.showModal();
}

function mountLauncher() {
  const nav = document.querySelector(".workbench-shell .nav");
  if (!nav || nav.querySelector("[data-physics-exam-launch]")) return;
  const group = document.createElement("div");
  group.className = "nav-group physics-exam-nav-group";
  group.innerHTML = '<p class="nav-group-label">真题与专题</p><button type="button" data-physics-exam-launch title="长沙中考物理分析引擎"><span aria-hidden="true">⌁</span><span>中考分析引擎</span><i class="nav-selected-dot"></i></button>';
  group.querySelector("[data-physics-exam-launch]").addEventListener("click", openWorkspace);
  nav.insertBefore(group, nav.querySelector(".nav-group:last-child") || null);
}

document.addEventListener("DOMContentLoaded", () => {
  mountLauncher();
  new MutationObserver(mountLauncher).observe(document.body, { childList: true, subtree: true });
});
window.addEventListener("message", event => {
  if (event.origin !== location.origin || event.data?.type !== "physics-exam-close") return;
  const frame = document.querySelector(`#${launcherId} iframe`);
  if (frame?.contentWindow === event.source) closeWorkspace();
});
