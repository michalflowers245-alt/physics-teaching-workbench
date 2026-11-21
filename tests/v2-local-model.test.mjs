import assert from 'node:assert/strict';
import test from 'node:test';
import {createModelService} from '../server/model-service.mjs';
import {extractTeachingFacts} from '../server/production-feedback.mjs';

const base={AI_PROVIDER:'ollama',AI_MODEL:'deepseek-r1:8b',AI_TEXT_FALLBACK:'deepseek-r1:1.5b',AI_VISION_MODEL:'qwen3-vl:4b',
  AI_API_KEY:'not-for-the-local-model',AI_BASE_URL:'http://127.0.0.1:11434'};
const remote=async (url,options)=>{throw new Error('wrong route: '+url.pathname+' '+options.method);};
const fixture=(installed=[])=>{
  const calls=[];
  const service=createModelService(base,{fetchImpl:async(url,options)=>{
    calls.push({url,options});
    if(url.pathname==='/api/tags')return Response.json({models:installed.map(name=>({name}))});
    if(url.pathname==='/api/chat'){
      const {model}=JSON.parse(options.body);
      return Response.json({model,done:true,done_reason:'stop',message:{content:'本机模型输出',thinking:'内部推理不返回'},prompt_eval_count:11,eval_count:9});
    }
    return remote(url,options);
  }});
  return {service,calls};
};

test('文字任务走已下载的 DeepSeek，模型就绪后切换到主模型，且不发旧密钥',async()=>{
  const installed=[base.AI_TEXT_FALLBACK];
  const {service,calls}=fixture(installed);
  const input={model:'旧模型',messages:[{role:'user',content:'生成课堂文案'}]};
  const initial=await service.prepare(input);
  assert.equal(initial.model,base.AI_TEXT_FALLBACK);
  installed.push(base.AI_MODEL);
  await service.status({force:true});
  const actual=await service.prepare(input);
  assert.equal(actual.model,base.AI_MODEL);
  const result=await service.invoke(actual,new AbortController().signal);
  const sent=calls.at(-1);
  assert.equal(sent.url.href,'http://127.0.0.1:11434/api/chat');
  assert.equal(sent.options.redirect,'error');
  assert(!new Headers(sent.options.headers).has('Authorization'));
  assert.equal(JSON.parse(sent.options.body).truncate,false);
  assert.equal(result.choices[0].message.content,'本机模型输出');
  assert.deepEqual(result.usage,{prompt_tokens:11,completion_tokens:9,total_tokens:20});
  assert(!JSON.stringify(result).includes('内部推理'));
});

test('图片任务使用本机识图模型；没有安装时不交给文字模型',async()=>{
  const png='data:image/png;base64,iVBORw0KGgo=';
  const input={response_format:{type:'json_object'},messages:[{role:'user',content:[{type:'text',text:'读照片'},
    {type:'image_url',image_url:{url:png}}]}]};
  const installed=[base.AI_MODEL];
  const {service,calls}=fixture(installed);
  await assert.rejects(service.prepare(input),{status:503});
  assert(calls.every(x=>x.url.pathname==='/api/tags'));
  installed.push(base.AI_VISION_MODEL);
  await service.status({force:true});
  const payload=await service.prepare(input);
  const result=await service.invoke(payload,new AbortController().signal);
  assert.equal(result.model,base.AI_VISION_MODEL);
  const sent=JSON.parse(calls.at(-1).options.body);
  assert.equal(sent.format,'json');
  assert.deepEqual(sent.messages,[{role:'user',content:'读照片',images:['iVBORw0KGgo=']}]);
  payload.messages[0].content[1].image_url.url='https://example.com/photo.png';
  await assert.rejects(service.invoke(payload,new AbortController().signal),{status:422});
});

test('本机模型配置拒绝外部域名和云端模型标签',()=>{
  assert.throws(()=>createModelService({...base,AI_BASE_URL:'https://example.com'}),/回环地址/);
  assert.throws(()=>createModelService({...base,AI_MODEL:'deepseek:671b-cloud'}),/本机模型名/);
});

test('扫描答案页明确标注的选择答案不会被解析正文替换',async()=>{
  const service=createModelService(base,{ocr:async()=> '第1题 标准答案：D\n解析：水升温更少。',fetchImpl:async(url)=>{
    if(url.pathname==='/api/tags')return Response.json({models:[{name:base.AI_TEXT_FALLBACK}]});
    return Response.json({model:base.AI_TEXT_FALLBACK,done:true,done_reason:'stop',message:{content:'{"questions":[{"id":"1","answer":"水升温更少","explanation":"原解析"}],"warnings":[]}' }});
  }});
  const payload=await service.prepare({response_format:{type:'json_schema',json_schema:{name:'answer_page_v1',schema:{type:'object'}}},
    messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgo='}}]}]});
  const result=await service.invoke(payload,new AbortController().signal);
  assert.equal(result.inputMode,'ocr');
  assert.deepEqual(JSON.parse(result.choices[0].message.content).questions,[{id:'1',answer:'D',explanation:'水升温更少。'}]);
});

test('学生续页以原卷印刷题号和原答为候选依据',async()=>{
  const service=createModelService(base,{ocr:async()=> '第3题 作答：D',fetchImpl:async(url)=>{
    if(url.pathname==='/api/tags')return Response.json({models:[{name:base.AI_TEXT_FALLBACK}]});
    return Response.json({done:true,done_reason:'stop',message:{content:'{"answers":[{"id":"2","answer":"D","uncertain":true}],"warnings":[]}'}});
  }});
  const payload=await service.prepare({response_format:{type:'json_schema',json_schema:{name:'student_answers_v1',schema:{type:'object'}}},
    messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgo='}}]}]});
  const result=await service.invoke(payload,new AbortController().signal);
  assert.deepEqual(JSON.parse(result.choices[0].message.content).answers,[{id:'3',answer:'D',uncertain:false}]);
});

test('卷头有明确小数分时保留卷面读数',async()=>{
  const service=createModelService(base,{ocr:async()=> '姓名：陈小满\n卷面得分：9.5',fetchImpl:async(url)=>{
    if(url.pathname==='/api/tags')return Response.json({models:[{name:base.AI_TEXT_FALLBACK}]});
    return Response.json({done:true,done_reason:'stop',message:{content:'{"name":"陈小满","score":"","warning":""}'}});
  }});
  const payload=await service.prepare({response_format:{type:'json_schema',json_schema:{name:'paper_header_v1',schema:{type:'object'}}},
    messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,iVBORw0KGgo='}}]}]});
  const result=await service.invoke(payload,new AbortController().signal);
  assert.equal(JSON.parse(result.choices[0].message.content).score,'9.5');
});

test('DeepSeek 选择课堂原文编号，图文事实由原句组装，跨题选择被拒绝',async()=>{
  const material=[
    '第一道题，探究比热容。',
    '题目给出等质量的水和油，用相同的加热器供热。',
    '为什么要比较升温多少？',
    '先控制质量与加热时间。',
    '根据吸热量相近，升温少的物质比热容大。',
    '因此水升温少，水的比热容较大。',
    '易错点是忽略质量相同。',
    '家长可以问：为什么加热时间要一样？',
    '第二道题，另一场实验。',
    '因此铁块体积会改变。',
  ].join('\n');
  const selected={hook:3,knowledge:5,condition:2,method:4,conclusion:6,mistake:7,parent:8};
  const generate=conclusion=>extractTeachingFacts({material,meta:{topic:'比热容'},model:base.AI_MODEL,localEvidence:true,engine:{
    async request({payload}){
      assert.equal(payload.response_format.type,'json_schema');
      return {model:base.AI_TEXT_FALLBACK,choices:[{message:{content:JSON.stringify({...selected,conclusion})}}]};
    }
  }});
  const output=await generate(6);
  assert.equal(output.model,base.AI_TEXT_FALLBACK);
  assert(output.facts.evidence.every(line=>material.includes(line)));
  assert.match(output.facts.steps[1],/水的比热容较大/);
  await assert.rejects(generate(10),/跨题/);
});
