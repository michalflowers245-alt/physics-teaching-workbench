import {spawn} from 'node:child_process';
import {access, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {AppError} from './store.mjs';
import {classifyTeachingQuestion} from './teaching-video-types.mjs';

export const ffmpeg = '/opt/homebrew/bin/ffmpeg';
export const ffprobe = '/opt/homebrew/bin/ffprobe';
const whisper = '/opt/homebrew/bin/whisper-cli';
const frameMargin = 0.08;
const videoTimescale = ['-video_track_timescale', '90000'];

export function runTool(command, args, {cwd, stdin, timeout = 900_000, maxOutput = 12 * 1024 * 1024} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']});
    let output = [], bytes = 0, errors = '', reason;
    const stop = message => { reason = message; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('处理超时，请重试这一阶段'), timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxOutput) stop('工具返回内容超出限制');
      else output.push(chunk);
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-2000); });
    child.on('error', error => { clearTimeout(timer); reject(new AppError('本机工具无法启动：' + error.code, 503)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (reason || code !== 0) {
        const detail = errors.split('\n').map(s => s.trim()).filter(Boolean).at(-1);
        reject(new AppError(reason || `本机工具处理失败${detail ? '：' + detail.slice(0, 220) : ''}`, 422));
      } else resolve(Buffer.concat(output).toString('utf8'));
    });
    if (stdin) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
  });
}

function rate(value) {
  const [a, b = 1] = String(value || '').split('/').map(Number);
  return a / b;
}

export async function probeVideo(file) {
  const result = JSON.parse(await runTool(ffprobe, ['-v','error','-show_format','-show_streams','-of','json',file], {timeout: 45_000}));
  const video = result.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = result.streams.find(stream => stream.codec_type === 'audio');
  const duration = Number(result.format?.duration);
  if (!video || !audio || !Number.isFinite(duration) || duration <= 0 || !video.width || !video.height ||
      !result.format?.format_name?.split(',').some(name => name === 'mov' || name === 'mp4')) {
    throw new AppError('需要有讲解音轨的 MP4 或 MOV 视频', 422);
  }
  const rotation = Number(video.side_data_list?.find(item => item.rotation != null)?.rotation || 0);
  const sar = rate(video.sample_aspect_ratio?.replace(':','/'));
  const w = video.width * (sar > 0 ? sar : 1);
  const rotated = Math.abs(rotation) % 180 === 90;
  const even = n => Math.max(2, Math.round(n / 2) * 2);
  const fps = rate(video.avg_frame_rate);
  return {duration, width: even(rotated ? video.height : w), height: even(rotated ? w : video.height),
    fps: fps > 0 && fps <= 120 ? fps : 30, rotation, video, audio};
}

export async function probeSpeech(file) {
  const info = JSON.parse(await runTool(ffprobe, ['-v','error','-show_format','-show_streams','-of','json',file], {timeout:45_000}));
  const formats = (info.format?.format_name || '').split(',');
  const audio = info.streams?.find(stream => stream.codec_type === 'audio');
  if (!audio || !formats.some(format => ['mp4','mov','mp3','wav','matroska','webm','ogg'].includes(format))) {
    throw new AppError('文件不含可识别的音轨，请选择有声音的 MP4、MOV 或录音文件',422);
  }
  let duration = Number(info.format?.duration || audio.duration);
  if (!Number.isFinite(duration)) {
    // MediaRecorder WebM may omit the duration from its container header.
    const progress = await runTool(ffmpeg, ['-nostdin','-v','error','-progress','pipe:1','-i',file,'-map','0:a:0','-f','null','-'], {timeout:120_000});
    duration = Number([...progress.matchAll(/^out_time_us=(\d+)$/gm)].at(-1)?.[1]) / 1e6;
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new AppError('录音时长无法读取，请重新录音或换一个文件',422);
  return {duration};
}

export function parseTimedText(input, duration) {
  const at = value => value.split(':').map(x => Number(x.replace(',', '.'))).reduce((a, b) => a * 60 + b, 0);
  const source = input.replace(/^\uFEFF/,'').replaceAll('\r','').trim();
  const cues = [];
  if (source.startsWith('[')) {
    try {
      for (const row of JSON.parse(source)) cues.push({start:Number(row.start),end:Number(row.end),text:String(row.text || '').trim()});
    } catch { throw new AppError('转写 JSON 应为带 start、end（秒）和 text 的列表', 422); }
  } else {
    for (const block of source.split(/\n\s*\n/)) {
      const lines = block.split('\n');
      const i = lines.findIndex(line => line.includes('-->'));
      if (i < 0) {
        if (/^(?:WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block)) continue;
        throw new AppError('字幕含有无法读取的时间码，请检查 SRT 或 VTT', 422);
      }
      const timing = lines[i].match(/^\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})(?:\s|$)/);
      if (!timing) throw new AppError('字幕时间码格式不正确', 422);
      cues.push({start:at(timing[1]),end:at(timing[2]),text:lines.slice(i+1).join(' ').replace(/<[^>]*>/g,'').trim()});
    }
  }
  if (!cues.length || cues.length > 30_000 || cues.some((c,i) => !c.text || !Number.isFinite(c.start) ||
      !Number.isFinite(c.end) || c.start < 0 || c.end <= c.start || c.end > duration + 0.25 ||
      (i && c.start < cues[i-1].end - 0.05))) {
    throw new AppError('字幕含空段、交叠或超出视频的时间码，请检查后重新上传', 422);
  }
  return cues.map(c => ({...c, end:Math.min(c.end,duration)}));
}

export async function transcribeWindow({source, start, duration, dir, model}) {
  await access(model).catch(() => { throw new AppError('找不到本机 Whisper 模型，请恢复 ggml-large-v3-turbo.bin 后重试',503); });
  const temporary = await mkdtemp(join(dir, 'asr-'));
  const wav = join(temporary, 'audio.wav');
  const result = join(temporary, 'cues');
  try {
    await runTool(ffmpeg, ['-nostdin','-v','error','-ss',String(start),'-i',source,'-t',String(duration),'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',wav]);
    await runTool(whisper, ['-m',model,'-l','zh','-f',wav,'-oj','-of',result,'-t','4','-np'], {timeout:1_800_000});
    const parsed = JSON.parse(await readFile(result+'.json','utf8'));
    return (parsed.transcription || []).map(row => ({
      start:start + row.offsets.from / 1000, end:start + Math.min(duration,row.offsets.to / 1000),
      text:row.text.trim().replaceAll('比热溶','比热容').replaceAll('比熱容','比热容').replaceAll('做提时','做题时'),
    })).filter(row => row.text && row.end > row.start && !/^\[[^\]]+\]$/.test(row.text));
  } finally { await rm(temporary,{recursive:true,force:true}); }
}

const opening = /第[一二三四五六七八九十\d]+(?:道题|个知识点|讲)|换(?:一道题?|一题|一个知识点)|下一(?:道题?|题|个知识点)|接下来(?:看|讲|讨论|学习)(?:下一|另一|新的一)|另一个知识点|再看一道/;
const conditions = /题目|已知|假设|设有|题干|如果|当.{0,18}时|问题是|质量相同|条件/;
const reasoning = /根据|因为|所以|代入|公式|先.{1,20}再|控制变量|通过.+判断|乘以|除以|大于|小于|相同|比较/;
const conclusion = /结论|最终|得出|答案|可知|说明|因此|所以|符合/;
const noise = /听不清|看不清|没听到|没有声音|字幕由|感谢观看|下期视频|訂閱/;
const depends = /(?:这儿|这个图|这里|看图|图上|黑板上).{0,12}(?:这个|这[边条]|那里|如下|所示|写的)/;
const named = ['扩散','分子热运动','热传递','比热容','内能','蒸发','凝华','熔化','光的反射','平面镜成像','折射','密度','欧姆定律','焦耳定律','电功率','串联电路','并联电路','浮力','压强','杠杆','机械效率','惯性','声现象'];

const partPattern=/(?:^|^(?:然后|那么|接下来|那|好|首先|所以)(?:首先|第一个|我们|你们|来看|看一下|看|就|吧|[，,\s]){0,6})\s*第([一二三四五六七八九十\d]+)[小]?[问文](?=\s|$|[，,：:呢就它是问])/u;
const partNumber=value=>({一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}[value]||Number(value)||0);
const recap=/^(?:所以|因此|就|刚才)|(?:那么|然后)?第[一二三四五六七八九十\d]+[问文](?:它考|已经|就比较简单)/u;
const continues=/同一(?:题|解法)|还是刚才|接着上一步|第一种情况|第二种情况|另一种(?:情况|方法)|两种(?:情况|方法)/u;
const finished=/算出|等于|答案|结论|因此|所以|最后|解出|符合/u;
const speechMarker=/^(?:大家好|同学们|我们来看|你看|对吧|有没有问题|听懂了吗|做完了)/u;
const asSentence=rows=>rows.map(row=>row.text).join('，');

function findSubQuestion(text){
  const line=text.trim().replace(/^[，,\s]+/u,'').replace(/^(?:我们来看一下这个|我们来看这个|我们看一下这个|我们看一下|我们看|然后我们来看一下这个|然后我们看一下这个|然后我们看一下|然后我们看|然后首先第一个[，,]?)/u,'');
  return recap.test(line)?0:partNumber(line.match(partPattern)?.[1]);
}

export function selectTeachingClips(cues, duration, hints = []) {
  if (!cues.length) return [{title:'手动标记讲解区间',start:0,end:Math.min(duration,60),intro:'请填写这段讲解的真实问题',outro:'请填写本题的方法',reason:'未识别到可用讲解，请预听原片并标记时间码'}];
  const groups=[];
  let segment={rows:[],part:0,focus:0};
  let segmentText='';
  for(const cue of cues){
    const part=findSubQuestion(cue.text);
    const last=segment.rows.at(-1);
    const size=last?last.end-segment.rows[0].start:0;
    const nextQuestion=last&&opening.test(cue.text)&&!continues.test(cue.text)&&(finished.test(segmentText)||cue.start-last.end>3);
    const nextPart=part>segment.part&&segment.part>0&&size>=11&&finished.test(segmentText);
    if(nextQuestion||nextPart){
      groups.push(segment);
      segment={rows:[],part:0,focus:0};
      segmentText='';
    }
    if(part&&!segment.part){
      segment.part=part;
      segment.focus=segment.rows.length;
    }
    segment.rows.push(cue);
    segmentText+='，'+cue.text;
  }
  if(segment.rows.length)groups.push(segment);
  const keywords=[...new Set([...named,...hints.filter(s=>s.length>=2&&s.length<20)])];
  return groups.map(({rows,part,focus},index)=>{
    const first=rows[0],last=rows.at(-1);
    const relevant=rows.slice(focus);
    const nearStart=asSentence(relevant.filter(r=>r.start<relevant[0].start+105));
    const body=asSentence(relevant);
    const tail=asSentence(relevant.filter(r=>r.end>=last.end-60));
    const model=classifyTeachingQuestion(nearStart)||classifyTeachingQuestion(body);
    const topic=keywords.find(word=>nearStart.includes(word));
    const directQuestion=nearStart.split(/[。！!？?，,]/u).map(s=>s.trim())
      .find(s=>s.length>=7&&s.length<=55&&/如何|为什么|怎么|多大|多少|哪[个种]|是否|会不会/u.test(s)&&!speechMarker.test(s));
    const question=directQuestion?directQuestion+'？':'';
    const answer=tail.split(/[。！？]/u).map(s=>s.trim()).reverse()
      .find(s=>conclusion.test(s)&&s.length>=6&&s.length<=90) || relevant.slice(-6).map(c=>c.text).reverse().find(s=>finished.test(s)&&s.length>=6);
    const issues=[];
    const hasPrompt=conditions.test(nearStart)||!!question||/他问|它说|第[一二三四五六七八九十\d]+[问文]|求出|求.{0,14}多少/u.test(nearStart);
    const continuation=/第一种情况|接着上|我们继续/u.test(asSentence(rows.slice(0,4)))&&!part;
    if(!model)issues.push(topic?'考点已识别，具体题型待确认':'题型和考点证据不足');
    if(!hasPrompt||continuation)issues.push('缺少独立题干或前置条件');
    if(!reasoning.test(body)&&!/等于|除以|公式|比上/u.test(body))issues.push('未找到关键推理');
    if(model?.finish?!model.finish.test(tail):!finished.test(tail))issues.push('未找到可核对的本问结论');
    if(body.length<48||last.end-first.start<10)issues.push('讲解证据过短');
    if(noise.test(nearStart)||noise.test(tail)||(!model&&depends.test(body)))issues.push('疑似转写噪声或需对照板书');
    if(rows.some((r,i)=>i&&r.start-rows[i-1].end>25))issues.push('中间有长停顿，请检查边界');
    const questionType=model?.type||'题型待确认';
    return {title:(part?'第'+part+'问 · ':'')+(model?.type||topic||'讲解片段 '+(index+1)),
      group:model?.group||'待确认',questionType,tested:model?.tested||topic||'',
      start:Math.max(0,first.start-(index?0:frameMargin)),end:Math.min(duration,last.end+.12,nextStart(groups,index)),
      intro:model?.hook||question||nearStart.slice(0,58),
      outro:model?.method||answer||'',
      reason:issues.join('；')};
  });
}

function nextStart(groups,index){
  return groups[index+1]?.rows[0].start ?? Infinity;
}

async function encodeCard(directory, name, png, seconds, geometry) {
  await runTool(ffmpeg, ['-nostdin','-v','error','-loop','1','-framerate',String(geometry.fps),'-i',png,
    '-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000','-t',String(seconds),'-map','0:v','-map','1:a',
    '-vf','setsar=1,format=yuv420p','-c:v','libx264','-preset','veryfast','-profile:v','high','-c:a','aac','-ar','48000','-ac','2',
    ...videoTimescale,name],{cwd:directory});
}

function streamShape(probe) {
  const v=probe.video,a=probe.audio;
  return JSON.stringify([v.codec_name,v.profile,v.width,v.height,v.pix_fmt,v.time_base,v.avg_frame_rate,v.has_b_frames,
    a.codec_name,a.profile,a.sample_rate,a.channels,a.time_base]);
}

async function exactKeyframes(file, start, end, fps, duration) {
  const from = Math.max(0, start - 2), width = end - from + 2;
  const sample = await runTool(ffprobe,['-v','error','-select_streams','v:0','-skip_frame','nokey',
    '-read_intervals',`${from}%+${width}`,'-show_entries','frame=best_effort_timestamp_time','-of','csv=p=0',file], {timeout:120_000});
  const keys = sample.split('\n').map(line => line.split(',')[0].trim()).filter(Boolean).map(Number).filter(Number.isFinite);
  const key = time => keys.some(n=>Math.abs(n-time) <= Math.min(.024, .55/fps));
  return key(start) && (key(end) || Math.abs(end-duration) < .55/fps);
}

export async function verifyClip(file, duration, geometry) {
  const result = await probeVideo(file);
  const tolerance = Math.max(.2, 3/geometry.fps);
  const lengths = [Number(result.video.duration),Number(result.audio.duration)];
  const startDrift = Math.abs(Number(result.video.start_time || 0)-Number(result.audio.start_time || 0));
  if (result.video.codec_name !== 'h264' || result.audio.codec_name !== 'aac' ||
      result.width !== geometry.width || result.height !== geometry.height ||
      Math.abs(result.duration-duration) > tolerance || startDrift > .09 ||
      lengths.some(n=>!Number.isFinite(n)) || Math.abs(lengths[0]-lengths[1]) > tolerance) {
    throw new AppError('成片时长、比例或音视频流校验失败，请重试导出',422);
  }
  for (const point of [0, Math.max(0, result.duration - .4)]) {
    await runTool(ffmpeg,['-nostdin','-v','error','-xerror','-ss',String(point),'-i',file,'-t','0.32','-map','0:v','-map','0:a','-f','null','-'],{timeout:60_000});
  }
  return result.duration;
}

export async function renderClip({source, geometry, clip, output, dir, renderImage}) {
  const work = await mkdtemp(join(dir,'render-'));
  const intro = 2.5, outro = 2.5, length = clip.end - clip.start;
  const total = length + intro + outro;
  const media = ['-nostdin','-v','error'];
  const leadingVideoGap = Math.max(0, Number(geometry.video.start_time || 0)-clip.start);
  const position = clip.start>0?['-ss',String(clip.start)]:[];
  const input = leadingVideoGap?['-i',source,...position]:[...position,'-i',source];
  const seek = [...input,'-t',String(length),'-map','0:v:0','-map','0:a:0'];
  // Some screen recordings contain audio before the first picture. Hold that first picture across the gap so the
  // concat demuxer does not add drift to the body or discard the start of the original audio.
  const pad = leadingVideoGap>0.005?`tpad=start_mode=clone:start_duration=${leadingVideoGap},`:'';
  try {
    await renderImage({kind:'video',width:geometry.width,height:geometry.height,label:'本题先想',topic:clip.questionType,title:clip.intro || clip.title},join(work,'intro.png'));
    await renderImage({kind:'video',width:geometry.width,height:geometry.height,label:'方法回顾',topic:clip.questionType,title:clip.outro},join(work,'outro.png'));
    await encodeCard(work,'intro.mp4','intro.png',intro,geometry);
    await encodeCard(work,'outro.mp4','outro.png',outro,geometry);
    await writeFile(join(work,'join.txt'),"file 'intro.mp4'\nfile 'body.mp4'\nfile 'outro.mp4'\n");
    const joinFiles = () => runTool(ffmpeg,[...media,'-y','-f','concat','-safe','1','-i','join.txt','-c','copy','-movflags','+faststart',output],{cwd:work});
    if (!geometry.rotation && geometry.video.codec_name === 'h264' && geometry.audio.codec_name === 'aac' &&
        geometry.width === geometry.video.width && geometry.height === geometry.video.height &&
        await exactKeyframes(source,clip.start,clip.end,geometry.fps,geometry.duration).catch(()=>false)) {
      try {
        await runTool(ffmpeg,[...media,...seek,'-c','copy','-avoid_negative_ts','make_zero',...videoTimescale,'body.mp4'],{cwd:work});
        if (streamShape(await probeVideo(join(work,'intro.mp4'))) !== streamShape(await probeVideo(join(work,'body.mp4')))) throw new Error('码流参数不同');
        await joinFiles();
        return {duration:await verifyClip(output,total,geometry),mode:'关键帧快速导出',intro,outro};
      } catch { /* The precise route handles media with incompatible packet boundaries. */ }
    }
    await runTool(ffmpeg,[...media,'-y',...seek,'-vf',`${pad}scale=${geometry.width}:${geometry.height}:flags=lanczos,setsar=1,format=yuv420p`,
      '-fps_mode:v','passthrough','-enc_time_base:v','1:90000','-c:v','libx264','-preset','veryfast','-crf','17','-profile:v','high',
      '-c:a','aac','-ar','48000','-ac','2',...videoTimescale,'body.mp4'],{cwd:work});
    await joinFiles();
    return {duration:await verifyClip(output,total,geometry),mode:'精确切点导出',intro,outro};
  } finally { await rm(work,{recursive:true,force:true}); }
}

export async function validateMp4(file) {
  if (!(await stat(file)).size) throw new AppError('导出文件为空',422);
  return probeVideo(file);
}
