import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {access,copyFile,link,mkdir,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AppError} from './store.mjs';
import {probeVideo,verifyClip} from './production-media.mjs';
import {hash,safeName,text} from './production-feedback.mjs';

const userData=join(homedir(),'Library','Application Support','ChatCut');
const launcher=join(userData,'chatcut-mcp');
const desktopSocket=join(userData,'mcp.sock');
const CONNECT_TIMEOUT=15_000;

async function wakeDesktop(){
  if(process.platform!=='darwin')return;
  if(await access(desktopSocket).then(()=>true,()=>false))return;
  const app=spawn('/usr/bin/open',['-g','-a','ChatCut'],{stdio:'ignore'});
  await new Promise((resolve,reject)=>{
    const failed=()=>reject(new AppError('无法打开 ChatCut Desktop，请手动打开桌面端后重试',503));
    app.once('error',failed);
    app.once('exit',code=>code===0?resolve():failed());
  });
  const deadline=Date.now()+CONNECT_TIMEOUT;
  do{
    if(await access(desktopSocket).then(()=>true,()=>false))return;
    await delay(300);
  }while(Date.now()<deadline);
  throw new AppError('ChatCut Desktop 尚未完成启动，请打开桌面端后重试',503);
}

export async function connectDesktop({timeout=CONNECT_TIMEOUT}={}){
  await access(launcher).catch(()=>{throw new AppError('ChatCut Desktop 本机连接未就绪。普通录课可直接用 FFmpeg。',503);});
  const child=spawn(launcher,[],{stdio:['pipe','pipe','pipe'],env:{...process.env,CHATCUT_MCP_USER_DATA:userData}});
  const lines=createInterface({input:child.stdout});
  const waiting=new Map();
  let next=0;
  let diagnostic='';
  let closed=false;
  child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-1500);});
  child.stdin.on('error',()=>{});
  const shutdown=()=>{
    if(closed)return;
    closed=true;
    child.kill();
    lines.close();
    for(const pending of waiting.values()){
      clearTimeout(pending.timer);
      pending.reject(new AppError('ChatCut 本机连接中断，请打开 ChatCut Desktop 后重试',503));
    }
    waiting.clear();
  };
  child.on('error',shutdown);
  child.on('close',shutdown);
  lines.on('line',line=>{
    let data;
    try{data=JSON.parse(line);}catch{return;}
    const request=waiting.get(data.id);
    if(!request)return;
    waiting.delete(data.id);
    clearTimeout(request.timer);
    if(data.error)request.reject(new AppError(String(data.error.message || 'ChatCut 调用失败').slice(0,300),503));
    else request.resolve(data.result);
  });
  const notify=(method,params={})=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',method,params})+'\n');
  const request=(method,params={},timeout=20_000)=>new Promise((resolve,reject)=>{
    if(closed){reject(new AppError('ChatCut 本机连接中断，请打开 ChatCut Desktop 后重试',503));return;}
    const id=++next;
    const timer=setTimeout(()=>{waiting.delete(id);reject(new AppError('ChatCut 本机连接响应超时，请重试',503));},timeout);
    waiting.set(id,{timer,resolve,reject});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  try{
    await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'teaching-workbench',version:'1.0.0'}},timeout);
    notify('notifications/initialized');
  }catch(error){
    shutdown();
    if(/SIGN_IN_REQUIRED/i.test(diagnostic))throw new AppError('ChatCut Desktop 连接要求登录。请打开桌面端后重试',503);
    throw error;
  }
  return {request,close:shutdown};
}

export async function invokeDesktop(client,name,args={},timeout){
  const result=await client.request('tools/call',{name,arguments:args},timeout);
  const written=result.content?.filter(part=>part.type==='text').map(part=>part.text) || [];
  let data=result.structuredContent;
  if(!data){
    for(const line of written)try{data=JSON.parse(line);break;}catch{}
  }
  if(result.isError || data?.status==='failed' || data?.code==='SIGN_IN_REQUIRED'){
    const message=text(data?.message || data?.error || written.at(-1) || 'ChatCut 本机操作失败',240);
    const recoverable=/SIGN_IN_REQUIRED|signed.in|登录|ipc connection closed|desktop.*(?:not available|not running)|timed? out/i.test(message);
    throw new AppError(message,recoverable?503:422);
  }
  if(!data)throw new AppError('ChatCut 没有返回可识别的操作结果',503);
  return data;
}

const desktopId=value=>typeof value==='string' && /^[0-9a-f-]{35,36}$/i.test(value);
const newProject='new-local';
export class DesktopChatCut{
  constructor(env,{connect=connectDesktop,wake=wakeDesktop}={}){
    this.disabled=env.PANEL_CHATCUT==='off';
    this.connect=connect;
    this.wake=wake;
    this.checked=null;
    this.checking=null;
  }
  async session(fn,{wake=false,timeout=CONNECT_TIMEOUT}={}){
    if(this.disabled)throw new AppError('本机服务未开启 ChatCut',503);
    if(wake){
      this.waking ||= this.wake().finally(()=>{this.waking=null;});
      await this.waking;
    }
    const client=await this.connect({timeout});
    try{
      const {tools}=await client.request('tools/list',{},timeout);
      const skip=tools?.find(tool=>tool.name==='push_asset')?.inputSchema?.properties?.skipTranscription;
      if(skip?.type!=='boolean')throw new AppError('当前 ChatCut 连接不能保证关闭云端转写。请打开支持本机导入的桌面版本，或选择本机 FFmpeg。',503);
      return await fn((name,args,deadline)=>invokeDesktop(client,name,
        name==='push_asset'?{...args,skipTranscription:true}:args,deadline ?? timeout));
    }finally{client.close();}
  }
  async status(){
    if(this.checked && Date.now()-this.checked.at<3500)return this.checked.value;
    if(!this.checking){
      this.checking=this.projects().then(()=>({ready:true,message:'ChatCut Desktop 本机连接可用，录课不会上传转写'}))
        .catch(error=>({ready:false,message:error.message}))
        .then(value=>{this.checked={at:Date.now(),value};return value;})
        .finally(()=>{this.checking=null;});
    }
    return this.checking;
  }
  cachedStatus(){
    return this.checked?.value || {ready:false,pending:true,message:'ChatCut 状态按需检查。普通录课使用本机 FFmpeg。'};
  }
  validateChoice(input={}){
    const {projectId,introId='',outroId=''}=input || {};
    if(projectId!==newProject&&!desktopId(projectId))throw new AppError('请选择一个 ChatCut 本地项目');
    if([introId,outroId].some(id=>id&&!desktopId(id)))throw new AppError('ChatCut 素材标识不正确');
    return {projectId,introId,outroId};
  }
  async projects(){
    return this.session(async call=>{
      const {projects}=await call('list_projects');
      return (projects || []).filter(project=>desktopId(project.projectId)&&project.locationStatus==='available'&&project.surface==='chatcut-desktop')
        .map(project=>({id:project.projectId,name:project.name}));
    },{wake:true});
  }
  async assets(projectId){
    if(!desktopId(projectId))throw new AppError('ChatCut 项目标识不正确');
    return this.session(call=>assetChoices(call,projectId));
  }
  async render({record,source,geometry,clip,output,dir,renderImage,checkpoint}){
    const choice=record.template;
    return this.session(async call=>{
      const folder=join(dir,'chatcut-media',record.id);
      await mkdir(folder,{recursive:true,mode:0o700});
      const state=record.desktopCut ||= {};
      if(!state.projectId){
        if(choice.projectId===newProject){
          const {projects}=await call('list_projects');
          const name='张老师物理｜'+safeName(record.meta.topic || record.name)+'｜'+record.id.slice(0,8);
          const existing=projects?.find(project=>project.name===name && project.locationStatus==='available' && project.surface==='chatcut-desktop');
          state.projectId=existing?.projectId || (await call('create_project',{name,compositionWidth:geometry.width,compositionHeight:geometry.height,openWindow:false})).projectId;
        }else state.projectId=choice.projectId;
        checkpoint();
      }
      const projectId=state.projectId;
      const project=await call('read_project',{projectId});
      if(project.project?.readOnly)throw new AppError('选中的 ChatCut 项目不可编辑，请使用可写的本地项目',503);
      const fps=Number(project.project?.frameRate || 30);
      const mark=Math.round(clip.start*fps), stop=Math.round(clip.end*fps);
      const durationFrames=Math.max(1,stop-mark);
      const stamp=hash(JSON.stringify(['cards-v3',clip.questionType,clip.title,clip.start,clip.end,clip.intro,clip.outro,choice])).slice(0,12);
      const cut=clip.desktop ||= {};
      if(cut.stamp!==stamp){clip.desktop={stamp};checkpoint();}
      const current=clip.desktop;
      const video=join(folder,'课堂原片'+(/\.mov$/i.test(record.name)?'.mov':'.mp4'));
      if(!state.sourceId){
        await link(source,video).catch(error=>{if(error.code!=='EEXIST')throw error;});
        state.sourceId=await push(call,projectId,video);
        checkpoint();
      }

      const cards=await assetChoices(call,projectId);
      const selected={intro:choice.introId,outro:choice.outroId};
      const makeCard=async(kind)=>{
        let decoration;
        if(selected[kind]){
          const found=cards.find(asset=>asset.id===selected[kind]);
          if(!found)throw new AppError('选定的 ChatCut '+(kind==='intro'?'片头':'片尾')+'素材已移走或不能本机读取',503);
          decoration=found;
        }
        const path=join(folder,clip.id+'-'+stamp+'-'+kind+'.png');
        const index=kind+'Id';
        if(!current[index]){
          await renderImage({kind:decoration?'video-overlay':'video',width:geometry.width,height:geometry.height,
            label:kind==='intro'?'本题先想':'方法回顾',topic:clip.questionType,
            title:kind==='intro'?clip.intro || clip.title:clip.outro},path);
          current[index]=await push(call,projectId,path);
          checkpoint();
        }
        const frames=decoration?.kind==='video'?Math.max(1,Math.min(Math.round(fps*2.5),Math.floor(decoration.duration/1_000_000*fps))):Math.round(2.5*fps);
        return {labelId:current[index],decoration,frames};
      };
      const intro=await makeCard('intro'),outro=await makeCard('outro');
      if(!current.timelineId){
        const name=clip.title+' · '+clip.id.slice(0,8)+' · '+stamp.slice(0,6);
        let found=(await call('read_project',{projectId})).timelines?.find(item=>item.name===name);
        if(!found){
          await call('manage_timelines',{projectId,action:'create',name,activate:false,
            compositionHeight:geometry.height,compositionWidth:geometry.width});
          found=(await call('read_project',{projectId})).timelines?.find(item=>item.name===name);
        }
        current.timelineId=found?.id;
        if(!current.timelineId)throw new AppError('ChatCut 未返回新时间线编号',503);
        checkpoint();
      }
      const timelineId=current.timelineId;
      if(!current.assembled){
        const card=(asset,startFrame)=>{
          const layer=(id,type,trackId)=>({assetId:id,type,trackId,startFrame,durationFrames:asset.frames,
            ...(type==='video'?{media:'video'}:{}),fit:'contain'});
          return asset.decoration?[layer(asset.decoration.id,asset.decoration.kind,'V1'),layer(asset.labelId,'image','V2')]:
            [layer(asset.labelId,'image','V1')];
        };
        await call('edit_item',{projectId,timelineId,adds:[...card(intro,0),
          {assetId:state.sourceId,type:'video',trackId:'V1',startFrame:intro.frames,durationFrames,
            sourceIn:Math.round(mark/fps*1_000_000),media:'audio-video',fit:'contain'},
          ...card(outro,intro.frames+durationFrames)]});
        current.assembled=true;checkpoint();
      }
      if(!current.taskId){
        const short=Math.min(geometry.width,geometry.height);
        const resolution=short>1200?'4K':short>760?'1080p':short>520?'720p':'480p';
        const expected=join(folder,clip.id+'-'+stamp+'.mp4');
        const task=await call('export',{projectId,timelineId,format:'video',codec:'h264',videoProfile:'sdr_h264',resolution,fps,
          outputPath:expected,endFrameExclusive:intro.frames+durationFrames+outro.frames},60_000);
        current.taskId=task.taskId;
        current.outputPath=task.outputPath;
        if(!current.outputPath)throw new AppError('ChatCut 未返回本机导出路径',503);
        checkpoint();
      }
      if(current.taskId){
        const progress=await call('track_progress',{action:'wait',target:'export',projectId,exportTaskIds:current.taskId},600_000);
        const item=(progress.jobs || progress.exports || progress.tasks || progress.items || []).find(x=>
          (x.id || x.taskId || x.exportTaskId)===current.taskId);
        if(item && ['failed','error','cancelled','canceled'].includes(item.status)){
          current.taskId=null;checkpoint();
          throw new AppError(text(item.error?.message || item.error || 'ChatCut 导出失败',240),422);
        }
        current.outputPath=item?.outputPath || item?.result?.outputPath || progress.outputPath || current.outputPath;
      }
      await access(current.outputPath).catch(()=>{throw new AppError('ChatCut 导出尚未返回成品，请稍后重试同一任务',503);});
      const real=await realpath(current.outputPath);
      if(dirname(real)!==await realpath(folder))throw new AppError('ChatCut 成品路径超出本机任务目录',422);
      const actual=await probeVideo(real);
      const expectedRatio=geometry.width/geometry.height;
      if(Math.abs(actual.width/actual.height/expectedRatio-1)>.007)throw new AppError('ChatCut 成片的宽高比与录屏不一致',422);
      const duration=await verifyClip(real,(intro.frames+durationFrames+outro.frames)/fps,actual);
      await copyFile(real,output);
      return {duration,mode:'ChatCut 本机导出',intro:intro.frames/fps,outro:outro.frames/fps,projectId,timelineId};
    });
  }
}

async function assetChoices(call,projectId){
  const choices=[];
  for(let offset=0;offset<2000;offset+=100){
    const {assets,total}=await call('browse_assets',{projectId,status:'ready',limit:100,offset});
    for(const asset of assets || []){
      if(!desktopId(asset.fullId)||!['image','video'].includes(asset.type)||!asset.sourceAccess?.desktopRegistered)continue;
      if(asset.type==='video'&&!(Number(asset.duration)>0))continue;
      choices.push({id:asset.fullId,name:asset.name || asset.filename,kind:asset.type,duration:asset.duration});
    }
    if(!assets?.length||offset+assets.length>=total||assets.length<100)break;
  }
  return choices;
}

async function push(call,projectId,filePath){
  const result=await call('push_asset',{projectId,filePath},60_000);
  const assetId=result.results?.find(item=>item.success)?.assetId;
  if(!desktopId(assetId))throw new AppError('ChatCut 未能读取备选的本机素材',503);
  return assetId;
}
