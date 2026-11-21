import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as D from '../shared/domain.mjs';
import {Store} from '../server/store.mjs';
import {TaskEngine} from '../server/tasks.mjs';
test('已确认错题与分数按学生档案进入反馈正文',()=>{
  const text=D.composeAssessmentFeedback({name:'周小北',score:'9.5',maximum:10,
    wrong:[{id:'3',answer:'D',standard:'C',explanation:'惯性大小只与质量有关。'}]},'依据');
  assert.match(text,/周小北家长您好.*9\.5 \/ 10/);
  assert.match(text,/第3题，孩子原答 D。参考答案 C/);
  assert.equal(D.samePaperAnswer('Ｃ、Ａ','AC'),true);
  assert.equal(D.samePaperAnswer('D','C'),false);
});
test('模型返回最后一页时，批量识别仍等待页面保存',async t=>{
  const store=database(t);
  const job=store.newJob({kind:'headers',total:1,plan:{items:[{key:'header-0'}],options:{}}});
  const engine=new TaskEngine(store,async()=>({choices:[{message:{content:'{}'}}]}));
  await engine.request({jobId:job.id,itemKey:'header-0',payload:{messages:[{role:'user',content:'读卷头'}]}});
  assert.equal(store.getJob(job.id).completed,1);
  assert.equal(store.getJob(job.id).status,'running');
});
function fixture(){return D.migrateState({grades:[{id:'g1',name:'初一A',students:['小明','同名','同名']},{id:'g2',name:'初一B',students:['小明']}],lesson:{gradeId:'g1',year:'2026',term:'春季',lessonNo:'1',maxScore:10,penalty:.5,pagesPerStudent:1,totalLessons:16},scores:[{name:'小明',score:'8',status:'A'}],wrongbook:{rows:[{name:'小明',score:'8',answers:{1:'B'},checked:false}],columns:['1'],confirmed:false},feedbacks:[],knowledge:{1:{answer:'A'}},gate:{sources:[],plan:{lessons:[],locked:false,version:0},progress:{'g1::小明':{l:{t:{status:'passed'}}}}}});}
function database(t){const dir=mkdtempSync(join(tmpdir(),'physics-test-')),store=new Store(dir);store.importState(fixture(),store.get().revision);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}
function edit(store,fn){const d=store.get();fn(d.state);return store.save(d.state,d.revision);}
function planFixture(){const sources=[{id:'source',name:'讲义A',content:'第1页：力的单位是N。选择题1答案A，2答案B，3答案C。'}];const lessons=[1,2].map(i=>({id:'l'+i,title:'第'+i+'节 力',exerciseMinimum:1,countReason:'教师确认只检验一道综合选择题',tasks:[{id:'k'+i,type:'knowledge',label:'力的单位',standard:'能复述力的单位是牛顿',source:'讲义A 第1页'},{id:'e'+i,type:'exercise',question:'1',questionType:'选择',source:'讲义A 第1页',threshold:'100%',expectedAnswer:'A',answerConfirmed:true}]}));return {sources,plan:{lessons,locked:false,version:0}};}
test('迁移可重复且不丢当前课次、固定学生ID和关卡进度',()=>{
  const a=fixture(),b=D.migrateState(a),sid=a.grades[0].studentIds[0];assert.equal(Object.keys(a.students).length,4);assert.deepEqual(Object.keys(a.students),Object.keys(b.students));assert.equal(a.scores[0].studentId,sid);assert.equal(a.gate.progress[sid].l.t.status,'passed');assert.notEqual(a.grades[0].studentIds[1],a.grades[0].studentIds[2]);
});
test('多班级、多学期、多课次往返保存完整草稿且不串错题',()=>{
  const s=fixture(),original=D.clone(s.lesson);s.pdf.materialId='raw';s.feedbacks.push({text:'初稿'});s.scores[0].score='9';
  for(const lesson of [{...original,lessonNo:'2'},{...original,term:'秋季'},{...original,gradeId:'g2'},{...original,year:'2027'}]){D.selectSession(s,lesson);assert.equal(s.scores[0].score,'');assert.equal(s.wrongbook.rows.length,0);s.scores[0].score='1';}
  D.selectSession(s,original);assert.equal(s.scores[0].score,'9');assert.equal(s.pdf.materialId,'raw');assert.equal(s.feedbacks[0].text,'初稿');assert.equal(s.wrongbook.rows[0].score,'8');
});
test('CAS拒绝缺失版本和旧版本；写盘异常不会假成功',t=>{
  const st=database(t),a=st.get(),b=st.get();a.state.scores[0].score='7';st.save(a.state,a.revision);assert.throws(()=>st.save(b.state,b.revision),e=>e.status===409);assert.throws(()=>st.save(b.state),e=>e.status===428);
  const latest=st.get(),prior=st.dailyBackup;st.dailyBackup=()=>{throw new Error('模拟磁盘满');};assert.throws(()=>st.save(latest.state,latest.revision),/磁盘满/);assert.equal(st.get().revision,latest.revision);st.dailyBackup=prior;
});
test('学生改名转班停读与恢复不改变已确认历史身份',t=>{
  const st=database(t),sid=st.get().state.scores[0].studentId;st.confirmSession(st.get().state.sessionId,'scores','首次',st.get().revision);st.updateStudent(sid,'rename',{name:'小明新名'},st.get().revision);assert.equal(st.get().state.scores[0].name,'小明新名');assert.equal(st.get().state.confirmations.scores.snapshot[0].name,'小明');
  st.updateStudent(sid,'transfer',{gradeId:'g2',reason:'教师转班'},st.get().revision);assert.equal(st.get().state.students[sid].gradeId,'g2');st.updateStudent(sid,'inactive',{inactive:true},st.get().revision);assert.equal(st.get().state.students[sid].inactive,true);st.updateStudent(sid,'inactive',{inactive:false},st.get().revision);assert.equal(st.get().state.students[sid].inactive,false);
});
test('确认后的成绩允许修订但需原因，原版本可追溯',t=>{
  const st=database(t),id=st.get().state.sessionId;st.confirmSession(id,'scores','首次',st.get().revision);edit(st,s=>s.scores[0].score='9');assert.throws(()=>st.confirmSession(id,'scores','',st.get().revision),/原因/);st.confirmSession(id,'scores','更正录入',st.get().revision);assert.equal(st.get().state.confirmations.scores.snapshot[0].score,'9');assert.equal(st.get().state.revisions[0].previous.snapshot[0].score,'8');
});
test('每题、步骤分验证满分合计、范围和确认评分标准',t=>{
  const st=database(t),id=st.get().state.sessionId,sid=st.get().state.scores[0].studentId;
  edit(st,s=>{s.scoring={mode:'points',confirmed:false,questions:[{id:'1',points:4,steps:[]},{id:'2',points:6,steps:[{label:'公式',points:2},{label:'计算',points:4}]}],grades:{[sid]:{'1':'3','2::0':'2','2::1':'3'}}};});
  assert.throws(()=>st.confirmSession(id,'scores','首次',st.get().revision),/评分标准/);st.confirmSession(id,'scoring','教师确认',st.get().revision);st.confirmSession(id,'scores','步骤给分',st.get().revision);assert.equal(st.get().state.scores[0].score,'8');
  edit(st,s=>s.scoring.grades[sid]['2::1']='5');assert.throws(()=>st.confirmSession(id,'scores','异常分数',st.get().revision),/超范围/);
});
test('原文件hash去重，完整备份恢复且损坏备份拒绝',t=>{
  const st=database(t),bytes=Buffer.from('%PDF-1.7\nfixture\n%%EOF'),a=st.addMaterial(bytes,{name:'卷.pdf',type:'application/pdf'}),b=st.addMaterial(bytes,{name:'卷.pdf',type:'application/pdf'});assert.equal(a.id,b.id);assert.equal(readFileSync(st.materialFile(a.id).path).toString(),bytes.toString());
  const backup=st.createBackup('manual',true);edit(st,s=>s.scores[0].score='2');st.restoreBackup(backup.id,st.get().revision);assert.equal(st.get().state.scores[0].score,'8');
  const file=join(st.backupDir,backup.id,'workbench.sqlite');writeFileSync(file,'corrupt');assert.throws(()=>st.inspectBackup(backup.id),/校验失败/);
});
test('资料类型和空文件拒绝；原卷必须人工匹配、覆盖全部页码',t=>{
  const st=database(t);assert.throws(()=>st.addMaterial(Buffer.from('secret'),{name:'x.html'}),/格式/);assert.throws(()=>st.addMaterial(Buffer.from('bad'),{name:'x.pdf'}),/PDF/);
  const m=st.addMaterial(Buffer.from('%PDF-1.7 fixture'),{name:'卷.pdf'}),sid=st.get().state.scores[0].studentId,id=st.get().state.sessionId;
  edit(st,s=>{s.pdf={materialId:m.id,pageCount:2,pairs:[{start:0,end:0,studentId:sid,matchMethod:'suggested'}],confirmed:false};});
  assert.throws(()=>st.confirmSession(id,'pdf','',st.get().revision),/逐份确认/);edit(st,s=>s.pdf.pairs[0].matchMethod='manual');assert.throws(()=>st.confirmSession(id,'pdf','',st.get().revision),/未分配/);edit(st,s=>s.pdf.pairs[0].end=1);st.confirmSession(id,'pdf','',st.get().revision);assert.equal(st.get().state.pdf.confirmed,true);
});
test('教师可明确减题；来源缺失与模糊标准不能锁定',()=>{
  const p=planFixture();assert.deepEqual(D.validateGate(p.plan,p.sources),[]);p.plan.lessons[0].countReason='';assert.match(D.validateGate(p.plan,p.sources).join(''),/原因/);p.plan.lessons[0].tasks[0].source='不存在';assert.match(D.validateGate(p.plan,p.sources).join(''),/来源/);
});
test('重复任务编号不能借用一次通过解锁多项',()=>{
  const p=planFixture();p.plan.lessons[0].tasks[1].id=p.plan.lessons[0].tasks[0].id;assert.match(D.validateGate(p.plan,p.sources).join(''),/任务编号缺失或重复/);
});
test('家长反馈公式转换为可复制纯文本，不改数值',()=>{
  assert.equal(D.plainFeedback(String.raw`\(a=\frac{F}{m}=4\text{ m/s}^2\)`),'a=(F)/(m)=4 m/s²');
});
test('每个PDF解析入口禁用动态代码执行',()=>{
  for(const file of ['app.js','gate.js','gate-workbench.js','client/lifecycle-materials.js'])for(const line of readFileSync(file,'utf8').split('\n').filter(l=>l.includes('pdfjsLib.getDocument(')))assert.ok(line.includes('isEvalSupported:false'),file);
});
test('尚未提交的旧学生草稿迁移；同课旧版本保留',()=>{
  const legacy={grades:[{id:'g',name:'班',students:['甲']}],lesson:{gradeId:'g',year:'2026',term:'春季',lessonNo:'1',maxScore:10,penalty:.5},scores:[{name:'甲',score:'9'}],scoreArchives:[7,8].map(score=>({gradeId:'g',year:'2026',term:'春季',lessonNo:'1',scores:[{name:'甲',score:String(score)}]})),ui:{answerDrafts:{'g::甲':{'l::t':'未提交中文答案'}}}};
  const s=D.migrateState(legacy),sid=s.grades[0].studentIds[0];assert.equal(s.ui.answerDrafts[s.courseId+'|'+sid]['l::t'],'未提交中文答案');assert.equal(s.scores[0].score,'9');assert.equal(s.confirmations.scores.snapshot[0].score,'8');assert.equal(s.revisions[0].previous.snapshot[0].score,'7');
});
test('课程参数修订要求原因并留存原测满分',t=>{
  const st=database(t),id=st.get().state.sessionId;st.confirmSession(id,'scores','首次',st.get().revision);edit(st,s=>s.lesson.maxScore=20);assert.throws(()=>st.confirmSession(id,'scores','',st.get().revision),/原因/);st.confirmSession(id,'scores','调整满分录入错误',st.get().revision);assert.equal(st.get().state.revisions.at(-1).previous.meta.maxScore,10);
});
test('无效模型结构标记后可重新请求而不反复复用坏缓存',async t=>{
  const st=database(t);let calls=0;const engine=new TaskEngine(st,async()=>({choices:[{message:{content:++calls===1?'invalid':'{"answers":[]}'}}]}));const job=st.newJob({total:1}),body={jobId:job.id,itemKey:'page1',payload:{messages:[{role:'user',content:'extract'}]}};
  await engine.request(body);const bad=st.getJob(job.id);bad.items[0].status='failed';bad.items[0].needsFresh=true;st.putJob(bad);const result=await engine.request(body);assert.equal(calls,2);assert.equal(result.choices[0].message.content,'{"answers":[]}');
});
test('服务器阻止越课，疑难待复核，错答订正和全部通过解锁',async t=>{
  const st=database(t),{plan,sources}=planFixture(),cid=st.get().state.courseId,sid=st.get().state.scores[0].studentId;st.lockGate(cid,plan,sources,'首次',st.get().revision);
  const engine=new TaskEngine(st,async()=>({choices:[{message:{content:'{"result":"pass","correctRate":100,"reason":"需教师确认口头说明"}'}}]}));
  const verify=(lid,tid,evidence)=>engine.verifyGate({courseId:cid,studentId:sid,lessonId:lid,taskId:tid,evidence,expectedRevision:st.get().revision});
  await assert.rejects(verify('l2','e2','A'),/本节课过关任务尚未完成/);
  await verify('l1','e1','B');assert.equal(st.get().state.gate.progress[sid].l1.e1.status,'failed');
  await verify('l1','e1','A');assert.equal(st.get().state.gate.progress[sid].l1.e1.status,'passed');
  await verify('l1','k1','单位是牛顿');assert.equal(st.get().state.gate.progress[sid].l1.k1.status,'review');assert.equal(D.currentGateLesson(st.get().state.gate,sid).id,'l1');
  st.reviewGate(cid,sid,'l1','k1',{reason:'教师听取复述并核对原讲义',correctRate:100,passed:true},st.get().revision);assert.equal(D.currentGateLesson(st.get().state.gate,sid).id,'l2');
  const before=st.get();before.state.gate.progress[sid].l2={e2:{status:'passed'},k2:{status:'passed'}};st.save(before.state,before.revision);assert.equal(st.get().state.gate.progress[sid].l2,undefined);
});
test('标准修订保留未改动任务；迟到核验结果不能写入新版',t=>{
  const st=database(t),{plan,sources}=planFixture(),cid=st.get().state.courseId,sid=st.get().state.scores[0].studentId;st.lockGate(cid,plan,sources,'首次',st.get().revision);
  const a=st.beginGate(cid,sid,'l1','e1','A','request-1',st.get().revision);assert.throws(()=>st.beginGate(cid,sid,'l1','e1','A','request-2',st.get().revision),/重复/);
  const revised=D.clone(st.get().state.gate.plan);revised.lessons[0].tasks[1].expectedAnswer='B';st.lockGate(cid,revised,sources,'更正标准答案',st.get().revision);
  const done=st.finishGate(cid,sid,'l1','e1','request-1',a.result.signature,{status:'passed'});assert.equal(done.result.stale,true);assert.notEqual(st.get().state.gate.progress[sid]?.l1?.e1?.status,'passed');assert.equal(st.get().state.gate.revisions.length,1);
});
test('任务串行、重复请求去重、复用缓存、部分失败成果保留',async t=>{
  const st=database(t);let inflight=0,max=0,calls=0;
  const engine=new TaskEngine(st,async payload=>{calls++;inflight++;max=Math.max(max,inflight);await new Promise(r=>setTimeout(r,10));inflight--;if(payload.messages[0].content==='fail')throw new Error('模拟模型失败');return {choices:[{message:{content:'OK'}}],usage:{total_tokens:5}};});
  const job=st.newJob({total:3}),request=(key,content)=>engine.request({jobId:job.id,itemKey:key,payload:{messages:[{role:'user',content}]}});
  await Promise.all([request('a','one'),request('a','one'),request('b','two')]);assert.equal(max,1);assert.equal(calls,2);await assert.rejects(request('c','fail'));assert.equal(st.getJob(job.id).items.filter(i=>i.status==='done').length,2);await request('c','one');assert.equal(calls,3);assert.equal(st.getJob(job.id).items.find(i=>i.key==='c').cacheHit,true);
});
test('取消任务不写迟到结果、未知用量不伪造',async t=>{
  const st=database(t),job=st.newJob({total:1});let done;
  const engine=new TaskEngine(st,()=>new Promise(r=>done=r)),run=engine.request({jobId:job.id,payload:{messages:[{role:'user',content:'x'}]}});
  await new Promise(r=>setImmediate(r));engine.cancel(job.id);done({choices:[{message:{content:'late'}}]});await assert.rejects(run,/取消/);assert.equal(st.getJob(job.id).status,'cancelled');assert.equal(st.getJob(job.id).usage,null);
});
test('恢复备份保留任务历史并拒绝恢复前迟到结果',async t=>{
  const st=database(t),job=st.newJob({total:1});let done;const engine=new TaskEngine(st,()=>new Promise(r=>done=r));const backup=st.createBackup('manual',true),run=engine.request({jobId:job.id,payload:{messages:[{role:'user',content:'old'}]}});await new Promise(r=>setImmediate(r));engine.invalidate();st.restoreBackup(backup.id,st.get().revision);done({choices:[{message:{content:'stale'}}]});await assert.rejects(run,/旧任务/);assert.equal(st.getJob(job.id).items.length,0);
});
test('60人30题跨学期数据可以事务保存和恢复',t=>{
  const st=database(t);edit(st,s=>{const g=s.grades[0];for(let i=0;i<60;i++){const id='stress-'+i;s.students[id]={id,name:'测试'+i,gradeId:g.id,inactive:false,names:[],history:[]};g.studentIds.push(id);}D.syncRosterNames(s);D.selectSession(s,{...s.lesson,term:'秋季'});s.lesson.questionSpec=Array.from({length:30},(_,i)=>i+1).join(',');s.scores.forEach(r=>r.score='8');s.wrongbook={columns:Array.from({length:30},(_,i)=>String(i+1)),rows:s.scores.map(r=>({...r,answers:Object.fromEntries(Array.from({length:30},(_,i)=>[i+1,'A'])),checked:false})),confirmed:false};});
  const a=st.get();assert.ok(a.state.scores.length>=60);assert.equal(a.state.wrongbook.columns.length,30);assert.equal(D.migrateState(a.state).wrongbook.rows.length,a.state.scores.length);
});
