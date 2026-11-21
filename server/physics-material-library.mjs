import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

const SOURCE_LAYERS = new Set(['A', 'B', 'C', 'D']);
const MAX_BATCH = 25_000;
const MAX_TEXT_LENGTH = 12_000_000;
const MAX_SEARCH_OFFSET = 1_000_000;

const FIELD_LIMITS = Object.freeze({
  id: 250,
  sourceCorpus: 240,
  region: 120,
  examType: 160,
  grade: 80,
  role: 80,
  title: 1_200,
  fileName: 1_200,
  sourcePath: 8_192,
  archivePath: 8_192,
  archiveEntry: 8_192,
  extension: 32,
  familyKey: 1_024,
  status: 80,
});

function boundedString(value, field, { required = false, fallback = '' } = {}) {
  const text = value == null ? fallback : String(value).trim();
  if (required && !text) throw new TypeError(`${field} is required`);
  const limit = FIELD_LIMITS[field] ?? 1_000;
  if (text.length > limit) throw new RangeError(`${field} exceeds ${limit} characters`);
  return text;
}

function optionalInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function normalizeWarnings(value) {
  const warnings = value == null ? [] : value;
  let json;
  try {
    json = JSON.stringify(warnings);
  } catch {
    throw new TypeError('warnings must be JSON serializable');
  }
  if (json === undefined || json.length > 128_000) {
    throw new RangeError('warnings JSON exceeds 128000 characters');
  }
  return json;
}

function normalizeIndexedAt(value) {
  if (value == null || value === '') return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('indexedAt must be a valid date');
  return date.toISOString();
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError('each material must be an object');
  }
  const id = boundedString(item.id, 'id', { required: true });
  const sourceCorpus = boundedString(item.sourceCorpus, 'sourceCorpus', { required: true });
  const sourceLayer = String(item.sourceLayer || '').trim().toUpperCase();
  if (!SOURCE_LAYERS.has(sourceLayer)) throw new TypeError('sourceLayer must be A, B, C or D');

  const year = optionalInteger(item.year, 'year', { min: 1900, max: 2200 });
  const bytes = optionalInteger(item.bytes, 'bytes', { min: 0 });
  const pageCount = optionalInteger(item.pageCount, 'pageCount', { min: 0, max: 1_000_000 });
  const questionCountEstimate = optionalInteger(item.questionCountEstimate, 'questionCountEstimate', { min: 0, max: 1_000_000 });
  const fileName = boundedString(item.fileName, 'fileName', { required: true });
  const title = boundedString(item.title, 'title', { fallback: fileName }) || fileName;
  const textContent = item.textContent == null ? '' : String(item.textContent);
  if (textContent.length > MAX_TEXT_LENGTH) {
    throw new RangeError(`textContent exceeds ${MAX_TEXT_LENGTH} characters`);
  }
  const rawSha = item.sha256 == null ? '' : String(item.sha256).trim().toLowerCase();
  if (rawSha && !/^[a-f0-9]{64}$/.test(rawSha)) throw new TypeError('sha256 must contain 64 hexadecimal characters');
  const extension = boundedString(item.extension, 'extension')
    .toLowerCase()
    .replace(/^\.+/, '');
  if (extension && !/^[a-z0-9][a-z0-9+_-]{0,31}$/.test(extension)) {
    throw new TypeError('extension contains unsupported characters');
  }

  return {
    id,
    sourceCorpus,
    sourceLayer,
    year,
    region: boundedString(item.region, 'region'),
    examType: boundedString(item.examType, 'examType'),
    grade: boundedString(item.grade, 'grade'),
    role: boundedString(item.role, 'role'),
    title,
    fileName,
    sourcePath: boundedString(item.sourcePath, 'sourcePath'),
    archivePath: boundedString(item.archivePath, 'archivePath'),
    archiveEntry: boundedString(item.archiveEntry, 'archiveEntry'),
    extension,
    bytes,
    sha256: rawSha || null,
    familyKey: boundedString(item.familyKey, 'familyKey'),
    textContent,
    textLength: textContent.length,
    pageCount,
    questionCountEstimate,
    status: boundedString(item.status, 'status', { fallback: 'indexed' }) || 'indexed',
    warnings: normalizeWarnings(item.warnings),
    indexedAt: normalizeIndexedAt(item.indexedAt),
  };
}

function requireFilterString(value, field) {
  if (value == null || value === '') return '';
  return boundedString(value, field);
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function parseWarnings(value) {
  try {
    return JSON.parse(value || '[]');
  } catch {
    return ['资料索引中的 warnings 字段已损坏'];
  }
}

function rowToPublic(row, { includeText = false } = {}) {
  if (!row) return null;
  const result = {
    id: row.id,
    sourceCorpus: row.source_corpus,
    sourceLayer: row.source_layer,
    year: row.year,
    region: row.region,
    examType: row.exam_type,
    grade: row.grade,
    role: row.role,
    title: row.title,
    fileName: row.file_name,
    sourcePath: row.source_path,
    archivePath: row.archive_path,
    archiveEntry: row.archive_entry,
    extension: row.extension,
    bytes: row.bytes,
    sha256: row.sha256,
    familyKey: row.family_key,
    familyVersionCount: Number(row.family_version_count || 1),
    exactDuplicateOf: row.exact_duplicate_of,
    textLength: row.text_length,
    pageCount: row.page_count,
    questionCountEstimate: row.question_count_estimate,
    status: row.status,
    warnings: parseWarnings(row.warnings),
    indexedAt: row.indexed_at,
  };
  if (includeText) result.textContent = row.text_content;
  if (Object.hasOwn(row, 'snippet')) result.snippet = String(row.snippet || '').slice(0, 800);
  return result;
}

function groupCounts(rows, key) {
  return Object.fromEntries(rows.map(row => [String(row[key] || '未标注'), Number(row.count)]));
}

function escapeLike(value) {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function literalFtsQuery(value) {
  return value.split(/\s+/).filter(Boolean).map(token => `"${token.replaceAll('"', '""')}"`).join(' AND ');
}

const SEARCHABLE_LIKE_COLUMNS = Object.freeze([
  'm.title', 'm.file_name', 'm.region', 'm.exam_type', 'm.grade', 'm.role', 'm.text_content',
]);

function appendLikeTerm(filters, values, term) {
  const pattern = escapeLike(term);
  filters.push(`(${SEARCHABLE_LIKE_COLUMNS.map(column => `${column} LIKE ? ESCAPE '\\' COLLATE NOCASE`).join(' OR ')})`);
  values.push(...SEARCHABLE_LIKE_COLUMNS.map(() => pattern));
}

const HUNAN_REGIONS = Object.freeze([
  '长沙', '株洲', '湘潭', '衡阳', '邵阳', '岳阳', '常德', '张家界',
  '益阳', '郴州', '永州', '怀化', '娄底', '湘西',
]);

function chineseCount(value) {
  const text = String(value || '');
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === '十') return 10;
  if (text.includes('十')) {
    const [left, right] = text.split('十');
    return (left ? digits[left] : 1) * 10 + (right ? digits[right] : 0);
  }
  return digits[text] ?? null;
}

/** Convert a short teacher request into deterministic local-search intent. */
export function parseMaterialSearchIntent(value) {
  const rawQuery = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const countMatch = rawQuery.match(/([0-9]{1,3}|[一二两三四五六七八九十]{1,3})\s*道/);
  const requestedCount = countMatch ? chineseCount(countMatch[1]) : null;
  const yearMatch = rawQuery.match(/(?:19|20)\d{2}/);
  const region = HUNAN_REGIONS.find(name => rawQuery.includes(name)) || '';
  const grade = /八年级|初二/.test(rawQuery) ? '八年级' : /九年级|初三/.test(rawQuery) ? '九年级' : '';
  const trendIntent = /近三年|近五年|历年|近年|如何考(?:查)?|怎么考(?:查)?|考什么/.test(rawQuery);
  let sourceLayer = '';
  if (region === '长沙' && /中考|真题|原卷/.test(rawQuery)) sourceLayer = 'A';
  else if (/湖南(?:省)?其他地市|其他地市/.test(rawQuery)) sourceLayer = 'B';
  else if (/校考|期中|期末|联考|集团卷/.test(rawQuery) && (!region || region === '长沙')) sourceLayer = 'C';
  else if (/讲义|练习册|专题资料|训练资料/.test(rawQuery)) sourceLayer = 'D';
  else if (trendIntent) sourceLayer = 'A';

  let effectiveQuery = rawQuery
    .replace(/(?:19|20)\d{2}\s*年?/g, ' ')
    .replace(/[0-9]{1,3}\s*道/g, ' ')
    .replace(/[一二两三四五六七八九十]{1,3}\s*道/g, ' ')
    .replace(/湖南(?:省)?其他地市|其他地市/g, ' ')
    .replace(new RegExp(HUNAN_REGIONS.map(name => `${name}(?:市|州)?`).join('|'), 'g'), ' ')
    .replace(/八年级|九年级|初二|初三/g, ' ')
    .replace(/请问|麻烦|帮我|给我|我要|我想要|想找|找一下|找|查一下|搜一下|查找|查询|搜索|筛选|推荐|来点|来|出几道|出|看一下|看看|有没有|关于|相关的?/g, ' ')
    .replace(/近三年|近五年|历年|近年|如何考(?:查)?|怎么考(?:查)?|考什么/g, ' ')
    .replace(/中考原卷|中考真题|原卷|真题|中考|校考|期中|期末|联考|集团卷|讲义|练习册|专题资料|训练资料/g, ' ')
    .replace(/物理|题目|题型|习题|试题|题/g, ' ')
    .replace(/[“”"'‘’《》【】()（）：:，,。！？!?；;、/\\|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!effectiveQuery && !sourceLayer && !yearMatch && !region && !grade) effectiveQuery = rawQuery;
  return {
    rawQuery,
    effectiveQuery,
    requestedCount: Number.isInteger(requestedCount) && requestedCount > 0 && requestedCount <= 100 ? requestedCount : null,
    inferredFilters: {
      layer: sourceLayer,
      grade,
      year: yearMatch ? Number(yearMatch[0]) : null,
      region: region || (trendIntent ? '长沙' : ''),
    },
  };
}

/**
 * A self-contained SQLite catalogue for local teaching materials.
 *
 * The caller is responsible for reading files and extracting text. This class
 * only accepts already-derived metadata/text and never opens a source document.
 */
export class PhysicsMaterialLibrary {
  constructor(dataDirectoryOrConnection) {
    if (typeof dataDirectoryOrConnection === 'string' && dataDirectoryOrConnection.trim()) {
      mkdirSync(dataDirectoryOrConnection, { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(join(dataDirectoryOrConnection, 'material-library.sqlite'));
      this.ownsConnection = true;
    } else if (dataDirectoryOrConnection && typeof dataDirectoryOrConnection.prepare === 'function' && typeof dataDirectoryOrConnection.exec === 'function') {
      this.db = dataDirectoryOrConnection;
      this.ownsConnection = false;
    } else {
      throw new TypeError('a data directory or DatabaseSync connection is required');
    }

    this.closed = false;
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS physics_material (
        id TEXT PRIMARY KEY,
        source_corpus TEXT NOT NULL,
        source_layer TEXT NOT NULL CHECK(source_layer IN ('A','B','C','D')),
        year INTEGER,
        region TEXT NOT NULL DEFAULT '',
        exam_type TEXT NOT NULL DEFAULT '',
        grade TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        source_path TEXT NOT NULL DEFAULT '',
        archive_path TEXT NOT NULL DEFAULT '',
        archive_entry TEXT NOT NULL DEFAULT '',
        extension TEXT NOT NULL DEFAULT '',
        bytes INTEGER CHECK(bytes IS NULL OR bytes >= 0),
        sha256 TEXT CHECK(sha256 IS NULL OR length(sha256)=64),
        family_key TEXT NOT NULL DEFAULT '',
        exact_duplicate_of TEXT REFERENCES physics_material(id) ON DELETE SET NULL,
        text_content TEXT NOT NULL DEFAULT '',
        text_length INTEGER NOT NULL CHECK(text_length >= 0),
        page_count INTEGER CHECK(page_count IS NULL OR page_count >= 0),
        question_count_estimate INTEGER CHECK(question_count_estimate IS NULL OR question_count_estimate >= 0),
        status TEXT NOT NULL,
        warnings TEXT NOT NULL CHECK(json_valid(warnings)),
        indexed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS physics_material_corpus_idx ON physics_material(source_corpus);
      CREATE INDEX IF NOT EXISTS physics_material_layer_idx ON physics_material(source_layer);
      CREATE INDEX IF NOT EXISTS physics_material_year_idx ON physics_material(year);
      CREATE INDEX IF NOT EXISTS physics_material_grade_idx ON physics_material(grade);
      CREATE INDEX IF NOT EXISTS physics_material_region_idx ON physics_material(region);
      CREATE INDEX IF NOT EXISTS physics_material_role_idx ON physics_material(role);
      CREATE INDEX IF NOT EXISTS physics_material_family_idx ON physics_material(family_key);
      CREATE INDEX IF NOT EXISTS physics_material_sha_idx ON physics_material(sha256);
    `);
    this.ftsMode = this.#initializeFts();
  }

  #assertOpen() {
    if (this.closed) throw new Error('material library is closed');
  }

  #initializeFts() {
    let mode = 'like';
    try {
      try {
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS physics_material_fts USING fts5(
          id UNINDEXED, title, file_name, region, exam_type, grade, role, text_content,
          tokenize='trigram case_sensitive 0'
        )`);
        mode = 'fts5-trigram';
      } catch {
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS physics_material_fts USING fts5(
          id UNINDEXED, title, file_name, region, exam_type, grade, role, text_content,
          tokenize='unicode61'
        )`);
        mode = 'fts5-unicode61';
      }
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS physics_material_fts_insert AFTER INSERT ON physics_material BEGIN
          INSERT INTO physics_material_fts(id,title,file_name,region,exam_type,grade,role,text_content)
          VALUES(new.id,new.title,new.file_name,new.region,new.exam_type,new.grade,new.role,new.text_content);
        END;
        CREATE TRIGGER IF NOT EXISTS physics_material_fts_delete AFTER DELETE ON physics_material BEGIN
          DELETE FROM physics_material_fts WHERE id=old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS physics_material_fts_update
        AFTER UPDATE OF title,file_name,region,exam_type,grade,role,text_content ON physics_material BEGIN
          DELETE FROM physics_material_fts WHERE id=old.id;
          INSERT INTO physics_material_fts(id,title,file_name,region,exam_type,grade,role,text_content)
          VALUES(new.id,new.title,new.file_name,new.region,new.exam_type,new.grade,new.role,new.text_content);
        END;
      `);
      const materialCount = Number(this.db.prepare('SELECT count(*) AS count FROM physics_material').get().count);
      const ftsCount = Number(this.db.prepare('SELECT count(*) AS count FROM physics_material_fts').get().count);
      if (materialCount !== ftsCount) {
        this.db.exec(`
          BEGIN IMMEDIATE;
          DELETE FROM physics_material_fts;
          INSERT INTO physics_material_fts(id,title,file_name,region,exam_type,grade,role,text_content)
          SELECT id,title,file_name,region,exam_type,grade,role,text_content FROM physics_material;
          COMMIT;
        `);
      }
    } catch {
      try {
        if (this.db.inTransaction) this.db.exec('ROLLBACK');
      } catch { /* Keep LIKE search available even if FTS initialization fails. */ }
      mode = 'like';
    }
    return mode;
  }

  upsertMany(items, { replaceCorpus = false } = {}) {
    this.#assertOpen();
    if (!Array.isArray(items)) throw new TypeError('items must be an array');
    if (items.length > MAX_BATCH) throw new RangeError(`a batch may contain at most ${MAX_BATCH} items`);
    const normalized = items.map(normalizeItem);
    const ids = new Set();
    for (const item of normalized) {
      if (ids.has(item.id)) throw new TypeError(`duplicate id in batch: ${item.id}`);
      ids.add(item.id);
    }

    let corporaToReplace = [];
    if (replaceCorpus === true) {
      if (!normalized.length) throw new TypeError('replaceCorpus=true requires at least one item');
      corporaToReplace = [...new Set(normalized.map(item => item.sourceCorpus))];
    } else if (typeof replaceCorpus === 'string' && replaceCorpus.trim()) {
      const corpus = boundedString(replaceCorpus, 'sourceCorpus', { required: true });
      if (normalized.some(item => item.sourceCorpus !== corpus)) {
        throw new TypeError('all replacement items must belong to replaceCorpus');
      }
      corporaToReplace = [corpus];
    } else if (replaceCorpus !== false && replaceCorpus != null) {
      throw new TypeError('replaceCorpus must be false, true, or a sourceCorpus string');
    }

    const upsert = this.db.prepare(`
      INSERT INTO physics_material (
        id,source_corpus,source_layer,year,region,exam_type,grade,role,title,file_name,
        source_path,archive_path,archive_entry,extension,bytes,sha256,family_key,
        exact_duplicate_of,text_content,text_length,page_count,question_count_estimate,
        status,warnings,indexed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        source_corpus=excluded.source_corpus,
        source_layer=excluded.source_layer,
        year=excluded.year,
        region=excluded.region,
        exam_type=excluded.exam_type,
        grade=excluded.grade,
        role=excluded.role,
        title=excluded.title,
        file_name=excluded.file_name,
        source_path=excluded.source_path,
        archive_path=excluded.archive_path,
        archive_entry=excluded.archive_entry,
        extension=excluded.extension,
        bytes=excluded.bytes,
        sha256=excluded.sha256,
        family_key=excluded.family_key,
        exact_duplicate_of=NULL,
        text_content=excluded.text_content,
        text_length=excluded.text_length,
        page_count=excluded.page_count,
        question_count_estimate=excluded.question_count_estimate,
        status=excluded.status,
        warnings=excluded.warnings,
        indexed_at=excluded.indexed_at
    `);
    const removeCorpus = this.db.prepare('DELETE FROM physics_material WHERE source_corpus=?');
    let replaced = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const corpus of corporaToReplace) replaced += Number(removeCorpus.run(corpus).changes || 0);
      for (const item of normalized) {
        upsert.run(
          item.id, item.sourceCorpus, item.sourceLayer, item.year, item.region,
          item.examType, item.grade, item.role, item.title, item.fileName,
          item.sourcePath, item.archivePath, item.archiveEntry, item.extension,
          item.bytes, item.sha256, item.familyKey, item.textContent, item.textLength,
          item.pageCount, item.questionCountEstimate, item.status, item.warnings,
          item.indexedAt,
        );
      }
      // Re-elect one stable canonical source per byte-identical SHA group. Each
      // source row remains present, so provenance is never discarded.
      this.db.exec(`
        UPDATE physics_material SET exact_duplicate_of=NULL WHERE exact_duplicate_of IS NOT NULL;
        UPDATE physics_material AS duplicate
        SET exact_duplicate_of=(
          SELECT canonical.id FROM physics_material AS canonical
          WHERE canonical.sha256=duplicate.sha256
          ORDER BY canonical.rowid, canonical.id LIMIT 1
        )
        WHERE duplicate.sha256 IS NOT NULL
          AND duplicate.rowid<>(
            SELECT canonical.rowid FROM physics_material AS canonical
            WHERE canonical.sha256=duplicate.sha256
            ORDER BY canonical.rowid, canonical.id LIMIT 1
          );
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve original error. */ }
      throw error;
    }

    const summary = this.db.prepare(`
      SELECT count(*) AS total,
             sum(CASE WHEN exact_duplicate_of IS NOT NULL THEN 1 ELSE 0 END) AS duplicates
      FROM physics_material
    `).get();
    return {
      upserted: normalized.length,
      replaced,
      total: Number(summary.total || 0),
      exactDuplicates: Number(summary.duplicates || 0),
      searchMode: this.ftsMode,
    };
  }

  stats() {
    this.#assertOpen();
    const totals = this.db.prepare(`
      SELECT count(*) AS total,
             count(DISTINCT sha256) + sum(CASE WHEN sha256 IS NULL THEN 1 ELSE 0 END) AS unique_files,
             count(DISTINCT CASE WHEN family_key<>'' THEN source_layer||char(0)||role||char(0)||family_key ELSE id END) AS unique_families,
             sum(CASE WHEN exact_duplicate_of IS NOT NULL THEN 1 ELSE 0 END) AS exact_duplicates,
             coalesce(sum(bytes),0) AS total_bytes,
             sum(CASE WHEN text_length>0 THEN 1 ELSE 0 END) AS text_documents,
             coalesce(sum(text_length),0) AS total_text_length,
             coalesce(sum(page_count),0) AS total_pages,
             coalesce(sum(question_count_estimate),0) AS question_count_estimate,
             max(indexed_at) AS latest_indexed_at
      FROM physics_material
    `).get();
    const counts = (field) => this.db.prepare(`
      SELECT ${field} AS value, count(*) AS count
      FROM physics_material GROUP BY ${field} ORDER BY count DESC, value LIMIT 1000
    `).all();
    const toObject = rows => Object.fromEntries(rows.map(row => [String(row.value || '未标注'), Number(row.count)]));
    return {
      total: Number(totals.total || 0),
      uniqueFiles: Number(totals.unique_files || 0),
      uniqueFamilies: Number(totals.unique_families || 0),
      exactDuplicates: Number(totals.exact_duplicates || 0),
      totalBytes: Number(totals.total_bytes || 0),
      textDocuments: Number(totals.text_documents || 0),
      totalTextLength: Number(totals.total_text_length || 0),
      totalPages: Number(totals.total_pages || 0),
      questionCountEstimate: Number(totals.question_count_estimate || 0),
      latestIndexedAt: totals.latest_indexed_at || null,
      byLayer: toObject(counts('source_layer')),
      byGrade: toObject(counts('grade')),
      byRole: toObject(counts('role')),
      byStatus: toObject(counts('status')),
      byCorpus: toObject(counts('source_corpus')),
      searchMode: this.ftsMode,
    };
  }

  search({ q = '', layer = '', grade = '', year = '', region = '', role = '', includeDuplicates = false, limit = 20, offset = 0 } = {}) {
    this.#assertOpen();
    const intent = parseMaterialSearchIntent(q);
    if (intent.rawQuery.length > 240) throw new RangeError('q exceeds 240 characters');
    q = intent.effectiveQuery;
    layer = String(layer ?? '').trim().toUpperCase();
    if (!layer) layer = intent.inferredFilters.layer;
    if (layer && !SOURCE_LAYERS.has(layer)) throw new TypeError('layer must be A, B, C or D');
    grade = requireFilterString(grade, 'grade');
    if (!grade) grade = intent.inferredFilters.grade;
    region = requireFilterString(region, 'region');
    if (!region) region = intent.inferredFilters.region;
    role = requireFilterString(role, 'role');
    const normalizedYear = year === '' || year == null
      ? intent.inferredFilters.year
      : optionalInteger(year, 'year', { min: 1900, max: 2200 });
    limit = clampInteger(limit, 20, 1, 100);
    offset = clampInteger(offset, 0, 0, MAX_SEARCH_OFFSET);

    const filters = [];
    const filterValues = [];
    const searchTerms = q.split(/\s+/).map(term => term.trim()).filter(Boolean);
    if (includeDuplicates !== true && includeDuplicates !== '1') {
      filters.push('m.exact_duplicate_of IS NULL');
      filters.push(`(m.family_key='' OR m.id=(
        SELECT sibling.id FROM physics_material AS sibling
        WHERE sibling.family_key=m.family_key AND sibling.role=m.role AND sibling.source_layer=m.source_layer
        ORDER BY length(sibling.file_name),sibling.rowid LIMIT 1
      ))`);
    }
    if (layer) { filters.push('m.source_layer=?'); filterValues.push(layer); }
    if (grade) { filters.push('m.grade=?'); filterValues.push(grade); }
    if (normalizedYear != null) { filters.push('m.year=?'); filterValues.push(normalizedYear); }
    if (region) { filters.push('m.region=?'); filterValues.push(region); }
    if (role) { filters.push('m.role=?'); filterValues.push(role); }

    const metadataColumns = `
      m.id,m.source_corpus,m.source_layer,m.year,m.region,m.exam_type,m.grade,m.role,
      m.title,m.file_name,m.source_path,m.archive_path,m.archive_entry,m.extension,
      m.bytes,m.sha256,m.family_key,m.exact_duplicate_of,m.text_length,m.page_count,
      m.question_count_estimate,m.status,m.warnings,m.indexed_at,
      (SELECT count(*) FROM physics_material AS family
       WHERE family.family_key=m.family_key AND family.role=m.role AND family.source_layer=m.source_layer) AS family_version_count
    `;

    let usedFts = false;
    let rows = [];
    let total = 0;
    const ftsTerms = searchTerms.filter(term => [...term].length >= 3);
    const shortTerms = searchTerms.filter(term => [...term].length < 3);
    if (q && this.ftsMode !== 'like' && ftsTerms.length) {
      try {
        const ftsFilters = [];
        const ftsFilterValues = [];
        for (const term of shortTerms) appendLikeTerm(ftsFilters, ftsFilterValues, term);
        const where = ['physics_material_fts MATCH ?', ...ftsFilters, ...filters].join(' AND ');
        const values = [literalFtsQuery(ftsTerms.join(' ')), ...ftsFilterValues, ...filterValues];
        total = Number(this.db.prepare(`
          SELECT count(*) AS count FROM physics_material_fts
          JOIN physics_material AS m ON m.id=physics_material_fts.id WHERE ${where}
        `).get(...values).count || 0);
        if (total > 0) {
          rows = this.db.prepare(`
            SELECT ${metadataColumns},
              snippet(physics_material_fts,7,'【','】','…',28) AS snippet,
              bm25(physics_material_fts,0.0,8.0,5.0,2.0,2.0,2.0,1.5,1.0) AS rank
            FROM physics_material_fts JOIN physics_material AS m ON m.id=physics_material_fts.id
            WHERE ${where} ORDER BY rank,m.indexed_at DESC,m.id LIMIT ? OFFSET ?
          `).all(...values, limit, offset);
          usedFts = true;
        }
      } catch {
        // A malformed/unsupported MATCH expression must never disable search.
        rows = [];
        total = 0;
      }
    }

    if (!q || !usedFts) {
      const where = [...filters];
      const values = [...filterValues];
      if (q) {
        for (const term of searchTerms) appendLikeTerm(where, values, term);
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      total = Number(this.db.prepare(`SELECT count(*) AS count FROM physics_material AS m ${clause}`).get(...values).count || 0);
      rows = this.db.prepare(`
        SELECT ${metadataColumns},
          CASE WHEN m.text_length>0 THEN substr(m.text_content,1,360) ELSE m.title END AS snippet
        FROM physics_material AS m ${clause}
        ORDER BY m.indexed_at DESC,m.id LIMIT ? OFFSET ?
      `).all(...values, limit, offset);
      if (q) {
        const readText = this.db.prepare('SELECT text_content FROM physics_material WHERE id=?');
        for (const row of rows) {
          const text = String(readText.get(row.id)?.text_content || '');
          const needle = searchTerms.find(term => text.toLocaleLowerCase('zh-CN').includes(term.toLocaleLowerCase('zh-CN'))) || q;
          const at = text.toLocaleLowerCase('zh-CN').indexOf(needle.toLocaleLowerCase('zh-CN'));
          if (at >= 0) row.snippet = `${at > 90 ? '…' : ''}${text.slice(Math.max(0, at - 90), at + needle.length + 260)}${at + needle.length + 260 < text.length ? '…' : ''}`;
        }
      }
    }

    return {
      items: rows.map(row => rowToPublic(row)),
      total,
      limit,
      offset,
      query: intent.rawQuery,
      effectiveQuery: q,
      requestedCount: intent.requestedCount,
      appliedFilters: { layer, grade, year: normalizedYear, region, role },
      searchMode: usedFts ? this.ftsMode : 'like',
    };
  }

  get(id) {
    this.#assertOpen();
    id = boundedString(id, 'id', { required: true });
    const row = this.db.prepare('SELECT * FROM physics_material WHERE id=?').get(id);
    return rowToPublic(row, { includeText: true });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsConnection) this.db.close();
  }
}

export default PhysicsMaterialLibrary;
