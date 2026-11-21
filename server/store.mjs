import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync,readFileSync,writeFileSync,chmodSync,copyFileSync,linkSync,readdirSync,rmSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {migrateState,captureSession,selectSession,sessionKey,courseKey,clone,identifyRows,activeStudents,syncRosterNames,sourceVersion,assessmentReviewSource,validateScoring,pointsScore,validateGate,reconcileGate,currentGateLesson,blockedMessage,taskSignature,objectiveVerdict,fingerprint,emptySession,emptyGate} from '../shared/domain.mjs';

export class AppError extends Error { constructor(message,status=400,extra={}) {super(message);this.status=status;this.extra=extra;} }
const sha = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const json = value => JSON.stringify(value);
const safeObject = value => {
  if(!value || typeof value !== 'object' || Array.isArray(value))throw new AppError('数据格式不正确');
  const text=json(value);
  if(Buffer.byteLength(text)>32*1024*1024)throw new AppError('结构化记录超过32MB，请先导出旧学期归档',413);
  const walk=v=>{if(!v||typeof v!=='object')return;for(const k of Object.keys(v)){if(['__proto__','prototype','constructor'].includes(k))throw new AppError('不支持的数据字段');walk(v[k]);}};
  walk(value); return JSON.parse(text);
};
export class Store {
  constructor(root,options={}) {
    this.root=resolve(root);this.data=resolve(options.dataDir || join(root,'data'));
    this.materialDir=join(this.data,'materials');this.backupDir=join(this.data,'backups');
    for(const dir of [this.data,this.materialDir,this.backupDir]) {mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);}
    this.path=join(this.data,'workbench.sqlite');
    const fresh=!existsSync(this.path);
    this.db=new DatabaseSync(this.path);chmodSync(this.path,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, saved_at TEXT NOT NULL, body TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL, meta TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL, body TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS ai_cache (hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, body TEXT NOT NULL)',
    ].join(';'));
    if(!this.db.prepare('SELECT id FROM app_state').get()) {
      const legacy=join(this.data,'panel-state.json');
      let state={},legacySavedAt='';
      if(existsSync(legacy)) {
        try {const envelope=JSON.parse(readFileSync(legacy,'utf8'));state=envelope.state || {};legacySavedAt=envelope.savedAt || '';}catch {throw new AppError('旧数据文件损坏，已停止迁移。请先从备份恢复。',500);}
        const destination=join(this.data,'legacy-panel-state.json');
        if(!existsSync(destination)){copyFileSync(legacy,destination);chmodSync(destination,0o400);}
      }
      if(existsSync(join(root,'memory','panel-agent.md'))) {state.agent ||= {};state.agent.memory ||= readFileSync(join(root,'memory','panel-agent.md'),'utf8');}
      state=migrateState(state);
      state.migration.legacySavedAt=legacySavedAt;
      this.db.prepare('INSERT INTO app_state VALUES(1,1,?,?)').run(now(),json(state));
      this.audit('migration',{legacy:existsSync(legacy),schemaVersion:2});
      if(fresh)this.createBackup('migration',false);
    }
    for(const row of this.db.prepare("SELECT * FROM jobs WHERE status IN ('running','queued')").all()) {
      const job=JSON.parse(row.body);job.status='interrupted';job.error='上次处理已中断，成功结果已保存，可重试未完成项';this.putJob(job);
    }
    this.transact(undefined,state=>{
      for(const gate of Object.values(state.courses || {}))for(const student of Object.values(gate.progress || {}))for(const lesson of Object.values(student))for(const record of Object.values(lesson)){
        if(record.status==='checking'){record.status='pending';record.feedback='核验中断，答案已保留，请重新提交。';}
      }
    },{skipBackup:true,skipIfEqual:true});
  }
  get() {const row=this.db.prepare('SELECT * FROM app_state WHERE id=1').get();return {state:JSON.parse(row.body),revision:row.revision,savedAt:row.saved_at,schemaVersion:2};}
  audit(action,body){this.db.prepare('INSERT INTO audit VALUES(?,?,?,?)').run(randomUUID(),now(),action,json(body));}
  checkRevision(expected,current) {
    if(!Number.isInteger(expected))throw new AppError('页面版本已升级，请刷新后再保存。',428,{revision:current});
    if(expected!==current)throw new AppError('另一页面已保存新版本。你的草稿已保留，请比较后再处理。',409,{revision:current});
  }
  transact(expected,fn,{skipBackup=false,skipIfEqual=false}={}) {
    const current=this.get();
    if(expected!==undefined)this.checkRevision(expected,current.revision);
    if(!skipBackup)this.dailyBackup();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state=clone(current.state),result=fn(state);
      state.sessionId='';state.courseId='';
      selectSession(state,state.lesson);
      if(skipIfEqual&&json(state)===json(current.state)){this.db.exec('ROLLBACK');return {...current,result};}
      const savedAt=now(),revision=current.revision+1;
      this.db.prepare('UPDATE app_state SET revision=?,saved_at=?,body=? WHERE id=1').run(revision,savedAt,json(state));
      this.db.exec('COMMIT');return {state,revision,savedAt,result,ok:true};
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  save(incoming,expected) {
    this.checkRevision(expected,this.get().revision);
    incoming=safeObject(incoming);
    if(incoming.schemaVersion!==2)throw new AppError('旧格式数据请使用导入功能，避免覆盖新版记录',428);
    captureSession(incoming);
    return this.transact(expected,state=>{
      const next=migrateState(incoming);
      // Progress and published snapshots are owned by dedicated server operations.
      for(const [cid,gate]of Object.entries(next.courses)){
        const old=state.courses[cid];
        if(old){gate.progress=clone(old.progress);gate.revisions=clone(old.revisions || []);if(old.plan.locked)gate.plan=clone(old.plan);}
        else {gate.progress={};gate.revisions=[];if(gate.plan.locked)throw new AppError('请通过确认锁定发布课程任务');}
      }
      for(const [cid,gate]of Object.entries(state.courses))if(!next.courses[cid])next.courses[cid]=clone(gate);
      for(const [id,session]of Object.entries(next.sessions))if(!state.sessions[id]){session.confirmations={};session.revisions=[];session.pdf.confirmed=false;session.wrongbook.confirmed=false;session.scoring.confirmed=false;}
      for(const [id,session]of Object.entries(state.sessions)){
        if(!next.sessions[id])next.sessions[id]=clone(session);
        else {next.sessions[id].confirmations=clone(session.confirmations);next.sessions[id].revisions=clone(session.revisions);}
      }
      next.ai.key='';
      for(const key of Object.keys(state))delete state[key];
      Object.assign(state,next);
      // Clear stale projections before selecting the canonical session again.
      state.sessionId='';state.courseId='';
    });
  }
  importState(input,expected) {
    const next=migrateState(safeObject(input));
    if(!Array.isArray(next.grades)||!next.lesson||!next.sessions)throw new AppError('不是有效的面板备份');
    this.checkRevision(expected,this.get().revision);this.createBackup('before-import',false);
    const result=this.transact(expected,state=>{for(const k of Object.keys(state))delete state[k];Object.assign(state,next);state.sessionId='';state.courseId='';});
    this.audit('import',{revision:result.revision});return result;
  }
  confirmSession(id,type,reason,expected) {
    this.checkRevision(expected,this.get().revision);
    if(!['scores','wrongbook','pdf','knowledge','scoring'].includes(type))throw new AppError('未知确认类型');
    return this.transact(expected,state=>{
      const s=state.sessions[id];if(!s)throw new AppError('课次不存在',404);
      if(type==='scoring'){const errors=validateScoring(s);if(errors.length)throw new AppError(errors.join('；'));s.scoring.confirmed=true;}
      if(type==='scores'){
        for(const row of s.scores){
          if(row.score!==''&&(!Number.isFinite(Number(row.score))||Number(row.score)<0||Number(row.score)>Number(s.lesson.maxScore)))throw new AppError(row.name+'的分数超出0至满分的范围');
          if(s.scoring.mode==='points'&&row.status!=='请假'){
            if(!s.confirmations.scoring || fingerprint(s.confirmations.scoring.snapshot)!==fingerprint(s.scoring)) {
              // Grade entries do not change the confirmed rubric.
              const a=clone(s.confirmations.scoring?.snapshot || {}),b=clone(s.scoring);delete a.grades;delete b.grades;
              if(fingerprint(a)!==fingerprint(b))throw new AppError('请先确认本次评分标准');
            }
            const grade=pointsScore(s,row.studentId);if(!grade.complete||grade.errors.length)throw new AppError(row.name+'有未填写或超范围的步骤分');row.score=String(grade.sum);
          }
        }
      }
      if(type==='wrongbook'){
        if(!s.wrongbook.rows.length||s.wrongbook.rows.some(r=>!r.checked||!r.studentId))throw new AppError('请完成每位学生的逐行校对，并关联独立学生档案');
        if(s.scoring.mode==='legacy')for(const r of s.wrongbook.rows){
          if(r.score===''||r.status==='请假')continue;
          const expected=(Number(s.lesson.maxScore)-Number(r.score))/Number(s.lesson.penalty),actual=Object.values(r.answers || {}).filter(Boolean).length;
          if(Math.abs(expected-actual)>.001&&!r.checkReason?.trim())throw new AppError(r.name+'的错题与扣分有差异，请填写校对依据');
        }
      }
      if(type==='pdf'){
        const pairs=s.pdf.pairs,used=new Set(),pageUse=new Set();
        if(!s.pdf.materialId)throw new AppError('请先保存原卷');
        for(const p of pairs){
          if(!p.studentId || p.matchMethod!=='manual')throw new AppError('请逐份确认学生匹配，AI建议不等于教师确认');
          if(used.has(p.studentId))throw new AppError('同一学生匹配了多份试卷，请合并或检查分组');
          used.add(p.studentId);
          if(!Number.isInteger(p.start)||!Number.isInteger(p.end)||p.start<0||p.end<p.start||p.end>=s.pdf.pageCount)throw new AppError('分组页码无效');
          for(let n=p.start;n<=p.end;n++){if(pageUse.has(n))throw new AppError('试卷分组存在重叠页码');pageUse.add(n);}
        }
        if(pageUse.size!==s.pdf.pageCount)throw new AppError('存在未分配的卷面页，请检查分组');
        s.pdf.confirmed=true;
      }
      const previous=s.confirmations[type],snapshot=clone(s[type]);
      const assessmentSource=type==='wrongbook'?assessmentReviewSource(s):undefined;
      if(type==='wrongbook'){s.wrongbook.confirmed=true;snapshot.confirmed=true;}
      const changed=previous&&(fingerprint(previous.snapshot)!==fingerprint(snapshot)||fingerprint(previous.meta || s.lesson)!==fingerprint(s.lesson)||previous.assessmentSource!==assessmentSource);
      if(changed){
        if(!reason?.trim())throw new AppError('修订已确认记录需要填写原因');
        s.revisions.push({id:randomUUID(),type,at:now(),reason,previous:clone(previous)});
      }
      if(previous&&!changed)return;
      s.confirmations[type]={version:(previous?.version || 0)+1,at:now(),reason:reason || '首次确认',snapshot,meta:clone(s.lesson),...(assessmentSource&&{assessmentSource})};
      state.sessionId='';state.courseId='';
    });
  }
  updateStudent(id,action,body,expected) {
    this.checkRevision(expected,this.get().revision);
    return this.transact(expected,state=>{
      const student=state.students[id];if(!student)throw new AppError('学生不存在',404);
      const previous=clone(student);
      if(action==='rename'){
        const name=String(body.name || '').trim();if(!name)throw new AppError('姓名不能为空');
        student.names=[...new Set([...(student.names || []),student.name,name])];student.name=name;
      }else if(action==='transfer'){
        const target=state.grades.find(g=>g.id===body.gradeId);if(!target)throw new AppError('目标班级不存在');
        state.grades.forEach(g=>g.studentIds=g.studentIds.filter(x=>x!==id));target.studentIds.push(id);student.gradeId=target.id;student.inactive=false;
      }else if(action==='inactive')student.inactive=!!body.inactive;
      else throw new AppError('未知学生操作');
      student.history ||= [];student.history.push({at:now(),kind:action,gradeId:previous.gradeId,previousName:previous.name,reason:body.reason || ''});
      syncRosterNames(state);
      // Historical confirmed snapshots remain untouched. Current drafts display the new name.
      for(const session of Object.values(state.sessions))for(const rows of [session.scores,session.wrongbook.rows,session.feedbacks])for(const row of rows)if(row.studentId===id)row.name=student.name;
      state.sessionId='';state.courseId='';
    });
  }
  classifyRecord(id,body,expected){
    this.checkRevision(expected,this.get().revision);
    return this.transact(expected,state=>{
      const item=state.unassigned.find(x=>x.id===id);if(!item)throw new AppError('待归类记录不存在',404);
      if(item.classifiedAt)throw new AppError('该记录已完成归类，不会重复导入');
      if(!body.reason?.trim())throw new AppError('请填写归类依据');
      if(item.kind==='record-identity'){
        const student=state.students[body.studentId],session=state.sessions[item.sessionId];
        if(!student||!session)throw new AppError('请选择已有学生档案');
        const rows={scores:session.scores,pdf:session.pdf.pairs,wrongbook:session.wrongbook.rows,feedbacks:session.feedbacks}[item.field],row=rows?.[item.index];
        if(!row)throw new AppError('原记录位置已变化，请先查看原始记录');
        if(row.studentId)throw new AppError('原记录已经关联学生，请检查是否重复操作');
        row.studentId=student.id;row.name=student.name;
        if(item.field==='pdf')row.student=student.name;
      }else{
        const field={scoreArchives:'scores',pdfArchives:'pdf',wrongbookArchives:'wrongbook',feedbackArchives:'feedbacks'}[item.kind];
        if(!field)throw new AppError('整份冲突草稿须逐项人工比对，不能直接覆盖当前数据库。可导出后通过导入预览恢复。');
        const grade=state.grades.find(g=>g.id===body.gradeId);
        if(!grade||!/^\d{4}$/.test(String(body.year))||!['春季','暑假','秋季','寒假'].includes(body.term)||!Number.isInteger(Number(body.lessonNo))||Number(body.lessonNo)<1)throw new AppError('请完整选择班级、年份、学期和课次');
        const lesson={...state.lesson,gradeId:grade.id,year:String(body.year),term:body.term,lessonNo:String(body.lessonNo)},sid=sessionKey(lesson),session=state.sessions[sid] ||= emptySession(lesson),record=clone(item.record);
        if(session.confirmations[field])throw new AppError('目标课次已有此类型确认记录，请选择正确归属，系统不会替你覆盖');
        session[field]=['pdf','wrongbook'].includes(field)?record:(record[field] || []);
        identifyRows(state,session);session.confirmations[field]={version:1,at:now(),reason:body.reason,snapshot:clone(session[field]),meta:clone(lesson)};
      }
      item.classifiedAt=now();item.classification=clone(body);delete item.classification.expectedRevision;
    });
  }
  addMaterial(bytes,{name,type,sessionId='',kind='material'}) {
    if(!bytes.length || bytes.length>100*1024*1024)throw new AppError('单个资料须在100MB以内，空文件无法导入',413);
    const extension=String(name).split('.').pop().toLowerCase();
    const allowed=['pdf','png','jpg','jpeg','webp','txt','md','csv','docx'];
    if(!allowed.includes(extension))throw new AppError('不支持该资料格式',415);
    if(extension==='pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw new AppError('文件不是有效PDF',415);
    if(extension==='docx'&&bytes.subarray(0,2).toString()!=='PK')throw new AppError('文件不是有效DOCX',415);
    if(['png','jpg','jpeg','webp'].includes(extension)){
      const valid=extension==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):extension==='webp'?bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP':bytes[0]===255&&bytes[1]===216;
      if(!valid)throw new AppError('图片内容与扩展名不符',415);
    }
    const hash=sha(bytes),path=join(this.materialDir,hash);
    if(!existsSync(path))writeFileSync(path,bytes,{mode:0o600});
    const known=this.db.prepare('SELECT * FROM materials WHERE hash=? AND name=?').get(hash,name);
    if(known)return this.material(known.id);
    const id=randomUUID(),created=now(),mime={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',csv:'text/csv',txt:'text/plain',md:'text/plain'}[extension];
    this.db.prepare('INSERT INTO materials VALUES(?,?,?,?,?,?,?)').run(id,String(name).slice(0,240),hash,mime,bytes.length,created,json({sessionId,kind,originalType:type,extracts:[]}));
    this.audit('material-added',{id,hash,size:bytes.length});return this.material(id);
  }
  material(id) {const row=this.db.prepare('SELECT * FROM materials WHERE id=?').get(id);if(!row)throw new AppError('资料不存在',404);return {...row,meta:JSON.parse(row.meta),url:'/api/materials/'+id+'/file'};}
  materials() {return this.db.prepare('SELECT id FROM materials ORDER BY created_at DESC').all().map(x=>this.material(x.id));}
  materialFile(id) {const m=this.material(id),path=join(this.materialDir,m.hash);if(!existsSync(path))throw new AppError('原文件缺失，请从备份恢复',404);return {material:m,path};}
  setExtracts(id,extracts){const m=this.material(id);m.meta.extracts=extracts;this.db.prepare('UPDATE materials SET meta=? WHERE id=?').run(json(m.meta),id);return this.material(id);}
  listBackups() {
    return readdirSync(this.backupDir,{withFileTypes:true}).filter(d=>d.isDirectory()).flatMap(d=>{
      try{return JSON.parse(readFileSync(join(this.backupDir,d.name,'manifest.json'),'utf8'));}catch{return [];}
    }).sort((a,b)=>b.at.localeCompare(a.at));
  }
  createBackup(kind='manual',manual=true) {
    const record=this.get(),id=now().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8),dir=join(this.backupDir,id);
    mkdirSync(dir,{mode:0o700});mkdirSync(join(dir,'materials'),{mode:0o700});
    try {
      const sqlitePath=join(dir,'workbench.sqlite');
      this.db.exec("VACUUM INTO '"+sqlitePath.replace(/'/g,"''")+"'");
      const materials=this.materials();
      for(const m of materials){const source=join(this.materialDir,m.hash),destination=join(dir,'materials',m.hash);if(!existsSync(source))throw new AppError('有原文件缺失，备份未完成');if(!existsSync(destination)){try{linkSync(source,destination);}catch{copyFileSync(source,destination);}}}
      const manifest={id,at:now(),kind,manual,revision:record.revision,students:Object.keys(record.state.students).length,sessions:Object.keys(record.state.sessions).length,files:materials.map(m=>({id:m.id,hash:m.hash,size:m.size})),databaseHash:sha(readFileSync(sqlitePath))};
      writeFileSync(join(dir,'manifest.json'),json(manifest),{mode:0o600});
      return manifest;
    }catch(error){rmSync(dir,{recursive:true,force:true});throw error;}
  }
  dailyBackup(){
    const date=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at)),today=date(now());
    if(this.listBackups().some(b=>b.kind==='daily'&&date(b.at)===today))return;
    this.createBackup('daily',false);
    for(const backup of this.listBackups())if(backup.kind==='daily'&&!backup.manual&&Date.now()-Date.parse(backup.at)>30*86400000)rmSync(join(this.backupDir,backup.id),{recursive:true,force:true});
  }
  inspectBackup(id) {
    const manifest=this.listBackups().find(x=>x.id===id);if(!manifest)throw new AppError('备份不存在',404);
    const dir=join(this.backupDir,id),file=join(dir,'workbench.sqlite');
    if(sha(readFileSync(file))!==manifest.databaseHash)throw new AppError('备份数据库校验失败，不能恢复');
    for(const m of manifest.files){const path=join(dir,'materials',m.hash);if(!existsSync(path)||sha(readFileSync(path))!==m.hash)throw new AppError('备份原文件校验失败，不能恢复');}
    const db=new DatabaseSync(file,{readOnly:true});
    try {
      if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new AppError('备份完整性检查失败');
      const body=JSON.parse(db.prepare('SELECT body FROM app_state WHERE id=1').get().body),current=this.get().state;
      const changes=[...new Set([...Object.keys(current.sessions),...Object.keys(body.sessions)])].flatMap(id=>{
        const a=current.sessions[id],b=body.sessions[id];if(fingerprint(a)===fingerprint(b))return [];
        const lesson=(b || a).lesson,fields=['scores','knowledge','wrongbook','feedbacks','scoring','corrections','followups','confirmations'].filter(k=>fingerprint(a?.[k])!==fingerprint(b?.[k]));
        return [{id,label:(body.grades.find(g=>g.id===lesson.gradeId)?.name || current.grades.find(g=>g.id===lesson.gradeId)?.name || '历史班级')+' '+lesson.year+lesson.term+' 第'+lesson.lessonNo+'课',kind:!a?'补回':!b?'移出当前记录':'还原',fields}];
      });
      return {manifest,state:body,diff:{studentsBefore:Object.keys(current.students).length,studentsAfter:Object.keys(body.students).length,sessionsBefore:Object.keys(current.sessions).length,sessionsAfter:Object.keys(body.sessions).length,files:manifest.files.length,changes}};
    }finally{db.close();}
  }
  restoreBackup(id,expected) {
    this.checkRevision(expected,this.get().revision);const inspected=this.inspectBackup(id);
    this.createBackup('before-restore',false);
    const dir=join(this.backupDir,id),backupDb=new DatabaseSync(join(dir,'workbench.sqlite'),{readOnly:true});
    try{
      for(const m of inspected.manifest.files){const dst=join(this.materialDir,m.hash);if(!existsSync(dst))copyFileSync(join(dir,'materials',m.hash),dst);}
      const result=this.transact(expected,state=>{
        for(const key of Object.keys(state))delete state[key];Object.assign(state,inspected.state);state.sessionId='';state.courseId='';
        for(const row of backupDb.prepare('SELECT * FROM materials').all())this.db.prepare('INSERT OR REPLACE INTO materials VALUES(?,?,?,?,?,?,?)').run(row.id,row.name,row.hash,row.type,row.size,row.created_at,row.meta);
        this.db.prepare("DELETE FROM jobs").run();
        for(const row of backupDb.prepare('SELECT * FROM jobs').all()){const job=JSON.parse(row.body);if(['running','queued'].includes(job.status)){job.status='interrupted';job.error='备份恢复后需人工继续任务，已完成成果保留';}this.putJob(job);}
        for(const gate of Object.values(state.courses))for(const lessons of Object.values(gate.progress))for(const records of Object.values(lessons))for(const r of Object.values(records))if(r.status==='checking'){r.status='pending';delete r.requestId;r.feedback='从备份恢复了答案，请重新提交或请教师复核。';}
      });
      this.audit('restored',{backupId:id,revision:result.revision});return result;
    }finally{backupDb.close();}
  }
  putJob(job){job.updatedAt=now();this.db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?,?,?)').run(job.id,job.status,job.updatedAt,json(job));return job;}
  getJob(id){const row=this.db.prepare('SELECT body FROM jobs WHERE id=?').get(id);if(!row)throw new AppError('任务不存在',404);return JSON.parse(row.body);}
  jobs(){return this.db.prepare('SELECT body FROM jobs ORDER BY updated_at DESC LIMIT 100').all().map(x=>JSON.parse(x.body));}
  newJob(body){const job={id:randomUUID(),label:body.label || 'AI任务',kind:body.kind || 'ai',sessionId:body.sessionId,courseId:body.courseId,studentId:body.studentId,version:body.version,plan:body.plan,status:'running',total:body.total || 1,items:[],at:now(),usage:null};return this.putJob(job);}
  cacheGet(hash){const row=this.db.prepare('SELECT body FROM ai_cache WHERE hash=?').get(hash);return row?JSON.parse(row.body):null;}
  cacheSet(hash,body){this.db.prepare('INSERT OR REPLACE INTO ai_cache VALUES(?,?,?)').run(hash,now(),json(body));}
  lockGate(cid,plan,sources,reason,expected) {
    this.checkRevision(expected,this.get().revision);
    return this.transact(expected,state=>{
      const gate=state.courses[cid];if(!gate)throw new AppError('课程计划不存在',404);
      const errors=validateGate(plan,sources);if(errors.length)throw new AppError(errors.join('；'));
      if(gate.plan.locked&&!reason?.trim())throw new AppError('发布修订版本需要填写修改原因');
      const old=clone(gate.plan),next={...clone(plan),locked:true,lockedAt:now(),version:(old.version || 0)+1,sources:clone(sources)};
      if(old.locked)gate.revisions.push({plan:old,progress:clone(gate.progress),reason,archivedAt:now()});
      gate.plan=next;gate.sources=clone(sources);gate.progress=reconcileGate(old,next,gate.progress);delete gate.draftPlan;
      state.sessionId='';state.courseId='';
    });
  }
  beginGate(cid,sid,lid,tid,evidence,requestId,expected) {
    this.checkRevision(expected,this.get().revision);
    return this.transact(expected,state=>{
      const gate=state.courses[cid];if(!gate?.plan.locked)throw new AppError('教师尚未锁定课程任务');
      if(!state.students[sid]||state.students[sid].gradeId!==decodeURIComponent(cid.split('|')[0]))throw new AppError('请选择本班已建档学生');
      const lesson=currentGateLesson(gate,sid);
      if(lesson?.id!==lid)throw new AppError(lesson?blockedMessage(lesson,gate.progress[sid]):'全部课程已完成');
      const task=lesson.tasks.find(t=>t.id===tid);if(!task)throw new AppError('任务不存在');
      if(!String(evidence || '').trim())throw new AppError('请先填写作答过程');
      const records=(gate.progress[sid] ||= {})[lid] ||= {};
      if(records[tid]?.status==='checking')throw new AppError('该任务正在核验，请勿重复提交',409);
      const previous=clone(records[tid] || {});
      records[tid]={...previous,status:'checking',evidence,requestId,attempts:(previous.attempts || 0)+1,updatedAt:now()};
      state.sessionId='';state.courseId='';
      return {task:clone(task),planVersion:gate.plan.version,signature:taskSignature(task,gate.plan.sources),sources:clone(gate.plan.sources),previous};
    });
  }
  finishGate(cid,sid,lid,tid,requestId,signature,verdict) {
    return this.transact(undefined,state=>{
      const gate=state.courses[cid],task=gate?.plan.lessons.find(l=>l.id===lid)?.tasks.find(t=>t.id===tid),record=gate?.progress[sid]?.[lid]?.[tid];
      if(!task||record?.requestId!==requestId||signature!==taskSignature(task,gate.plan.sources))return {stale:true};
      Object.assign(record,verdict,{updatedAt:now()});
      record.history ||= [];record.history.push({evidence:record.evidence,...verdict,at:now()});delete record.requestId;
      state.sessionId='';state.courseId='';
    });
  }
  reviewGate(cid,sid,lid,tid,body,expected) {
    this.checkRevision(expected,this.get().revision);
    return this.transact(expected,state=>{
      const gate=state.courses[cid],lesson=currentGateLesson(gate,sid),task=lesson?.tasks.find(t=>t.id===tid);
      if(lesson?.id!==lid||!task)throw new AppError('该任务当前不可复核');
      const record=gate.progress[sid]?.[lid]?.[tid];
      if(!record?.evidence)throw new AppError('没有可复核的学生作答');
      if(record.status==='checking')throw new AppError('任务仍在核验，请等待完成');
      if(!body.reason?.trim())throw new AppError('教师复核必须填写依据');
      const rate=Number(body.correctRate),threshold=Number(String(task.threshold || '100').replace('%',''));
      if(!Number.isFinite(rate)||rate<0||rate>100)throw new AppError('请填写0至100的正确率');
      if(body.passed&&task.type==='exercise'&&rate<threshold)throw new AppError('正确率未达锁定门槛，不能确认通过');
      if(body.passed&&task.type!=='exercise'&&rate<100)throw new AppError('知识点及操作标准必须全部达标，不能将未达标项标记通过');
      const verdict={status:body.passed?'passed':'failed',correctRate:rate,feedback:body.reason,method:'teacher',updatedAt:now()};
      Object.assign(record,verdict);delete record.requestId;record.history ||= [];record.history.push({...verdict,evidence:record.evidence,at:now()});
      state.sessionId='';state.courseId='';
    });
  }
  close(){this.db.close();}
}
