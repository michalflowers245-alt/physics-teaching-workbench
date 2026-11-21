import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const printSource = readFileSync(new URL("../exam-engine/student-print.js", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

// Exercise the actual standalone page script: there is no browser-only test
// API and no production database writes. The parent task also checks layout
// in a real browser, since a DOM double cannot prove paper pagination.
function page(payload) {
  const elements = [];
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.listeners = new Map();
      this.className = "";
      this.hidden = false;
      this.disabled = false;
      this.complete = false;
      this.naturalWidth = 0;
      this._text = "";
      this.classList = {
        toggle: (name, enabled) => {
          const names = new Set(this.className.split(/\s+/).filter(Boolean));
          enabled ? names.add(name) : names.delete(name);
          this.className = [...names].join(" ");
        },
        contains: name => this.className.split(/\s+/).includes(name),
      };
      elements.push(this);
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    set src(value) { this._src = value; this.complete = false; this.naturalWidth = 0; }
    get src() { return this._src; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this._text = ""; this.children = children; }
    addEventListener(name, callback) { const callbacks = this.listeners.get(name) || new Set(); callbacks.add(callback); this.listeners.set(name, callbacks); }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    emit(name) { for (const callback of [...(this.listeners.get(name) || [])]) callback(); }
    decode() { return Promise.resolve(); }
    loaded() { this.complete = true; this.naturalWidth = 1200; this.emit("load"); }
    failed() { this.complete = true; this.naturalWidth = 0; this.emit("error"); }
  }
  const selectors = new Map(["loading", "error", "content", "print", "pdf", "retry", "asset-status"].map(key => [`[data-sheet-${key}]`, new Element("div")]));
  const body = new Element("body");
  const document = { body, createElement: tag => new Element(tag), querySelector: selector => selectors.get(selector) };
  const events = new Map();
  let printed = 0;
  const window = { print: () => printed++, addEventListener: (name, callback) => events.set(name, callback) };
  vm.runInNewContext(printSource, { document, window, location: { search: "?set=studentset_test12345" }, URLSearchParams, setTimeout, clearTimeout, fetch: async () => ({ ok: true, json: async () => payload }) });
  return {
    elements, body,
    get: name => selectors.get(`[data-sheet-${name}]`),
    byClass: name => elements.filter(element => element.classList.contains(name)),
    images: () => elements.filter(element => element.tagName === "img"),
    printed: () => printed,
    beforePrint: () => events.get("beforeprint")(),
  };
}

const crop = suffix => ({ url: `/api/physics-exam/assets/asset_crop_${suffix}` });
const original = (overrides = {}) => ({ questionNo: "20", score: 6, contentMode: "original", stem: "OCR_REFERENCE_ONLY", options: [{ label: "A", text: "OCR_OPTION_ONLY" }], imageAssets: [crop("page0001"), crop("page0002")], ...overrides });

test("完整原题只出现一份可打印内容，混卷连续编号，跨页题保留逐段图示", async () => {
  const view = page({ title: "专题练习", questions: [original(), original({ imageAssets: [crop("page0003")] })] });
  await flush();
  assert.deepEqual(view.byClass("student-question-title").map(element => element.children[0].textContent), ["第 1 题（6分）", "第 2 题（6分）"]);
  assert.equal(view.byClass("student-source-number").length, 2);
  assert.equal(view.byClass("student-question-fragment").length, 3);
  assert.equal(view.byClass("student-continuation")[0].textContent, "第 1 题（续 1）");
  for (const question of view.byClass("student-question")) {
    assert.equal(question.children.filter(element => element.classList.contains("student-stem")).length, 0);
    assert.equal(question.children.filter(element => element.classList.contains("student-option")).length, 0);
    assert.equal(question.children.filter(element => element.classList.contains("student-ocr-reference")).length, 1);
  }
  const images = view.images();
  assert.ok(images.every(image => image.loading === "eager"));
  assert.equal(view.get("print").disabled, true);
  assert.equal(view.get("pdf").disabled, true);
  images[0].loaded(); images[1].loaded();
  await flush();
  assert.equal(view.get("print").disabled, true, "最后一张尚未载入，不应允许打印");
  view.beforePrint();
  assert.equal(view.body.classList.contains("sheet-not-ready"), true);
  images[2].loaded();
  await flush();
  assert.equal(view.get("print").disabled, false);
  assert.equal(view.get("pdf").disabled, false);
  view.get("print").emit("click");
  assert.equal(view.printed(), 1);
});

test("题图载入失败明确定位题目，重试成功前保留打印门禁", async () => {
  const view = page({ title: "失败重试", questions: [original({ imageAssets: [crop("retry001")] })] });
  await flush();
  view.images()[0].failed();
  await flush();
  assert.match(view.get("error").textContent, /第 1 题第 1 张题图载入失败/);
  assert.equal(view.get("retry").hidden, false);
  assert.equal(view.get("print").disabled, true);
  view.get("retry").emit("click");
  await flush();
  const retryImage = view.images().at(-1);
  assert.match(retryImage.src, /sheet_retry=2$/);
  assert.equal(view.get("print").disabled, true);
  retryImage.loaded();
  await flush();
  assert.equal(view.get("print").disabled, false);
  assert.equal(view.get("error").hidden, true);
});

test("不完整或无效原题图不会被静默略过后打印", async () => {
  for (const images of [[], [{ url: "https://example.com/unsafe.png" }]]) {
    const view = page({ title: "失效原题", questions: [original({ imageAssets: images })] });
    await flush();
    assert.equal(view.get("print").disabled, true);
    assert.equal(view.get("error").hidden, false);
    assert.match(view.get("error").textContent, /缺少完整原题图|题图链接无效/);
    assert.equal(view.get("content").hidden, true);
  }
});

test("兼容结构化题目正常显示文字与表格，无图片时可直接打印", async () => {
  const view = page({ title: "文字练习", questions: [{ questionNo: "8", score: 2, stem: "已核验题干", options: [{ label: "A", text: "答案选项" }], tables: [{ headers: ["时间/s"], rows: [["2"]] }], imageAssets: [] }] });
  await flush();
  assert.equal(view.byClass("student-stem")[0].textContent, "已核验题干");
  assert.equal(view.byClass("student-option")[0].textContent, "A. 答案选项");
  assert.equal(view.byClass("student-table").length, 1);
  assert.equal(view.byClass("student-ocr-reference").length, 0);
  assert.equal(view.get("print").disabled, false);
});
