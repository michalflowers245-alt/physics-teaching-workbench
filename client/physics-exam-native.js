// Native workbench entry point for the independent physics exam engine.
// The engine keeps its own data and API namespace; this layer only gives it a
// first-class home in the existing teaching workspace.
const physicsExamOriginal={initializeWorkbench,wbShell,wbBindShell,activeView,bindView};

function initializeWorkbench(){
  if(!wbPages.some(page=>page[0]==='exam')){
    const managementIndex=wbPages.findIndex(page=>page[0]==='setup');
    const entry=['exam','中考分析引擎','导入真题、检索证据、生成专题训练','file'];
    wbPages.splice(managementIndex<0?wbPages.length:managementIndex,0,entry);
  }
  physicsExamOriginal.initializeWorkbench();
}

function physicsExamNav(){
  const button=(key,label)=>{
    const page=wbPages.find(item=>item[0]===key);
    if(!page)return '';
    const title=label||page[1];
    return '<button type="button" data-nav="'+escapeAttr(key)+'" title="'+escapeAttr(title)+'">'+(icons[page[3]]||icons.file)+
      '<span>'+escapeHtml(title)+'</span><i class="nav-selected-dot"></i></button>';
  };
  const daily=[['classroom'],['moments','宣发素材']].map(([key,label])=>button(key,label)).join('');
  const tools=[['overview'],['feedback','学生跟进'],['scores'],['knowledge'],['pdf'],['wrongbook'],['recording'],
    ['gate'],['exam'],['setup'],['ai'],['agent'],['outreach']];
  return '<nav class="nav" aria-label="主导航"><div class="nav-group editorial-daily">'+daily+'</div>'+
    '<details class="nav-group classroom-tools" data-detail="classroom-tools"><summary><span>更多工具</span><i aria-hidden="true">+</i></summary><div class="editorial-tool-list">'+tools.map(([key,label])=>button(key,label)).join('')+'</div></details></nav>';
}

function wbShell(){
  return physicsExamOriginal.wbShell().replace(/<nav class="nav" aria-label="主导航">[\s\S]*?<\/nav>/,physicsExamNav());
}

function wbBindShell(){
  physicsExamOriginal.wbBindShell();
  const menu=document.querySelector('.classroom-tools');
  menu?.addEventListener('click',event=>{
    if(event.target.closest('[data-nav]')&&matchMedia('(max-width: 660px)').matches){
      menu.open=false;
      menu.querySelector('summary')?.focus({preventScroll:true});
    }
  });
  menu?.addEventListener('keydown',event=>{
    if(event.key==='Escape'&&menu.open){menu.open=false;menu.querySelector('summary')?.focus();event.stopPropagation();}
  });
}

function physicsExamView(){
  return '<section class="section physics-exam-host" aria-label="中考物理分析引擎" style="padding:0;overflow:hidden;min-height:680px">'+
    '<iframe data-physics-exam-frame title="长沙中考物理分析引擎" src="/exam-engine/index.html?sessionId='+encodeURIComponent(state.sessionId || '')+'" loading="eager" style="display:block;width:100%;height:max(720px, 80dvh);border:0;background:var(--paper)"></iframe>'+
    '</section>';
}

function activeView(){
  if(state.active==='exam')return physicsExamView();
  return physicsExamOriginal.activeView();
}

function bindView(){
  if(state.active==='exam'){
    const frame=document.querySelector('[data-physics-exam-frame]');
    if(frame)frame.addEventListener('load',()=>frame.removeAttribute('aria-busy'),{once:true});
    return;
  }
  physicsExamOriginal.bindView();
}
