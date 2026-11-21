// Shared pure business rules. No browser, filesystem, or AI side effects.
export const sessionFields = ['scores', 'pdf', 'knowledge', 'wrongbook', 'feedbacks', 'scoring', 'corrections', 'followups', 'confirmations', 'revisions', 'materialIds'];
export const clone = value => structuredClone(value);
export const sessionKey = lesson => [lesson.gradeId, lesson.year, lesson.term, lesson.lessonNo].map(x => encodeURIComponent(String(x || ''))).join('|');
export const courseKey = lesson => [lesson.gradeId, lesson.year, lesson.term].map(x => encodeURIComponent(String(x || ''))).join('|');
export function stableId(value) {
  let a = 2166136261, b = 5381;
  for (const char of String(value)) { a = Math.imul(a ^ char.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ char.charCodeAt(0); }
  return 'id-' + (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
}
export const fingerprint = value => stableId(JSON.stringify(value));
export function emptyGate() { return {mode:'admin', sources:[], draftSource:'', plan:{lessons:[],locked:false,version:0},studentName:'',progress:{},revisions:[]}; }
export function emptySession(lesson, students = []) {
  return {id:sessionKey(lesson), lesson:clone(lesson), scores:students.map(s => ({studentId:s.id,name:s.name,score:'',status:'A',homeworkWrong:''})),
    pdf:{fileName:'',pageCount:0,pairs:[],confirmed:false},knowledge:{},wrongbook:{columns:[],rows:[],confirmed:false},feedbacks:[],
    scoring:{mode:'legacy',questions:[],grades:{},confirmed:false},corrections:[],followups:[],confirmations:{},revisions:[],materialIds:[]};
}
export function activeStudents(state, gradeId) {
  const grade = state.grades.find(g => g.id === gradeId);
  return (grade?.studentIds || []).map(id => state.students[id]).filter(s => s && !s.inactive && s.gradeId === gradeId);
}
export function syncRosterNames(state) {
  for (const grade of state.grades) {
    if (!grade.studentIds) continue;
    const roster = activeStudents(state, grade.id);
    grade.students = roster.map(s => s.name);
    grade.parentTitles = Object.fromEntries(roster.map(s => [s.name,'家长']));
  }
}
export function identifyRows(state, session) {
  const grade = state.grades.find(g => g.id === session.lesson.gradeId);
  const pool = Object.values(state.students).filter(s => s.gradeId === grade?.id || s.history?.some(h => h.gradeId === grade?.id));
  for (const [field,rows] of [['scores',session.scores],['wrongbook',session.wrongbook.rows],['feedbacks',session.feedbacks],['pdf',session.pdf.pairs]]) {
    for (const [index,row] of (rows || []).entries()) {
      if (row.studentId && state.students[row.studentId]) continue;
      const matches = pool.filter(s => s.name === (row.name || row.student) || s.names?.includes(row.name || row.student));
      if (matches.length === 1) row.studentId = matches[0].id;
      else if(row.name || row.student){
        const id=stableId(session.id+'|'+field+'|'+index+'|identity');
        state.unassigned ||= [];
        if(!state.unassigned.some(x=>x.id===id))state.unassigned.push({id,kind:'record-identity',sessionId:session.id,field,index,record:clone(row),reason:'记录中的学生无法唯一对应，等待教师选择独立档案'});
      }
    }
  }
}
export function captureSession(state) {
  if (state.schemaVersion !== 2 || !state.sessionId) return;
  const old = state.sessions[state.sessionId];
  if (!old) return;
  if (state.sessionId === sessionKey(state.lesson)) old.lesson = clone(state.lesson);
  for (const field of sessionFields) if (state[field] !== undefined) old[field] = state[field];
  identifyRows(state, old);
  if (state.courseId && state.gate) state.courses[state.courseId] = state.gate;
}
export function selectSession(state, lesson) {
  const target = clone(lesson);
  captureSession(state);
  const id = sessionKey(target), cid = courseKey(target);
  if (!state.sessions[id]) {
    const meta = {...target,questionSpec:'',answerPdfName:''};
    state.sessions[id] = emptySession(meta, activeStudents(state, target.gradeId));
  }
  state.sessionId = id;
  state.lesson = state.sessions[id].lesson;
  for (const field of sessionFields) state[field] = state.sessions[id][field];
  state.courseId = cid;
  state.gate = state.courses[cid] ||= emptyGate();
  return state.sessions[id];
}
export function migrateState(input = {}) {
  const state = clone(input);
  if (state.schemaVersion === 2) {
    state.students ||= {}; state.sessions ||= {}; state.courses ||= {}; state.unassigned ||= [];
    state.ui ||= {}; state.ai ||= {}; state.ai.key = '';
    for (const session of Object.values(state.sessions)) {
      const defaults = emptySession(session.lesson || state.lesson);
      for (const field of sessionFields) session[field] ??= defaults[field];
    }
    selectSession(state, state.lesson);
    return state;
  }
  state.grades ||= [{id:'grade-1',name:'初一',students:[],parentTitles:{}}];
  state.lesson ||= {gradeId:state.grades[0].id,year:String(new Date().getFullYear()),term:'春季',lessonNo:'1',totalLessons:16,maxScore:10,penalty:.5,pagesPerStudent:2,questionSpec:''};
  state.lesson.gradeId ||= state.grades[0].id;
  state.students = {}; state.sessions = {}; state.courses = {}; state.unassigned = [];
  for (const grade of state.grades) {
    grade.studentIds = (grade.students || []).map((name, index) => {
      const id = stableId([grade.id, name, index].join('|'));
      state.students[id] = {id,name,gradeId:grade.id,inactive:false,names:[name],history:[{gradeId:grade.id,kind:'imported'}]};
      return id;
    });
  }
  for (const [key, field] of [['scoreArchives','scores'],['pdfArchives','pdf'],['wrongbookArchives','wrongbook'],['feedbackArchives','feedbacks']]) {
    for (const archive of state[key] || []) {
      const matches = state.grades.filter(g => archive.gradeId ? g.id === archive.gradeId : g.name === archive.gradeName);
      if (matches.length !== 1 || !archive.year || !archive.term || !archive.lessonNo) {
        state.unassigned.push({id:stableId(key+JSON.stringify(archive)),kind:key,record:clone(archive),reason:'历史记录的班级或课次无法唯一对应'}); continue;
      }
      const lesson = {...state.lesson,gradeId:matches[0].id,year:archive.year,term:archive.term,lessonNo:archive.lessonNo,title:archive.title || '',questionSpec:archive.questionSpec || '',maxScore:archive.maxScore ?? state.lesson.maxScore,penalty:archive.penalty ?? state.lesson.penalty};
      const id = sessionKey(lesson), session = state.sessions[id] ||= emptySession(lesson);
      if (field === 'pdf') session.pdf = {fileName:archive.fileName,pageCount:archive.pageCount,pairs:archive.pairs || [],confirmed:archive.confirmed || false};
      else if (field === 'wrongbook') { session.wrongbook = {columns:archive.columns || [],rows:archive.rows || [],confirmed:!!archive.confirmed}; session.lesson.questionSpec=(archive.columns || []).join(','); }
      else session[field] = clone(archive[field] || []);
      identifyRows(state, session);
      const prior=session.confirmations[field];
      if(prior)session.revisions.push({id:stableId(key+JSON.stringify(prior)),type:field,at:archive.savedAt || '',reason:'多个旧版历史记录迁移',previous:clone(prior)});
      session.confirmations[field] = {version:(prior?.version || 0)+1,at:archive.savedAt || '',snapshot:clone(session[field]),meta:clone(lesson),reason:'旧版历史迁移'};
    }
  }
  const current = emptySession(state.lesson, activeStudents(state,state.lesson.gradeId));
  for (const field of sessionFields) if (state[field] !== undefined) current[field] = clone(state[field]);
  const existing = state.sessions[current.id];
  if (existing) {current.confirmations=existing.confirmations;current.revisions=[...existing.revisions,...current.revisions.filter(r=>!existing.revisions.some(x=>x.id===r.id))];}
  identifyRows(state, current);
  state.sessions[current.id] = current;
  const gate = clone(state.gate || emptyGate());
  // Split the former global plan by original class; never attribute another class's progress.
  for (const grade of state.grades) {
    const cid = courseKey({...state.lesson,gradeId:grade.id}), copy = clone(gate);
    copy.progress = {};
    for (const [key, records] of Object.entries(gate.progress || {})) {
      if (!key.startsWith(grade.id + '::')) continue;
      const name = key.slice(grade.id.length + 2);
      const matches = Object.values(state.students).filter(s => s.gradeId === grade.id && s.name === name);
      if (matches.length === 1) copy.progress[matches[0].id] = records;
      else state.unassigned.push({id:stableId('gate'+key),kind:'gate-progress',record:{key,records},reason:'关卡学生无法唯一对应'});
    }
    if (copy.plan.locked && !copy.plan.sources) copy.plan.sources = clone(copy.sources);
    copy.revisions ||= []; state.courses[cid] = copy;
  }
  // Legacy answer drafts are copied by class+student without guessing duplicate names.
  state.ui ||= {}; state.ui.answerDrafts ||= {};
  for(const [key,old]of Object.entries(state.ui.answerDrafts)){
    const matches=Object.values(state.students).filter(s=>key===s.gradeId+'::'+s.name);
    if(matches.length===1){const student=matches[0],cid=courseKey({...state.lesson,gradeId:student.gradeId});state.ui.answerDrafts[cid+'|'+student.id]=clone(old);}
    else if(matches.length>1)state.unassigned.push({id:stableId('answer-draft'+key),kind:'gate-draft',record:{key,draft:clone(old)},reason:'同名学生的作答草稿需教师确认归属'});
  }
  for(const [key,records]of Object.entries(gate.progress || {}))if(!state.grades.some(g=>key.startsWith(g.id+'::')))state.unassigned.push({id:stableId('gate-unknown'+key),kind:'gate-progress',record:{key,records:clone(records)},reason:'原关卡记录的班级无法确定'});
  state.schemaVersion = 2; state.sessionId = ''; state.courseId = '';
  state.ai ||= {}; state.ai.key = ''; state.ui ||= {};
  state.migration = {version:2,at:new Date().toISOString(),legacyPreserved:true};
  selectSession(state, state.lesson);
  return state;
}
export function sourceVersion(session) {
  return fingerprint({scores:session.confirmations.scores || null,wrongbook:session.confirmations.wrongbook || null,knowledge:session.confirmations.knowledge || null,scoring:session.confirmations.scoring || null});
}

export function assessmentReviewSource(session) {
  const { scores, knowledge, pdf } = session.confirmations || {};
  return fingerprint({ questionSpec: session.lesson?.questionSpec || "", materialId: session.pdf?.materialId || "",
    scores: scores?.version || 0, knowledge: knowledge?.version || 0, pdf: pdf?.version || 0 });
}

// Compare teaching facts, not previews, AI candidates or a student's display name.
export function confirmationCurrent(session,type) {
  const confirmation=session.confirmations?.[type];if(!confirmation)return false;
  if(type==='wrongbook'&&confirmation.assessmentSource&&confirmation.assessmentSource!==assessmentReviewSource(session))return false;
  const facts=value=>{
    if(type==='scores')return (value || []).map(r=>({studentId:r.studentId,score:r.score,status:r.status,homeworkWrong:r.homeworkWrong}));
    if(type==='wrongbook')return {columns:value?.columns || [],rows:(value?.rows || []).map(r=>({studentId:r.studentId,score:r.score,status:r.status,answers:r.answers,checked:r.checked}))};
    if(type==='pdf')return {materialId:value?.materialId,pageCount:value?.pageCount,pairs:(value?.pairs || []).map(p=>({studentId:p.studentId,start:p.start,end:p.end,matchMethod:p.matchMethod}))};
    return value;
  };
  if(fingerprint(facts(session[type]))!==fingerprint(facts(confirmation.snapshot)))return false;
  if(['scores','wrongbook'].includes(type)&&confirmation.meta)for(const key of ['maxScore','penalty'])if(Number(confirmation.meta[key])!==Number(session.lesson[key]))return false;
  if(type==='knowledge'&&confirmation.meta&&String(confirmation.meta.questionSpec || '')!==String(session.lesson.questionSpec || ''))return false;
  if(type==='scores'&&session.scoring?.mode==='points'){
    const a=clone(session.scoring),b=clone(session.confirmations.scoring?.snapshot || {});delete a.grades;delete b.grades;
    if(fingerprint(a)!==fingerprint(b))return false;
    for(const r of session.scores.filter(r=>r.status!=='请假')){const grade=pointsScore(session,r.studentId);if(!grade.complete||grade.errors.length||Number(r.score)!==grade.sum)return false;}
  }
  return true;
}
export function feedbackQueue(session,{studentId='',onlyMissing=true}={}) {
  const scores=new Map((session.confirmations?.scores?.snapshot || []).map(r=>[r.studentId,r]));
  const seen=new Set();
  return (session.confirmations?.wrongbook?.snapshot?.rows || []).filter(r=>{
    const score=scores.get(r.studentId);
    if(!r.studentId||seen.has(r.studentId)||studentId&&r.studentId!==studentId||!r.checked||!score||score.status==='请假'||score.score==null||String(score.score).trim()===''||!Number.isFinite(Number(score.score)))return false;
    seen.add(r.studentId);
    return !onlyMissing||!(session.feedbacks || []).some(f=>f.studentId===r.studentId&&f.text?.trim());
  });
}
export function feedbackReadiness(session) {
  const reasons=[];
  if(!confirmationCurrent(session,'scores'))reasons.push({view:'scores',text:'先确认本次成绩'});
  if(!confirmationCurrent(session,'wrongbook'))reasons.push({view:'wrongbook',text:'先校对并确认错题'});
  if(session.confirmations?.knowledge&&!confirmationCurrent(session,'knowledge'))reasons.push({view:'knowledge',text:'标准答案已修改，请确认新版本'});
  if(session.confirmations?.scores&&session.confirmations?.wrongbook){
    const scores=new Map(session.confirmations.scores.snapshot.map(r=>[r.studentId,r]));
    if(session.confirmations.wrongbook.snapshot.rows.some(r=>{const s=scores.get(r.studentId);return !s||String(s.score ?? '')!==String(r.score ?? '')||s.status!==r.status;} )&&!reasons.some(r=>r.view==='wrongbook'))reasons.push({view:'wrongbook',text:'成绩已更新，请同步并重新确认错题'});
  }
  return {ready:reasons.length===0,reasons};
}
export function teachingProgress(session) {
  const present=(session.scores || []).filter(r=>r.status!=='请假'),recorded=present.filter(r=>r.score!=null&&String(r.score).trim()!==''&&Number.isFinite(Number(r.score))),eligible=feedbackQueue(session,{onlyMissing:false});
  const fresh=Object.fromEntries(['knowledge','pdf','scores','wrongbook'].map(type=>[type,confirmationCurrent(session,type)]));
  const source=sourceVersion(session),feedbacks=eligible.map(r=>(session.feedbacks || []).find(f=>f.studentId===r.studentId&&f.text?.trim())).filter(Boolean);
  const stale=feedbacks.filter(f=>f.sourceVersion&&f.sourceVersion!==source),sent=feedbacks.filter(f=>f.sentAt&&(!f.sourceVersion||f.sourceVersion===source));
  const missing=eligible.length-feedbacks.length;
  const rows=session.wrongbook?.rows || [],pairs=session.pdf?.pairs || [],answers=Object.values(session.knowledge || {}).filter(q=>q.answer?.trim()).length;
  const steps=[
    {id:'knowledge',label:'标准答案',done:fresh.knowledge,detail:fresh.knowledge?'已确认':answers?'已填 '+answers+' 题 · 待确认':'上传答案 PDF 或手工填写'},
    {id:'pdf',label:'学生答卷',done:fresh.pdf&&!!session.pdf.materialId,detail:session.pdf.materialId?(fresh.pdf?'已确认 ':'待确认 ')+pairs.length+' 份':'上传学生答卷 PDF'},
    {id:'scores',label:'测评成绩',done:fresh.scores&&recorded.length>0&&recorded.length===present.length,detail:recorded.length+'/'+present.length+' 人已录入'+(fresh.scores&&recorded.length?' · 已确认':'')},
    {id:'wrongbook',label:'错题校对',done:fresh.wrongbook&&fresh.scores,detail:rows.length?rows.filter(r=>r.checked).length+'/'+rows.length+' 人已校对':'识别原答，核对错题'},
    {id:'feedback',label:'家长反馈',done:eligible.length>0&&missing===0&&!stale.length&&sent.length===eligible.length&&fresh.scores&&fresh.wrongbook,detail:missing?'待生成 '+missing+' 人':stale.length?'需更新 '+stale.length+' 人':feedbacks.length?'已发送 '+sent.length+'/'+eligible.length+' 人':'生成后复制给家长'}
  ];
  // Teachers can also finish with hand-entered records, without uploading a PDF.
  let next=steps.find(s=>!s.done) || steps.at(-1);
  if(fresh.scores&&fresh.wrongbook&&eligible.length)next=feedbackReadiness(session).ready?steps.at(-1):steps.find(s=>s.id===feedbackReadiness(session).reasons[0].view);
  return {steps,next,recorded:recorded.length,present:present.length,eligible:eligible.length,missing,stale:stale.length,sent:sent.length,fresh};
}
export function plainFeedback(text) {
  return String(text).replace(/\\[()[\]]/g,'').replace(/\\(?:text|mathrm)\{([^{}]*)\}/g,'$1').replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g,'($1)/($2)').replace(/\\(?:times|cdot)\b/g,'×').replace(/\\div\b/g,'÷').replace(/\^2\b/g,'²').replace(/\^3\b/g,'³');
}
export function samePaperAnswer(first, second) {
  const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').trim();
  const a = normalize(first);
  const b = normalize(second);
  if (!a || !b) return false;
  const choice = /^[a-h](?:[,、]?[a-h])*$/i;
  if (choice.test(a) && choice.test(b)) {
    const sorted = value => [...new Set(value.toUpperCase().replace(/[,、]/g, ''))].sort().join('');
    return sorted(a) === sorted(b);
  }
  return a === b;
}

export const feedbackMethods = Object.freeze({
  条件: '先圈出题目给出的条件，说清用了哪条物理规律，再重新作答',
  依据: '请孩子用自己的话说出判断依据，并说明原答和正确思路的区别',
  重做: '请孩子遮住答案独立重做，再对照解析检查改对了哪一步',
});

export function composeAssessmentFeedback({name, score, maximum, wrong}, method) {
  if (!Object.hasOwn(feedbackMethods, method)) throw new Error('DeepSeek 未给出可用的复习方式');
  const lines = [name+'家长您好！本次物理课前测得分 '+score+' / '+maximum+'。'];
  if (!wrong.length) {
    lines.push('本次校对记录未登记错题。复习时，可以挑一道题请孩子说说自己的判断依据。');
    return lines.join('\n\n');
  }
  lines.push(wrong.map(({id,answer,standard,explanation}) =>
    plainFeedback('第'+id+'题，孩子原答 '+answer+'。'+(standard?'参考答案 '+standard+'。':'')+
      (explanation?'复习时可参考这条解析。'+explanation:''))).join('\n'));
  const questions = wrong.map(q=>'第'+q.id+'题').join('、');
  lines.push('回家可以先复习'+questions+'，'+feedbackMethods[method]+'。下次课前可再抽一道核对。');
  return lines.join('\n\n');
}
export function validateScoring(session) {
  const config = session.scoring, errors = [];
  if (config.mode !== 'points') return errors;
  if (!config.questions.length) errors.push('至少添加一道题目');
  const seen = new Set();
  for (const q of config.questions) {
    if (!q.id || seen.has(q.id)) errors.push('题号缺失或重复：' + (q.id || '未填写'));
    seen.add(q.id);
    if (!Number.isFinite(Number(q.points)) || Number(q.points) <= 0) errors.push('第'+q.id+'题分值须大于0');
    if (q.steps?.length) {
      if (q.steps.some(s => !s.label?.trim() || !Number.isFinite(Number(s.points)) || Number(s.points) <= 0)) errors.push('第'+q.id+'题步骤须有标准和有效分值');
      if (Math.abs(q.steps.reduce((n,s)=>n+Number(s.points),0)-Number(q.points))>.001) errors.push('第'+q.id+'题步骤分合计不等于题目分值');
    }
  }
  if (Math.abs(config.questions.reduce((n,q)=>n+Number(q.points),0)-Number(session.lesson.maxScore))>.001) errors.push('题目分值合计必须等于试卷满分');
  return errors;
}
export function pointsScore(session, studentId) {
  const values = session.scoring.grades?.[studentId] || {};
  let sum=0, complete=true; const errors=[];
  for(const q of session.scoring.questions) {
    const parts=q.steps?.length?q.steps.map((s,i)=>({key:q.id+'::'+i,points:s.points})): [{key:q.id,points:q.points}];
    for(const part of parts) {
      const raw=values[part.key];
      if(raw===undefined || raw==='') {complete=false;continue;}
      const n=Number(raw);
      if(!Number.isFinite(n)||n<0||n>Number(part.points)) errors.push('第'+q.id+'题得分超出范围');
      else sum+=n;
    }
  }
  return {sum:Math.round(sum*100)/100,complete,errors};
}
export function gatePassed(lesson, records={}) { return lesson.skipLock || (lesson.tasks?.length>0 && lesson.tasks.every(t=>records[lesson.id]?.[t.id]?.status==='passed')); }
export function currentGateLesson(gate, studentId) { return gate.plan.lessons.find(l=>!gatePassed(l,gate.progress[studentId] || {})); }
export function blockedMessage(lesson, records={}) {
  const names = lesson.tasks.filter(t=>records[lesson.id]?.[t.id]?.status!=='passed').map(t=>t.type==='exercise'?(t.source+' '+t.question):(t.label || '未命名任务'));
  return '本节课过关任务尚未完成，还差：'+names.join('；')+'。请完成全部要求后再继续，无法直接进入下一课。';
}
export function taskSignature(task,sources=[]) {
  const relevant=sources.filter(s=>String(task.source || '').includes(s.name) || s.id===task.materialId);
  return fingerprint({...task,sources:relevant.map(s=>[s.id,s.name,s.content])});
}
export function validateGate(plan,sources=[]) {
  const errors=[],lessonIds=new Set();
  if(!plan.lessons?.length) return ['至少添加一节课'];
  for(const [i,l]of plan.lessons.entries()){
    const prefix='第'+(i+1)+'节';
    if(!l.id||lessonIds.has(l.id))errors.push(prefix+'课程编号缺失或重复');lessonIds.add(l.id);
    if(!l.title?.trim())errors.push(prefix+'缺少课程名称');
    if(l.skipLock)continue;
    const required=Number(l.exerciseMinimum ?? 3);
    if(!Number.isInteger(required)||required<0)errors.push(prefix+'习题数量要求无效');
    if(required<3&&!l.countReason?.trim())errors.push(prefix+'减少习题数量需要教师填写原因');
    if(!l.tasks?.some(t=>t.type==='knowledge'))errors.push(prefix+'至少需要一个知识点');
    if((l.tasks || []).filter(t=>t.type==='exercise').length<required)errors.push(prefix+'习题不足'+required+'道');
    const taskIds=new Set();
    for(const [j,t]of (l.tasks || []).entries()){
      const at=prefix+'第'+(j+1)+'项';
      if(!t.id||taskIds.has(t.id))errors.push(at+'任务编号缺失或重复');taskIds.add(t.id);
      if(!sources.some(s=>s.name?.trim()&&s.content?.trim()&&(t.materialId===s.id || String(t.source || '').includes(s.name))))errors.push(at+'资料来源无法定位');
      if(t.type==='exercise'){
        if(!t.question || !t.questionType)errors.push(at+'缺少题号或题型');
        const n=Number(String(t.threshold).replace('%',''));
        if(!Number.isFinite(n)||n<=0||n>100)errors.push(at+'正确率门槛须为0到100之间的百分数');
      }else if(!t.label?.trim() || !t.standard?.trim() || /^(理解|了解|掌握)[^，。；]*$/.test(t.standard.trim()))errors.push(at+'需要具体可检验的掌握标准');
    }
  }
  return errors;
}
export function reconcileGate(oldPlan,nextPlan,progress={}) {
  const result={};
  for(const [sid,records]of Object.entries(progress)){
    result[sid]={};
    for(const l of nextPlan.lessons){
      const old=oldPlan.lessons.find(x=>x.id===l.id);
      if(!old || old.skipLock!==l.skipLock)continue;
      result[sid][l.id]={};
      for(const t of l.tasks){
        const prior=old.tasks.find(x=>x.id===t.id), record=records[l.id]?.[t.id];
        if(prior&&record&&record.status!=='checking'&&taskSignature(prior,oldPlan.sources)===taskSignature(t,nextPlan.sources))result[sid][l.id][t.id]=clone(record);
      }
    }
  }
  return result;
}
export function objectiveVerdict(task,evidence) {
  if(task.type!=='exercise'||!task.expectedAnswer?.trim() || !task.answerConfirmed || !/选择|填空|判断|数值/.test(task.questionType || ''))return null;
  const clean=s=>String(s).normalize('NFKC').trim().replace(/\s+/g,'').replace(/[。.]$/,'').toUpperCase();
  const answers=String(task.expectedAnswer).split('|').map(clean);
  const submitted=clean(evidence);
  if(answers.includes(submitted))return {status:'passed',correctRate:100,feedback:'与教师确认的标准答案一致。',method:'exact'};
  if(submitted.length>80 || /[。；;：:\n]/.test(evidence))return null;
  return {status:'failed',correctRate:0,feedback:'与教师确认的标准答案不符，请订正后重新提交。',method:'exact'};
}
