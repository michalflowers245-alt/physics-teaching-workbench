const classroomOriginal={initializeWorkbench,activeView,bindView};
const classroomLeadStages=['咨询','已约试听','已到课','已报名','已结束'];
const classroomApi='/api/classroom';
const classroomFileLabels={review:'课堂复习图',parent:'家长反馈',report:'学习报告'};

function initializeWorkbench(){
  if(!wbPages.some(page=>page[0]==='classroom')){
    wbPages.unshift(['classroom','本节课','课堂录音、朋友圈图文和复习资料','file']);
    wbPages.push(['outreach','发布与咨询记录','查看发布记录和咨询进展','msg']);
  }
  classroomOriginal.initializeWorkbench();
}

function activeView(){
  if(state.active==='classroom')return classroomView();
  if(state.active==='outreach')return '<div data-outreach-root><p role="status">正在读取宣发和咨询记录…</p></div>';
  return classroomOriginal.activeView();
}

function bindView(){
  if(state.active==='classroom'){classroomBind();return;}
  if(state.active==='outreach'){classroomBindOutreach();return;}
  classroomOriginal.bindView();
}

function classroomLessonLabel(session){
  const lesson=session.lesson;
  const grade=state.grades.find(item=>item.id===lesson.gradeId)?.name||'班级待确认';
  return [grade,'第'+lesson.lessonNo+'讲',lesson.topic,[lesson.year,lesson.term].filter(Boolean).join(''),lesson.date].filter(Boolean).join(' · ');
}

function classroomView(){
  const lesson=state.lesson,prep=lesson.classroomPrep||{};
  const options=Object.values(state.sessions).sort((a,b)=>(b.lesson.date||'').localeCompare(a.lesson.date||''))
    .map(s=>'<option value="'+escapeAttr(s.id)+'" '+(s.id===state.sessionId?'selected':'')+'>'+escapeHtml(classroomLessonLabel(s))+'</option>').join('');
  return '<div data-classroom-root>'+
    '<div class="section classroom-context"><label>当前课次<select data-classroom-select>'+options+'</select></label><button type="button" class="ghost" data-classroom-new>新增课次</button></div>'+
    v2Card('宣发素材','<div id="classroom-delivery" tabindex="-1" aria-label="宣发素材"></div><label class="production-drop" data-classroom-drop><strong>选择或拖入课堂录音、录课</strong><span>生成朋友圈文案、配图和复习图。上传视频还可按题型剪辑。</span>'+
      '<input type="file" data-classroom-file aria-label="上传本课录课或录音" accept=".mp4,.mov,.m4a,.wav,.mp3,.webm,.ogg"></label>'+
      '<p class="hint" data-classroom-upload-status role="status"></p><div data-classroom-results aria-live="polite"></div>')+
    v2Card('备课','<div id="classroom-prepare" tabindex="-1" aria-label="备课"></div><form data-classroom-prep><div class="classroom-fields">'+
      '<label>上课日期<input name="date" type="date" required value="'+escapeAttr(lesson.date||'')+'"></label>'+
      '<label>本课主题<input name="topic" maxlength="64" required value="'+escapeAttr(lesson.topic||'')+'"></label>'+
      '<label>今天讲什么<textarea name="objectives" rows="3" maxlength="1000">'+escapeHtml(prep.objectives||'')+'</textarea></label>'+
      '<label>代表题与讲法<textarea name="example" rows="3" maxlength="1000">'+escapeHtml(prep.example||'')+'</textarea></label>'+
      '<label>课后练习与下次复查<textarea name="practice" rows="2" maxlength="1000">'+escapeHtml(prep.practice||'')+'</textarea></label></div>'+
      '<div class="actions"><button type="submit" class="primary">保存备课</button></div></form>')+
    '<div class="classroom-secondary">'+v2Card('测评与校对','<div class="actions"><button type="button" class="secondary" data-nav="overview">打开测评与校对</button></div>')+
    v2Card('学生跟进','<p class="hint" data-classroom-followups>正在读取本课待办…</p><div class="actions"><button type="button" class="secondary" data-nav="feedback">一对一家长反馈</button>'+
      '<button type="button" class="ghost" data-teaching-go="wrongbook">核对错题和订正</button></div><div data-classroom-prior></div>')+'</div>'+
    '</div>';
}

function classroomNewLesson(){
  const lesson=state.lesson;
  const gradeOptions=state.grades.filter(g=>!g.inactive).map(g=>'<option value="'+escapeAttr(g.id)+'" '+(g.id===lesson.gradeId?'selected':'')+'>'+escapeHtml(g.name)+'</option>').join('');
  const termOptions=TERMS.map(term=>'<option '+(term===lesson.term?'selected':'')+'>'+escapeHtml(term)+'</option>').join('');
  const dialog=v2Dialog('新增课次','<form data-classroom-create class="classroom-fields"><label>班级<select name="gradeId">'+gradeOptions+'</select></label>'+
    '<label>年份<input type="number" name="year" min="2000" max="2100" required value="'+escapeAttr(lesson.year)+'"></label>'+
    '<label>学期<select name="term">'+termOptions+'</select></label>'+
    '<label>第几讲<input type="number" name="lessonNo" min="1" max="999" required></label>'+
    '<div class="actions"><button class="primary" type="submit">打开课次</button></div></form>');
  v2On('[data-classroom-create]','submit',async(event,form)=>{
    event.preventDefault();
    const fields=Object.fromEntries(new FormData(form));
    const target={...lesson,...fields,date:'',topic:'',title:'',classroomPrep:{},
      totalLessons:Math.max(Number(lesson.totalLessons)||16,Number(fields.lessonNo))};
    dialog.close();
    v2Select(target,'classroom');
    await v2Flush();
  },dialog);
}

function classroomUploadable(session){
  return !!session.lesson.date&&!!session.lesson.topic;
}

function classroomBind(){
  const root=document.querySelector('[data-classroom-root]');
  const sessionId=state.sessionId,session=state.sessions[sessionId];
  const note=root.querySelector('[data-classroom-upload-status]');
  const fileInput=root.querySelector('[data-classroom-file]');
  const results=root.querySelector('[data-classroom-results]');
  const current=()=>root.isConnected&&state.active==='classroom'&&state.sessionId===sessionId;
  let data,refreshTimer,loading=false,signature='';
  const show=(message,error=false)=>{if(current()){note.textContent=message;note.classList.toggle('inline-error',error);}};
  const refresh=async()=>{
    if(!current()||loading)return;
    loading=true;
    clearTimeout(refreshTimer);
    try{
      const next=await Api.request(classroomApi+'?session='+encodeURIComponent(sessionId));
      if(!current())return;
      const changed=JSON.stringify(next)!==signature;
      data=next;
      if(changed){
        signature=JSON.stringify(next);
        classroomRenderDeliveries(results,data,refresh);
        const prior=root.querySelector('[data-classroom-prior]');
        prior.innerHTML=data.priorChecks.length?'<details><summary>前序课次待复查 · '+data.priorChecks.length+' 项</summary>'+
          data.priorChecks.map((check,index)=>'<button type="button" class="v2-todo ghost" data-classroom-check="'+index+'"><span>'+
            escapeHtml(check.name+' · '+check.detail)+'</span><small>'+escapeHtml(check.label)+' →</small></button>').join('')+'</details>':'';
        v2Action('[data-classroom-check]',el=>{
          const item=data.priorChecks[Number(el.dataset.classroomCheck)];
          const previous=item&&state.sessions[item.sessionId];
          if(previous){
            if(item.view==='wrongbook')wbUI().wrongbookTab='corrections';
            v2Select(previous.lesson,item.view);
          }
        },prior);
        root.querySelector('[data-classroom-followups]').textContent='本课待跟进 '+data.studentFollowups+' 项 · 待订正或复核 '+data.corrections+' 项';
        const topic=root.querySelector('[name="topic"]');
        if(!topic.value&&!session.lesson.topic)topic.placeholder=data.meta.topic?'授课计划建议 '+data.meta.topic:'填写课堂主题';
      }
      if([...data.recordings,...data.deliveries].some(row=>['generating','saving','queued','running','uploading'].includes(row.status))){
        refreshTimer=setTimeout(refresh,1800);
      }
    }catch(error){
      if(current()){show(error.message,true);refreshTimer=setTimeout(refresh,4500);}
    }finally{loading=false;}
  };
  v2On('[data-classroom-select]','change',(_,el)=>{
    const next=state.sessions[el.value];
    if(next)v2Select(next.lesson,'classroom');
  },root);
  v2Action('[data-classroom-new]',classroomNewLesson,root);
  v2On('[data-classroom-prep]','submit',async(event,form)=>{
    event.preventDefault();
    const fields=Object.fromEntries(new FormData(form));
    const topic=fields.topic.trim();
    if(!topic)throw new Error('请填写本课主题');
    const submit=form.querySelector('[type="submit"]');
    if(submit.disabled)return;
    submit.disabled=true;
    try{
      Object.assign(state.lesson,{date:fields.date,topic,title:topic,
        classroomPrep:{objectives:fields.objectives.trim(),example:fields.example.trim(),practice:fields.practice.trim()}});
      saveState();await v2Flush();
      if(current()){
        const title=document.querySelector('[data-editorial-title]');
        if(title)title.textContent=topic;
        const label=document.querySelector('.editorial-lesson');
        if(label)label.innerHTML=wbLessonMeta(state.lesson,!/^\d+$/.test(String(state.lesson.lessonNo||'')));
        const selected=root.querySelector('[data-classroom-select]').selectedOptions[0];
        if(selected)selected.textContent=classroomLessonLabel(session);
        toast('备课已保存');await refresh();
      }
    }finally{submit.disabled=false;}
  },root);
  const upload=async file=>{
    if(!file||fileInput.disabled)return;
    if(!classroomUploadable(session)){show('先保存本课日期和主题，再上传素材。',true);fileInput.value='';return;}
    fileInput.disabled=true;
    try{
      await v2Flush();
      show('正在上传到本机…');
      const draft=await productionRequest('/recordings',{classroom:true,name:file.name,size:file.size,meta:{sessionId}});
      await productionUpload(draft.id,file,value=>show('正在上传到本机 '+value+'%'));
      show('上传完成。可以继续备课或查看其他课次。');
      await refresh();
      if(current())refreshTimer=setTimeout(refresh,900);
    }catch(error){show(error.message,true);}
    finally{fileInput.disabled=false;fileInput.value='';}
  };
  fileInput.onchange=()=>upload(fileInput.files?.[0]);
  const drop=root.querySelector('[data-classroom-drop]');
  for(const name of ['dragenter','dragover'])drop.addEventListener(name,event=>{event.preventDefault();drop.classList.add('is-dragging');});
  drop.addEventListener('dragleave',()=>drop.classList.remove('is-dragging'));
  drop.addEventListener('drop',event=>{event.preventDefault();drop.classList.remove('is-dragging');upload(event.dataTransfer.files?.[0]);});
  refresh();
}

function classroomRenderDeliveries(root,data,refresh){
  const recordings=data.recordings.map(record=>{
    const feedback=data.deliveries.find(item=>item.recordingId===record.id);
    const phases={failed:'待补充或重试',generating:'正在整理课堂要点',saving:'正在保存成品',saved:'成品已保存',preview:'等候核对'};
    const progress=record.status==='running'&&record.segmentProgress?' · '+record.segmentProgress.done+'/'+record.segmentProgress.total+' 段':'';
    const version=feedback?.version;
    const failed=feedback?.status==='failed';
    const moveAudio=failed&&feedback.canReassign&&record.purpose==='transcript'&&record.status==='done';
    const retryFeedback=failed&&feedback.errorCode!=='lesson_mismatch';
    const copy=version?.files.copy,poster=version?.files.poster;
    const promotion=(copy||poster)?'<div class="actions classroom-promotion">'+
      (copy?'<button type="button" class="primary" data-classroom-copy-moments="'+escapeAttr(copy)+'">复制朋友圈文案</button>':'')+
      (poster?'<a class="production-link" href="'+escapeAttr(poster)+'">下载朋友圈配图</a>':'')+
      (copy?'<a class="production-link" href="'+escapeAttr(copy)+'">下载文案</a>':'')+'</div>':'';
    const assets=version?Object.entries(classroomFileLabels).filter(([key])=>version.files[key]).map(([key,label])=>
      '<a class="production-link" href="'+escapeAttr(version.files[key])+'">'+label+'</a>').join(''):'';
    const sent=version&&data.familyDelivery?.version===version.id;
    const clips=(record.clips||[]).map(clip=>{
      if(!clip.version)return '<li>'+escapeHtml(clip.title)+' · '+escapeHtml(clip.reason||clip.error||'正在导出')+'</li>';
      const download=productionApi+'/recordings/'+record.id+'/clips/'+clip.id+'/file?download=1';
      return '<li><strong>'+escapeHtml(clip.title)+'</strong> <a class="production-link" href="'+escapeAttr(download)+'">下载 MP4</a></li>';
    }).join('');
    return '<article class="classroom-record"><div class="production-status"><strong>'+escapeHtml(record.name)+'</strong><span>'+
      escapeHtml(record.stage+progress+(feedback?' · '+(feedback.analysisStage||phases[feedback.status]||feedback.status):''))+'</span></div>'+
      (record.error||feedback?.error?'<p class="inline-error">'+escapeHtml(record.error||feedback.error)+'</p>':'')+
      (feedback?.factSource?'<p class="hint">'+escapeHtml([feedback.factSource,feedback.factModel].filter(Boolean).join(' · '))+(feedback.reviewSuggested?' · 分享前请核对题意、公式和单位':'')+'</p>':'')+
      promotion+
      (assets?'<div class="classroom-downloads">'+assets+'</div>':'')+
      (version?'<div class="actions"><button type="button" class="ghost" data-classroom-folder="'+escapeAttr(feedback.id)+'">打开所在文件夹</button>'+
        (feedback.recordingId&&feedback.status==='saved'?'<button type="button" class="secondary" data-classroom-rebuild="'+escapeAttr(feedback.id)+'">用 DeepSeek 重新分析</button>':'')+
        (version.files.parent?'<button type="button" class="secondary" data-classroom-copy="'+escapeAttr(version.files.parent)+'">复制家长稿</button>'+
          (sent?'<span class="hint">已标记发给家长 · '+escapeHtml(v2Date(data.familyDelivery.sentAt))+'</span>':
          '<button type="button" class="ghost" data-classroom-sent="'+escapeAttr(feedback.id)+'" data-version="'+escapeAttr(version.id)+'">标记已发给家长</button>'):'')+
        '</div>':'')+
      (failed?'<div class="actions">'+
        (moveAudio?'<button type="button" class="secondary" data-classroom-reassign="'+escapeAttr(record.id)+'">改放课次</button>':'')+
        (retryFeedback?'<button type="button" class="secondary" data-classroom-retry-feedback="'+escapeAttr(feedback.id)+'">重试生成</button>':'')+
        (feedback.errorCode==='deepseek_not_configured'?'<a class="production-link" href="/?view=ai&amp;reanalyze='+encodeURIComponent(feedback.id)+'">配置 DeepSeek API</a>':'')+
        '<a class="production-link" href="/?view=speech&amp;feedback='+escapeAttr(feedback.id)+'">核对课堂要点</a></div>':
        feedback?.reviewSuggested?'<a class="production-link" href="/?view=speech&amp;feedback='+escapeAttr(feedback.id)+'">核对课堂要点</a>':'')+
      (record.status==='failed'?'<button type="button" class="secondary" data-classroom-retry="'+escapeAttr(record.id)+'">重试处理</button>':'')+
      (clips?'<details><summary>讲题视频 · '+record.clips.length+' 段</summary><ul class="classroom-clips">'+clips+'</ul></details>':'')+
      '</article>';
  }).join('');
  root.innerHTML=recordings||v2Empty('本课还没有上传课堂素材');
  v2Action('[data-classroom-folder]',el=>productionRequest('/moments/'+el.dataset.classroomFolder+'/open-folder',{}),root);
  v2Action('[data-classroom-copy]',async el=>{
    const file=await fetch(el.dataset.classroomCopy);
    if(!file.ok)throw new Error('未能读取家长稿');
    await navigator.clipboard.writeText(await file.text());toast('家长稿已复制');
  },root);
  v2Action('[data-classroom-copy-moments]',async el=>{
    const file=await fetch(el.dataset.classroomCopyMoments);
    if(!file.ok)throw new Error('未能读取朋友圈文案');
    await wbCopyText(await file.text());toast('朋友圈文案已复制');
  },root);
  v2Action('[data-classroom-retry]',async el=>{
    await productionRequest('/recordings/'+el.dataset.classroomRetry+'/retry',{});
    await refresh();
  },root);
  v2Action('[data-classroom-retry-feedback]',async el=>{
    await productionRequest('/moments/'+el.dataset.classroomRetryFeedback+'/retry',{});
    await refresh();
  },root);
  v2Action('[data-classroom-rebuild]',async el=>{
    await productionRequest('/moments/'+el.dataset.classroomRebuild+'/rebuild',{requestKey:crypto.randomUUID()});
    await refresh();
  },root);
  v2Action('[data-classroom-reassign]',el=>classroomReassignAudio(el.dataset.classroomReassign,data.meta.sessionId),root);
  v2Action('[data-classroom-sent]',async el=>{
    await Api.request(classroomApi,{sessionId:data.meta.sessionId,revision:data.revision,action:'family',delivery:el.dataset.classroomSent,version:el.dataset.version});
    await refresh();
  },root);
}

function classroomReassignAudio(id,currentSessionId){
  const candidates=Object.values(state.sessions).filter(s=>s.id!==currentSessionId&&s.lesson.date&&s.lesson.topic);
  const options=candidates.map(s=>'<option value="'+escapeAttr(s.id)+'">'+escapeHtml(classroomLessonLabel(s))+'</option>').join('');
  const dialog=v2Dialog('改放课次','<p class="hint">移动这条录音，并用已有转写在目标课次重新生成。</p>'+
    (options?'<form data-classroom-move class="classroom-fields"><label>目标课次<select name="sessionId" required><option value="">选择课次</option>'+options+'</select></label>'+
      '<div class="actions"><button class="primary" type="submit">移动并生成</button></div></form>':
      '<p>请先在「本节课」新增目标课次，并保存日期与主题。</p>'));
  classroomSubmit(dialog,'[data-classroom-move]',async fields=>{
    await v2Flush();
    const moved=await productionRequest('/recordings/'+id+'/reassign',{sessionId:fields.sessionId});
    dialog.close();
    v2Select(state.sessions[moved.meta.sessionId].lesson,'classroom');
    toast('已改放课次，正在用已有转写生成');
  });
}

function classroomPublications(rows){
  if(!rows.length)return '<p class="hint">暂无发布记录。</p>';
  return '<ul class="classroom-publications">'+rows.map(row=>'<li><strong>'+escapeHtml(row.title)+'</strong><span>'+escapeHtml(row.channel+' · '+row.date)+'</span>'+
    (row.url?'<a href="'+escapeAttr(row.url)+'" target="_blank" rel="noopener">查看发布</a>':'')+'</li>').join('')+'</ul>';
}

function classroomSubmit(dialog,selector,save){
  v2On(selector,'submit',async(event,form)=>{
    event.preventDefault();
    const button=form.querySelector('[type="submit"]');
    if(button.disabled)return;
    button.disabled=true;
    try{await save(Object.fromEntries(new FormData(form)));}
    finally{button.disabled=false;}
  },dialog);
}

function classroomLeadDialog(sessionId,revision,publications,lead,refresh){
  const sourceOptions=publications.map(row=>'<option value="'+escapeAttr(row.id)+'" '+(lead?.publicationId===row.id?'selected':'')+'>'+
    escapeHtml(row.channel+' · '+row.title+' · '+row.date)+'</option>').join('');
  const stageOptions=classroomLeadStages.map(stage=>'<option '+(lead?.stage===stage?'selected':'')+'>'+stage+'</option>').join('');
  const dialog=v2Dialog(lead?'更新咨询进展':'登记咨询','<form data-classroom-lead-form class="classroom-fields">'+
    '<label>家长称呼或备注<input name="label" required maxlength="60" value="'+escapeAttr(lead?.label||'')+'"></label>'+
    '<label>来源内容<select name="publicationId"><option value="">线下、转介绍或其他来源</option>'+sourceOptions+'</select></label>'+
    '<label>其他来源<input name="origin" maxlength="60" value="'+escapeAttr(lead?.origin||'')+'" placeholder="未选择内容时填写"></label>'+
    '<label>进展<select name="stage">'+stageOptions+'</select></label>'+
    '<label>下次跟进或试听日期<input name="nextAt" type="date" value="'+escapeAttr(lead?.nextAt||'')+'"></label>'+
    '<label>下一步或沟通结果<textarea name="note" rows="3" maxlength="500">'+escapeHtml(lead?.note||'')+'</textarea></label>'+
    (lead?.history?.length?'<p class="hint">进展记录 '+lead.history.map(item=>escapeHtml(item.stage+' '+v2Date(item.at))).join(' → ')+'</p>':'')+
    '<div class="actions"><button type="submit" class="primary">保存进展</button></div></form>');
  classroomSubmit(dialog,'[data-classroom-lead-form]',async fields=>{
    await Api.request(classroomApi,{...fields,sessionId,revision,action:'lead',leadId:lead?.id});
    dialog.close();await refresh();toast('咨询进展已保存');
  });
}

async function classroomBindOutreach(){
  const root=document.querySelector('[data-outreach-root]');
  const load=async()=>{
    try{
      const data=await Api.request(classroomApi);
      if(!root.isConnected)return;
      const all=data.rows.flatMap(row=>row.leads.map(lead=>({row,lead})));
      const totals=classroomLeadStages.map(stage=>'<div><strong>'+all.filter(x=>x.lead.stage===stage).length+'</strong><span>'+stage+'</span></div>').join('');
      const cards=all.sort((a,b)=>(a.lead.nextAt||'9999').localeCompare(b.lead.nextAt||'9999')).map(({row,lead},index)=>{
        const source=row.publications.find(item=>item.id===lead.publicationId),overdue=lead.nextAt&&lead.nextAt<data.today&&!['已报名','已结束'].includes(lead.stage);
        return '<article class="classroom-record"><div class="section-title-row"><strong>'+escapeHtml(lead.label)+'</strong><span class="production-tag">'+escapeHtml(lead.stage)+'</span></div>'+
          '<p class="hint">'+escapeHtml(row.lesson+' · 来源 '+(source?source.channel+' / '+source.title:lead.origin))+'</p>'+
          (lead.nextAt?'<p class="'+(overdue?'inline-error':'hint')+'">'+escapeHtml((overdue?'已到期 · ':'下次跟进 · ')+lead.nextAt)+'</p>':'')+
          (lead.note?'<p>'+escapeHtml(lead.note)+'</p>':'')+
          '<button type="button" class="secondary" data-classroom-update="'+index+'">更新进展</button></article>';
      }).join('');
      const releases=data.rows.flatMap(row=>row.publications).sort((a,b)=>b.date.localeCompare(a.date));
      root.innerHTML=v2Card('咨询、试听与报名','<div class="classroom-totals">'+totals+'</div>'+(cards||v2Empty('还没有咨询记录。')),
        '<button type="button" class="secondary" data-nav="classroom">回本节课</button>')+v2Card('发布记录',classroomPublications(releases));
      v2Action('[data-classroom-update]',el=>{
        const {row,lead}=all[Number(el.dataset.classroomUpdate)];
        return classroomLeadDialog(row.sessionId,row.revision,row.publications,lead,load);
      },root);
    }catch(error){if(root.isConnected)root.innerHTML='<p class="inline-error">'+escapeHtml(error.message)+'</p>';}
  };
  await load();
}
