import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../shared/domain.mjs';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
function lesson(){
  const s=D.emptySession({gradeId:'test',year:2026,term:'秋季',lessonNo:1,maxScore:10,penalty:.5,questionSpec:'1'});
  s.scores=['a','b','absent','blank','zero'].map((id,i)=>({studentId:id,name:id,score:['9','10','','','0'][i],status:id==='absent'?'请假':'A',homeworkWrong:''}));
  s.wrongbook={columns:['1'],rows:s.scores.map(r=>({...r,checked:true,answers:{1:r.score==='9'?'B':''}})),confirmed:true};
  s.knowledge={1:{answer:'A'}};
  for(const type of ['scores','wrongbook','knowledge'])s.confirmations[type]={version:1,snapshot:D.clone(s[type]),meta:D.clone(s.lesson)};
  return s;
}
test('一键补齐反馈保留手写、已生成和已发送内容，并排除缺考及空分数',()=>{
  const s=lesson();s.feedbacks=[{studentId:'a',text:'老师手写，不能覆盖'},{studentId:'b',text:'已发送原文',sentAt:'yesterday'}];
  assert.deepEqual(D.feedbackQueue(s).map(r=>r.studentId),['zero']);
  assert.deepEqual(D.feedbackQueue(s,{studentId:'a',onlyMissing:false}).map(r=>r.studentId),['a']);
  assert.deepEqual(D.feedbackQueue(s,{studentId:'blank',onlyMissing:false}),[]);
});
test('流程显示真实完成程度：空成绩已归档也不能显示成绩全部完成',()=>{
  const s=lesson();s.scores.forEach(r=>r.score='');s.confirmations.scores.snapshot=D.clone(s.scores);
  assert.equal(D.teachingProgress(s).steps.find(x=>x.id==='scores').done,false);
  assert.equal(D.teachingProgress(s).steps.find(x=>x.id==='feedback').done,false);
});
test('修改测评事实使下一步回到确认，候选与学生改名不产生假冲突',()=>{
  const s=lesson();assert.equal(D.feedbackReadiness(s).ready,true);
  s.scores[0].name='新姓名';s.wrongbook.rows[0].candidates={1:{answer:'B'}};assert.equal(D.feedbackReadiness(s).ready,true);
  s.scores[0].score='8';assert.equal(D.feedbackReadiness(s).reasons[0].view,'scores');
  s.confirmations.scores.snapshot=D.clone(s.scores);assert.ok(D.feedbackReadiness(s).reasons.some(r=>r.view==='wrongbook'));
});
test('已发送反馈在来源修订后仍显示需更新，不误报流程全部完成',()=>{
  const s=lesson();s.scores=s.scores.filter(r=>r.studentId==='a');s.wrongbook.rows=s.wrongbook.rows.filter(r=>r.studentId==='a');
  for(const type of ['scores','wrongbook'])s.confirmations[type].snapshot=D.clone(s[type]);
  s.feedbacks=[{studentId:'a',text:'家长您好',sentAt:'today',sourceVersion:D.sourceVersion(s)}];
  assert.equal(D.teachingProgress(s).steps.at(-1).done,true);
  s.confirmations.knowledge.version++;assert.equal(D.teachingProgress(s).stale,1);assert.equal(D.teachingProgress(s).steps.at(-1).done,false);
  assert.equal(D.feedbackQueue(s).length,0,'来源改动也不能静默覆盖已发文字');
});
test('分卷预览不会把人工确认变成过期，但更换原件或学生会',()=>{
  const s=lesson();s.pdf={materialId:'paper1',pageCount:1,pairs:[{studentId:'a',start:0,end:0,matchMethod:'manual',previews:[]}],confirmed:true};s.confirmations.pdf={snapshot:D.clone(s.pdf)};
  s.pdf.pairs[0].previews=['new thumbnail'];assert.equal(D.confirmationCurrent(s,'pdf'),true);
  s.pdf.pairs[0].studentId='b';assert.equal(D.confirmationCurrent(s,'pdf'),false);
});
test('整班卷头识别：第一人的AI姓名建议不会中断后续页，教师改匹配则应失效',()=>{
  const s=lesson();s.pdf={materialId:'paper1',pageCount:2,pairs:[0,1].map(i=>({studentId:'',start:i,end:i,matchMethod:'suggested'}))};
  const context={Domain:D,v2Session:()=>s};runInNewContext(readFileSync(new URL('../client/lifecycle-materials.js',import.meta.url),'utf8'),context);
  const version=context.v2BatchVersion('headers',s);s.pdf.pairs[0].studentId='a';s.pdf.pairs[0].scoreCandidate='9';assert.equal(context.v2BatchVersion('headers',s),version);
  s.pdf.pairs[0].matchMethod='manual';assert.notEqual(context.v2BatchVersion('headers',s),version);
});
test('重新同步修改后的成绩与新增题列，仅保留有效校对，错题原答不丢失',()=>{
  const s=lesson(),state={wrongbook:s.wrongbook,scores:s.scores},context={Domain:D,state,v2Session:()=>s,v2Name:(id,name)=>name};
  runInNewContext(readFileSync(new URL('../client/lifecycle-materials.js',import.meta.url),'utf8'),context);
  s.confirmations.scores.snapshot[0].score='8';context.syncWrongbookRows(['1']);assert.equal(state.wrongbook.rows[0].checked,false);assert.equal(state.wrongbook.rows[1].checked,true);assert.equal(state.wrongbook.rows[0].answers[1],'B');
  context.syncWrongbookRows(['1','2']);assert.ok(state.wrongbook.rows.every(r=>!r.checked));
});
