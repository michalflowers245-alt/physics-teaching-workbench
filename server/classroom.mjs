import {randomUUID} from 'node:crypto';
import {AppError} from './store.mjs';
import {readBody,sendJson} from './routes.mjs';
import {normalizeMeta,text,today} from './production-feedback.mjs';

export const leadStages=['咨询','已约试听','已到课','已报名','已结束'];
const timestamp=()=>new Date().toISOString();
const productionBase='/api/teaching-production';

function requireDate(value,label,optional=false){
  if(optional&&!value)return '';
  if(typeof value!=='string'||!value)throw new AppError('请填写'+label,422);
  return normalizeMeta({date:value}).date;
}

function releaseLink(value){
  if(!value)return '';
  try{
    const url=new URL(text(value,1024));
    if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)return url.href;
  }catch{}
  throw new AppError('发布链接请填写 HTTP 或 HTTPS 地址',422);
}

export class Classroom {
  constructor(production){this.production=production;}

  lesson(sessionId){
    const sessions=this.production.store.get().state.sessions;
    const session=Object.hasOwn(sessions,sessionId)?sessions[sessionId]:null;
    const meta=this.production.lessons().find(item=>item.sessionId===sessionId);
    if(!session||!meta)throw new AppError('请先保存课次',404);
    return {session,meta};
  }

  workspace(sessionId){
    return this.production.all('classroom',-1).find(row=>row.sessionId===sessionId)||
      {id:randomUUID(),kind:'classroom',sessionId,revision:0,publications:[],leads:[],familyDelivery:null};
  }

  lessonFiles(record){
    const version=record.versions.at(-1);
    if(!version)return null;
    const links={report:'docxPath',review:'pngPath',parent:'parentPath',copy:'txtPath',poster:'promoPath'};
    const files=Object.fromEntries(Object.entries(links).filter(([,key])=>version[key]).map(([type])=>
      [type,productionBase+'/moments/'+record.id+'/download/'+type+'?version='+encodeURIComponent(version.id)]));
    return {id:version.id,files,folder:version.dir};
  }

  priorChecks(lesson){
    const {state}=this.production.store.get();
    const sessions=Object.values(state.sessions).filter(row=>row.lesson.gradeId===lesson.gradeId&&
      String(row.lesson.year)===String(lesson.year)&&row.lesson.term===lesson.term&&
      Number(row.lesson.lessonNo)<Number(lesson.lessonNo)).sort((a,b)=>Number(b.lesson.lessonNo)-Number(a.lesson.lessonNo));
    return sessions.flatMap(row=>{
      const label='第'+row.lesson.lessonNo+'讲';
      const display=(entry,view,detail)=>({sessionId:row.id,view,label,detail,name:state.students[entry.studentId]?.name||'学生待确认'});
      const corrections=(row.corrections||[]).filter(item=>item.status!=='passed')
        .map(item=>display(item,'wrongbook','第'+item.question+'题待订正或复核'));
      const followups=(row.followups||[]).filter(item=>!item.completedAt)
        .map(item=>display(item,'feedback',item.note||'待跟进'));
      return [...corrections,...followups];
    }).slice(0,8);
  }

  details(sessionId){
    const {session,meta}=this.lesson(sessionId);
    const workflow=this.workspace(sessionId);
    const recordings=this.production.all('recording',-1)
      .filter(r=>r.meta.sessionId===sessionId&&(r.sourceHash||r.status==='uploading'))
      .map(r=>this.production.present(r));
    const deliveries=this.production.all('moments',-1).filter(r=>r.meta.sessionId===sessionId)
      .map(r=>({id:r.id,recordingId:r.recordingId,topic:r.meta.topic,status:r.status,error:r.error,updated:r.updated,
        factSource:r.factSource,factModel:r.factModel,analysisStage:r.analysisStage,
        reviewSuggested:r.reviewSuggested,hasPreview:!!r.preview,errorCode:r.errorCode,
        canReassign:r.status==='failed'&&!r.facts&&!r.versions.length,version:this.lessonFiles(r)}));
    return {meta,prep:session.lesson.classroomPrep||{},recordings,deliveries,revision:workflow.revision,
      familyDelivery:workflow.familyDelivery,publications:workflow.publications,leads:workflow.leads,priorChecks:this.priorChecks(session.lesson),
      studentFollowups:(session.followups||[]).filter(row=>!row.completedAt).length,
      corrections:(session.corrections||[]).filter(row=>row.status!=='passed').length};
  }

  outreach(){
    const lessons=new Map(this.production.lessons().map(meta=>[meta.sessionId,meta]));
    return this.production.all('classroom',-1).flatMap(row=>{
      if(!lessons.has(row.sessionId)||!row.publications.length&&!row.leads.length)return [];
      return [{sessionId:row.sessionId,lesson:lessons.get(row.sessionId).label,revision:row.revision,
        publications:row.publications,leads:row.leads}];
    });
  }

  publicationSource(sessionId,input){
    if(input.sourceType==='poster'){
      const delivery=this.production.get(input.sourceId,'moments');
      const version=delivery.versions.find(row=>row.id===input.sourceVersion);
      if(delivery.meta.sessionId!==sessionId||!version?.promoPath)throw new AppError('请选择本课已保存的宣发图',422);
      return {sourceType:'poster',sourceId:delivery.id,sourceVersion:version.id,title:delivery.meta.topic+' · 课后图文'};
    }
    if(input.sourceType==='clip'){
      const recording=this.production.get(input.sourceId,'recording');
      const clip=recording.clips.find(row=>row.id===input.clipId);
      if(recording.meta.sessionId!==sessionId||!clip?.version||clip.version.name!==input.sourceVersion)throw new AppError('请选择本课已导出的当前片段',422);
      return {sourceType:'clip',sourceId:recording.id,clipId:clip.id,sourceVersion:clip.version.name,title:clip.title};
    }
    throw new AppError('请选择已保存的图文或视频',422);
  }

  async update(sessionId,input){
    this.lesson(sessionId);
    const row=this.workspace(sessionId);
    if(input.revision!==row.revision)throw new AppError('本课跟进记录已更新，请刷新后再操作',409);
    if(input.action==='family'){
      const artifact=this.production.get(input.delivery,'moments');
      const version=artifact.versions.find(item=>item.id===input.version);
      if(artifact.meta.sessionId!==sessionId||!version?.parentPath)throw new AppError('请选择本课已保存的家长稿',422);
      row.familyDelivery={deliveryId:artifact.id,version:version.id,sentAt:timestamp()};
    }else if(input.action==='publication'){
      if(input.approved!==true)throw new AppError('请确认这份内容已实际发布，并已核查公开范围',422);
      const source=this.publicationSource(sessionId,input);
      const channel=text(input.channel,32),date=requireDate(input.date,'发布日期'),url=releaseLink(input.url);
      if(!channel)throw new AppError('请填写发布渠道',422);
      if(row.publications.some(old=>old.sourceId===source.sourceId&&old.clipId===source.clipId&&
          old.sourceVersion===source.sourceVersion&&old.channel===channel&&old.date===date&&old.url===url))return row;
      row.publications.unshift({id:randomUUID(),...source,channel,date,url,created:timestamp()});
    }else if(input.action==='lead'){
      const previous=input.leadId?row.leads.find(x=>x.id===input.leadId):null;
      if(input.leadId&&!previous)throw new AppError('咨询记录不存在',404);
      const label=text(input.label,60),note=text(input.note,500);
      const stage=leadStages.includes(input.stage)?input.stage:null;
      if(!label||!stage)throw new AppError('请补齐咨询称呼和进展',422);
      const publicationId=text(input.publicationId,40),origin=text(input.origin,60);
      if(publicationId&&!row.publications.some(item=>item.id===publicationId))throw new AppError('请选择本课已登记的内容来源',422);
      if(!publicationId&&!origin)throw new AppError('请填写咨询来源',422);
      const nextAt=requireDate(input.nextAt,'下次跟进日期',true);
      const history=[...(previous?.history||[])];
      if(stage!==previous?.stage)history.push({stage,at:timestamp()});
      const record={id:previous?.id||randomUUID(),label,note,stage,publicationId,origin,nextAt,history,updated:timestamp()};
      row.leads=previous?row.leads.map(item=>item.id===record.id?record:item):[record,...row.leads];
    }else{
      throw new AppError('不支持此操作',405);
    }
    row.revision+=1;
    return this.production.put(row);
  }

  async run(req,res,url){
    if(url.pathname!=='/api/classroom')return false;
    if(req.method==='GET'){
      const sessionId=url.searchParams.get('session');
      sendJson(res,200,sessionId?this.details(sessionId):{rows:this.outreach(),stages:leadStages,today:today()});
      return true;
    }
    if(req.method==='POST'){
      let input;
      try{input=JSON.parse((await readBody(req,64*1024)).toString('utf8'));}
      catch{throw new AppError('请求格式无效');}
      if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.sessionId!=='string')throw new AppError('请选择课次',422);
      const row=await this.update(input.sessionId,input);
      sendJson(res,200,{revision:row.revision});
      return true;
    }
    throw new AppError('不支持此操作',405);
  }
}
