import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizePack } from './pack.js';
import { normalizeAvatar } from './avatar.js';
import { createStructuredMemory, MEMORY_LIMITS } from './structured-memory.js';
import { isMemoryRoom, matchesChatEvidence, memoryChannel } from './chat-memory.js';

const format = 'dsh-persona-shell-backup';
const plain = (s,max) => typeof s==='string' && s.trim().length>0 && s.length<=max;
const invalid = () => {throw Error('invalid-backup');};
const portableFields = ['id','scope','personaId','sessionId','kind','key','content','status','origin','chatOnly','evidence','tags','pinned','version','createdAt','updatedAt','expiresAt','occurredAt'];
const portableEntry = e => Object.fromEntries(portableFields.filter(k=>e[k]!==undefined).map(k=>[k,structuredClone(e[k])]));

function portableCard(preset) {
  const pack=normalizePack(preset.pack);
  return {schemaVersion:1,name:preset.name,pack,...(!preset.builtin && preset.avatar?.startsWith('data:image/png;')?{avatar:preset.avatar}:{})};
}

export function exportAssets({presets,entries,rooms}, {type='both',history=false,id,plugin}) {
  if (id) {const p=presets.find(p=>p.id===id);if(!p)throw Error('persona-not-found');return portableCard(p);}
  if (!['both','memory','personas'].includes(type)) invalid();
  const selected=type==='personas'?[]:entries.filter(e=>history || (e.status==='active' && (e.expiresAt===null || e.expiresAt>Date.now())));
  const roomIds=new Set(selected.flatMap(e=>[e.sessionId,...e.evidence.map(ref=>ref.sessionId)]));
  return {format,version:1,exportedAt:new Date().toISOString(),plugin,
    personas:type==='memory'?[]:presets.filter(p=>!p.builtin).map(p=>({id:p.id,...portableCard(p)})),
    memory:{entries:selected.map(portableEntry)}, rooms:rooms.filter(r=>roomIds.has(r.id)).map(({id,name})=>({id,name}))};
}

function checkedCard(raw) {
  if (!raw || (raw.schemaVersion??1)!==1 || !plain(raw.name,40) || !raw.pack || !plain(raw.pack.identity,24000)
    || JSON.stringify(raw.pack).length>65536 || raw.avatar!=null && !raw.avatar?.startsWith?.('data:image/png;')) invalid();
  for(const key of ['report','voice','samples','avoid']) if(raw.pack[key]!==undefined && (!Array.isArray(raw.pack[key])
    || raw.pack[key].length>(key==='samples'?8:key==='avoid'?12:10) || raw.pack[key].some(s=>!plain(s,24000))))invalid();
  const narration=raw.pack.narration;
  if(narration!==undefined && (!narration || !['voice','relay'].includes(narration.mode) || !plain(narration.assistant,20)
    || narration.selfReference!==undefined && !['none','natural'].includes(narration.selfReference)
    || narration.selfAliases!==undefined && (!Array.isArray(narration.selfAliases) || narration.selfAliases.length>3 || narration.selfAliases.some(s=>typeof s!=='string'||!s.trim()||[...s].length>8))))invalid();
  if(raw.pack.address!==undefined && (!plain(raw.pack.address?.user,24000)||!plain(raw.pack.address?.subagent,24000)))invalid();
  const pack=normalizePack(raw.pack);
  if(raw.pack.chat!==undefined && !isDeepStrictEqual(raw.pack.chat,pack.chat))invalid();
  return {name:raw.name.trim(),pack,avatar:normalizeAvatar(raw.avatar),builtin:false,source:''};
}

function checkedEntry(raw) {
  if (!raw || !['manual','explicit','model','chat','legacy','correction'].includes(raw.origin)
    || !Array.isArray(raw.tags) || raw.tags.length>6 || raw.tags.some(t=>!plain(t,32))
    || !Array.isArray(raw.evidence) || raw.evidence.length>4 || typeof raw.pinned!=='boolean'
    || ![raw.createdAt,raw.updatedAt,...(raw.occurredAt!=null?[raw.occurredAt]:[]),...(raw.expiresAt!=null?[raw.expiresAt]:[])]
      .every(t=>Number.isSafeInteger(t) && t>=0 && t<=253402300799999)) invalid();
  const e=portableEntry(raw);
  if(e.chatOnly!==undefined && typeof e.chatOnly!=='boolean')invalid();
  const chat=e.origin==='chat' || e.evidence.some(ref=>ref?.source==='message' && isMemoryRoom(ref.sessionId));
  if(chat){if(!['agreement','episode','context'].includes(e.kind) || e.scope==='shared')invalid();e.origin='chat';}
  if(chat && !matchesChatEvidence(e,e.evidence))invalid();
  // Imported grants are reviewed locally. Normalize an explicitly authorized shared record
  // for schema validation only; the import below always resets its grant.
  const check=createStructuredMemory();check.restore({version:1,entries:[{...e,origin:chat?'chat':'manual'}]});
  const saved=check.snapshot().entries[0];
  if(!saved || !isDeepStrictEqual(saved.evidence,e.evidence) || saved.scope!==e.scope || saved.personaId!==e.personaId || saved.sessionId!==e.sessionId)invalid();
  return e;
}

export function planAssetImport(file,{presets,entries,rooms,limit},fallbackPersona) {
  const single=file?.schemaVersion===1 && !file.format && file.pack;
  const input=single?{personas:[{...file,id:'single'}],memory:{entries:[]},rooms:[]}:file;
  if(!input || !single && (input.format!==format || input.version!==1) || !Array.isArray(input.personas) || input.personas.length>26
    || !Array.isArray(input.memory?.entries) || input.memory.entries.length>MEMORY_LIMITS.entries || !Array.isArray(input.rooms) || input.rooms.length>200)invalid();
  const allCards=input.personas.map(checkedCard), allEntries=input.memory.entries.map(checkedEntry);
  if(input.rooms.some(r=>!plain(r?.id,160)||!isMemoryRoom(r.id)||!plain(r.name,120))
    || input.personas.some(p=>!plain(p.id,160)) || new Set(input.personas.map(p=>p.id)).size!==allCards.length
    || new Set(allEntries.map(e=>e.id)).size!==allEntries.length)invalid();
  const occupied=new Set(presets.map(p=>p.name)), mapping=new Map(presets.map(p=>[p.id,p.id]));
  const cards=[], additions=[], missingRooms=new Set();
  const summary={personas:[],entries:0,duplicates:0,missingPersona:0,missingRoom:0,capacity:0,rooms:[]};
  for(const [i,card] of allCards.entries()){
    const old=input.personas[i].id;
    if(presets.some(p=>p.builtin && p.id===old))invalid();
    if(presets.length+cards.length>=limit){mapping.delete(old);summary.capacity++;continue;}
    const base=card.name.slice(0,30);let name=card.name;
    for(let n=1;occupied.has(name);n++)name=base+(n===1?'（导入）':`（导入 ${n}）`);
    occupied.add(name);const id='preset-'+randomUUID();mapping.set(old,id);
    cards.push({...card,id,name,at:Date.now()});summary.personas.push(name);
  }
  if(fallbackPersona && !presets.some(p=>p.id===fallbackPersona))invalid();
  const fingerprint=e=>JSON.stringify([e.kind,e.scope,e.personaId,e.sessionId,e.content,memoryChannel(e),e.status,e.expiresAt]);
  const seen=new Set(entries.map(fingerprint));
  for(const e of allEntries){
    if(e.personaId && !mapping.has(e.personaId)){summary.missingPersona++;continue;}
    e.personaId=mapping.get(e.personaId)??null;
    if(e.scope==='session' && isMemoryRoom(e.sessionId) && !rooms.some(r=>r.id===e.sessionId)){
      missingRooms.add(input.rooms.find(r=>r.id===e.sessionId)?.name??e.sessionId);
      if(!fallbackPersona || e.personaId && e.personaId!==fallbackPersona){summary.missingRoom++;continue;}
      if(e.origin!=='chat')e.chatOnly=true;
      e.scope='persona';e.personaId=fallbackPersona;e.sessionId=null;
    }
    const original=fingerprint(e);
    if(e.status==='active')e.status='candidate';
    if(seen.has(original)||seen.has(fingerprint(e))){summary.duplicates++;continue;}
    if(entries.length+additions.length>=MEMORY_LIMITS.entries){summary.capacity++;continue;}
    seen.add(original);seen.add(fingerprint(e));e.id=randomUUID();e.version=1;
    for(const ref of e.evidence) if(ref.personaId && mapping.has(ref.personaId))ref.personaId=mapping.get(ref.personaId);
    if(e.scope==='shared' && e.status==='candidate')e.importedForReview=true;
    additions.push({...e,ownerId:'owner'});
  }
  summary.entries=additions.length;summary.rooms=[...missingRooms];
  const token=createHash('sha256').update(JSON.stringify([file,fallbackPersona??null,summary,entries.map(e=>[e.id,e.version]),presets.map(p=>[p.id,p.name]),rooms.map(r=>r.id)])).digest('hex');
  return {cards,additions,summary,token};
}
