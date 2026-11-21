// Server-authoritative course plans and evidence review.
const gatesOriginal={gateAdminView,gateLessonEditorView,gateTaskEditorView,gateGenerationPrompt,gateNormalizePlan};
function gateAdminView(){
  const base=gatesOriginal.gateAdminView();
  return base+v2Card('本班课程与复核','<p class="hint">当前课程计划属于 '+escapeHtml(currentGrade().name+' · '+state.lesson.year+state.lesson.term)+'。复制只复制任务与资料，不复制学生进度。</p><button class="secondary" data-gate-copy-course>复制计划到其他班级 / 学期</button>'+v2GateReviewList());
}
function gateLessonEditorView(lesson,index){
  const text='<div class="v2-fields"><label>本节最低习题数量<input data-gate-minimum="'+lesson.id+'" type="number" min="0" value="'+(lesson.exerciseMinimum ?? 3)+'"></label><label>教师调整数量的原因<input data-gate-count-reason="'+lesson.id+'" value="'+escapeAttr(lesson.countReason || '')+'" placeholder="少于3道时必填"></label></div>';
  return gatesOriginal.gateLessonEditorView(lesson,index).replace('每节至少 1 个知识点、3 道习题才可锁定。','默认每节至少3道习题；教师可明确调整数量并记录原因。').replace('<div class="gate-task-list">',text+'<div class="gate-task-list">');
}
function gateTaskEditorView(lid,task,index){
  const base=gatesOriginal.gateTaskEditorView(lid,task,index);
  const fields=task.type==='exercise'?'<div class="v2-fields"><label>明确答案（多个等价写法用 | 分隔）<input data-gate-task-field="expectedAnswer" data-gate-lesson-id="'+lid+'" data-gate-task-id="'+task.id+'" value="'+escapeAttr(task.expectedAnswer || '')+'"></label><label class="gate-check"><input type="checkbox" data-gate-answer-confirm="'+task.id+'" data-gate-lesson-id="'+lid+'" '+(task.answerConfirmed?'checked':'')+'>教师已核对标准答案</label></div><p class="hint">仅选择、填空、判断、数值类明确答案自动核验。过程题、模糊表达与证据不足转教师复核，待复核不能通关。</p>':'';
  return base.replace('</article>',fields+'</article>');
}
function v2GateReviewList(){
  const gate=state.gate,items=[];
  for(const [sid,lessons]of Object.entries(gate.progress))for(const [lid,records]of Object.entries(lessons))for(const [tid,r]of Object.entries(records))if(r.status==='review'||r.status==='pending'&&r.evidence)items.push({sid,lid,tid,r});
  return items.length?items.map(x=>'<div class="v2-review-task"><strong>'+escapeHtml(v2Name(x.sid))+'</strong><p>'+escapeHtml(gate.plan.lessons.find(l=>l.id===x.lid)?.title || '')+'</p><pre>'+escapeHtml(x.r.evidence)+'</pre><p>辅助建议：'+escapeHtml(x.r.aiFeedback || x.r.feedback)+'</p><button class="secondary" data-gate-review="'+x.tid+'" data-student="'+x.sid+'" data-lesson="'+x.lid+'">核对证据并复核</button></div>').join(''):v2Empty('当前班级没有待复核的关卡任务');
}
function gateStudentView(){
  const g=state.gate,students=Domain.activeStudents(state,currentGrade().id),sid=g.studentId,records=g.progress[sid] || {},current=Domain.currentGateLesson(g,sid),locked=g.plan.locked;
  return v2Card('学生执行','<p class="hint">教师在场切换学生。本模式隐藏管理操作，不是远程账号权限隔离。</p><label>当前学生<select data-gate-student-select><option value="">请由教师选择学生</option>'+students.map(s=>'<option value="'+s.id+'" '+(sid===s.id?'selected':'')+'>'+escapeHtml(s.name)+' · '+s.id.slice(-6)+'</option>').join('')+'</select></label>','<button class="ghost" data-gate-mode="admin">返回教师工作台</button>')+
    (!locked?v2Empty('教师尚未确认锁定本班课程计划'):!sid?v2Empty('选择学生后开始当前任务'):!current?v2Card('全部课程已通关','<p>本计划所有锁课要求均已达标，记录已保存。</p>'):
    '<div class="gate-editor-layout"><nav class="gate-course-nav">'+g.plan.lessons.map((l,i)=>'<button class="ghost" data-student-lesson="'+l.id+'"><strong>第'+(i+1)+'节 · '+escapeHtml(l.title)+'</strong><small>'+(Domain.gatePassed(l,records)?'已通过':l.id===current.id?'当前课程':'未解锁')+'</small></button>').join('')+'</nav><div>'+v2Card(current.title,'<p class="gate-locked-note">已完成 '+current.tasks.filter(t=>records[current.id]?.[t.id]?.status==='passed').length+'/'+current.tasks.length+' 项。全部达到锁定要求才能进入下一课。</p><p class="hint">'+escapeHtml(Domain.blockedMessage(current,records))+'</p>'+current.tasks.map(t=>{
      const r=records[current.id]?.[t.id] || {},drafts=(wbUI().answerDrafts[state.courseId+'|'+sid] || {}),key=current.id+'::'+t.id,value=drafts[key] ?? r.evidence ?? '';
      return '<article class="gate-task-editor"><div class="gate-task-head"><strong>'+escapeHtml(gateTaskShortName(t))+'</strong><span class="status-pill">'+({pending:'待提交',checking:'处理中',failed:'需订正',review:'待教师复核',passed:'已通过'}[r.status] || '待提交')+'</span></div><p>'+escapeHtml(t.standard || t.questionType+' · '+t.threshold)+'</p><p class="hint">来源：'+escapeHtml(t.source)+'</p>'+v2GateSourceLink(t,g.plan.sources)+'<label>答案、推导过程或操作记录<textarea data-gate-evidence="'+t.id+'" data-gate-lesson-id="'+current.id+'" '+(['passed','checking','review'].includes(r.status)?'disabled':'')+'>'+escapeHtml(value)+'</textarea></label><p class="'+(r.status==='failed'?'inline-error':'hint')+'">'+escapeHtml(r.feedback || '')+'</p><button class="primary" data-gate-verify="'+t.id+'" data-gate-lesson-id="'+current.id+'" '+(['passed','checking','review'].includes(r.status)?'disabled':'')+'>'+(r.status==='failed'?'提交订正':'提交核验')+'</button>'+(r.status==='review'?'<p class="hint">等待教师核实证据；当前不能通关。</p>':'')+'<details><summary>提交记录 · '+(r.history?.length || 0)+' 次</summary>'+(r.history || []).map(h=>'<p>'+v2Date(h.at)+' · '+escapeHtml(h.status)+'</p><pre>'+escapeHtml(h.evidence)+'</pre><p>'+escapeHtml(h.feedback)+'</p>').join('')+'</details></article>';
    }).join(''))+'</div></div>');
}
function v2GateSourceLink(task,sources=[]){const source=sources.find(s=>task.materialId===s.id||String(task.source).includes(s.name));return source?.materialId?'<a target="_blank" rel="noopener" href="/api/materials/'+source.materialId+'/file">查看提供的原始资料 ↗</a>':'';}
function bindGate(){
  gateEnsure();
  v2On('[data-gate-mode]','click',(e,el)=>{state.gate.mode=el.dataset.gateMode;saveState();render();});
  v2On('[data-gate-student-select]','change',(e,el)=>{state.gate.studentId=el.value;state.gate.studentName=v2Name(el.value,'');saveState();render();});
  v2On('[data-gate-evidence]','input',(e,el)=>{const key=state.courseId+'|'+gateProgressKey();(wbUI().answerDrafts[key] ||= {})[el.dataset.gateLessonId+'::'+el.dataset.gateEvidence]=el.value;saveState();});
  v2Action('[data-gate-verify]',el=>gateVerifyTask(el.dataset.gateLessonId,el.dataset.gateVerify));
  v2Action('[data-student-lesson]',el=>{const current=Domain.currentGateLesson(state.gate,gateProgressKey());if(current&&current.id!==el.dataset.studentLesson)toast(Domain.blockedMessage(current,gateStudentProgress()),'error');});
  v2On('[data-gate-source-files]','change',e=>gateIngestFiles([...e.target.files]));
  v2On('[data-gate-draft-source]','input',(e,el)=>{state.gate.draftSource=el.value;saveState();});
  v2Action('[data-gate-add-text]',async()=>{const content=state.gate.draftSource.trim();if(!content)throw new Error('请先粘贴资料');const name='粘贴资料-'+new Date().toISOString().slice(0,10)+'-'+(state.gate.sources.length+1)+'.txt',material=await v2StoreFile(new File([content],name,{type:'text/plain'}),'course');gateMarkPlanEdited();state.gate.sources.push({id:material.id,materialId:material.id,name,content,kind:'文本',addedAt:new Date().toISOString()});state.gate.draftSource='';saveState();await v2Flush();render();await gateGeneratePlan();});
  v2Action('[data-gate-delete-source]',async el=>{if(!await wbConfirm('移除课程资料引用','原文件继续保存在资料库。发布新版本前需重新检查相关任务来源。','移除引用'))return;gateMarkPlanEdited();state.gate.sources=state.gate.sources.filter(s=>s.id!==el.dataset.gateDeleteSource);saveState();render();});
  v2Action('[data-gate-generate]',gateGeneratePlan);
  v2Action('[data-gate-add-lesson]',()=>{gateMarkPlanEdited();const l=gateNewLesson(gatePlan().lessons.length);gatePlan().lessons.push(l);wbUI().gateLessonId=l.id;saveState();render();});
  v2Action('[data-gate-delete-lesson]',async el=>{if(!await wbConfirm('删除课程草稿','已发布版本和学生历史仍保留。确认新版本后课程目录才改变。','删除本节'))return;gateMarkPlanEdited();gatePlan().lessons=gatePlan().lessons.filter(l=>l.id!==el.dataset.gateDeleteLesson);saveState();render();});
  v2On('[data-gate-lesson-title]','input',(e,el)=>{gateMarkPlanEdited();gateLessonById(el.dataset.gateLessonTitle).title=el.value;saveState();});
  v2On('[data-gate-minimum]','input',(e,el)=>{gateMarkPlanEdited();gateLessonById(el.dataset.gateMinimum).exerciseMinimum=Number(el.value);saveState();});
  v2On('[data-gate-count-reason]','input',(e,el)=>{gateMarkPlanEdited();gateLessonById(el.dataset.gateCountReason).countReason=el.value;saveState();});
  v2On('[data-gate-skip-lock]','change',async(e,el)=>{if(el.checked&&!await wbConfirm('教师设置：这节不锁','明确取消本节的锁课要求。此修改需要发布新版本后才生效。','这节不锁')){el.checked=false;return;}gateMarkPlanEdited();gateLessonById(el.dataset.gateSkipLock).skipLock=el.checked;saveState();render();});
  v2Action('[data-gate-add-task]',el=>{gateMarkPlanEdited();gateLessonById(el.dataset.gateAddTask).tasks.push(gateTaskTemplate(el.dataset.gateTaskType));saveState();render();});
  v2Action('[data-gate-delete-task]',el=>{gateMarkPlanEdited();const l=gateLessonById(el.dataset.gateLessonId);l.tasks=l.tasks.filter(t=>t.id!==el.dataset.gateDeleteTask);saveState();render();});
  v2On('[data-gate-task-field]','input',(e,el)=>{gateMarkPlanEdited();const t=gateTaskById(gateLessonById(el.dataset.gateLessonId),el.dataset.gateTaskId);t[el.dataset.gateTaskField]=el.value;if(el.dataset.gateTaskField==='expectedAnswer'){t.answerConfirmed=false;const check=el.closest('article').querySelector('[data-gate-answer-confirm]');if(check)check.checked=false;}saveState();});
  v2On('[data-gate-answer-confirm]','change',(e,el)=>{gateMarkPlanEdited();gateTaskById(gateLessonById(el.dataset.gateLessonId),el.dataset.gateAnswerConfirm).answerConfirmed=el.checked;saveState();});
  v2Action('[data-gate-lock]',gateLockPlan);
  v2Action('[data-gate-export]',()=>downloadText('课程关卡过关任务.md',gatePlanMarkdown(),'text/markdown'));
  v2Action('[data-gate-select-lesson]',el=>{wbUI().gateLessonId=el.dataset.gateSelectLesson;saveState();render();});
  v2Action('[data-gate-discard]',async()=>{if(!await wbConfirm('撤销当前修订草稿','学生当前锁定版本保持不变。','撤销草稿'))return;delete state.gate.draftPlan;state.gate.sources=Domain.clone(state.gate.plan.sources || []);saveState();render();});
  v2Action('[data-gate-download-revision]',el=>downloadText('课程关卡历史版本.json',JSON.stringify(state.gate.revisions[Number(el.dataset.gateDownloadRevision)],null,2),'application/json'));
  v2Action('[data-gate-error-lesson]',el=>{const l=gatePlan().lessons[Number(el.dataset.gateErrorLesson)];if(l){wbUI().gateLessonId=l.id;render();const taskIndex=Number(el.dataset.gateErrorTask),target=taskIndex>=0?document.querySelectorAll('.gate-task-editor')[taskIndex]:document.querySelector('.gate-lesson-editor');target?.scrollIntoView({block:'center'});target?.querySelector('input,textarea')?.focus();}});
  v2Action('[data-gate-review]',el=>v2GateReview(el.dataset.student,el.dataset.lesson,el.dataset.gateReview));
  v2Action('[data-gate-copy-course]',v2GateCopy);
}
async function gateLockPlan(){
  const gate=state.gate,working=gatePlan();
  if(gate.plan.locked&&!gate.draftPlan){downloadText('课程关卡-锁定版.md',gatePlanMarkdown(),'text/markdown');return;}
  const errors=gateValidationErrors();working.lastValidation=errors;if(errors.length){saveState();render();toast('尚有'+errors.length+'项需要补齐','error');return;}
  const reason=gate.plan.locked?await v2Prompt('发布课程修订版本','未改动任务的有效判定保留；改动任务重新核验。旧版任务和全部进度永久留档。请填写修改原因。','',true):'首次锁定';
  if(reason===null)return;
  if(!await wbConfirm('确认锁定 '+working.lessons.length+' 节课','服务端将逐项检查通关条件。任何待提交、待订正或待复核项都会阻止进入下一课。','确认锁定'))return;
  await v2Mutation('/api/gates/lock',{courseId:state.courseId,plan:Domain.clone(working),sources:Domain.clone(gate.sources),reason});render();toast('已锁定，后续严格执行');
}
async function gateVerifyTask(lid,tid){
  if(workbench.job)throw new Error('已有任务正在处理');const cid=state.courseId,sid=gateProgressKey(),key=cid+'|'+sid,evidence=wbUI().answerDrafts[key]?.[lid+'::'+tid] || state.gate.progress[sid]?.[lid]?.[tid]?.evidence || '';
  if(!evidence.trim())throw new Error('请先填写作答内容');
  await v2Flush();
  await wbRunJob('核验本项任务',async()=>{
    try{
      const data=await Api.request('/api/gates/verify',{courseId:cid,studentId:sid,lessonId:lid,taskId:tid,evidence,expectedRevision:v2.serverRevision,sessionId:state.sessionId},{timeout:155000});
      v2Adopt(data);render();const r=state.courses[cid].progress[sid]?.[lid]?.[tid];toast(r?.status==='passed'?'本项已通过':r?.status==='review'?'已进入教师复核，未放行':r?.feedback || '答案已保留',r?.status==='failed'?'error':undefined);
    }catch(error){try{v2Adopt(await Api.request('/api/panel-state'));render();}catch{}throw error;}
  });
}
function v2GateReview(sid,lid,tid){
  const task=state.gate.plan.lessons.find(l=>l.id===lid)?.tasks.find(t=>t.id===tid),record=state.gate.progress[sid]?.[lid]?.[tid];if(!task||!record)return;
  const d=v2Dialog('教师复核 · '+v2Name(sid),'<p>'+escapeHtml(gateTaskDescription(task))+'</p>'+v2GateSourceLink(task,state.gate.plan.sources)+'<pre>'+escapeHtml(record.evidence)+'</pre><p>AI辅助意见：'+escapeHtml(record.aiFeedback || record.feedback)+'</p><label>实测正确率（0—100）<input data-review-rate type="number" min="0" max="100" value=""></label><label>复核依据（不得以复核降低标准）<textarea data-review-reason required></textarea></label><div class="actions"><button class="secondary" data-review-result="failed">不达标，要求订正</button><button class="primary" data-review-result="passed">符合锁定标准，通过</button></div>');
  v2Action('[data-review-result]',async el=>{const raw=d.querySelector('input').value,reason=d.querySelector('textarea').value.trim();if(raw===''||!reason)throw new Error('请填写正确率和具体核验证据');await v2Mutation('/api/gates/review',{courseId:state.courseId,studentId:sid,lessonId:lid,taskId:tid,passed:el.dataset.reviewResult==='passed',correctRate:Number(raw),reason});d.close();render();toast('教师复核已记录');},d);
}
function v2GateCopy(){
  const d=v2Dialog('复制课程计划','<p>仅复制任务和资料，不带学生进度。目标班级已有计划时不会覆盖。</p><label>目标班级<select data-copy-grade>'+state.grades.map(g=>'<option value="'+g.id+'">'+escapeHtml(g.name)+'</option>').join('')+'</select></label><label>年份<input data-copy-year value="'+state.lesson.year+'"></label><label>学期<select data-copy-term>'+TERMS.map(t=>'<option '+(t===state.lesson.term?'selected':'')+'>'+t+'</option>').join('')+'</select></label><button class="primary" data-copy-plan>复制为新草稿</button>');
  v2Action('[data-copy-plan]',async()=>{const to=Domain.courseKey({gradeId:d.querySelector('[data-copy-grade]').value,year:d.querySelector('[data-copy-year]').value,term:d.querySelector('[data-copy-term]').value});await v2Mutation('/api/gates/copy',{from:state.courseId,to});d.close();toast('课程已复制；切换到目标班级检查后锁定');},d);
}
function gateSourceCorpus(){const content=state.gate.sources.map(s=>'【资料：'+s.name+'】\n'+s.content).join('\n\n');if(content.length>65000)throw new Error('资料超过单次65000字处理范围。请按章节建立课程计划，不会截断资料或编造缺失内容。原件完整保留。');return content;}
async function gateIngestFiles(files){
  let count=0;
  await wbRunJob('读取并保存课程资料',async()=>{for(const file of files){try{const material=await v2StoreFile(file,'course'),content=await gateReadFile(file);if(!content.trim())throw new Error('没有读取到文字，原件已保存');gateMarkPlanEdited();const source={id:material.id,materialId:material.id,name:file.name,content,kind:gateFileKind(file),addedAt:new Date().toISOString()};const index=state.gate.sources.findIndex(s=>s.id===material.id);if(index>=0)state.gate.sources[index]=source;else state.gate.sources.push(source);count++;saveState();await v2Flush();}catch(error){toast(file.name+'：'+error.message,'error');}}render();});
  if(count)await gateGeneratePlan();
}
async function gateReadPdf(file){
  const bytes=await file.arrayBuffer(),count=await v2PdfCount(bytes),parts=[],material=v2.materials.find(m=>m.name===file.name&&m.size===file.size);
  if(count>200)throw new Error('资料有'+count+'页，请分章节到200页以内；原件已完整保存');
  const extracts=material?.meta.extracts || [];
  for(let page=1;page<=count;page++){
    let text=extracts.find(x=>x.page===page)?.text;
    if(!text){const part=await v2PdfPage(bytes,page);text=part.text;if(text.trim().length<30)text=await callVisionModel('只提取本页教学资料原文，保留题号、标题、公式，不补充资料以外内容。模糊区域标记[无法辨认]。',part.image);extracts.push({page,text});if(material)await Api.request('/api/materials/'+material.id+'/extracts',{extracts});}
    parts.push('【第'+page+'页】\n'+text);setAiProgress('gate',page,count,'active','按页保存资料文字');
  }
  return parts.join('\n');
}
