// Application state and persistence. Compiled with the existing presentation modules.
const coreOriginal={initializeWorkbench,render,wbShell,wbHeader,wbEnhance,wbBindShell,wbSetJobUI,bindView,activeView,wbUI};
const v2={ready:false,serverRevision:0,baseState:null,replica:new Api.BrowserReplica(),flushPromise:null,materials:[],jobs:[],health:null,backups:[],pdfId:'',conflict:null,batch:null,undo:[],frameSamples:[],browserSequence:0};

function loadState(){
  try{const saved=localStorage.getItem(STORAGE_KEY);return saved?mergeState(structuredClone(defaultState),JSON.parse(saved)):structuredClone(defaultState);}
  catch{return structuredClone(defaultState);}
}
function v2Session(){v2Boundary();return state.sessions[state.sessionId];}
function v2Boundary(){
  if(state.schemaVersion!==2)return;
  if(Domain.sessionKey(state.lesson)!==state.sessionId){
    Domain.selectSession(state,state.lesson);
    sourcePdfBytes=null;v2.pdfId='';v2LoadOriginal();
  }
  if(Domain.courseKey(state.lesson)!==state.courseId)Domain.selectSession(state,state.lesson);
}
function panelStateSnapshot(){
  v2Boundary();Domain.captureSession(state);
  const snapshot=JSON.parse(serializedState());snapshot.ai.key='';return snapshot;
}
function v2Select(lesson,view=state.active){
  if(workbench.job){toast('请等待当前课次任务完成，再切换课程');return;}
  wbCapturePosition();Domain.selectSession(state,lesson);sourcePdfBytes=null;v2.pdfId='';state.active=view;saveState();render();v2LoadOriginal();
}
function v2Adopt(data,{preserveUi=true}={}){
  const ui=state.ui,active=state.active,lesson=Domain.clone(state.lesson);
  state=mergeState(structuredClone(defaultState),Domain.migrateState(data.state));
  if(preserveUi){state.ui=ui;state.active=active;Domain.selectSession(state,lesson);}
  v2.serverRevision=data.revision;v2.baseState=Domain.clone(state);
  workbench.savedAt=data.savedAt;workbench.persistedRevision=workbench.revision;workbench.saveStatus='saved';
  state.ai.key='';wbWriteBrowser();wbUpdateSaveIndicator();
}
async function restorePanelStateFromDisk(){
  const browser=await v2.replica.read(),savedConflict=await v2.replica.read('conflict');
  let pending=false,journal=null,legacyTime='',hasLegacy=false;
  try{pending=localStorage.getItem('physics-workbench-pending')==='true';journal=JSON.parse(localStorage.getItem('physics-v2-journal') || 'null');legacyTime=localStorage.getItem(STORAGE_SAVED_AT_KEY) || '';hasLegacy=!!localStorage.getItem(STORAGE_KEY)&&localStorage.getItem('physics-v2-migrated')!=='true';}catch{}
  try{
    const data=await Api.request('/api/panel-state',undefined,{timeout:8000});
    const oldBrowser=Domain.clone(state);
    v2Adopt(data,{preserveUi:false});v2.ready=true;
    if(savedConflict?.local){v2.conflict={local:savedConflict.local,remote:data};}
    else if(pending&&browser?.state){
      if(browser.baseRevision===data.revision){state=Domain.migrateState(browser.state);state=mergeState(structuredClone(defaultState),state);if(journal?.session&&journal.sessionId){state.sessions[journal.sessionId]=journal.session;state.ui={...state.ui,...journal.ui};state.sessionId='';state.courseId='';Domain.selectSession(state,journal.session.lesson);}saveState();}
      else v2.conflict={local:browser.state,remote:data};
    }else if(hasLegacy&&oldBrowser.schemaVersion!==2&&v2LegacyDiffers(oldBrowser,data.state)&&(pending||!legacyTime||!data.state.migration?.legacySavedAt||Date.parse(legacyTime)>Date.parse(data.state.migration.legacySavedAt))){
      // Never silently overwrite the migrated database with a potentially different browser copy.
      v2.conflict={local:Domain.migrateState(oldBrowser),remote:data};
    }
    if(v2.conflict)await v2.replica.write(v2.conflict,'conflict');
    try{localStorage.setItem('physics-v2-migrated','true');}catch{}
    const page=new URLSearchParams(location.search);
    if(speechEntry)state.active='moments';
    else if(page.get('view')==='ai')state.active='ai';
    else {
      const requested=page.get('view');
      state.active=['outreach','wrongbook'].includes(requested)?requested:'classroom';
      const lesson=Object.hasOwn(state.sessions,page.get('lesson'))?state.sessions[page.get('lesson')]:null;
      if(lesson)Domain.selectSession(state,lesson.lesson);
      if(requested==='wrongbook'&&page.get('tab')==='diagnosis')wbUI().wrongbookTab='diagnosis';
    }
  }catch(error){
    if(browser?.state){state=mergeState(structuredClone(defaultState),Domain.migrateState(browser.state));v2.serverRevision=browser.baseRevision;v2.ready=true;workbench.saveStatus='browser';}
    else {state=Domain.migrateState(state);workbench.saveStatus='error';v2.ready=false;setTimeout(()=>toast('本机数据库尚未连接，暂未保存任何修改。请检查本机服务后刷新。','error'),0);}
  }
}
function v2LegacyDiffers(browser,server){
  const normalized=Domain.migrateState(browser),pick=s=>({grades:s.grades.map(g=>({id:g.id,name:g.name,students:g.students})),sessions:s.sessions,courses:s.courses,answerDrafts:s.ui?.answerDrafts || {}});
  return Domain.fingerprint(pick(normalized))!==Domain.fingerprint(pick(server));
}
function initializeWorkbench(){
  if(!wbPages.some(p=>p[0]==='overview'))wbPages.unshift(['overview','测评与校对','从答案和答卷到成绩、错题和一对一反馈','table']);
  coreOriginal.initializeWorkbench();
  if(window.pdfjsLib)pdfjsLib.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.min.js';
  v2LoadOriginal();v2RefreshResources();
  document.addEventListener('keydown',event=>{
    if(event.isComposing)return;
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='s'){event.preventDefault();v2Flush().then(()=>toast('当前草稿已保存到本机')).catch(e=>toast(e.message,'error'));}
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();v2SearchDialog();}
  });
  document.addEventListener('click',event=>{
    if(!event.target.closest('button,input,select,summary'))return;
    const start=performance.now();requestAnimationFrame(()=>{v2.frameSamples.push(performance.now()-start);if(v2.frameSamples.length>500)v2.frameSamples.shift();document.documentElement.dataset.feedbackP95=String(v2.frameSamples.slice().sort((a,b)=>a-b)[Math.floor((v2.frameSamples.length-1)*.95)]?.toFixed(1) || '');});
  },true);
  document.addEventListener('input',event=>{
    if(!event.target.matches('input,textarea,select'))return;
    const start=performance.now();requestAnimationFrame(()=>{v2.inputSamples ||= [];v2.inputSamples.push(performance.now()-start);document.documentElement.dataset.inputP95=v2.inputSamples.slice().sort((a,b)=>a-b)[Math.floor((v2.inputSamples.length-1)*.95)].toFixed(1);});
  },true);
}
function saveState(){
  if(!v2.ready)return;
  v2Boundary();Domain.captureSession(state);
  workbench.revision++;workbench.saveStatus='saving';wbUpdateSaveIndicator();
  clearTimeout(workbench.browserTimer);workbench.browserTimer=setTimeout(wbWriteBrowser,120);
  schedulePanelStateSave(400);
}
function schedulePanelStateSave(delay=400){clearTimeout(workbench.saveTimer);workbench.saveTimer=setTimeout(()=>v2Flush().catch(()=>{}),delay);}
async function wbWriteBrowser(){
  if(!v2.ready)return;
  clearTimeout(workbench.browserTimer);
  const sequence=++v2.browserSequence,snapshot=panelStateSnapshot(),pending=workbench.revision>workbench.persistedRevision;
  let fallback=false;
  try{
    if(v2.conflict)await v2.replica.write(v2.conflict,'conflict');
    localStorage.setItem('physics-workbench-pending',String(pending));
    localStorage.setItem('physics-v2-journal',JSON.stringify({sessionId:state.sessionId,session:snapshot.sessions[state.sessionId],ui:snapshot.ui,at:new Date().toISOString()}));
    localStorage.setItem(STORAGE_SAVED_AT_KEY,new Date().toISOString());fallback=true;
  }catch{}
  try{await v2.replica.write({state:snapshot,baseRevision:v2.serverRevision,pending,at:new Date().toISOString()});if(sequence===v2.browserSequence)workbench.browserSaved=true;}
  catch{if(sequence===v2.browserSequence)workbench.browserSaved=fallback;}
}
async function v2Flush(){
  clearTimeout(workbench.saveTimer);
  if(!v2.ready)throw new Error('数据库尚未连接');
  if(v2.conflict){workbench.saveStatus='browser';wbUpdateSaveIndicator();throw new Error('存在版本冲突，请先保留并处理两份记录');}
  if(v2.flushPromise){await v2.flushPromise;if(workbench.persistedRevision<workbench.revision)return v2Flush();return;}
  if(workbench.persistedRevision>=workbench.revision)return;
  v2.flushPromise=(async()=>{
    await wbWriteBrowser();
    const revision=workbench.revision,snapshot=panelStateSnapshot();
    try{
      const data=await Api.request('/api/panel-state',{state:snapshot,expectedRevision:v2.serverRevision},{timeout:15000});
      v2.serverRevision=data.revision;v2.baseState=Domain.clone(data.state);workbench.savedAt=data.savedAt;workbench.persistedRevision=revision;
      if(revision===workbench.revision)workbench.saveStatus='saved';
      wbWriteBrowser();
    }catch(error){
      workbench.saveStatus=workbench.browserSaved?'browser':'error';
      if(error.status===409){v2.conflict={local:snapshot,remote:await Api.request('/api/panel-state')};await v2.replica.write(v2.conflict,'conflict');render();}
      workbench.lastSaveError=error.message;throw error;
    }finally{wbUpdateSaveIndicator();}
  })();
  try{await v2.flushPromise;}finally{v2.flushPromise=null;}
  if(workbench.persistedRevision<workbench.revision)return v2Flush();
}
async function persistPanelState(){return v2Flush();}
async function v2Mutation(path,body={}){
  await v2Flush();
  if(v2.mutating)throw new Error('上一步确认尚未完成，请稍候');
  v2.mutating=true;wbSetJobUI();
  try{
    const data=await Api.request(path,{...body,expectedRevision:v2.serverRevision});
    if(data.state)v2Adopt(data);
    return data;
  }catch(error){
    if(error.status===409){v2.conflict={local:panelStateSnapshot(),remote:await Api.request('/api/panel-state')};await v2.replica.write(v2.conflict,'conflict');workbench.saveStatus='browser';render();}
    throw error;
  }finally{v2.mutating=false;wbSetJobUI();}
}
async function v2Confirm(type){
  try{
    Domain.captureSession(state);
    const previous=v2Session().confirmations[type];
    const draft=type==='wrongbook'?{...state.wrongbook,confirmed:true}:state[type];
    const changed=previous&&(Domain.fingerprint(previous.snapshot)!==Domain.fingerprint(draft)||Domain.fingerprint(previous.meta || state.lesson)!==Domain.fingerprint(state.lesson)||
      (type==='wrongbook'&&previous.assessmentSource!==Domain.assessmentReviewSource(v2Session())));
    const reason=changed?await v2Prompt('修订已确认的记录','请填写修改原因；旧版将保留在历史修订记录中。','',true):'首次确认';
    if(changed&&reason===null)return false;
    await v2Mutation('/api/sessions/'+encodeURIComponent(state.sessionId)+'/confirm',{type,reason});
    toast('已确认并保存'+(changed?'新版本，旧记录已保留':''));render();return true;
  }catch(error){toast(error.message,'error');return false;}
}
async function v2Prompt(title,description,value='',required=false){
  return new Promise(resolve=>{
    const previous=document.activeElement,dialog=document.createElement('dialog');dialog.className='wb-dialog';
    dialog.innerHTML='<form method="dialog"><h3>'+escapeHtml(title)+'</h3><p>'+escapeHtml(description)+'</p><label class="field"><span>填写内容</span><textarea aria-label="'+escapeAttr(title)+'" '+(required?'required':'')+'>'+escapeHtml(value)+'</textarea></label><div class="actions"><button class="ghost" value="cancel" formnovalidate>取消</button><button class="primary" value="confirm">确认</button></div></form>';
    document.body.appendChild(dialog);dialog.showModal();dialog.querySelector('textarea').focus();
    dialog.onclose=()=>{const result=dialog.returnValue==='confirm'?dialog.querySelector('textarea').value.trim():null;dialog.remove();previous?.focus({preventScroll:true});resolve(result);};
  });
}
async function v2ResolveConflict(){
  const {local,remote}=v2.conflict;
  const text='本机最新版本 '+remote.revision+'；你的页面基于旧版本。保留两份会把当前草稿存入“待归类资料”，不会覆盖本机新记录。';
  if(!await wbConfirm('检测到两个页面的不同记录',text,'保留两份并继续'))return;
  downloadText('冲突草稿备份.json',JSON.stringify(local,null,2),'application/json');
  v2Adopt(remote,{preserveUi:false});v2.conflict=null;
  state.unassigned.push({id:crypto.randomUUID(),kind:'conflict-draft',reason:'多页面保存冲突，原始草稿已保留',record:local,at:new Date().toISOString()});
  saveState();await v2Flush();await v2.replica.write(null,'conflict');render();
}
async function v2RefreshResources(){
  const results=await Promise.allSettled([Api.request('/api/materials'),Api.request('/api/jobs'),Api.request('/api/backups'),Api.request('/api/health')]);
  ['materials','jobs','backups','health'].forEach((key,i)=>{if(results[i].status==='fulfilled')v2[key]=results[i].value;});
  if(state.active==='overview'&&!workbench.composing)render();
}
async function v2LoadOriginal(){
  const id=state.pdf?.materialId,key=state.sessionId;
  if(!id){sourcePdfBytes=null;return;}
  if(v2.pdfId===id&&sourcePdfBytes)return;
  try{
    const response=await fetch('/api/materials/'+id+'/file');if(!response.ok)throw new Error('历史原卷缺失，请从备份恢复');
    const bytes=await response.arrayBuffer();
    if(state.sessionId!==key||state.pdf.materialId!==id)return;
    sourcePdfBytes=bytes;v2.pdfId=id;
    if(state.active==='pdf'){await buildPairPreviews();render();}
    else if(state.active==='wrongbook')render();
  }catch(error){toast(error.message,'error');}
}
function render(){
  if(!v2.ready&&state.schemaVersion!==2)return;
  v2Boundary();coreOriginal.render();
  document.querySelector('.workbench-shell')?.classList.toggle('student-workspace',state.active==='gate'&&state.gate.mode==='student');
}
function wbShell(){
  let html=coreOriginal.wbShell();
  html=html.replace('<nav class="nav" aria-label="主导航">','<nav class="nav" aria-label="主导航"><button data-nav="overview" title="工作概览">'+icons.table+'<span>工作概览</span></button>');
  // The original grouping assumes nine pages. Build groups explicitly after adding Overview.
  const nav='<nav class="nav" aria-label="主导航">'+[['工作概览',['overview']],['课前测与反馈',['scores','knowledge','pdf','wrongbook','feedback']],['课程学习',['gate']],['管理与设置',['setup','ai','agent']]].map(([label,keys])=>'<div class="nav-group"><p class="nav-group-label">'+label+'</p>'+keys.map(key=>{const p=wbPages.find(x=>x[0]===key);return '<button data-nav="'+key+'" title="'+p[1]+'">'+icons[p[3]]+'<span>'+p[1]+'</span></button>';}).join('')+'</div>').join('')+'</nav>';
  return html.replace(/<nav class="nav"[\s\S]*?<\/nav>/,nav);
}
function wbHeader(){
  let base=coreOriginal.wbHeader();
  const query=normalizedHistoryQuery(),records=Object.values(state.sessions).filter(s=>String(s.lesson.year)===String(query.year)&&s.lesson.term===query.term&&String(s.lesson.lessonNo)===String(query.lessonNo)&&(state.grades.find(g=>g.id===s.lesson.gradeId)?.name===query.gradeName));
  base=base.replace('</div></details>','<div class="v2-history-results">'+(records.length?records.map(s=>'<button class="secondary" data-v2-history-load="'+escapeAttr(s.id)+'">打开此课完整记录 · '+Object.keys(s.confirmations).length+'类已确认 / 草稿保留</button>').join(''):'<p class="hint">没有此课记录。请选择其他查询条件。</p>')+'</div></div></details>');
  const grade=currentGrade();
  const context='<div class="v2-context-bar"><label>班级<select data-v2-context="gradeId" aria-label="当前班级">'+state.grades.filter(g=>!g.inactive).map(g=>'<option value="'+g.id+'" '+(g.id===grade.id?'selected':'')+'>'+escapeHtml(g.name)+'</option>').join('')+'</select></label><label>年份<input data-v2-context="year" aria-label="当前年份" type="number" min="2000" max="2100" value="'+escapeAttr(state.lesson.year)+'"></label><label>学期<select data-v2-context="term" aria-label="当前学期">'+TERMS.map(t=>'<option '+(t===state.lesson.term?'selected':'')+'>'+t+'</option>').join('')+'</select></label><label>课次<select data-v2-context="lessonNo" aria-label="当前课次">'+lessonOptions().map(n=>'<option value="'+n+'" '+(String(n)===String(state.lesson.lessonNo)?'selected':'')+'>第'+n+'次课</option>').join('')+'</select></label><span class="context-draft">当前录入 · 自动保存草稿</span><button class="ghost" data-v2-search>搜索 ⌘K</button><button class="ghost" data-v2-jobs>任务中心</button></div>';
  const productionPage=['recording','moments'].includes(state.active);
  const tools='<div class="v2-context-bar production-global-tools"><span class="context-draft">课次在下方关联</span><button class="ghost" data-v2-search>搜索 ⌘K</button><button class="ghost" data-v2-jobs>任务中心</button></div>';
  return base+(['classroom','outreach'].includes(state.active)?'':productionPage?tools:context)+teachingFlowHeader()+(v2.conflict?'<div class="inline-error" role="alert">另一页面保存了新版本。你的草稿仍在。<button class="secondary" data-v2-conflict>比较并保留两份</button></div>':'');
}
function wbEnhance(){
  coreOriginal.wbEnhance();
  document.querySelectorAll('[data-v2-context]').forEach(input=>input.addEventListener('change',()=>{
    if(input.dataset.v2Context==='year'&&(!/^\d{4}$/.test(input.value)||Number(input.value)<2000||Number(input.value)>2100)){input.setCustomValidity('请输入2000至2100之间的年份');input.reportValidity();return;}
    v2Select({...state.lesson,[input.dataset.v2Context]:input.value});
  }));
  document.querySelector('[data-v2-search]')?.addEventListener('click',v2SearchDialog);
  document.querySelector('[data-v2-jobs]')?.addEventListener('click',v2JobsDialog);
  document.querySelector('[data-v2-conflict]')?.addEventListener('click',v2ResolveConflict);
  v2BindCommon();v2BindPaste();
}
function wbSetJobUI(){
  coreOriginal.wbSetJobUI();
  document.querySelectorAll('[data-v2-context]').forEach(el=>{el.disabled=!!workbench.job||!!v2.mutating;});
  document.querySelectorAll('[data-view-content] input,[data-view-content] select,[data-view-content] textarea,[data-view-content] button').forEach(el=>{
    if(v2.mutating&&!el.disabled){el.dataset.mutationDisabled='true';el.disabled=true;}
    else if(!v2.mutating&&el.dataset.mutationDisabled){el.disabled=false;delete el.dataset.mutationDisabled;}
  });
}
function activeView(){
  if(state.active==='overview')return v2Overview();
  return coreOriginal.activeView();
}
function bindView(){
  if(state.active==='overview'){v2BindOverview();return;}
  coreOriginal.bindView();
}
function loadScoresForCurrentSelection(){v2Boundary();return !!v2Session().confirmations.scores;}
function ensureScoreRowsForCurrentSelection(){v2Boundary();}
function buildScoreRows(){
  const byId=new Map(state.scores.map(r=>[r.studentId,r]));
  for(const s of Domain.activeStudents(state,currentGrade().id))if(!byId.has(s.id))state.scores.push({studentId:s.id,name:s.name,score:'',status:'A',homeworkWrong:''});
  saveState();
}
function archiveIsLocked(){return false;}
function currentRecordLocked(){return false;}
function assertCurrentRecordEditable(){return true;}
function lockedRecordHint(){return '';}
function archiveEditStatusText(archive){return '已确认历史记录；教师修订会保留旧版 · '+(archive.savedAt?new Date(archive.savedAt).toLocaleString('zh-CN'):'历史迁移');}
function currentArchiveForType(type=state.active){return selectedArchiveForType(type);}
function archivesForType(type=state.active){
  const field={scores:'scores',pdf:'pdf',wrongbook:'wrongbook',feedback:'feedbacks'}[type];if(!field)return [];
  return Object.values(state.sessions).flatMap(s=>{
    const confirmed=s.confirmations[field];
    if(!confirmed&&(type!=='feedback'||!s.feedbacks.length))return [];
    const value=confirmed?.snapshot || s[field],meta={...s.lesson,id:s.id,gradeName:state.grades.find(g=>g.id===s.lesson.gradeId)?.name || '历史班级',savedAt:confirmed?.at || '',title:s.lesson.title || ''};
    return [{...meta,...(['pdf','wrongbook'].includes(type)?value:{[field]:value})}];
  });
}
function selectedArchiveForType(type=state.active){return archiveByQuery(archivesForType(type),normalizedHistoryQuery());}
function selectedScoreArchive(){return selectedArchiveForType('scores');}
function scoreArchiveForCurrentSelection(){return archivesForType('scores').find(a=>a.id===state.sessionId);}
function applyArchiveMeta(archive){if(archive)v2Select({...state.lesson,...archive,gradeId:archive.gradeId},state.active);}
function saveScoreArchive(){return v2Confirm('scores');}
function savePdfArchive(){return v2Confirm('pdf');}
function saveWrongbookArchive(){return v2Confirm('wrongbook');}
function saveFeedbackArchive(){Domain.captureSession(state);saveState();}
function gateProgressKey(){return state.gate.studentId || Domain.activeStudents(state,currentGrade().id).find(s=>s.name===state.gate.studentName)?.id || '';}
function gateStudentProgress(create=false){const key=gateProgressKey();if(!key)return {};if(create)state.gate.progress[key] ||= {};return state.gate.progress[key] || {};}
function gateLessonPassed(lesson,progress){return Domain.gatePassed(lesson,progress);}
function gateCurrentLesson(progress){return gatePlan().lessons.find(l=>!Domain.gatePassed(l,progress));}
function gateValidationErrors(){return Domain.validateGate(gatePlan(),state.gate.sources);}
