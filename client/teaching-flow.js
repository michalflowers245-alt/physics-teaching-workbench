// Practical entry points for the existing teaching workflow. No separate data store.
function teachingFlow(){return Domain.teachingProgress(v2Session());}
function teachingFlowSteps(){
  const flow=teachingFlow();
  return '<nav class="teaching-steps" aria-label="本次测评流程">'+flow.steps.map((step,i)=>'<button class="teaching-step '+(step.done?'is-done ':'')+(state.active===step.id?'is-current':'')+'" data-teaching-go="'+step.id+'" '+(state.active===step.id?'aria-current="step"':'')+'><span class="teaching-step-number">'+(step.done?'✓':i+1)+'</span><span><strong>'+step.label+'</strong><small>'+escapeHtml(step.detail)+'</small></span></button>').join('')+'</nav>';
}
function teachingFlowHome(){
  const flow=teachingFlow(),hasStudents=state.scores.length>0;
  return '<section class="teaching-start"><div class="section-title-row"><div><h3>本次测评，从这里开始</h3><p class="hint">选好上方班级和课次，上传对应资料。每次做到哪一步，下次接着做。</p></div><button class="primary" data-teaching-go="'+(hasStudents?flow.next.id:'setup')+'">'+(hasStudents?'继续 · '+flow.next.label:'先添加学生名单')+' →</button></div>'+
    '<div class="home-primary-actions"><button class="secondary" data-teaching-go="knowledge">上传试卷与答案 →</button><button class="primary" data-teaching-go="'+(hasStudents?flow.next.id:'setup')+'">'+(hasStudents?'继续 · '+flow.next.label:'添加学生名单')+' →</button></div>'+
    '<div class="teaching-upload-grid"><div class="teaching-upload-card"><span class="teaching-upload-icon">'+icons.file+'</span><div><h4>老师的试卷与标准答案</h4><p>上传含答案的 PDF，自动逐页提取，完成后校对。</p>'+v2UploadControl('data-teaching-upload="knowledge"','上传标准答案 PDF','.pdf')+'<button class="ghost" data-teaching-go="knowledge">手工填写 / 查看已有答案</button></div></div><div class="teaching-upload-card"><span class="teaching-upload-icon">'+icons.file+'</span><div><h4>学生做完的答卷</h4><p>整班合并成一份 PDF 也可以；上传后按页分组、确认姓名。</p>'+v2UploadControl('data-teaching-upload="pdf"','上传学生答卷 PDF','.pdf')+'<button class="ghost" data-teaching-go="pdf">查看 / 调整已有分组</button></div></div></div>'+teachingFlowSteps()+'</section>';
}
function teachingFlowHeader(){
  if(!['knowledge','pdf','scores','wrongbook','feedback'].includes(state.active))return '';
  return '<div class="teaching-flow-header">'+teachingFlowSteps()+'</div>';
}
function teachingFlowNext(){
  const flow=teachingFlow(),current=flow.steps.find(s=>s.id===state.active);if(!current?.done)return '';
  const next=flow.steps.slice(flow.steps.indexOf(current)+1).find(s=>!s.done);
  if(!next)return '';
  return '<aside class="teaching-next" role="status"><span>✓ '+current.label+'已确认</span><button class="primary" data-teaching-go="'+next.id+'">下一步 · '+next.label+' →</button></aside>';
}
function bindTeachingFlow(){
  v2Action('[data-teaching-go]',el=>{if(el.dataset.teachingGo==='wrongbook')wbUI().wrongbookTab='review';v2Navigate(el.dataset.teachingGo);});
  v2On('[data-teaching-upload]','change',async(e,el)=>{
    const file=el.files?.[0];if(!file)return;
    state.active=el.dataset.teachingUpload;saveState();render();
    if(el.dataset.teachingUpload==='knowledge')await importAnswerPdf({target:{files:[file]}});else await loadPdf({target:{files:[file]}});
  });
  // Repaint only progress text after editing; never replace the active input.
  const root=document.querySelector('[data-view-content]');
  if(root&&!root.dataset.teachingBound){root.dataset.teachingBound='true';root.addEventListener('input',()=>{clearTimeout(v2.flowTimer);v2.flowTimer=setTimeout(refreshTeachingFlow,250);});}
}
function refreshTeachingFlow(){
  if(workbench.composing)return;
  const flow=teachingFlow();
  document.querySelectorAll('.teaching-step').forEach(el=>{const s=flow.steps.find(s=>s.id===el.dataset.teachingGo);if(!s)return;el.classList.toggle('is-done',s.done);el.querySelector('small').textContent=s.detail;el.querySelector('.teaching-step-number').textContent=s.done?'✓':String(flow.steps.indexOf(s)+1);});
  const next=document.querySelector('.teaching-next');if(next&&!flow.steps.find(s=>s.id===state.active)?.done)next.remove();
  const generate=document.querySelector('[data-generate-feedback]');if(generate&&!workbench.job&&!v2.mutating){generate.disabled=!Domain.feedbackReadiness(v2Session()).ready||!flow.missing;generate.textContent=flow.missing?'生成缺少的 '+flow.missing+' 人反馈':state.feedbacks.length?'反馈已齐全':'暂无可生成的反馈';}
}
function adoptPaperScores(){
  const session=v2Session(),sid=state.sessionId;
  if(!Domain.confirmationCurrent(session,'pdf'))throw new Error('请先确认拆卷与学生对应关系，再带入分数');
  if(session.scoring.mode==='points')throw new Error('当前按题目/步骤给分，请在成绩表填写各题分数；卷面总分可作为核对依据');
  const rows=session.pdf.pairs.filter(p=>p.scoreCandidate!=null&&String(p.scoreCandidate).trim()).map(p=>({pair:p,score:session.scores.find(r=>r.studentId===p.studentId),value:String(p.scoreCandidate).replace(/分$/,'').trim()}));
  const valid=r=>r.score&&r.score.status!=='请假'&&/^\d+(?:\.\d+)?$/.test(r.value)&&Number(r.value)<=Number(session.lesson.maxScore);
  const entries=rows.map((row,index)=>{
    const usable=valid(row);
    const nameDiffers=row.pair.headerNameCandidate&&row.pair.headerNameCandidate!==row.score?.name;
    const selected=usable&&!nameDiffers&&row.score.score==='';
    const note=!usable?'候选无效、超过满分或学生缺考，请手工录分':nameDiffers?'卷头识别为 '+row.pair.headerNameCandidate+'，请核对后勾选':
      row.score.score!==''?'已有成绩，按需勾选替换':'可带入';
    const name=row.score?.name || '未匹配学生';
    return '<tr><td><input type="checkbox" data-paper-score-row="'+index+'" aria-label="采用'+escapeAttr(name)+'的分数" '+
      (!usable?'disabled':selected?'checked':'')+'></td><td>'+escapeHtml(name)+'</td><td>'+
      escapeHtml(row.score?.score || '未录入')+'</td><td>'+escapeHtml(row.value)+'</td><td>'+escapeHtml(note)+'</td></tr>';
  }).join('');
  const d=v2Dialog('带入卷面分数 · 先核对再保存','<p class="hint">勾选确认要带入的分数。已有成绩或卷头姓名不一致的行需要单独勾选。</p>'+
    '<div class="table-wrap"><table><thead><tr><th>采用</th><th>学生</th><th>已有成绩</th><th>卷面候选</th><th>检查</th></tr></thead><tbody>'+
    entries+'</tbody></table></div><button class="primary" data-paper-score-save>带入勾选的成绩</button>');
  v2Action('[data-paper-score-save]',async()=>{
    if(state.sessionId!==sid)throw new Error('课次已改变，请回到原课次重新核对');
    const chosen=[...d.querySelectorAll('[data-paper-score-row]:checked')].map(el=>rows[Number(el.dataset.paperScoreRow)]).filter(valid);if(!chosen.length)throw new Error('请勾选需要带入的有效分数');
    v2PushUndo();for(const r of chosen)r.score.score=String(Number(r.value));saveState();await v2Flush();d.close();v2Navigate('scores');toast('已带入 '+chosen.length+' 人的成绩草稿，核对后确认成绩');
  },d);
}
