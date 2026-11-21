/* Student printing consumes the server allow-list only. Original crops are
 * the authoritative printable content; their OCR is an on-screen aid. */
(function () {
  "use strict";
  const idPattern = /^[a-zA-Z0-9_-]{8,250}$/;
  const assetUrlPattern = /^\/api\/physics-exam\/assets\/[a-zA-Z0-9_-]{8,80}$/;
  const loading = document.querySelector("[data-sheet-loading]");
  const error = document.querySelector("[data-sheet-error]");
  const content = document.querySelector("[data-sheet-content]");
  const printButton = document.querySelector("[data-sheet-print]");
  const pdfButton = document.querySelector("[data-sheet-pdf]");
  const retryButton = document.querySelector("[data-sheet-retry]");
  const assetStatus = document.querySelector("[data-sheet-asset-status]");
  let printAvailable = false;
  let imageItems = [];
  let loadingSheet = false;
  let loadAttempt = 0;

  const text = value => value == null ? "" : String(value);
  function node(tag, value, className) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (value != null) result.textContent = text(value);
    return result;
  }
  function setPrintAvailable(available) {
    printAvailable = available;
    printButton.disabled = !available;
    if (pdfButton) pdfButton.disabled = !available;
    printButton.textContent = available ? "打印／存为 PDF" : "题目载入后可打印";
    document.body.classList.toggle("sheet-not-ready", !available);
  }
  function allImagesReady() {
    return imageItems.every(({ image }) => image.complete && image.naturalWidth > 0);
  }
  function showError(message) {
    loading.hidden = true;
    error.hidden = false;
    error.textContent = message || "题单暂不可用，请回到教师工作台核对。";
    retryButton.hidden = false;
    setPrintAvailable(false);
  }
  function appendTable(parent, table) {
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    const headers = Array.isArray(table?.headers) ? table.headers : [];
    if (!headers.length && !rows.length) return;
    const wrap = node("div", null, "student-table-wrap"), element = node("table", null, "student-table");
    if (headers.length) {
      const thead = document.createElement("thead"), tr = document.createElement("tr");
      headers.forEach(cell => tr.append(node("th", cell)));
      thead.append(tr); element.append(thead);
    }
    const tbody = document.createElement("tbody");
    rows.forEach(row => {
      const tr = document.createElement("tr");
      (Array.isArray(row) ? row : []).forEach(cell => tr.append(node("td", cell)));
      tbody.append(tr);
    });
    element.append(tbody); wrap.append(element); parent.append(wrap);
  }
  function appendStructuredContent(parent, question) {
    parent.append(node("div", question?.stem || "", "student-stem"));
    (Array.isArray(question?.options) ? question.options : []).forEach(option => {
      const value = typeof option === "string" ? option : `${text(option?.label)}. ${text(option?.text)}`;
      parent.append(node("p", value, "student-option"));
    });
    (Array.isArray(question?.tables) ? question.tables : []).forEach(table => appendTable(parent, table));
  }
  function appendQuestion(parent, question, index) {
    const number = index + 1;
    const originalMode = question?.contentMode === "original";
    const assets = Array.isArray(question?.imageAssets) ? question.imageAssets : [];
    if (originalMode && !assets.length) throw new Error(`第 ${number} 题缺少完整原题图，请回到教师工作台核对。`);
    if (assets.some(asset => !assetUrlPattern.test(text(asset?.url)))) throw new Error(`第 ${number} 题的题图链接无效，请回到教师工作台核对。`);
    const article = node("section", null, `student-question${originalMode ? " student-question-original" : ""}`);
    const heading = node("h2", null, "student-question-title");
    const score = Number.isFinite(Number(question?.score)) && Number(question.score) > 0 ? `（${Number(question.score)}分）` : "";
    heading.append(node("span", `第 ${number} 题${score}`));
    if (text(question?.questionNo) && text(question.questionNo) !== String(number)) heading.append(node("small", `原卷第 ${text(question.questionNo)} 题`, "student-source-number"));
    article.append(heading);
    if (!originalMode) appendStructuredContent(article, question);
    assets.forEach((asset, imageIndex) => {
      const fragment = node("figure", null, "student-question-fragment");
      if (imageIndex > 0) fragment.append(node("figcaption", `第 ${number} 题（续 ${imageIndex}）`, "student-continuation"));
      const image = node("img", null, "student-question-image");
      image.loading = "eager";
      image.decoding = "sync";
      image.alt = `第 ${number} 题${assets.length > 1 ? `，第 ${imageIndex + 1} 段` : ""}原题图`;
      fragment.append(image); article.append(fragment);
      imageItems.push({ image, url: asset.url, label: `第 ${number} 题第 ${imageIndex + 1} 张题图` });
    });
    if (originalMode) {
      const optionalText = node("details", null, "student-ocr-reference");
      optionalText.append(node("summary", "查看辅助文字（不打印，以原题图为准）"));
      appendStructuredContent(optionalText, question);
      article.append(optionalText);
    }
    article.append(node("div", "作答：", "student-answer-space"));
    parent.append(article);
  }
  function render(payload) {
    if (!Array.isArray(payload.questions) || !payload.questions.length) throw new Error("题单没有题目，请回到教师工作台核对。");
    content.replaceChildren();
    imageItems = [];
    const title = node("h1", payload.title || "学生练习卷", "student-sheet-title");
    content.append(title);
    content.append(node("p", "班级：_______________　姓名：_______________　日期：_______________", "student-sheet-identity"));
    content.append(node("p", `共 ${payload.questions.length} 题。请独立作答，写清必要的物理依据和步骤。`, "student-sheet-note"));
    payload.questions.forEach((question, index) => appendQuestion(content, question, index));
    content.hidden = false;
    document.title = text(payload.title) || "学生练习卷";
  }
  function loadImage(item, attempt) {
    const { image, label } = item;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = reason => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
        reason ? reject(new Error(`${label}${reason}`)) : resolve();
      };
      const onLoad = async () => {
        if (!(image.naturalWidth > 0)) { finish("未能载入"); return; }
        try { if (typeof image.decode === "function") await image.decode(); finish(); }
        catch { finish("无法解码，请重试"); }
      };
      const onError = () => finish("载入失败");
      const timer = setTimeout(() => finish("载入超时"), 30000);
      image.addEventListener("load", onLoad);
      image.addEventListener("error", onError);
      image.src = attempt > 1 ? `${item.url}?sheet_retry=${attempt}` : item.url;
      if (image.complete) image.naturalWidth > 0 ? onLoad() : onError();
    });
  }
  async function boot() {
    if (loadingSheet) return;
    loadingSheet = true;
    setPrintAvailable(false);
    loading.hidden = false;
    error.hidden = true;
    content.hidden = true;
    retryButton.hidden = true;
    assetStatus.textContent = "正在载入题目…";
    const setId = new URLSearchParams(location.search).get("set") || "";
    const attempt = ++loadAttempt;
    try {
      if (!idPattern.test(setId)) throw new Error("题单链接无效。请由教师从题单工作台打开学生卷。");
      const response = await fetch(`/api/physics-exam/question-sets/${encodeURIComponent(setId)}/student`, { cache: "no-store", credentials: "same-origin" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "题单尚未完成审核");
      render(payload);
      loading.hidden = true;
      const total = imageItems.length;
      let completed = 0;
      assetStatus.textContent = total ? `正在载入完整题图：0 / ${total}；全部载入后可打印。` : "正在准备打印…";
      const results = await Promise.allSettled(imageItems.map(item => loadImage(item, attempt).then(() => {
        completed += 1;
        assetStatus.textContent = `正在载入完整题图：${completed} / ${total}；全部载入后可打印。`;
      })));
      const failed = results.filter(result => result.status === "rejected");
      if (failed.length) throw new Error(`${failed.map(result => result.reason.message).join("；")}。请点击“重新载入”，题图补齐前不能打印。`);
      assetStatus.textContent = total ? `全部 ${total} 张题图已载入，可以打印。` : "题目已完整载入，可以打印。";
      setPrintAvailable(true);
    } catch (reason) {
      assetStatus.textContent = "题目尚未完整载入。";
      showError(reason?.message || "学生卷载入失败");
    } finally {
      loadingSheet = false;
    }
  }
  printButton.addEventListener("click", () => {
    if (!printAvailable || !allImagesReady()) { showError("题图尚未完整载入，请点击“重新载入”后再打印。"); return; }
    window.print();
  });
  retryButton.addEventListener("click", boot);
  pdfButton?.addEventListener("click", async () => {
    if (!printAvailable || !allImagesReady()) return;
    const setId = new URLSearchParams(location.search).get("set") || "";
    if (!idPattern.test(setId)) return;
    pdfButton.disabled = true;
    pdfButton.textContent = "正在生成 PDF…";
    error.hidden = true;
    try {
      const response = await fetch(`/api/physics-exam/question-sets/${encodeURIComponent(setId)}/student.pdf`, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || "PDF 生成失败，请稍后重试。");
      }
      if (!(response.headers.get("content-type") || "").includes("application/pdf")) throw new Error("服务器未返回有效 PDF，请重新核对题单。");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${(document.title || "学生练习卷").replace(/[\\/:*?"<>|]/g, "_")}.pdf`;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      assetStatus.textContent = "学生卷 PDF 已生成并发起下载，可打开打印；文件不含答案与解析。";
    } catch (reason) {
      error.hidden = false;
      error.textContent = reason?.message || "PDF 生成失败，请重试。";
    } finally {
      pdfButton.disabled = !printAvailable;
      pdfButton.textContent = "下载学生卷 PDF";
    }
  });
  window.addEventListener("beforeprint", () => {
    // Native print shortcuts cannot be disabled; an incomplete sheet prints
    // a clear retry notice instead of questions with missing diagrams.
    document.body.classList.toggle("sheet-not-ready", !printAvailable || !allImagesReady());
  });
  boot();
})();
