import { randomUUID } from 'node:crypto';
import { quoteRef } from './chat-quote.js';
import { normalizeWorkExcerpt } from './chat-excerpt.js';

const id=value=>typeof value==='string'&&value.length>0&&value.length<=200;
const seq=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const label=(value,max=160)=>typeof value==='string'?value.slice(0,max):'';
const outcomes=new Set(['pending','generated','silent','failed','rejected','cancelled','interrupted']);
const coordination=value=>value&&['required','not-needed','unclear'].includes(value.work)
  &&['answer','advice','listen','open','unclear'].includes(value.request)
  &&['model','omitted','no-sources','invalid','timeout','unavailable','explicit'].includes(value.basis)
  ?{work:value.work,request:value.request,basis:value.basis,selectedSourceIds:[...new Set((Array.isArray(value.selectedSourceIds)?value.selectedSourceIds:[]).filter(id))].slice(0,6)}:null;
const memoryRefs=values=>(Array.isArray(values)?values:[]).filter(r=>id(r?.id)&&Number.isSafeInteger(r.version)&&r.version>0).slice(0,5).map(({id,version})=>({id,version}));
const workRefs=values=>(Array.isArray(values)?values:[]).filter(s=>id(s?.sessionId)).slice(0,6).map(s=>({
  sessionId:s.sessionId,name:label(s.name),cursor:seq(s.cursor),turn:seq(s.turn),goalSeq:seq(s.goalSeq),reportSeq:seq(s.reportSeq),
  reportStatus:['none','progress','final'].includes(s.reportStatus)?s.reportStatus:'none',readAt:seq(s.readAt),
  goalOmitted:s.goalOmitted===true,reportOmitted:s.reportOmitted===true,previousReportOmitted:s.previousReportOmitted===true,goalHasAttachments:s.goalHasAttachments===true,
  ...(normalizeWorkExcerpt(s.reportExcerpt)?{reportExcerpt:normalizeWorkExcerpt(s.reportExcerpt)}:{}),
  ...(s.previousReport?{previousReport:{turn:seq(s.previousReport.turn),seq:seq(s.previousReport.seq),
    ...(normalizeWorkExcerpt(s.previousReport.excerpt)?{excerpt:normalizeWorkExcerpt(s.previousReport.excerpt)}:{})}}:{}),
}));

/** Bounded evidence pointers only. Original text and persona preferences are resolved at read time. */
export function createChatReferenceUsage({now=Date.now,changed=()=>{}}={}) {
  let records=[];
  const valid=value=>value&&id(value.id)&&id(value.roomId)&&id(value.personaId)&&id(value.messageId)&&id(value.attemptId)
    &&(value.scopeKey===null||id(value.scopeKey))&&Number.isSafeInteger(value.at)&&value.at>=0;
  const refs=values=>(Array.isArray(values)?values:[]).map(quoteRef).filter(Boolean).slice(0,4);
  const normalize=value=>({id:value.id,roomId:value.roomId,personaId:value.personaId,messageId:value.messageId,attemptId:value.attemptId,
    scopeKey:value.scopeKey,at:value.at,sentAt:seq(value.sentAt),outcome:outcomes.has(value.outcome)?value.outcome:'interrupted',
    work:workRefs(value.work),omitted:(Array.isArray(value.omitted)?value.omitted:[]).slice(0,6).map(s=>({name:label(s?.name),reason:label(s?.reason,60)})),
    notes:refs(value.notes).filter(r=>r.roomId===value.roomId),quote:quoteRef(value.quote)?.roomId===value.roomId?quoteRef(value.quote):null,
    memory:memoryRefs(value.memory),memoryEnabled:value.memoryEnabled===true,historyCount:Math.min(8,seq(value.historyCount)??0),
    discussion:(Array.isArray(value.discussion)?value.discussion:[]).filter(r=>id(r?.id)&&Number.isSafeInteger(r.version)&&r.version>0).slice(0,8).map(({id,version})=>({id,version})),
    coordination:coordination(value.coordination),
    assignment:['respond','complement','contribute','answer-peer'].includes(value.assignment?.kind)?{
      kind:value.assignment.kind,...(Number.isInteger(value.assignment.order)&&value.assignment.order>=1&&value.assignment.order<=8?{order:value.assignment.order}:{}),
      primaryCount:Number.isInteger(value.assignment.primaryCount)&&value.assignment.primaryCount>=0&&value.assignment.primaryCount<=8?value.assignment.primaryCount:1}:null});
  return {
    begin(input){
      const value={...input,id:randomUUID(),at:now(),sentAt:null,outcome:'pending'};if(!valid(value))return;
      const record=normalize(value);records.push(record);records=records.slice(-24);changed();
      return {sent(){if(records.includes(record)&&record.sentAt===null){record.sentAt=Math.max(record.at,now());changed();}},
        finish(outcome){if(records.includes(record)&&record.outcome==='pending'&&outcomes.has(outcome)){record.outcome=outcome;changed();}}};
    },
    read:roomId=>structuredClone(records.filter(r=>r.roomId===roomId).slice().reverse()),
    snapshot:()=>({version:1,records:structuredClone(records)}),
    restore(raw){records=[];if(raw?.version!==1||!Array.isArray(raw.records))return;
      for(const value of raw.records.slice(-24)){if(!valid(value)||!outcomes.has(value.outcome)||records.some(r=>r.id===value.id)
          ||(value.sentAt!==null&&(seq(value.sentAt)===null||value.sentAt<value.at))||(['generated','silent'].includes(value.outcome)&&value.sentAt===null))continue;
        const record=normalize(value);if(record.outcome==='pending')record.outcome='interrupted';records.push(record);}},
    clear(roomId){records=records.filter(r=>r.roomId!==roomId);changed();},
  };
}
