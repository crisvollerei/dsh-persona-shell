import {quoteRef,quoteKey} from './chat-quote.js';

/** A short model proposal, never evidence, user feedback or a saved scene fact. */
export function normalizeSceneDirection(value){
  return typeof value==='string'&&value.length<=240&&value.trim()
    &&!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)?value.trim():null;
}

/** Bind only the current selected actor and a real, included public reply target. */
export function projectSceneDirection(value,{roomId,generation=0,scopeKey=null,messageId,actorId,timeline}={}){
  const text=normalizeSceneDirection(value?.text),ref=quoteRef(value?.sourceRef),target=timeline?.replyTarget;
  if(!text||!ref||!target||typeof messageId!=='string'||!messageId||typeof actorId!=='string'||!actorId
    ||value.roomId!==roomId||value.generation!==generation||value.scopeKey!==scopeKey
    ||value.messageId!==messageId||value.actorId!==actorId||ref.roomId!==roomId||ref.generation!==generation)return;
  const event=timeline.timeline?.find(event=>event.eventId===target.eventId),bubble=event?.bubbles.find(bubble=>bubble.index===target.index);
  if(!event||!bubble)return;
  const actual=bubble.ref??{roomId,generation,kind:'assistant',turnId:event.turnId,attemptId:event.attemptId,index:bubble.index};
  if(quoteKey(ref)!==quoteKey(actual))return;
  return {text,source:{eventId:event.eventId,index:bubble.index}};
}
