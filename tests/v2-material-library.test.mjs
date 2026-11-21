import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PhysicsMaterialLibrary, parseMaterialSearchIntent } from "../server/physics-material-library.mjs";

test("资料总库按A-D分层、中文检索并默认隐藏字节重复副本", t => {
  const directory = mkdtempSync(join(tmpdir(), "physics-material-library-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const library = new PhysicsMaterialLibrary(directory);
  t.after(() => library.close());
  const sha = "a".repeat(64), base = { sourceCorpus: "fixture", year: 2025, region: "长沙", grade: "九年级", role: "paper", examType: "中考原卷", extension: ".pdf", bytes: 100, pageCount: 2, questionCountEstimate: 1, status: "indexed", warnings: [] };
  const result = library.upsertMany([
    { ...base, id: "material_primary", sourceLayer: "A", title: "动态电路原卷", fileName: "动态电路.pdf", sourcePath: "/tmp/a.pdf", sha256: sha, familyKey: "dynamic", textContent: "滑动变阻器移动后判断电压表示数变化并排查接线故障" },
    { ...base, id: "material_duplicate", sourceLayer: "A", title: "动态电路副本", fileName: "动态电路 (1).pdf", sourcePath: "/tmp/b.pdf", sha256: sha, familyKey: "dynamic", textContent: "滑动变阻器移动后判断电压表示数变化并排查接线故障" },
    { ...base, id: "material_practice", sourceLayer: "D", title: "浮力训练", fileName: "浮力训练.docx", sourcePath: "/tmp/c.docx", sha256: "b".repeat(64), familyKey: "buoyancy", textContent: "物体漂浮时浮力与重力的关系" },
  ]);
  assert.equal(result.total, 3);
  assert.equal(result.exactDuplicates, 1);
  assert.deepEqual(library.stats().byLayer, { A: 2, D: 1 });
  const hidden = library.search({ q: "滑动变阻器" });
  assert.equal(hidden.total, 1);
  assert.equal(hidden.items[0].id, "material_primary");
  const shown = library.search({ q: "滑动变阻器", includeDuplicates: true });
  assert.equal(shown.total, 2);
  assert.equal(library.search({ q: "滑动变阻器 故障" }).items[0].id, "material_primary");
  assert.equal(library.search({ q: "浮力 漂浮", layer: "D" }).items[0].id, "material_practice");
  assert.equal(library.search({ q: "浮力", layer: "D" }).items[0].sourceLayer, "D");
  assert.match(library.get("material_primary").textContent, /电压表/);
});

test("教师可以直接用自然语言说题型，系统提取考点和来源条件", t => {
  const directory = mkdtempSync(join(tmpdir(), "physics-material-natural-search-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const library = new PhysicsMaterialLibrary(directory);
  t.after(() => library.close());
  const base = { sourceCorpus: "fixture", grade: "九年级", role: "original_with_source_analysis", examType: "中考原卷", extension: ".pdf", bytes: 100, pageCount: 2, questionCountEstimate: 1, status: "indexed", warnings: [] };
  library.upsertMany([
    { ...base, id: "changsha_2025", sourceLayer: "A", year: 2025, region: "长沙", title: "长沙动态电路", fileName: "长沙卷.pdf", sourcePath: "/tmp/cs.pdf", sha256: "c".repeat(64), familyKey: "cs", textContent: "滑动变阻器构成动态电路，判断电流表示数" },
    { ...base, id: "zhangjiajie_2025", sourceLayer: "B", year: 2025, region: "张家界", title: "张家界动态电路", fileName: "张家界卷.pdf", sourcePath: "/tmp/zjj.pdf", sha256: "d".repeat(64), familyKey: "zjj", textContent: "滑动变阻器构成动态电路，判断电流表示数" },
  ]);

  const plain = library.search({ q: "给我找4道动态电路题" });
  assert.equal(plain.effectiveQuery, "动态电路");
  assert.equal(plain.requestedCount, 4);
  assert.equal(plain.total, 2);

  const chineseCountRequest = library.search({ q: "给我找四道动态电路题" });
  assert.equal(chineseCountRequest.effectiveQuery, "动态电路");
  assert.equal(chineseCountRequest.requestedCount, 4);

  const scoped = library.search({ q: "给我找2025年长沙中考动态电路真题" });
  assert.equal(scoped.total, 1);
  assert.equal(scoped.items[0].id, "changsha_2025");
  assert.deepEqual(scoped.appliedFilters, { layer: "A", grade: "", year: 2025, region: "长沙", role: "" });

  const trend = library.search({ q: "动态电路近年如何考" });
  assert.equal(trend.total, 1);
  assert.deepEqual(trend.appliedFilters, { layer: "A", grade: "", year: null, region: "长沙", role: "" });

  assert.deepEqual(parseMaterialSearchIntent("凸透镜成像怎么考？").effectiveQuery, "凸透镜成像");
});
