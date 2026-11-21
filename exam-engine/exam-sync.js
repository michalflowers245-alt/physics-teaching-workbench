/* Optimistic, incremental server writes with a durable local recovery copy. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.ExamSync=api;})(typeof window==='undefined'?globalThis:window,function(){
  'use strict';
  const collections=['files','canonicalExams','questions','attempts','trainingPlans','questionSets','auditEvents','questionAliases','analysisRuns','importJobs','masteryRecords'];
  const metaKeys=['lessonMappings','importDraft','activeTab','settings'];
  const clone=x=>JSON.parse(JSON.stringify(x));
  let base={},revision=0,timer=null,queue=Promise.resolve(),inflight=null,dbPromise=null,ready=false,legacyRecovery=null;
  let recoveryKey='workspace',slotReady=null,recoveryChannel=null;
  const tabOwner=globalThis.crypto.randomUUID(),sessionKey='physics-exam-recovery-tab-id';
  const validRevision=value=>Number.isSafeInteger(value)&&value>=0;
  function assertRemote(value){if(!value||!validRevision(value.revision)||!value.engine||typeof value.engine!=='object'||Array.isArray(value.engine))throw new Error('服务器快照格式或版本无效，已保留本机副本');}
  async function initRecoverySlot(){
    if(slotReady)return slotReady;
    slotReady=(async()=>{
      if(typeof sessionStorage==='undefined')return; // Non-browser tests and legacy recovery retain their old slot.
      let id;try{id=sessionStorage.getItem(sessionKey);}catch{}
      if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id||''))id=globalThis.crypto.randomUUID();
      recoveryKey='tab:'+id;
      if(typeof BroadcastChannel!=='undefined'){
        try{
          recoveryChannel=new BroadcastChannel('physics-exam-recovery-owners-v2');
          let duplicate=false;
          recoveryChannel.onmessage=event=>{const m=event.data||{};if(m.owner===tabOwner||m.key!==recoveryKey)return;if(m.type==='probe')recoveryChannel.postMessage({type:'claim',key:recoveryKey,owner:tabOwner,forOwner:m.owner});if(m.type==='claim'&&m.forOwner===tabOwner)duplicate=true;};
          recoveryChannel.postMessage({type:'probe',key:recoveryKey,owner:tabOwner});
          await new Promise(resolve=>setTimeout(resolve,40));
          if(duplicate){id=globalThis.crypto.randomUUID();recoveryKey='tab:'+id;}
        }catch{recoveryChannel=null;}
      }
      try{sessionStorage.setItem(sessionKey,id);}catch{}
    })();return slotReady;
  }
  function snapshot(engine){const out={version:2};for(const k of collections)out[k]=clone(engine[k]||[]);for(const k of metaKeys)if(engine[k]!=null)out[k]=clone(engine[k]);return out;}
  function diff(before,after){const changes=[];for(const c of collections){const old=new Map((before[c]||[]).map(x=>[x.id,x]));for(const x of after[c]||[]){if(!x.id)continue;if(JSON.stringify(old.get(x.id))!==JSON.stringify(x))changes.push({collection:c,id:x.id,value:x});old.delete(x.id);}for(const key of old.keys())if(c!=='auditEvents')changes.push({collection:c,id:key,delete:true});}for(const k of metaKeys)if(JSON.stringify(before[k])!==JSON.stringify(after[k])&&after[k]!==undefined)changes.push({collection:'meta',id:k,value:after[k]});return changes;}
  function status(engine,state,message=''){engine.syncStatus=state;engine.syncMessage=message; if(typeof document!=='undefined'){const node=document.querySelector('[data-engine-sync-status]');if(node)node.textContent=({saved:'已保存',pending:'待同步',saving:'保存中',conflict:'保存冲突',error:'保存失败',offline:'离线待同步'})[state]+(message?` · ${message}`:'');}}
  function database(){if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{if(typeof indexedDB==='undefined')return reject(new Error('浏览器不支持离线数据库'));const req=indexedDB.open('physics-exam-recovery-v2',1);req.onupgradeneeded=()=>req.result.createObjectStore('state');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});return dbPromise;}
  async function cacheWrite(value,key=recoveryKey){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('state','readwrite');tx.objectStore('state').put({...value,recoveryId:key},key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  async function cacheRead(key=recoveryKey){try{const db=await database();return await new Promise((resolve,reject)=>{const req=db.transaction('state').objectStore('state').get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}catch{return null;}}
  async function listRecoveries(){await initRecoverySlot();try{const db=await database();const records=await new Promise((resolve,reject)=>{const store=db.transaction('state').objectStore('state');if(typeof store.getAll!=='function'){resolve([]);return;}const req=store.getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);});return records.filter(r=>r?.pending&&r.engine).map(r=>({recoveryId:r.recoveryId||'workspace',revision:r.revision,pending:true,at:r.at||'',questionCount:r.engine.questions?.length||0,attemptCount:r.engine.attempts?.length||0,current:(r.recoveryId||'workspace')===recoveryKey,uncertain:Boolean(r.inflight)})).sort((a,b)=>b.at.localeCompare(a.at));}catch{return [];}}
  async function exportRecovery(key){if(typeof key!=='string'||key.length>150)throw new Error('恢复副本标识无效');const saved=await cacheRead(key);if(!saved?.engine)throw new Error('恢复副本不存在');return {format:'private-exam-recovery-v2',warning:'私人副本包含学生数据与原解析，请勿对外发布',...clone(saved)};}
  async function checkpoint(engine,pending){try{await cacheWrite({engine:snapshot(engine),base,revision,pending,inflight,legacyRecovery,at:new Date().toISOString()});engine.offlineDurable=true;}catch(error){engine.offlineDurable=false;engine.syncMessage=`离线副本未保存：${error.message}`;}}
  async function restore(state,ensure){
    await initRecoverySlot();
    const recovery=await cacheRead();let old=null;
    inflight=recovery?.inflight||null;
    try{old=JSON.parse(localStorage.getItem('physics-exam-analysis-engine-v1')||'null');}catch{}
    legacyRecovery=recovery?.legacyRecovery || old || null;
    if(recovery?.engine)state.examEngine=recovery.engine;else if(old)state.examEngine=old;
    try{
      const response=await fetch('/api/physics-exam/engine',{cache:'no-store'});if(!response.ok)throw new Error(`服务返回 ${response.status}`);const remote=await response.json();
      assertRemote(remote);
      revision=remote.revision||0;
      if(recovery?.pending){base=recovery.base||{};revision=recovery.revision||0;inflight=recovery.inflight||null;const retryable=remote.revision===revision||Boolean(inflight);status(state.examEngine,retryable?'pending':'conflict',retryable?'恢复未同步修改；不确定请求按原ID重放':'服务器已有其他修改，本机副本已保留');}
      else if(remote.revision===0 && old && collections.some(c=>(old[c]||[]).length) && collections.every(c=>!(remote.engine?.[c]||[]).length)) {
        state.examEngine=clone(old);base=snapshot(remote.engine||{});
        for(const q of state.examEngine.questions||[])Object.assign(q,{reviewed:false,reviewedBy:'',reviewedAt:'',migrationNeedsReview:true});
        for(const e of state.examEngine.canonicalExams||[])Object.assign(e,{complete:false,completenessConfirmed:false,dedupeStatus:'unconfirmed',migrationNeedsReview:true});
        for(const a of state.examEngine.attempts||[])Object.assign(a,{manualVerified:false,verificationStatus:'draft',verifiedBy:'',verifiedAt:'',migrationNeedsReview:true});
        for(const f of state.examEngine.files||[])f.migrationNeedsReview=true;
        status(state.examEngine,'pending','已保留旧浏览器数据；旧审核须重新确认');
      }
      else if(remote.engine){state.examEngine=remote.engine;base=snapshot(remote.engine);status(state.examEngine,'saved',old?'旧浏览器副本保留在私人恢复包中':'');state.examEngine.lastSavedAt=remote.savedAt||'';}
      else{base={};ensure(state);status(state.examEngine,'pending',old?'旧浏览器数据待迁移':'');}
    }catch(error){base=recovery?.base||{};revision=recovery?.revision||0;ensure(state);status(state.examEngine,'offline',error.message);}
    ensure(state);state.examEngine.dataRevision=revision;ready=true;await checkpoint(state.examEngine,['pending','conflict','offline'].includes(state.examEngine.syncStatus));if(state.examEngine.syncStatus==='pending')schedule(state.examEngine);
    if(typeof window!=='undefined' && window.addEventListener)window.addEventListener('online',()=>flush(state.examEngine));
  }
  async function send(engine){
    if(!ready||engine.syncStatus==='conflict')return false;
    const shot=snapshot(engine),changes=diff(base,shot);
    if(!changes.length&&!inflight){status(engine,'saved');return true;}
    status(engine,'saving');
    const body=inflight||{baseRevision:revision,requestId:globalThis.crypto.randomUUID(),changes};inflight=body;
    await checkpoint(engine,true);
    try{
      const response=await fetch('/api/physics-exam/engine/changes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const result=await response.json();
      if(response.status===409){status(engine,'conflict','服务器版本已变化；待同步副本保留，可导出后载入服务器版本');return false;}
      if(!response.ok){inflight=null;throw new Error(result.detail||result.error||`HTTP ${response.status}`);}
      if(!validRevision(result.revision)||result.revision!==body.baseRevision+1||result.ok===false)throw new Error('服务器成功响应版本无效；保留原请求ID等待核验重放');
      // Apply exactly the acknowledged delta, including on an idempotent retry of an uncertain response.
      for(const c of body.changes){if(c.collection==='meta'){base[c.id]=clone(c.value);continue;}base[c.collection]||=[];const i=base[c.collection].findIndex(x=>x.id===c.id);if(c.delete){if(i>=0)base[c.collection].splice(i,1);}else if(i>=0)base[c.collection][i]=clone(c.value);else base[c.collection].push(clone(c.value));}
      revision=result.revision;engine.dataRevision=revision;engine.lastSavedAt=result.savedAt;inflight=null;
      const remains=diff(base,snapshot(engine)).length>0;await checkpoint(engine,remains);status(engine,remains?'pending':'saved',engine.offlineDurable===false?'服务器已保存，但离线缓存不可用':'');if(remains)schedule(engine);return true;
    }catch(error){status(engine,'error',error.message);await checkpoint(engine,true);return false;}
  }
  function schedule(engine){if(!engine)return;if(engine.syncStatus==='conflict')return;status(engine,'pending');clearTimeout(timer);timer=setTimeout(()=>{queue=queue.catch(()=>false).then(()=>send(engine));},420);}
  async function flush(engine){clearTimeout(timer);queue=queue.catch(()=>false).then(()=>send(engine));return queue;}
  async function preserveCurrent(engine){if(engine&&(inflight||diff(base,snapshot(engine)).length))await cacheWrite({engine:snapshot(engine),base:clone(base),revision,pending:true,inflight:inflight?clone(inflight):null,legacyRecovery,at:new Date().toISOString()},'archive:'+globalThis.crypto.randomUUID());}
  async function reload(state,ensure){const response=await fetch('/api/physics-exam/engine',{cache:'no-store'});if(!response.ok)throw new Error('无法读取服务器版本');const data=await response.json();assertRemote(data);await preserveCurrent(state.examEngine);state.examEngine=data.engine;ensure(state);base=snapshot(state.examEngine);revision=data.revision;state.examEngine.dataRevision=revision;inflight=null;await checkpoint(state.examEngine,false);status(state.examEngine,'saved');return state.examEngine;}
  async function restoreRecovery(key,state,ensure){
    await initRecoverySlot();const saved=await exportRecovery(key);if(!validRevision(saved.revision))throw new Error('恢复副本版本无效');
    clearTimeout(timer);await queue.catch(()=>false);await preserveCurrent(state.examEngine);
    state.examEngine=clone(saved.engine);ensure(state);base=clone(saved.base||{});revision=saved.revision;inflight=saved.inflight?clone(saved.inflight):null;legacyRecovery=saved.legacyRecovery||null;ready=true;
    try{const response=await fetch('/api/physics-exam/engine',{cache:'no-store'});if(!response.ok)throw new Error('无法读取服务器版本');const remote=await response.json();assertRemote(remote);status(state.examEngine,remote.revision===revision||inflight?'pending':'conflict','已载入选定副本，未自动合并或上传；请核对后重试保存');}catch(error){status(state.examEngine,'offline',error.message);}
    state.examEngine.dataRevision=revision;await checkpoint(state.examEngine,true);return state.examEngine;
  }
  function backup(engine){return {format:'private-exam-recovery-v2',warning:'私人备份包含原解析和学生数据，请勿对外发布',recoveryId:recoveryKey,revision,base:snapshot(base),engine:snapshot(engine),inflight,legacyRecovery};}
  return {restore,schedule,flush,reload,backup,diff,snapshot,collections,metaKeys,listRecoveries,exportRecovery,restoreRecovery};
});
