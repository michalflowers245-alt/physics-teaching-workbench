import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {AppError} from './store.mjs';

export function createLocalOcr(root){
  const executable=join(root,'native','panel-ocr');
  if(process.platform!=='darwin'||!existsSync(executable))return null;
  return (base64,signal)=>new Promise((resolve,reject)=>{
    const bytes=Buffer.from(base64,'base64');
    if(!bytes.length||bytes.length>18*1024*1024){
      reject(new AppError('图片过大或已损坏，请上传较小的清晰图片',422));
      return;
    }
    const child=spawn(executable,[],{stdio:['pipe','pipe','ignore'],signal});
    let output='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
    child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');});
    child.once('error',()=>{
      clearTimeout(timer);
      reject(new AppError(signal.aborted?'任务已取消或超时':'无法启动本机文字识别',503));
    });
    child.once('close',code=>{
      clearTimeout(timer);
      if(code!==0){reject(new AppError('图片的本机文字识别失败。请缩小图片或手工校对。',422));return;}
      try{
        const lines=JSON.parse(output);
        if(!Array.isArray(lines)||lines.length===0)throw Error();
        const text=lines.filter(line=>typeof line==='string').join('\n').trim();
        if(!text)throw Error();
        if(text.length>14000){
          reject(new AppError('这张图片的文字太多，请按区域裁切后分别识别。',422));
          return;
        }
        resolve(text);
      }catch{reject(new AppError('图片里没有识别到清晰的文字，请重拍或手工校对。',422));}
    });
    child.stdout.setEncoding('utf8');
    child.stdin.end(bytes);
  });
}
