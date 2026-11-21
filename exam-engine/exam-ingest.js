/* Lossless import candidates. Source evidence is immutable; only teachers publish revisions. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ExamIngest = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const HUNAN = ['株洲','湘潭','衡阳','邵阳','岳阳','常德','张家界','益阳','郴州','永州','怀化','娄底','湘西','湘西土家族苗族自治州'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const now = () => new Date().toISOString();
  const id = prefix => `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '')}`;
  const digits = text => String(text ?? '').normalize('NFKC');
  const clean = text => digits(text).replace(/\[\[PAGE:\d+\]\]/g, '').replace(/(?:第\s*)?\d+\s*页\s*(?:共\s*\d+\s*页)?/g, '').replace(/(?:www\.[\w.-]+|https?:\/\/\S+|\d{4}[年./-]\d{1,2}[月./-]\d{1,2}日)/g, '').replace(/(?:版权所有|仅供|发布日期|下载时间)[^\n]{0,80}/g, '').replace(/[\s\u200b\ufeff]+/g, '').toLowerCase();
  function validateMetadata(input) {
    const d = { ...input, year: String(input.year || '').trim(), region: String(input.region || '').trim().replace(/市$/, '') };
    d.paperOriginId=String(input.paperOriginId||'').trim();d.paperOriginName=String(input.paperOriginName||'').trim();
    d.applicableRegions=[...new Set((Array.isArray(input.applicableRegions)?input.applicableRegions:String(input.applicableRegions||'').split(/[，,、;；\n]/)).map(x=>String(x).trim().replace(/市$/,'')).filter(Boolean))];
    if(d.paperOriginId&&!/^[\p{L}\p{N}_.:-]{1,120}$/u.test(d.paperOriginId))throw new Error('命题方案 ID 仅使用文字、数字及 _ . : -，不超过120字');
    if(d.applicableRegions.some(x=>!['长沙',...HUNAN].includes(x)))throw new Error('适用地区请选择湖南地市；非湖南资料请将此项留空');
    if (!/^20\d{2}$/.test(d.year)) throw new Error('必须填写四位试卷年份');
    if (!['A','B','C','D'].includes(d.sourceLayer)) throw new Error('PDF 仅接受 A-D 类；E 类请导入作答');
    if (!d.region) throw new Error('必须填写来源地区');
    if (d.sourceLayer === 'A' && (d.region !== '长沙' || d.examType !== '中考原卷')) throw new Error('A 类只能是长沙中考原卷');
    if (d.sourceLayer === 'B' && (!HUNAN.includes(d.region) || d.examType !== '中考原卷')) throw new Error('B 类只能是湖南其他地市中考原卷');
    if (d.sourceLayer === 'C' && (d.region !== '长沙' || d.examType === '中考原卷')) throw new Error('C 类只能是长沙学校或集团考试');
    return d;
  }
  function detectMetadata(text, confirmed) {
    const source = digits(text);
    const years = [...new Set(source.match(/20\d{2}/g) || [])];
    const regions = ['长沙', ...HUNAN].filter(city => source.includes(city));
    const suggestion = { year: years.length === 1 ? years[0] : null, region: regions.length === 1 ? regions[0] : null,
      examType: /模拟|联考|期中|期末/.test(source) ? '非中考原卷' : /中考/.test(source) ? '中考原卷' : null };
    const conflicts = Object.keys(suggestion).filter(key => suggestion[key] && confirmed[key] && suggestion[key] !== confirmed[key]).map(key => ({ field: key, confirmed: confirmed[key], detected: suggestion[key] }));
    if (years.length > 1) conflicts.push({ field: 'year', confirmed: confirmed.year, detected: years.join('、') });
    return { ...confirmed, suggestion, conflicts };
  }
  function pageBlocks(items, width, height) {
    const tokens = items.filter(x => String(x.str || '').trim()).map(x => {
      const size = Math.abs(x.height || x.transform?.[3] || 10);
      return { text: x.str, x: x.transform?.[4] || 0, y: height - (x.transform?.[5] || 0) - size,
        width: x.width || 0, height: size, eol: Boolean(x.hasEOL) };
    }).sort((a,b) => a.y-b.y || a.x-b.x);
    const rows = [];
    tokens.forEach(token => {
      let row = rows.findLast(r => Math.abs(r.y-token.y) <= Math.max(2, token.height*.25));
      if (!row) { row = { y: token.y, tokens: [] }; rows.push(row); }
      row.tokens.push(token);
    });
    let blocks = [];
    rows.forEach(row => {
      const ordered = row.tokens.sort((a,b) => a.x-b.x);
      let run = [];
      const emit = () => {
        if (!run.length) return;
        const left = Math.min(...run.map(x=>x.x)), top = Math.min(...run.map(x=>x.y));
        const right = Math.max(...run.map(x=>x.x+x.width)), bottom = Math.max(...run.map(x=>x.y+x.height));
        blocks.push({ text: run.map(x=>x.text).join(' '), bbox: [left/width, top/height, (right-left)/width, (bottom-top)/height], cells: run.map(x=>({text:x.text,x:x.x/width})) });
        run = [];
      };
      ordered.forEach(t => { const prev = run.at(-1); if (prev && t.x-(prev.x+prev.width) > width*.15) emit(); run.push(t); });
      emit();
    });
    const numbered = blocks.filter(b => /^\s*(?:第\s*)?[1-9]\d?\s*[、.．]/.test(b.text));
    const columns = numbered.some(b=>b.bbox[0]>.48) && numbered.some(b=>b.bbox[0]<.3);
    blocks.sort((a,b) => (columns ? Math.floor(a.bbox[0]/.5)-Math.floor(b.bbox[0]/.5) : 0) || a.bbox[1]-b.bbox[1] || a.bbox[0]-b.bbox[0]);
    return { blocks, text: blocks.map(b=>b.text).join('\n'), width, height, columns: columns ? 2 : 1 };
  }
  function segmentQuestions(pages, metadata, infer = raw => ({ stem: raw })) {
    const repeated = new Map();
    pages.forEach(page => (page.blocks || []).filter(b=>b.bbox[1]<.06 || b.bbox[1]>.94).forEach(b => { const k=clean(b.text); repeated.set(k,(repeated.get(k)||0)+1); }));
    const candidates = [], answerItems = [];
    let current = null, answers = false, sectionScore = null, sectionType = '';
    const finish = () => { if (current) (current.isAnswer ? answerItems : candidates).push(current); current = null; };
    for (const page of pages) {
      const blocks = page.blocks?.length ? page.blocks : String(page.text || '').split(/\n/).map(text=>({text,bbox:null}));
      if(current&&!answers&&!blocks.some(b=>String(b.text||'').trim())){
        current.sourceSpans.push({pageNo:page.pageNo,bbox:[.03,.03,.94,.94],kind:'question',cells:[],imageOnly:true});
        current.hasImageOnlyPage=true;
      }
      for (const block of blocks) {
        if (block.bbox && (block.bbox[1]<.06 || block.bbox[1]>.94) && repeated.get(clean(block.text)) > 1) continue;
        const line = digits(block.text).trim();
        if (!line) continue;
        if (/^(?:参考答案|答案与解析|参考解析|试题解析|答案解析)/.test(line)) { finish(); answers = true; }
        if (/^[一二三四五六七八九十]+[、.]/.test(line)) {
          finish(); sectionType = /选择/.test(line)?'选择题':/实验/.test(line)?'实验探究题':/计算/.test(line)?'计算题':/填空/.test(line)?'填空题':'';
          const m=line.match(/每(?:小)?题\s*(\d+(?:\.\d+)?)\s*分/); sectionScore=m?Number(m[1]):null;
        }
        // Numbered line starts are authoritative candidates; later starts in a flattened line must follow the sequence.
        const markers = [...line.matchAll(/(?:^|\s)(?:第\s*)?([1-9]\d?)\s*[、.．]\s*(?!\d)/g)];
        const valid = markers.filter((m,i)=>i===0 || Number(m[1])===Number(markers[i-1][1])+1);
        const pieces = valid.length ? valid.map((m,i)=>({ no:String(Number(m[1])), text:line.slice(m.index+m[0].length,valid[i+1]?.index), start:m.index })) : [{text:line}];
        if (valid.length && valid[0].index>0 && current) current.chunks.push(line.slice(0,valid[0].index));
        for (const piece of pieces) {
          if (piece.no) { finish(); current={questionNo:piece.no,pageNo:page.pageNo,chunks:[],sourceSpans:[],isAnswer:answers,sectionScore,sectionType}; }
          if (!current) continue;
          current.chunks.push(piece.text);
          current.sourceSpans.push({pageNo:page.pageNo,bbox:block.bbox,kind:answers?'answer':'question',cells:block.cells||[]});
        }
      }
    }
    finish();
    return candidates.map(candidate => {
      const raw=candidate.chunks.join('\n').trim(), info=infer(raw);
      const answer=answerItems.find(a=>a.questionNo===candidate.questionNo);
      const answerRaw=answer?.chunks.join('\n')||'';
      const answerInfo=answerRaw?infer(answerRaw):{};
      const spans=[];
      for (const span of candidate.sourceSpans) {
        let group=spans.find(s=>s.pageNo===span.pageNo);
        if (!group) { group={pageNo:span.pageNo,bbox:span.bbox ? [...span.bbox] : null,kind:'question'}; spans.push(group); }
        else if (group.bbox && span.bbox) {
          const [x,y,w,h]=group.bbox, [a,b,c,d]=span.bbox;
          group.bbox=[Math.min(x,a),Math.min(y,b),Math.max(x+w,a+c)-Math.min(x,a),Math.max(y+h,b+d)-Math.min(y,b)];
        }
      }
      // Preserve the exact text bbox for evidence, and propose a separate question-region
      // crop extending to the next question. Diagrams often sit below the last OCR line.
      for(const span of spans)if(span.bbox){
        const page=pages.find(p=>p.pageNo===span.pageNo),two=page?.columns===2,col=two&&span.bbox[0]>=.5?1:0;
        const next=[...candidates,...answerItems].filter(c=>c!==candidate).flatMap(c=>c.sourceSpans.slice(0,1)).filter(s=>s.pageNo===span.pageNo&&s.bbox&&s.bbox[1]>span.bbox[1]+.01&&(!two||Number(s.bbox[0]>=.5)===col)).sort((a,b)=>a.bbox[1]-b.bbox[1])[0];
        const left=two?(col ? .51 : .025):.025,right=two?(col ? .975 : .49):.975,top=Math.max(.01,span.bbox[1]-.008),bottom=Math.max(top+.01,Math.min(.98,next?next.bbox[1]-.008:.98));
        span.cropBBox=[left,top,right-left,bottom-top];
      }
      const parts=[...raw.matchAll(/[（(](\d+)[）)]/g)].map(m=>({partId:m[1],score:null}));
      const tableRows=candidate.sourceSpans.filter(s=>s.cells.length>=3).map(s=>s.cells.map(c=>c.text));
      const specificScore=info.score != null && Number(info.score)>0 ? Number(info.score) : null;
      return {...info,questionNo:candidate.questionNo,pageNo:candidate.pageNo,raw,year:metadata.year,region:metadata.region,
        score:specificScore??candidate.sectionScore,type:info.type==='待人工确认'?candidate.sectionType||info.type:info.type,
        answer: info.answer || answerInfo.answer || (/^[A-D](?:\s|$)/.test(answerRaw)?answerRaw[0]:''),
        sourceExplanation:info.sourceExplanation||answerInfo.sourceExplanation||'',
        sourceSpans:spans,answerSpans:answer?.sourceSpans||[],parts,
        tableStructure:/表|数据/.test(raw)&&tableRows.length?{rows:tableRows,status:'needs_review'}:null,
        imageReviewRequired:!!candidate.hasImageOnlyPage||/如图|图中|电路图|图甲|图乙|下图|如表|表格/.test(raw)};
    });
  }
  function similarity(a,b) {
    if (!a || !b) return 0; if (a===b) return 1;
    const grams=s=>new Set(Array.from({length:Math.max(0,s.length-2)},(_,i)=>s.slice(i,i+3)));
    const x=grams(clean(a)), y=grams(clean(b)); if (!x.size||!y.size) return 0;
    let n=0; x.forEach(g=>{if(y.has(g))n++;}); return n/(x.size+y.size-n);
  }
  function hashSimilarity(a,b) {
    if(!a||!b||a.length!==b.length||!/^[a-f0-9]+$/i.test(a+b)) return 0;
    let n=0; for(let i=0;i<a.length;i++){let x=parseInt(a[i],16)^parseInt(b[i],16); while(x){n++;x&=x-1;}}
    return 1-n/(a.length*4);
  }
  function alignPages(a,b) {
    const pairs=[]; a.forEach((x,i)=>b.forEach((y,j)=>pairs.push({i,j,score:hashSimilarity(x.hash,y.hash)})));
    pairs.sort((x,y)=>y.score-x.score); const usedA=new Set(),usedB=new Set(),matched=[];
    for(const p of pairs) if(!usedA.has(p.i)&&!usedB.has(p.j)){usedA.add(p.i);usedB.add(p.j);matched.push(p);}
    return {score:matched.length?matched.reduce((s,p)=>s+p.score,0)/Math.max(a.length,b.length):0,pairs:matched};
  }
  function findDuplicate(engine,incoming) {
    const canonicalId = f => { let value=f.canonicalExamId;const seen=new Set();while(value&&!seen.has(value)){seen.add(value);const e=(engine.canonicalExams||[]).find(e=>e.id===value);if(!e)return null;if(!e.mergedInto)return value;value=e.mergedInto;}return null; };
    const candidates=(engine.files||[]).filter(f=>f.id!==incoming.id && canonicalId(f) && ['sourceLayer','year','region','examType'].every(k=>String(f[k])===String(incoming[k])));
    return candidates.map(f=>{
      const exact=Boolean(f.sha256&&f.sha256===incoming.sha256&&['sourceLayer','year','region','examType'].every(k=>String(f[k])===String(incoming[k]))), textSimilarity=similarity(f.normalizedText,incoming.normalizedText), images=alignPages(f.pageHashes||[],incoming.pageHashes||[]), questionSimilarity=similarity(f.questionSignature,incoming.questionSignature);
      return {canonicalExamId:canonicalId(f),duplicateGroupId:f.duplicateGroupId,score:exact?1:textSimilarity*.55+images.score*.25+questionSimilarity*.2,
        evidence:{method:exact?'sha256_exact':'metadata + normalized_text + question_signature + aligned_phash',exactSha256:exact,candidateFileId:f.id,candidateFileName:f.fileName,textSimilarity,imageSimilarity:images.score,questionSignatureSimilarity:questionSimilarity,pageAlignment:images.pairs,decision:exact?'exact_reuse':'pending_teacher'}};
    }).sort((a,b)=>b.score-a.score)[0]||null;
  }
  function registerFile(engine,file,drafts,makeQuestion) {
    if(file.canonicalExamId && engine.canonicalExams.some(e=>e.id===file.canonicalExamId)) { if(!engine.files.some(f=>f.id===file.id))engine.files.push(file);return file; }
    const duplicate=findDuplicate(engine,file);
    if(duplicate?.evidence.exactSha256) {
      Object.assign(file,{canonicalExamId:duplicate.canonicalExamId,duplicateGroupId:duplicate.duplicateGroupId,status:'duplicate',dedupeEvidence:duplicate.evidence});
      const exam=engine.canonicalExams.find(e=>e.id===file.canonicalExamId); if(exam&&!exam.fileIds.includes(file.id))exam.fileIds.push(file.id);
    } else {
      const examId=id('exam'), group=duplicate?.duplicateGroupId||id('dup');
      Object.assign(file,{canonicalExamId:examId,duplicateGroupId:group,status:duplicate?'duplicate_candidate':'canonical',dedupeEvidence:duplicate?.evidence||{method:'new_canonical',decision:'pending_teacher'}});
      engine.canonicalExams.push({id:examId,duplicateGroupId:group,sourceLayer:file.sourceLayer,year:file.year,region:file.region,examType:file.examType,
        paperOriginId:file.paperOriginId||'',paperOriginName:file.paperOriginName||'',applicableRegions:clone(file.applicableRegions||[]),fileIds:[file.id],candidateOf:duplicate?.canonicalExamId||null,dedupeStatus:duplicate?'pending':'unconfirmed',completenessConfirmed:false,complete:false,expectedQuestionCount:null,totalScore:null,reviewStatus:'needs_question_review',createdAt:now()});
      drafts.forEach((d,i)=>engine.questions.push(makeQuestion(d,file,examId,i)));
    }
    file.extractionDrafts=clone(drafts); engine.files.push(file); return file;
  }
  function resolveDuplicate(engine,fileId,decision,reviewer='local_teacher') {
    const file=engine.files.find(f=>f.id===fileId), exam=engine.canonicalExams.find(e=>e.id===file?.canonicalExamId);
    if(!file||!exam)throw new Error('找不到待审版本');
    if(!['merge','separate','undo'].includes(decision))throw new Error('无效的去重决定');
    const before={exam:clone(exam),file:clone(file)};
    if(decision==='undo') {
      const previous=[...(engine.auditEvents||[])].reverse().find(e=>e.entityId===fileId&&e.entityType==='dedupe'&&e.status!=='undo');
      if(!previous?.payload?.before)throw new Error('没有可撤销的人工决定');
      const target=engine.canonicalExams.find(e=>e.id===exam.mergedInto);
      if(target) {target.fileIds=target.fileIds.filter(x=>x!==file.id);target.versionConflicts=(target.versionConflicts||[]).filter(c=>c.fileId!==file.id);target.complete=false;target.completenessConfirmed=false;}
      Object.assign(exam,previous.payload.before.exam,{complete:false,completenessConfirmed:false,mergedInto:null});
      Object.assign(file,previous.payload.before.file);
      const ids=new Set(engine.questions.filter(q=>q.canonicalExamId===exam.id).map(q=>q.id));
      engine.questionAliases=(engine.questionAliases||[]).filter(a=>!ids.has(a.id));
    } else if(decision==='merge') {
      const target=engine.canonicalExams.find(e=>e.id===exam.candidateOf);
      if(!target||target.id===exam.id||target.mergedInto)throw new Error('请先处理主版本的去重关系');
      if(!['sourceLayer','year','region','examType'].every(k=>target[k]===exam[k]))throw new Error('不同考试身份不可合并');
      exam.mergedInto=target.id; exam.complete=false;exam.completenessConfirmed=false;exam.dedupeStatus='confirmed';
      if(!target.fileIds.includes(file.id))target.fileIds.push(file.id);
      target.complete=false;target.completenessConfirmed=false;target.dedupeStatus='confirmed';
      file.status='duplicate_confirmed';file.dedupeEvidence.decision='teacher_merge';
      engine.questionAliases||=[];
      for(const q of engine.questions.filter(q=>q.canonicalExamId===exam.id)) {
        const cropHashes = value => (value.imageAssets||[]).filter(a=>a.kind==='question-crop').map(a=>a.perceptualHash||'').sort();
        const sameImages = (a,b) => {
          const x=cropHashes(a),y=cropHashes(b);
          if(!x.length&&!y.length)return !a.imageReviewRequired&&!b.imageReviewRequired;
          return x.length===y.length&&x.every((h,i)=>h&&hashSimilarity(h,y[i])>=.94);
        };
        const rootQ=engine.questions.find(r=>r.canonicalExamId===target.id&&r.questionNo===q.questionNo&&clean(r.stem)===clean(q.stem)&&clean(r.answer)===clean(q.answer)&&JSON.stringify(r.options)===JSON.stringify(q.options)&&sameImages(r,q));
        if(rootQ&&!engine.questionAliases.some(a=>a.id===q.id))engine.questionAliases.push({id:q.id,targetId:rootQ.id,at:now(),reviewer});
        else if(!rootQ) (target.versionConflicts||=[]).push({fileId:file.id,questionId:q.id,questionNo:q.questionNo,status:'pending'});
      }
    } else {
      exam.dedupeStatus='confirmed';exam.candidateOf=null;exam.duplicateGroupId=id('dup');file.duplicateGroupId=exam.duplicateGroupId;
      file.status='canonical';file.dedupeEvidence.decision='teacher_separate';
    }
    (engine.auditEvents||=[]).push({id:id('audit'),entityType:'dedupe',entityId:fileId,status:decision,at:now(),reviewer,payload:{before}});
    return exam;
  }
  function reviewIssues(q) {
    const issues=[];
    for(const f of ['questionNo','stem','type','answer','mainPoint','physicalModel','method'])if(!String(q[f]||'').trim()||/^待人工/.test(String(q[f])))issues.push(f);
    if(!Array.isArray(q.abilities)||!q.abilities.length||q.abilities.some(a=>/^待人工/.test(a)))issues.push('abilities');
    if(/选择/.test(q.type||'')&&(!Array.isArray(q.options)||q.options.length<2))issues.push('options');
    if(!(Number(q.pageNo)>0))issues.push('pageNo');
    if(!q.sourceSpans?.length&&!q.imageAssets?.length)issues.push('sourceSpans');
    const sourcePages=[...new Set((q.sourceSpans||[]).map(s=>Number(s?.pageNo)).filter(pageNo=>Number.isInteger(pageNo)&&pageNo>0))];
    const requiresOriginalCrop=q.generated!==true&&(Boolean(q.sourceFileId)||sourcePages.length>0);
    // OCR text is only a searchable aid.  Every source-backed question must
    // retain a reviewed crop for every source page before it can be confirmed
    // or delivered, otherwise a circuit, table or continuation could vanish.
    if((q.imageReviewRequired||requiresOriginalCrop)&&!q.imageReviewed)issues.push('imageReviewed');
    if((q.imageReviewRequired||requiresOriginalCrop) && !(q.imageAssets||[]).some(a=>a.kind==='question-crop'&&a.persistent))issues.push('question-crop');
    if(q.imageReviewRequired||requiresOriginalCrop)for(const pageNo of sourcePages)if(!(q.imageAssets||[]).some(a=>a.kind==='question-crop'&&a.persistent&&Number(a.pageNo)===pageNo))issues.push(`page-${pageNo}-crop`);
    return issues;
  }
  function confirmExam(engine,examId,expected,totalScore) {
    const exam=engine.canonicalExams.find(e=>e.id===examId);
    if(!exam||exam.mergedInto)throw new Error('该考试不是独立主版本');
    const qs=engine.questions.filter(q=>q.canonicalExamId===examId&&!q.excluded);
    if(!Number.isInteger(Number(expected))||Number(expected)<=0||qs.length!==Number(expected))throw new Error('核验题数必须与原卷实际题数及当前题目一致');
    if(qs.some(q=>!q.reviewed||reviewIssues(q).length))throw new Error('请先逐题确认题干、答案、标签与图表');
    if(exam.dedupeStatus!=='confirmed')throw new Error('请先确认本卷去重身份');
    if(exam.versionConflicts?.some(c=>c.status==='pending'))throw new Error('请先逐项核验重复版本的题目差异');
    if(engine.files.filter(f=>exam.fileIds.includes(f.id)).some(f=>!f.originalAsset?.persistent))throw new Error('原卷必须先永久保存');
    const scores=qs.map(q=>q.score==null?null:Number(q.score));
    if(totalScore!==''&&totalScore!=null&&(!(Number(totalScore)>0)||scores.some(s=>s==null||s<=0)||Math.abs(scores.reduce((a,b)=>a+b,0)-Number(totalScore))>1e-6))throw new Error('物理总分与逐题分值不一致，或仍有缺失分值');
    Object.assign(exam,{expectedQuestionCount:Number(expected),totalScore:totalScore===''||totalScore==null?null:Number(totalScore),complete:true,completenessConfirmed:true,reviewStatus:'confirmed',reviewedBy:'local_teacher',reviewedAt:now()});
    return exam;
  }
  function proposeAi(q,draft,span) {
    (q.aiCandidates||=[]).push({id:id('candidate'),at:now(),draft:clone(draft),sourceSpan:clone(span),status:'pending'});
    return q.aiCandidates.at(-1);
  }
  function reviseMetadata(engine,examId,input,reviewer='local_teacher') {
    const exam=engine.canonicalExams.find(e=>e.id===examId);
    if(!exam)throw new Error('考试不存在');
    if(exam.mergedInto||engine.canonicalExams.some(e=>e.mergedInto===examId))throw new Error('请先撤销版本合并，再分别修正元数据并重新去重');
    const data=validateMetadata({...exam,...input}),keys=['sourceLayer','year','region','examType','paperOriginId','paperOriginName','applicableRegions'];
    if(keys.every(k=>JSON.stringify(exam[k]??'')===JSON.stringify(data[k]??'')))return exam;
    const before=clone(exam),fields=Object.fromEntries(keys.map(k=>[k,data[k]]));
    const files=engine.files.filter(f=>f.canonicalExamId===examId),ownIds=new Set(files.map(f=>f.id));
    Object.assign(exam,fields,{complete:false,completenessConfirmed:false,dedupeStatus:'unconfirmed',candidateOf:null,reviewedBy:'',reviewedAt:''});
    for(const f of files)Object.assign(f,fields,{metadataConfirmed:true,metadataReviewedBy:reviewer,metadataReviewedAt:now()});
    for(const q of engine.questions.filter(q=>q.canonicalExamId===examId))Object.assign(q,{sourceLayer:data.sourceLayer,year:data.year,region:data.region,examType:data.examType,reviewed:false,reviewedBy:'',reviewedAt:''});
    const match=files.length?findDuplicate({...engine,files:engine.files.filter(f=>!ownIds.has(f.id))},files[0]):null;
    if(match){exam.candidateOf=match.canonicalExamId;exam.dedupeStatus='pending';exam.duplicateGroupId=match.duplicateGroupId;}
    for(const f of files){f.status=match?'duplicate_candidate':'canonical';f.duplicateGroupId=exam.duplicateGroupId;f.dedupeEvidence=match?.evidence||{method:'metadata_revised',decision:'pending_teacher'};}
    (engine.auditEvents||=[]).push({id:id('audit'),entityId:examId,entityType:'exam_metadata',status:'revised',reviewer,at:now(),payload:{before,after:clone(exam),affectedQuestionIds:engine.questions.filter(q=>q.canonicalExamId===examId).map(q=>q.id)}});
    return exam;
  }
  return {HUNAN,validateMetadata,detectMetadata,pageBlocks,segmentQuestions,normalizeText:clean,similarity,hashSimilarity,alignPages,findDuplicate,registerFile,resolveDuplicate,reviewIssues,confirmExam,proposeAi,reviseMetadata};
});
