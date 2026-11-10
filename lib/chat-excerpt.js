import {createHash} from 'node:crypto';

export const WORK_EXCERPT_LIMITS=Object.freeze({chars:5000,spans:32,inputChars:200000});
const marker='\n\n[…原文省略…]\n\n';
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const digest=value=>createHash('sha256').update(value,'utf16le').digest('hex');
const reasons=new Set(['budget','oversize-block','unclosed-fence','source-too-large']);
const caution=/(?:风险|限制|条件|尚未|未(?:完|验|测|发|获|执|解决)|不(?:支持|能|可|会|应|得|代表|保证|等于)|仅|除非|如果|但是|必须|待(?:确认|验证|批准)|失败|中断|撤销|回滚|\b(?:risk|limit|unless|not|only|must|failed|pending|unverified|warning|unknown)\b)/iu;
const isList=line=>/^\s*(?:[-+*]|\d+[.)])\s+\S/u.test(line);
const heading=value=>value.trim().split(/\r?\n/u).every(line=>!line.trim()||/^ {0,3}#{1,6}(?:\s|$)/u.test(line));

/** Exact UTF-16 ranges. Fenced code, tables and loose lists are never sliced. */
function blocks(value){
  const lines=[...value.matchAll(/[^\n]*(?:\n|$)/gu)].filter(match=>match[0].length),result=[];
  const nextContent=new Array(lines.length);let following='';
  for(let index=lines.length-1;index>=0;index--){nextContent[index]=following;if(lines[index][0].trim())following=lines[index][0];}
  let start=0,hasContent=false,list=false,indented=false,fence=null;
  for(let index=0;index<lines.length;index++){
    const line=lines[index][0],trimmed=line.replace(/\r?\n$/u,''),end=lines[index].index+line.length;
    if(fence){
      const close=/^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(trimmed);
      if(close&&close[1][0]===fence.char&&close[1].length>=fence.length)fence=null;
    }else{
      const open=/^ {0,3}(`{3,}|~{3,})/u.exec(trimmed);
      if(open)fence={char:open[1][0],length:open[1].length};
    }
    if(trimmed.trim()){if(!hasContent)indented=/^(?: {4}|\t)\S?/u.test(trimmed);hasContent=true;list||=isList(trimmed);}
    if(!trimmed.trim()&&!fence&&hasContent){
      const next=nextContent[index];
      if(list&&(isList(next)||/^ {2,}\S/u.test(next))||indented&&/^(?: {4}|\t)\S?/u.test(next))continue;
      result.push({start,end,complete:true});start=end;hasContent=false;list=false;indented=false;
    }
  }
  if(start<value.length){
    if(hasContent)result.push({start,end:value.length,complete:!fence});
    else if(result.length)result.at(-1).end=value.length;
  }
  const merged=[];
  for(const block of result){
    const headingOnly=heading(value.slice(block.start,block.end));
    if(merged.at(-1)?.headingOnly)Object.assign(merged.at(-1),{end:block.end,complete:block.complete,headingOnly});
    else merged.push({...block,headingOnly});
  }
  return merged;
}

function ranges(selected){
  const result=[];
  for(const span of selected.slice().sort((a,b)=>a.start-b.start)){
    const last=result.at(-1);
    if(last&&last.end===span.start)last.end=span.end;
    else result.push({start:span.start,end:span.end});
  }
  return result;
}
function render(value,spans){
  if(!spans.length)return'';
  let text='',end=0;
  for(const span of spans){if(span.start>end)text+=marker;text+=value.slice(span.start,span.end);end=span.end;}
  if(end<value.length)text+=marker;
  return text;
}
function spread(values){
  const result=[],queue=values.length?[[0,values.length-1]]:[];
  for(let index=0;index<queue.length;index++){
    const [left,right]=queue[index],middle=Math.floor((left+right)/2);result.push(values[middle]);
    if(left<middle)queue.push([left,middle-1]);if(middle<right)queue.push([middle+1,right]);
  }
  return result;
}
function omissions(value,spans,units,budget){
  const result=[];let start=0;
  for(const end of [...spans.map(span=>span.start),value.length]){
    if(end>start){const skipped=units.filter(unit=>unit.start<end&&unit.end>start);
      result.push({start,end,reason:skipped.some(unit=>!unit.complete)?'unclosed-fence':skipped.some(unit=>unit.end-unit.start>budget)?'oversize-block':'budget'});}
    const selected=spans.find(span=>span.start===end);if(selected)start=selected.end;
  }
  return result;
}

/** Select bounded verbatim blocks. Caution cues are a heuristic, never completeness proof. */
export function selectWorkExcerpt(value,limit=WORK_EXCERPT_LIMITS.chars){
  const original=typeof value==='string'?value:'',budget=integer(limit)?Math.min(limit,WORK_EXCERPT_LIMITS.chars):0;
  if(original.length<=budget)return{text:original,omitted:false};
  if(original.length>WORK_EXCERPT_LIMITS.inputChars)return{text:'',omitted:true,excerpt:{version:1,strategy:'whole-blocks',coverage:'partial-unknown',
    originalChars:original.length,includedChars:0,digest:null,spans:[],omitted:[{start:0,end:original.length,reason:'source-too-large'}]}};
  const units=blocks(original),selected=[],used=new Set(),cautious=[];
  for(let index=0;index<units.length;index++)if(caution.test(original.slice(units[index].start,units[index].end)))cautious.push(index);
  const add=index=>{
    const unit=units[index];if(!unit||!unit.complete||used.has(index)||unit.end-unit.start>budget||selected.length>=WORK_EXCERPT_LIMITS.spans)return;
    if(render(original,ranges([...selected,unit])).length>budget)return;
    selected.push(unit);used.add(index);
  };
  for(const index of spread(cautious))add(index);
  for(const index of [...used]){add(index-1);add(index+1);}
  for(const index of spread(units.map((_,index)=>index)))add(index);
  const spans=ranges(selected),text=render(original,spans);
  return{text,omitted:true,excerpt:{version:1,strategy:'whole-blocks',coverage:'partial-unknown',originalChars:original.length,
    includedChars:spans.reduce((sum,span)=>sum+span.end-span.start,0),digest:digest(original),spans,omitted:omissions(original,spans,units,budget)}};
}

/** Bounded pointer-only whitelist, suitable for persisted reference-use records. */
export function normalizeWorkExcerpt(value){
  if(!object(value)||Object.keys(value).some(key=>!['version','strategy','coverage','originalChars','includedChars','digest','spans','omitted'].includes(key))
    ||value.version!==1||value.strategy!=='whole-blocks'||value.coverage!=='partial-unknown'
    ||!integer(value.originalChars)||!value.originalChars||!integer(value.includedChars)||value.includedChars>WORK_EXCERPT_LIMITS.chars
    ||!Array.isArray(value.spans)||value.spans.length>WORK_EXCERPT_LIMITS.spans||!Array.isArray(value.omitted)
    ||!value.omitted.length||value.omitted.length>WORK_EXCERPT_LIMITS.spans+1)return null;
  const validSpan=(span,allowed)=>object(span)&&Object.keys(span).every(key=>allowed.includes(key))
    &&integer(span.start)&&integer(span.end)&&span.start<span.end&&span.end<=value.originalChars;
  const spans=[];let end=-1,chars=0;
  for(const span of value.spans){if(!validSpan(span,['start','end'])||span.start<=end)return null;spans.push({start:span.start,end:span.end});end=span.end;chars+=span.end-span.start;}
  if(chars!==value.includedChars)return null;
  const omitted=[];end=-1;
  for(const span of value.omitted){if(!validSpan(span,['start','end','reason'])||span.start<end||!reasons.has(span.reason))return null;
    omitted.push({start:span.start,end:span.end,reason:span.reason});end=span.end;}
  const all=[...spans,...omitted].sort((a,b)=>a.start-b.start);end=0;
  for(const span of all){if(span.start!==end)return null;end=span.end;}if(end!==value.originalChars)return null;
  if(value.digest===null){if(value.originalChars<=WORK_EXCERPT_LIMITS.inputChars||spans.length||omitted.length!==1||omitted[0].reason!=='source-too-large')return null;}
  else if(typeof value.digest!=='string'||!/^[a-f0-9]{64}$/u.test(value.digest)||value.originalChars>WORK_EXCERPT_LIMITS.inputChars
    ||omitted.some(span=>span.reason==='source-too-large'))return null;
  return{version:1,strategy:'whole-blocks',coverage:'partial-unknown',originalChars:value.originalChars,includedChars:chars,digest:value.digest,spans,omitted};
}

/** Reconstruct exactly a past selection against the same raw report, never a new excerpt. */
export function restoreWorkExcerpt(value,metadata){
  const excerpt=normalizeWorkExcerpt(metadata);if(typeof value!=='string'||!excerpt||value.length!==excerpt.originalChars)return null;
  if(excerpt.digest===null)return null;
  if(digest(value)!==excerpt.digest)return null;
  const units=blocks(value);
  for(const span of excerpt.spans){const first=units.findIndex(unit=>unit.start===span.start),last=units.findIndex(unit=>unit.end===span.end);
    if(first<0||last<first||units.slice(first,last+1).some(unit=>!unit.complete))return null;}
  const text=render(value,excerpt.spans);if(text.length>WORK_EXCERPT_LIMITS.chars)return null;
  return{text,excerpt};
}
