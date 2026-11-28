import { randomUUID } from 'node:crypto';
import { CHAT_LIMITS, parseChatDecision, chatFailure } from './persona-chat.js';
import { buildChatPrompt, publicChatExchange } from './chat-prompt.js';
import { selectChatImages, appendChatImages } from './chat-images.js';
import { createChatTimeContext, relativeDay } from './chat-time.js';
import { chatSchedulerEventKey } from './chat-scheduler.js';
import { contextSelectionFallback, explicitContextSelection } from './chat-coordinator.js';
import { CHAT_SUPPORT_SETTINGS, supportReasonContext, supportSummaryContext } from './chat-support-templates.js';
import { directorEvents, directedOpinionHandback, possiblePeerCall, userMentions } from './chat-director.js';
import { buildDirectorRequest } from './chat-director-wire.js';
import { normalizeChatContribution } from './chat-contribution.js';
import { buildChatSceneCatalog, selectChatScene, projectChatScene } from './chat-scene.js';
import { roomCharacterContext } from './character-roster.js';
import { quoteKey, resolveChatQuote } from './chat-quote.js';
import { discussionContext, chatAssignment } from './chat-discussion.js';
import { partialChatReply } from './chat-live.js';
import { personalChatMemory } from './chat-memory.js';

export function createHostChat({
  chatTiming, cancelCandidateJobs,
  activeChats, activeWorkDrafts, capturedRoomContext, cfg, chatContext, chatDirectorClocks,
  chatDirectorFailures, chatInputBindings, chatInputDraining, getChatInputReady,
  getChatInputRestore, chatInputs, chatInputTimers, chatIntervalMs, chatJobKey, chatJobsFor,
  chatLive, chatProfile, chatReferenceUsage, chatRounds, chats, chatScheduler, chatSupport,
  contextForRoom, ctx, currentSessionHint, getDiagnostics, DIRECTOR_FINISHES, DIRECTOR_REASONS,
  ensureChatProfile, expressionLlm, expressionMemory, instanceId, memories, getPresets,
  resolveChatRouteAsync, roomContexts, roomScopeKey, settings, getStoreClosing, streamWithSignal,
  supportScope, trackModelTask, waitWithSignal, warn, workDraftRequests,
}) {
  function retireOldRoomReferences(roomId){
    cancelCandidateJobs(roomId);
    const revision=chats.read(roomId)?.referenceRevision??0,round=chatRounds.get(roomId);
    if(round&&(round.referenceRevision??0)!==revision)round.abort.abort(Error('chat-context-changed'));
    for(const pending of chatJobsFor(roomId))if((pending.referenceRevision??0)!==revision)pending.abort.abort(Error('chat-context-changed'));
    retireInvalidWorkDrafts(roomId);
  }

  function retireInvalidWorkDrafts(roomId,drop=false){
    cancelCandidateJobs(roomId, !drop);
    const pending=activeWorkDrafts.get(roomId);
    if(pending&&!pending.valid())pending.abort.abort(Error('chat-draft-context-changed'));
    if(drop)for(const [key,value] of workDraftRequests)if(value.roomId===roomId)workDraftRequests.delete(key);
  }

  const schedulerScope=(room,scopeKey)=>JSON.stringify([scopeKey??null,room.referenceRevision??0]);
  function retainChatEvents(roomId){
    const room=chats.read(roomId);if(!room)return;
    const ids=[];
    for(const turn of room.turns){
      for(const part of turn.userParts??[{id:turn.messageId}])ids.push(chatSchedulerEventKey({roomId,generation:room.generation??0,
        sourceScope:schedulerScope(room,turn.scopeKey??turn.contextKey??null),turnId:part.id,attemptId:'user'}));
      if(turn.status==='ready')ids.push(chatSchedulerEventKey({roomId,generation:room.generation??0,
        sourceScope:schedulerScope(room,turn.scopeKey??turn.contextKey??null),turnId:turn.id,attemptId:turn.attemptId}));
    }
    chatScheduler.retain(roomId,ids.filter(Boolean));
  }

  function armChatInput(roomId) {
    const old=chatInputTimers.get(roomId);if(old!==undefined){clearTimeout(old);chatInputTimers.delete(roomId);}
    if(getStoreClosing()||!getChatInputReady()||chatInputDraining.has(roomId)||chatRounds.has(roomId)||!chatInputs.peek(roomId))return;
    const delay=Math.min(2_147_483_647, Math.max(0,chatInputs.notBefore(roomId)-Date.now()));
    const timer=setTimeout(()=>{chatInputTimers.delete(roomId);void drainChatInput(roomId);},delay);
    chatInputTimers.set(roomId,timer);
  }
  function retireChatInputRuntime(roomId){
    cancelCandidateJobs(roomId);
    const timer=chatInputTimers.get(roomId);if(timer!==undefined)clearTimeout(timer);chatInputTimers.delete(roomId);
    for(const key of chatInputBindings.keys())if(JSON.parse(key)[0]===roomId)chatInputBindings.delete(key);
  }

  async function drainChatInput(roomId) {
    if(getStoreClosing()||chatInputDraining.has(roomId)||chatRounds.has(roomId))return;
    chatInputDraining.add(roomId);let batch;
    try{
      await getChatInputRestore();
      const first=chatInputs.peek(roomId);if(!first)return;
      batch=await chatInputs.claim(roomId,first.id);if(!batch||getStoreClosing())return;
      const room=chats.read(roomId);
      if(!room||roomScopeKey(room)!==batch.scopeKey||(room.referenceRevision??0)!==batch.referenceRevision)throw Error('source-changed');
      if(batch.imageGeneration!==undefined&&batch.imageGeneration!==(room.generation??0))throw Error('source-changed');
      if(batch.recipients.some(p=>!room.memberIds.includes(p.id)||!getPresets().some(v=>v.id===p.id)))throw Error('persona-changed');
      const source=contextForRoom(roomId),binding=chatInputBindings.get(JSON.stringify([roomId,batch.id]));
      let workContext=binding;
      if(source?.active())workContext=capturedRoomContext(roomId,source.key(),{sourceIds:[]});
      if(!workContext||workContext.scopeKey!==batch.scopeKey)throw Error('source-changed');
      const result=await chats.send({roomId,personaId:batch.recipients[0]?.id,name:batch.recipients[0]?.name,
        recipients:batch.recipients,requestId:batch.id,content:batch.message,userParts:batch.parts,
        quote:batch.quote?.ref,revision:room.revision,epoch:chats.epoch(),contextKey:workContext.key,scopeKey:batch.scopeKey,
        frozenRecipients:true,frozenMemberIds:batch.memberIds,allowOrphan:true,directed:true});
      await chatInputs.complete(roomId,batch.id);chatInputBindings.delete(JSON.stringify([roomId,batch.id]));
      const recoverable=!result.created&&!chatRounds.has(roomId)&&!chatJobsFor(roomId).length
        &&result.room.turns.at(-1)?.messageId===batch.id&&(result.turns.some(t=>t.status==='pending')||result.turn.phase==='anchor'&&result.turns.length===1);
      if(!getStoreClosing()&&(result.created||recoverable))launchChatRound(result,workContext,batch.clientTime);
    }catch(error){
      if(batch&&!getStoreClosing())try{await chatInputs.fail(roomId,batch.id,['source-changed','persona-changed'].includes(error.message)?error.message:'save');}catch{/* Keep durable original words for explicit retry. */}
    }finally{chatInputDraining.delete(roomId);armChatInput(roomId);}
  }

  function chatInbox(roomId,events,scopeKey) {
    const room=chats.read(roomId);if(!room)return[];const result=[];
    for(const event of events){let ref;try{ref=JSON.parse(event.id);}catch{continue;}
      if(ref.roomId!==roomId||ref.sourceScope!==schedulerScope(room,scopeKey)||ref.generation!==(room.generation??0))continue;
      if(event.authorId==='user'){
        const committed=room.turns.find(t=>(t.scopeKey??t.contextKey??null)===scopeKey&&(t.messageId===ref.turnId||t.userParts?.some(p=>p.id===ref.turnId)));
        const part=committed?.userParts?.find(p=>p.id===ref.turnId);
        const text=part?.text??committed?.user;
        if(text)result.push({author:{role:'user',name:'我'},text,eventId:event.id,
          refs:[{roomId,generation:room.generation??0,kind:'user',messageId:part?.id??committed?.messageId??ref.turnId}]});
      }else{
        const turn=room.turns.find(t=>t.id===ref.turnId&&t.attemptId===ref.attemptId&&t.recipientId===event.authorId
          &&t.status==='ready'&&(t.scopeKey??t.contextKey??null)===scopeKey);
        if(turn)result.push({author:{role:'assistant',id:turn.recipientId,name:turn.speakerName},messages:turn.assistant,eventId:event.id,
          refs:turn.assistant.map((_,index)=>({roomId,generation:room.generation??0,kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index}))});
      }
    }
    // Whole statements only; old items remain available in the room history.
    let chars=0;return result.reverse().filter(item=>{const size=item.text?.length??item.messages.reduce((n,v)=>n+v.length,0);if(chars+size>6000)return false;chars+=size;return true;}).slice(0,12).reverse();
  }

  async function waitChatActor(roomId,personaId,attemptId,signal,kind='normal') {
    while(!signal.aborted){
      retainChatEvents(roomId);
      const slot=chatScheduler.claim(roomId,personaId,attemptId,kind);if(slot)return slot;
      const due=chatScheduler.readyAt(roomId,personaId,kind);
      if(due===null&&!chatScheduler.read(roomId,personaId)?.inFlight)throw Error('chat-cancelled');
      await new Promise((resolve,reject)=>{
        const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);reject(signal.reason);};
        const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},due===null?25:Math.max(1,due-Date.now()));
        signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
      });
    }
    throw signal.reason;
  }

  function launchChat(persona, room, turn, workContext,waitFor,round) {
    if (getStoreClosing() || turn.status !== 'pending') return;
    const key=chatJobKey(room.id,turn.attemptId);
    const peerGrantAtStart=turn.responsePlan?.kind==='peer'?chatScheduler.read(room.id,persona.id)?.peerGrant:null;
    const previous = chatJobsFor(room.id).find(job=>job.turnId===turn.id);
    if (previous?.attemptId === turn.attemptId && !previous.abort.signal.aborted) return;
    previous?.abort.abort(new Error('chat-superseded'));
    const abort = new AbortController();
    const aborted=()=>abort.abort(round.abort.signal.reason);round.abort.signal.addEventListener('abort',aborted,{once:true});if(round.abort.signal.aborted)aborted();
    if(!chats.hasMember(room.id,persona.id))abort.abort(Error('chat-member-removed'));
    const chatOptions={provider:settings.chatProvider,model:settings.chatModel,thinking:settings.chatThinking,reasoningEffort:settings.chatReasoningEffort};
    let liveRevision=0,lastLiveAt=0,progressTimer;
    const pending = { personaId: persona.id, roomId: room.id,turnId:turn.id,messageId:turn.messageId,referenceRevision:round.referenceRevision,started:!waitFor, pack: persona.pack, abort, attemptId: turn.attemptId, contextKey: workContext?.key };
    activeChats.set(key, pending);
    const publish=(status,messages=[])=>{
      if(activeChats.get(key)!==pending)return;
      const frame={instanceId,personaId:persona.id,roomId:room.id,turnId:turn.id,
        attemptId:turn.attemptId,revision:++liveRevision,status,messages};
      chatLive.publish(key,frame);
      if(status==='silent')round.silentFrames.set(persona.id,frame);
      const members=chats.liveGroup(room.id,turn.messageId,{withStatus:true});
      if(!members||status!=='silent'&&!members.some(t=>t.id===turn.id&&t.attemptId===turn.attemptId))return;
      const frames=[];
      let settled=true;
      for(const member of members){
        const cached=chatLive.read(chatJobKey(room.id,member.attemptId));
        if(cached && (member.status==='pending' || member.status===cached.status)) frames.push(cached);
        if(member.status==='pending' && (!cached || ['streaming','queued'].includes(cached.status))) settled=false;
      }
      chatLive.publish(room.id,{instanceId,roomId:room.id,frames:[...frames,...round.silentFrames.values()],
        status:settled?'settled':'streaming'});
    };
    publish(waitFor?'queued':'streaming');
    const sourceContext=roomContexts.get(room.id)??chatContext;
    return trackModelTask((async () => {
      let memoryContext,referenceUse,actorSlot;
      let outcome = 'failed';
      let timer;
      const valid = () => !getStoreClosing() && getPresets().find((p) => p.id === persona.id)?.pack === persona.pack
        && chats.hasMember(room.id,persona.id)
        && chats.matchesRound(room.id,round.referenceRevision??0)
        && (!workContext || sourceContext.key() === workContext.key);
      try {
        if(waitFor)await waitWithSignal(waitFor,abort.signal);
        abort.signal.throwIfAborted();
        if(!valid())throw Error('persona-changed');
        actorSlot=await waitChatActor(room.id,persona.id,turn.attemptId,abort.signal,turn.responsePlan?.kind==='peer'?'peer':'normal');
        const current=chats.read(room.id),position=current?.turns.findIndex(t=>t.id===turn.id&&t.attemptId===turn.attemptId);
        if(position===undefined||position<0||current.turns[position].status!=='pending')throw Error('chat-cancelled');
        const scene=roomDirectorEvents(current,turn.messageId,turn.scopeKey??turn.contextKey??null,Infinity),
          throughEvent=scene.findLast(event=>event.author.role==='user'||event.author.id!==persona.id);
        if(!throughEvent)throw Error('chat-cancelled');
        const throughRef=JSON.parse(throughEvent.id),through={turnId:throughRef.turnId,attemptId:throughRef.attemptId};
        const preceding=current.turns.filter(t=>t.messageId===turn.messageId&&t.status==='ready'
          &&(t.scopeKey??t.contextKey??null)===(turn.scopeKey??turn.contextKey??null));
        // Canonical seats preserve their owners; visual order follows actual starts.
        if(!await chats.startReply({roomId:room.id,id:turn.id,attemptId:turn.attemptId,valid:()=>valid()&&!abort.signal.aborted}))throw Error('chat-cancelled');
        pending.started=true;publish('streaming');
        timer=setTimeout(()=>abort.abort(new Error('chat-timeout')),cfg.timeoutMs);
        const route = await waitWithSignal(resolveChatRouteAsync(workContext?.primarySessionId??currentSessionHint(),chatOptions,abort.signal), abort.signal);
        if (!valid() || !route) throw new Error('chat-unavailable');
        round.model={provider:route.provider,model:route.model};
        memoryContext = expressionMemory(persona.id, room.id, turn.user, 'chat');
        const refs = entries => JSON.stringify(entries.map(({ id, version }) => [id, version]));
        const used = refs(memoryContext.entries);
        pending.hasStaleMemory = () => used !== refs(settings.memory
          ? memories.select({ personaId: persona.id, sessionId: room.id, text: turn.user, purpose: 'chat' }) : []);
        const llm = expressionLlm('chat', () => {
          pending.generating=true;
          round.timing.calls.actor++;
          memoryContext.usage?.sent();
          referenceUse?.sent();
        },{...chatOptions,beforeAttempt(){if (!valid()) throw new Error('persona-changed');}});
        if (!llm) throw new Error('chat-unavailable');
        const userImages=selectChatImages(current,turn.messageId,turn.scopeKey??turn.contextKey??null);
        const imageHead=current.turns.find(t=>t.messageId===turn.messageId&&t.userParts);
        const imagesRequired=!!imageHead?.userParts?.some(p=>p.images?.length)||userImages.some(i=>imageHead?.quote?.ref?.kind==='user'&&imageHead.quote.ref.messageId===i.messageId);
        if(userImages.length){
          const attachments=ctx.get('attachments');
          if(typeof attachments?.readImage!=='function')throw Error('chat-images-unavailable');
          for(const image of userImages){
            try{await waitWithSignal(attachments.readImage(image.attachment,abort.signal),abort.signal);}
            catch{abort.signal.throwIfAborted();throw Error('chat-images-unavailable');}
          }
        }
        const history = current.turns.filter(t => t.messageId!==turn.messageId&&(t.scopeKey??t.contextKey??null) === (turn.scopeKey??turn.contextKey??null));
        const currentMemberIds=chats.read(room.id)?.memberIds??[];
        const castMembers=currentMemberIds.map(id=>getPresets().find(p=>p.id===id)).filter(Boolean);
        const shortReply=turn.responsePlan?.kind==='peer'||turn.phase==='followup';
        const replyBudget=shortReply?{bubbles:2,chars:600}:undefined;
        let responsePlan=turn.responsePlan;
        if(responsePlan?.kind==='peer'&&!preceding.some(t=>t.recipientId===responsePlan.to&&t.assistant.some(text=>text.includes(responsePlan.evidence)))) {
          abort.abort(Error('chat-cancelled'));throw abort.signal.reason;
        }
        if(responsePlan?.kind==='contribute'&&responsePlan.to!=='user'&&!preceding.some(t=>t.recipientId===responsePlan.to))responsePlan={...responsePlan,to:'user'};
        ensureChatProfile();
        const { system, messages:requestMessages, control:supplied } = buildChatPrompt({ pack: persona.pack, history, message: turn.user,
          persona:{id:persona.id,builtin:persona.builtin===true},
          userAddress:chatProfile.read().userAddress,
          userGender:chatProfile.read().userGender,
          currentTurn:current.turns.find(t=>t.messageId===turn.messageId&&t.phase==='anchor')??turn,
          scopeKey:turn.scopeKey??turn.contextKey??null,
          scene:projectChatScene(chats.read(room.id),{messageId:turn.messageId,scopeKey:turn.scopeKey??turn.contextKey??null,referenceRevision:round.referenceRevision??0}),
          responsePlan,
          directorAssignment:round.directive?.id===persona.id?round.directive:undefined,
          supportResult:round.supportSourcesCurrent?.()===false ||
            round.supportWorkIds?.some(id => !round.coordination?.sourceIds?.includes(id)) ? undefined : round.supportArtifact,
          sceneDirection:round.directive?.id===persona.id&&round.directive.sceneDirection&&round.replyTarget?.ref?{
            text:round.directive.sceneDirection,roomId:room.id,generation:current.generation??0,scopeKey:turn.scopeKey??turn.contextKey??null,
            messageId:turn.messageId,actorId:persona.id,sourceRef:round.replyTarget.ref}:undefined,
          replyTarget:round.replyTarget,
          opportunity:{kind:actorSlot.kind,normalRemainingAfterThis:actorSlot.normalRemainingAfterThis,peerRemainingAfterThis:actorSlot.peerRemainingAfterThis},
          inbox:chatInbox(room.id,actorSlot.events,turn.scopeKey??turn.contextKey??null),
          assignment:chatAssignment(turn,publicChatExchange(preceding)),discussionState:discussionContext(current,turn.scopeKey??turn.contextKey??null),
          exchange:preceding,phase:turn.phase,replyBudget,roomId:room.id,generation:current.generation??0,excluded:current.excludedReferences??[],
          quotedMessage:current.turns.find(t=>t.messageId===turn.messageId&&t.quote)?.quote,
          cast:roomCharacterContext(persona,castMembers),
          memory: memoryContext.entries.filter(e => !personalChatMemory(e)).map(e => e.content),
          personalContext: memoryContext.entries.filter(personalChatMemory)
            .map(({kind, content, occurredAt, createdAt}) => ({kind, content, when:relativeDay(occurredAt ?? createdAt, round.timeContext),
              timeBasis:occurredAt == null ? '记录时间' : '发生时间'})), workContext,coordination:round.coordination,timeContext:round.timeContext,
          speaker:{id:persona.id,name:persona.name},recipients:turn.recipients,participants:castMembers.map(({id,name})=>({id,name})) });
        // A removed/excluded target is not permission to answer a different
        // message. Exact directed plans must reach the actor with that pointer.
        if(responsePlan?.sourceRef&&!supplied.replyTarget)throw Error('chat-invalid');
        referenceUse=chatReferenceUsage.begin({roomId:room.id,personaId:persona.id,messageId:turn.messageId,attemptId:turn.attemptId,
          scopeKey:turn.scopeKey??turn.contextKey??null,work:workContext?.sources??[],omitted:workContext?.omitted??[],
          notes:supplied.roomNotes.map(n=>n.ref),quote:supplied.quotedMessage?.ref,memory:memoryContext.entries,
          memoryEnabled:settings.memory===true,historyCount:supplied.historyCount,assignment:supplied.assignment,
          coordination:round.coordination?{work:round.coordination.work,request:round.coordination.request,basis:round.coordination.basis,selectedSourceIds:round.coordination.sourceIds}:null,
          discussion:(supplied.discussionState??[]).map(({id,version})=>({id,version}))});
        let wire = '', finish;
        const preview=()=>{
          const messages=partialChatReply(wire,replyBudget);if(!replyBudget)return messages;
          const allowed=[];let chars=0;
          for(const message of messages){
            if(allowed.length>=replyBudget.bubbles||chars+message.text.length>replyBudget.chars)break;
            allowed.push(message);chars+=message.text.length;
          }
          return allowed;
        };
        for await (const chunk of streamWithSignal(llm, { provider: route.provider, model: route.model, system,
          messages: appendChatImages(requestMessages,userImages),imageInputRequired:imagesRequired, maxTokens: chatOptions.thinking?(shortReply?4096:8192):(shortReply?768:2048), signal: abort.signal })) {
          if (!valid()) throw new Error('persona-changed');
          if (chunk.type === 'error') throw chunk.error ?? chunk.failure ?? new Error('chat-model-error');
          if (chunk.type.startsWith('tool-call')
            || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
            || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) throw new Error('chat-invalid');
          if (chunk.type === 'text-delta') {wire += chunk.text;
            if(chunk.text)round.timing.firstText??=Math.max(0,Date.now()-round.startedAt);
            if(wire.length>24000)throw Error('chat-too-long');
            if(!progressTimer){const delay=Math.max(0,40-(Date.now()-lastLiveAt));
              if(!delay){publish('streaming',preview());lastLiveAt=Date.now();}
              else progressTimer=setTimeout(()=>{progressTimer=undefined;if(valid()&&!abort.signal.aborted){publish('streaming',preview());lastLiveAt=Date.now();}},delay);
            }}
          if (wire.length > 24000) throw new Error('chat-too-long');
          if (chunk.type === 'finish') {
            finish = chunk.reason?.kind;
            if (finish === 'error') throw chunk.reason.failure ?? new Error('chat-model-error');
          }
        }
        pending.generating=false;clearTimeout(progressTimer);progressTimer=undefined;
        abort.signal.throwIfAborted();
        if (!valid() || finish !== 'stop') throw new Error(finish === 'max-tokens' ? 'chat-length' : 'chat-incomplete');
        const decision = parseChatDecision(wire,replyBudget);
        if (!decision) { outcome = 'rejected'; throw new Error('chat-format'); }
        if(decision.kind==='silent'){
          let applied;
          try{applied=await chats.declineReply({roomId:room.id,id:turn.id,attemptId:turn.attemptId,epoch:round.epoch,
              scopeKey:turn.scopeKey??turn.contextKey??null,referenceRevision:round.referenceRevision??0,through,
              valid:()=>valid()&&!abort.signal.aborted});}
          catch{
            if(!valid()&&!abort.signal.aborted)abort.abort(Error('chat-cancelled'));
            abort.signal.throwIfAborted();throw Error('chat-save-failed');
          }
          if(!valid()&&!abort.signal.aborted)abort.abort(Error('chat-cancelled'));
          abort.signal.throwIfAborted();
          if(!applied)throw Error('chat-save-failed');
          outcome='silent';retainChatEvents(room.id);publish('silent');return{outcome};
        }
        const messages=decision.messages;
        if(replyBudget&&(messages.length>replyBudget.bubbles||messages.join('').length>replyBudget.chars)){
          outcome='rejected';throw Error('chat-too-long');
        }
        const applied = await chats.finish({ personaId: persona.id, roomId: room.id, id: turn.id,
          attemptId: turn.attemptId, status: 'ready', messages, valid: () => valid() && !abort.signal.aborted });
        if(!applied){abort.signal.throwIfAborted();throw Error('chat-cancelled');}
        outcome = 'generated';
        const committed=chats.read(room.id),event=roomDirectorEvents(committed,turn.messageId,turn.scopeKey??turn.contextKey??null,Infinity)
          .find(value=>value.id===chatSchedulerEventKey({roomId:room.id,generation:committed.generation??0,
            sourceScope:schedulerScope(committed,turn.scopeKey??turn.contextKey??null),turnId:turn.id,attemptId:turn.attemptId}));
        if(event)publishDirectorEvent(room.id,event,turn.messageId);
        retainChatEvents(room.id);
        publish('ready',messages.map(text=>({text,complete:true})));
      } catch (error) {
        const failure = chatFailure(error, abort.signal);
        if ((abort.signal.aborted && failure !== 'timeout') || error?.message==='chat-cancelled') outcome = 'cancelled';
        if (!getStoreClosing()) try {
          await chats.finish({ personaId: persona.id, roomId: room.id, id: turn.id, attemptId: turn.attemptId,
            status: outcome === 'cancelled' ? 'cancelled' : 'failed', failure,
            valid:()=>chats.acceptsEpoch(room.id,round.epoch) });
        } catch (error) { warn('chat result persist failed', error); }
        publish(outcome==='cancelled'?'cancelled':'failed');
        if(failure==='vision'||failure==='image-unavailable')round.abort.abort(Error('chat-vision-unavailable'));
      } finally {
        if(actorSlot){
          if(outcome==='silent')chatScheduler.abstain(room.id,persona.id,actorSlot.token);
          else chatScheduler.finish(room.id,persona.id,actorSlot.token,{success:outcome==='generated',responseId:turn.attemptId,completedAt:chats.read(room.id)?.turns.find(t=>t.id===turn.id&&t.attemptId===turn.attemptId)?.completedAt??Date.now()});
        }else if(peerGrantAtStart)chatScheduler.revokePeer(room.id,persona.id,peerGrantAtStart);
        if (!['silent','generated'].includes(outcome)) round.timingFailed=true;
        memoryContext?.usage?.finish(outcome);
        referenceUse?.finish(outcome);
        clearTimeout(progressTimer);
        clearTimeout(timer); abort.abort();
        round.abort.signal.removeEventListener('abort',aborted);
        if (activeChats.get(key) === pending) activeChats.delete(key);
      }
      return{outcome};
    })());
  }

  function roomDirectorEvents(room,messageId,scopeKey,limit=14000){
    const all=room.turns.filter(t=>t.messageId===messageId),group=all.filter(t=>(t.scopeKey??t.contextKey??null)===scopeKey),head=all.find(t=>t.phase==='anchor')??all[0];
    if(!head)return[];
    const key=t=>chatSchedulerEventKey({roomId:room.id,generation:room.generation??0,sourceScope:schedulerScope(room,scopeKey),turnId:t.id,attemptId:t.phase==='anchor'?'user':t.attemptId});
    const rows=[{id:key(head),author:{role:'user',name:'我'},messages:head.userParts?.map(p=>p.text)??[head.user],recipients:head.recipients}];
    for(const turn of group.filter(t=>t.phase!=='anchor'&&t.status==='ready'&&t.assistant.length).sort((a,b)=>(a.emittedOrder??0)-(b.emittedOrder??0))){
      const source=directedSource(room,rows,turn.responsePlan,scopeKey);
      rows.push({id:key(turn),author:{role:'assistant',id:turn.recipientId,name:turn.speakerName},messages:turn.assistant,
        ...(source?{replyTo:{to:turn.responsePlan.to,eventId:source.event.id,index:source.index}}:{})});
    }
    return directorEvents(rows,limit);
  }

  function publishDirectorEvent(roomId,event,userTurnId){
    chatScheduler.publish(roomId,{id:event.id,authorId:event.author.role==='user'?'user':event.author.id,
      userTurnId,messageCount:event.messages.length,...(event.replyTo?{replyTo:event.replyTo}:{})});
  }

  function directorContributions(room,events,scopeKey){
    const result=[];
    for(const event of events){
      if(event.author.role!=='assistant')continue;
      const key=JSON.parse(event.id),turn=room.turns.find(value=>value.id===key.turnId&&value.attemptId===key.attemptId);
      if(!turn||turn.status!=='ready'||!turn.assistant.length||(turn.scopeKey??turn.contextKey??null)!==scopeKey)continue;
      const contribution=normalizeChatContribution(turn.responsePlan?.contribution);
      if(contribution)result.push({eventId:event.id,contribution});
    }
    return result;
  }

  function directorQuote(room,event,index,scopeKey){
    const key=JSON.parse(event.id),turn=room.turns.find(value=>value.id===key.turnId&&
      (value.phase==='anchor'?key.attemptId==='user':value.attemptId===key.attemptId));
    if(!turn)return undefined;
    // A confirmed single-seat retry may change its work-reference scope. Its
    // original user anchor stays the same public instruction; old peer replies
    // remain subject to their own scope and are never brought across with it.
    const proof=event.author.role==='user'&&(turn.scopeKey??turn.contextKey??null)!==scopeKey
      ?{...room,turns:room.turns.map(value=>value===turn?{...turn,scopeKey}:value)}:room;
    return resolveChatQuote(proof,event.author.role==='user'?{roomId:room.id,generation:room.generation??0,kind:'user',
      messageId:turn.userParts?.[index]?.id??turn.messageId}:{roomId:room.id,generation:room.generation??0,kind:'assistant',
      turnId:turn.id,attemptId:turn.attemptId,index},scopeKey);
  }

  function directedSource(room,events,plan,scopeKey){
    if(typeof plan?.evidence!=='string'||!plan.evidence.trim())return undefined;
    const expected=plan.sourceRef===undefined?undefined:quoteKey(plan.sourceRef);
    if(expected===null)return undefined;
    const matches=[];
    for(const event of events){
      if(!(plan.to==='user'?event.author.role==='user':event.author.id===plan.to))continue;
      for(let index=0;index<event.messages.length;index++){
        if(!event.messages[index].includes(plan.evidence))continue;
        const quote=directorQuote(room,event,index,scopeKey);
        if(quote&&(expected===undefined||quoteKey(quote.ref)===expected))matches.push({event,index,quote});
      }
    }
    // An old literal-only plan is usable only when its original location is
    // unique. Identical text from a later turn must never silently rebind it.
    return matches.length===1?matches[0]:undefined;
  }

  function launchChatRound(result,workContext,clientTime) {
    const room=result.room,messageId=result.turn.messageId,original=room.turns.find(t=>t.messageId===messageId);
    const summaryRequested=original.userParts?.some(part=>part.summarize===true)===true;
    const scopeKey=result.turn.scopeKey??result.turn.contextKey??null,startedAt=Date.now(),abort=new AbortController();
    const round={id:randomUUID(),roomId:room.id,messageId,abort,stage:'preparing',startedAt,epoch:chats.epoch(),
      timing:{path:'director',contextDone:null,directorDone:null,firstText:null,done:null,calls:{director:0,context:0,actor:0,support:0}},
      referenceRevision:room.referenceRevision??0,contextKey:workContext?.key,timeContext:createChatTimeContext(clientTime,startedAt),
      attempts:new Set(),silentFrames:new Map(),members:getPresets().filter(p=>original.memberIdsAtSend.includes(p.id)&&room.memberIds.includes(p.id)),
      selected:original.recipients.map(p=>p.id),disabled:new Set(room.turns.filter(t=>t.messageId===messageId&&['failed','cancelled'].includes(t.status)).map(t=>t.recipientId))};
    chatRounds.get(room.id)?.abort.abort(Error('chat-superseded'));chatRounds.set(room.id,round);chatDirectorFailures.delete(room.id);
    const source=roomContexts.get(room.id)??chatContext;
    const valid=()=>!getStoreClosing()&&!abort.signal.aborted&&chatRounds.get(room.id)===round&&chats.acceptsEpoch(room.id,round.epoch)
      &&chats.matchesRound(room.id,round.referenceRevision??0,messageId)&&(!workContext||source.key()===workContext.key);
    chatScheduler.register(room.id,original.memberIdsAtSend,{generation:room.generation??0,sourceScope:schedulerScope(room,scopeKey)});
    if(result.created&&result.turn.phase==='anchor')chatScheduler.reset(room.id,messageId,round.selected);
    else if(chatScheduler.read(room.id,original.memberIdsAtSend[0])?.userTurnId!==messageId){
      // A restored cycle may straddle a wall-clock correction. Preserve its spent opportunities.
      const at=Math.min(original.at,startedAt);
      chatScheduler.restoreCycle(room.id,{
        userTurnId:messageId,recipients:round.selected,at,
        responses:room.turns.filter(t=>t.messageId===messageId&&t.phase!=='anchor'&&t.status==='ready').map(t=>({
          id:t.attemptId,personaId:t.recipientId,kind:t.responsePlan?.kind==='peer'?'peer':'normal',completedAt:Math.max(at,Math.min(t.completedAt??t.at,startedAt))}))});
    }
    for(const id of original.memberIdsAtSend)if(!room.memberIds.includes(id))chatScheduler.removeMember(room.id,id);
    const present=()=>round.members.filter(p=>chats.hasMember(room.id,p.id)&&getPresets().find(v=>v.id===p.id)?.pack===p.pack);
    const history=()=>chats.read(room.id).turns.filter(t=>t.messageId!==messageId&&(t.scopeKey??t.contextKey??null)===scopeKey);
    const refresh=()=>{
      const current=chats.read(room.id),events=roomDirectorEvents(current,messageId,scopeKey);
      for(const event of events)publishDirectorEvent(room.id,event,messageId);
      retainChatEvents(room.id);return events;
    };
    const wait=ms=>new Promise(resolve=>{
      const wake=()=>{clearTimeout(timer);abort.signal.removeEventListener('abort',wake);if(round.wake===wake)delete round.wake;resolve();};
      const timer=setTimeout(wake,Math.max(0,ms));round.wake=wake;abort.signal.addEventListener('abort',wake,{once:true});if(abort.signal.aborted)wake();
    });
    const timer=setTimeout(()=>abort.abort(Error('chat-timeout')),Math.max(120000,Math.min(600000,cfg.timeoutMs*32)));
    void trackModelTask((async()=>{
      let lastDecision=chatDirectorClocks.get(room.id)??-Infinity,decisions=0;const checked=new Set();
      try{
        // Explicit retries consume the existing cycle; they never reset its locks.
        if(result.turn.phase!=='anchor'&&result.turn.status==='pending'){
          const turn=result.turn,person=present().find(p=>p.id===turn.recipientId);round.disabled.delete(turn.recipientId);
          round.attempts.add(turn.attemptId);
          if(person){
            refresh();
            const retryTimeline=roomDirectorEvents(chats.read(room.id),messageId,scopeKey,Infinity);
            // Retry authority uses the exact durable source, even when the
            // director's smaller reading window omitted its older long bubble.
            for(const event of retryTimeline)publishDirectorEvent(room.id,event,messageId);
            const retrySource=directedSource(chats.read(room.id),retryTimeline,turn.responsePlan,scopeKey);
            let authorized=turn.responsePlan?.to==='user'||!!retrySource;
            if(turn.responsePlan?.kind==='peer'){
              const event=retrySource?.event;
              // An older failed seat may only have mentioned this member. It
              // cannot borrow an invitation from a different bubble on retry.
              const grant=chatScheduler.read(room.id,person.id)?.peerGrant;
              authorized=!!event&&possiblePeerCall(person,event,present(),{index:retrySource.index,evidence:turn.responsePlan.evidence})&&
                (grant ? grant.sourceEventId===event.id&&grant.fromId===event.author.id
                  : chatScheduler.grantPeer(room.id,person.id,{sourceEventId:event.id,fromId:event.author.id,evidence:turn.responsePlan.evidence}));
            }
            if(!authorized){
              await chats.finish({roomId:room.id,personaId:person.id,id:turn.id,attemptId:turn.attemptId,status:'failed',failure:'source-changed',valid});
              return;
            }
            const contribution=normalizeChatContribution(turn.responsePlan?.contribution);
            round.directive={id:person.id,kind:turn.responsePlan?.kind==='peer'?'peer':'normal',to:turn.responsePlan?.to??'user',
              goal:contribution?.point??'完成这次未成功的回应，保持原话与回应对象，不重复已完成的其他发言。',...(contribution?{contribution}:{})};
            round.replyTarget=retrySource?.quote;
            round.stage='speaking';
            const reply=await launchChat(person,chats.read(room.id),turn,workContext,undefined,round);
            if(reply?.outcome!=='silent'&&chats.read(room.id)?.turns.find(t=>t.id===turn.id)?.status!=='ready')round.disabled.add(person.id);
          }else return;
          // Confirmation authorizes this failed seat against the new reference
          // scope, not a fresh continuation of the old scope's user cycle.
          if((original.scopeKey??original.contextKey??null)!==scopeKey)return;
        }
        while(valid()&&decisions<1+CHAT_LIMITS.members+2*CHAT_LIMITS.roundReplies){
          if(chatInputs.peek(room.id))break;
          const current=chats.read(room.id),group=current.turns.filter(t=>t.messageId===messageId&&t.phase!=='anchor');
          if(group.length>=CHAT_LIMITS.roundReplies)break;
          const events=refresh(),timeline=roomDirectorEvents(current,messageId,scopeKey,Infinity),visibleIds=new Set(events.map(e=>e.id));
          const members=present(),now=Date.now(),cooldowns=new Map(),addressed=new Set();
          const followup=group.some(turn=>turn.status==='ready');
          const userEvent=events.findLast(e=>e.author.role==='user');
          const mentioned=new Set(followup?userMentions(userEvent,members,original.recipients).map(mention=>mention.id):[]);
          const states=members.map(person=>{
            const state=chatScheduler.read(room.id,person.id),normalAt=chatScheduler.readyAt(room.id,person.id,'normal');
            // A completed response consumes the timeline it saw. Grade changes,
            // cooldowns and restarts cannot turn that same original line into a
            // fresh invitation. A genuinely new peer statement can still reopen
            // a natural return, using the actor's remaining independent budget.
            const lastOwn=timeline.findLastIndex(e=>e.author.role==='assistant'&&e.author.id===person.id);
            const silence=current.silences?.find(value=>value.personaId===person.id&&value.messageId===messageId
              &&value.scopeKey===scopeKey&&value.referenceRevision===(current.referenceRevision??0));
            const silenceKey=silence?chatSchedulerEventKey({roomId:room.id,generation:current.generation??0,sourceScope:schedulerScope(current,scopeKey),...silence.through}):null;
            const lastSeen=silenceKey?timeline.findIndex(e=>e.id===silenceKey):-1,
              unread=timeline.slice(Math.max(lastOwn,lastSeen)+1).filter(e=>visibleIds.has(e.id)&&(e.author.role==='user'||e.author.id!==person.id)),
              pendingEventIds=unread.map(e=>e.id),normalPendingEventIds=(state?.normalPendingEventIds??[]).filter(id=>pendingEventIds.includes(id));
            const available=!!state&&!state.inFlight&&!round.disabled.has(person.id);
            const normalDue=available&&normalPendingEventIds.length?normalAt:null;
            const peerCall=available&&state.peerRemaining===1&&unread.some(e=>possiblePeerCall(person,e,members));
            const peerDue=peerCall?state.nextEligibleAt:null;
            const due=Math.min(normalDue??Infinity,peerDue??Infinity);
            if(Number.isFinite(due)&&due>now)cooldowns.set(person.id,due);
            if(followup&&(peerCall||(mentioned.has(person.id)&&normalDue!==null&&normalPendingEventIds.includes(userEvent?.id))))addressed.add(person.id);
            return{id:person.id,level:state?.level??3,normalRemaining:state?.normalRemaining??0,peerRemaining:state?.peerRemaining??0,
              spokenCount:timeline.filter(e=>e.author.role==='assistant'&&e.author.id===person.id).length,
              pendingEventIds,normalPendingEventIds,normalReady:normalDue!==null&&normalDue<=now,peerReady:peerDue!==null&&peerDue<=now,
              availability:due===Infinity?'done':due<=now?'ready':'cooling'};
          });
          const signature=JSON.stringify([events.map(e=>e.id),states]);
          const eligible=states.some(s=>s.normalReady||s.peerReady);
          // Let an explicitly addressed listener appear in the first follow-up ballot.
          // Wait locally before asking the model, so an actual WAIT is always final.
          const allAddressedCooling=addressed.size>0&&[...addressed].every(id=>cooldowns.has(id));
          if(!eligible||checked.has(signature)||allAddressedCooling){
            const deadlines=allAddressedCooling?[...addressed].map(id=>cooldowns.get(id)):[...cooldowns.values()];
            if(!deadlines.length)break;
            round.stage='listening';await wait(Math.max(Math.min(...deadlines),lastDecision+chatIntervalMs)-Date.now());continue;
          }
          const sources=workContext?.key&&source.active()?source.selection(workContext.key).sources:[];
          const supportUsed=chatSupport.find({...supportScope(current),messageId});
          const explicit=explicitContextSelection(original.user);
          const wantsSummary=summaryRequested&&!supportUsed&&!explicit;
          const manualSummary=wantsSummary&&sources.length>0&&chats.active()===room.id;
          const supportTemplates=!supportUsed&&!manualSummary&&chats.active()===room.id&&source.active()
            ? [...(settings.chatResearchEnabled&&typeof ctx.get('web')?.search==='function'?['research']:[]),
              ...(settings.chatDeepReasoningEnabled?['reason']:[]),
              ...(settings.chatSummarizeEnabled&&!explicit&&sources.length?['summarize']:[])] : [];
          const directorOptions={requestLocal:true,phase:followup?'followup':'opening',supportTemplates,summaryRequested:manualSummary,message:original.user,recipients:original.recipients,members,states,events,
            imageCount:original.userParts?.reduce((n,p)=>n+(p.images?.length??0),0)??0,
            contributions:directorContributions(current,events,scopeKey),
            sources,sourceIds:sources.map(s=>s.id),history:history(),quotedMessage:original.quote,referenceSelection:round.coordination,
            sceneCatalog:buildChatSceneCatalog(current,{messageId,scopeKey,referenceRevision:round.referenceRevision??0})};
          const {system,user,choices,userEventId,parse}=buildDirectorRequest(directorOptions);
          if (!choices.length) { checked.add(signature); continue; }
          const simpleOpening = result.created && result.turn.phase === 'anchor' && decisions === 0 && !group.length
            && !original.quote && !explicit
            && !directorOptions.imageCount && (original.userParts?.length ?? 1) === 1
            && !sources.length && !current.sources?.length && !workContext?.primarySessionId
            && !summaryRequested && !supportUsed && !supportTemplates.length && !directorOptions.sceneCatalog.current
            && !directorOptions.history.some(turn=>turn.scene && turn.scene.relation!=='fresh');
          const solo=original.memberIdsAtSend.length===1 && members.length===1;
          const targetId=solo ? members[0].id : original.recipients.length===1 ? original.recipients[0].id : null;
          const openingChoice=simpleOpening && choices.find(c=>c.id===targetId && c.kind==='normal' && c.to==='user' && c.eventId===userEventId);
          let decision;
          if (openingChoice) {
            round.timing.path=solo?'direct':'directed';
            decision = parse(openingChoice.choiceId);
            checked.add(signature);
            decisions++;
          } else {
            const delay=lastDecision+chatIntervalMs-Date.now();if(delay>0){round.stage='listening';await wait(delay);continue;}
            checked.add(signature);lastDecision=Date.now();chatDirectorClocks.set(room.id,lastDecision);decisions++;
            const selectingSources = sources.length > 0 && !explicit && !round.coordination;
            if (selectingSources && round.timing.path !== 'support') round.timing.path = 'context';
            round.stage=group.length?'listening':'preparing';
            const controller=new AbortController(),stop=()=>controller.abort(abort.signal.reason);
            abort.signal.addEventListener('abort',stop,{once:true});if(abort.signal.aborted)stop();
            const deadline=setTimeout(()=>controller.abort(Error('chat-director-timeout')),cfg.timeoutMs);
            let finish,failureReason;
            try{
              const options={provider:settings.chatProvider,model:settings.chatModel,thinking:false};
              const route=await waitWithSignal(resolveChatRouteAsync(workContext?.primarySessionId??currentSessionHint(),options,controller.signal),controller.signal);
              if(!route||!valid())throw Error('chat-unavailable');round.model=route;
              const llm=expressionLlm('chat-participation',()=>{
                round.timing.calls.director++;
                round.listeningMemberIds=states.filter(s=>s.normalReady||s.peerReady).map(s=>s.id);},
                {...options,beforeAttempt(){if(!valid()||controller.signal.aborted)throw Error('chat-cancelled');}});
              if(!llm)throw Error('chat-unavailable');let wire='';
              lastDecision=Date.now();chatDirectorClocks.set(room.id,lastDecision);
              for await(const chunk of streamWithSignal(llm,{...route,system,messages:[{role:'user',content:[{type:'text',text:user}]}],maxTokens:2048,signal:controller.signal})){
                if(chunk.type==='error')throw Error('chat-director-model-error');
                if(chunk.type.startsWith('tool-call')||(chunk.type==='block-start'&&chunk.blockType==='tool-call')||(chunk.type==='block-end'&&chunk.block?.type==='tool-call')){
                  failureReason='tool-call';throw Error('chat-director-invalid');
                }
                if(chunk.type==='text-delta')wire+=chunk.text;
                if(wire.length>20000){failureReason='too-long';throw Error('chat-director-invalid');}
                if(chunk.type==='finish')finish=chunk.reason?.kind;
              }
              round.listeningMemberIds=[];controller.signal.throwIfAborted();if(!valid())return;
              decision=finish==='stop'?parse(wire):{basis:'invalid',reason:'non-stop'};
              round.timing.directorDone??=Math.max(0,Date.now()-startedAt);
              if(decision.basis!=='model'){
                failureReason=DIRECTOR_REASONS.has(decision.reason)?decision.reason:'shape';throw Error('chat-director-invalid');
              }
              if(decision.sceneKey!==undefined){
                const scene=selectChatScene(chats.read(room.id),{messageId,scopeKey,referenceRevision:round.referenceRevision??0,key:decision.sceneKey});
                if(!scene){failureReason='scene';throw Error('chat-director-invalid');}
                const applied=await waitWithSignal(chats.setScene({roomId:room.id,messageId,scene,scopeKey,referenceRevision:round.referenceRevision??0,
                  epoch:round.epoch,valid:()=>valid()&&!controller.signal.aborted}),controller.signal);
                if(!valid())return;
                if(!applied)throw Error('chat-scene-save-failed');
              }
              getDiagnostics().chatDirector={at:Date.now(),roomId:room.id,messageId,status:'accepted',finish:'stop'};
            }catch(error){if(valid()){
              const code=controller.signal.reason?.message==='chat-director-timeout'?'timeout':error.message==='chat-director-invalid'?'invalid':'unavailable';
              const issue={messageId,code,...(code==='invalid'&&DIRECTOR_REASONS.has(failureReason)?{reason:failureReason}:{}),
                finish:finish===undefined?'missing':DIRECTOR_FINISHES.has(finish)?finish:'other'};
              chatDirectorFailures.set(room.id,issue);
              // Keep stable categories only. Provider output and conversation text
              // never enter diagnostics, memory or the usage ledger.
              getDiagnostics().chatDirector={at:Date.now(),roomId:room.id,status:'failed',...issue};
            }return;}
            finally{round.listeningMemberIds=[];clearTimeout(deadline);abort.signal.removeEventListener('abort',stop);controller.abort();}
          }
          if(!valid()||chatInputs.peek(room.id))break;
          if (manualSummary && (!decision.next || decision.next.kind !== 'normal' || decision.next.to !== 'user')) {
            const direct = choices.filter(choice => choice.kind === 'normal' && choice.to === 'user' && choice.eventId === userEventId);
            const fallback = original.recipients.length
              ? original.recipients.map(recipient => direct.find(choice => choice.id === recipient.id)).find(Boolean) : direct[0];
            if (fallback) {
              const accepted = parse(fallback.choiceId);
              if (accepted.next) decision = { ...decision, next: accepted.next, waitForUser: false };
            }
          }
          if (wantsSummary && (!manualSummary || !decision.next || decision.next.kind !== 'normal' || decision.next.to !== 'user')) {
            chatDirectorFailures.set(room.id,{messageId,code:manualSummary?'summary-actor-unavailable':'summary-reference-unavailable'});
          }
          round.coordination=explicit??(decision.context.basis==='omitted'&&round.coordination?round.coordination:decision.context);
          // A decision with no actor or no selected sources needs no source capture.
          if (round.timing.path === 'context' && (!decision.next || (round.coordination.work !== 'required' && !manualSummary))) {
            round.timing.contextDone ??= Math.max(0, Date.now() - startedAt);
          }
          if(!decision.next){if(decision.waitForUser===true)break;continue;}
          const action=decision.next,person=members.find(p=>p.id===action.id);
          if(!manualSummary&&round.coordination.work!=='required'&&directedOpinionHandback(directorOptions,action))break;
          const directSummary=manualSummary&&action.kind==='normal'&&action.to==='user';
          const helper=directSummary?{template:'summarize',goal:'整理与当前问题有关的工作会话原文'}:action.support;
          if(directSummary&&round.coordination.work!=='required'){
            const primary=sources.find(s=>s.primary)??sources[0];
            round.coordination={work:'required',sourceIds:[primary.id],request:round.coordination.request,basis:'explicit'};
          }
          const targetEvent=events.find(event=>event.id===action.evidence.eventId);
          round.replyTarget=directorQuote(chats.read(room.id),targetEvent,action.evidence.index,scopeKey);
          let preparationGrant;
          if(action.kind==='peer'){
            const grant=chatScheduler.read(room.id,person.id)?.peerGrant;
            if(!grant&&!chatScheduler.grantPeer(room.id,person.id,{sourceEventId:action.evidence.eventId,fromId:action.to,evidence:action.evidence.text}))continue;
            if(grant&&(grant.sourceEventId!==action.evidence.eventId||grant.fromId!==action.to))continue;
            preparationGrant=chatScheduler.read(room.id,person.id)?.peerGrant;
          }
          try{
          const ids=round.coordination.work==='required'?round.coordination.sourceIds:[];
          if(workContext?.key){
            if(source.active()){
              if(ids.length)await waitWithSignal(source.prepareCapture(workContext.key,{sourceIds:ids}),abort.signal);
              if(!valid())return;workContext={...source.capture(workContext.key,{sourceIds:ids,question:original.user}),sourceCatalog:source.selection(workContext.key).sources,scopeKey};
            }else{workContext={...workContext,sources:[],omitted:ids.length?[{name:'已接入的工作参考',reason:'inactive'}]:[]};if(ids.length)round.coordination={...contextSelectionFallback('unavailable'),request:round.coordination.request};}
          }
          if (round.timing.path === 'context') round.timing.contextDone ??= Math.max(0, Date.now() - startedAt);
          if(helper){
            round.timing.path='support';
            if(targetEvent?.author?.role!=='user')throw Error('chat-invalid');
            round.stage='support';
            const snapshot=chats.read(room.id),scope=supportScope(snapshot);
            const isSummary=helper.template==='summarize';
            const captureOptions={sourceIds:ids,question:original.user};
            const summarySources=isSummary&&ids.length&&source.active()
              ? source.capture(workContext.key,{...captureOptions,forSummary:true}).sources.filter(entry=>source.resolveReference(entry)) : [];
            const summaryCurrent=()=>source.active()&&summarySources.every(entry=>source.resolveReference(entry));
            round.supportArtifact=await chatSupport.start({...scope,messageId,actorId:person.id,actorName:person.name,
              template:helper.template,goal:helper.goal,question:original.user,...(directSummary?{explicit:true}:{}),
              context:isSummary?JSON.stringify(supportSummaryContext(summarySources)):helper.template==='reason'?supportReasonContext(snapshot,original,workContext?.sources):''},
              {signal:abort.signal,valid:()=>valid()&&chats.hasMember(room.id,person.id)&&getPresets().some(p=>p.id===person.id&&p.pack===person.pack)
                &&(directSummary||settings[CHAT_SUPPORT_SETTINGS[helper.template]]===true)
                &&(!isSummary||!summarySources.length||summaryCurrent())});
            if(!valid()||chatInputs.peek(room.id))break;
            if(isSummary){
              round.supportWorkIds=ids;
              round.supportSourcesCurrent=summarySources.length?summaryCurrent:undefined;
              if(summarySources.length&&!summaryCurrent()){
                if(source.active())await waitWithSignal(source.prepareCapture(workContext.key,{sourceIds:ids}),abort.signal);
                if(!valid())return;
                workContext=source.active()
                  ? {...source.capture(workContext.key,captureOptions),sourceCatalog:source.selection(workContext.key).sources,scopeKey}
                  : {...workContext,sources:[],omitted:[{name:'已接入的工作参考',reason:'inactive'}]};
              }
            }
          }
          const state=chats.read(room.id),added=await chats.appendDirectedReply({roomId:room.id,messageId,planId:round.id+':'+decisions,
            actor:{id:person.id,name:person.name},responsePlan:{kind:action.kind,to:action.to,evidence:action.evidence.text,
              ...(action.contribution?{contribution:action.contribution}:{}),
              ...(round.replyTarget?.ref?{sourceRef:round.replyTarget.ref}:{})},
            attempts:state.turns.filter(t=>t.messageId===messageId).map(t=>({id:t.id,attemptId:t.attemptId})),members,
            epoch:round.epoch,contextKey:workContext?.key??null,scopeKey,valid});
          if(!added.created)continue;
          round.attempts.add(added.turn.attemptId);
          if(!valid())continue;
          round.directive=action;round.stage='speaking';
          const reply=await launchChat(person,added.room,added.turn,workContext,undefined,round);
          if(reply?.outcome!=='silent'&&chats.read(room.id)?.turns.find(t=>t.id===added.turn.id)?.status!=='ready')round.disabled.add(person.id);
          }finally{if(preparationGrant)chatScheduler.revokePeer(room.id,person.id,preparationGrant);}
        }
      }catch(error){if(valid())chatDirectorFailures.set(room.id,{messageId,code:'unavailable'});}
      finally{
        clearTimeout(timer);
        if(valid()&&!round.timingFailed&&chatDirectorFailures.get(room.id)?.messageId!==messageId)round.timing.done=Math.max(0,Date.now()-startedAt);
        chatTiming.record({...round.timing,at:startedAt});
        if(!getStoreClosing()){const pending=chats.read(room.id)?.turns.filter(t=>t.messageId===messageId&&t.status==='pending'&&round.attempts.has(t.attemptId))??[];
          if(pending.length)try{await chats.cancel({roomId:room.id,id:pending[0].id,attemptId:pending[0].attemptId,messageId,
            attempts:pending.map(t=>({id:t.id,attemptId:t.attemptId})),epoch:round.epoch});}catch{/* Retired generation. */}}
        if(chatRounds.get(room.id)===round)chatRounds.delete(room.id);armChatInput(room.id);
      }
    })());
  }

  return {
    retireOldRoomReferences, retireInvalidWorkDrafts, retireChatInputRuntime, launchChatRound,
    armChatInput,
  };
}
