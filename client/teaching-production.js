const productionOriginal={activeView,bindView};
const productionApi='/api/teaching-production';
const productionLocation=new URLSearchParams(location.search);
const speechEntry=productionLocation.get('view')==='speech';
const requestedFeedbackId=speechEntry?(productionLocation.get('feedback')||''):'';
const linkedFeedbackId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedFeedbackId)?requestedFeedbackId.toLowerCase():'';
const productionState={context:null,videoId:productionRememberedId('videoId'),momentsId:linkedFeedbackId||productionRememberedId('momentsId'),
  speechId:productionRememberedId('speechId'),feedbackInput:productionFeedbackDraft(),videoInput:{},poll:null,speechPoll:null,speechUpload:false,microphone:null};

function productionRememberedId(key){
  try{return sessionStorage.getItem('physics-production-'+key) || '';}catch{return '';}
}

function productionFeedbackDraft(){
  try{return JSON.parse(sessionStorage.getItem('physics-production-feedback-draft')||'{}') || {};}catch{return {};}
}

function productionSelectId(kind,id){
  const key={recordings:'videoId',moments:'momentsId',speech:'speechId'}[kind];
  productionState[key]=id;
  try{sessionStorage.setItem('physics-production-'+key,id);}catch{}
}

function activeView(){
  if(state.active==='recording')return productionRecordingView();
  if(state.active==='moments')return productionMomentsView();
  return productionOriginal.activeView();
}

function bindView(){
  clearTimeout(productionState.poll);
  clearTimeout(productionState.speechPoll);
  if(productionState.microphone&&!productionState.microphone.root.isConnected)productionState.microphone.stop();
  if(state.active==='recording')return productionBindRecording();
  if(state.active==='moments')return productionBindMoments();
  productionOriginal.bindView();
}

function productionMeta(draft={}){
  return '<div class="production-fields"><label>关联已有课次<select data-production-lesson><option value="">暂不关联</option></select></label>'+
    '<label>上课日期<input type="date" data-production-meta="date" value="'+escapeAttr(draft.date || '')+'"></label>'+
    '<label>年级<input type="text" data-production-meta="grade" maxlength="24" placeholder="如：九年级" value="'+escapeAttr(draft.grade || '')+'"></label>'+
    '<label>讲次<input type="number" data-production-meta="lessonNo" min="1" max="999" placeholder="第几讲" value="'+escapeAttr(draft.lessonNo || '')+'"></label>'+
    '<label>主题<input type="text" data-production-meta="topic" maxlength="64" placeholder="如：内能和比热容" value="'+escapeAttr(draft.topic || '')+'"></label></div>';
}

function productionReadMeta(root){
  return Object.fromEntries([['sessionId',root.querySelector('[data-production-lesson]').value],
    ...Array.from(root.querySelectorAll('[data-production-meta]'),el=>[el.dataset.productionMeta,el.value.trim()])]);
}

async function productionLoadContext(root,draft){
  const context=await Api.request(productionApi+'/context');
  if(!root.isConnected)return;
  productionState.context=context;
  const select=root.querySelector('[data-production-lesson]');
  for(const item of context.lessons)select.add(new Option(item.label,item.sessionId));
  select.value=draft.sessionId || '';
  select.onchange=()=>{
    const item=context.lessons.find(l=>l.sessionId===select.value);
    if(item)root.querySelectorAll('[data-production-meta]').forEach(el=>{el.value=item[el.dataset.productionMeta] || '';});
    const use=root.querySelector('[data-production-use-lesson]');
    if(use){use.disabled=!item?.material;use.title=item?.material?'带入已确认的题目解析':'该课次没有已确认的题目解析';}
  };
  const use=root.querySelector('[data-production-use-lesson]');
  if(use)use.disabled=!context.lessons.find(l=>l.sessionId===select.value)?.material;
  return context;
}

function productionRecordingView(){
  return '<div data-production-root="recordings">'+v2Card('上传课堂录屏',
    productionMeta(productionState.videoInput)+'<div class="production-record-options"><label class="production-caption">已有时间码字幕（选填）<input data-production-subtitle type="file" accept=".srt,.vtt,.json"></label>'+
    '<div data-production-chatcut></div></div><label class="production-drop" data-production-drop><strong>拖入课堂录屏，或点击选择文件</strong><span>支持 MP4、MOV，上传后自动识别题型、考点和讲解边界</span><input data-production-file aria-label="选择课堂录屏" type="file" accept=".mp4,.mov,video/mp4,video/quicktime"></label>'+
    '<p class="production-notice hint" data-production-note role="status"></p>')+
    v2Card('剪辑任务和题型分组','<label class="production-history">选择已处理记录<select data-production-history><option value="">请选择录课</option></select></label><div data-production-result aria-live="polite"></div>')+'</div>';
}

function productionMomentsView(){
  const draft=productionState.feedbackInput;
  return '<div data-production-root="moments">'+v2Card('课堂录音与学习反馈',
    productionMeta(draft)+
    '<div class="production-speech-controls"><label class="production-drop" data-speech-drop><strong>上传录音或录课，自动生成本课资料包</strong><span>支持 MP4、MOV、M4A、WAV、MP3、WebM、OGG</span><input data-speech-file aria-label="上传 MP4 或录音" type="file" accept=".mp4,.mov,.m4a,.wav,.mp3,.webm,.ogg"></label>'+
    '<div class="production-mic"><button type="button" class="primary" data-speech-mic>开始录音</button><span class="hint">结束录音后开始识别。</span></div></div>'+
    '<label class="production-check"><input type="checkbox" data-speech-auto checked> 自动生成学习报告、知识点复习图、家长稿、朋友圈与群稿、自测题单和宣发图</label>'+
    '<p class="hint">模板根据录音实际内容选择：概念、实验、计算或综合复习。原题不完整时照常整理知识和方法，缺失的题干单独标为待核；新编自测会明确标注，不冒充课堂原题。</p>'+
    '<p class="production-notice hint" data-speech-note role="status"></p>'+
    '<details><summary>查看转写记录</summary><label class="production-history">转写记录<select data-speech-history><option value="">选择已上传的录课或录音</option></select></label></details>'+
    '<div data-speech-actions class="actions"></div>')+
    v2Card('学习反馈成品','<details><summary>查看历史成品</summary><label class="production-history">选择历史成品<select data-production-history><option value="">请选择成品</option></select></label></details><div data-production-result aria-live="polite"></div>')+
    v2Card('课堂材料与手动图文',
    '<div class="actions production-import"><button type="button" class="secondary" data-production-use-lesson disabled>带入已确认的题目解析</button></div>'+
    '<label>识别文字或课堂笔记<textarea aria-label="课堂材料" data-production-material rows="8" maxlength="60000" placeholder="上传视频或结束录音后，识别文字会自动填在这里。也可直接粘贴课堂笔记。">'+escapeHtml(draft.material || '')+'</textarea></label>'+
    '<div class="actions"><button type="button" class="secondary" data-speech-copy>复制识别文字</button><button type="button" class="ghost" data-speech-download>下载 TXT</button><button type="button" class="ghost" data-speech-timing>查看时间码</button></div>'+
    '<label class="production-check"><input type="checkbox" data-production-consent'+(draft.confirmedPublic?' checked':'')+'> 这份材料可公开，已经去除学生个人信息</label>'+
    '<div class="actions"><button class="primary" data-production-generate>生成文案和图片</button><button type="button" class="ghost" data-production-sample>查看材料填写示例</button></div><p class="production-notice hint" data-production-note role="status"></p>')+'</div>';
}

function productionNote(root,message,error=false){
  const element=root.querySelector('[data-production-note]');
  element.textContent=message;
  element.classList.toggle('inline-error',error);
}

function productionRequest(path,data){
  return Api.request(productionApi+path,data,{timeout:15000});
}

const productionStatusLabels={queued:'排队中',running:'处理中',uploading:'上传中',generating:'生成中',saving:'保存中',saved:'已保存',done:'已导出',failed:'待重试',review:'待确认',waiting:'等待 ChatCut',preview:'待保存'};

async function productionList(root){
  const kind=root.dataset.productionRoot;
  const select=root.querySelector('[data-production-history]');
  const rows=await productionRequest('/'+kind);
  if(!root.isConnected)return;
  const selected=kind==='recordings'?productionState.videoId:productionState.momentsId;
  select.replaceChildren(new Option(kind==='recordings'?'请选择录课':'请选择成品',''));
  for(const row of rows.filter(r=>kind!=='recordings'||r.purpose!=='transcript'))select.add(new Option(row.name+(row.clipPlan?' · 按题型':'')+' · '+(productionStatusLabels[row.status]||row.status)+' · '+v2Date(row.updated),row.id));
  select.value=selected;
}

function productionPoll(root,id,delay=0,failures=0){
  clearTimeout(productionState.poll);
  if(!id || !root.isConnected)return;
  productionState.poll=setTimeout(async()=>{
    if(!root.isConnected)return;
    const kind=root.dataset.productionRoot;
    const isSelected=()=>root.isConnected&&(kind==='recordings'?productionState.videoId:productionState.momentsId)===id;
    try{
      const data=await productionRequest('/'+kind+'/'+id);
      if(!isSelected())return;
      const option=Array.from(root.querySelector('[data-production-history]').options).find(item=>item.value===id);
      if(option){
        const name=kind==='recordings'?data.name+(data.clipPlan?' · 按题型':''):(data.meta.topic||data.facts?.topic||(data.bundle?'学习反馈':data.reviewOnly?'课堂复习图':'朋友圈草稿'));
        option.textContent=name+' · '+(productionStatusLabels[data.status]||data.status)+' · '+v2Date(data.updated);
      }
      if(failures)productionNote(root,'已重新连上本机服务。');
      if(root.dataset.lastProduction!==(id+data.updated)){
        root.dataset.lastProduction=id+data.updated;
        if(kind==='recordings')productionRenderRecording(root,data);
        else productionRenderMoments(root,data);
      }
      if(['queued','uploading','running','generating','saving'].includes(data.status))productionPoll(root,id,1400);
    }catch(error){
      if(!isSelected())return;
      if(error.status!==404 && failures<5){
        productionNote(root,'正在重新连接本机服务，已提交的任务仍可从历史找回。');
        productionPoll(root,id,Math.min(1000*2**failures,8000),failures+1);
      }else productionNote(root,error.message,true);
    }
  },delay);
}

function productionBindHistory(root){
  const isVideo=root.dataset.productionRoot==='recordings';
  root.querySelector('[data-production-history]').onchange=event=>{
    productionSelectId(root.dataset.productionRoot,event.target.value);
    root.dataset.lastProduction='';
    root.querySelector('[data-production-result]').replaceChildren();
    productionPoll(root,event.target.value);
  };
  productionList(root).catch(error=>productionNote(root,error.message,true));
  productionPoll(root,isVideo?productionState.videoId:productionState.momentsId);
}

function productionChatcutPicker(root){
  const target=root.querySelector('[data-production-chatcut]');
  target.innerHTML='<details><summary>用 ChatCut 剪辑（选填）</summary><div data-chatcut-controls><p class="hint">普通录课使用本机 FFmpeg。</p></div></details>';
  const detail=target.querySelector('details'),controls=target.querySelector('[data-chatcut-controls]');
  let loaded=false,loading=false;
  async function load(){
    if(loading || loaded)return;
    loading=true;
    controls.textContent='正在检查 ChatCut 本机连接…';
    try {
      const projects=await productionRequest('/chatcut/projects');
      if(!root.isConnected)return;
      productionChatcutProjects(controls,projects,root);
      loaded=true;
    }catch(error){
      controls.innerHTML='<p class="hint">'+escapeHtml(error.message)+'</p><button type="button" class="secondary" data-chatcut-recheck>重新检查连接</button>';
      controls.querySelector('[data-chatcut-recheck]').onclick=load;
    }finally{loading=false;}
  }
  detail.ontoggle=()=>{if(detail.open)load();};
}

function productionChatcutProjects(controls,projects,root){
  controls.innerHTML='<p class="hint">ChatCut Desktop 已连接。录课通过本机导入，关闭云端转写。</p><label>ChatCut 项目<select data-chatcut-project><option value="">普通录课 · FFmpeg</option><option value="new-local">新建 ChatCut 本地项目</option></select></label><div data-chatcut-assets></div>';
  const project=controls.querySelector('[data-chatcut-project]');
  const assets=controls.querySelector('[data-chatcut-assets]');
  for(const item of projects)project.add(new Option(item.name,item.id));
  project.onchange=async()=>{
    assets.replaceChildren();
    if(!project.value||project.value==='new-local')return;
    const chosen=project.value;
    assets.textContent='正在读取素材…';
    try{
      const rows=await productionRequest('/chatcut/assets?projectId='+encodeURIComponent(chosen));
      if(project.value!==chosen)return;
      assets.innerHTML='<label>片头素材<select data-chatcut-intro><option value="">使用默认片头</option></select></label><label>片尾素材<select data-chatcut-outro><option value="">使用默认片尾</option></select></label>';
      for(const menu of assets.querySelectorAll('select'))for(const row of rows)menu.add(new Option(row.name,row.id));
    }catch(error){assets.textContent='素材读取失败';productionNote(root,error.message,true);}
  };
}

function productionBindRecording(){
  const root=document.querySelector('[data-production-root]');
  if(!root)return;
  productionLoadContext(root,productionState.videoInput).catch(error=>productionNote(root,error.message,true));
  productionChatcutPicker(root);
  productionBindHistory(root);
  const input=root.querySelector('[data-production-file]'), drop=root.querySelector('[data-production-drop]');
  root.addEventListener('change',()=>{productionState.videoInput=productionReadMeta(root);});
  const upload=async file=>{
    if(!file||input.disabled)return;
    input.disabled=true;
    drop.setAttribute('aria-busy','true');
    try{
      productionNote(root,'正在上传到本机…');
      const subtitleFile=root.querySelector('[data-production-subtitle]').files[0];
      if(subtitleFile?.size>1_500_000)throw new Error('字幕文件过大，请使用精简的 SRT、VTT 或 JSON');
      const subtitles=subtitleFile?await subtitleFile.text():'';
      const projectId=root.querySelector('[data-chatcut-project]')?.value;
      const meta=productionReadMeta(root);
      const draft=await productionRequest('/recordings',{name:file.name,size:file.size,meta,subtitles,
        renderer:projectId?'chatcut':'ffmpeg',template:projectId?{projectId,
          introId:root.querySelector('[data-chatcut-intro]')?.value,outroId:root.querySelector('[data-chatcut-outro]')?.value}:null});
      const result=await productionUpload(draft.id,file,percent=>{if(root.isConnected)productionNote(root,'上传到本机 '+percent+'%');});
      productionSelectId('recordings',result.id);
      if(root.isConnected){
        productionNote(root,'视频已上传，后台开始处理。');
        await productionList(root);
        productionPoll(root,result.id);
      }
    }catch(error){if(root.isConnected)productionNote(root,error.message,true);}
    finally{input.disabled=false;input.value='';drop.removeAttribute('aria-busy');}
  };
  input.onchange=()=>upload(input.files[0]);
  for(const event of ['dragenter','dragover'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.add('is-dragging');});
  drop.addEventListener('dragleave',()=>drop.classList.remove('is-dragging'));
  drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('is-dragging');upload(e.dataTransfer.files[0]);});
}

function productionUpload(id,file,progress){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open('PUT',productionApi+'/recordings/'+id+'/file');
    xhr.setRequestHeader('Content-Type','application/octet-stream');
    xhr.upload.onprogress=e=>{if(e.lengthComputable)progress(Math.floor(e.loaded/e.total*100));};
    xhr.onerror=xhr.onabort=()=>reject(new Error('上传中断，请重新选择文件'));
    xhr.onload=()=>{
      let body;
      try{body=JSON.parse(xhr.responseText);}catch{reject(new Error('本机服务返回了无法识别的结果'));return;}
      if(xhr.status>=200&&xhr.status<300)resolve(body);
      else reject(new Error(body.error || '上传失败，请重试'));
    };
    xhr.send(file);
  });
}

function productionSeccode(value){
  const ms=Math.round(Number(value)*1000),h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;
  return [h,m,s].map(n=>String(n).padStart(2,'0')).join(':')+'.'+String(ms%1000).padStart(3,'0');
}

function productionRenderRecording(root,data){
  const result=root.querySelector('[data-production-result]');
  const route='/recordings/'+data.id, base=productionApi+route;
  const count=data.clips.filter(c=>c.version).length;
  const elapsed=Object.entries(data.elapsed||{}).map(([k,v])=>({probe:'读取',transcript:'转写',segment:'分段'})[k]+' '+(v/1000).toFixed(2)+'秒').join(' · ');
  const progress=data.segmentProgress&&data.stage==='提取讲解'?' · '+data.segmentProgress.done+'/'+data.segmentProgress.total+' 段':'';
  const busy=['uploading','queued','running'].includes(data.status);
  const activePlayers=Array.from(result.querySelectorAll('video')).some(v=>!v.paused&&!v.ended);
  if(activePlayers&&busy){root.dataset.lastProduction='';return;}
  const groups=new Map();
  for(const [index,clip] of data.clips.entries()){
    const key=data.clipPlan?(clip.group||'待确认'):'';
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({clip,index});
  }
  const clipCard=({clip,index})=>{
    const version=clip.version,url=base+'/clips/'+clip.id+'/file';
    const topic=clip.tested?'<p class="production-clip-topic"><span>考点</span> '+escapeHtml(clip.tested)+'</p>':'';
    const preview=clip.questionType?'<details class="production-clip-words"><summary>查看片头与片尾</summary><p>片头 · '+escapeHtml(clip.intro)+'</p><p>片尾 · '+escapeHtml(clip.outro)+'</p></details>':'';
    return '<article class="production-clip"><div class="section-title-row"><h4>'+escapeHtml(clip.title)+'</h4><span class="production-tag">'+(clip.internal?'仅供内部复习':'已确认可分享')+'</span></div>'+
      topic+'<p class="hint">原片 '+productionSeccode(clip.start)+' – '+productionSeccode(clip.end)+(version?' · 成片 '+version.duration.toFixed(1)+'秒 · '+escapeHtml(version.mode)+' '+(version.elapsed/1000).toFixed(2)+'秒':'')+'</p>'+
      (clip.reason||clip.error?'<p class="inline-error">'+escapeHtml(clip.reason||clip.error)+'</p>':'')+
      preview+(version?'<p class="production-path">'+escapeHtml(version.path)+'</p>':'')+
      '<div class="actions">'+(version?'<button type="button" class="secondary" data-clip-play="'+index+'">播放片段</button><a class="production-link" href="'+url+'?download=1">下载 MP4</a>':'')+
      '<button type="button" class="ghost" data-clip-source="'+index+'">看原片区间</button><button type="button" class="secondary" data-clip-edit="'+index+'"'+(busy?' disabled':'')+'>'+(clip.status==='review'?'确认边界并导出':'调整题型或时间')+'</button></div></article>';
  };
  const sections=Array.from(groups,([group,clips])=>group
    ?'<section class="production-clip-category"><h3>'+escapeHtml(group)+'<small>'+clips.length+' 条</small></h3>'+clips.map(clipCard).join('')+'</section>'
    :clips.map(clipCard).join('')).join('');
  result.innerHTML='<div class="production-status"><strong>'+escapeHtml(data.stage)+escapeHtml(progress)+'</strong><span>'+count+' 条已导出'+(data.transcriptCached?' · 已复用转写':'')+'</span></div>'+
    (elapsed?'<p class="hint">'+escapeHtml(elapsed)+'</p>':'')+
    (data.transcriptWarning?'<p class="hint">'+escapeHtml(data.transcriptWarning)+'</p>':'')+
    (data.error?'<p class="inline-error">'+escapeHtml(data.error)+'</p>':'')+
    '<div class="actions">'+(data.hasSource?'<button type="button" class="secondary" data-production-source>预览原片</button>':'')+
    (data.elapsed?.transcript!=null?'<button type="button" class="secondary" data-production-transcript>查看转写 / 制作反馈</button>':'')+
    (!busy&&data.videoDuration?'<button type="button" class="secondary" data-production-segments>调整分段</button>':'')+
    (!busy&&data.hasSource&&data.videoDuration&&!data.clipPlan?'<button type="button" class="primary" data-production-recut>按题型重新剪一版</button>':'')+
    (count?'<a class="production-link" href="'+base+'/zip">'+(data.clipPlan?'按题型下载 ZIP':'批量下载 ZIP')+'</a>':'')+
    (['failed','waiting'].includes(data.status)&&data.hasSource?'<button type="button" class="secondary" data-production-retry>重试未完成片段</button>':'')+'</div>'+
    sections;
  const player=(url,title,begin,end)=>{
    const panel=v2Dialog(title,'<video class="production-player" controls playsinline preload="metadata"></video>');
    const video=panel.querySelector('video');video.src=url;
    if(begin!=null)video.addEventListener('loadedmetadata',()=>{video.currentTime=begin;},{once:true});
    if(end!=null)video.addEventListener('timeupdate',()=>{if(video.currentTime>=end&&!video.paused)video.pause();});
  };
  v2Action('[data-production-source]',()=>player(base+'/file','原片预览'),result);
  v2Action('[data-production-transcript]',()=>{
    productionSelectId('speech',data.id);
    v2Navigate('moments');
  },result);
  v2Action('[data-clip-source]',el=>{const clip=data.clips[Number(el.dataset.clipSource)];player(base+'/file','原片区间',clip.start,clip.end);},result);
  v2Action('[data-clip-play]',el=>{const clip=data.clips[Number(el.dataset.clipPlay)];player(base+'/clips/'+clip.id+'/file',clip.version.title);},result);
  v2Action('[data-production-retry]',async()=>{await productionRequest(route+'/retry',{});productionPoll(root,data.id);},result);
  v2Action('[data-clip-edit]',el=>productionEditClip(root,data,data.clips[Number(el.dataset.clipEdit)]),result);
  v2Action('[data-production-segments]',()=>productionEditSegments(root,data),result);
  v2Action('[data-production-recut]',async()=>{
    const revised=await productionRequest(route+'/recut',{});
    productionSelectId('recordings',revised.id);
    await productionList(root);productionPoll(root,revised.id);
  },result);
}

function productionEditSegments(root,data){
  const dlg=v2Dialog('调整分段','<p class="hint">可删去误判的分段，也可把相邻讲解合为一条。每条保留所选时间内的原声和画面。原片共 '+productionSeccode(data.videoDuration)+'。</p>'+
    '<div class="production-segment-list" data-segment-list></div>'+
    '<p class="inline-error" role="alert" data-segment-error hidden></p>'+
    '<div class="actions"><button type="button" class="secondary" data-segment-add>添加片段</button>'+
    '<button type="button" class="primary" data-segment-save>保存分段并导出</button></div>');
  const list=dlg.querySelector('[data-segment-list]');
  const add=({id='',title='',start=0,end=data.videoDuration,intro='',outro=''}={})=>{
    const section=document.createElement('fieldset');
    section.className='production-segment-row';
    section.dataset.segmentId=id;
    section.innerHTML='<label>标题<input data-segment-field="title" maxlength="90" value="'+escapeAttr(title)+'"></label>'+
      '<div class="production-layout"><label>开始（秒）<input data-segment-field="start" type="number" step="0.001" min="0" value="'+start.toFixed(3)+'"></label>'+
      '<label>结束（秒）<input data-segment-field="end" type="number" step="0.001" min="0" value="'+end.toFixed(3)+'"></label></div>'+
      '<label>片头问题<input data-segment-field="intro" maxlength="100" value="'+escapeAttr(intro)+'"></label>'+
      '<label>片尾方法<input data-segment-field="outro" maxlength="100" value="'+escapeAttr(outro)+'"></label>'+
      '<button type="button" class="ghost" data-segment-remove>移出这条</button>';
    section.querySelector('[data-segment-remove]').onclick=()=>section.remove();
    list.append(section);
    return section;
  };
  for(const clip of data.clips)add(clip);
  if(!data.clips.length)add();
  v2Action('[data-segment-add]',()=>add().querySelector('input').focus(),dlg);
  v2Action('[data-segment-save]',async()=>{
    const clips=Array.from(list.children,row=>({id:row.dataset.segmentId,
      ...Object.fromEntries(Array.from(row.querySelectorAll('[data-segment-field]'),el=>[el.dataset.segmentField,el.value]))}));
    try{
      await productionRequest('/recordings/'+data.id+'/segments',{updated:data.updated,clips});
      dlg.close();
      productionPoll(root,data.id);
    }catch(error){
      const info=dlg.querySelector('[data-segment-error]');
      info.hidden=false;
      info.textContent=error.message;
    }
  },dlg);
}

function productionEditClip(root,data,clip){
  const classes=['力学计算','电学计算','热学计算','作图与图像','实验探究','知识辨析','待确认'];
  if(clip.group&&!classes.includes(clip.group))classes.unshift(clip.group);
  const options=classes.map(group=>'<option'+(group===(clip.group||'待确认')?' selected':'')+'>'+escapeHtml(group)+'</option>').join('');
  const dlg=v2Dialog('调整这条片段','<label>标题<input data-clip-title maxlength="90" value="'+escapeAttr(clip.title)+'"></label>'+
    '<div class="production-layout"><label>原片开始（秒）<input data-clip-start type="number" step="0.001" min="0" value="'+clip.start.toFixed(3)+'"></label>'+
    '<label>原片结束（秒）<input data-clip-end type="number" step="0.001" min="0" max="'+data.videoDuration+'" value="'+clip.end.toFixed(3)+'"></label></div>'+
    '<div class="production-layout"><label>题型分组<select data-clip-group>'+options+'</select></label>'+
    '<label>具体题型<input data-clip-question-type maxlength="42" value="'+escapeAttr(clip.questionType||'')+'"></label></div>'+
    '<label>考点<input data-clip-tested maxlength="90" value="'+escapeAttr(clip.tested||'')+'"></label>'+
    '<label>片头问题<input data-clip-intro maxlength="100" value="'+escapeAttr(clip.intro)+'"></label>'+
    '<label>片尾方法<input data-clip-outro maxlength="100" value="'+escapeAttr(clip.outro)+'"></label>'+
    '<label class="production-check"><input type="checkbox" data-clip-share'+(clip.internal?'':' checked')+'> 已核查学生信息和公开许可</label>'+
    '<button type="button" class="primary" data-clip-save>保存并导出这条</button>');
  v2Action('[data-clip-save]',async()=>{
    const value=k=>dlg.querySelector('[data-clip-'+k+']').value;
    await productionRequest('/recordings/'+data.id+'/clips/'+clip.id,{title:value('title'),start:value('start'),end:value('end'),
      intro:value('intro'),outro:value('outro'),group:value('group'),questionType:value('question-type'),tested:value('tested'),publicApproved:dlg.querySelector('[data-clip-share]').checked});
    dlg.close();productionPoll(root,data.id);
  },dlg);
}

function productionBindSpeech(root,material,consent,update){
  const input=root.querySelector('[data-speech-file]'),drop=root.querySelector('[data-speech-drop]'),
    select=root.querySelector('[data-speech-history]'),note=root.querySelector('[data-speech-note]'),
    actions=root.querySelector('[data-speech-actions]'),mic=root.querySelector('[data-speech-mic]'),
    copy=root.querySelector('[data-speech-copy]'),download=root.querySelector('[data-speech-download]'),
    timing=root.querySelector('[data-speech-timing]'),auto=root.querySelector('[data-speech-auto]');
  let transcript, selection=0;
  const show=(message,error=false)=>{note.textContent=message;note.classList.toggle('inline-error',error);};
  const refresh=()=>{
    copy.disabled=download.disabled=!material.value.trim();
    timing.disabled=!transcript;
  };
  material.addEventListener('input',refresh);
  refresh();
  const list=async()=>{
    const rows=await productionRequest('/recordings');
    if(!root.isConnected)return;
    select.replaceChildren(new Option('选择已上传的录课或录音',''));
    for(const row of rows)select.add(new Option(row.name+' · '+(row.purpose==='transcript'?row.stage:'录课快剪'),row.id));
    select.value=productionState.speechId;
  };
  const use=()=>{
    const prior=productionState.feedbackInput.recordingId;
    if(prior!==transcript.id)consent.checked=false;
    material.value=transcript.text.slice(0,60_000);
    root.dataset.speechSource=transcript.id;
    update();refresh();
    show('语音识别完成 · '+transcript.cues.length+' 段'+(transcript.text.length>60_000?' · 已填前 60000 字，完整记录可下载':''));
  };
  const poll=async(id,initialMaterial,ticket,failures=0)=>{
    const current=()=>root.isConnected&&productionState.speechId===id&&selection===ticket;
    if(!id||!current())return;
    try{
      const data=await productionRequest('/recordings/'+id);
      if(!current())return;
      const entry=Array.from(select.options).find(option=>option.value===id);
      if(entry)entry.textContent=data.name+' · '+(data.purpose==='transcript'?data.stage:'录课快剪');
      const pending=['draft','queued','running','uploading'].includes(data.status);
      if(pending&&data.elapsed?.transcript==null){
        const p=data.segmentProgress;
        show(data.stage+(p&&data.stage==='提取讲解'?' '+p.done+'/'+p.total+' 段':'')+'…');
        productionState.speechPoll=setTimeout(()=>poll(id,initialMaterial,ticket),1200);return;
      }
      if(data.feedbackId&&!productionState.momentsId){
        productionSelectId('moments',data.feedbackId);
        root.dataset.lastProduction='';
        productionList(root).catch(()=>{});
        productionPoll(root,data.feedbackId);
      }
      try{
        const next=await productionRequest('/recordings/'+id+'/transcript');
        if(!current())return;
        transcript={...next,id,name:data.name};
      }catch(error){
        if(!current())return;
        if(error.status!==409)throw error;
        show(data.error || '这条记录没有可用转写。请选择其他录音，或重新识别。',true);
        if(data.hasSource){
          const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='重试语音识别';
          button.onclick=async()=>{button.disabled=true;try{await productionRequest('/recordings/'+id+'/retry',{});if(current()){actions.replaceChildren();poll(id,material.value,ticket);}}catch(e){if(current())show(e.message,true);button.disabled=false;}};
          actions.replaceChildren(button);
        }
        return;
      }
      actions.replaceChildren();
      refresh();
      const seconds=(Number(data.elapsed?.transcript || 0)/1000).toFixed(1);
      if(root.dataset.speechSource===id){
        show('语音识别完成 · '+transcript.cues.length+' 段 · '+(data.transcriptCached?'复用已有转写':seconds+' 秒'));
      }else if(!material.value || material.value===initialMaterial&&root.dataset.speechSource){
        use();
        show(note.textContent+' · '+(data.transcriptCached?'复用已有转写':seconds+' 秒'));
      }else{
        show('识别完成。下方已有编辑中的课堂材料。');
        const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='用这次转写替换课堂材料';
        button.onclick=()=>{use();button.remove();};actions.append(button);
        const full=document.createElement('button');full.type='button';full.className='ghost';full.textContent='下载这次完整转写';
        full.onclick=()=>downloadText(data.name.replace(/\.[^.]+$/,'')+'_转写.txt',transcript.text,'text/plain;charset=utf-8');actions.append(full);
      }
      if(data.feedbackId)show(note.textContent+' · 查看下方学习反馈成品');
      // Repetition is presented as an optional, reversible edit; the source transcript remains intact.
      const hasRepeat=/(?:([^\n，。！？,.!?]{4,35}?)(?:[\s，。！？,.!?]*\1){3,})/u.test(transcript.text);
      if(hasRepeat){
        const clean=document.createElement('button');clean.type='button';clean.className='secondary';clean.textContent='折叠疑似重复内容';
        clean.onclick=()=>{
          if(root.dataset.speechSource!==id){show('请先将这次转写载入课堂材料，再整理重复内容。',true);return;}
          const pattern=/([^\n，。！？,.!?]{4,35}?)(?:[\s，。！？,.!?]*\1){3,}/gu;
          let count=0;
          material.value=material.value.replace(pattern,(_,phrase)=>{count++;return phrase+'【重复内容已折叠，请回听核对】';});
          material.dispatchEvent(new Event('input',{bubbles:true}));
          show(count?'已折叠 '+count+' 处疑似重复，请回听核对；原始转写可下载。':'当前文字中没有可折叠的连续重复。');
        };
        const original=document.createElement('button');original.type='button';original.className='ghost';original.textContent='下载原始转写';
        original.onclick=()=>downloadText(data.name.replace(/\.[^.]+$/,'')+'_原始转写.txt',transcript.text,'text/plain;charset=utf-8');
        actions.append(clean,original);
        show(note.textContent+' · 检测到疑似重复，请核对');
      }
      if(/\.(mp4|mov)$/i.test(data.name)){
        const url=productionApi+'/recordings/'+data.id+'/file';
        const preview=document.createElement('button');preview.type='button';preview.className='ghost';preview.textContent='预览原片';
        preview.onclick=()=>{const panel=v2Dialog('原片预览','<video class="production-player" controls playsinline preload="metadata"></video>');panel.querySelector('video').src=url;};
        const link=document.createElement('a');link.className='production-link';link.href=url+'?download=1';link.textContent='下载原片';
        actions.append(preview,link);
      }
    }catch(error){
      if(!current())return;
      show(error.message,true);
      if(failures<3)productionState.speechPoll=setTimeout(()=>poll(id,initialMaterial,ticket,failures+1),2500);
    }
  };
  const watch=(id)=>{
    clearTimeout(productionState.speechPoll);transcript=null;actions.replaceChildren();refresh();
    productionSelectId('speech',id);
    const ticket=++selection;
    if(id)poll(id,material.value,ticket);
    else show('');
  };
  select.onchange=()=>watch(select.value);
  list().then(()=>{if(root.isConnected&&select.value)watch(select.value);}).catch(error=>show(error.message,true));
  const upload=async(file)=>{
    if(!file)return;
    if(productionState.speechUpload){show('文件正在上传，请稍后再添加下一份。',true);return;}
    productionState.speechUpload=true;input.disabled=true;drop.setAttribute('aria-busy','true');
    try{
      clearTimeout(productionState.speechPoll);
      selection++;
      show('正在上传到本机…');
      const draft=await productionRequest('/recordings',{name:file.name,size:file.size,meta:productionReadMeta(root),purpose:'transcript',autoFeedback:auto.checked});
      const uploaded=await productionUpload(draft.id,file,percent=>show('正在上传到本机 '+percent+'%'));
      productionSelectId('speech',uploaded.id);
      const mounted=root.isConnected?root:document.querySelector('[data-production-root="moments"]');
      if(uploaded.autoFeedback){
        productionSelectId('moments','');
        if(mounted===root){
          clearTimeout(productionState.poll);
          root.dataset.lastProduction='';
          root.querySelector('[data-production-history]').value='';
          root.querySelector('[data-production-result]').textContent='语音识别完成后，将按本课内容生成资料包并标出待核项。';
        }
      }
      if(mounted===root){
        show('上传完成，正在识别语音…');
        watch(uploaded.id);list().catch(()=>{});
      }else if(mounted)render();
    }catch(error){show(error.message,true);}
    finally{productionState.speechUpload=false;input.disabled=false;input.value='';drop.removeAttribute('aria-busy');}
  };
  input.onchange=()=>upload(input.files[0]);
  for(const event of ['dragenter','dragover'])drop.addEventListener(event,e=>{e.preventDefault();drop.classList.add('is-dragging');});
  drop.addEventListener('dragleave',()=>drop.classList.remove('is-dragging'));
  drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('is-dragging');upload(e.dataTransfer.files[0]);});
  mic.onclick=async()=>{
    if(productionState.microphone){productionState.microphone.stop();return;}
    if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder!=='function'){
      show('这个浏览器无法录音。请在 Chrome 或 Safari 打开工作台，或直接上传录音文件。',true);return;
    }
    let stream,permissionTimer,permissionExpired=false;
    mic.disabled=true;
    show('正在等待麦克风权限，请在浏览器提示中选择允许。');
    try{
      const request=navigator.mediaDevices.getUserMedia({audio:true}).then(result=>{
        if(permissionExpired || !root.isConnected)result.getTracks().forEach(track=>track.stop());
        return result;
      });
      const timeout=new Promise((_,reject)=>{
        permissionTimer=setTimeout(()=>{
          permissionExpired=true;
          reject(new Error('等待麦克风权限超时。请检查浏览器或系统权限后重试。'));
        },45000);
      });
      stream=await Promise.race([request,timeout]);
      clearTimeout(permissionTimer);
      if(!root.isConnected){stream.getTracks().forEach(track=>track.stop());return;}
      const type=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(value=>MediaRecorder.isTypeSupported(value));
      const recorder=new MediaRecorder(stream,type?{mimeType:type}:undefined),parts=[];
      const started=Date.now();
      let timer,failed=false;
      const stop=()=>{if(recorder.state!=='inactive')recorder.stop();stream.getTracks().forEach(track=>track.stop());};
      productionState.microphone={root,stop};
      recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data);};
      recorder.onerror=()=>{failed=true;show('录音中断，请重新开始。',true);stop();};
      recorder.onstop=()=>{
        productionState.microphone=null;clearInterval(timer);
        stream.getTracks().forEach(track=>track.stop());
        mic.textContent='开始录音';mic.setAttribute('aria-pressed','false');
        if(failed)return;
        if(!parts.length||Date.now()-started<650){show('录音太短，请录完一句完整的话再结束。',true);return;}
        const mime=recorder.mimeType||parts[0].type;
        const ext=mime.includes('mp4')?'m4a':mime.includes('ogg')?'ogg':'webm';
        upload(new File(parts,'麦克风录音_'+new Date(started).toISOString().slice(0,19).replaceAll(':','-')+'.'+ext,{type:mime}));
      };
      recorder.start(1000);
      mic.textContent='结束录音并识别';mic.setAttribute('aria-pressed','true');show('正在录音 00:00');
      timer=setInterval(()=>{
        const n=Math.floor((Date.now()-started)/1000);
        show('正在录音 '+String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0'));
        if(n>=1800)stop();
      },500);
    }catch(error){
      clearTimeout(permissionTimer);
      productionState.microphone=null;stream?.getTracks().forEach(track=>track.stop());
      show(permissionExpired?error.message:error.name==='NotAllowedError'
        ?'麦克风未获允许。请在浏览器网站设置和 macOS 系统设置的「隐私与安全性 → 麦克风」中允许浏览器，再重试。'
        :'麦克风无法启动，请检查输入设备或上传文件。',true);
    }finally{mic.disabled=false;}
  };
  v2Action('[data-speech-copy]',async el=>{await navigator.clipboard.writeText(material.value);el.textContent='已复制';},root);
  v2Action('[data-speech-download]',()=>{
    const full=transcript?.text.length>60_000&&material.value===transcript.text.slice(0,60_000);
    downloadText((transcript?.name.replace(/\.[^.]+$/,'')||'课堂材料')+'_转写.txt',full?transcript.text:material.value,'text/plain;charset=utf-8');
  },root);
  v2Action('[data-speech-timing]',()=>v2Dialog('识别文字与时间码','<ol class="production-transcript">'+transcript.cues.map(c=>
    '<li><time>'+productionSeccode(c.start)+'</time> '+escapeHtml(c.text)+'</li>').join('')+'</ol>'),root);
}

function productionBindMoments(){
  const root=document.querySelector('[data-production-root]');
  if(!root)return;
  const material=root.querySelector('[data-production-material]'),consent=root.querySelector('[data-production-consent]');
  root.dataset.speechSource=productionState.feedbackInput.recordingId||'';
  const update=()=>{
    productionState.feedbackInput={...productionReadMeta(root),material:material.value,confirmedPublic:consent.checked,recordingId:root.dataset.speechSource};
    try{sessionStorage.setItem('physics-production-feedback-draft',JSON.stringify(productionState.feedbackInput));}catch{}
  };
  root.addEventListener('input',update);root.addEventListener('change',update);
  productionLoadContext(root,productionState.feedbackInput).catch(error=>productionNote(root,error.message,true));
  productionBindHistory(root);
  productionBindSpeech(root,material,consent,update);
  v2Action('[data-production-sample]',()=>v2Dialog('课堂材料填写示例',
    '<p class="hint">这些字段可直接写进课堂材料。模型暂不可用时，系统也能按这样的笔记生成。</p>'+
    '<p>主题：比热容。<br>问题：为什么要比较水和油各自升温多少？<br>代表题条件：水和油的质量相同，用相同加热器加热相同时间。<br>第一步：先控制质量和加热条件，再比较温度变化。<br>结论：吸热量近似相同时，升温较少的一方比热容更大。<br>易错点：把末温当作升高的温度。<br>家长可以问：升温更少说明什么？</p>'),root);
  v2Action('[data-production-use-lesson]',()=>{
    const id=root.querySelector('[data-production-lesson]').value;
    const selected=productionState.context?.lessons.find(l=>l.sessionId===id);
    if(selected?.material){material.value=selected.material;delete root.dataset.speechSource;consent.checked=false;material.dispatchEvent(new Event('input',{bubbles:true}));material.focus();}
  },root);
  v2Action('[data-production-generate]',async()=>{
    update();
    if(!consent.checked){productionNote(root,'请先确认这份材料可公开，已经去除学生个人信息。',true);consent.focus();return;}
    const draft=productionState.feedbackInput;
    try{
      productionNote(root,'正在生成课堂要点和配图…');
      const result=await productionRequest('/moments',{material:draft.material,confirmedPublic:true,meta:productionReadMeta(root),recordingId:draft.recordingId});
      productionSelectId('moments',result.id);
      productionNote(root,'已提交。请在下方查看生成进度。');
      await productionList(root);productionPoll(root,result.id);
    }catch(error){productionNote(root,error.message,true);}
  },root);
}

function productionRenderMoments(root,data){
  const result=root.querySelector('[data-production-result]'),route='/moments/'+data.id;
  const busy=['generating','saving'].includes(data.status);
  const last=data.versions.at(-1);
  const bundle=data.bundle;
  const hasBundle=bundle&&last?.id&&last.docxPath&&last.pngPath&&last.txtPath;
  const downloads=hasBundle?[
    ['report','学习反馈报告（Word）',last.docxPath],['review','课堂复习图（PNG）',last.pngPath],
    ['copy','朋友圈文案（TXT）',last.txtPath],['parent','家长反馈稿（TXT）',last.parentPath],
    ['group','年级群稿（TXT）',last.groupPath],['quiz','课后自测题单（TXT）',last.practicePath],['poster','朋友圈配图（PNG）',last.promoPath]
  ].filter(([, ,path])=>path):[];
  const labels=bundle
    ?{generating:'正在按本课内容整理课堂资料',saving:'正在保存本课资料包',saved:'本课资料包已保存',preview:'预览已更新，待保存',failed:'课堂资料生成失败'}
    :data.reviewOnly
    ?{generating:'正在整理知识点与例题',saving:'正在保存课堂复习图',saved:'课堂复习图已保存',preview:'复习图已更新，待保存',failed:'复习图需要补充或重试'}
    :{generating:'正在生成课堂要点和配图',saving:'正在保存文案和图片',saved:'已保存',preview:'配图已更新，待保存',failed:'需要处理后重试'};
  const reviewImage=data.preview?productionImageCard('知识点与做题步骤',productionApi+route+'/preview?v='+data.preview,!bundle):'';
  result.innerHTML='<div class="production-status"><strong>'+escapeHtml(data.analysisStage||labels[data.status]||data.status)+'</strong>'+
    (last?'<span>'+escapeHtml([last.dateSource,last.date,'共保存 '+data.versions.length+' 版'].filter(Boolean).join(' · '))+'</span>':'')+'</div>'+
    (hasBundle?'<div class="actions" aria-label="下载课次成品">'+downloads.map(([file,label])=>'<a class="production-link" data-feedback-download="'+file+'" href="'+productionApi+route+'/download/'+file+'?version='+encodeURIComponent(last.id)+'">'+label+'</a>').join('')+'</div>':'')+
    (data.factSource?'<p class="hint">'+escapeHtml([data.factSource,data.factModel,data.analysis?.tokens!=null?'本次 '+data.analysis.tokens+' tokens':''].filter(Boolean).join(' · '))+'</p>':'')+
    (data.reviewSuggested?'<p class="hint">'+(data.reviewOnly?'转写自动整理。使用前请核对题意、公式与单位。':'请先核对题意、公式与单位，再保存这组图文。')+'</p>':'')+
    (data.reviewRanges?.length?'<p class="hint">录音依据 '+data.reviewRanges.map(r=>productionSeccode(r.start).slice(0,8)+'–'+productionSeccode(r.end).slice(0,8)).join('、')+'</p>':'')+
    (data.aiIssue&&!data.error?'<p class="hint">'+escapeHtml(data.aiIssue)+'</p>':'')+
    (data.error?'<p class="inline-error">'+escapeHtml(data.error)+'</p>':'')+
    (data.errorCode==='deepseek_not_configured'?'<a class="production-link" href="/?view=ai&amp;reanalyze='+encodeURIComponent(data.id)+'">配置 DeepSeek API</a>':'')+
    (data.reviewOnly&&!data.body&&reviewImage?'<div class="production-preview">'+reviewImage+'</div>':'')+
    (data.body?'<div class="production-preview"><div class="production-images">'+
      (reviewImage?reviewImage+
       (data.hasPromo?productionImageCard('朋友圈配图',productionApi+route+'/promo?v='+data.preview):''):'<p class="hint">图片生成后显示在这里</p>')+
      '</div><div class="production-copy"><label>朋友圈文案'+(bundle?'（草稿）':'')+'<textarea aria-label="朋友圈文案" rows="8" data-production-copytext '+(busy||bundle?'readonly':'')+'>'+escapeHtml(data.body)+'</textarea></label><div class="actions"><button type="button" class="secondary" data-production-copy>复制文案</button><button type="button" class="secondary" data-production-facts '+(busy?'disabled':'')+'>编辑知识点与方法</button></div></div></div>':'')+
    '<div class="actions">'+(!busy&&data.reviewOnly&&!data.body&&data.facts?'<button type="button" class="secondary" data-production-facts>编辑知识点与方法</button>':'')+
    (!busy&&data.facts&&(!data.reviewOnly||data.status==='preview')?'<button type="button" class="primary" data-production-save>'+(bundle?'保存本课资料包':data.reviewOnly?'保存课堂复习图':data.reviewSuggested?'核对后保存图文':'保存文案和图片')+'</button><button type="button" class="secondary" data-production-image>重新生成图片</button>':'')+
    (!busy&&last&&data.factSource?.startsWith('AI 暂不可用')?'<button type="button" class="secondary" data-production-retry-ai>用 AI 重新生成</button>':'')+
    (!busy&&data.reviewOnly&&data.recordingId&&data.status!=='failed'?'<button type="button" class="secondary" data-production-rebuild>用 DeepSeek 重新分析</button>':'')+
    (data.status==='failed'?'<button type="button" class="secondary" data-production-again>重试</button>'+
      (data.reviewOnly&&!data.versions.length?'<button type="button" class="secondary" data-production-metadata>修正课次或按新规则重新整理</button>':'')+
      (!data.facts?'<button type="button" class="secondary" data-production-facts>填写课堂要点</button>':''):'')+
    (last?'<button type="button" class="secondary" data-production-folder>打开所在文件夹</button>':'')+'</div>'+
    (last?'<details class="production-path" '+(data.status==='saved'&&!hasBundle?'open':'')+'><summary>已保存文件与历史版本</summary>'+data.versions.slice().reverse().map(v=>'<div>'+[v.docxPath,v.pngPath,v.txtPath,v.parentPath,v.groupPath,v.practicePath,v.promoPath].filter(Boolean).map(path=>'<p>'+escapeHtml(path)+'</p>').join('')+'</div>').join('')+'</details>':'');
  const textarea=result.querySelector('[data-production-copytext]');
  const send=async(action,fields={})=>{
    try{
      await productionRequest(route+'/'+action,{body:bundle?undefined:textarea?.value,requestKey:crypto.randomUUID(),baseUpdated:data.updated,...fields});
      result.querySelector('[data-production-edit-error]')?.remove();
      productionPoll(root,data.id);
    }catch(error){
      const container=result.querySelector('[data-production-edit-error]') || document.createElement('p');
      container.dataset.productionEditError='';
      container.className='inline-error';
      container.setAttribute('role','alert');
      container.textContent=error.message;
      result.querySelector('.production-status').after(container);
      throw error;
    }
  };
  v2Action('[data-production-copy]',async el=>{
    await navigator.clipboard.writeText(textarea.value);el.textContent='已复制';toast('朋友圈文案已复制');
  },result);
  v2Action('[data-production-save]',()=>send('save'),result);
  v2Action('[data-production-image]',()=>send('image'),result);
  v2Action('[data-production-again]',()=>send('retry'),result);
  v2Action('[data-production-retry-ai]',()=>send('retry-ai',{body:null}),result);
  v2Action('[data-production-rebuild]',()=>send('rebuild'),result);
  v2Action('[data-production-folder]',async()=>{await productionRequest(route+'/open-folder',{});toast('已打开成品所在文件夹');},result);
  v2Action('[data-production-facts]',()=>productionEditFacts(root,data,send),result);
  v2Action('[data-production-metadata]',()=>{
    const meta=data.meta||{};
    const dlg=v2Dialog('修正这份录音的课次信息',
      '<p class="hint">修正后会复用已保存的转写，不会重新上传或识别录音。讲次不确定时可留空。</p>'+
      '<label>上课日期<input type="date" data-meta-date value="'+escapeHtml(meta.date||'')+'"></label>'+
      '<label>年级<input type="text" data-meta-grade value="'+escapeHtml(meta.grade||'')+'"></label>'+
      '<label>讲次（选填）<input type="text" data-meta-lesson value="'+escapeHtml(meta.lessonNo||'')+'"></label>'+
      '<label>本课主题<input type="text" data-meta-topic value="'+escapeHtml(meta.topic||'')+'"></label>'+
      '<button type="button" class="primary" data-meta-submit>保存并重新生成</button>');
    v2Action('[data-meta-submit]',async()=>{
      const value=key=>dlg.querySelector('[data-meta-'+key+']').value.trim();
      await send('metadata',{meta:{date:value('date'),grade:value('grade'),lessonNo:value('lesson'),topic:value('topic')}});
      dlg.close();
    },dlg);
  },result);
}

function productionImageCard(label,url,allowDownload=true){
  return '<figure class="production-image"><figcaption>'+label+'</figcaption><a href="'+url+'" target="_blank" rel="noopener" aria-label="查看'+label+'"><img alt="'+label+'" loading="lazy" src="'+url+'"></a>'+
    (allowDownload?'<a class="production-link" href="'+url+'" download="'+label+'.png">下载'+label+'</a>':'')+'</figure>';
}

function productionEditFacts(root,data,send){
  const labels={topic:'本讲主题',hook:'开头问题或易错点',knowledge:'知识点（每行一条）',topicTypes:'题型归类（每行一条）',methods:'做题方法（每行一步）',condition:'录音中可核对的完整题目条件（不完整可留空）',steps:'同一道题的推导与结论（每行一步）',mistake:'主要易错点',mistakes:'其他易错点（每行一条）',parent:'家长可以怎么问',reviewQuestions:'课后自测题（按课堂知识新编，每行一题）',answerKey:'教师核对要点（每行一条）',pendingReview:'待教师核对事项（每行一条）'};
  const values={topic:data.meta.topic,knowledge:[],methods:[],steps:[],...data.facts};
  const dlg=v2Dialog('编辑知识点与做题方法',Object.entries(labels).map(([k,label])=>
    '<label>'+label+'<textarea data-fact="'+k+'" rows="'+(Array.isArray(values[k])?3:2)+'">'+escapeHtml(Array.isArray(values[k])?values[k].join('\n'):values[k] || '')+'</textarea></label>'
  ).join('')+'<button type="button" class="primary" data-facts-apply>'+(data.reviewOnly&&!data.bundle?'更新复习图预览':'更新文案和配图预览')+'</button>');
  v2Action('[data-facts-apply]',async()=>{
    const facts=Object.fromEntries(Array.from(dlg.querySelectorAll('[data-fact]'),el=>{
      const k=el.dataset.fact,value=el.value.trim();return [k,['knowledge','topicTypes','methods','steps','mistakes','reviewQuestions','answerKey','pendingReview'].includes(k)?value.split(/\n+/).map(x=>x.trim()).filter(Boolean):value];
    }));
    await send('image',{facts,body:null});dlg.close();productionPoll(root,data.id);
  },dlg);
}
