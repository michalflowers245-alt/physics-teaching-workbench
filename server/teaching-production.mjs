import {DatabaseSync} from 'node:sqlite';
import {createReadStream,createWriteStream,mkdirSync} from 'node:fs';
import {access,link,lstat,mkdir,mkdtemp,readFile,realpath,rename,rm,stat,statfs} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {homedir} from 'node:os';
import {AppError} from './store.mjs';
import {scheduledTopic} from '../shared/production-curriculum.mjs';
import {readBody,sendJson} from './routes.mjs';
import {parseTimedText,probeSpeech,probeVideo,renderClip,runTool,selectTeachingClips,transcribeWindow} from './production-media.mjs';
import {DeepSeekLesson} from './deepseek-lesson.mjs';
import {composeFeedback,composeParentFeedback,composeGroupFeedback,composePracticeSheet,createImageRenderer,createLessonReportRenderer,extractSpeechFacts,hasPrivateContent,hash,lessonLabel,normalizeMeta,promoData,publishLessonFiles,safeName,saveFeedbackPair,saveLearningFeedback,saveReviewImage,sheetData,text,today,validateFacts,extractTeachingFacts,extractLocalFacts,validateFeedbackEdit,verifyPng,withoutLessonNumber} from './production-feedback.mjs';

const SIZE_LIMIT=20*1024**3;
const WINDOW_SECONDS=480;
const CLIP_PLAN_VERSION='question-types-v1';
const FEEDBACK_IMAGE_VERSION='feedback-10-topic-only';
const RECORDING_FEEDBACK_VERSION=1;
const FEEDBACK_DOWNLOADS={
  report:['docxPath','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  review:['pngPath','image/png'],
  copy:['txtPath','text/plain; charset=utf-8'],
  parent:['parentPath','text/plain; charset=utf-8'],
  group:['groupPath','text/plain; charset=utf-8'],
  quiz:['practicePath','text/plain; charset=utf-8'],
  poster:['promoPath','image/png']
};
const now=()=>new Date().toISOString();
const stamp=()=>Date.now();
const analysisCacheKey=record=>'deepseek-classroom-v1:'+record.id+':'+record.analysisAttempt;
const gradeLabel=value=>({'初一':'七年级','初二':'八年级','初三':'九年级'})[value] || value || '';
const isId=value=>/^[0-9a-f-]{36}$/.test(value);
const errorMessage=error=>{
  const disk={EACCES:'没有写入权限',EPERM:'没有写入权限',ENOSPC:'磁盘空间不足',EROFS:'目录是只读的',ENOENT:'文件或目录已移动',ENOTDIR:'目标目录位置存在同名文件'};
  return disk[error.code] || error.message || '处理失败，请重试';
};

async function body(req) {
  const source=await readBody(req,2*1024**2);
  try {return JSON.parse(source.toString('utf8') || '{}');}
  catch {throw new AppError('请求格式无效');}
}

async function mediaResponse(req,res,file,mime,downloadName='') {
  const info=await stat(file).catch(()=>{throw new AppError('文件已移动或不再可用',404);});
  const headers={'Content-Type':mime,'Accept-Ranges':'bytes','Cache-Control':'private, no-store',
    'X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'};
  if(downloadName)headers['Content-Disposition']="attachment; filename*=UTF-8''"+
    encodeURIComponent(downloadName).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
  let start=0,end=info.size-1,status=200;
  if(req.headers.range){
    const range=String(req.headers.range).match(/^bytes=(\d*)-(\d*)$/);
    if(range&&(range[1]||range[2])){
      start=range[1]?Number(range[1]):Math.max(0,info.size-Number(range[2]));
      end=range[1]&&range[2]?Math.min(end,Number(range[2])):end;
    }
    if(!range||!(range[1]||range[2])||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=info.size){
      res.writeHead(416,{'Content-Range':'bytes */'+info.size});res.end();return;
    }
    status=206;headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length']=Math.max(0,end-start+1);
  res.writeHead(status,headers);
  if(req.method==='HEAD'||!info.size)res.end();
  else await pipeline(createReadStream(file,{start,end}),res).catch(()=>{});
}

export class TeachingProduction {
  constructor(program,store,engine,env,chatcut,{lessonAI}={}) {
    this.store=store;
    this.engine=engine;
    this.chatcut=chatcut;
    this.program=program;
    this.model=env.AI_MODEL || 'gpt-5.6-luna';
    this.localEvidence=env.AI_PROVIDER==='ollama';
    this.dir=join(store.data,'teaching-production');
    this.sources=join(this.dir,'sources');
    this.outputs=join(this.dir,'clips');
    this.desktop=resolve(env.PANEL_FEEDBACK_DIR || join(this.dir,'feedback'));
    this.lessonAI=lessonAI || new DeepSeekLesson({
      keyPath:env.PANEL_DEEPSEEK_KEY_FILE || join(this.dir,'deepseek-api-key'),
      envKey:env.DEEPSEEK_API_KEY
    });
    const [deliveryId,deliveryFolder]=String(env.PANEL_FEEDBACK_DESKTOP_COPY || '').split('|');
    if(isId(deliveryId)&&deliveryFolder&&safeName(deliveryFolder)===deliveryFolder){
      this.desktopDelivery={id:deliveryId,folder:deliveryFolder};
    }
    this.whisperModel=env.PANEL_WHISPER_MODEL || join(homedir(),'.cache','whisper','ggml-large-v3-turbo.bin');
    const python=env.PANEL_PRODUCTION_PYTHON || join(program,'.venv','bin','python');
    this.renderImage=createImageRenderer(program,python);
    this.renderReport=createLessonReportRenderer(program,python);
    for(const dir of [this.dir,this.sources,this.outputs])mkdirSync(dir,{recursive:true,mode:0o700});
    this.db=new DatabaseSync(join(this.dir,'production.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, updated TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS by_kind ON records(kind,updated); CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.writing=new Map();
    this.videoQueue=Promise.resolve();
    this.lessonQueue=Promise.resolve();
    this.stopping=false;
    for(const job of this.all('recording',-1)){
      if(['queued','running'].includes(job.status))this.queueVideo(job.id);
      else if(job.status==='uploading'&&!job.sourceHash){job.status='draft';this.put(job); }
    }
    for(const draft of this.all('moments',-1)){
      if(['generating','saving'].includes(draft.status)){
        if(draft.reviewOnly){
          this.runMoments(draft,draft.failedAction || (draft.facts?'save':'generate'));
          continue;
        }
        draft.status='failed';draft.error='上次处理被中断，按「重试」继续';this.put(draft);
      }
    }
    for(const job of this.all('recording',-1))if(job.autoFeedback&&!job.feedbackId&&job.sourceHash&&job.elapsed?.transcript!=null&&this.cache(this.transcriptKey(job))?.length)this.queueSpeechReview(job);
  }

  close(){
    this.stopping=true;
    this.db.close();
  }

  all(kind,max=75){return this.db.prepare('SELECT body FROM records WHERE kind=? ORDER BY updated DESC LIMIT ?').all(kind,max).map(row=>JSON.parse(row.body));}
  get(id,kind){
    const row=isId(id)?this.db.prepare('SELECT kind,body FROM records WHERE id=?').get(id):null;
    if(!row||row.kind!==kind)throw new AppError('记录不存在',404);
    return JSON.parse(row.body);
  }
  put(record){
    record.updated=now();
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,body=excluded.body')
      .run(record.id,record.kind,record.updated,JSON.stringify(record));
    return record;
  }
  cache(key){const row=this.db.prepare('SELECT value FROM cache WHERE key=?').get(key);return row?JSON.parse(row.value):null;}
  remember(key,value){this.db.prepare('INSERT OR REPLACE INTO cache VALUES(?,?)').run(key,JSON.stringify(value));}

  discardAnalysisAttempt(record){
    if(!record.analysisAttempt)return;
    this.db.prepare('DELETE FROM cache WHERE key=?').run(analysisCacheKey(record));
    delete record.analysisAttempt;
  }

  lessons(){
    const {state}=this.store.get();
    const plans=Object.values(state.sessions).map(s=>{
      const l=s.lesson, grade=gradeLabel(state.grades.find(g=>g.id===l.gradeId)?.name);
      const gate=state.courses[[l.gradeId,l.year,l.term].map(x=>encodeURIComponent(String(x || ''))).join('|')]?.plan;
      const specificTitle=/^\d{4}.*第\d+次课$/.test(l.title || '')?'':l.title;
      const topic=l.topic || specificTitle || (gate?.locked ? gate.lessons?.[Number(l.lessonNo)-1]?.title : '') || scheduledTopic({...l,grade});
      const base={sessionId:s.id,date:l.date || l.lessonDate || '',grade,lessonNo:String(l.lessonNo || ''),topic};
      // Material reuse is restricted to the confirmed answer snapshot rather than
      // class score, feedback, or student submissions.
      const verified=s.confirmations?.knowledge?.snapshot;
      const questions=verified && Object.entries(verified).filter(([,value])=>value && typeof value==='object').map(([number,x])=>{
        const description=[x.question,x.stem,x.topic,x.knowledge,x.answer,x.analysis,x.explanation].filter(v=>typeof v==='string' && v.trim());
        return description.length?'第'+number+'题 '+description.join('。'):'';
      }).filter(Boolean);
      return {...base,label:[grade,l.year+l.term,lessonLabel(base),topic].filter(Boolean).join(' · '),
        material:questions?.join('\n') || ''};
    });
    return plans;
  }
  meta(input){
    const selected=this.lessons().find(l=>l.sessionId===input?.sessionId);
    const source={...selected};
    for(const key of ['date','grade','lessonNo','topic'])if(input && Object.hasOwn(input,key))source[key]=input[key];
    source.sessionId=selected?.sessionId || '';
    return normalizeMeta(source);
  }
  source(record){return join(this.sources,record.sourceHash+'.media');}
  clipPath(folder,name){return join(this.outputs,folder,name);}
  present(record){
    if(record.kind==='recording'){
      const {subtitles,geometry,sourceHash,windowIndex,archivedClips,...rest}=record;
      const clips=(rest.clips || []).map(c=>({...c,version:c.version?{...c.version,path:this.clipPath(record.id,c.version.name)}:null}));
      return {...rest,clips,hasSource:!!sourceHash,videoDuration:geometry?.duration};
    }
    return record;
  }
  lists(kind){
    return this.all(kind).filter(r=>kind!=='recording'||r.sourceHash||r.status==='uploading').map(r=>kind==='recording'
      ? {id:r.id,name:r.name,purpose:r.purpose,clipPlan:r.clipPlan,status:r.status,stage:r.stage,updated:r.updated}
      : {id:r.id,name:r.meta.topic||r.facts?.topic||(r.bundle?'学习反馈':r.reviewOnly?'课堂复习图':'朋友圈草稿'),
        bundle:!!r.bundle,reviewOnly:!!r.reviewOnly,status:r.status,updated:r.updated});
  }

  newRecording(input){
    const name=basename(text(input.name,230));
    const classroom=input.classroom===true;
    const purpose=classroom?(/\.(mp4|mov)$/i.test(name)?'clips':'transcript'):input.purpose==='transcript'?'transcript':'clips';
    const meta=this.meta(classroom?{sessionId:input.meta?.sessionId}:input.meta);
    if(classroom&&(!meta.sessionId||!meta.date||!meta.topic))throw new AppError('先保存本课日期和主题，再上传课堂素材',422);
    const allowed=purpose==='transcript'?/\.(mp4|mov|m4a|wav|mp3|webm|ogg)$/i:/\.(mp4|mov)$/i;
    if(!allowed.test(name))throw new AppError(purpose==='transcript'?'请选择 MP4、MOV、M4A、WAV、MP3、WebM 或 OGG':'请选择 MP4 或 MOV 视频',415);
    if(!Number.isSafeInteger(input.size)||input.size<1||input.size>SIZE_LIMIT)throw new AppError('视频需小于 20 GiB',413);
    const subtitles=text(input.subtitles,1_500_001);
    if(subtitles.length>1_500_000)throw new AppError('字幕文件过大，请使用精简的时间码字幕',413);
    const autoFeedback=classroom||purpose==='transcript'&&input.autoFeedback===true;
    const renderer=purpose==='clips'&&input.renderer==='chatcut'?'chatcut':'ffmpeg';
    const template=renderer==='chatcut'?this.chatcut.validateChoice(input.template):null;
    return this.put({id:randomUUID(),kind:'recording',name,purpose,autoFeedback,
      ...(autoFeedback?{feedbackVersion:RECORDING_FEEDBACK_VERSION}:{}),...(classroom?{classroom:true}:{}),size:input.size,meta,status:'draft',
      stage:'等待上传',clips:[],subtitles,renderer,template,created:now(),elapsed:{}});
  }

  upload(req,record){
    if(record.sourceHash)return Promise.resolve(record);
    if(this.writing.has(record.id))throw new AppError('这一份视频正在上传',409);
    const op=this.receive(req,record);
    this.writing.set(record.id,op);
    return op.finally(()=>this.writing.delete(record.id));
  }
  async receive(req,record){
    req.setTimeout(60_000,()=>req.destroy());
    const disk=await statfs(this.sources,{bigint:true});
    if(disk.bavail*disk.bsize < BigInt(record.size)+1024n**3n)throw new AppError('磁盘空间不足，保留至少 1 GiB 的处理空间',507);
    if(Number(req.headers['content-length'])!==record.size)throw new AppError('视频上传大小与所选文件不一致',422);
    record.status='uploading';record.stage='上传到本机';delete record.error;this.put(record);
    const temp=await mkdtemp(join(this.dir,'upload-')),file=join(temp,'uploaded');
    let count=0;
    const digest=createHash('sha256');
    const meter=new Transform({transform(chunk,encoding,cb){
      count+=chunk.length;
      if(count>record.size)cb(new AppError('上传超出声明大小',413));
      else {digest.update(chunk);cb(null,chunk);}
    }});
    try{
      await pipeline(req,meter,createWriteStream(file,{flags:'wx',mode:0o600}));
      if(count!==record.size)throw new AppError('上传中断，请重新选取同一个文件',422);
      const fingerprint=digest.digest('hex');
      const key=this.recordingInputKey(record,fingerprint);
      await link(file,join(this.sources,fingerprint+'.media')).catch(error=>{if(error.code!=='EEXIST')throw error;});
      const duplicate=this.all('recording',-1).find(r=>r.id!==record.id&&r.inputKey===key);
      if(duplicate){
        this.db.prepare('DELETE FROM records WHERE id=?').run(record.id);
        if(duplicate.autoFeedback&&duplicate.status==='done'&&!duplicate.feedbackId)this.queueSpeechReview(duplicate);
        return duplicate;
      }
      record.sourceHash=fingerprint;record.inputKey=key;record.status='queued';record.stage='等待处理';
      this.put(record);this.queueVideo(record.id);return record;
    }catch(error){
      record.status='failed';record.error=errorMessage(error);this.put(record);
      throw error;
    }finally{await rm(temp,{recursive:true,force:true});}
  }

  recordingInputKey(record,fingerprint){
    const speech=record.purpose==='transcript';
    return hash(JSON.stringify({fingerprint,meta:record.meta,subtitles:record.subtitles,renderer:record.renderer,template:record.template,
      ...(speech?{purpose:'transcript'}:{clipPlan:CLIP_PLAN_VERSION}),...(record.autoFeedback?{autoFeedback:true}:{}),
      ...(record.feedbackVersion?{feedbackVersion:record.feedbackVersion}:{}),...(record.classroom?{classroom:true}:{})}));
  }

  recutByQuestionType(record){
    if(record.purpose==='transcript'||!record.sourceHash||!record.geometry)throw new AppError('这条记录没有可剪辑的原视频',422);
    if(this.writing.has('video:'+record.id))throw new AppError('请等当前导出结束后再重新分题',409);
    const inputKey=this.recordingInputKey(record,record.sourceHash);
    const existing=this.all('recording',-1).find(item=>item.inputKey===inputKey);
    if(existing)return existing;
    const nowTime=now();
    const next=this.put({id:randomUUID(),kind:'recording',purpose:'clips',name:record.name,size:record.size,meta:record.meta,
      subtitles:record.subtitles,renderer:record.renderer,template:record.template,sourceHash:record.sourceHash,inputKey,
      geometry:record.geometry,clipPlan:CLIP_PLAN_VERSION,clips:[],elapsed:{},stage:'等待处理',status:'queued',created:nowTime});
    this.queueVideo(next.id);
    return next;
  }

  rememberClipPlan(record){
    if(!record.segmentKey)return;
    this.remember(record.segmentKey,record.clips.map(({title,group,questionType,tested,start,end,intro,outro,reason})=>
      ({title,group,questionType,tested,start,end,intro,outro,reason:reason||''})));
  }

  queueVideo(id){
    if(this.writing.has('video:'+id))return;
    const promise=this.videoQueue.catch(()=>{}).then(()=>this.stopping?null:this.processVideo(id));
    this.writing.set('video:'+id,promise);
    this.videoQueue=promise.finally(()=>this.writing.delete('video:'+id));
    this.videoQueue.catch(()=>{});
  }

  transcriptKey(record){
    return 'asr-v2:'+record.sourceHash+':'+(record.subtitles?hash(record.subtitles):basename(this.whisperModel));
  }

  transcript(record){
    const rows=record.sourceHash && this.cache(this.transcriptKey(record));
    if(!rows?.length)throw new AppError('语音转写尚未完成，或没有识别到有效讲解',409);
    const chunks=[];
    let current=[];
    for(const row of rows){
      if(current.length&&row.start-current.at(-1).end>1.6){chunks.push(current);current=[];}
      current.push(row);
    }
    if(current.length)chunks.push(current);
    return {text:chunks.map(group=>group.map(r=>r.text).join('，').replace(/([。！？?!])，/g,'$1')).join('\n'),cues:rows,meta:record.meta};
  }

  async processVideo(id){
    const record=this.get(id,'recording'),source=this.source(record);
    if(!record.sourceHash)return;
    const phase=(stage)=>{record.status='running';record.stage=stage;delete record.error;this.put(record);};
    try{
      const speechOnly=record.purpose==='transcript';
      if(!record.geometry){
        phase(speechOnly?'读取音轨':'读取视频');
        const t=stamp();
        record.geometry=await (speechOnly?probeSpeech(source):probeVideo(source));
        record.elapsed.probe=stamp()-t;this.put(record);
      }
      const geometry=record.geometry;
      const asrKey=this.transcriptKey(record);
      let cues=this.cache(asrKey);
      if(!record.clips.length){
        phase('提取讲解');
        const t=stamp();
        const hit=!!cues;
        if(!cues&&record.subtitles){
          try {cues=parseTimedText(record.subtitles,geometry.duration);}
          catch(error){record.transcriptWarning=error.message+'，已采用本机转写';this.put(record);}
        }
        if(!cues){
          cues=[];
          const pieces=Math.ceil(geometry.duration/WINDOW_SECONDS);
          for(let i=0;i<pieces;i++){
            const start=i*WINDOW_SECONDS,key=asrKey+':part:'+i;
            let rows=this.cache(key);
            if(!rows){
              const overlap=i ? 2 : 0, from=start-overlap;
              rows=await transcribeWindow({source,start:from,duration:Math.min(WINDOW_SECONDS+overlap,geometry.duration-from),dir:this.dir,model:this.whisperModel});
              this.remember(key,rows);
            }
            for(let row of rows){
              const prior=cues.at(-1);
              if(prior&&row.start<prior.end-.1&&row.end<=prior.end+.4)continue;
              if(prior&&row.start<prior.end)row={...row,start:prior.end};
              if(row.end>row.start)cues.push(row);
            }
            record.segmentProgress={done:i+1,total:pieces};this.put(record);
          }
        }
        this.remember(asrKey,cues);
        record.elapsed.transcript=stamp()-t;record.transcriptCached=hit;
        if(speechOnly){
          if(!cues.length)throw new AppError('没有识别到有效语音，请检查录音音量后重试',422);
          record.status='done';record.stage='转写完成';this.put(record);
          if(record.autoFeedback)this.queueSpeechReview(record);
          return;
        }
        if(record.autoFeedback&&!record.feedbackId&&cues.length)this.queueSpeechReview(record);
        phase('识别题型与考点');
        const t2=stamp();
        const segmentKey=CLIP_PLAN_VERSION+':'+asrKey+':'+hash(JSON.stringify(record.meta));
        record.clipPlan=CLIP_PLAN_VERSION;
        const prior=this.cache(segmentKey);
        const ranges=prior || selectTeachingClips(cues,geometry.duration,(record.meta.topic || '').split(/[、，,；;、\s]/));
        record.segmentKey=segmentKey;
        record.clips=ranges.map(range=>({...range,id:randomUUID(),status:range.reason?'review':'queued',internal:true,versions:[]}));
        this.rememberClipPlan(record);
        record.elapsed.segment=stamp()-t2;this.put(record);
      }
      phase('导出片段');
      for(const clip of record.clips){
        if(!['queued','running'].includes(clip.status))continue;
        clip.status='running';delete clip.error;this.put(record);
        try{await this.exportClip(record,clip);clip.status='done';}
        catch(error){clip.status=error.status===503&&record.renderer==='chatcut'?'waiting':'failed';clip.error=errorMessage(error);}
        this.put(record);
      }
      record.clips.sort((a,b)=>a.start-b.start);
      record.status=record.clips.some(c=>c.status==='waiting')?'waiting':record.clips.some(c=>c.status==='failed')?'failed':
        record.clips.some(c=>c.status==='review')?'review':'done';
      record.stage=record.status==='done'?'导出完成':record.status==='review'?'待确认片段':record.status==='waiting'?'等待 ChatCut 连接':'部分片段需要重试';
      this.put(record);
    }catch(error){record.status='failed';record.error=errorMessage(error);this.put(record);}
  }

  async exportClip(record,clip){
    const folder=this.clipPath(record.id,'');
    await mkdir(folder,{recursive:true,mode:0o700});
    const temporary=await mkdtemp(join(folder,'.render-'));
    const output=join(temporary,'output.mp4');
    const stem=[record.meta.date || '日期待确认',safeName(record.meta.grade,'年级待确认'),
      safeName(withoutLessonNumber(clip.title,{heading:true}),'讲题片段').slice(0,40)].join('_');
    const t=stamp();
    try{
      const args={record,source:this.source(record),geometry:record.geometry,clip,output,dir:this.dir,renderImage:this.renderImage,checkpoint:()=>this.put(record)};
      const result=record.renderer==='chatcut'?await this.chatcut.render(args):await renderClip(args);
      for(let n=1;n<=10_000;n++){
        const name=stem+(n===1?'':'_v'+n)+'.mp4';
        try{await link(output,this.clipPath(record.id,name));}
        catch(error){if(error.code==='EEXIST')continue;throw error;}
        clip.version={name,...result,elapsed:stamp()-t,at:now(),start:clip.start,end:clip.end,title:clip.title};
        clip.versions.push(clip.version);return;
      }
      throw new AppError('同名视频版本过多，请调整标题',409);
    }finally{await rm(temporary,{recursive:true,force:true});}
  }
  updateClip(record,clip,input){
    if(this.writing.has('video:'+record.id))throw new AppError('当前录课正在处理，请等这一轮结束',409);
    const start=Number(input.start),end=Number(input.end);
    const title=text(input.title,90),intro=text(input.intro,100),outro=text(input.outro,100);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end-start<1||end>record.geometry.duration)
      throw new AppError('结束时间需在原视频范围内，并晚于开始时间至少 1 秒');
    if(!title||!intro||!outro)throw new AppError('请填写标题、片头问题和片尾方法');
    const overlap=record.clips.find(c=>c.id!==clip.id && Math.min(c.end,end)-Math.max(c.start,start)>.5);
    if(overlap)throw new AppError('与「'+overlap.title+'」交叠，请调整起止时间');
    const group='group' in input?text(input.group,28):clip.group;
    const questionType='questionType' in input?text(input.questionType,42):clip.questionType;
    const tested='tested' in input?text(input.tested,90):clip.tested;
    const same=clip.status==='done'&&start===clip.start&&end===clip.end&&title===clip.title&&intro===clip.intro&&outro===clip.outro&&questionType===clip.questionType;
    Object.assign(clip,{start,end,title,intro,outro,group,questionType,tested,reason:'',internal:input.publicApproved!==true});
    if(!same){
      clip.status='queued';record.status='queued';record.stage='导出片段';
    }
    this.rememberClipPlan(record);
    this.put(record);
    if(!same)this.queueVideo(record.id);
    return record;
  }

  updateSegments(record,input){
    if(this.writing.has('video:'+record.id)||!record.geometry)throw new AppError('请等当前录课处理结束，再调整分段',409);
    if(input?.updated!==record.updated)throw new AppError('这份录课记录已更新，请重新打开分段后再保存',409);
    if(!Array.isArray(input.clips)||!input.clips.length||input.clips.length>100)throw new AppError('请保留 1 至 100 条讲解片段');
    const prior=new Map(record.clips.map(clip=>[clip.id,clip])),used=new Set();
    const clips=input.clips.map((row,index)=>{
      const start=Number(row?.start),end=Number(row?.end);
      const title=text(row?.title,90),intro=text(row?.intro,100),outro=text(row?.outro,100);
      if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end-start<1||end>record.geometry.duration+.0005)
        throw new AppError('第 '+(index+1)+' 条的起止时间无效，请检查原片时长');
      if(!title||!intro||!outro)throw new AppError('请填写第 '+(index+1)+' 条的标题、片头和片尾');
      const saved=prior.get(row.id);
      if(row.id&&(!saved||used.has(row.id)))throw new AppError('存在重复或失效的片段，请重新打开分段',409);
      if(saved)used.add(saved.id);
      const endInSource=Math.min(end,record.geometry.duration);
      const same=saved?.status==='done'&&saved.start===start&&saved.end===endInSource&&
        saved.title===title&&saved.intro===intro&&saved.outro===outro;
      if(same)return saved;
      return {id:randomUUID(),start,end:endInSource,title,intro,outro,group:saved?.group,questionType:saved?.questionType,
        tested:saved?.tested,status:'queued',internal:true,versions:[]};
    }).sort((a,b)=>a.start-b.start);
    if(clips.some((clip,index)=>index>0&&clip.start<clips[index-1].end-.001))
      throw new AppError('分段时间有交叠，请调整相邻片段的起止时间');
    const kept=new Set(clips.map(clip=>clip.id));
    record.archivedClips=[...(record.archivedClips || []),...record.clips.filter(clip=>clip.version&&!kept.has(clip.id))];
    record.clips=clips;
    const hasPending=clips.some(clip=>clip.status==='queued');
    record.status=hasPending?'queued':'done';
    record.stage=hasPending?'导出片段':'导出完成';
    delete record.error;
    this.rememberClipPlan(record);
    this.put(record);
    if(hasPending)this.queueVideo(record.id);
    return record;
  }

  async zip(req,res,record){
    const files=record.clips.filter(c=>c.version).map(c=>[this.clipPath(record.id,c.version.name),
      record.clipPlan?safeName(c.group,'待确认')+'/'+c.version.name:c.version.name]);
    if(!files.length)throw new AppError('暂无可下载片段',404);
    const dir=await mkdtemp(join(this.dir,'zip-')),file=join(dir,'clips.zip');
    try{
      // zipfile sets the UTF-8 filename flag and streams large videos to ZIP64 archives.
      const script='import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], "w", compression=zipfile.ZIP_STORED, allowZip64=True) as out:\n for path,name in json.loads(sys.argv[2]): out.write(path, name)';
      await runTool('/usr/bin/python3',['-c',script,file,JSON.stringify(files)]);
      await mediaResponse(req,res,file,'application/zip','录课片段_'+safeName(record.meta.topic || record.name)+'.zip');
    }finally{await rm(dir,{recursive:true,force:true});}
  }

  approvePublic(input){
    if(input.confirmedPublic!==true)throw new AppError('请先确认这份课堂材料允许公开，并移除学生个人信息',422);
    const material=text(input.material,60_001);
    if(material.length<30||material.length>60_000)throw new AppError('请提交 30 至 60000 字的课堂内容，包含一道代表题的条件和方法',422);
    this.checkPrivate(material+'\n'+JSON.stringify(input.meta || {}));
    return material;
  }

  studentNames(){
    return Object.values(this.store.get().state.students).flatMap(s=>[s.name,...(s.names || [])]).filter(x=>typeof x==='string');
  }

  checkPrivate(content){
    if(hasPrivateContent(content,this.studentNames()))throw new AppError('内容疑似包含学生姓名、学号或联系方式，请脱敏后重试',422);
  }

  queueSpeechReview(record){
    const key='speech-review:'+record.id;
    let review=this.all('moments',-1).find(r=>r.inputKey===key);
    if(!review)review=this.put({id:randomUUID(),kind:'moments',inputKey:key,reviewOnly:true,
      ...(record.feedbackVersion?{bundle:true}:{}),...(record.classroom?{classroom:true}:{}),meta:{...record.meta},
      recordingId:record.id,status:'generating',created:now(),generatedDate:today(),versions:[]});
    record.feedbackId=review.id;
    this.put(record);
    if(review.status==='generating')this.runMoments(review,'generate');
  }

  newMoments(input){
    const material=this.approvePublic(input),meta=this.meta(input.meta);
    const recording=input.recordingId?this.get(input.recordingId,'recording'):null;
    const transcript=recording?this.transcript(recording):null;
    const useFullRecording=transcript&&material===text(transcript.text.slice(0,60_000),60_000);
    const key=hash(JSON.stringify({material,meta,recordingId:recording?.id,...(useFullRecording?{mode:'recording-analysis'}:{})}));
    const existing=this.all('moments',-1).find(r=>r.inputKey===key);
    if(existing)return existing;
    const record=this.put({id:randomUUID(),kind:'moments',inputKey:key,meta,recordingId:recording?.id,
      ...(useFullRecording?{reviewOnly:true,bundle:true}:{material}),status:'generating',created:now(),generatedDate:today(),versions:[]});
    this.runMoments(record,'generate');
    return record;
  }

  runMoments(record,action,input={}){
    const slot='moments:'+record.id;
    if(this.writing.has(slot))return;
    const original=action==='retry-ai'?structuredClone(record):null;
    const analyzing=record.reviewOnly&&record.recordingId&&
      (['rebuild','analyze'].includes(action)||action==='generate'&&!record.facts);
    if(analyzing){
      action='analyze';
      record.analysisAttempt ||= randomUUID();
      record.analysisStage='等待 DeepSeek 分析';
    }
    record.status=action==='save'?'saving':'generating';
    delete record.error;
    delete record.errorCode;
    record.failedAction=action;this.put(record);
    const work=analyzing
      ? this.lessonQueue.catch(()=>{}).then(()=>this.stopping?null:this.finishRecordingAnalysis(record,input))
      : this.finishMoments(record,action,input);
    if(analyzing)this.lessonQueue=work;
    const promise=work.catch(error=>{
      if(!this.stopping){
        if(original)this.put({...original,error:errorMessage(error)});
        else{
          record.status='failed';record.error=errorMessage(error);
          delete record.analysisStage;
          if(error.extra?.code)record.errorCode=error.extra.code;
          this.put(record);
        }
      }
    }).finally(()=>this.writing.delete(slot));
    this.writing.set(slot,promise);
  }

  validateMomentsEdit(record,input){
    if(input.baseUpdated && input.baseUpdated!==record.updated){
      throw new AppError('这份图文已在另一页面更新。请先保留你编辑的文字，再从历史中重新打开记录。',409);
    }
    const candidate={...record,meta:{...record.meta}};
    if(input.facts){
      candidate.facts=validateFacts(input.facts);
      const requestedSource=input.factSource;
      if(requestedSource && !['教师整理的课堂要点','AI根据录音整理，待教师复核'].includes(requestedSource)){
        throw new AppError('课堂要点来源标记无效',422);
      }
      candidate.factSource=requestedSource || '教师整理的课堂要点';
      if(requestedSource==='AI根据录音整理，待教师复核')candidate.reviewSuggested=true;
      delete candidate.factModel;
      delete candidate.analysis;
      delete candidate.analysisAttempt;
      delete candidate.aiIssue;
      candidate.meta.topic=candidate.facts.topic;
      if(!candidate.reviewOnly)candidate.body=composeFeedback(candidate.meta,candidate.facts);
      if(candidate.bundle)delete candidate.reviewRanges;
      if(hash(JSON.stringify([FEEDBACK_IMAGE_VERSION,candidate.meta,candidate.facts]))!==candidate.preview)delete candidate.preview;
    }
    if(!candidate.reviewOnly&&typeof input.body==='string'){
      if(!candidate.facts)throw new AppError('请先生成或填写课堂要点',422);
      candidate.body=validateFeedbackEdit(input.body,candidate.meta,candidate.facts);
    }
    this.checkPrivate(JSON.stringify(candidate.facts || {})+'\n'+(candidate.body || ''));
    return candidate;
  }

  verifiedClassroomReferences(record,recording){
    if(!record.classroom||!recording.sourceHash)return [];
    const sources=new Set(this.all('recording',-1).filter(r=>r.sourceHash===recording.sourceHash).map(r=>r.id));
    return this.all('moments',-1).filter(item=>item.id!==record.id&&item.status==='saved'&&!item.reviewSuggested&&
      item.versions.length&&item.facts&&sources.has(item.recordingId)&&
      ['已按录音核算例题','教师整理的课堂要点','沿用本课已核对的课堂要点'].includes(item.factSource));
  }

  reassignClassroomAudio(record,sessionId){
    if(!record.classroom||record.purpose!=='transcript'||record.status!=='done'||!record.feedbackId){
      throw new AppError('只可改放已转写、图文未生成的本课录音',422);
    }
    const review=this.get(record.feedbackId,'moments');
    if(review.recordingId!==record.id||this.writing.has('moments:'+review.id)){
      throw new AppError('请等待这份录音的课堂交付处理完成',409);
    }
    if(review.status!=='failed'||review.facts||review.versions.length){
      throw new AppError('这份录音已经有课堂要点或成品，不能直接改放课次',409);
    }
    const meta=this.meta({sessionId});
    if(!meta.sessionId||!meta.date||!meta.topic)throw new AppError('请为目标课次先保存日期和主题',422);
    if(meta.sessionId===record.meta.sessionId)throw new AppError('请选择另一课次',422);
    this.transcript(record);
    const inputKey=this.recordingInputKey({...record,meta},record.sourceHash);
    if(this.all('recording',-1).some(item=>item.id!==record.id&&item.inputKey===inputKey)){
      throw new AppError('目标课次已经有同一录音，请在目标课次查看',409);
    }
    const moved={...record,meta,inputKey,reassignments:[...(record.reassignments||[]),{from:record.meta,to:meta,at:now(),previousError:review.error || ''}]};
    const draft={...review,meta,status:'generating',failedAction:'generate'};
    delete draft.error;
    delete draft.errorCode;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.discardAnalysisAttempt(draft);
      this.put(moved);
      this.put(draft);
      this.db.exec('COMMIT');
    }catch(error){
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.runMoments(draft,'generate');
    return moved;
  }

  reclassifyFailedSpeechReview(record,input){
    if(!record.reviewOnly||!record.recordingId||record.status!=='failed'||record.versions?.length){
      throw new AppError('只能修正尚未保存成品的失败录音记录',409);
    }
    const recording=this.get(record.recordingId,'recording');
    if(recording.status!=='done'||this.writing.has('moments:'+record.id))throw new AppError('请等待录音转写完成后再修正课次',409);
    const meta=normalizeMeta({...input.meta,sessionId:''});
    if(!meta.date||!meta.grade||!meta.topic)throw new AppError('请填写上课日期、年级和本课主题；讲次可暂留空',422);
    this.transcript(recording);
    const changed=JSON.stringify(meta)!==JSON.stringify(record.meta);
    const previous={meta:record.meta,at:now(),reason:'教师修正录音课次信息'};
    const history=changed?[...(record.metadataHistory||[]),previous]:record.metadataHistory||[];
    const revised={...record,meta,status:'generating',failedAction:'generate',metadataHistory:history};
    const revisedRecording={...recording,meta,metadataHistory:changed?[...(recording.metadataHistory||[]),previous]:recording.metadataHistory||[]};
    for(const key of ['error','errorCode','facts','body','preview','factModel','factSource','reviewRanges','reviewSuggested','hasPromo','aiIssue'])delete revised[key];
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.discardAnalysisAttempt(revised);
      this.put(revisedRecording);
      this.put(revised);
      this.db.exec('COMMIT');
    }
    catch(error){this.db.exec('ROLLBACK');throw error;}
    this.runMoments(revised,'generate');
    return revised;
  }

  async finishMoments(record,action,input){
    const folder=join(this.dir,record.id);
    await mkdir(folder,{recursive:true,mode:0o700});
    if(action==='retry-ai'||(action==='generate'&&!record.facts)){
      let facts,source,review=false;
      try{
        const notes=record.recordingId&&extractLocalFacts(record.material,record.meta);
        const args={material:record.material,meta:record.meta,engine:this.engine,model:this.model,force:!!input.retry,localEvidence:this.localEvidence};
        const output=notes?{facts:notes}:await (record.recordingId?extractSpeechFacts(args):extractTeachingFacts(args));
        facts=output.facts;
        record.factModel=output.model;
        source=notes?'根据修订后的课堂记录整理':output.verified?'按原课转写与计算核验整理':'AI 根据已提供材料提取';
        review=!output.verified;
      }catch(error){
        if(action==='retry-ai')throw new AppError('本次 AI 重试未成功，已保留原有图文。'+errorMessage(error),error.status||503);
        if(Number(error.status)<500 && ![401,429].includes(error.status))throw error;
        const fallback=extractLocalFacts(record.material,record.meta);
        if(!fallback)throw new AppError(errorMessage(error)+'。也可以直接点「填写课堂要点」，在本机生成图文。',error.status || 503);
        facts=fallback;
        source='AI 暂不可用或提取未通过 · 按课堂原文在本机整理';
        review=true;
        delete record.factModel;
        record.aiIssue=errorMessage(error);
      }
      this.checkPrivate(JSON.stringify(facts));
      if(source.startsWith('AI 根据'))delete record.aiIssue;
      record.facts=facts;
      record.reviewSuggested=review;
      record.factSource=source;
      record.meta.topic ||= facts.topic;
      record.body=composeFeedback(record.meta,facts);
      if(action!=='retry-ai')this.put(record);
    }
    if(!record.facts)throw new AppError('请先生成或填写课堂要点',422);
    if(record.bundle&&!record.analysis)record.body=composeFeedback(record.meta,record.facts);
    if(record.body)record.body=withoutLessonNumber(record.body,{heading:true});
    this.checkPrivate(JSON.stringify(record.facts)+'\n'+(record.body || ''));
    const signature=hash(JSON.stringify([FEEDBACK_IMAGE_VERSION,record.meta,record.facts,record.analysis?.poster]));
    const makePromo=record.bundle||record.classroom||!record.reviewOnly;
    const previewPath=join(folder,signature+'.png');
    const promoPath=join(folder,signature+'-promo.png');
    const hasPreview=record.preview===signature &&
      await Promise.all((makePromo?[previewPath,promoPath]:[previewPath]).map(path=>verifyPng(path))).then(()=>true,()=>false);
    if(!hasPreview||action==='image'){
      const temp=await mkdtemp(join(folder,'.image-'));
      try{
        const png=join(temp,'preview.png'), promo=join(temp,'promo.png');
        await this.renderImage(sheetData(record.meta,record.facts),png);
        await verifyPng(png);
        if(makePromo){
          await this.renderImage(this.feedbackPoster(record.meta,record.facts,record.analysis?.poster),promo);
          await verifyPng(promo);await rename(promo,promoPath);
        }
        await rename(png,previewPath);
        record.preview=signature;
        record.hasPromo=!!makePromo;
        if(action!=='retry-ai')this.put(record);
      }finally{await rm(temp,{recursive:true,force:true});}
    }
    if(action==='image'||action==='generate'&&record.reviewSuggested&&!record.reviewOnly){
      record.status='preview';record.failedAction='';this.put(record);return;
    }
    if(record.reviewOnly){record.status='saving';this.put(record);}
    const output={root:this.desktop,meta:record.meta,facts:record.facts,image:previewPath,generatedDate:record.generatedDate};
    const saved=record.bundle?await saveLearningFeedback({...output,body:record.body,renderReport:this.renderReport,
      ranges:record.reviewRanges,factSource:record.factSource,
      parentText:record.analysis?.parentText || composeParentFeedback(record.meta,record.facts),groupText:composeGroupFeedback(record.meta,record.facts),
      practiceText:composePracticeSheet(record.meta,record.facts),promo:promoPath}):record.reviewOnly?await saveReviewImage(output):
      await saveFeedbackPair({...output,body:record.body,promo:promoPath});
    record.versions.push({...saved,id:randomUUID(),at:now(),requestKey:input.requestKey || null,
      ...(record.analysis?{model:record.analysis.model,analyzedAt:record.analysis.analyzedAt}:{})});
    if(!record.reviewOnly||action==='save'&&record.factSource==='教师整理的课堂要点')record.reviewSuggested=false;
    record.status='saved';record.failedAction='';this.put(record);
  }

  feedbackPoster(meta,facts,poster){
    const data=promoData(meta,facts);
    if(!poster)return data;
    const {hook,knowledge,methods}=poster;
    return {...data,hook,knowledge,methods};
  }

  checkRecordingAssignment(record,recording){
    if(recording.purpose!=='transcript')return;
    const references=this.verifiedClassroomReferences(record,recording);
    const exact=references.some(item=>['date','grade','lessonNo','topic'].every(key=>item.meta?.[key]===record.meta[key]));
    const sameDay=references.filter(item=>item.meta.date===record.meta.date&&item.meta.grade&&item.meta.lessonNo&&item.meta.topic);
    const lessons=new Map(sameDay.map(item=>[JSON.stringify([item.meta.grade,item.meta.lessonNo,item.meta.topic]),item.meta]));
    if(exact||lessons.size!==1)return;
    const known=lessons.values().next().value;
    if(known.grade!==record.meta.grade||known.lessonNo!==record.meta.lessonNo){
      throw new AppError('同一录音已按'+known.grade+' '+lessonLabel(known)+'《'+known.topic+'》核对。请在本节课改放到正确课次。',422,{code:'lesson_mismatch'});
    }
  }

  async finishRecordingAnalysis(record,input){
    const recording=this.get(record.recordingId,'recording');
    this.checkRecordingAssignment(record,recording);
    const {cues}=this.transcript(recording);
    const cacheKey=analysisCacheKey(record);
    const stage=label=>{
      if(this.stopping)throw new AppError('服务停止，重开后可继续处理。',503);
      record.analysisStage=label;
      this.put(record);
    };
    const pending=this.cache(cacheKey) || {};
    const result=pending.result || await this.lessonAI.analyze({
      cues,meta:record.meta,studentNames:this.studentNames(),onStage:stage
    });
    const {facts,parentText:originalParent,momentsText:originalMoments,poster,ranges,...analysis}=result;
    const parentText=withoutLessonNumber(originalParent,{heading:true});
    const momentsText=withoutLessonNumber(originalMoments,{heading:true});
    stage('正在排版并保存四份课堂成品');
    record.status='saving';
    this.put(record);
    this.checkPrivate(JSON.stringify(result));
    this.remember(cacheKey,{result,...(pending.saved?{saved:pending.saved}:{})});
    const meta={...record.meta,topic:record.meta.lessonNo&&record.meta.topic?record.meta.topic:facts.topic};
    const factSource=analysis.editorialReviewedAt?'DeepSeek 已分析录音并完成教学校订':'DeepSeek 已分析录音';
    const signature=hash(JSON.stringify([FEEDBACK_IMAGE_VERSION,meta,facts,poster]));
    const folder=join(this.dir,record.id);
    await mkdir(folder,{recursive:true,mode:0o700});
    const work=await mkdtemp(join(folder,'.analysis-'));
    const png=join(work,'review.png'), promo=join(work,'promo.png');
    try{
      await this.renderImage(sheetData(meta,facts),png);
      await this.renderImage(this.feedbackPoster(meta,facts,poster),promo);
      const saved=pending.saved || await saveLearningFeedback({root:this.desktop,meta,facts,body:momentsText,
        image:png,generatedDate:record.generatedDate,renderReport:this.renderReport,ranges,factSource,parentText,
        groupText:composeGroupFeedback(meta,facts),promo});
      this.remember(cacheKey,{result,saved});
      let deliveryDir;
      const deliveryFolder=this.desktopDelivery?.id===record.id?this.desktopDelivery.folder:null;
      if(deliveryFolder)deliveryDir=await publishLessonFiles(this.desktop,deliveryFolder,saved);
      await rename(png,join(folder,signature+'.png'));
      await rename(promo,join(folder,signature+'-promo.png'));
      const version={...saved,id:randomUUID(),at:now(),requestKey:input.requestKey || null,
        model:analysis.model,analyzedAt:analysis.analyzedAt,...(deliveryDir?{deliveryDir}:{})};
      if(this.stopping)return;
      delete record.analysisStage;
      delete record.analysisAttempt;
      delete record.aiIssue;
      Object.assign(record,{facts,body:momentsText,reviewRanges:ranges,reviewSuggested:false,factSource,
        factModel:analysis.model,analysis:{...analysis,parentText,poster},preview:signature,hasPromo:true,bundle:true,
        status:'saved',failedAction:'',versions:[...record.versions,version]});
      this.put(record);
      this.db.prepare('DELETE FROM cache WHERE key=?').run(cacheKey);
    }finally{await rm(work,{recursive:true,force:true});}
  }

  async feedbackDownload(record,type,version){
    const [key,mime]=FEEDBACK_DOWNLOADS[type];
    const saved=version===null?record.versions.at(-1):record.versions.find(item=>item.id===version);
    const file=saved?.[key];
    if(!file)throw new AppError('这份成品还没有保存',404);
    const directory=await realpath(saved.dir).catch(()=>null);
    if(!directory||!directory.startsWith(this.desktop+sep)||dirname(file)!==directory){
      throw new AppError('成品目录已移动或不在教育反馈目录内',404);
    }
    const info=await lstat(file).catch(()=>null);
    if(!info?.isFile()||!info.size||await realpath(file).catch(()=>null)!==file){
      throw new AppError('成品文件已移动或不可下载',404);
    }
    return {file,mime};
  }

  async run(req,res,url){
    const p=url.pathname,m=req.method,root='/api/teaching-production';
    if(!p.startsWith(root+'/'))return false;
    const ok=(result,status=200)=>{sendJson(res,status,result);return true;};
    if(p===root+'/deepseek'&&m==='GET')return ok(await this.lessonAI.status());
    if(p===root+'/deepseek'&&m==='POST'){
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new AppError('密钥设置只接受 JSON。',415);
      const input=await body(req);
      return ok(await this.lessonAI.configure(input.apiKey));
    }
    if(p===root+'/context'&&m==='GET')return ok({lessons:this.lessons(),chatcut:this.chatcut.cachedStatus()});
    if(p===root+'/chatcut/status'&&m==='GET')return ok(await this.chatcut.status());
    if(p===root+'/chatcut/projects'&&m==='GET')return ok(await this.chatcut.projects());
    if(p===root+'/chatcut/assets'&&m==='GET')return ok(await this.chatcut.assets(url.searchParams.get('projectId')));
    if(p===root+'/recordings'){
      if(m==='GET')return ok(this.lists('recording'));
      if(m==='POST')return ok(this.present(this.newRecording(await body(req))),201);
    }
    if(p===root+'/moments'){
      if(m==='GET')return ok(this.lists('moments'));
      if(m==='POST')return ok(this.newMoments(await body(req)),202);
    }
    let match=p.match(/^\/api\/teaching-production\/recordings\/([0-9a-f-]+)(?:\/(file|retry|zip|clips|segments|transcript|recut|reassign)(?:\/([0-9a-f-]+)(?:\/(file))?)?)?$/);
    if(match){
      const [,id,action,clipId,fileAction]=match,r=this.get(id,'recording');
      if(!action&&m==='GET')return ok(this.present(r));
      if(action==='file'&&m==='PUT')return ok(this.present(await this.upload(req,r)),202);
      if(action==='transcript'&&m==='GET')return ok(this.transcript(r));
      if(action==='reassign'&&m==='POST'&&!clipId){
        const input=await body(req);
        return ok(this.present(this.reassignClassroomAudio(this.get(id,'recording'),input.sessionId)),202);
      }
      if(r.purpose==='transcript'&&['zip','segments','clips','recut'].includes(action))throw new AppError('这是语音识别记录，请在语音识别中查看',404);
      if(action==='file'&&['GET','HEAD'].includes(m)&&r.sourceHash&&/\.(mp4|mov)$/i.test(r.name)){
        await mediaResponse(req,res,this.source(r),/\.mov$/i.test(r.name)?'video/quicktime':'video/mp4',
          url.searchParams.has('download')?r.name:'');return true;
      }
      if(action==='zip'&&m==='GET'){await this.zip(req,res,r);return true;}
      if(action==='recut'&&m==='POST'&&!clipId)return ok(this.present(this.recutByQuestionType(r)),202);
      if(action==='segments'&&!clipId&&m==='POST')return ok(this.present(this.updateSegments(r,await body(req))),202);
      if(action==='retry'&&m==='POST'&&r.sourceHash){
        if(!this.writing.has('video:'+id)){
          r.clips.forEach(c=>{if(['failed','waiting'].includes(c.status))c.status='queued';});
          r.status='queued';this.put(r);this.queueVideo(id);
        }
        return ok(this.present(r),202);
      }
      if(action==='clips'){
        const clip=r.clips.find(c=>c.id===clipId) ||
          (fileAction&&(r.archivedClips || []).find(c=>c.id===clipId));
        if(!clip)throw new AppError('片段不存在',404);
        if(!fileAction&&m==='POST')return ok(this.present(this.updateClip(r,clip,await body(req))),202);
        if(fileAction&&['GET','HEAD'].includes(m)&&clip.version){
          await mediaResponse(req,res,this.clipPath(r.id,clip.version.name),'video/mp4',url.searchParams.has('download')?clip.version.name:'');return true;
        }
      }
    }
    match=p.match(/^\/api\/teaching-production\/moments\/([0-9a-f-]+)\/download\/(report|review|copy|parent|group|quiz|poster)$/);
    if(match&&['GET','HEAD'].includes(m)){
      const [,id,type]=match;
      const {file,mime}=await this.feedbackDownload(this.get(id,'moments'),type,url.searchParams.get('version'));
      await mediaResponse(req,res,file,mime,basename(file));
      return true;
    }
    match=p.match(/^\/api\/teaching-production\/moments\/([0-9a-f-]+)(?:\/(retry|retry-ai|save|image|preview|promo|open-folder|metadata|rebuild))?$/);
    if(match){
      const [,id,action]=match,r=this.get(id,'moments');
      if(!action&&m==='GET')return ok(r);
      if(action==='preview'&&['GET','HEAD'].includes(m)&&r.preview){
        await mediaResponse(req,res,join(this.dir,r.id,r.preview+'.png'),'image/png');return true;
      }
      if(action==='promo'&&['GET','HEAD'].includes(m)&&r.preview&&r.hasPromo){
        await mediaResponse(req,res,join(this.dir,r.id,r.preview+'-promo.png'),'image/png');return true;
      }
      if(action==='open-folder'&&m==='POST'){
        const saved=r.versions.at(-1);
        if(!saved)throw new AppError('请先保存成品',409);
        const delivered=saved.deliveryDir&&await realpath(saved.deliveryDir).catch(()=>null);
        const folder=delivered||await realpath(saved.dir);
        if(!folder.startsWith(this.desktop+sep))throw new AppError('输出目录不在教育反馈目录内',403);
        if(r.bundle)for(const type of ['report','review','copy',...(saved.parentPath?['parent']:[]),...(saved.groupPath?['group']:[]),...(saved.practicePath?['quiz']:[]),...(saved.promoPath?['poster']:[])])await this.feedbackDownload(r,type,saved.id);
        if(saved.txtPath)await access(saved.txtPath);
        await access(saved.pngPath);
        if(saved.promoPath)await access(saved.promoPath);
        await runTool('/usr/bin/open',[folder],{timeout:15_000});
        return ok({opened:folder});
      }
      if(['retry','retry-ai','save','image'].includes(action)&&m==='POST'){
        const input=await body(req);
        const latest=this.get(id,'moments');
        const requestKey=typeof input.requestKey==='string'?input.requestKey.slice(0,80):null;
        if(requestKey && latest.versions.some(version=>version.requestKey===requestKey))return ok(latest);
        if(this.writing.has('moments:'+id))throw new AppError('正在处理这份图文，请稍候再操作',409);
        if(action==='retry-ai'&&(!latest.versions.length||!latest.factSource?.startsWith('AI 暂不可用')))throw new AppError('当前没有需要重新生成的本机图文',409);
        if(!latest.facts&&action!=='retry'&&!(action==='image'&&input.facts))throw new AppError('请先生成课堂要点');
        const operation=action==='retry'?(latest.failedAction || (!latest.facts?'generate':'save')):action;
        const draft=this.validateMomentsEdit(latest,input);
        if(input.facts)this.discardAnalysisAttempt(latest);
        this.runMoments(draft,operation,{requestKey,retry:action==='retry'||action==='retry-ai'});
        return ok(draft,202);
      }
      if(action==='metadata'&&m==='POST')return ok(this.reclassifyFailedSpeechReview(r,await body(req)),202);
      if(action==='rebuild'&&m==='POST'){
        const input=await body(req);
        const requestKey=typeof input.requestKey==='string'?input.requestKey.slice(0,80):null;
        if(requestKey&&r.versions.some(version=>version.requestKey===requestKey))return ok(r);
        if(!r.reviewOnly||!r.recordingId||this.writing.has('moments:'+r.id))throw new AppError('当前录音记录暂不能重新整理',409);
        if(input.baseUpdated&&input.baseUpdated!==r.updated)throw new AppError('这份材料刚刚更新，请重新打开后操作。',409);
        const recording=this.get(r.recordingId,'recording');
        if(recording.status!=='done')throw new AppError('请等待转写完成后重新整理',409);
        this.discardAnalysisAttempt(r);
        const draft={...r,analysisAttempt:randomUUID()};
        this.runMoments(draft,'rebuild',{requestKey});
        return ok(draft,202);
      }
    }
    throw new AppError('教学成品接口不存在或不支持此操作',404);
  }
}
