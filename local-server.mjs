import {createServer} from 'node:http';
import {readFileSync,existsSync,createReadStream,statSync} from 'node:fs';
import {resolve,join,extname,sep} from 'node:path';
import {Store,AppError} from './server/store.mjs';
import {TaskEngine} from './server/tasks.mjs';
import {route,protect,sendJson} from './server/routes.mjs';
import {EngineStore} from './server/physics-exam-store.mjs';
import {PhysicsMaterialLibrary} from './server/physics-material-library.mjs';
import {routePhysicsExam} from './server/physics-exam-routes.mjs';
import {Classroom} from './server/classroom.mjs';
import {TeachingProduction} from './server/teaching-production.mjs';
import {DesktopChatCut} from './server/production-chatcut.mjs';
import {createModelService} from './server/model-service.mjs';
import {createLocalOcr} from './server/local-ocr.mjs';
const root=resolve('.');
const env={...process.env};
if(existsSync(join(root,'.env.local')))for(const line of readFileSync(join(root,'.env.local'),'utf8').split(/\r?\n/)){
  if(!line.trim()||line.trim().startsWith('#'))continue;
  const i=line.indexOf('=');if(i<0)continue;const key=line.slice(0,i).trim();
  if(env[key]==null)env[key]=line.slice(i+1).trim().replace(/^['"]|['"]$/g,'');
}
const port=Number(env.PORT || 4173),store=new Store(root,{dataDir:env.PANEL_DATA_DIR});
const physicsExamDataDir=join(store.data,'physics-exam');
let physicsExamStore=null;
let physicsMaterialLibrary=null;
const getPhysicsExamStore=()=>physicsExamStore ||= new EngineStore(physicsExamDataDir);
const getPhysicsMaterialLibrary=()=>physicsMaterialLibrary ||= new PhysicsMaterialLibrary(physicsExamDataDir);
const models=createModelService(env,{baseFromState:()=>store.get().state.ai?.baseUrl,ocr:createLocalOcr(root)});
const engine=new TaskEngine(store,models.invoke,{prepare:models.prepare,cacheScope:'model-service-v4:'+models.provider});
const production=new TeachingProduction(root,store,engine,env,new DesktopChatCut(env));
const classroom=new Classroom(production);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon','.wasm':'application/wasm','.json':'application/json'};
const server=createServer(async(req,res)=>{
  try {
    protect(req,port);
    const url=new URL(req.url || '/', 'http://127.0.0.1:'+port);
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(req.method==='GET'&&url.pathname==='/api/ai/status'){sendJson(res,200,await models.status({force:true}));return;}
    if(await classroom.run(req,res,url))return;
    if(await production.run(req,res,url))return;
    if(await routePhysicsExam(req,res,url,{root,env,dataDir:physicsExamDataDir,panelStore:store,getStore:getPhysicsExamStore,getMaterialLibrary:getPhysicsMaterialLibrary}))return;
    if(await route(req,res,url,store,engine,env,models))return;
    if(!['GET','HEAD'].includes(req.method))throw new AppError('不支持的操作',405);
    const requested=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
    if(requested.split('/').some(part=>part==='..'||part==='.')||requested.includes('\\'))throw new AppError('Not found',404);
    if(!/^\/(?:index\.html|(?:styles|gate|workbench|lifecycle|exam-launcher|production)\.css|(?:app|gate|workbench|gate-workbench|exam-launcher)\.(?:js|mjs)|exam-engine\/(?:index|student-print)\.html|exam-engine\/(?:engine|engine-native|student-print)\.css|exam-engine\/(?:host|bridge-v2)\.mjs|exam-engine\/(?:exam-domain|exam-ingest|exam-sync|exam-training|physics-taxonomy|question-overview|student-question-set|exam-engine|student-print)\.js|client\/[a-zA-Z0-9_./-]+|shared\/domain\.mjs|vendor\/[a-zA-Z0-9_./-]+|assets\/[a-zA-Z0-9_./-]+)$/.test(requested))throw new AppError('Not found',404);
    const file=resolve(root,'.'+requested);
    if(!file.startsWith(root+sep)||!existsSync(file)||!statSync(file).isFile())throw new AppError('Not found',404);
    const frameAncestors=requested==='/exam-engine/index.html'?"'self'":"'none'";
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors "+frameAncestors);
    res.writeHead(200,{'Content-Type':mime[extname(file)] || 'application/octet-stream','Cache-Control':requested.startsWith('/vendor/')?'public, max-age=86400':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin'});
    if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
  }catch(error){if(!res.headersSent)sendJson(res,error.status || 500,{error:error.status?error.message:'本机服务处理失败，请重试',...(error.extra || {})});else res.end();}
});
server.requestTimeout=0; // Recording uploads have an idle timeout, not a fixed wall-clock limit.
server.listen(port,'127.0.0.1',()=>console.log('张老师物理 v2 http://127.0.0.1:'+port));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>{production.close();physicsMaterialLibrary?.close();physicsExamStore?.close();store.close();process.exit(0);}));
