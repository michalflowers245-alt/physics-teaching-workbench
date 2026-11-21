import {createReadStream} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {AppError} from './store.mjs';
import {clone,emptyGate} from '../shared/domain.mjs';
export async function readBody(req,max=32*1024*1024) {
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>max)throw new AppError('文件或请求过大',413);chunks.push(chunk);}
  return Buffer.concat(chunks);
}
export async function readJson(req){try{return JSON.parse((await readBody(req)).toString('utf8'));}catch(e){if(e instanceof AppError)throw e;throw new AppError('JSON格式不正确');}}
export function sendJson(res,status,body){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));}
export function protect(req,port) {
  const hosts=new Set(['localhost:'+port,'127.0.0.1:'+port]);
  if(!hosts.has(String(req.headers.host).toLowerCase()))throw new AppError('不允许的本机访问地址',403);
  if(req.headers['sec-fetch-site']==='cross-site')throw new AppError('禁止外部网页访问本机数据',403);
  if(req.headers.origin && !['http://127.0.0.1:'+port,'http://localhost:'+port].includes(req.headers.origin))throw new AppError('请求来源不允许',403);
}
export async function route(req,res,url,store,engine,env,models) {
  const path=url.pathname,method=req.method;
  const ok=body=>sendJson(res,200,body);
  if(path==='/api/panel-state'){
    if(method==='GET')return ok(store.get()),true;
    if(method==='POST'){const body=await readJson(req);return ok(store.save(body.state,body.expectedRevision)),true;}
  }
  if(path==='/api/health'&&method==='GET'){
    const {revision,savedAt}=store.get();
    return ok({ok:true,database:'SQLite',revision,savedAt,localOnly:true,model:models?.model || env.AI_MODEL || 'gpt-5.6-luna',
      aiProvider:models?.provider || 'compatible',visionModel:models?.vision || null,
      backups:store.listBackups().length,files:store.materials().length,dataDirectory:store.data}),true;
  }
  if(path==='/api/import'&&method==='POST'){const b=await readJson(req);return ok(store.importState(b.state,b.expectedRevision)),true;}
  if(path==='/api/sessions'&&method==='GET')return ok(Object.values(store.get().state.sessions)),true;
  let pendingMatch=path.match(/^\/api\/unassigned\/([^/]+)\/assign$/);
  if(pendingMatch&&method==='POST'){const b=await readJson(req);return ok(store.classifyRecord(pendingMatch[1],b,b.expectedRevision)),true;}
  let match=path.match(/^\/api\/sessions\/([^/]+)\/confirm$/);
  if(match&&method==='POST'){const b=await readJson(req);return ok(store.confirmSession(decodeURIComponent(match[1]),b.type,b.reason,b.expectedRevision)),true;}
  match=path.match(/^\/api\/students\/([^/]+)$/);
  if(match&&method==='POST'){const b=await readJson(req);return ok(store.updateStudent(match[1],b.action,b,b.expectedRevision)),true;}
  if(path==='/api/materials'){
    if(method==='GET')return ok(store.materials()),true;
    if(method==='POST'){
      const bytes=await readBody(req,100*1024*1024);
      return ok(store.addMaterial(bytes,{name:decodeURIComponent(req.headers['x-file-name'] || '资料.txt'),type:req.headers['content-type'],sessionId:decodeURIComponent(req.headers['x-session-id'] || ''),kind:req.headers['x-material-kind']})),true;
    }
  }
  match=path.match(/^\/api\/materials\/([a-zA-Z0-9-]+)(?:\/(file|extracts))?$/);
  if(match) {
    if(method==='GET'&&match[2]==='file'){
      const {material,path:file}=store.materialFile(match[1]);
      res.writeHead(200,{'Content-Type':material.type,'Content-Length':material.size,'Content-Disposition':"inline; filename*=UTF-8''"+encodeURIComponent(material.name),'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'});
      createReadStream(file).pipe(res);return true;
    }
    if(method==='GET')return ok(store.material(match[1])),true;
    if(method==='POST'&&match[2]==='extracts'){const b=await readJson(req);return ok(store.setExtracts(match[1],b.extracts)),true;}
  }
  if(path==='/api/jobs'){
    if(method==='GET')return ok(store.jobs()),true;
    if(method==='POST')return ok(store.newJob(await readJson(req))),true;
  }
  match=path.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)(?:\/(cancel|resume|finish|item-error))?$/);
  if(match){
    if(method==='GET')return ok(store.getJob(match[1])),true;
    if(method==='POST'){
      const job=store.getJob(match[1]);
      if(match[2]==='cancel')return ok(engine.cancel(job.id)),true;
      if(match[2]==='resume'){job.status='running';job.error='';return ok(store.putJob(job)),true;}
      if(match[2]==='finish'){const b=await readJson(req);job.status=job.status==='cancelled'?'cancelled':b.failed||job.items.filter(i=>i.status==='done').length<job.total?'failed':'done';return ok(store.putJob(job)),true;}
      if(match[2]==='item-error'){const b=await readJson(req),item=job.items.find(i=>i.key===b.itemKey);if(item){item.status='failed';item.needsFresh=!!b.needsFresh;item.error=String(b.error || '应用结果失败').slice(0,400);job.error=item.error;job.completed=job.items.filter(i=>i.status==='done').length;if(job.status!=='cancelled')job.status=job.plan?'running':'failed';}return ok(store.putJob(job)),true;}
    }
  }
  if(path==='/.netlify/functions/vision-proxy'&&method==='POST'){
    const body=await readJson(req);if(!body.payload)throw new AppError('缺少模型请求');
    return ok(await engine.request(body)),true;
  }
  if(path==='/api/gates/lock'&&method==='POST'){const b=await readJson(req);return ok(store.lockGate(b.courseId,b.plan,b.sources,b.reason,b.expectedRevision)),true;}
  if(path==='/api/gates/verify'&&method==='POST')return ok(await engine.verifyGate(await readJson(req))),true;
  if(path==='/api/gates/review'&&method==='POST'){const b=await readJson(req);return ok(store.reviewGate(b.courseId,b.studentId,b.lessonId,b.taskId,b,b.expectedRevision)),true;}
  if(path==='/api/gates/copy'&&method==='POST'){
    const b=await readJson(req);
    store.checkRevision(b.expectedRevision,store.get().revision);
    return ok(store.transact(b.expectedRevision,state=>{
      const source=state.courses[b.from];if(!source)throw new AppError('来源课程不存在');
      if(state.courses[b.to]?.plan?.lessons?.length)throw new AppError('目标班级已有课程计划，请先保存并处理现有计划');
      const gate=emptyGate();gate.sources=clone(source.sources);gate.plan={...clone(source.plan),locked:false,version:0};
      gate.plan.lessons.forEach(l=>{l.id=randomUUID();l.tasks.forEach(t=>t.id=randomUUID());});state.courses[b.to]=gate;
    })),true;
  }
  if(path==='/api/backups'){
    if(method==='GET')return ok(store.listBackups()),true;
    if(method==='POST'){const b=await readJson(req),kind=['before-roster-import','before-score-import'].includes(b.kind)?b.kind:'manual';return ok(store.createBackup(kind,kind==='manual')),true;}
  }
  match=path.match(/^\/api\/backups\/([a-zA-Z0-9-]+)\/(inspect|restore)$/);
  if(match){
    if(method==='GET'&&match[2]==='inspect'){const {manifest,diff}=store.inspectBackup(match[1]);return ok({manifest,diff}),true;}
    if(method==='POST'&&match[2]==='restore'){const b=await readJson(req);store.checkRevision(b.expectedRevision,store.get().revision);store.inspectBackup(match[1]);engine.invalidate();return ok(store.restoreBackup(match[1],b.expectedRevision)),true;}
  }
  if(path==='/api/agent-memory'){
    if(method==='GET')return ok({memory:store.get().state.agent?.memory || ''}),true;
    if(method==='POST'){const b=await readJson(req);return ok(store.transact(b.expectedRevision,s=>{s.agent ||= {};s.agent.memory=String(b.memory || '');})),true;}
  }
  if(path.startsWith('/api/')||path.startsWith('/.netlify/'))throw new AppError('接口不存在或操作不支持',404);
  return false;
}
