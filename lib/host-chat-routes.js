import { readRequestBody } from './http-body.js';
import { reasoningOptions } from './expression-llm.js';
import { CHAT_LIMITS } from './persona-chat.js';
import { CHAT_IMAGE_LIMITS, decodeChatImages, normalizeChatImages, sameChatImages, imageInputStatus } from './chat-images.js';
import { buildReplySuggestions, parseReplySuggestions } from './reply-suggestions.js';
import { avatarContent } from './avatar.js';
import { quoteKey, resolveChatQuote } from './chat-quote.js';
import { chatMemorySource } from './chat-memory.js';

const isObjectBody = body => body !== null && typeof body === 'object' && !Array.isArray(body);

export function createHostChatRoutes({
  saveMemoryMutation, discoverChatMemory, roomMemoryCount,
  activeChats, activeModelMetadata, activePresetId, activeSuggestions, activeWorkDrafts,
  armChatInput, cancelledWorkDrafts, capturedRoomContext, cfg, chatContext, chatContextState,
  chatDirectorClocks, chatDirectorFailures, chatInputBindings, getChatInputRestore, chatInputs,
  chatJobKey, chatJobsFor, chatLive, chatProfile, getChatRecordsLoaded, chatReferenceUsage,
  chatRounds, chats, chatScheduler, chatStarting, chatState, chatStreamControllers, chatSupport,
  contextForRoom, ctx, currentSessionHint, ensureChatLocalStateKey, ensureChatProfile,
  ensureChatRecords, expressionLlm, generateWorkDraft, getLlm, instanceId, launchChatRound,
  modelRoutes, personaFor, preparedWorkDraft, getPresets, publicChatProfile, resolveChatRouteAsync,
  retireChatInputRuntime, retireInvalidWorkDrafts, retireOldRoomReferences, roomContexts,
  roomPublicChoices, roomReferenceState, roomScopeKey, ROUTE, sendJson, settings,
  getSettingsRestored, getStore, getStoreClosing, streamWithSignal, supportScope, trackModelTask,
  waitWithSignal,
}) {
  function retireRoomRuntime(id, reason) {
    retireChatInputRuntime(id);
    chatDirectorFailures.delete(id);
    chatScheduler.clearRoom(id);
    retireInvalidWorkDrafts(id,true);
    chatReferenceUsage.clear(id);
    chatSupport.cancelRoom(id,reason);
    chatRounds.get(id)?.abort.abort(Error('chat-cleared'));
    for (const job of chatJobsFor(id)) job.abort.abort(Error('chat-cleared'));
    activeSuggestions.get(id)?.abort.abort(Error('chat-cleared'));
    chatLive.clearRoom(id);
  }

  return async function handleChatRoutes(req, res, url, path) {
    if (path === ROUTE + '/chat/memory' && req.method === 'POST') {
      if (!getSettingsRestored() || !getStore() || getStoreClosing()) { sendJson(res,503,{error:'storage-not-ready'}); return; }
      try {
        const raw = await readRequestBody(req, 8192);
        if (raw === undefined) throw Error('invalid-memory-entry');
        const body=JSON.parse(raw);
        if (!isObjectBody(body)) throw Error('invalid-memory-entry');
        ensureChatRecords();
        if(body.action==='discover'){sendJson(res,200,await trackModelTask(discoverChatMemory(body)));return;}
        const entry=await chats.withRoom(body?.room, room=>saveMemoryMutation({action:'remember'}, {requireEnabled:true,
          applyChange: staged=>{
            if (body.scope === 'persona' && !getPresets().some(p => p.id === body.personaId)) throw Error('chat-memory-member');
            return staged.rememberChat(chatMemorySource(room, roomScopeKey(room), body));
          }}));
        sendJson(res,200,{entry});
      } catch (error) {
        const known=/^(chat-memory-|memory-|invalid-memory-)/.test(error.message);
        sendJson(res,known||error instanceof SyntaxError?400:503,{error:known?error.message:error instanceof SyntaxError?'invalid-memory-entry':'memory-save-failed',...(error.capacity?{capacity:{cleanable:error.capacity.cleanable,groups:error.capacity.similar.length}}:{})});
      }
      return;
    }
    if(path===ROUTE+'/chat/live'&&req.method==='GET'){
      const personaId=url.searchParams.get('persona'),attemptId=url.searchParams.get('attempt');
      const multiplex=url.searchParams.get('batch')==='1',requestedRoom=url.searchParams.get('room');
      if(multiplex?!requestedRoom||requestedRoom.length>160:!personaId||personaId.length>160||!attemptId||attemptId.length>160){sendJson(res,400,{error:'invalid-chat-stream'});return;}
      if(typeof res.write!=='function'){sendJson(res,503,{error:'chat-stream-unavailable'});return;}
      if(multiplex)ensureChatRecords();
      const abort=new AbortController(),closed=()=>abort.abort();res.once?.('close',closed);req.once?.('aborted',closed);
      chatStreamControllers.add(abort);
      try{
        res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'private, no-cache, no-transform','x-accel-buffering':'no'});res.flushHeaders?.();
        const roomId=requestedRoom??chats.read(personaId)?.id??personaId;
        for await(const frame of chatLive.observe(multiplex?roomId:chatJobKey(roomId,attemptId),abort.signal)){
          if(abort.signal.aborted||res.destroyed)break;
          const durable=multiplex&&!frame?chats.liveGroup(roomId,undefined,{withStatus:true}):null;
          const value=multiplex?frame??{instanceId,roomId,status:durable?.length&&durable.every(t=>t.status!=='pending')?'settled':'closed',frames:[]}
            :frame?.attemptId===attemptId&&frame.personaId===personaId?frame:{instanceId,personaId,roomId,attemptId,status:'closed',messages:[]};
          if(!res.write('data:'+JSON.stringify(value)+'\n\n')){
            let drain;try{await waitWithSignal(new Promise(resolve=>{drain=resolve;res.once('drain',drain);}),abort.signal);}finally{res.off?.('drain',drain);}
          }
          if(!['streaming','queued'].includes(value.status))break;
        }
      }catch{/* Disconnected clients continue with the canonical snapshot on reopening. */}
      finally{abort.abort();chatStreamControllers.delete(abort);res.off?.('close',closed);req.off?.('aborted',closed);if(!res.writableEnded&&!res.destroyed)res.end();}
      return;
    }

    if(path===ROUTE+'/chat-references'&&(req.method==='GET'||req.method==='POST')){
      if(!getSettingsRestored()||!getStore()||getStoreClosing()){sendJson(res,503,{error:'storage-not-ready'});return;}
      try{
        if(req.method==='GET'){sendJson(res,200,roomReferenceState(url.searchParams.get('room')||undefined));return;}
        const raw = await readRequestBody(req, 4096);
        if (raw === undefined) throw Error('invalid-chat-reference');
        const body=JSON.parse(raw);
        if (!isObjectBody(body)) throw Error('invalid-chat-reference');
        if(!getChatRecordsLoaded())throw Error('context-not-open');
        const changed=await chats.referencePolicy({...body,scopeKey:roomScopeKey(chats.read(body?.roomId))});
        if(changed)retireOldRoomReferences(body.roomId);
        sendJson(res,200,roomReferenceState(body.roomId));
      }catch(error){const known=/^(chat-|invalid-chat-|context-)/.test(error?.message??'');
        sendJson(res,error.message==='chat-room-not-found'?404:/conflict/.test(error.message)?409:error instanceof SyntaxError||known?400:503,
          {error:error instanceof SyntaxError?'invalid-chat-reference':known?error.message:'chat-reference-unavailable'});}
      return;
    }

    if(path===ROUTE+'/chat-discussion'&&req.method==='POST'){
      if(!getSettingsRestored()||!getStore()||getStoreClosing()){sendJson(res,503,{error:'storage-not-ready'});return;}
      try{
        if(!getChatRecordsLoaded())throw Error('context-not-open');
        const raw = await readRequestBody(req, 8192);
        if (raw === undefined) throw Error('invalid-chat-discussion');
        const body=JSON.parse(raw);
        if(!body||typeof body!=='object'||Array.isArray(body))throw Error('invalid-chat-discussion');
        await chats.discussionChange(body,roomScopeKey);
        retireOldRoomReferences(body.roomId);
        sendJson(res,200,roomReferenceState(body.roomId));
      }catch(error){const known=/^(chat-|invalid-chat-|context-)/.test(error?.message??'');
        sendJson(res,error.message==='chat-room-not-found'?404:/conflict/.test(error.message)?409:error instanceof SyntaxError||known?400:503,
          {error:error instanceof SyntaxError?'invalid-chat-discussion':known?error.message:'chat-discussion-save-failed'});}
      return;
    }

    if (path === ROUTE + '/chat-context' && (req.method === 'POST' || req.method === 'GET')) {
      if (!getSettingsRestored() || !getStore() || getStoreClosing()) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      let body, source=chatContext, roomId;
      try {
        if (req.method === 'GET') {
          roomId=url.searchParams.get('room')||undefined;source=contextForRoom(roomId);
          if (!source?.snapshot().initialized) throw Error('context-not-open');
          if (source.presence(url.searchParams.get('viewer'), true, Number(url.searchParams.get('sequence')))) await source.refresh();
          sendJson(res, 200, chatContextState(source,roomId)); return;
        }
        const raw = await readRequestBody(req, 4096);
        if (raw === undefined) throw Error('invalid-context-request');
        body=JSON.parse(raw);
        if (!body || typeof body!=='object' || Array.isArray(body)) throw Error('invalid-context-request');
        if(body.action==='open'){ensureChatRecords();ensureChatProfile();}
        if(body.roomId && body.action==='presence' && body.visible===false) ensureChatRecords();
        // A close can arrive before the open it supersedes; retain its sequence
        // without opening the room's references or reading their contents.
        roomId=body.roomId;source=contextForRoom(roomId,body.action==='open'||(body.action==='presence'&&body.visible===false));
        if(!source)throw Error('context-not-open');
        if (body.action==='open' || body.action==='presence') {
          if (!source.presence(body.viewer, body.visible !== false, body.sequence) || body.visible === false) {
            sendJson(res,200,chatContextState(source,roomId)); return;
          }
          if (body.action==='open') {
            const room=roomId?chats.read(roomId):null;
            await source.open({sessionId:body.sessionId,selection:room?.sources?{sessionIds:room.sources,primarySessionId:room.primarySessionId}:undefined});
          }
        } else {
          if (!source.active()) throw Error('context-not-open');
          if (['attach','detach'].includes(body.action) && body.revision!==source.snapshot().revision) throw Error('chat-context-changed');
          if (body.action==='attach') await source.attach(body.sessionId,body.primary===true);
          else if (body.action==='detach') source.detach(body.sessionId);
          else if (body.action==='sessions') { sendJson(res,200,{roomId,items:await source.sessions(body.projectId)});return; }
          else if (body.action==='dismiss') source.dismiss(body.noticeId);
          else if (body.action==='refresh') await source.refresh(true);
          else if (body.action==='focus') source.touch(body.sessionId,'view',body.viewer);
          else throw Error('invalid-context-action');
          for (const pending of activeChats.values()) if ((roomId?pending.roomId===roomId:!roomContexts.has(pending.roomId)) && pending.contextKey && pending.contextKey!==source.key()) pending.abort.abort(Error('chat-context-changed'));
          for(const round of chatRounds.values())if((roomId?round.roomId===roomId:!roomContexts.has(round.roomId))&&round.contextKey&&round.contextKey!==source.key())round.abort.abort(Error('chat-context-changed'));
          for (const pending of activeSuggestions.values()) if ((roomId?pending.roomId===roomId:!roomContexts.has(pending.roomId)) && pending.contextKey && pending.contextKey!==source.key()) pending.abort.abort(Error('suggestions-context-changed'));
        }
        if(roomId && ['open','attach','detach','refresh'].includes(body.action)){
          const value=source.snapshot(),sessionIds=value.sources.map(s=>s.sessionId),room=chats.read(roomId);
          if(JSON.stringify(room?.sources)!==JSON.stringify(sessionIds)||room?.primarySessionId!==value.primarySessionId)
            await chats.sources({roomId,sessionIds,primarySessionId:value.primarySessionId});
          retireInvalidWorkDrafts(roomId);
        }
        sendJson(res,200,chatContextState(source,roomId));
      } catch (error) {
        const known=/^(context-|invalid-context-|chat-context-)/.test(error.message??'');
        const invalid=error instanceof SyntaxError || /^invalid-context-/.test(error.message??'');
        sendJson(res,error.message==='chat-room-not-found'?404:invalid?400:known?409:503,
          {error:error.message==='chat-room-not-found'?error.message:invalid?'invalid-context-request':known?error.message:'context-unavailable',state:chatContextState(source,roomId)});
      }
      return;
    }

    if (path === ROUTE + '/chat-profile' && req.method === 'GET') { sendJson(res, 200, publicChatProfile()); return; }

    if (path === ROUTE + '/chat-profile' && req.method === 'POST') {
      if (!getSettingsRestored() || !getStore() || getStoreClosing()) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      ensureChatProfile();
      const raw = await readRequestBody(req, 560 * 1024);
      if (raw === undefined) { sendJson(res, 413, { error: 'too-large' }); return; }
      try {
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid-profile');
        await chatProfile.update(body);
        if (!getStoreClosing()) sendJson(res, 200, publicChatProfile());
        else sendJson(res, 503, { error: 'storage-not-ready' });
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        sendJson(res, reason === 'profile-conflict' ? 409 : /^invalid-/.test(reason) ? 400 : 503,
          { error: reason === 'profile-conflict' ? reason : reason.startsWith('invalid-') ? reason : 'profile-save-failed', state: publicChatProfile() });
      }
      return;
    }

    if (path === ROUTE + '/chat-profile/avatar' && req.method === 'GET') {
      ensureChatProfile();
      const content = avatarContent(chatProfile.read().avatar);
      if (!content) { sendJson(res, 404, { error: 'avatar-not-found' }); return; }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': content.data.length,
        'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
      res.end(content.data); return;
    }

    if(path===ROUTE+'/chat-image'&&req.method==='GET'){
      ensureChatRecords();
      const room=chats.read(url.searchParams.get('room')),generation=Number(url.searchParams.get('generation'));
      const attachmentId=url.searchParams.get('id');
      const parts=room?[...room.turns.flatMap(t=>t.userParts??[]),...chatInputs.list(room.id).filter(b=>b.imageGeneration===(room.generation??0)).flatMap(b=>b.parts)]:[];
      const ref=room&&generation===(room.generation??0)?parts.flatMap(p=>p.images??[]).find(r=>r.attachmentId===attachmentId):undefined;
      const attachments=ctx.get('attachments');
      if(!ref||typeof attachments?.readImage!=='function'){sendJson(res,404,{error:'chat-image-unavailable'});return;}
      try{
        const image=await waitWithSignal(attachments.readImage(ref),AbortSignal.timeout(Math.min(cfg.timeoutMs,8000)));
        const bytes=Buffer.from(image.data);
        if(bytes.length!==ref.bytes)throw Error('invalid-image');
        res.writeHead(200,{'content-type':ref.mediaType,'content-length':bytes.length,'cache-control':'private, no-store','x-content-type-options':'nosniff'});
        res.end(bytes);
      }catch{if(!res.writableEnded)sendJson(res,404,{error:'chat-image-unavailable'});}
      return;
    }

    // Inspect the same room route without opening sessions or dispatching a model stream.
    if (path === `${ROUTE}/chat-model-options`) {
      if(req.method!=='GET'){sendJson(res,405,{error:'method-not-allowed'});return;}
      const roomId=url.searchParams.get('room');
      const room=roomId&&getChatRecordsLoaded()?chats.read(roomId):undefined;
      if(roomId&&!room){sendJson(res,getChatRecordsLoaded()?404:409,{error:getChatRecordsLoaded()?'chat-room-not-found':'context-not-open'});return;}
      const abort=new AbortController(),closed=()=>abort.abort(Error('metadata-cancelled'));
      activeModelMetadata.add(abort);res.once?.('close',closed);
      const timer=setTimeout(()=>abort.abort(Error('metadata-timeout')),Math.min(cfg.timeoutMs,8000));
      const inspect=async()=>{
        let route;
        try{
          route=await modelRoutes.resolve(room?.primarySessionId??currentSessionHint(),{provider:settings.chatProvider,model:settings.chatModel},{signal:abort.signal});
          abort.signal.throwIfAborted();
          if(!route)return{provider:null,model:null,source:null,...reasoningOptions(),error:'no-route'};
          const llm=getLlm();let info;
          if(typeof llm?.resolveModelInfo==='function')info=await waitWithSignal(llm.resolveModelInfo(route.provider,route.model,abort.signal),abort.signal);
          else if(typeof llm?.listModels==='function'){
            const listed=await waitWithSignal(llm.listModels(route.provider),abort.signal);
            info=Array.isArray(listed)?listed.find(model=>model?.id===route.model):undefined;
          }
          abort.signal.throwIfAborted();
          return{...route,...reasoningOptions(info),vision:imageInputStatus(info)};
        }catch{
          return{provider:route?.provider??null,model:route?.model??null,source:route?.source??null,...reasoningOptions(),vision:'unknown',error:'metadata-unavailable'};
        }
      };
      try{
        const result=await trackModelTask(inspect());
        if(!res.destroyed&&!res.writableEnded)sendJson(res,getStoreClosing()?503:200,getStoreClosing()?
          {provider:null,model:null,source:null,...reasoningOptions(),error:'metadata-unavailable'}:result);
      }finally{
        clearTimeout(timer);activeModelMetadata.delete(abort);res.off?.('close',closed);
      }
      return;
    }

    if(path===ROUTE+'/chat-rooms'&&req.method==='POST'){
      if(!getSettingsRestored()||!getStore()||getStoreClosing()){sendJson(res,503,{error:'storage-not-ready'});return;}
      ensureChatRecords();let body;
      try{
        const raw = await readRequestBody(req, 12000);
        if (raw === undefined) throw Error('invalid-chat-room');
        body = JSON.parse(raw);
        if (!isObjectBody(body)) throw Error('invalid-chat-room');
        const before=chats.read(body.roomId);let selected=body.roomId;
        if(body.action==='ensure-first' || body.action==='create'){
          if(body.epoch!==chats.epoch())throw Error('chat-conflict');
          if(!Array.isArray(body.memberIds)||body.memberIds.some(id=>!getPresets().some(p=>p.id===id)))throw Error('persona-not-found');
          const room=await chats.create(body,{onlyIfEmpty:body.action==='ensure-first'});selected=room.id;
        }else if(body.action==='select')await chats.select(body);
        else if(body.action==='update'){
          if(!before)throw Error('chat-room-not-found');
          if(body.memberIds!==undefined&&(!Array.isArray(body.memberIds)||body.memberIds.some(id=>!before.memberIds.includes(id)&&!getPresets().some(p=>p.id===id))))throw Error('persona-not-found');
          if(body.targetPersonaId!==undefined&&!getPresets().some(p=>p.id===body.targetPersonaId))throw Error('persona-not-found');
          if(body.targetPersonaIds!==undefined&&(!Array.isArray(body.targetPersonaIds)||body.targetPersonaIds.some(id=>!getPresets().some(p=>p.id===id))))throw Error('persona-not-found');
          const room=await chats.update(body);
          for(const id of before.memberIds)if(!room.memberIds.includes(id))chatScheduler.removeMember(room.id,id);
          for(const pending of chatJobsFor(room.id))if(!room.memberIds.includes(pending.personaId))pending.abort.abort(Error('chat-member-removed'));
          activeSuggestions.get(room.id)?.abort.abort(Error('suggestions-context-changed'));
        }else if(body.action==='delete'){
          await chats.remove(body, (id,finish)=>body.retractMemories!==false && roomMemoryCount(id)
            ? saveMemoryMutation({action:'retract-room'},{applyChange:staged=>staged.retractRoom(id),finish}) : finish());
          retireRoomRuntime(body.roomId,'room-deleted');
          chatDirectorClocks.delete(body.roomId);
          roomContexts.get(body.roomId)?.dispose();roomContexts.delete(body.roomId);
          await chatInputs.clear(body.roomId,{forgetReceipts:true});
          selected=chats.active();
        }else throw Error('invalid-chat-room-action');
        sendJson(res,200,chatState(selected));
      }catch(error){const code=error instanceof SyntaxError?'invalid-chat-room':error.message;
        sendJson(res,code==='chat-room-not-found'?404:code?.includes('conflict')?409:code==='chat-input-save-failed'?503:/^(invalid-|chat-|persona-)/.test(code??'')?400:503,
          {error:/^(invalid-|chat-|persona-)/.test(code??'')?code:'chat-save-failed',state:chatState(body?.roomId??chats.active())});}
      return;
    }

    if (path === ROUTE + '/chat' && req.method === 'GET') {
      ensureChatRecords();
      const sessionId = url.searchParams.get('session');
      if (sessionId !== null && (!sessionId.trim() || sessionId.length > 200)) { sendJson(res, 400, { error: 'invalid-session' }); return; }
      const reportPersonaId = sessionId ? personaFor(sessionId).id : activePresetId();
      const explicitRoom=url.searchParams.get('room'),legacyPersona=url.searchParams.get('persona');
      const id = explicitRoom || legacyPersona || chats.active() || reportPersonaId;
      if (explicitRoom&&!chats.read(id)) {sendJson(res,404,{error:'chat-room-not-found'});return;}
      if (legacyPersona&&!getPresets().some((p) => p.id === id) && !chats.read(id)) { sendJson(res, 404, { error: 'persona-not-found' }); return; }
      await ensureChatLocalStateKey();
      sendJson(res, 200, { ...chatState(id), reportPersonaId }); return;
    }

    if(path===ROUTE+'/chat-work-draft'&&(req.method==='GET'||req.method==='POST')){
      if(!getSettingsRestored()||!getStore()||getStoreClosing()){sendJson(res,503,{error:'storage-not-ready'});return;}
      try{
        if(req.method==='GET'){
          if(!getChatRecordsLoaded()){sendJson(res,200,{initialized:false,room:null,choices:[],thinking:settings.chatThinking===true});return;}
          const requested=url.searchParams.get('room'),room=chats.read(requested??chats.active());
          if(requested&&!room)throw Error('chat-room-not-found');
          sendJson(res,200,{initialized:true,room:room?{id:room.id,name:room.name}:null,epoch:chats.epoch(),scopeKey:roomScopeKey(room),
            referenceRevision:room?.referenceRevision??0,discussionRevision:room?.discussion?.revision??0,thinking:settings.chatThinking===true,
            choices:room?roomPublicChoices(room,roomScopeKey(room),room.excludedReferences):[]});return;
        }
        const raw = await readRequestBody(req, 18000);
        if (raw === undefined) throw Error('invalid-chat-draft');
        const body=JSON.parse(raw);
        if(!body||typeof body!=='object'||Array.isArray(body))throw Error('invalid-chat-draft');
        if(body.action==='cancel'){
          if(typeof body.roomId!=='string'||!body.roomId.trim()||body.roomId.length>160
            ||typeof body.requestId!=='string'||!body.requestId.trim()||body.requestId.length>160)throw Error('invalid-chat-draft');
          const key=JSON.stringify([body.roomId,body.requestId]);cancelledWorkDrafts.add(key);
          while(cancelledWorkDrafts.size>64)cancelledWorkDrafts.delete(cancelledWorkDrafts.values().next().value);
          const pending=activeWorkDrafts.get(body.roomId),cancelled=pending?.requestId===body.requestId&&!pending.abort.signal.aborted;
          if(cancelled)pending.abort.abort(Error('chat-draft-cancelled'));
          sendJson(res,200,{cancelled:!!cancelled});return;
        }
        if(body.action==='validate'){sendJson(res,200,{valid:true,basis:preparedWorkDraft(body).basis});return;}
        if(body.action!=='generate')throw Error('invalid-chat-draft');
        const result=await generateWorkDraft(body);
        if(getStoreClosing())throw Error('chat-draft-unavailable');
        // A completed cached response is still checked against the present sources.
        preparedWorkDraft(body);sendJson(res,200,result);
      }catch(error){const reason=error instanceof SyntaxError?'invalid-chat-draft':error?.message??'',known=/^(invalid-chat-draft|chat-draft-|chat-room-not-found|context-not-open)/.test(reason);
        sendJson(res,reason==='chat-room-not-found'?404:/conflict|context-changed|superseded|cancelled/.test(reason)?409:/invalid-chat-draft|too-large/.test(reason)?400:503,
          {error:known?reason:'chat-draft-unavailable'});}
      return;
    }

    if (path === ROUTE + '/chat/suggestions' && req.method === 'POST') {
      if (!getSettingsRestored() || !getStore() || getStoreClosing()) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      ensureChatRecords();
      const raw = await readRequestBody(req, 24000);
      if (raw === undefined) { sendJson(res, 413, { error: 'too-large' }); return; }
      let body;
      try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid-chat-message' }); return; }
      const persona = getPresets().find((p) => p.id === body?.personaId);
      const instruction = typeof body?.instruction === 'string' ? body.instruction : '';
      if (!persona || instruction.length > 4000) { sendJson(res, 400, { error: 'invalid-chat-message' }); return; }
      const room = chats.read(body.roomId??persona.id);
      if(body.roomId&&(!room||!room.memberIds.includes(persona.id)||(room.targetPersonaId!==null&&room.targetPersonaId!==persona.id))){
        sendJson(res,409,{error:'suggestions-context-changed'});return;
      }
      const sourceContext=roomContexts.get(room?.id)??chatContext;
      const contextKey=body.contextKey??null;
      if (contextKey && (!sourceContext.active() || contextKey!==sourceContext.key())) {sendJson(res,409,{error:'suggestions-context-changed'});return;}
      const epoch = body.epoch ?? 0;
      if (!chats.acceptsEpoch(room?.id, epoch) || (room?.id ?? null) !== body.roomId || (room?.revision ?? 0) !== body.revision) {
        sendJson(res, 409, { error: 'suggestions-context-changed' }); return;
      }
      let suggestionScope=contextKey;
      if(body.roomId&&(roomContexts.has(body.roomId)||!room?.legacyPersonaId)){try{suggestionScope=capturedRoomContext(body.roomId,contextKey).scopeKey;}catch{
        sendJson(res,409,{error:'suggestions-context-changed'});return;}}
      const suggestionHistory=(room?.turns??[]).filter(t=>(t.scopeKey??t.contextKey??null)===suggestionScope);
      if (!instruction.trim() && !suggestionHistory.length) { sendJson(res, 400, { error: 'suggestions-no-context' }); return; }
      const suggestionKey=room?.id??persona.id;
      activeSuggestions.get(suggestionKey)?.abort.abort(new Error('superseded'));
      const abort = new AbortController();
      const chatOptions={provider:settings.chatProvider,model:settings.chatModel,thinking:settings.chatThinking,reasoningEffort:settings.chatReasoningEffort};
      const pending = { personaId: persona.id,roomId:room?.id, pack: persona.pack, abort, contextKey };
      activeSuggestions.set(suggestionKey, pending);
      const closed = () => { if (!res.writableEnded) abort.abort(new Error('disconnected')); };
      res.once?.('close', closed);
      const timer = setTimeout(() => abort.abort(new Error('suggestions-timeout')), Math.min(cfg.timeoutMs, chatOptions.thinking?60000:20000));
      const current = () => !getStoreClosing() && chats.acceptsEpoch(room?.id, epoch) && getPresets().find((p) => p.id === persona.id)?.pack === persona.pack
        && (!contextKey || sourceContext.key()===contextKey)
        && (chats.read(body.roomId??persona.id)?.id ?? null) === body.roomId && (chats.read(body.roomId??persona.id)?.revision ?? 0) === body.revision;
      try {
        const suggestions = await trackModelTask((async () => {
          const route = await waitWithSignal(resolveChatRouteAsync(contextKey?sourceContext.snapshot().primarySessionId:currentSessionHint(),chatOptions,abort.signal), abort.signal);
          const llm = expressionLlm('reply-suggestions', undefined, { ...chatOptions, beforeAttempt() {
            if (!current()) throw new Error('suggestions-context-changed');
          } });
          if (!route || !llm || !current()) throw new Error('suggestions-unavailable');
          const { system, user } = buildReplySuggestions({ name:room?(room.targetPersonaIds.length?room.targetPersonaIds:room.memberIds).map(id=>getPresets().find(p=>p.id===id)?.name??id).join('、'):persona.name, history: suggestionHistory, instruction });
          let wire = '', finish;
          for await (const chunk of streamWithSignal(llm, { provider: route.provider, model: route.model, system,
            messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: chatOptions.thinking?4096:768, signal: abort.signal })) {
            if (chunk.type === 'error' || chunk.type.startsWith('tool-call')
              || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
              || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) throw new Error('suggestions-invalid');
            if (chunk.type === 'text-delta') wire += chunk.text;
            if (wire.length > 4096) throw new Error('suggestions-too-long');
            if (chunk.type === 'finish') finish = chunk.reason?.kind;
          }
          abort.signal.throwIfAborted();
          const result = finish === 'stop' ? parseReplySuggestions(wire) : undefined;
          if (!result || !current()) throw new Error('suggestions-context-changed');
          return result;
        })());
        abort.signal.throwIfAborted();
        if (!current()) throw new Error('suggestions-context-changed');
        if (!res.destroyed && !res.writableEnded) sendJson(res, 200, { personaId: persona.id, roomId: body.roomId, revision: body.revision, suggestions });
      } catch {
        if (!res.destroyed && !res.writableEnded) sendJson(res, current() ? 422 : 409,
          { error: current() ? 'suggestions-failed' : 'suggestions-context-changed' });
      } finally {
        clearTimeout(timer); res.removeListener?.('close', closed); abort.abort();
        if (activeSuggestions.get(suggestionKey) === pending) activeSuggestions.delete(suggestionKey);
      }
      return;
    }

    if (path === ROUTE + '/chat' && req.method === 'POST') {
      if (!getSettingsRestored() || !getStore() || getStoreClosing()) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
      ensureChatRecords();
      const raw = await readRequestBody(req, CHAT_IMAGE_LIMITS.request);
      if (raw === undefined) { sendJson(res, 413, { error: 'too-large' }); return; }
      let body;
      try { body = JSON.parse(raw); } catch { sendJson(res, 400, { error: 'invalid-chat-message' }); return; }
      if(Buffer.byteLength(raw)>24000&&(body?.action!=='send'||!Array.isArray(body.images))){sendJson(res,413,{error:'too-large'});return;}
      if(body?.summarize!==undefined&&(body.summarize!==true||body.action!=='send'||!body.roomId)){sendJson(res,400,{error:'invalid-chat-message'});return;}
      const id = body?.personaId;
      if (typeof id !== 'string' || !id || id.length > 160) { sendJson(res, 400, { error: 'invalid-chat-message' }); return; }
      const selectedRoom=chats.read(body.roomId??id),roomKey=selectedRoom?.id??id;
      if(body.roomId&&!selectedRoom){sendJson(res,404,{error:'chat-room-not-found'});return;}
      const recipientId=body.action==='retry'&&body.roomId?selectedRoom.turns.find(t=>t.id===body.id)?.recipientId:id;
      const persona = getPresets().find((p) => p.id === recipientId);
      try {
        if (body.action === 'send' || body.action === 'retry') {
          if(body.userParts!==undefined)throw Error('invalid-chat-message');
          if(body.withoutImages!==undefined&&(body.withoutImages!==true||body.images!==undefined))throw Error('invalid-chat-message');
          if (!persona) { sendJson(res, 400, { error: 'persona-not-found' }); return; }
          if (chatStarting.has(roomKey)) { sendJson(res, 409, { error: 'chat-busy', state: chatState(body.roomId??id) }); return; }
          const previousRound=chatRounds.get(roomKey);
          if(body.action==='retry'&&previousRound&&!previousRound.abort.signal.aborted&&previousRound.stage==='listening')throw Error('chat-busy');
          // launchChatRound supersedes the old judgement only after the new message is durable.
          const allowOrphan = !chatJobsFor(roomKey).some(job=>!job.abort.signal.aborted)
            && (!previousRound || previousRound.abort.signal.aborted);
          chatStarting.add(roomKey);
          let result;
          try {
            let admittedImages=[];
            if(body.action==='send'&&body.images!==undefined){
              if(!body.roomId||!selectedRoom||!chats.acceptsEpoch(selectedRoom.id,body.epoch))throw Error('chat-conflict');
              if(typeof body.content!=='string'||body.content.length>CHAT_LIMITS.input)throw Error('invalid-chat-message');
              const uploads=decodeChatImages(body.images),attachments=ctx.get('attachments');
              if(typeof attachments?.saveImages!=='function'||typeof attachments?.readImage!=='function')throw Error('chat-images-unavailable');
              const knownRequest=selectedRoom.turns.some(t=>t.userParts?.some(p=>p.id===body.requestId))||chatInputs.list(selectedRoom.id).some(b=>b.parts.some(p=>p.id===body.requestId));
              if(!knownRequest){
                const metadataSignal=AbortSignal.timeout(Math.min(cfg.timeoutMs,8000));
                const route=await resolveChatRouteAsync(selectedRoom.primarySessionId??currentSessionHint(),{provider:settings.chatProvider,model:settings.chatModel},metadataSignal);
                const llm=getLlm(),info=route&&typeof llm?.resolveModelInfo==='function'?await waitWithSignal(llm.resolveModelInfo(route.provider,route.model,metadataSignal),metadataSignal).catch(()=>undefined):undefined;
                if(imageInputStatus(info)==='unsupported')throw Error('chat-vision-unavailable');
              }
              try{admittedImages=normalizeChatImages(await attachments.saveImages(uploads));}catch{throw Error('chat-image-upload-failed');}
              if(admittedImages.length!==uploads.length)throw Error('chat-image-upload-failed');
              if(!chats.acceptsEpoch(selectedRoom.id,body.epoch)||getStoreClosing())throw Error('chat-conflict');
              if(!body.content.trim())body.content='（发送了 '+admittedImages.length+' 张图片）';
            }else if(Buffer.byteLength(raw)>24000)throw Error('invalid-chat-message');
            const sourceContext=body.roomId?contextForRoom(body.roomId):chatContext;
            if(body.roomId&&(!sourceContext||!body.contextKey))throw Error('context-not-open');
            // Preserve the room's range/version before saving the message. Work bodies
            // are refreshed and captured only after this round selects relevant sources.
            const workContext=body.roomId?capturedRoomContext(body.roomId,body.contextKey,{sourceIds:[]}):body.contextKey ? sourceContext.capture(body.contextKey,{sourceIds:[]}) : undefined;
            const contextKey=workContext?.key??null;
            const scopeKey=workContext?.scopeKey??contextKey;
            const targetIds=body.recipientIds??selectedRoom?.targetPersonaIds??[persona.id];
            if(body.action==='send'&&(!Array.isArray(targetIds)||targetIds.some(target=>!getPresets().some(p=>p.id===target))))throw Error('invalid-chat-message');
            if(body.action==='send'&&body.roomId){
              await getChatInputRestore();
              const current=chats.read(body.roomId);
              if (!current) throw Error('chat-room-not-found');
              if (getStoreClosing() || targetIds.some(target => !getPresets().some(p => p.id === target))) throw Error('chat-conflict');
              if(!chats.acceptsEpoch(current.id,body.epoch))throw Error('chat-conflict');
              const prior=current.turns.find(t=>t.messageId===body.requestId||t.userParts?.some(p=>p.id===body.requestId));
              if(prior){
                const text=prior.userParts?.find(p=>p.id===body.requestId)?.text??prior.user;
                if(text!==body.content||!sameChatImages(prior.userParts?.find(p=>p.id===body.requestId)?.images,admittedImages)||!!prior.userParts?.find(p=>p.id===body.requestId)?.withoutImages!==(body.withoutImages===true)||!!prior.userParts?.find(p=>p.id===body.requestId)?.summarize!==(body.summarize===true)||(prior.scopeKey??prior.contextKey??null)!==scopeKey||(prior.recipients.length>0&&prior.recipients[0].id!==persona.id)
                  ||(body.recipientIds&&JSON.stringify(body.recipientIds)!==JSON.stringify(prior.recipients.map(p=>p.id)))
                  ||quoteKey(body.quote)!==quoteKey(prior.quote?.ref))throw Error('chat-id-conflict');
                // A committed request remains an acknowledgment even if next-send
                // roster controls changed. It must never create a new round.
              }else{
              if(body.summarize&&!current.sources?.length)throw Error('support-reference-unavailable');
              if(JSON.stringify(targetIds)!==JSON.stringify(current.targetPersonaIds))throw Error('chat-conflict');
              const quote=body.quote==null?null:resolveChatQuote(current,body.quote,scopeKey);
              if(body.quote!=null&&!quote)throw Error('chat-quote-unavailable');
              const queued=await chatInputs.enqueue({roomId:current.id,requestId:body.requestId,content:body.content,...(admittedImages.length?{images:admittedImages,imageGeneration:current.generation??0}:{}),...(body.withoutImages?{withoutImages:true}:{}),...(body.summarize?{summarize:true}:{}),
                recipients:targetIds.map(id=>({id,name:getPresets().find(p=>p.id===id).name})),memberIds:current.memberIds,
                referenceRevision:current.referenceRevision??0,contextKey,scopeKey,quote,clientTime:body.clientTime});
              if(queued.batch)chatInputBindings.set(JSON.stringify([current.id,queued.batch.id]),workContext);
              const round=chatRounds.get(current.id);
              if(round&&queued.created&&!chatJobsFor(current.id).some(job=>job.started&&!job.abort.signal.aborted))round.abort.abort(Error('chat-user-input'));
              round?.wake?.();
              armChatInput(current.id);
              }
            }else{
              result = body.action === 'send' ? await chats.send({ ...body,personaId:persona.id,recipients:targetIds.map(id=>({id,name:getPresets().find(p=>p.id===id).name})), contextKey,scopeKey, name: persona.name, allowOrphan,frozenRecipients:false,frozenMemberIds:undefined,directed:true })
                : await chats.retry({ ...body,personaId:persona.id, contextKey,scopeKey, name: persona.name, allowOrphan,members:getPresets() });
            }
            retireInvalidWorkDrafts(roomKey);
            if (workContext?.primarySessionId) sourceContext.touch(workContext.primarySessionId,'message');
            if (!getStoreClosing() && result?.created)launchChatRound(result,workContext,body.clientTime);
          } finally { chatStarting.delete(roomKey); }
        } else if(body.action==='retry-director'){
          if(!selectedRoom||!chats.acceptsEpoch(selectedRoom.id,body.epoch)||chatRounds.has(selectedRoom.id)||chatJobsFor(selectedRoom.id).some(job=>!job.abort.signal.aborted))throw Error('chat-busy');
          const anchor=selectedRoom.turns.find(t=>t.messageId===body.messageId&&t.phase==='anchor');
          if(!anchor||selectedRoom.turns.at(-1)?.messageId!==anchor.messageId)throw Error('chat-retry-unavailable');
          const work=capturedRoomContext(selectedRoom.id,body.contextKey,{sourceIds:[]});
          if((anchor.scopeKey??anchor.contextKey??null)!==work.scopeKey)throw Error('chat-context-changed');
          launchChatRound({room:selectedRoom,turn:anchor,turns:[anchor],created:false},work,body.clientTime);
        } else if(body.action==='cancel-support'){
          if(!selectedRoom||!chats.acceptsEpoch(selectedRoom.id,body.epoch)||typeof body.jobId!=='string'||!chatSupport.view(supportScope(selectedRoom)).some(j=>j.id===body.jobId))throw Error('chat-conflict');
          chatSupport.cancel(selectedRoom.id,body.jobId);
        } else if (body.action==='retry-input'||body.action==='cancel-input') {
          await getChatInputRestore();
          if(!selectedRoom||!chats.acceptsEpoch(selectedRoom.id,body.epoch))throw Error('chat-conflict');
          if(body.action==='cancel-input'){
            await chatInputs.cancel(selectedRoom.id,body.requestId);chatInputBindings.delete(JSON.stringify([selectedRoom.id,body.requestId]));
          }
          else{
            const batch=chatInputs.list(selectedRoom.id).find(b=>b.id===body.requestId);
            if(!batch)throw Error('chat-input-not-found');
            if(batch.scopeKey!==roomScopeKey(selectedRoom)||(selectedRoom.referenceRevision??0)!==batch.referenceRevision)throw Error('chat-context-changed');
            const binding=capturedRoomContext(selectedRoom.id,body.contextKey,{sourceIds:[]});
            chatInputBindings.set(JSON.stringify([selectedRoom.id,batch.id]),binding);
            await chatInputs.retry(selectedRoom.id,batch.id);armChatInput(selectedRoom.id);
          }
        } else if (body.action === 'cancel') {
          const round=chatRounds.get(roomKey);
          if(body.roundId&&round?.id===body.roundId&&round.messageId===body.messageId&&chats.acceptsEpoch(roomKey,body.epoch))round.abort.abort(Error('chat-cancelled'));
          const cancelled = body.attempts?.length===0&&body.roundId?false:await chats.cancel(body);
          if(cancelled&&round&&(body.messageId===undefined||round.messageId===body.messageId)
            &&(body.attempts?body.attempts.some(p=>round.attempts.has(p.attemptId)):round.attempts.has(body.attemptId)))round.abort.abort(Error('chat-cancelled'));
          if(cancelled)for(const pending of chatJobsFor(roomKey))if(body.attempts?body.attempts.some(p=>p.id===pending.turnId&&p.attemptId===pending.attemptId)
            :body.messageId?pending.messageId===body.messageId:pending.attemptId===body.attemptId)pending.abort.abort(new Error('chat-cancelled'));
        } else if (body.action === 'clear') {
          if (await chats.clear(body)) {
            retireRoomRuntime(roomKey,'chat-cleared');
            await chatInputs.clear(roomKey,{forgetReceipts:true});
          }
        } else { sendJson(res, 400, { error: 'invalid-chat-action' }); return; }
        if (getStoreClosing()) { sendJson(res, 503, { error: 'storage-not-ready' }); return; }
        sendJson(res, 200, chatState(body.roomId??id));
      } catch (error) {
        const reason = error?.message ?? 'chat-save-failed';
        const known = /^(invalid-chat|chat-|context-not-open|support-reference-unavailable)/.test(reason);
        sendJson(res, /save-failed|persist/.test(reason) ? 503 : /conflict|busy|context-changed|context-unsaved|context-not-open/.test(reason) ? 409 : known ? 400 : 503,
          { error: known ? reason : 'chat-save-failed', state: chatState(body.roomId??id) });
      }
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  };
}
