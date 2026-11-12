import { normalizeChatGender } from './chat-gender.js';
// Optional persisted chat expression and explicit gender. No relationships, state or authority.
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const lines=(value,cap,maxChars)=>{
  if(!Array.isArray(value))return undefined;
  const selected=value.filter(line=>typeof line==='string'&&line.trim()&&line.length<=maxChars).slice(0,cap);
  return value.length===0||selected.length?selected:undefined;
};
const groups=(value,cap)=>{
  if(!Array.isArray(value))return undefined;
  const selected=[];let chars=0;
  for(const group of value){
    if(selected.length>=cap)break;
    if(!record(group)||!Array.isArray(group.turns)||group.turns.length<2||group.turns.length>6)continue;
    if(!group.turns.every(turn=>record(turn)&&typeof turn.speaker==='string'&&turn.speaker.trim()
      &&turn.speaker.length<=40&&!/[\r\n\x00-\x1f]/u.test(turn.speaker)
      &&typeof turn.text==='string'&&turn.text.trim()&&turn.text.length<=400))continue;
    if(!group.turns.some(turn=>turn.speaker==='self')||!group.turns.some(turn=>turn.speaker!=='self'))continue;
    const turns=group.turns.map(({speaker,text})=>({speaker,text}));
    const size=turns.reduce((total,turn)=>total+turn.speaker.length+turn.text.length,0);
    if(chars+size>2000)continue;
    chars+=size;selected.push({turns});
  }
  return value.length===0||selected.length?selected:undefined;
};

const sourceProfile=value=>{
  if(!record(value)||typeof value.text!=='string'||!value.text.trim()||value.text.length>24000
    ||typeof value.identity!=='string'||!value.identity.trim()||value.identity.length>4000
    ||!Array.isArray(value.voice)||value.voice.length>8
    ||!value.voice.every(line=>typeof line==='string'&&line.trim()&&line.length<=400))return undefined;
  return {text:value.text,identity:value.identity,voice:[...value.voice],enabled:value.enabled===true};
};

/** Exact snapshots prevent old source material from following a manual edit. Not semantic approval. */
export function isChatSourceActive(profile,identity,voice){
  const source=sourceProfile(profile?.source);
  return !!source&&source.enabled===true&&source.identity===identity&&Array.isArray(voice)
    &&Array.isArray(source.voice)&&source.voice.length===voice.length&&source.voice.every((line,index)=>line===voice[index]);
}

/** Missing or malformed fields inherit the legacy card; explicit [] disables a field. */
export function normalizeChatProfile(value){
  if(!record(value))return undefined;
  const result={};
  for(const [key,normalize] of [['voice',v=>lines(v,8,400)],['samples',v=>lines(v,8,800)],
    ['dialogueExamples',v=>groups(v,3)],['workDialogueExamples',v=>groups(v,2)],
    ['gender',v=>normalizeChatGender(v)??undefined],['source',sourceProfile]]){
    const selected=normalize(value[key]);if(selected!==undefined)result[key]=selected;
  }
  return Object.keys(result).length?result:undefined;
}
