import { mkdirSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import StudentQuestionSets from '../exam-engine/student-question-set.js';

export const COLLECTIONS = ['files', 'canonicalExams', 'questions', 'attempts', 'trainingPlans', 'questionSets', 'auditEvents', 'questionAliases', 'analysisRuns', 'importJobs', 'masteryRecords'];
const IMMUTABLE = new Set(['auditEvents', 'analysisRuns']);
const HUNAN = new Set(['株洲', '湘潭', '衡阳', '邵阳', '岳阳', '常德', '张家界', '益阳', '郴州', '永州', '怀化', '娄底', '湘西', '湘西土家族苗族自治州']);
const META = new Set(['version', 'activeTab', 'importDraft', 'lessonMappings', 'settings', 'lastSavedAt', 'analysisSettings', 'reviewer', 'trainingSettings']);
const layers = new Set(['A', 'B', 'C', 'D', 'E']);
const stamp = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class StoreError extends Error {
  constructor(status, code, detail = code) { super(detail); this.status = status; this.code = code; }
}
const invalid = message => { throw new StoreError(422, 'validation_failed', message); };
function baseEngine() { return {version: 2, ...Object.fromEntries(COLLECTIONS.map(k => [k, []])), lessonMappings: {}, settings: {}, importDraft: {sourceLayer: 'A', region: '长沙', year: '', examType: '中考原卷'}, activeTab: 'overview'}; }

/** Incremental authoritative store. Every commit and before/after value remains auditable. */
export class EngineStore {
  constructor(dataDir) {
    mkdirSync(dataDir, {recursive: true, mode: 0o700});
    this.dataDir=dataDir;
    this.path = join(dataDir, 'exam-engine.sqlite');
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const hasNew = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='engine_meta_v2'").get();
    const hasLegacy = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='engine_snapshot'").get();
    let legacy;
    if (!hasNew && hasLegacy) {
      const row = this.db.prepare('SELECT state_json FROM engine_snapshot WHERE id=1').get();
      if (row) {
        const backupPath = join(dataDir, `exam-engine.pre-v2-${Date.now()}-${randomUUID().slice(0,8)}.sqlite`);
        this.db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
        try { legacy = JSON.parse(row.state_json); } catch { /* Original remains in backup and legacy table. */ }
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engine_meta_v2 (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0), saved_at TEXT NOT NULL);
      INSERT OR IGNORE INTO engine_meta_v2 VALUES (1,0,'');
      CREATE TABLE IF NOT EXISTS engine_entity (collection TEXT NOT NULL, entity_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(collection, entity_id));
      CREATE TABLE IF NOT EXISTS engine_link (from_collection TEXT NOT NULL, from_id TEXT NOT NULL, to_collection TEXT NOT NULL, to_id TEXT NOT NULL, PRIMARY KEY(from_collection,from_id,to_collection,to_id), FOREIGN KEY(from_collection,from_id) REFERENCES engine_entity(collection,entity_id) DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(to_collection,to_id) REFERENCES engine_entity(collection,entity_id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TABLE IF NOT EXISTS engine_commit (request_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, revision INTEGER NOT NULL UNIQUE, saved_at TEXT NOT NULL, metadata TEXT NOT NULL CHECK(json_valid(metadata)));
      CREATE TABLE IF NOT EXISTS engine_revision (id INTEGER PRIMARY KEY, request_id TEXT NOT NULL REFERENCES engine_commit(request_id), collection TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, changed_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS engine_revision_entity ON engine_revision(collection, entity_id, id);
      CREATE TRIGGER IF NOT EXISTS revision_no_update BEFORE UPDATE ON engine_revision BEGIN SELECT RAISE(ABORT,'revision history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS revision_no_delete BEFORE DELETE ON engine_revision BEGIN SELECT RAISE(ABORT,'revision history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS commit_no_update BEFORE UPDATE ON engine_commit BEGIN SELECT RAISE(ABORT,'commit history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS commit_no_delete BEFORE DELETE ON engine_commit BEGIN SELECT RAISE(ABORT,'commit history is immutable'); END;
    `);
    if (legacy) this.migrateLegacy(legacy);
    // A browser worker does not survive restart. Retain the checkpoint and expose a resumable pause.
    const running = this.db.prepare("SELECT payload FROM engine_entity WHERE collection='importJobs' AND json_extract(payload,'$.status')='running'").all().map(row=>JSON.parse(row.payload));
    if (running.length) this.commit({baseRevision: this.revision, requestId: `restart:${randomUUID()}`, changes: running.map(job => ({collection:'importJobs', id:job.id, value:{...job,status:'paused', pauseReason:'server_restarted', updatedAt:stamp()}})), meta:{action:'recovery'}});
  }
  get revision() { return this.db.prepare('SELECT revision FROM engine_meta_v2 WHERE id=1').get().revision; }
  close() { this.db.close(); }
  getEngine() {
    const engine = baseEngine();
    for (const row of this.db.prepare('SELECT collection,entity_id,payload FROM engine_entity ORDER BY rowid').iterate()) {
      const value = JSON.parse(row.payload);
      if (row.collection === 'meta') engine[row.entity_id] = value;
      else if (COLLECTIONS.includes(row.collection)) engine[row.collection].push(value);
    }
    // Legacy snapshot metadata describes the old payload, not the active server schema.
    engine.version = 2;
    const {revision, saved_at} = this.db.prepare('SELECT revision,saved_at FROM engine_meta_v2 WHERE id=1').get();
    return {engine, revision, savedAt:saved_at};
  }
  get(collection,id) { const row = this.db.prepare('SELECT payload FROM engine_entity WHERE collection=? AND entity_id=?').get(collection,id); return row ? JSON.parse(row.payload) : null; }
  list(collection, {limit=50, offset=0}={}) {
    if (!COLLECTIONS.includes(collection)) invalid('unknown collection');
    limit=Math.min(500, Math.max(1, Number(limit)||50)); offset=Math.max(0,Number(offset)||0);
    const total=this.db.prepare('SELECT count(*) AS n FROM engine_entity WHERE collection=?').get(collection).n;
    const items=this.db.prepare('SELECT payload FROM engine_entity WHERE collection=? ORDER BY rowid LIMIT ? OFFSET ?').all(collection,limit,offset).map(r=>JSON.parse(r.payload));
    return {items,total,limit,offset,revision:this.revision};
  }
  history(collection,id) { return this.db.prepare('SELECT r.*,c.revision,c.metadata FROM engine_revision r JOIN engine_commit c USING(request_id) WHERE collection=? AND entity_id=? ORDER BY r.id').all(collection,id).map(r=>({...r,before:r.before_json?JSON.parse(r.before_json):null,after:r.after_json?JSON.parse(r.after_json):null,before_json:undefined,after_json:undefined,metadata:JSON.parse(r.metadata)})); }
  async backups() {
    const directory=join(this.dataDir,'exam-backups');
    if(!existsSync(directory)) return [];
    const results=[];
    for(const name of await readdir(directory)) {
      if(!/^backup_[a-f0-9]{32}$/.test(name)) continue;
      try {const manifest=JSON.parse(await readFile(join(directory,name,'manifest.json'),'utf8'));if(manifest.id===name&&manifest.complete) results.push({id:name,revision:manifest.revision,createdAt:manifest.createdAt,assetFiles:manifest.assets.length,bytes:manifest.bytes});} catch { /* Incomplete copies are not advertised as valid backups. */ }
    }
    return results.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async backup({baseRevision,requestId}) {
    if(!Number.isInteger(baseRevision)||typeof requestId!=='string'||!requestId||requestId.length>180) invalid('backup requires revision and requestId');
    const id=`backup_${digest(requestId).slice(0,32)}`, directory=join(this.dataDir,'exam-backups',id);
    const manifestPath=join(directory,'manifest.json');
    if(existsSync(manifestPath)) {
      const previous=JSON.parse(await readFile(manifestPath,'utf8'));
      if(previous.revision!==baseRevision) throw new StoreError(409,'idempotency_conflict');
      if(previous.complete) return previous;
    }
    if(this.revision!==baseRevision) throw new StoreError(409,'revision_conflict');
    await mkdir(directory,{recursive:true,mode:0o700});
    const backupDb=join(directory,'engine.sqlite');
    // A crash may leave an incomplete directory. Use a new request id to retry without overwriting evidence.
    if(existsSync(backupDb)) throw new StoreError(409,'backup_incomplete','上次备份未完成，请使用新的请求ID重试');
    this.db.exec(`VACUUM INTO '${backupDb.replaceAll("'","''")}'`);
    const snapshotBytes=await readFile(backupDb);
    const manifest={version:1,id,revision:baseRevision,createdAt:stamp(),complete:false,databaseSha256:createHash('sha256').update(snapshotBytes).digest('hex'),bytes:snapshotBytes.length,assets:[]};
    const assetsDir=join(this.dataDir,'exam-assets');
    await mkdir(join(directory,'assets'),{recursive:true,mode:0o700});
    if(existsSync(assetsDir)) for(const name of await readdir(assetsDir)) {
      if(!/^[a-zA-Z0-9_-]{8,80}\.(?:json|pdf|png|jpe?g|webp)$/.test(name)) continue;
      const bytes=await readFile(join(assetsDir,name));
      await copyFile(join(assetsDir,name),join(directory,'assets',name));
      manifest.assets.push({name,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});manifest.bytes+=bytes.length;
    }
    manifest.complete=true;
    await writeFile(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600});
    return manifest;
  }
  async restoreBackup(id,{baseRevision,requestId}) {
    if(!/^backup_[a-f0-9]{32}$/.test(id)) invalid('invalid backup id');
    if(!Number.isInteger(baseRevision)||typeof requestId!=='string'||!requestId||requestId.length>150) invalid('restore requires revision and requestId');
    const replay=this.db.prepare('SELECT * FROM engine_commit WHERE request_id=?').get(requestId);
    if(replay) {
      const metadata=JSON.parse(replay.metadata);
      if(metadata.action!=='restore_trusted_local_backup'||metadata.backupId!==id||metadata.restoreBaseRevision!==baseRevision) throw new StoreError(409,'idempotency_conflict');
      return {ok:true,revision:replay.revision,savedAt:replay.saved_at,replayed:true,recoveryBackupId:metadata.recoveryBackupId};
    }
    if(this.revision!==baseRevision) throw new StoreError(409,'revision_conflict');
    const directory=join(this.dataDir,'exam-backups',id);
    if(!existsSync(join(directory,'manifest.json'))) throw new StoreError(404,'backup_not_found');
    const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
    if(!manifest.complete||manifest.id!==id) invalid('incomplete backup');
    const dbBytes=await readFile(join(directory,'engine.sqlite'));
    if(createHash('sha256').update(dbBytes).digest('hex')!==manifest.databaseSha256) invalid('backup database checksum mismatch');
    // Verify every asset before modifying either active data or database state.
    for(const asset of manifest.assets) {
      if(!/^[a-zA-Z0-9_-]{8,80}\.(?:json|pdf|png|jpe?g|webp)$/.test(asset.name)) invalid('invalid backup asset name');
      const bytes=await readFile(join(directory,'assets',asset.name));
      if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256) invalid('backup asset checksum mismatch');
      const target=join(this.dataDir,'exam-assets',asset.name);
      if(existsSync(target)) {
        const existing=await readFile(target);
        if(createHash('sha256').update(existing).digest('hex')!==asset.sha256) invalid('active immutable asset conflicts with backup; restore cannot overwrite it');
      }
    }
    const recovery=await this.backup({baseRevision,requestId:`before-restore:${requestId}`});
    const source=new DatabaseSync(join(directory,'engine.sqlite'),{readOnly:true});
    let rows;try {rows=source.prepare('SELECT collection,entity_id,payload FROM engine_entity').all();}finally{source.close();}
    const desired=new Map(rows.map(r=>[`${r.collection}\0${r.entity_id}`,r]));
    const current=this.db.prepare('SELECT collection,entity_id,payload FROM engine_entity').all();
    const changes=[];
    for(const row of current) {
      const key=`${row.collection}\0${row.entity_id}`, wanted=desired.get(key);
      if(IMMUTABLE.has(row.collection)) {desired.delete(key);continue;}
      if(!wanted) changes.push({collection:row.collection,id:row.entity_id,delete:true});
      else {if(row.payload!==wanted.payload) changes.push({collection:row.collection,id:row.entity_id,value:JSON.parse(wanted.payload)});desired.delete(key);}
    }
    for(const row of desired.values()) changes.push({collection:row.collection,id:row.entity_id,value:JSON.parse(row.payload)});
    const event={id:`restore:${randomUUID()}`,entityType:'backup',entityId:id,entityIds:changes.filter(c=>!c.delete).map(c=>c.id),status:'confirmed',reviewer:'local_teacher',at:stamp(),payload:{operation:'restore_trusted_local_backup',backupRevision:manifest.revision,recoveryBackupId:recovery.id}};
    changes.push({collection:'auditEvents',id:event.id,value:event});
    // Restoring a verified local snapshot is a new publication action for
    // every changed ready sheet. Record it explicitly instead of weakening
    // the normal ready-to-ready confirmation rule for generic commits.
    for(const change of [...changes]) if(change.collection==='questionSets'&&!change.delete&&change.value.status==='ready') {
      const confirmation={id:`restore-sheet:${randomUUID()}`,entityType:'question_set',entityId:change.id,status:'confirmed',reviewer:'local_teacher',at:stamp(),payload:{operation:'restore_trusted_local_backup',backupId:id,backupRevision:manifest.revision}};
      changes.push({collection:'auditEvents',id:confirmation.id,value:confirmation});
    }
    await mkdir(join(this.dataDir,'exam-assets'),{recursive:true,mode:0o700});
    for(const asset of manifest.assets) if(!existsSync(join(this.dataDir,'exam-assets',asset.name))) await copyFile(join(directory,'assets',asset.name),join(this.dataDir,'exam-assets',asset.name));
    const result=this.commit({baseRevision,requestId,changes,meta:{action:'restore_trusted_local_backup',backupId:id,restoreBaseRevision:baseRevision,recoveryBackupId:recovery.id}});
    return {...result,recoveryBackupId:recovery.id};
  }
  commit(input) {
    const {baseRevision,requestId,changes,meta={}} = input || {};
    if (!Number.isInteger(baseRevision) || typeof requestId !== 'string' || !requestId.trim() || requestId.length>180 || !Array.isArray(changes) || changes.length>250000) invalid('baseRevision, requestId and bounded changes are required');
    const requestHash = digest(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const replay = this.db.prepare('SELECT * FROM engine_commit WHERE request_id=?').get(requestId);
      if (replay) {
        if (replay.request_hash !== requestHash) throw new StoreError(409,'idempotency_conflict');
        this.db.exec('COMMIT'); return {ok:true,revision:replay.revision,savedAt:replay.saved_at,replayed:true,changed:0};
      }
      const current=this.revision;
      if (baseRevision!==current) throw new StoreError(409,'revision_conflict',`数据库版本为 ${current}，请合并本地修改后重试`);
      const engine=this.getEngine().engine;
      const original={}; const indexed={};
      for (const name of COLLECTIONS) indexed[name]=new Map(engine[name].map(v=>[v.id,v]));
      const duplicate=new Set();
      for (const change of changes) {
        const {collection,id,value}=change||{};
        if (!COLLECTIONS.includes(collection) && collection!=='meta') invalid('unknown collection');
        if (typeof id!=='string'||!id||id.length>250) invalid('invalid entity id');
        const key=`${collection}\0${id}`;
        if(duplicate.has(key)) invalid('one change per entity per commit'); duplicate.add(key);
        original[key]=collection==='meta'?engine[id]:indexed[collection].get(id);
        if(IMMUTABLE.has(collection)&&original[key] && (change.delete || digest(original[key])!==digest(value))) invalid(`${collection} is immutable; append a correction event`);
        if(collection==='meta') {
          if(!META.has(id)) invalid('unknown metadata field');
          if(change.delete) delete engine[id]; else engine[id]=value;
        } else if(change.delete) indexed[collection].delete(id);
        else {
          if(!value||typeof value!=='object'||Array.isArray(value)||value.id!==id) invalid('entity value must match id');
          indexed[collection].set(id,value);
        }
      }
      for(const name of COLLECTIONS) engine[name]=[...indexed[name].values()];
      validateEngine(engine, changes, original, meta);
      for(const {collection,value,delete:deleted} of changes) {
        if(deleted||value?.migrationNeedsReview) continue;
        const assets=collection==='files'?[value.originalAsset,...(value.pageAssets||[])]:collection==='questions'?(value.imageAssets||[]):[];
        for(const asset of assets.filter(Boolean)) {
          if(!/^[a-zA-Z0-9_-]{8,80}$/.test(String(asset.id||'')) || !existsSync(join(this.dataDir,'exam-assets',`${asset.id}.json`))) invalid('asset reference does not exist in local immutable storage');
        }
      }
      const revision=current+1, savedAt=stamp();
      this.db.prepare('INSERT INTO engine_commit VALUES (?,?,?,?,?)').run(requestId,requestHash,revision,savedAt,JSON.stringify(meta));
      const upsert=this.db.prepare('INSERT INTO engine_entity VALUES (?,?,?,?) ON CONFLICT(collection,entity_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload');
      const history=this.db.prepare('INSERT INTO engine_revision(request_id,collection,entity_id,before_json,after_json,changed_at) VALUES(?,?,?,?,?,?)');
      for (const change of changes) {
        const {collection,id,value}=change;
        this.db.prepare('DELETE FROM engine_link WHERE from_collection=? AND from_id=?').run(collection,id);
        if(change.delete) this.db.prepare('DELETE FROM engine_entity WHERE collection=? AND entity_id=?').run(collection,id);
        else upsert.run(collection,id,revision,JSON.stringify(value));
        history.run(requestId,collection,id,original[`${collection}\0${id}`]===undefined?null:JSON.stringify(original[`${collection}\0${id}`]),change.delete?null:JSON.stringify(value),savedAt);
      }
      const link=this.db.prepare('INSERT OR IGNORE INTO engine_link VALUES (?,?,?,?)');
      for(const {collection,id,value,delete:deleted} of changes) {
        if(deleted||collection==='meta'||value.migrationNeedsReview) continue;
        for(const [target,targetId] of linksFor(collection,value)) if(indexed[target]?.has(targetId)) link.run(collection,id,target,targetId);
      }
      this.db.prepare('UPDATE engine_meta_v2 SET revision=?,saved_at=? WHERE id=1').run(revision,savedAt);
      this.db.exec('COMMIT'); return {ok:true,revision,savedAt,changed:changes.length};
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  migrateLegacy(legacy) {
    const changes=[];
    for(const name of COLLECTIONS) for(const value of Array.isArray(legacy[name])?legacy[name]:[]) {
      if(!value?.id) continue;
      const next={...value,migrationNeedsReview:true};
      if(name==='questions') {next.reviewed=false;next.reviewStatus='pending';}
      if(name==='attempts') {next.manualVerified=false;next.status='pending';next.verificationStatus='pending';}
      if(name==='canonicalExams') {next.completenessConfirmed=false;next.dedupeStatus='pending';}
      changes.push({collection:name,id:next.id,value:next});
    }
    for(const key of META) if(legacy[key]!==undefined) changes.push({collection:'meta',id:key,value:legacy[key]});
    const event={id:`migration:${randomUUID()}`,status:'legacy_quarantined',at:stamp(),reason:'旧版本缺少可验证审核版本；已备份，需重新确认'};
    changes.push({collection:'auditEvents',id:event.id,value:event});
    this.commit({baseRevision:0,requestId:event.id,changes,meta:{action:'legacy_migration'}});
  }
}

function linksFor(collection,v) {
  if(collection==='files'||collection==='questions') return v.canonicalExamId?[['canonicalExams',v.canonicalExamId]]:[];
  if(collection==='attempts' && v.manualVerified) return [['questions',v.questionId]];
  if(collection==='questionSets') return StudentQuestionSets.normalizeRefs(v.questionRefs).map(ref=>['questions',ref.questionId]);
  return [];
}
function validateSource(v, {draft=false}={}) {
  if(!layers.has(v.sourceLayer)) invalid('invalid source layer');
  const region=String(v.region||'').trim().replace(/^湖南省/,'').replace(/市$/,'');
  if(v.sourceLayer==='A'&&(region!=='长沙'||v.examType!=='中考原卷')) invalid('A必须是长沙中考原卷');
  if(v.sourceLayer==='B'&&(!HUNAN.has(region)||v.examType!=='中考原卷')) invalid('B必须是湖南其他地市中考原卷');
  if(v.sourceLayer==='C'&&region!=='长沙') invalid('C必须是长沙本地学校试卷');
  if(['A','B','C'].includes(v.sourceLayer)&&(!Number.isInteger(Number(v.year))||Number(v.year)<1980||Number(v.year)>new Date().getFullYear()+1)) invalid('invalid exam year');
  if(v.paperOriginId!=null&&(typeof v.paperOriginId!=='string'||v.paperOriginId.length>180||/[\u0000-\u001f]/.test(v.paperOriginId))) invalid('paperOriginId must be a bounded string');
  if(v.paperOriginName!=null&&(typeof v.paperOriginName!=='string'||v.paperOriginName.length>300)) invalid('paperOriginName must be a bounded string');
  if(v.applicableRegions!=null) {
    if(!Array.isArray(v.applicableRegions)||v.applicableRegions.length>40||v.applicableRegions.some(r=>typeof r!=='string'||!r.trim()||r.length>80)) invalid('applicableRegions must be a bounded region list');
    const regions=v.applicableRegions.map(r=>r.trim().replace(/^湖南省/,'').replace(/市$/,''));
    if(new Set(regions).size!==regions.length) invalid('applicableRegions must not repeat regions');
    if(['A','B','C'].includes(v.sourceLayer)&&regions.some(r=>r!=='长沙'&&!HUNAN.has(r))) invalid('official/local applicableRegions must belong to Hunan');
    if(regions.length&&!regions.includes(region)&&v.sourceLayer!=='D') invalid('applicableRegions must include the source region');
  }
  if(!draft&&!v.duplicateGroupId) invalid('missing duplicate_group_id');
}
function studentPublicationDigest(set) {
  // These are the fields that determine the issued sheet or who confirmed
  // it. Local timestamps such as updatedAt do not change a publication.
  return digest({
    title: String(set?.title || '').trim(),
    questionRefs: StudentQuestionSets.normalizeRefs(set?.questionRefs),
    status: set?.status || 'draft',
    publishedAt: String(set?.publishedAt || '').trim(),
    publishedBy: String(set?.publishedBy || '').trim(),
  });
}
function validateEngine(engine,changes,old,meta) {
  const exams=new Map(engine.canonicalExams.map(v=>[v.id,v]));
  const questions=new Map(engine.questions.map(v=>[v.id,v]));
  const aliases=new Map(engine.questionAliases.map(v=>[v.id,v.targetId]));
  const canonicalQuestionId=id=>{
    const visited=new Set();let current=id;
    while(aliases.has(current)) {if(visited.has(current)) invalid('question alias cycle');visited.add(current);current=aliases.get(current);}
    return current;
  };
  for(const alias of engine.questionAliases) if(!questions.has(canonicalQuestionId(alias.id))) invalid('question alias references unknown target');
  const reviewEvents=changes.filter(c=>c.collection==='auditEvents'&&!c.delete).map(c=>c.value);
  const teacherAction=meta.action==='teacher_review'&&meta.reviewer==='local_teacher';
  const approved=id=>teacherAction||reviewEvents.some(e=>(e.entityId===id || (Array.isArray(e.entityIds)&&e.entityIds.includes(id)))&&['question_review','confirmed','confirmed_attempts_written','exam_review'].includes(e.status)&&(e.reviewer==='local_teacher'||e.reviewedBy==='local_teacher'));
  const formalOrigins=new Set();
  for(const exam of engine.canonicalExams) {
    if(exam.migrationNeedsReview) continue;
    validateSource(exam);
    if(exam.paperOriginId?.trim()&&['A','B'].includes(exam.sourceLayer)&&(exam.completenessConfirmed||exam.complete)&&!exam.mergedInto) {
      const origin=JSON.stringify([exam.sourceLayer,String(exam.year),String(exam.region).trim().replace(/^湖南省/,'').replace(/市$/,''),exam.paperOriginId.trim()]);
      if(formalOrigins.has(origin)) invalid('同年度同地区同命题原卷ID只能确认一个独立主版本，请先合并重复版本');
      formalOrigins.add(origin);
    }
  }
  for(const file of engine.files) {
    if(file.migrationNeedsReview) continue;
    const processing=['processing','queued','failed','paused'].includes(file.status)&&!file.canonicalExamId;
    validateSource(file,{draft:processing});
    if(processing) continue;
    const exam=exams.get(file.canonicalExamId);
    if(!exam||exam.sourceLayer!==file.sourceLayer) invalid('source_document references unknown or conflicting canonical exam');
    if(file.paperOriginId?.trim()&&exam.paperOriginId?.trim()&&file.paperOriginId.trim()!==exam.paperOriginId.trim()) invalid('source document and canonical paper origin disagree');
  }
  for(const q of engine.questions) {
    if(q.migrationNeedsReview) continue;
    const exam=exams.get(q.canonicalExamId);
    // Generated D items share question IDs with retests, but can never become official exam evidence.
    if(q.generated===true) {
      if(q.sourceLayer!=='D'||q.countedInFrequency!==false||q.canonicalExamId) invalid('generated questions must be D, excluded from frequency, without an official canonical exam');
      if(q.sourceFileId || (Array.isArray(q.sourceSpans)&&q.sourceSpans.length) || q.pageNo!=null) invalid('generated questions cannot claim original source pages; use derivedFromQuestionId for the parent question');
    } else if(!exam||q.sourceLayer&&q.sourceLayer!==exam.sourceLayer) invalid('question references unknown or conflicting canonical exam');
    if(q.score!==null&&q.score!==undefined&&q.score!==''&&(!Number.isFinite(Number(q.score))||Number(q.score)<0)) invalid('score must be non-negative or unknown');
    if(q.pageNo!=null&&(!Number.isInteger(Number(q.pageNo))||Number(q.pageNo)<1)) invalid('question page number must be positive');
  }
  for(const set of engine.questionSets) {
    const refs=StudentQuestionSets.normalizeRefs(set.questionRefs);
    if(refs.length !== (Array.isArray(set.questionRefs) ? set.questionRefs.length : 0)) invalid('question set contains duplicate or invalid question references');
    if(refs.length>100) invalid('question set exceeds 100 questions');
    for(const ref of refs) if(!questions.has(ref.questionId)) invalid('question set references unknown question');
  }
  const activeIdentities=new Set();
  for(const a of engine.attempts) {
    if(a.migrationNeedsReview) {if(a.manualVerified) invalid('迁移记录需要重新核验'); continue;}
    if(a.sourceLayer!=='E') invalid('attempt requires source layer E');
    if(a.manualVerified) {
      if(!questions.has(canonicalQuestionId(a.questionId))) invalid('verified attempt references unknown question');
      if(!a.studentId||!a.classId||!a.sessionId) invalid('verified attempt requires stable student, class and session identities');
      if(a.isCorrect!==true&&a.isCorrect!==false) invalid('verified attempt requires a known outcome');
      // Existing responses to two source versions remain auditable after a merge;
      // the domain resolves aliases and selects one effective response for statistics.
      const identity=JSON.stringify([a.classId,a.studentId,a.sessionId,a.questionId,a.partId||'whole',String(a.round||1)]);
      if(activeIdentities.has(identity)) invalid('same response identity cannot have two active verified revisions');
      activeIdentities.add(identity);
    }
    if(a.timeSeconds!=null&&a.timeSeconds!==''&&(!Number.isFinite(Number(a.timeSeconds))||Number(a.timeSeconds)<0)) invalid('invalid time_seconds');
  }
  for(const mapping of Object.values(engine.lessonMappings||{})) for(const id of Object.values(mapping||{})) if(id&&!questions.has(id)) invalid('unknown lesson question mapping');
  for(const c of changes) {
    if(c.delete||c.collection==='meta') continue;
    const v=c.value, previous=old[`${c.collection}\0${c.id}`];
    if(meta.action==='legacy_migration') continue;
    if(c.collection==='questions'&&previous&&previous.generated!==true&&v.generated===true) invalid('a source question cannot be converted to generated in place; create a new derived question ID');
    if(c.collection==='questions'&&v.reviewed && (!previous?.reviewed || digest({...previous,reviewed:false})!==digest({...v,reviewed:false}))) {
      if(!approved(c.id)) invalid('question confirmation requires an explicit local teacher review event');
      if(!v.reviewedAt) invalid('question confirmation requires reviewedAt');
    }
    if(c.collection==='attempts'&&v.manualVerified&&(!previous?.manualVerified||digest(previous)!==digest(v))) {
      if(!approved(c.id)) invalid('作答人工确认必须由本机教师审核事件授权，不能信任CSV声明');
      if(!v.verifiedAt) invalid('attempt confirmation requires verifiedAt');
    }
    if(c.collection==='canonicalExams'&&(v.completenessConfirmed===true||v.complete===true)&&!(previous?.completenessConfirmed===true||previous?.complete===true)&&!approved(c.id)) invalid('exam completeness requires teacher review');
    if(c.collection==='questionSets'&&v.status==='ready') {
      const issues=StudentQuestionSets.questionSetIssues(v,questions);
      if(issues.length) invalid(issues.join('；'));
      const publicationChanged=previous?.status!=='ready'||studentPublicationDigest(v)!==studentPublicationDigest(previous);
      if(publicationChanged) {
        const confirmed=reviewEvents.some(event=>event.entityType==='question_set'&&event.entityId===c.id&&event.status==='confirmed'&&event.reviewer==='local_teacher'&&!old[`auditEvents\0${event.id}`]);
        if(!confirmed) invalid('student question set publication requires an explicit local teacher review event');
      }
    }
    if(c.collection==='importJobs' && !['queued','running','paused','failed','completed','cancelled','pending','awaiting_review'].includes(v.status)) invalid('invalid import job status');
  }
}
