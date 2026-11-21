// Teaching lifecycle views. Inputs mutate only their own field; rendering is explicit.
const viewsOriginal={scoreTable,scoreTableDensity,wbBindShell,aiView,bindAi,bindAgent,agentView,toast};
function v2On(selector,event,fn,root=document){root.querySelectorAll(selector).forEach(el=>el.addEventListener(event,async e=>{try{await fn(e,el);}catch(error){toast(error.message || '操作失败，请重试','error');}}));}
function v2Action(selector,fn,root=document){v2On(selector,'click',async(e,el)=>{if(el.dataset.busy)return;el.dataset.busy='true';el.setAttribute('aria-busy','true');el.disabled=true;try{await fn(el,e);}finally{delete el.dataset.busy;el.removeAttribute('aria-busy');el.disabled=false;}},root);}
function v2Card(title,body,action=''){return '<section class="section"><div class="section-title-row"><h3>'+title+'</h3>'+action+'</div>'+body+'</section>';}
function v2Empty(text){return '<div class="v2-empty">'+escapeHtml(text)+'</div>';}
function v2Date(at){return at?new Date(at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'尚无记录';}
function toast(message,kind){
  const dialog=[...document.querySelectorAll('dialog[open]')].at(-1);
  if(dialog&&(kind==='error'||/失败|请填写|请选择|缺少|超出|无效/.test(message))){
    let error=dialog.querySelector('[data-dialog-error]');if(!error){error=document.createElement('p');error.dataset.dialogError='';error.className='inline-error';error.setAttribute('role','alert');dialog.querySelector('.dialog-body,form')?.prepend(error);}
    error.textContent=message;error.scrollIntoView({block:'nearest'});return;
  }
  viewsOriginal.toast(message,kind);
}
function v2Name(id,fallback='未关联学生'){return state.students[id]?.name || fallback;}
function v2Dialog(title,html){
  const previous=document.activeElement;
  const dialog=document.createElement('dialog');
  const headingId='dialog-'+crypto.randomUUID();
  dialog.className='wb-dialog v2-dialog';
  dialog.setAttribute('aria-labelledby',headingId);
  dialog.innerHTML='<div class="dialog-heading"><h3 id="'+headingId+'">'+escapeHtml(title)+'</h3><button type="button" class="ghost" data-close-dialog aria-label="关闭弹窗">关闭</button></div><div class="dialog-body">'+html+'</div>';
  document.body.append(dialog);
  dialog.querySelector('[data-close-dialog]').onclick=()=>dialog.close();
  dialog.onclose=()=>{
    dialog.remove();
    previous?.focus({preventScroll:true});
  };
  dialog.showModal();
  return dialog;
}
function wbBindShell(){
  const app=document.querySelector('#app');
  app.addEventListener('click',e=>{
    const nav=e.target.closest('[data-nav]');if(nav){v2Navigate(nav.dataset.nav);return;}
    if(e.target.closest('[data-collapse]')){
      state.ui.collapsed=!state.ui.collapsed;
      wbUpdateSidebar();
      saveState();
    }
    if(e.target.closest('[data-save-retry]'))v2Flush().catch(error=>toast(error.message,'error'));
    if(e.target.closest('[data-export-state]'))v2BackupDialog();
  });
  v2On('[data-import-state]','change',async(e,input)=>{
    if(!input.files.length)return;
    const incoming=JSON.parse(await input.files[0].text()),next=Domain.migrateState(incoming);
    const text='将导入 '+Object.keys(next.students).length+' 位学生、'+Object.keys(next.sessions).length+' 个课次。现有数据库及原文件会先完整备份；JSON不包含的原文件不会凭空恢复。';
    if(!await wbConfirm('检查数据导入',text,'备份现状并导入'))return;
    await v2Mutation('/api/import',{state:incoming});sourcePdfBytes=null;v2.pdfId='';render();await v2RefreshResources();toast('导入完成，现状备份已保留');
  });
  app.addEventListener('click',e=>{
    if(!workbench.job)return;const el=e.target.closest('button,label,input,select,textarea');
    if(!el||el.closest('[data-nav],[data-collapse],[data-v2-jobs],[data-v2-cancel],[data-v2-filter],[data-gate-mode],[data-gate-student-select],[data-gate-evidence]'))return;
    e.preventDefault();e.stopImmediatePropagation();toast('当前任务正在处理；可在任务中心取消后续处理');
  },true);
}
function v2Navigate(view){
  wbCapturePosition();state.active=view;saveState();
  const start=performance.now(),token=crypto.randomUUID();v2.navigationToken=token;
  document.querySelectorAll('.nav [data-nav]').forEach(button=>{button.setAttribute('aria-selected',String(button.dataset.nav===view));button.setAttribute('aria-current',button.dataset.nav===view?'page':'false');});
  const content=document.querySelector('[data-view-content]');
  content.setAttribute('aria-busy','true');content.dataset.loadingView=view;
  let indicator=document.querySelector('.v2-page-loading');
  if(!indicator){indicator=document.createElement('div');indicator.className='v2-page-loading';indicator.setAttribute('role','status');content.before(indicator);}
  indicator.textContent='正在打开'+(wbPages.find(p=>p[0]===view)?.[1] || '页面')+'…';
  // Paint the selected navigation and truthful opening state first. Large tables
  // then mount on the following frame; first feedback and full readiness are measured separately.
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(v2.navigationToken!==token)return;
    render();content.removeAttribute('aria-busy');delete content.dataset.loadingView;indicator.remove();
    requestAnimationFrame(()=>{v2.readySamples ||= [];v2.readySamples.push(performance.now()-start);document.documentElement.dataset.viewReadyP95=v2.readySamples.slice().sort((a,b)=>a-b)[Math.floor((v2.readySamples.length-1)*.95)].toFixed(1);});
  }));
}
function v2BindCommon(){
  const content=document.querySelector('[data-view-content]');if(content&&!content.querySelector('.teaching-next'))content.insertAdjacentHTML('beforeend',teachingFlowNext());
  bindTeachingFlow();
  v2BindExports();
  document.querySelectorAll('[data-density]').forEach(el=>{el.onclick=()=>{wbUI().density=wbUI().density==='compact'?'comfortable':'compact';saveState();render();};});
  v2Action('[data-v2-profile]',el=>v2Profile(el.dataset.v2Profile));
  v2Action('[data-v2-backups]',v2BackupDialog);
  v2Action('[data-v2-revisions]',v2RevisionsDialog);
  v2On('[data-v2-filter]','input',(e,el)=>{
    wbUI().filters[state.sessionId+'|'+el.dataset.v2Filter]=el.value;
    v2ApplyFilter(el);saveState();
  });
  document.querySelectorAll('[data-v2-filter]').forEach(v2ApplyFilter);
  v2Action('[data-v2-jump]',el=>{const s=state.sessions[el.dataset.session];if(s)v2Select(s.lesson,el.dataset.v2Jump);if(el.dataset.student)wbUI().focusStudent=el.dataset.student;if(el.dataset.category==='corrections'||el.dataset.category==='review'){wbUI().wrongbookTab='corrections';wbUI().correctionFilter={sessionId:el.dataset.session,studentId:el.dataset.student};}else if(el.dataset.v2Jump==='wrongbook')wbUI().wrongbookTab='review';render();const i=state.corrections.findIndex(c=>c.studentId===el.dataset.student&&c.question===el.dataset.question);if(i>=0)document.querySelector('[data-correction-draft="'+i+'"]')?.closest('article').scrollIntoView({block:'start'});});
  v2Action('[data-v2-history-load]',el=>{const s=state.sessions[el.dataset.v2HistoryLoad];if(s)v2Select(s.lesson);});
}
function v2Filter(kind,placeholder='搜索学生姓名'){return '<input type="search" class="v2-search" aria-label="'+placeholder+'" placeholder="'+placeholder+'" data-v2-filter="'+kind+'" value="'+escapeAttr(wbUI().filters[state.sessionId+'|'+kind] || '')+'">';}
function v2ApplyFilter(el){const kind=el.dataset.v2Filter,term=el.value.trim().toLowerCase(),status=wbUI().filters[state.sessionId+'|'+(kind==='wrongbook'?'reviewStatus':kind==='feedback'?'feedbackStatus':'')] || '';let shown=0;document.querySelectorAll('[data-search-row="'+kind+'"]').forEach(row=>{const flag=kind==='feedback'?row.dataset.feedbackStatus:row.dataset.reviewStatus;row.hidden=!!term&&!row.dataset.searchText.toLowerCase().includes(term)||!!status&&(status==='unsent'?flag==='sent':flag!==status);if(!row.hidden)shown++;});const count=document.querySelector('[data-feedback-visible]');if(kind==='feedback'&&count)count.textContent=shown?'显示 '+shown+' 人':state.feedbacks.length?'没有符合筛选条件的反馈':'尚未生成反馈';}
function v2History(){const rows=Object.values(state.sessions).filter(s=>Object.keys(s.confirmations).length).sort((a,b)=>b.id.localeCompare(a.id));return '<details class="v2-history"><summary>已确认历史课次 · '+rows.length+' 条</summary>'+rows.map(s=>'<button class="history-row ghost" data-v2-history-load="'+escapeAttr(s.id)+'">'+escapeHtml((state.grades.find(g=>g.id===s.lesson.gradeId)?.name || '历史班级')+' · '+s.lesson.year+s.lesson.term+' 第'+s.lesson.lessonNo+'课')+'<span>打开完整记录 →</span></button>').join('')+'</details>';}
function v2Overview(){
  const all=Object.values(state.sessions),pending={pdf:[],wrongbook:[],feedback:[],corrections:[],review:[],followups:[]};
  for(const s of all){
    for(const p of s.pdf.pairs)if(!p.studentId||p.matchMethod!=='manual')pending.pdf.push({s,name:p.name || p.student || '第'+(p.start+1)+'页试卷'});
    if(s.pdf.materialId)for(const r of s.scores)if(r.studentId&&r.status!=='请假'&&!s.pdf.pairs.some(p=>p.studentId===r.studentId))pending.pdf.push({s,sid:r.studentId,name:'缺卷：'+v2Name(r.studentId,r.name)});
    for(const r of s.wrongbook.rows)if(!r.checked)pending.wrongbook.push({s,sid:r.studentId,name:r.name});
    for(const f of s.feedbacks)if(!f.sentAt)pending.feedback.push({s,sid:f.studentId,name:f.name});
    for(const c of s.corrections || [])if(c.status!=='passed')pending[c.status==='review'?'review':'corrections'].push({s,sid:c.studentId,question:c.question,name:v2Name(c.studentId)+' · 第'+c.question+'题'});
    for(const f of s.followups || [])if(!f.completedAt)pending.followups.push({s,sid:f.studentId,name:v2Name(f.studentId)+' · '+f.note});
  }
  const categories=[['pdf','待匹配试卷','pdf'],['wrongbook','待校对答案','wrongbook'],['feedback','待发送反馈','feedback'],['corrections','待订正','wrongbook'],['review','待教师复核','wrongbook'],['followups','待跟进','feedback']];
  let gateReviews=[];
  for(const [cid,g]of Object.entries(state.courses))for(const [sid,ls]of Object.entries(g.progress))for(const [lid,tasks]of Object.entries(ls))for(const [tid,r]of Object.entries(tasks))if(r.status==='review'||r.status==='pending'&&r.evidence)gateReviews.push({cid,sid,lid,tid});
  return teachingFlowHome()+
    '<div class="v2-stat-grid">'+categories.map(([k,t])=>'<'+(pending[k].length?'a':'div')+' class="v2-stat" '+(pending[k].length?'href="#todo-'+k+'"':'')+'><span>'+t+'</span><strong>'+pending[k].length+'</strong><small>'+(pending[k].length?'查看待办 ↗':'暂无待办')+'</small></'+(pending[k].length?'a':'div')+'>').join('')+'</div>'+
    '<div class="v2-overview-grid">'+categories.filter(([k])=>pending[k].length).map(([k,t,view])=>v2Card('<span id="todo-'+k+'">'+t+'</span>',pending[k].slice(0,30).map(x=>'<button class="v2-todo ghost" data-v2-jump="'+view+'" data-category="'+k+'" data-question="'+escapeAttr(x.question || '')+'" data-session="'+escapeAttr(x.s.id)+'" data-student="'+(x.sid || '')+'"><span>'+escapeHtml(x.name)+'</span><small>'+escapeHtml((state.grades.find(g=>g.id===x.s.lesson.gradeId)?.name || '')+' · '+x.s.lesson.year+x.s.lesson.term+' · 第'+x.s.lesson.lessonNo+'课')+' →</small></button>').join('')+(pending[k].length>30?'<p class="hint">另有 '+(pending[k].length-30)+' 项，进入对应模块查看全部。</p>':'') )).join('')+'</div>'+
    (gateReviews.length?v2Card('课程关卡 · 待复核 '+gateReviews.length+' 项',gateReviews.map(r=>'<button class="ghost" data-overview-gate="'+escapeAttr(r.cid)+'" data-student="'+r.sid+'">'+escapeHtml(v2Name(r.sid))+' → 查看任务</button>').join('')):'')+
    v2Card('本机数据','<div class="v2-health"><span>已建档 '+Object.keys(state.students).length+' 位学生</span><span>已记录 '+all.length+' 个课次</span><span>资料 '+v2.materials.length+' 份</span><span>备份 '+v2.backups.length+' 份</span></div>'+v2History()+(state.unassigned.length?'<button class="secondary" data-unassigned>待归类记录 '+state.unassigned.length+' 条</button>':''),'<button class="secondary" data-v2-backups>数据与恢复</button>');
}
function v2BindOverview(){
  v2Action('[data-overview-gate]',el=>{const parts=el.dataset.overviewGate.split('|').map(decodeURIComponent);v2Select({...state.lesson,gradeId:parts[0],year:parts[1],term:parts[2]},'gate');state.gate.studentId=el.dataset.student;state.gate.mode='admin';render();});
  v2Action('[data-unassigned]',v2Unassigned);
}
async function v2BackupDialog(){
  await v2Flush();v2.backups=await Api.request('/api/backups');
  const d=v2Dialog('本机备份与恢复','<p class="hint">完整备份包含数据库与原文件。每天首次写入自动备份，日常备份保留30天；手动备份长期保留。恢复前会检查完整性并备份现状。</p><div class="actions"><button class="primary" data-backup-new>创建完整备份</button><button class="secondary" data-backup-json>导出结构化记录</button></div><p class="hint">本机存储：'+escapeHtml(v2.health?.dataDirectory || '程序/data')+'</p><div class="v2-backup-list">'+v2.backups.map(b=>'<div class="v2-backup"><span>'+v2Date(b.at)+' · '+escapeHtml(b.kind)+'<small>'+b.students+' 位学生 · '+b.sessions+' 个课次 · '+b.files.length+' 份原文件</small></span><button class="secondary" data-backup-inspect="'+b.id+'">检查与恢复</button></div>').join('')+'</div>');
  v2Action('[data-backup-new]',async()=>{await Api.request('/api/backups',{});d.close();await v2BackupDialog();toast('完整备份已保存在本机');},d);
  v2Action('[data-backup-json]',()=>downloadText('张老师物理-结构化记录.json',JSON.stringify(panelStateSnapshot(),null,2),'application/json'),d);
  v2Action('[data-backup-inspect]',async el=>{
    const info=await Api.request('/api/backups/'+el.dataset.backupInspect+'/inspect'),diff=info.diff;
    const fields={scores:'成绩',knowledge:'解析',wrongbook:'错题',feedbacks:'反馈',scoring:'评分标准',corrections:'订正',followups:'跟进',confirmations:'确认版本'};
    const details=(diff.changes || []).map(c=>c.kind+'：'+c.label+'（'+c.fields.map(f=>fields[f]).join('、')+'）').join('；');
    if(!await wbConfirm('完整性校验通过 · 确认恢复','学生 '+diff.studentsBefore+' → '+diff.studentsAfter+'；课次 '+diff.sessionsBefore+' → '+diff.sessionsAfter+'；原文件 '+diff.files+' 份。'+(details || '教学记录内容无差异。')+' 现状将完整备份后恢复。恢复后新增原件仍保留在本地，不删除。','备份现状并恢复'))return;
    await v2Mutation('/api/backups/'+el.dataset.backupInspect+'/restore');d.close();sourcePdfBytes=null;v2.pdfId='';render();await v2LoadOriginal();await v2RefreshResources();toast('已恢复，恢复前的现状备份仍保留');
  },d);
}
function v2RevisionsDialog(){
  const s=v2Session();v2Dialog('本课次修订记录',s.revisions.length?s.revisions.slice().reverse().map(r=>'<details><summary>'+escapeHtml(r.type)+' · '+v2Date(r.at)+' · '+escapeHtml(r.reason)+'</summary><pre>'+escapeHtml(JSON.stringify(r.previous,null,2))+'</pre></details>').join(''):v2Empty('还没有对已确认记录做过修订'));
}
function v2Unassigned(){
  const d=v2Dialog('待归类记录','<p class="hint">系统未猜测合并这些资料。先查看原始内容，再明确选择归属。完整旧文件保留不动。</p>'+state.unassigned.map((r,i)=>'<details><summary>'+escapeHtml(r.reason || r.kind)+'</summary><pre>'+escapeHtml(JSON.stringify(r.record,null,2))+'</pre><button class="secondary" data-unassigned-export="'+i+'">导出此记录</button><button class="secondary" data-unassigned-note="'+i+'">填写归类备注</button>'+(!r.classifiedAt&&r.kind!=='conflict-draft'?'<button class="primary" data-unassigned-assign="'+i+'">明确选择归属</button>':'')+'<p>'+escapeHtml(typeof r.classification==='string'?r.classification:JSON.stringify(r.classification || ''))+'</p></details>').join(''));
  v2Action('[data-unassigned-assign]',el=>{d.close();v2ClassifyDialog(Number(el.dataset.unassignedAssign));},d);
  v2Action('[data-unassigned-export]',el=>downloadText('待归类记录.json',JSON.stringify(state.unassigned[Number(el.dataset.unassignedExport)],null,2),'application/json'),d);
  v2Action('[data-unassigned-note]',async el=>{const item=state.unassigned[Number(el.dataset.unassignedNote)],note=await v2Prompt('归类说明','填写实际班级、学生、年份、课次与后续处理说明。原记录会继续保留。',item.classification || '',true);if(note===null)return;item.classification=note;saveState();await v2Flush();toast('归类说明已保留');},d);
}
function setupView(){
  const g=currentGrade(),students=(g.studentIds || []).map(id=>state.students[id]).filter(Boolean);
  return '<div class="v2-roster-layout">'+v2Card('班级',state.grades.map(x=>'<button class="v2-class '+(x.id===g.id?'selected':'ghost')+'" data-select-class="'+x.id+'">'+escapeHtml(x.name)+'<span>'+Domain.activeStudents(state,x.id).length+' 人</span></button>').join('')+'<button class="secondary" data-add-class>＋ 新建班级</button>')+
    v2Card('学生名单','<p class="hint">学生使用固定档案编号；同名不会合并。对外称呼统一为“家长”。</p><div class="actions">'+v2Filter('roster')+'<button class="secondary" data-roster-preview>导入名单预览</button><button class="primary" data-build-roster-scores>进入成绩录入 →</button></div><div class="v2-roster">'+students.map(s=>'<div class="v2-student" data-search-row="roster" data-search-text="'+escapeAttr(s.name)+'"><button class="student-profile-link ghost" data-v2-profile="'+s.id+'">'+escapeHtml(s.name)+'<small>'+escapeHtml(s.id.slice(-8))+(s.inactive?' · 已停读':'')+'</small></button><div class="actions"><button class="ghost" data-student-rename="'+s.id+'">改名</button><button class="ghost" data-student-transfer="'+s.id+'">转班</button><button class="ghost" data-student-inactive="'+s.id+'">'+(s.inactive?'恢复':'停读')+'</button></div></div>').join('')+(students.length?'':v2Empty('粘贴或导入名单，创建学生档案'))+'</div>')+'</div>'+
    v2Card('课程参数','<div class="v2-fields"><label>总课次<input data-course-field="totalLessons" type="number" min="1" max="100" value="'+totalLessons()+'"></label><label>本次测评满分<input data-course-field="maxScore" type="number" min="0.5" step="0.5" value="'+state.lesson.maxScore+'"></label><label>旧模式每错题扣分<input data-course-field="penalty" type="number" min="0.1" step="0.1" value="'+state.lesson.penalty+'"></label></div><p class="hint">参数修改仅作用于当前课次；已确认的旧版本仍会保留。</p>');
}
function bindSetup(){
  v2Action('[data-select-class]',el=>v2Select({...state.lesson,gradeId:el.dataset.selectClass}));
  v2Action('[data-add-class]',async()=>{const name=await v2Prompt('新建班级','请输入班级名称','',true);if(!name)return;const g={id:crypto.randomUUID(),name,students:[],studentIds:[],parentTitles:{}};state.grades.push(g);v2Select({...state.lesson,gradeId:g.id});});
  v2Action('[data-roster-preview]',v2RosterPreview);
  v2Action('[data-build-roster-scores]',()=>{buildScoreRows();state.active='scores';saveState();render();});
  v2On('[data-course-field]','change',(e,el)=>{const value=Number(el.value);if(!Number.isFinite(value)||value<=0)throw new Error('参数必须大于0');state.lesson[el.dataset.courseField]=value;saveState();});
  v2Action('[data-student-rename]',async el=>{const s=state.students[el.dataset.studentRename],name=await v2Prompt('修改学生姓名','固定档案编号不变，历史记录仍属于同一学生。',s.name,true);if(!name)return;await v2Mutation('/api/students/'+s.id,{action:'rename',name,reason:'教师修改姓名'});render();});
  v2Action('[data-student-inactive]',async el=>{const s=state.students[el.dataset.studentInactive];if(!await wbConfirm(s.inactive?'恢复在读':'设为停读','不会删除历史成绩、反馈和关卡记录。',s.inactive?'恢复':'确认停读'))return;await v2Mutation('/api/students/'+s.id,{action:'inactive',inactive:!s.inactive});render();});
  v2Action('[data-student-transfer]',el=>v2Transfer(el.dataset.studentTransfer));
}
async function v2RosterPreview(){
  const d=v2Dialog('导入名单 · 先预览后建档','<p class="hint">一行一位学生，可粘贴姓名或选择TXT/CSV。已存在的同名学生默认不添加；需要同名新档案时请明确勾选。</p><label class="secondary action-button">选择名单文件<input type="file" accept=".txt,.csv" class="sr-file" data-roster-file></label><textarea data-roster-text aria-label="待导入名单" rows="9"></textarea><button class="primary" data-roster-check>预览导入</button><div data-roster-result></div>');
  const textarea=d.querySelector('[data-roster-text]');
  v2On('[data-roster-file]','change',async(e,el)=>{textarea.value=await el.files[0].text();},d);
  v2Action('[data-roster-check]',()=>{
    const names=textarea.value.replace(/^\uFEFF/,'').split(/\r?\n/).map(line=>parseCsv(line)[0]?.[0]?.trim()).filter(n=>n&&!['姓名','学生姓名'].includes(n));
    if(!names.length)throw new Error('请先填写姓名');
    const seen=new Set(),existing=Domain.activeStudents(state,currentGrade().id).map(s=>s.name),warnings=names.map(n=>{const duplicate=seen.has(n)||existing.includes(n);seen.add(n);return duplicate;});
    const result=d.querySelector('[data-roster-result]');result.innerHTML='<p>'+names.length+' 行 · '+warnings.filter(Boolean).length+' 行同名，请逐项确认。</p>'+names.map((n,i)=>'<label class="roster-preview-row"><input type="checkbox" data-roster-row="'+i+'" '+(warnings[i]?'':'checked')+'><span>'+escapeHtml(n)+'</span><small>'+(warnings[i]?'同名：勾选将新建独立档案':'新学生')+'</small></label>').join('')+'<button class="primary" data-roster-apply>确认建立所选档案</button>';
    v2Action('[data-roster-apply]',async()=>{
      const indices=[...d.querySelectorAll('[data-roster-row]:checked')].map(el=>Number(el.dataset.rosterRow));if(!indices.length)throw new Error('请选择要新建的档案');
      await v2Flush();await Api.request('/api/backups',{kind:'before-roster-import',manual:false});
      const g=currentGrade();for(const i of indices){const id=crypto.randomUUID();state.students[id]={id,name:names[i],names:[names[i]],gradeId:g.id,inactive:false,history:[{at:new Date().toISOString(),kind:'created',gradeId:g.id}]};g.studentIds.push(id);}
      Domain.syncRosterNames(state);buildScoreRows();saveState();await v2Flush();d.close();render();toast('已建立 '+indices.length+' 份学生档案');
    },result);
  },d);
}
function v2Transfer(id){
  const s=state.students[id],d=v2Dialog('转班 · '+s.name,'<p>固定档案与历史记录保持不变。原班级历史仍可查询。</p><label>目标班级<select data-transfer-grade>'+state.grades.filter(g=>g.id!==s.gradeId).map(g=>'<option value="'+g.id+'">'+escapeHtml(g.name)+'</option>').join('')+'</select></label><label>转班原因<textarea data-transfer-reason required></textarea></label><button class="primary" data-transfer-submit>确认转班</button>');
  v2Action('[data-transfer-submit]',async()=>{const gradeId=d.querySelector('[data-transfer-grade]').value,reason=d.querySelector('[data-transfer-reason]').value.trim();if(!reason)throw new Error('请填写转班原因');await v2Mutation('/api/students/'+id,{action:'transfer',gradeId,reason});buildScoreRows();saveState();d.close();render();},d);
}
function v2ClassifyDialog(index){
  const item=state.unassigned[index],identity=item.kind==='record-identity',d=v2Dialog('明确归属 · 不猜测合并','<p>'+escapeHtml(item.reason)+'</p>'+(identity?'<label>选择对应的学生档案<select data-classify-student>'+Object.values(state.students).map(s=>'<option value="'+s.id+'">'+escapeHtml((state.grades.find(g=>g.id===s.gradeId)?.name || '')+' · '+s.name)+' · '+s.id.slice(-8)+'</option>').join('')+'</select></label>':'<label>班级<select data-classify-grade>'+state.grades.map(g=>'<option value="'+g.id+'">'+escapeHtml(g.name)+'</option>').join('')+'</select></label><label>年份<input data-classify-year value="'+state.lesson.year+'"></label><label>学期<select data-classify-term>'+TERMS.map(t=>'<option>'+t+'</option>').join('')+'</select></label><label>课次<input type="number" min="1" data-classify-lesson value="1"></label>')+'<label>选择此归属的依据<textarea data-classify-reason></textarea></label><button class="primary" data-classify-save>保存明确归属</button>');
  v2Action('[data-classify-save]',async()=>{
    const body={reason:d.querySelector('textarea').value.trim()};
    if(identity)body.studentId=d.querySelector('[data-classify-student]').value;
    else Object.assign(body,{gradeId:d.querySelector('[data-classify-grade]').value,year:d.querySelector('[data-classify-year]').value,term:d.querySelector('[data-classify-term]').value,lessonNo:d.querySelector('[data-classify-lesson]').value});
    await v2Mutation('/api/unassigned/'+item.id+'/assign',body);d.close();render();toast('归属已记录，原始待归类资料仍保留');
  },d);
}
function v2Profile(id){
  const student=state.students[id];if(!student)return;
  const sessions=Object.values(state.sessions).sort((a,b)=>String(a.lesson.year).localeCompare(String(b.lesson.year))||TERMS.indexOf(a.lesson.term)-TERMS.indexOf(b.lesson.term)||Number(a.lesson.lessonNo)-Number(b.lesson.lessonNo));
  const scores=sessions.flatMap(s=>{const r=s.confirmations.scores?.snapshot.find(x=>x.studentId===id);return r&&r.score!==''&&r.score!==null&&r.status!=='请假'?[{s,r}]:[];});
  const corrections=sessions.flatMap(s=>s.corrections.filter(c=>c.studentId===id).map(c=>({s,c})));
  const feedbacks=sessions.flatMap(s=>s.feedbacks.filter(f=>f.studentId===id).map(f=>({s,f})));
  const wrongs={};for(const s of sessions){const r=s.confirmations.wrongbook?.snapshot.rows.find(x=>x.studentId===id);if(r)for(const [q,a]of Object.entries(r.answers || {}))if(a)wrongs[q]=(wrongs[q] || 0)+1;}
  const gates=Object.entries(state.courses).filter(([,g])=>g.progress[id]).map(([cid,g])=>'<p>'+escapeHtml(cid.split('|').slice(1).map(decodeURIComponent).join(' '))+' · '+g.plan.lessons.filter(l=>Domain.gatePassed(l,g.progress[id])).length+'/'+g.plan.lessons.length+' 节通过</p>').join('');
  const d=v2Dialog(student.name+' · 成长档案','<p class="hint">档案编号 '+escapeHtml(id)+' · '+(student.inactive?'已停读':'在读')+'。趋势只含已确认原测；未录入、请假不按零分计算。</p>'+
    '<div class="v2-profile-stats"><span>已确认测评 <strong>'+scores.length+'</strong></span><span>订正通过 <strong>'+corrections.filter(x=>x.c.status==='passed').length+'/'+corrections.length+'</strong></span><span>反馈记录 <strong>'+feedbacks.length+'</strong></span></div>'+
    '<h4>成绩趋势</h4><div class="v2-trend">'+scores.map(({s,r})=>'<div><label>'+escapeHtml(s.lesson.year+s.lesson.term+' 第'+s.lesson.lessonNo+'课')+'</label><meter min="0" max="'+s.lesson.maxScore+'" value="'+r.score+'"></meter><strong>'+r.score+'/'+s.lesson.maxScore+'</strong><button class="ghost" data-profile-session="'+escapeAttr(s.id)+'">查看</button></div>').join('')+'</div>'+
    '<h4>常错题记录</h4><p>'+escapeHtml(Object.entries(wrongs).sort((a,b)=>b[1]-a[1]).map(([q,n])=>'第'+q+'题：'+n+'次').join('；') || '暂无已确认错题')+'</p><p class="hint">题号仅表示各自原课次中的题目，不将相同题号推断成相同知识点。</p>'+
    '<h4>订正与复核</h4>'+corrections.map(({s,c})=>'<details><summary>第'+s.lesson.lessonNo+'课 · 第'+escapeHtml(c.question)+'题 · '+v2CorrectionStatus(c.status)+'</summary><pre>'+escapeHtml(JSON.stringify(c.attempts || [],null,2))+'</pre></details>').join('')+
    '<h4>课程关卡</h4>'+(gates || '<p class="hint">暂无关卡记录</p>')+'<h4>反馈时间线</h4>'+feedbacks.map(({s,f})=>'<details><summary>'+v2Date(f.sentAt || f.generatedAt)+' · 第'+s.lesson.lessonNo+'课 · '+v2FeedbackStatus(f)+'</summary><p class="preserve-lines">'+escapeHtml(f.text)+'</p>'+(f.versions || []).map(old=>'<p class="hint">旧版 '+v2Date(old.at)+' · '+escapeHtml(old.reason)+'</p><pre>'+escapeHtml(old.text)+'</pre>').join('')+'</details>').join(''));
  v2Action('[data-profile-session]',el=>{d.close();v2Select(state.sessions[el.dataset.profileSession].lesson,'scores');},d);
}
function scoresView(){
  const s=v2Session(),points=s.scoring.mode==='points';
  return v2Card('本次成绩','<div class="actions">'+v2Filter('scores')+'<button class="ghost" data-density>'+(wbUI().density==='compact'?'舒适模式':'紧凑模式')+'</button><button class="secondary" data-score-undo '+(v2.undo.length?'':'disabled')+'>撤销上次编辑</button><button class="ghost" data-v2-revisions>修订记录</button></div><p class="hint">输入自动存草稿；确认后才进入成长档案。支持表格多格粘贴预览、Tab横向、Enter向下。空分数不当作零分。</p>', '<button class="primary" data-save-score-archive>确认成绩</button>')+
    v2Card('评分方式','<div class="v2-fields"><label>本卷评分方式<select data-score-mode><option value="legacy" '+(!points?'selected':'')+'>原有扣分规则</option><option value="points" '+(points?'selected':'')+'>每题 / 步骤给分</option></select></label><span>满分 '+state.lesson.maxScore+' 分'+(!points?' · 每错题扣 '+state.lesson.penalty+' 分':'')+'</span>'+(points?'<button class="secondary" data-rubric-edit>编辑题目与步骤分</button><button class="secondary" data-rubric-confirm>确认评分标准</button><span>'+(s.scoring.confirmed?'标准已确认':'标准待确认')+'</span>':'')+'</div>')+
    v2Card('学生成绩',points?v2PointsTable():scoreTable())+'<details class="section"><summary>表格导入与导出</summary><div class="actions">'+v2UploadControl('data-score-csv-import','导入成绩 CSV','.csv')+'<button class="secondary" data-score-csv-export>导出当前成绩 CSV</button></div><p class="hint">支持学生ID精确对应；仅有姓名时，同名记录不会自动匹配。导入先预览，确认记录不会被覆盖。</p></details>'+v2History();
}
function scoreTable(rows=state.scores,options={}){
  let html=viewsOriginal.scoreTable(rows,options);
  rows.forEach((r,i)=>{html=html.replace('<td class="student-name-cell">'+escapeHtml(r.name)+'</td>','<td class="student-name-cell"><button class="ghost student-profile-link" data-v2-profile="'+r.studentId+'">'+escapeHtml(v2Name(r.studentId,r.name))+'</button></td>');});
  let index=0;html=html.replace(/<tr>\s*<td class="student-name-cell">/g,()=>{const r=rows[index++];return '<tr data-search-row="scores" data-search-text="'+escapeAttr(v2Name(r.studentId,r.name))+'"><td class="student-name-cell">';});
  return html;
}
function v2PointsTable(){
  const questions=state.scoring.questions,parts=questions.flatMap(q=>q.steps?.length?q.steps.map((s,i)=>({key:q.id+'::'+i,label:q.id+' · '+s.label,max:s.points})): [{key:q.id,label:q.id,max:q.points}]);
  if(!parts.length)return v2Empty('先编辑并确认每道题目的分值，再开始录入');
  return '<div class="table-wrap v2-points-table"><table style="table-layout:fixed;width:'+(parts.length*110+260)+'px"><thead><tr><th>姓名</th>'+parts.map(p=>'<th>'+escapeHtml(p.label)+'<small>满分 '+p.max+'</small></th>').join('')+'<th>总分</th><th>出勤</th></tr></thead><tbody>'+state.scores.map((r,i)=>'<tr data-search-row="scores" data-search-text="'+escapeAttr(v2Name(r.studentId,r.name))+'"><td><button class="ghost" data-v2-profile="'+r.studentId+'">'+escapeHtml(v2Name(r.studentId,r.name))+'</button></td>'+parts.map(p=>'<td><input class="score-input" data-point-student="'+r.studentId+'" data-point-key="'+escapeAttr(p.key)+'" data-point-max="'+p.max+'" aria-label="'+escapeAttr(r.name+' 第'+p.label+'题得分')+'" inputmode="decimal" value="'+escapeAttr(state.scoring.grades[r.studentId]?.[p.key] ?? '')+'"></td>').join('')+'<td data-point-total="'+r.studentId+'">'+(r.status==='请假'?'—':Domain.pointsScore(v2Session(),r.studentId).sum)+'</td><td><select data-attendance="'+i+'"><option value="A">在场</option><option value="请假" '+(r.status==='请假'?'selected':'')+'>请假</option></select></td></tr>').join('')+'</tbody></table></div>';
}
function v2PushUndo(){const prev={sessionId:state.sessionId,scores:Domain.clone(state.scores),scoring:Domain.clone(state.scoring)};v2.undo.push(prev);if(v2.undo.length>25)v2.undo.shift();}
function v2ExportScores(){
  const keys=state.scoring.mode==='points'?state.scoring.questions.flatMap(q=>q.steps?.length?q.steps.map((s,i)=>q.id+'::'+i):[q.id]):[];
  const rows=[['学生ID','姓名','课前测','作业等级','作业错题数量',...keys.map(k=>'步骤分:'+k)],...state.scores.map(r=>[r.studentId,v2Name(r.studentId,r.name),r.score,r.status,r.homeworkWrong,...keys.map(k=>state.scoring.grades[r.studentId]?.[k] ?? '')])];
  downloadText(safeName(currentLessonLabel())+'-成绩.csv',toCsv(rows),'text/csv;charset=utf-8');
}
async function v2ImportScores(file){
  const sid=state.sessionId,[headers,...data]=parseCsv(await readCsvFile(file));if(sid!==state.sessionId)throw new Error('课次已变化，请回到原课次重新导入');
  if(!headers?.some(h=>['姓名','学生ID'].includes(h)))throw new Error('CSV表头须包含姓名或学生ID');
  const at=name=>headers.indexOf(name),seen=new Set(),keys=state.scoring.questions.flatMap(q=>q.steps?.length?q.steps.map((s,i)=>({key:q.id+'::'+i,max:s.points})):[{key:q.id,max:q.points}]);
  const rows=data.filter(r=>r.some(Boolean)).map((cells,index)=>{
    const id=cells[at('学生ID')],name=cells[at('姓名')],matches=state.scores.filter(r=>id?r.studentId===id:v2Name(r.studentId,r.name)===name),row=matches.length===1?matches[0]:null;let error='';
    if(!row)error='姓名无法唯一对应或不在本课次';else if(seen.has(row.studentId))error='同一学生重复出现';else seen.add(row.studentId);
    const score=cells[at('课前测')] ?? cells[at('得分')] ?? '',grades={};
    if(score!==''&&(!Number.isFinite(Number(score))||Number(score)<0||Number(score)>state.lesson.maxScore))error='得分超出本卷范围';
    if(state.scoring.mode==='points')for(const k of keys){const col=at('步骤分:'+k.key),value=cells[col];if(col<0||value===undefined||value!==''&&(!Number.isFinite(Number(value))||Number(value)<0||Number(value)>k.max))error='步骤分列缺失或越界';else grades[k.key]=value;}
    const status=cells[at('作业等级')] || row?.status || 'A';if(!['S','A','B','请假','未完成'].includes(status))error='作业等级无效';
    return {row,name:name || row?.name || '第'+(index+2)+'行',score,status,homeworkWrong:cells[at('作业错题数量')] ?? row?.homeworkWrong ?? '',grades,error};
  });
  const d=v2Dialog('成绩导入预览','<p>共 '+rows.length+' 行，'+rows.filter(r=>r.error).length+' 行需修正。仅勾选项目写入草稿；不会替换已确认历史。</p>'+rows.map((r,i)=>'<label class="roster-preview-row"><input type="checkbox" data-csv-row="'+i+'" '+(r.error?'disabled':'checked')+'>'+escapeHtml(r.name)+' · '+escapeHtml(r.error || r.score || '空成绩')+'</label>').join('')+'<button class="primary" data-csv-apply>确认导入选中行</button>');
  v2Action('[data-csv-apply]',async()=>{if(sid!==state.sessionId)throw new Error('原课次已变化，请重新导入');await v2Flush();await Api.request('/api/backups',{kind:'before-score-import',manual:false});v2PushUndo();let count=0;for(const el of d.querySelectorAll('[data-csv-row]:checked')){const r=rows[Number(el.dataset.csvRow)];if(r.error)continue;Object.assign(r.row,{score:r.score,status:r.status,homeworkWrong:r.homeworkWrong});if(state.scoring.mode==='points'){state.scoring.grades[r.row.studentId]=r.grades;const total=Domain.pointsScore(v2Session(),r.row.studentId);r.row.score=total.complete?String(total.sum):'';}count++;}saveState();await v2Flush();d.close();render();toast('已导入 '+count+' 行草稿，请校对后确认成绩');},d);
}
function bindScores(){
  v2Action('[data-score-csv-export]',v2ExportScores);
  v2On('[data-score-csv-import]','change',async(e,el)=>{if(el.files[0])await v2ImportScores(el.files[0]);});
  v2Action('[data-save-score-archive]',async()=>{await v2Confirm('scores');});
  v2Action('[data-score-undo]',()=>{const prev=v2.undo.pop();if(!prev)return;if(prev.sessionId!==state.sessionId){toast('上次编辑属于其他课次，不应用到当前课次');return;}state.scores=prev.scores;state.scoring=prev.scoring;saveState();render();});
  v2On('[data-score-mode]','change',async(e,el)=>{if(!await wbConfirm('切换本卷评分方式','已有录入与原版确认记录保留。重新确认成绩前需要完成新模式的校验。','切换')){el.value=state.scoring.mode;return;}state.scoring.mode=el.value;state.scoring.confirmed=false;saveState();render();});
  v2Action('[data-rubric-edit]',v2RubricEditor);
  v2Action('[data-rubric-confirm]',()=>v2Confirm('scoring'));
  v2On('[data-score],[data-homework-wrong],[data-point-key]','focus',()=>v2PushUndo());
  v2On('[data-score]','input',(e,el)=>{const i=Number(el.dataset.score),n=Number(el.value),valid=el.value===''||Number.isFinite(n)&&n>=0&&n<=Number(state.lesson.maxScore);el.classList.toggle('field-error',!valid);el.setAttribute('aria-invalid',String(!valid));el.title=valid?'':'请输入0至'+state.lesson.maxScore+'分';state.scores[i].score=el.value;saveState();updateScoreAverageDisplay();updateScoreWrongUnitDisplay(i);});
  v2On('[data-score-status],[data-attendance]','change',(e,el)=>{state.scores[Number(el.dataset.scoreStatus ?? el.dataset.attendance)].status=el.value;saveState();});
  v2On('[data-homework-wrong]','input',(e,el)=>{const row=state.scores[Number(el.dataset.homeworkWrong)];row.homeworkWrong=el.value;const grade=homeworkGradeForWrongCount(el.value);if(grade){row.status=grade;const select=document.querySelector('[data-score-status="'+el.dataset.homeworkWrong+'"]');if(select)select.value=grade;}saveState();});
  v2On('[data-point-key]','input',(e,el)=>{const sid=el.dataset.pointStudent,key=el.dataset.pointKey;(state.scoring.grades[sid] ||= {})[key]=el.value;const n=Number(el.value),valid=el.value===''||Number.isFinite(n)&&n>=0&&n<=Number(el.dataset.pointMax);el.classList.toggle('field-error',!valid);el.setAttribute('aria-invalid',String(!valid));const result=Domain.pointsScore(v2Session(),sid),row=state.scores.find(r=>r.studentId===sid);row.score=result.complete&&!result.errors.length?String(result.sum):'';document.querySelector('[data-point-total="'+sid+'"]').textContent=String(result.sum)+(result.complete?'':'（未全）');saveState();});
}
function v2RubricEditor(){
  const d=v2Dialog('每题与步骤分','<p class="hint">一行一道题：题号 | 分值 | 步骤名称:分值;步骤名称:分值。小问使用1-1、1-2等独立题号。不填写步骤即按整题给分。合计须等于本卷满分。</p><textarea data-rubric rows="12" aria-label="评分标准">'+escapeHtml(state.scoring.questions.map(q=>q.id+' | '+q.points+' | '+(q.steps || []).map(s=>s.label+':'+s.points).join(';')).join('\n'))+'</textarea><p data-rubric-errors class="inline-error" hidden></p><button class="primary" data-rubric-save>保存评分草稿</button>');
  v2Action('[data-rubric-save]',()=>{
    const questions=d.querySelector('[data-rubric]').value.split('\n').map(s=>s.trim()).filter(Boolean).map(line=>{const [id,pts,steps]=line.split('|').map(s=>s.trim());return {id,points:Number(pts),steps:steps?steps.split(/[;；]/).filter(Boolean).map(part=>{const [label,n]=part.split(/[:：]/);return {label:label.trim(),points:Number(n)};}):[]};});
    const session=Domain.clone(v2Session());session.scoring={...session.scoring,questions,confirmed:false};const errors=Domain.validateScoring(session);
    if(errors.length){const target=d.querySelector('[data-rubric-errors]');target.textContent=errors.join('；');target.hidden=false;return;}
    state.scoring.questions=questions;state.scoring.confirmed=false;state.lesson.questionSpec=questions.map(q=>q.id).join(',');saveState();d.close();render();
  },d);
}
function v2BindPaste(){
  document.querySelectorAll('table').forEach(tableRoot=>tableRoot.addEventListener('paste',async e=>{const input=e.target.closest('input');if(!input)return;
    const text=e.clipboardData?.getData('text/plain') || '';if(!/[\t\n]/.test(text))return;e.preventDefault();
    const start=input.closest('td'),row=input.closest('tr'),table=input.closest('table'),rows=[...table.tBodies[0].rows],r0=rows.indexOf(row),c0=[...row.cells].indexOf(start),values=text.trimEnd().split(/\r?\n/).map(line=>line.split('\t')),changes=[],outside=[];
    values.forEach((line,ri)=>line.forEach((value,ci)=>{const field=rows[r0+ri]?.cells[c0+ci]?.querySelector('input:not([disabled])');if(field)changes.push({field,value});else outside.push([ri+1,ci+1]);}));
    if(!await wbConfirm('粘贴预览','即将填入 '+changes.length+' 个单元格'+(outside.length?'；'+outside.length+' 个单元格超出可填写区域，不会写入':'')+'。首行：'+values[0].join(' / '),'确认粘贴'))return;
    v2PushUndo();for(const {field,value}of changes){field.value=value;field.dispatchEvent(new Event('input',{bubbles:true}));}toast('已粘贴 '+changes.length+' 格，请检查红色标记');
  }));
}
function v2FeedbackStatus(f){return f.completedAt?'已完成':f.followupAt?'待跟进':f.sentAt?'已发送':f.copiedAt?'已复制':f.generatedAt?'已生成':'草稿';}
function v2BindExports(){
  const labels={knowledge:'导出题目解析 CSV',wrongbook:'导出错题明细 CSV',feedback:'下载全部反馈 TXT'};
  if(!labels[state.active])return;const content=document.querySelector('[data-view-content]');if(!content||content.querySelector('[data-v2-export-content]'))return;
  const warnings=state.active==='knowledge'?v2.materials.filter(m=>state.materialIds.includes(m.id)).flatMap(m=>(m.meta.extracts || []).flatMap(e=>(e.warnings || []).map(w=>m.name+' 第'+e.page+'页：'+w))):state.active==='wrongbook'?state.wrongbook.rows.flatMap(r=>(r.recognitionWarnings || []).map(w=>r.name+'：'+w)):[];
  if(warnings.length){const note=document.createElement('section');note.className='section inline-error';note.innerHTML='<h3>需人工检查的识别问题</h3>'+warnings.map(w=>'<p>'+escapeHtml(w)+'</p>').join('');content.prepend(note);}
  const block=document.createElement('details');block.className='section';block.innerHTML='<summary>导出与留存</summary><button class="secondary" data-v2-export-content>'+labels[state.active]+'</button>';content.append(block);
  v2Action('[data-v2-export-content]',()=>{
    if(state.active==='feedback'){downloadText(safeName(currentLessonLabel())+'-全部反馈.txt',state.feedbacks.map(f=>v2Name(f.studentId,f.name)+' · '+v2FeedbackStatus(f)+'\n'+f.text).join('\n\n────────\n\n'),'text/plain;charset=utf-8');return;}
    const rows=state.active==='knowledge'?[['题号','标准答案','解析','资料ID','页码'],...Object.entries(state.knowledge).map(([q,a])=>[q,a.answer,a.explanation,a.materialId,a.page])]:[['学生ID','姓名','原测得分',...state.wrongbook.columns],...state.wrongbook.rows.map(r=>[r.studentId,v2Name(r.studentId,r.name),r.score,...state.wrongbook.columns.map(q=>r.answers[q] || '')])];
    downloadText(safeName(currentLessonLabel())+'-'+(state.active==='knowledge'?'解析':'错题')+'.csv',toCsv(rows),'text/csv;charset=utf-8');
  });
  if(state.active==='feedback')document.querySelectorAll('.feedback-editor').forEach(el=>{const resize=()=>{el.style.height='auto';el.style.height=Math.max(280,el.scrollHeight+4)+'px';};resize();el.addEventListener('input',resize);});
}
function feedbackView(){
  const session=v2Session(),source=Domain.sourceVersion(session),missing=Domain.feedbackQueue(session).length,readiness=Domain.feedbackReadiness(session),sent=state.feedbacks.filter(f=>f.sentAt).length;
  return v2Card('反馈与跟进','<p class="hint">批量操作只补缺少的反馈，保留你已写好的内容。缺考、未录分的学生不自动生成。</p>'+(!readiness.ready?'<div class="teaching-prerequisites">'+readiness.reasons.map(r=>'<button class="secondary" data-teaching-go="'+r.view+'">'+r.text+' →</button>').join('')+'</div>':'')+'<div class="actions">'+v2Filter('feedback')+'<select data-feedback-filter aria-label="反馈状态"><option value="">全部反馈</option><option value="unsent">待发送</option><option value="copied">已复制未发送</option><option value="stale">来源需更新</option><option value="sent">已发送</option></select><button class="secondary" data-feedback-add>手写反馈</button><button class="ghost" data-feedback-followup>新增跟进</button></div><p class="hint">已生成 '+state.feedbacks.length+' 人 · 已发送 '+sent+' 人 · <span data-feedback-visible>显示 '+state.feedbacks.length+' 人</span></p>', '<button class="primary" data-generate-feedback '+(!readiness.ready||!missing?'disabled':'')+'>'+(missing?'生成缺少的 '+missing+' 人反馈':state.feedbacks.length?'反馈已齐全':'暂无可生成的反馈')+'</button>')+
    state.feedbacks.map((f,i)=>'<article class="section v2-feedback" data-search-row="feedback" data-feedback-status="'+v2FeedbackFlag(f)+'" data-search-text="'+escapeAttr(v2Name(f.studentId,f.name))+'"><div class="section-title-row"><div><h3><button class="ghost" data-v2-profile="'+f.studentId+'">'+escapeHtml(v2Name(f.studentId,f.name))+'</button></h3><p class="hint">'+escapeHtml(f.scoreText || '')+' · <span data-feedback-state>'+v2FeedbackStatus(f)+'</span></p></div><button class="primary" data-feedback-copy="'+i+'">'+(f.copiedAt?'再次复制':'复制全文')+'</button></div>'+(f.sourceVersion&&f.sourceVersion!==source?'<p class="inline-error">来源已修订，请核对后更新此人反馈；已发送旧版仍保留。</p>':'')+'<label class="field"><span class="sr-only">反馈正文</span><textarea class="feedback-editor" data-feedback-text="'+i+'" aria-label="'+escapeAttr(f.name+'的反馈正文')+'">'+escapeHtml(f.text || '')+'</textarea></label><div class="actions"><button class="secondary" data-feedback-sent="'+i+'" '+(f.sentAt?'disabled':'')+'>'+(f.sentAt?'已发送':'标记已发送')+'</button><button class="ghost" data-feedback-next="'+i+'">下一位待发送 →</button><details class="feedback-more"><summary>更多操作</summary><div class="actions"><button class="ghost" data-feedback-regenerate="'+i+'">重新生成此人</button><button class="ghost" data-feedback-revisions="'+i+'">历史版本 '+(f.versions?.length || 0)+'</button></div></details></div></article>').join('')+(state.feedbacks.length?'':v2Empty(!readiness.ready?'完成上方提示的确认步骤，即可生成反馈。':missing?'点击“生成缺少的 '+missing+' 人反馈”，每位学生生成后会单独保存。':'尚无已录分的学生，请先填写并确认实际测评成绩。'))+
    v2Card('跟进事项',state.followups.map((f,i)=>'<div class="v2-followup"><strong>'+escapeHtml(v2Name(f.studentId))+'</strong><p>'+escapeHtml(f.note)+'</p><small>计划 '+escapeHtml(f.dueAt || '未指定')+' · '+(f.completedAt?'已完成 '+v2Date(f.completedAt):'待跟进')+'</small>'+(f.completedAt?'<p>'+escapeHtml(f.result || '')+'</p>':'<button class="secondary" data-followup-complete="'+i+'">教师确认已跟进</button>')+'</div>').join('') || v2Empty('暂无跟进事项'))+v2History();
}
function v2PreserveFeedback(f,reason){f.versions ||= [];f.versions.push({text:f.text,at:new Date().toISOString(),sentAt:f.sentAt,sourceVersion:f.sourceVersion,reason});if(f.versions.length>500)throw new Error('此反馈历史版本过多，请先导出记录');}
function bindFeedback(){
  v2Action('[data-generate-feedback]',()=>v2GenerateFeedbacks());
  v2Action('[data-feedback-regenerate]',async el=>{const f=state.feedbacks[Number(el.dataset.feedbackRegenerate)];if(!await wbConfirm('重新生成 · '+v2Name(f.studentId),'将根据已确认成绩重新生成此人反馈，现有文字保留在历史版本中。','重新生成此人'))return;await v2GenerateFeedbacks(f.studentId,true);});
  const filter=document.querySelector('[data-feedback-filter]');if(filter)filter.value=wbUI().filters[state.sessionId+'|feedbackStatus'] || '';
  v2On('[data-feedback-filter]','change',(e,el)=>{wbUI().filters[state.sessionId+'|feedbackStatus']=el.value;v2ApplyFilter(document.querySelector('[data-v2-filter="feedback"]'));saveState();});
  v2On('[data-feedback-text]','focus',(e,el)=>{el.dataset.before=el.value;el.dataset.wasSent=String(!!state.feedbacks[Number(el.dataset.feedbackText)].sentAt);delete el.dataset.preserved;});
  v2On('[data-feedback-text]','input',(e,el)=>{
    const f=state.feedbacks[Number(el.dataset.feedbackText)];if(f.sentAt&&!el.dataset.preserved){v2PreserveFeedback(f,'修改已发送内容');delete f.sentAt;delete f.copiedAt;el.dataset.preserved='true';}
    f.text=el.value;f.editedAt=new Date().toISOString();delete f.copiedAt;saveState();const card=el.closest('article');card.dataset.feedbackStatus=v2FeedbackFlag(f);card.querySelector('[data-feedback-state]').textContent='编辑草稿 · 自动保存';const sentButton=card.querySelector('[data-feedback-sent]');sentButton.disabled=false;sentButton.textContent='标记已发送';card.querySelector('[data-feedback-copy]').textContent='复制全文';
  });
  v2On('[data-feedback-text]','change',async(e,el)=>{
    const f=state.feedbacks[Number(el.dataset.feedbackText)];if(el.dataset.before===el.value)return;
    const reason=el.dataset.wasSent==='true'?await v2Prompt('保存反馈修订原因','草稿已自动保存；请补充本次已发送内容的修改原因。','教师调整反馈表述',true):'教师编辑反馈草稿';
    f.versions ||= [];f.versions.push({text:el.dataset.before,reason:reason || '修改原因待补充',at:new Date().toISOString()});f.editReason=reason || '修改原因待补充';saveState();
  });
  v2Action('[data-feedback-copy]',async el=>{const f=state.feedbacks[Number(el.dataset.feedbackCopy)];if(!f.text?.trim())throw new Error('反馈正文为空');await wbCopyText(f.text);f.copiedAt=new Date().toISOString();saveState();el.textContent='已复制';el.closest('article').dataset.feedbackStatus=v2FeedbackFlag(f);el.closest('article').querySelector('[data-feedback-state]').textContent=v2FeedbackStatus(f);toast('已复制 '+v2Name(f.studentId)+' 的反馈；发给家长后再标记已发送');});
  v2Action('[data-feedback-sent]',async el=>{const f=state.feedbacks[Number(el.dataset.feedbackSent)];if(f.sentAt)return;if(!f.text?.trim())throw new Error('反馈正文为空');v2PreserveFeedback(f,'教师确认已发送');f.sentAt=new Date().toISOString();f.sentText=f.text;saveState();await v2Flush();render();toast('已记录 '+v2Name(f.studentId)+' 的发送状态');});
  v2Action('[data-feedback-next]',el=>{const index=Number(el.dataset.feedbackNext),indices=state.feedbacks.map((_,i)=>i),next=indices.slice(index+1).concat(indices.slice(0,index)).find(i=>!state.feedbacks[i].sentAt);if(next===undefined){toast('其他反馈均已标记发送');return;}wbUI().filters[state.sessionId+'|feedbackStatus']='unsent';wbUI().filters[state.sessionId+'|feedback']='';saveState();render();const card=document.querySelector('[data-feedback-copy="'+next+'"]')?.closest('article');card?.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});card?.querySelector('[data-feedback-copy]').focus({preventScroll:true});});
  v2Action('[data-feedback-revisions]',el=>{const f=state.feedbacks[Number(el.dataset.feedbackRevisions)];v2Dialog('反馈历史版本',(f.versions || []).slice().reverse().map(r=>'<details><summary>'+v2Date(r.at)+' · '+escapeHtml(r.reason)+'</summary><pre>'+escapeHtml(r.text)+'</pre></details>').join('') || v2Empty('尚无历史版本'));});
  v2Action('[data-feedback-add]',()=>v2PickStudent('新建反馈',async sid=>{let index=state.feedbacks.findIndex(f=>f.studentId===sid);if(index<0){state.feedbacks.push({id:crypto.randomUUID(),studentId:sid,name:v2Name(sid),text:v2Name(sid)+'家长您好，',versions:[],createdAt:new Date().toISOString()});index=state.feedbacks.length-1;}wbUI().filters[state.sessionId+'|feedbackStatus']='';wbUI().filters[state.sessionId+'|feedback']='';saveState();render();const input=document.querySelector('[data-feedback-text="'+index+'"]');input?.scrollIntoView({block:'center'});input?.focus({preventScroll:true});}));
  v2Action('[data-feedback-followup]',()=>v2PickStudent('新增跟进事项',sid=>v2AddFollowup(sid)));
  v2Action('[data-followup-complete]',async el=>{const f=state.followups[Number(el.dataset.followupComplete)],result=await v2Prompt('确认已跟进','填写处理结果与沟通备注。完成时间将自动记录。','',true);if(result===null)return;f.result=result;f.completedAt=new Date().toISOString();const feedback=state.feedbacks.find(x=>x.studentId===f.studentId);if(feedback){if(state.followups.some(x=>x.studentId===f.studentId&&!x.completedAt))delete feedback.completedAt;else feedback.completedAt=f.completedAt;}saveState();await v2Flush();render();});
}
function v2FeedbackFlag(f){return f.sourceVersion&&f.sourceVersion!==Domain.sourceVersion(v2Session())?'stale':f.sentAt?'sent':f.copiedAt?'copied':'draft';}
function v2PickStudent(title,fn){const d=v2Dialog(title,'<label>选择学生<select data-pick-student>'+Domain.activeStudents(state,currentGrade().id).map(s=>'<option value="'+s.id+'">'+escapeHtml(s.name)+' · '+s.id.slice(-6)+'</option>').join('')+'</select></label><button class="primary" data-pick-confirm>继续</button>');v2Action('[data-pick-confirm]',async()=>{const id=d.querySelector('select').value;if(!id)throw new Error('请先建立学生档案');d.close();await fn(id);},d);}
function v2AddFollowup(sid){const d=v2Dialog('跟进 · '+v2Name(sid),'<label>计划处理时间<input type="datetime-local" data-followup-time></label><label>需要跟进的事项<textarea data-followup-note required></textarea></label><button class="primary" data-followup-save>保存跟进事项</button>');v2Action('[data-followup-save]',()=>{const note=d.querySelector('textarea').value.trim();if(!note)throw new Error('请填写跟进事项');state.followups.push({id:crypto.randomUUID(),studentId:sid,note,dueAt:d.querySelector('input').value,createdAt:new Date().toISOString()});const f=state.feedbacks.find(f=>f.studentId===sid);if(f){f.followupAt=new Date().toISOString();delete f.completedAt;}saveState();d.close();render();},d);}
function v2CorrectionStatus(status){return {pending:'待订正',review:'待教师复核',failed:'需再次订正',passed:'已通过'}[status] || '待订正';}
function v2CorrectionsView(){
  const filter=wbUI().correctionFilter, student=filter?.sessionId===state.sessionId?filter.studentId:'';
  const items=state.corrections.map((c,i)=>({c,i})).filter(({c})=>!student||c.studentId===student);
  const filterLabel=student?'<div class="actions"><span class="hint">当前仅看 '+escapeHtml(v2Name(student))+'</span><button type="button" class="ghost" data-corrections-view-all>查看全班</button><button type="button" class="ghost" data-corrections-back-diagnosis>返回逐生诊断</button></div>':'';
  return v2Card('错题订正与复核','<p class="hint">订正任务来自本课次已确认错题。每次提交和教师判断都会留存，订正不改原测成绩。</p><button class="primary" data-corrections-create>从已确认错题创建任务</button>'+filterLabel+(items.length?'':'<p class="hint">当前没有订正任务。</p>'))+items.map(({c,i})=>'<article class="section"><div class="section-title-row"><h3>'+escapeHtml(v2Name(c.studentId))+' · 第'+escapeHtml(c.question)+'题</h3><span class="status-pill">'+v2CorrectionStatus(c.status)+'</span></div><p>原答：'+escapeHtml(c.originalAnswer)+'　标准答案：'+escapeHtml(c.standard.answer || '需教师核实')+'</p>'+(c.materialId?'<a href="/api/materials/'+c.materialId+'/file#page='+(c.page || 1)+'" target="_blank" rel="noopener">打开原题 · 第'+(c.page || 1)+'页</a>':'<p class="hint">旧记录未保存原卷，可回到拆卷页补传。</p>')+'<label>订正作答<textarea data-correction-draft="'+i+'" '+(['passed','review'].includes(c.status)?'disabled':'')+'>'+escapeHtml(c.draft || '')+'</textarea></label><div class="actions"><button class="primary" data-correction-submit="'+i+'" '+(['passed','review'].includes(c.status)?'disabled':'')+'>提交订正</button>'+(c.status==='review'?'<button class="secondary" data-correction-review="'+i+'">教师复核</button>':'')+'</div><details><summary>历次订正 · '+(c.attempts?.length || 0)+' 次</summary>'+(c.attempts || []).map(a=>'<div class="correction-attempt"><p>'+v2Date(a.at)+' · '+v2CorrectionStatus(a.status)+'</p><pre>'+escapeHtml(a.answer)+'</pre><p>'+escapeHtml(a.reason || '')+'</p></div>').join('')+'</details></article>').join('');
}
function v2BindCorrections(){
  v2Action('[data-corrections-view-all]',()=>{delete wbUI().correctionFilter;render();});
  v2Action('[data-corrections-back-diagnosis]',()=>{
    const student=wbUI().correctionFilter?.studentId;
    if(student)wbUI().focusStudent=student;
    wbUI().wrongbookTab='diagnosis';render();
  });
  v2Action('[data-corrections-create]',async()=>{
    const session=v2Session(), filter=wbUI().correctionFilter;
    const studentId=filter?.sessionId===session.id?filter.studentId:'';
    const result=await v2Mutation('/api/physics-exam/assessments/'+encodeURIComponent(session.id)+'/diagnosis/corrections',
      {studentId,confirmationVersion:session.confirmations.wrongbook?.version});
    if(state.sessionId!==session.id)return;
    render();toast('新建 '+result.created+' 项订正任务，已有 '+result.existing+' 项');
  });
  v2On('[data-correction-draft]','input',(e,el)=>{state.corrections[Number(el.dataset.correctionDraft)].draft=el.value;saveState();});
  v2Action('[data-correction-submit]',async el=>{const c=state.corrections[Number(el.dataset.correctionSubmit)];if(c.status==='review'||c.status==='passed')throw new Error('本次订正已提交，请等待复核');if(!c.draft.trim())throw new Error('请填写订正作答');c.attempts.push({id:crypto.randomUUID(),answer:c.draft,at:new Date().toISOString(),status:'review'});c.status='review';saveState();await v2Flush();render();toast('已提交，等待教师核对原题与标准答案');});
  v2Action('[data-correction-review]',el=>v2CorrectionReview(Number(el.dataset.correctionReview)));
}
function v2CorrectionReview(index){const c=state.corrections[index],d=v2Dialog('教师复核订正','<p>'+escapeHtml(v2Name(c.studentId))+' · 第'+escapeHtml(c.question)+'题</p><pre>'+escapeHtml(c.attempts.at(-1)?.answer || '')+'</pre><p>原标准答案：'+escapeHtml(c.standard.answer || '未录入，请核对原卷')+'</p><label>复核依据<textarea data-correction-reason required></textarea></label><div class="actions"><button class="secondary" data-correction-verdict="failed">要求再次订正</button><button class="primary" data-correction-verdict="passed">符合标准，确认通过</button></div>');
  v2Action('[data-correction-verdict]',async el=>{const reason=d.querySelector('textarea').value.trim();if(!reason)throw new Error('请填写复核依据');c.status=el.dataset.correctionVerdict;Object.assign(c.attempts.at(-1),{status:c.status,reason,reviewedAt:new Date().toISOString()});saveState();await v2Flush();d.close();render();toast('复核结果已保存，原测成绩未改动');},d);
}
function v2SearchDialog(){
  const d=v2Dialog('搜索学生与历史课次','<input type="search" autofocus data-global-search aria-label="搜索学生与课次" placeholder="输入姓名、班级、学期或课次"><div data-search-results></div>'),input=d.querySelector('input'),results=d.querySelector('[data-search-results]');
  const search=()=>{const term=input.value.trim().toLowerCase();results.innerHTML=Object.values(state.students).filter(s=>(s.name+' '+(state.grades.find(g=>g.id===s.gradeId)?.name || '')).toLowerCase().includes(term)).slice(0,30).map(s=>'<button class="v2-todo ghost" data-search-student="'+s.id+'">'+escapeHtml(s.name)+' · '+escapeHtml(state.grades.find(g=>g.id===s.gradeId)?.name || '')+'</button>').join('')+Object.values(state.sessions).filter(s=>(s.lesson.year+s.lesson.term+'第'+s.lesson.lessonNo+'课').includes(term)).slice(0,20).map(s=>'<button class="v2-todo ghost" data-search-session="'+escapeAttr(s.id)+'">'+escapeHtml((state.grades.find(g=>g.id===s.lesson.gradeId)?.name || '')+' '+s.lesson.year+s.lesson.term+' 第'+s.lesson.lessonNo+'课')+'</button>').join('');v2Action('[data-search-student]',el=>{d.close();v2Profile(el.dataset.searchStudent);},results);v2Action('[data-search-session]',el=>{d.close();v2Select(state.sessions[el.dataset.searchSession].lesson,'scores');},results);};input.oninput=search;search();input.focus();
}
async function persistAgentMemory(memory){state.agent.memory=memory;saveState();await v2Flush();return {memory};}
async function ensureAgentMemoryLoaded(){agentMemoryLoaded=true;return state.agent.memory;}
function wbSafeDuringJob(el){return !!el.closest('[data-nav],[data-collapse],[data-v2-jobs],[data-v2-cancel],[data-v2-filter],summary,[data-wb-notice-close]');}
function aiView(){
  const local=v2.health?.aiProvider==='ollama';
  return v2Card('本机 AI 连接','<p class="hint">'+(local?'通用文字和试卷识图使用本机模型。试卷识别结果需要教师校对。':'沿用服务端的模型配置。')+'</p>'+
    '<div class="v2-health"><span>文字 <strong>'+escapeHtml(v2.health?.model || '读取配置中')+'</strong></span>'+
    (v2.health?.visionModel?'<span>识图 <strong>'+escapeHtml(v2.health.visionModel)+'</strong></span>':'')+
    '</div><p class="hint" role="status" data-ai-model-status>正在检查本机模型…</p>'+aiProgressView('config','连接测试')+
    '<div class="actions"><button class="primary" data-ai-test>测试文字生成</button><button class="secondary" data-ai-refresh>刷新模型状态</button></div>')+
    v2Card('课堂反馈 · DeepSeek API','<p class="hint">课堂录音在本机转写。分析时，工作台会把去除个人信息的课堂讲解发送给 DeepSeek。连接后可生成家长反馈、复习图和朋友圈图文。</p>'+
      '<form data-lesson-ai-form><label class="field">DeepSeek API Key<input name="apiKey" type="password" autocomplete="off" spellcheck="false" maxlength="256" required></label>'+
      '<div class="actions"><button type="submit" class="primary">测试并启用课堂分析</button></div></form>'+
      '<p class="hint" role="status" data-lesson-ai-status>正在检查课堂模型…</p>')+
    v2Card('数据健康与恢复','<button class="secondary" data-v2-backups>完整备份与恢复</button><p class="hint">当前服务版本 '+v2.serverRevision+' · SQLite事务保存 · 仅监听本机地址</p>');
}
function bindAi(){
  const refresh=async()=>{
    const info=document.querySelector('[data-ai-model-status]');
    if(!info)return;
    try{
      const s=await Api.request('/api/ai/status');
      if(!info.isConnected)return;
      if(s.provider!=='ollama'){info.textContent='模型服务已配置。点「测试文字生成」确认连接。';return;}
      if(!s.online){info.textContent='本机模型服务未启动。';return;}
      const current=s.selectedModel;
      const status=current?'文字模型已就绪：'+current+(current!==s.model?'（轻量版）':''):'文字模型尚未下载完成';
      const scan=s.visionMode==='vision'?'试卷识图模型已就绪。':s.visionMode==='ocr'?'可识别扫描卷的印刷文字。图形和不清晰的笔迹需要人工校对。':'试卷识图尚未就绪，可先使用 PDF 文字层或手工校对。';
      info.textContent=status+'。'+scan;
    }catch(error){if(info.isConnected)info.textContent='暂时无法检查模型状态：'+error.message;}
  };
  refresh();
  bindLessonAi();
  v2Action('[data-ai-refresh]',refresh);
  v2Action('[data-ai-test]',async()=>{await wbRunJob('测试AI连接',async()=>{setAiProgress('config',0,1,'active');try{const reply=await callVisionModel('连接检查：请只回复连接正常。');setAiProgress('config',1,1,'done',reply);toast('连接成功：'+reply.slice(0,80));}catch(error){setAiProgress('config',0,1,'failed',error.message);throw error;}});});
}

function bindLessonAi(){
  const form=document.querySelector('[data-lesson-ai-form]');
  const info=document.querySelector('[data-lesson-ai-status]');
  if(!form||!info)return;
  const requested=new URLSearchParams(location.search).get('reanalyze');
  const feedbackId=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requested||'')?requested:null;
  const button=form.querySelector('button');
  if(feedbackId)button.textContent='测试连接并重做这节课';
  const display=(message,error=false)=>{
    info.textContent=message;
    info.classList.toggle('inline-error',error);
  };
  productionRequest('/deepseek').then(result=>{
    if(!info.isConnected)return;
    form.hidden=!!result.managedByEnvironment;
    display(result.configured?'课堂模型已配置 · '+result.model:'填入自己的 DeepSeek API Key 即可启用。');
  }).catch(error=>{if(info.isConnected)display(error.message,true);});
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(button.disabled)return;
    button.disabled=true;
    display('正在测试 DeepSeek 连接…');
    try{
      const result=await productionRequest('/deepseek',{apiKey:form.elements.apiKey.value});
      form.reset();
      display('连接成功 · '+result.model);
      if(feedbackId){
        await productionRequest('/moments/'+feedbackId+'/rebuild',{requestKey:crypto.randomUUID()});
        location.assign('/?view=speech&feedback='+encodeURIComponent(feedbackId));
      }
    }catch(error){
      display(error.message,true);
    }finally{button.disabled=false;}
  });
}
