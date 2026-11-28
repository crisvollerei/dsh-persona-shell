    const chatUpdates = new Set();
    const chatProfileUpdates = new Set();
    const chatUserAddressState={draft:null,saving:false,notice:''},chatUserAddressListeners=new Set();
    let chatUserAddressDraftVersion=0;
    const userAddressProblem=value=>/[\p{Cc}\p{Cs}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b\u2060\ufeff]/u.test(value)
      ?'称呼不能包含换行、控制字符或不可见字符。':Array.from(value.trim()).length>40?'最多 40 个字符，复杂表情可能占多个字符。':'';
    const notifyUserAddress=()=>{for(const update of chatUserAddressListeners)update();};
    const chatPersonaChoices = new Map();
    let chatContextCache;
    let chatForegroundSession;
    const chatForegroundListeners = new Set();
    let chatSurfaceMotion;
    const chatMotionReduced=()=>typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cancelChatMotion=()=>chatSurfaceMotion?.cancel();
    // Only browser snapshots move. The actual view, source lease and focus settle in the update callback.
    function changeChatSurface(update,kind){
      cancelChatMotion();
      let applied=false;
      const commit=()=>{if(applied)return;applied=true;if(typeof flushChatSync==='function')flushChatSync(update);else update();};
      if(typeof document.startViewTransition!=='function'||typeof flushChatSync!=='function'||chatMotionReduced()
        ||document.visibilityState==='hidden'||document.activeViewTransition){commit();return;}
      const root=document.documentElement,previous=root.getAttribute('data-dsh-chat-motion');
      const preference=typeof window.matchMedia==='function'?window.matchMedia('(prefers-reduced-motion: reduce)'):null;
      const motion={transition:null,cancel:null};let timer;
      const cleanup=()=>{
        clearTimeout(timer);preference?.removeEventListener?.('change',skip);document.removeEventListener('visibilitychange',visibility);
        if(chatSurfaceMotion!==motion)return;chatSurfaceMotion=undefined;
        if(previous===null)root.removeAttribute('data-dsh-chat-motion');else root.setAttribute('data-dsh-chat-motion',previous);
      };
      const skip=()=>{try{motion.transition?.skipTransition();}catch{/* The real view must still settle. */}commit();cleanup();};
      const visibility=()=>{if(document.visibilityState==='hidden')skip();};
      motion.cancel=skip;chatSurfaceMotion=motion;root.setAttribute('data-dsh-chat-motion',kind);
      try{
        motion.transition=document.startViewTransition(commit);
        Promise.resolve(motion.transition.ready).catch(()=>{});
        Promise.resolve(motion.transition.updateCallbackDone).catch(()=>{commit();});
        Promise.resolve(motion.transition.finished).catch(()=>{}).finally(()=>{commit();cleanup();});
        preference?.addEventListener?.('change',skip,{once:true});document.addEventListener('visibilitychange',visibility);
        timer=setTimeout(skip,1000);
      }catch{commit();cleanup();}
    }
    function enterChatSurface(node){
      if(!node||chatSurfaceMotion||document.activeViewTransition||chatMotionReduced()||document.visibilityState==='hidden'||typeof node.animate!=='function')return;
      const dock=node.classList.contains('dsh-persona-chat-dock');
      try{const animation=node.animate([{opacity:0,transform:dock?'translateY(5px) scale(.94)':'translateY(9px) scale(.985)'},
          {opacity:1,transform:'none'}],{duration:dock?160:190,easing:'cubic-bezier(.2,.8,.2,1)'});
        const preference=typeof window.matchMedia==='function'?window.matchMedia('(prefers-reduced-motion: reduce)'):null;
        const detach=()=>preference?.removeEventListener?.('change',cancel);
        const cancel=()=>{animation.cancel();detach();};
        preference?.addEventListener?.('change',cancel,{once:true});
        Promise.resolve(animation.finished).catch(()=>{}).finally(detach);
        return cancel;
      }catch{/* Animation support must not affect the window's controls. */}
    }
    const chatRuntime = {
      opened: false, minimized: false, root: undefined, container: undefined, motionStyle:undefined, revision:0,sessionId: undefined, conversation: undefined, focusAt: 0,
      setMinimized(value) {
        if (!this.opened || this.minimized===value) return;
        this.minimized=value;const revision=++this.revision;
        changeChatSurface(()=>{if(!this.opened||this.revision!==revision)return;for(const update of chatLaunchListeners)update();},value?'minimize':'restore');
      },
      foreground(sessionId) {
        if (!sessionId) return;
        const changed = chatForegroundSession!==sessionId; chatForegroundSession=sessionId;
        if (changed) for (const update of chatForegroundListeners) update();
        if (!this.opened || this.minimized || document.visibilityState==='hidden' || !chatContextCache?.initialized || (!changed && Date.now()-this.focusAt<5000)) return;
        this.focusAt=Date.now();
        void fetch(ROUTE+'/chat-context',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({action:'focus',roomId:chatContextCache.roomId,sessionId,viewer:'foreground'})}).catch(()=>{});
      },
      open(sessionId,conversation) {
        reportReadingRuntime.minimize();
        this.foreground(sessionId);
        if (!this.root) {
          if (typeof createChatRoot!=='function') throw Error('当前客户端暂不支持独立聊天室，请升级 DSH。');
          this.container=document.createElement('div');this.container.dataset.personaShell='chat-runtime';document.body.appendChild(this.container);
          this.root=createChatRoot(this.container);
          this.motionStyle=document.createElement('style');this.motionStyle.dataset.personaShell='chat-motion';
          this.motionStyle.textContent=CHAT_MOTION_CSS;document.head.appendChild(this.motionStyle);
        }
        if (this.opened) { if(this.minimized)this.setMinimized(false);else document.getElementById('dsh-persona-chat-input')?.focus();return; }
        const revision=++this.revision;cancelChatMotion();this.opened=true;this.minimized=false;
        if (!this.sessionId) {this.sessionId=sessionId;this.conversation=conversation;}
        this.root.render(h(RoomChatWorkspace,{sessionId:chatForegroundSession??this.sessionId,conversation:this.conversation,onClose:()=>this.close()}));
        for(const update of chatLaunchListeners)update();
        requestAnimationFrame(()=>{if(this.opened&&!this.minimized&&this.revision===revision)document.getElementById('dsh-persona-chat-input')?.focus({preventScroll:true});});
      },
      close() {for(const flush of chatUiFlushers.values())flush();this.opened=false;this.minimized=false;const revision=++this.revision;
        changeChatSurface(()=>{if(this.revision!==revision||this.opened)return;this.root?.render(null);chatAnimatedAttempts.clear();for(const update of chatLaunchListeners)update();},'close');},
      dispose() {this.revision++;this.opened=false;this.minimized=false;cancelChatMotion();this.root?.unmount();this.container?.remove();this.motionStyle?.remove();this.motionStyle=undefined;this.root=undefined;this.container=undefined;this.sessionId=undefined;this.conversation=undefined;chatContextCache=undefined;window.removeEventListener?.('storage',chatUiStorageEvent);},
    };
    const chatNonce = () => window.crypto?.randomUUID?.() ?? `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const emptyChatDraft = () => ({ text: '', requestId: chatNonce() });
    // Unsent bytes stay in this client session; committed messages hold Host attachment references.
    const chatImageDrafts=new Map(),chatImageSends=new Map();
    const rememberChatImages=(key,items)=>{if(items.length)chatImageDrafts.set(key,items);else chatImageDrafts.delete(key);
      while(chatImageDrafts.size>8)chatImageDrafts.delete(chatImageDrafts.keys().next().value);};
    const chatImageType=file=>file?.type&&file.type!=='application/octet-stream'?file.type:
      ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'}[file?.name?.split('.').at(-1)?.toLowerCase()]??'');
    const chatTransferImages=transfer=>{
      const files=Array.from(transfer?.files??[]);
      return (files.length?files:Array.from(transfer?.items??[]).filter(item=>item.kind==='file').map(item=>item.getAsFile?.()).filter(Boolean))
        .filter(file=>chatImageType(file).startsWith('image/'));
    };
    const chatTransferHasFiles=transfer=>Array.from(transfer?.types??[]).includes('Files')||Array.from(transfer?.items??[]).some(item=>item.kind==='file')||!!transfer?.files?.length;
    const chatUi = new Map(),chatUiListeners=new Set(),chatUiDurableDrafts=new Map(),chatUiDirtyDrafts=new Map(),chatUiIssues=new Map(),chatUiFlushers=new Map();
    let chatUiNamespace,chatUiInstance,chatUiScope,chatUiReadFailed=false;
    const chatUiIssue=(id,text)=>{if((chatUiIssues.get(id)??'')===text)return;if(text)chatUiIssues.set(id,text);else chatUiIssues.delete(id);
      Promise.resolve().then(()=>{for(const notify of chatUiListeners)notify();});};
    const chatUiId=value=>typeof value==='string'&&value.length>0&&value.length<=200;
    const chatUiNumber=value=>Number.isSafeInteger(value)&&value>=0?value:0;
    const chatUiKey=()=>chatUiNamespace?'dsh-persona-shell:room-ui:v1:'+chatUiNamespace:null;
    const chatUiQuote=value=>value&&chatUiId(value.roomId)&&['user','assistant'].includes(value.kind)
      ?{roomId:value.roomId,generation:chatUiNumber(value.generation),kind:value.kind,
        ...(value.kind==='user'&&chatUiId(value.messageId)?{messageId:value.messageId}:{}),
        ...(value.kind==='assistant'&&chatUiId(value.turnId)&&chatUiId(value.attemptId)&&Number.isInteger(value.index)&&value.index>=0&&value.index<6
          ?{turnId:value.turnId,attemptId:value.attemptId,index:value.index}:{})}:null;
    function normalizeChatUi(value){
      if(!value||typeof value!=='object')return null;
      const text=typeof value.draft?.text==='string'&&value.draft.text.length<=4000?value.draft.text:'';
      const position=value.reading,anchor=position?.anchor;
      return{generation:chatUiNumber(value.generation),scopeKey:typeof value.scopeKey==='string'?value.scopeKey.slice(0,200):null,
        draft:{text,requestId:chatUiId(value.draft?.requestId)?value.draft.requestId:chatNonce(),quoteRef:chatUiQuote(value.draft?.quoteRef)},
        selection:{start:Math.min(text.length,chatUiNumber(value.selection?.start)),end:Math.min(text.length,chatUiNumber(value.selection?.end))},
        reading:position&&typeof position==='object'?{atBottom:position.atBottom!==false,scrollTop:Math.max(0,Math.min(1000000,Number(position.scrollTop)||0)),
          anchor:anchor&&chatUiId(anchor.turnId)&&['user','assistant'].includes(anchor.kind)?{turnId:anchor.turnId,kind:anchor.kind,index:Math.min(5,chatUiNumber(anchor.index)),
            ...(anchor.kind==='user'&&chatUiId(anchor.messageId)?{messageId:anchor.messageId}:{})}:null,
          offset:Number.isFinite(position.offset)?Math.max(-100000,Math.min(100000,position.offset)):0,
          known:(Array.isArray(position.known)?position.known:[]).filter(chatUiId).slice(-256)}:null,
        visitedAt:chatUiNumber(value.visitedAt),updatedAt:chatUiNumber(value.updatedAt)};
    }
    function readChatUiStorage(){
      chatUiReadFailed=false;
      try{const raw=localStorage.getItem(chatUiKey());if(!raw)return{};if(raw.length>800000){chatUiReadFailed=true;return{};}const value=JSON.parse(raw);
        if(value?.version!==1||!value.rooms||typeof value.rooms!=='object'){chatUiReadFailed=true;return{};}
        return Object.fromEntries(Object.entries(value.rooms).filter(([id])=>chatUiId(id)).slice(-32).map(([id,record])=>[id,normalizeChatUi(record)]).filter(([,record])=>record));
      }catch{chatUiReadFailed=true;return{};}
    }
    function persistChatUi(id,patch,expectedDraft,explicitDraft=false){
      if(!chatUiKey())return;
      try{const rooms=readChatUiStorage(),old=rooms[id];
        if(chatUiReadFailed){chatUiIssue(id,'暂时无法读取本地草稿存储，当前输入仍保留在此页。');return;}
        const cached=chatUi.get(id),dirty=chatUiDirtyDrafts.get(id);
        if(dirty&&old&&old.generation>cached.generation){chatUiDirtyDrafts.delete(id);chatUi.set(id,old);chatDrafts.delete(id);return old;}
        if(dirty&&!explicitDraft&&old&&old.draft.requestId!==chatUiDurableDrafts.get(id)&&old.draft.requestId!==dirty){
          chatUiIssue(id,'另一页面也修改了草稿。本页未保存的输入已保留，请先核对再继续。');return;}
        if(!old&&!Object.hasOwn(patch,'draft')&&chatUiDurableDrafts.has(id)&&!dirty){
          chatUi.delete(id);chatDrafts.delete(id);chatWorkDrafts.delete(id);chatUiDurableDrafts.delete(id);return null;
        }
        const next={...(old??cached),...patch,updatedAt:Date.now()};
        if(dirty&&!explicitDraft&&cached?.draft.requestId===dirty)next.draft=cached.draft;
        if(expectedDraft&&old?.draft?.requestId!==expectedDraft){delete next.draft;next.draft=old?.draft??chatUi.get(id)?.draft;}
        rooms[id]=normalizeChatUi(next);
        const entries=Object.entries(rooms).filter(([,record])=>record).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,32);
        localStorage.setItem(chatUiKey(),JSON.stringify({version:1,rooms:Object.fromEntries(entries)}));
        chatUiDurableDrafts.set(id,rooms[id].draft.requestId);if(chatUiDirtyDrafts.get(id)===rooms[id].draft.requestId)chatUiDirtyDrafts.delete(id);chatUiIssue(id,'');return rooms[id];
      }catch{chatUiIssue(id,'本地草稿暂未保存，当前输入仍保留在此页。');}
    }
    function updateChatUi(id,patch,expectedDraft,explicitDraft=false){
      if(!chatUiId(id))return;
      const old=chatUi.get(id)??normalizeChatUi({draft:chatDrafts.get(id)}),next=normalizeChatUi({...old,...patch,updatedAt:Date.now()});
      chatUi.set(id,next);while(chatUi.size>32)chatUi.delete([...chatUi].sort((a,b)=>a[1].updatedAt-b[1].updatedAt)[0][0]);
      const persisted=persistChatUi(id,patch,expectedDraft,explicitDraft);if(persisted)chatUi.set(id,persisted);
    }
    function saveChatDraft(id,draft,expectedDraft,room,scopeKey){
      if(expectedDraft&&chatUiDirtyDrafts.has(id)&&chatUiDirtyDrafts.get(id)!==expectedDraft)return room?restoreChatUi(room,scopeKey):chatDrafts.get(id);
      if(expectedDraft&&chatUiKey()){
        const stored=readChatUiStorage()[id];
        if(stored?.draft?.requestId&&stored.draft.requestId!==expectedDraft){chatUi.set(id,stored);
          const other={text:stored.draft.text,requestId:stored.draft.requestId};chatDrafts.set(id,other);return room?restoreChatUi(room,scopeKey):other;}
      }
      if(!expectedDraft)chatUiDirtyDrafts.set(id,draft.requestId);
      keepDraft(chatDrafts,id,draft);updateChatUi(id,{draft:{text:draft.text,requestId:draft.requestId,quoteRef:draft.quote?.ref??null}},expectedDraft,!expectedDraft);return draft;
    }
    function clearChatUi(id){
      chatDrafts.delete(id);chatWorkDrafts.delete(id);chatUi.delete(id);chatUiDurableDrafts.delete(id);chatUiDirtyDrafts.delete(id);chatUiIssues.delete(id);
      if(chatUiKey())try{const rooms=readChatUiStorage();if(chatUiReadFailed)return;delete rooms[id];localStorage.setItem(chatUiKey(),JSON.stringify({version:1,rooms}));}catch{}
    }
    const chatUiStorageEvent=event=>{
      if(event.key!==chatUiKey()||!chatUiKey())return;
      const rooms=readChatUiStorage();if(chatUiReadFailed)return;let oldRooms={};try{oldRooms=JSON.parse(event.oldValue??'null')?.rooms??{};}catch{}
      for(const[id,record]of Object.entries(oldRooms))if(!rooms[id]){
        const local=chatUi.get(id);
        if(local&&!chatUiDirtyDrafts.has(id)&&local.updatedAt<=(record?.updatedAt??0)&&local.draft.requestId===record?.draft?.requestId){chatUi.delete(id);chatDrafts.delete(id);chatWorkDrafts.delete(id);chatUiDurableDrafts.delete(id);}
      }
      for(const[id,record]of Object.entries(rooms)){
        const local=chatUi.get(id),dirty=chatUiDirtyDrafts.get(id);
        if(local&&record.generation>local.generation){chatUiDirtyDrafts.delete(id);chatDrafts.delete(id);chatUi.set(id,record);continue;}
        if(dirty&&record.draft.requestId!==dirty){chatUiIssue(id,'另一页面也修改了草稿。本页未保存的输入已保留，请先核对再继续。');continue;}
        if(!local||record.updatedAt>=local.updatedAt)chatUi.set(id,record);
      }
      for(const notify of chatUiListeners)notify();
    };
    function useChatUiNamespace(value,instance){
      const changedInstance=chatUiInstance!==undefined&&chatUiInstance!==instance;
      chatUiInstance=instance;
      if(!chatUiId(value)){
        if(changedInstance){chatUi.clear();chatDrafts.clear();chatWorkDrafts.clear();chatUiDurableDrafts.clear();chatUiDirtyDrafts.clear();chatUiIssues.clear();chatUiScope=undefined;}
        chatUiNamespace=undefined;window.removeEventListener?.('storage',chatUiStorageEvent);return;
      }
      if(value===chatUiNamespace)return;
      if(chatUiScope&&chatUiScope!==value||changedInstance&&chatUiScope!==value){chatUi.clear();chatDrafts.clear();chatWorkDrafts.clear();chatUiDurableDrafts.clear();chatUiDirtyDrafts.clear();chatUiIssues.clear();}
      chatUiNamespace=value;chatUiScope=value;
      for(const[id,record]of Object.entries(readChatUiStorage())){chatUiDurableDrafts.set(id,record.draft.requestId);if((chatUi.get(id)?.updatedAt??0)<=record.updatedAt)chatUi.set(id,record);}
      window.removeEventListener?.('storage',chatUiStorageEvent);window.addEventListener?.('storage',chatUiStorageEvent);
    }
    function restoreChatUi(room,scopeKey){
      if(!room)return;
      let record=chatUi.get(room.id);
      if(record&&record.generation>(room.generation??0)){const empty=emptyChatDraft();chatDrafts.set(room.id,empty);return empty;}
      if(record&&record.generation!==(room.generation??0)){clearChatUi(room.id);record=null;}
      if(!record){updateChatUi(room.id,{generation:room.generation??0,scopeKey:scopeKey??null});record=chatUi.get(room.id)??normalizeChatUi({generation:room.generation??0,scopeKey});chatUi.set(room.id,record);}
      let quote;
      if(record.scopeKey===(scopeKey??null)&&record.draft.quoteRef){const source=chatQuotedSource(room,record.draft.quoteRef,scopeKey??null);
        if(source)quote={ref:record.draft.quoteRef,text:source.text,author:record.draft.quoteRef.kind==='user'?{role:'user',name:'我'}
          :{role:'assistant',id:source.turn.recipientId,name:source.turn.speakerName}};}
      const current=chatDrafts.get(room.id),draft={text:record.draft.text,requestId:record.draft.requestId,...(quote?{quote}:{})};
      if(!current||current.requestId!==draft.requestId||!!current.quote!==!!draft.quote)chatDrafts.set(room.id,draft);
      if(record.scopeKey!==(scopeKey??null)||!!record.draft.quoteRef!==!!quote)updateChatUi(room.id,{scopeKey:scopeKey??null,draft:{...record.draft,quoteRef:quote?.ref??null}});
      return chatDrafts.get(room.id);
    }
    const chatErrorText = (code) => ({
      'invalid-chat-images':'图片格式或大小不符合要求。每条最多 3 张，单张 4 MiB、合计 8 MiB，支持 PNG、JPEG、WebP 和 GIF。',
      'chat-image-upload-failed':'图片未保存成功，图片和输入已保留，请更换图片或重试。',
      'chat-images-unavailable':'当前宿主未提供可用的图片附件服务，请升级宿主，或仅发送文字。图片仍保留。',
      'chat-vision-unavailable':'当前模型明确不支持图片。请换用视觉模型，或仅发送文字；图片仍保留。',
      'storage-not-ready': '聊天记录暂时无法保存，请稍后重试。输入仍保留。',
      'chat-save-failed': '保存没有完成，请重试。输入仍保留。',
      'chat-conflict': '聊天记录刚有更新，已重新读取，请核对后再操作。',
      'chat-id-conflict': '这条消息已提交过不同内容，请重新编辑后发送。',
      'chat-busy': '这位角色还在回复，可以先写下一条，或停止这次回复。',
      'chat-context-changed': '参考来源已变化，请核对来源后重新发送。输入仍保留。',
      'chat-context-unsaved': '参考来源还未保存，请打开来源面板刷新后重试。消息仍保留。',
      'context-not-open': '参考服务尚未连接，请打开参考来源后重试。输入仍保留。',
      'chat-capacity': '已达到 32 个聊天室上限，请在房间资料中删除不再需要的聊天室。',
      'chat-primary-limit': '每条消息最多 @ 两位主讲。先取消一位，即可换人。',
      'chat-legacy-mentions': '这条消息点名的人数超过房间上限，请重新选择回复对象。',
      'chat-quote-unavailable':'引用的消息已更改或不在当前参考范围，请取消引用或重新选择。输入仍保留。',
      'persona-not-found': '这位角色已经移除，保留的记录仍可查看。',
      'chat-room-not-found': '这个聊天室已移除，请重新选择或新建。',
      'chat-recipient-not-member': '这位角色已不在房间中，请重新选择回复对象。',
      'invalid-chat-members': '每个聊天室需要 1–8 位不同的人格。',
      'support-reference-unavailable': '请先在当前房间接入工作会话，再整理工作参考。',
    }[code] ?? '暂时没有连接成功，输入仍保留，可以稍后重试。');
    const DIRECTOR_ISSUE_REASONS=Object.freeze({
      'wire-type':'调度返回类型不符合要求','wire-size':'调度结果超过长度上限',control:'调度返回的选项格式未能识别',scene:'话题关联选项未通过校验',contribution:'本次接话方向未能确认',support:'辅助任务或工作参考选项未通过校验',json:'调度结果不是完整的 JSON',
      'duplicate-key':'调度结果包含重复字段',shape:'调度结果结构不符合要求',choice:'所选接话项不在本次候选中',
      goal:'接话目标未能识别',actor:'接话角色不在本次候选中',event:'所选发言不在本次对话范围',
      evidence:'接话依据未能对应原话','stale-event':'所选原话已经处理或不再适用',author:'接话对象与原话作者未能对应',
      'normal-ineligible':'该角色当前没有普通接话机会','peer-ineligible':'该角色当前没有同伴接话机会',
      'peer-call':'尚不能确认这次是对她的直接邀请','non-stop':'调度回复未完整结束','too-long':'调度结果超过长度上限',
      'tool-call':'调度返回了不支持的工具请求',
    });
    const chatDirectorIssueReason=issue=>{
      if(typeof issue?.reason==='string'&&Object.hasOwn(DIRECTOR_ISSUE_REASONS,issue.reason))return DIRECTOR_ISSUE_REASONS[issue.reason];
      const defaults={invalid:'接话安排未通过校验',timeout:'调度判断超时',unavailable:'调度调用暂不可用',
        'summary-reference-unavailable':'本条工作参考暂不可用','summary-actor-unavailable':'本条还没有可直接回应并整理工作参考的人格'};
      return typeof issue?.code==='string'&&Object.hasOwn(defaults,issue.code)?defaults[issue.code]:'调度未完成';
    };
    const chatReplyStateText = (turn, running) => turn.status === 'pending' && running ? '输入中…' : ({
      vision:'这次模型没有成功接收图片。请换用支持视觉的模型后重试；图片仍在本条消息中。',
      'image-unavailable':'本条图片暂时无法读取，原消息已保留。请恢复附件服务后重试。',
      format: '回复格式暂未识别，消息已保留，可以重试。',
      'too-long': '回复过长，未保存不完整内容，可以重试。',
      length: '模型回复达到长度限制，消息已保留，可以重试。',
      timeout: '回复超时，消息已保留，可以重试。',
      unavailable: '聊天模型暂不可用，请检查聊天室模型设置。',
      auth: '模型认证或访问权限未通过，请检查提供方设置。',
      'rate-limit': '模型调用较频繁，请稍后重试。',
      network: '连接模型时中断，消息已保留，可以重试。',
      model: '模型调用未成功，消息已保留，可以重试。',
      incomplete: '模型回复未正常结束，消息已保留，可以重试。',
      'source-changed': '参考来源已更新，旧回复已停止。',
      'persona-changed': '人格设定已更新，旧回复已停止。',
      'memory-changed': '记忆偏好已更新，旧回复已停止。',
      'member-removed':'原回复对象已移出聊天室，回复已停止。',
      save: '回复保存未完成，消息已保留，可以重试。',
    }[turn.failure] ?? (turn.status === 'cancelled' ? '回复已停止' : '上次回复未完成，消息已保留'));
    const CHAT_MOTION_CSS = `
      .dsh-persona-chat,.dsh-persona-chat-dock{transform-origin:bottom right}
      html[data-dsh-chat-motion] :is(.dsh-persona-chat,.dsh-persona-chat-dock){view-transition-name:dsh-persona-chat-surface}
      html[data-dsh-chat-motion]{view-transition-name:none}
      html[data-dsh-chat-motion]::view-transition{pointer-events:none}
      html[data-dsh-chat-motion]::view-transition-group(*){animation-duration:0s}
      html[data-dsh-chat-motion]::view-transition-old(*),html[data-dsh-chat-motion]::view-transition-new(*){animation:none;mix-blend-mode:normal}
      html[data-dsh-chat-motion]::view-transition-group(dsh-persona-chat-surface){animation-duration:240ms;animation-timing-function:cubic-bezier(.22,.8,.2,1);overflow:hidden;border-radius:16px}
      html[data-dsh-chat-motion]::view-transition-image-pair(dsh-persona-chat-surface){isolation:isolate}
      html[data-dsh-chat-motion]::view-transition-old(dsh-persona-chat-surface){animation:dsh-chat-surface-out 140ms ease-out both}
      html[data-dsh-chat-motion]::view-transition-new(dsh-persona-chat-surface){animation:dsh-chat-surface-in 200ms 35ms ease-out both}
      @keyframes dsh-chat-surface-out{to{opacity:0}}
      @keyframes dsh-chat-surface-in{from{opacity:0}}
      @keyframes dsh-chat-panel-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
      @keyframes dsh-chat-message-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
      .dsh-persona-chat{transition:width 210ms cubic-bezier(.2,.8,.2,1),height 210ms cubic-bezier(.2,.8,.2,1)}
      .dsh-persona-chat .dsh-persona-chat-compose textarea{transition:height 190ms ease,border-color 120ms ease,box-shadow 120ms ease}
      .dsh-persona-chat :is(button,select):not(:where(.dsh-persona-chat-body *)),.dsh-persona-chat-dock button{transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease,box-shadow 120ms ease,opacity 120ms ease}
      .dsh-persona-chat-info[role=dialog]{max-height:min(52vh,55%);box-sizing:border-box;overflow-y:auto;overscroll-behavior:contain}
      .dsh-persona-chat :is(.dsh-persona-work-draft,.dsh-persona-chat-room-panel,.dsh-persona-chat-appearance,.dsh-persona-chat-sources),.dsh-persona-chat-info[role=group]{animation:dsh-chat-panel-in 160ms ease-out}
      .dsh-persona-chat-message[data-arriving=true],.dsh-persona-chat-typing{animation:dsh-chat-message-in 170ms ease-out}
      @media(prefers-reduced-motion:reduce){
        .dsh-persona-chat,.dsh-persona-chat-dock,.dsh-persona-chat :is(button,select,textarea):not(:where(.dsh-persona-chat-body *)),.dsh-persona-chat-dock button{transition:none!important}
        .dsh-persona-chat :is(.dsh-persona-work-draft,.dsh-persona-chat-room-panel,.dsh-persona-chat-appearance,.dsh-persona-chat-sources,.dsh-persona-chat-info,.dsh-persona-chat-message){animation:none!important}
        html[data-dsh-chat-motion]::view-transition-group(*),html[data-dsh-chat-motion]::view-transition-old(*),html[data-dsh-chat-motion]::view-transition-new(*){animation:none!important}
      }
    `;
    const CHAT_THEMES = [
      { id:'blue', name:'海蓝', color:'#3566c9' },
      { id:'jade', name:'青竹', color:'#237463' },
      { id:'violet', name:'藤紫', color:'#79559d' },
      { id:'rose', name:'玫瑰', color:'#a54765' },
    ];
    const CHAT_THEME_KEY = 'dsh-persona-shell:chat-theme:v1';
    const chatThemeFor = id => CHAT_THEMES.find(theme => theme.id === id) ?? CHAT_THEMES[0];
    function readChatTheme() {
      try { return chatThemeFor(localStorage.getItem(CHAT_THEME_KEY)); }
      catch { return CHAT_THEMES[0]; }
    }
    function useChatTheme() {
      const [theme,setTheme] = React.useState(readChatTheme);
      const [notice,setNotice] = React.useState('');
      React.useEffect(() => {
        const sync = event => {
          if (event.key !== CHAT_THEME_KEY && event.key !== null) return;
          setTheme(readChatTheme()); setNotice('');
        };
        window.addEventListener('storage',sync);
        return () => window.removeEventListener('storage',sync);
      },[]);
      const choose = value => {
        setTheme(value);
        try { localStorage.setItem(CHAT_THEME_KEY,value.id); setNotice(''); }
        catch { setNotice('主题已切换，本机暂时无法保存。'); }
      };
      return { theme, choose, notice };
    }
    const CHAT_CSS = `
      .dsh-persona-chat-message[data-chat-persona]>.dsh-persona-chat-bubble{background:color-mix(in srgb,var(--chat-persona-color,var(--chat-brand)) 12%,var(--chat-bg));border-color:color-mix(in srgb,var(--chat-persona-color,var(--chat-brand)) 25%,var(--chat-border))}
      .dsh-persona-chat-message[data-chat-persona] .dsh-persona-chat-speaker{color:color-mix(in srgb,var(--chat-text) 65%,var(--chat-persona-color,var(--chat-brand)))}
      .dsh-persona-chat{--chat-bg:var(--dsw-alias-bg-layer-1,#fff);--chat-soft:var(--dsw-alias-bg-layer-2,#f3f5f8);--chat-border:var(--dsw-alias-border-l1,#d6dfe9);--chat-text:var(--dsw-alias-label-primary,#203044);--chat-muted:var(--dsw-alias-label-secondary,#65758a);--chat-brand:${CHAT_THEMES[0].color};position:fixed;right:20px;bottom:20px;width:min(430px,calc(100vw - 32px));height:min(650px,calc(100dvh - 40px));z-index:1100;display:flex;flex-direction:column;min-width:0;border:1px solid var(--chat-border);border-radius:16px;background:var(--chat-bg);color:var(--chat-text);box-shadow:0 18px 70px #0003;font:14px/1.65 system-ui,sans-serif;overflow:hidden}
      .dsh-persona-chat[data-wide=true]{width:min(740px,calc(100vw - 32px));height:min(780px,calc(100dvh - 40px))}
      .dsh-persona-chat-sources{max-height:36%;overflow:auto;flex:none}.dsh-persona-chat-sources p{font-size:11px;margin:8px 0}.dsh-persona-chat-sources button{font-size:11px;min-height:26px;padding:2px 7px}.dsh-persona-source-item{display:flex;align-items:center;gap:8px;margin:7px 0}.dsh-persona-source-item>span{flex:1;min-width:0;overflow-wrap:anywhere}.dsh-persona-chat-source-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.dsh-persona-chat-source-actions select{min-width:0;max-width:100%;font-size:12px;border:1px solid var(--chat-border);border-radius:6px;background:var(--chat-bg);padding:5px}.dsh-persona-context-notices{flex:none;max-height:20%;overflow:auto;padding:8px 14px;border-bottom:1px solid var(--chat-border);font-size:12px}.dsh-persona-context-notices summary{cursor:pointer}
      /* The room owns its controls; MarkdownText owns the controls inside a reply. */
      .dsh-persona-chat :not(:where(.dsh-persona-chat-body *)){box-sizing:border-box}
      .dsh-persona-chat :is(button,select,textarea):not(:where(.dsh-persona-chat-body *)){font:inherit;color:inherit}
      .dsh-persona-chat button:not(:where(.dsh-persona-chat-body *)){cursor:pointer;border:1px solid var(--chat-border);border-radius:7px;background:var(--chat-bg);padding:5px 10px;min-height:32px}
      .dsh-persona-chat button:not(:where(.dsh-persona-chat-body *)):disabled{opacity:.5;cursor:default}
      .dsh-persona-chat :is(button,select,textarea):not(:where(.dsh-persona-chat-body *)):focus-visible{outline:2px solid var(--chat-brand);outline-offset:2px}
      .dsh-persona-chat-top{flex:none;min-height:64px;height:auto;margin:0;transform:none;overflow:visible;display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--chat-border);background:var(--chat-bg)}.dsh-persona-chat-title{min-width:0;flex:1}.dsh-persona-chat-title strong{display:block;font-size:14px}.dsh-persona-chat-title small{display:block;color:var(--chat-muted);font-size:11px}.dsh-persona-chat-top button{padding:3px 8px;font-size:12px}
      .dsh-persona-chat select:not(:where(.dsh-persona-chat-body *)){max-width:100%;min-width:0;border:0;border-radius:5px;background:var(--chat-soft);padding:3px 5px;font-size:13px}
      .dsh-persona-chat{--chat-brand-ink:color-mix(in srgb,var(--chat-brand) 55%,var(--chat-text))}
      .dsh-persona-chat-avatar{flex:none;display:grid;place-items:center;width:32px;height:32px;border-radius:10px;background:var(--chat-soft);border:1px solid var(--chat-border);font-size:13px;font-weight:600}.dsh-persona-chat-top>.dsh-persona-chat-avatar{color:var(--chat-brand-ink);width:36px;height:36px}
      .dsh-persona-chat-avatar-spacer{display:block;flex:none;width:32px;height:32px}.dsh-persona-chat-message[data-chat-continuation=true]{margin-top:-6px}
      .dsh-persona-chat-input-state{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:7px;margin:-5px 0 13px;font-size:10px;line-height:1.6;color:var(--chat-muted)}.dsh-persona-chat-input-state button{font-size:10px!important;min-height:24px!important;padding:1px 7px!important}
      .dsh-persona-chat-thread{position:relative;min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;padding:16px 14px;background:var(--chat-soft);scroll-padding:14px}.dsh-persona-chat-time{text-align:center;font-size:10px;color:var(--chat-muted);margin:0 0 14px}.dsh-persona-chat-message{display:flex;align-items:flex-start;gap:8px;margin:0 0 12px}.dsh-persona-chat-message[data-user=true]{flex-direction:row-reverse}.dsh-persona-chat-bubble{max-width:calc(100% - 48px);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--chat-bg);border:1px solid var(--chat-border);border-radius:3px 12px 12px;padding:9px 12px}.dsh-persona-chat-message[data-user=true]>.dsh-persona-chat-bubble{background:var(--chat-brand);color:#fff;border-color:transparent;border-radius:12px 3px 12px 12px}.dsh-persona-chat-turn-state{font-size:11px;color:var(--chat-muted);text-align:right;margin:-5px 0 14px}.dsh-persona-chat-turn-state button{font-size:11px;padding:2px 8px;min-height:26px;margin-left:8px}
      .dsh-persona-chat-empty{height:100%;min-height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--chat-muted);gap:8px;padding:18px}.dsh-persona-chat-empty strong{font-size:15px;color:var(--chat-text)}.dsh-persona-chat-empty p{margin:0;font-size:12px;max-width:270px}.dsh-persona-chat-compose{flex:none;padding:12px 14px;background:var(--chat-bg);border:0}.dsh-persona-chat-compose textarea{display:block;width:100%;min-height:70px;max-height:140px;resize:vertical;border:0;outline:0;background:transparent;line-height:1.65;padding:2px;color:var(--chat-text)}.dsh-persona-chat-compose-row{margin-top:6px;display:flex;align-items:center;justify-content:space-between;gap:10px}.dsh-persona-chat-compose-row small{font-size:10px;color:var(--chat-muted)}.dsh-persona-chat-compose button[data-primary]{background:var(--chat-brand);color:#fff;border-color:transparent;min-width:68px}.dsh-persona-chat-info{flex:none;font-size:11px;color:var(--chat-muted);padding:7px 14px;border-bottom:1px solid var(--chat-border);overflow-wrap:anywhere}.dsh-persona-chat-info button{font-size:11px;min-height:25px;margin-left:6px}
      .dsh-persona-chat-suggest{padding-bottom:8px;margin-bottom:7px;border-bottom:1px solid var(--chat-border)}.dsh-persona-chat-suggest-head{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px}.dsh-persona-chat-suggest-head label{display:flex;align-items:center;gap:5px}.dsh-persona-chat-suggest-head button{font-size:11px;min-height:28px;padding:3px 8px}.dsh-persona-chat-suggest small{display:block;font-size:10px;color:var(--chat-muted);margin:5px 0}.dsh-persona-chat-suggestions{max-height:155px;overflow:auto;display:grid;gap:5px}.dsh-persona-chat-suggestions button{font-size:12px;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--chat-soft)}
      @media(max-width:520px){.dsh-persona-chat,.dsh-persona-chat[data-wide=true]{right:8px;bottom:max(8px,env(safe-area-inset-bottom));width:calc(100vw - 16px);height:calc(100dvh - 24px);border-radius:12px}.dsh-persona-chat-top{padding:10px}.dsh-persona-chat-compose-row small{max-width:200px}.dsh-persona-chat-top button{font-size:11px;padding:3px 6px}}
      .dsh-persona-chat-top{display:grid;grid-template-columns:36px minmax(0,1fr) repeat(4,auto);gap:9px}.dsh-persona-chat-title{display:contents}.dsh-persona-chat-title strong{grid-column:2;grid-row:1}.dsh-persona-chat-title select{grid-column:1/-1;grid-row:2;width:100%;padding:7px 9px;background:var(--chat-soft);border:1px solid var(--chat-border);border-radius:7px}.dsh-persona-chat-top>.dsh-persona-chat-avatar{grid-column:1;grid-row:1}.dsh-persona-chat-top>button{grid-row:1}
      .dsh-persona-chat-compose textarea{padding:9px 10px;border:1px solid var(--chat-border);border-radius:9px;background:var(--chat-soft);font-size:13px;box-shadow:none}.dsh-persona-chat-compose textarea:focus-visible{outline:none!important;border-color:#7890e8;box-shadow:0 0 0 2px #7185e520}
      .dsh-persona-chat-thread-wrap{position:relative;min-height:0;flex:1;display:flex;overflow:hidden}
      /* Sticky code banners belong to the scrolling messages, below room panels and the jump button. */
      .dsh-persona-chat-thread{isolation:isolate;min-width:0;width:100%}
      .dsh-persona-chat-thread[data-following=true]{overflow-anchor:none}
      .dsh-persona-chat-thread-content{display:flow-root}
      .dsh-persona-chat .dsh-persona-chat-quote-action{align-self:center;flex:none;display:grid;place-items:center;width:26px;height:28px;min-height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--chat-muted);opacity:0;pointer-events:none}
      .dsh-persona-chat .dsh-persona-chat-quote-action:is(:hover,:focus-visible){background:var(--chat-soft);color:var(--chat-text)}
      .dsh-persona-chat-message:has(>.dsh-persona-chat-quote-action)>.dsh-persona-chat-bubble{max-width:calc(100% - 70px)}
      .dsh-persona-chat-message:hover>.dsh-persona-chat-quote-action,.dsh-persona-chat-message:focus-within>.dsh-persona-chat-quote-action{opacity:1;pointer-events:auto}
      .dsh-persona-chat-quote{display:flex;align-items:flex-start;gap:8px;border-inline-start:2px solid currentColor;padding:4px 8px;margin:2px 0 7px;min-width:0;opacity:.9;font-size:11px;line-height:1.5;white-space:normal}
      .dsh-persona-chat-quote>div{flex:1;min-width:0}.dsh-persona-chat-quote strong{display:block;font-size:10px}.dsh-persona-chat-quote-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap}.dsh-persona-chat-quote[data-expanded=true] .dsh-persona-chat-quote-text{display:block;max-height:min(160px,22dvh);overflow:auto;overscroll-behavior:contain}.dsh-persona-chat-quote small{display:block;margin-top:3px}.dsh-persona-chat-quote-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.dsh-persona-chat-quote>.dsh-persona-chat-quote-actions{display:flex;align-items:center;gap:3px;flex:none}
      .dsh-persona-chat .dsh-persona-chat-quote button{flex:none;min-height:22px;min-width:22px;padding:0 4px;border:0;background:transparent;color:inherit}
      .dsh-persona-chat-quote[data-draft=true]{flex:none;margin:0;padding:6px 9px;border-color:var(--chat-brand);border-radius:3px;background:var(--chat-soft);color:var(--chat-muted)}
      .dsh-persona-chat-quoted-highlight{outline:2px solid var(--chat-brand);outline-offset:3px;border-radius:10px}
      @media(hover:none){.dsh-persona-chat .dsh-persona-chat-quote-action{opacity:.65;pointer-events:auto}}
      .dsh-persona-chat-bubble{min-width:0;font-family:inherit;line-height:1.7}.dsh-persona-chat-body{white-space:normal;font:var(--dsw-font-markdown-base,inherit);line-height:1.7;min-width:0;max-width:100%;overflow-wrap:anywhere}.dsh-persona-chat-body>div{margin-block:0}.dsh-persona-chat-body :is(p,ul,ol,blockquote,pre):first-child{margin-top:0}.dsh-persona-chat-body :is(p,ul,ol,blockquote,pre):last-child{margin-bottom:0}.dsh-persona-chat-body pre{max-width:100%;overflow-x:auto}.dsh-persona-chat-body table{max-width:100%}.dsh-persona-chat-body img{max-width:100%;height:auto}
      .dsh-persona-chat-typing .dsh-persona-chat-bubble{display:flex;align-items:center;gap:1px;min-height:40px;padding:8px 12px;color:var(--chat-muted);background:var(--chat-bg);border-style:dashed;border-radius:3px 12px 12px;font-size:12px}.dsh-persona-chat-typing-dots{display:inline-flex;width:1.8em;font-family:ui-monospace,monospace;overflow:hidden;vertical-align:bottom}.dsh-persona-chat-typing-dots>span{display:inline-block;width:0;overflow:hidden;white-space:nowrap;animation:dsh-persona-chat-ellipsis 1.4s steps(3,end) infinite}
      @keyframes dsh-persona-chat-ellipsis{0%,10%{width:0}80%,100%{width:1.8em}}
      .dsh-persona-chat button.dsh-persona-chat-jump{position:absolute;right:14px;bottom:12px;z-index:1;border-radius:18px;padding:4px 12px;min-height:30px;font-size:11px;box-shadow:0 3px 12px #0002;color:var(--chat-muted);background:var(--chat-bg)}
      .dsh-persona-chat-wait{flex:none;margin:0;padding:3px 12px 6px;color:var(--chat-muted);font-size:11px;line-height:1.6;overflow-wrap:anywhere}.dsh-persona-chat-wait summary{cursor:pointer}.dsh-persona-chat-wait>span{display:block;padding-top:3px}
      @media(prefers-reduced-motion:reduce){.dsh-persona-chat-typing-dots>span{animation:none;width:1.8em}}
      @media(max-width:520px){.dsh-persona-chat-top{gap:7px;grid-template-columns:32px minmax(0,1fr) repeat(4,auto)}.dsh-persona-chat-top>.dsh-persona-chat-avatar{width:32px;height:32px}}
      .dsh-persona-chat{--chat-top-safe:max(52px,env(safe-area-inset-top,0px));box-sizing:border-box;right:16px;bottom:max(12px,env(safe-area-inset-bottom,0px));height:min(650px,calc(100dvh - var(--chat-top-safe) - max(12px,env(safe-area-inset-bottom,0px))));max-height:calc(100dvh - var(--chat-top-safe) - max(12px,env(safe-area-inset-bottom,0px)));-webkit-app-region:no-drag}
      .dsh-persona-chat[data-wide=true]{width:min(780px,calc(100vw - 32px));height:min(780px,calc(100dvh - var(--chat-top-safe) - max(12px,env(safe-area-inset-bottom,0px))))}
      .dsh-persona-chat-top{grid-template-columns:28px minmax(0,1fr) auto;gap:6px 8px;min-height:0;padding:9px 12px 8px}.dsh-persona-chat-top>.dsh-persona-chat-avatar{width:28px;height:28px}.dsh-persona-chat-title{display:block;grid-column:2;grid-row:1;font-size:14px;line-height:28px;min-width:0}.dsh-persona-chat-actions{grid-column:3;grid-row:1;display:flex;align-items:center;gap:4px}.dsh-persona-chat-actions button{min-height:27px;padding:2px 7px;font-size:11px}
      .dsh-persona-chat-context-row{grid-column:1/-1;grid-row:2;display:flex;align-items:center;gap:7px;min-width:0}.dsh-persona-chat-context-row select{flex:1;min-width:0;width:0;max-width:100%;padding:4px 7px;border:1px solid var(--chat-border);background:var(--chat-soft);font-size:12px;line-height:20px;height:29px;border-radius:6px}.dsh-persona-chat-context-row button{flex:none;font-size:11px;min-height:29px;padding:3px 8px;white-space:nowrap}.dsh-persona-chat-sources{max-height:28%;flex:0 1 auto;min-height:0;padding:6px 12px}.dsh-persona-chat-sources>p:first-child{margin-top:0}
      .dsh-persona-chat-thread-wrap{min-height:min(84px,18dvh)}.dsh-persona-chat-thread{padding:12px}.dsh-persona-chat-empty{min-height:0;gap:7px;padding:12px}.dsh-persona-chat-empty strong{font-size:14px}.dsh-persona-chat-empty p{font-size:11px;max-width:240px;line-height:1.65}
      .dsh-persona-chat-compose{padding:8px 12px;min-height:0;max-height:56%;display:flex;flex-direction:column;gap:6px;overflow:auto;container:chat-compose / inline-size}.dsh-persona-chat-compose textarea{flex:0 1 auto;height:56px;min-height:48px;max-height:none;resize:none;padding:7px 9px;border-radius:8px;font-size:13px}.dsh-persona-chat[data-compose-expanded=true] .dsh-persona-chat-compose textarea{height:clamp(88px,26dvh,220px);min-height:64px}
      .dsh-persona-chat-compose-row{flex:none;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:8px;margin-top:0;min-height:29px;position:sticky;bottom:0;z-index:1;background:var(--chat-bg)}
      .dsh-persona-chat-compose-tools,.dsh-persona-chat-compose-actions{display:flex;align-items:center;gap:7px;min-width:0}.dsh-persona-chat-compose-tools{flex-wrap:wrap;row-gap:3px}.dsh-persona-chat-compose-actions{justify-content:flex-end}
      .dsh-persona-chat-compose-tools label{display:flex;align-items:center;gap:5px;font-size:11px;white-space:nowrap;min-height:26px}.dsh-persona-chat-compose-tools input[type=checkbox]{margin:0;accent-color:var(--chat-brand)}.dsh-persona-chat-compose-short{display:none}
      .dsh-persona-chat-compose-actions small{font-size:10px;color:var(--chat-muted);white-space:nowrap}.dsh-persona-chat-compose-row button{min-height:29px;padding:3px 9px;font-size:12px;white-space:nowrap}.dsh-persona-chat-compose-row button[data-primary]{min-width:56px}.dsh-persona-chat-compose-row .dsh-persona-chat-compose-expand{display:grid;place-items:center;width:28px;min-width:28px;padding:4px;background:transparent;border-color:transparent;color:var(--chat-muted)}.dsh-persona-chat-compose-expand:hover{background:var(--chat-soft);border-color:var(--chat-border)}.dsh-persona-chat-compose-expand svg{display:block}
      @container chat-compose (max-width:520px){.dsh-persona-chat-compose-actions small{display:none}}
      @container chat-compose (max-width:430px){.dsh-persona-chat-compose-full{display:none}.dsh-persona-chat-compose-short{display:inline}}
      @container chat-compose (max-width:350px){.dsh-persona-chat-compose-row,.dsh-persona-chat-compose-tools,.dsh-persona-chat-compose-actions{column-gap:5px}.dsh-persona-chat-compose-row button{padding-inline:6px}.dsh-persona-chat-compose-tools label{font-size:10px;gap:3px}.dsh-persona-chat-compose-row .dsh-persona-chat-compose-expand{width:24px;min-width:24px}}
      .dsh-persona-chat-suggest{flex:0 1 auto;min-height:0;max-height:150px;overflow:auto;padding-bottom:6px;margin:0;border-bottom:1px solid var(--chat-border)}.dsh-persona-chat-suggest-head{font-size:11px;color:var(--chat-muted)}.dsh-persona-chat-suggest-head>small{margin:0;flex:1}.dsh-persona-chat-suggest-head>button{flex:none}.dsh-persona-chat-suggestions{max-height:110px}
      @media(max-width:520px){.dsh-persona-chat,.dsh-persona-chat[data-wide=true]{right:8px;bottom:max(8px,env(safe-area-inset-bottom,0px));width:calc(100vw - 16px);height:calc(100dvh - var(--chat-top-safe) - max(8px,env(safe-area-inset-bottom,0px)));max-height:calc(100dvh - var(--chat-top-safe) - max(8px,env(safe-area-inset-bottom,0px)))}.dsh-persona-chat-top{grid-template-columns:28px minmax(0,1fr) auto;padding:8px 10px 7px;gap:5px 7px}.dsh-persona-chat-top>.dsh-persona-chat-avatar{width:28px;height:28px}.dsh-persona-chat-actions{gap:3px}.dsh-persona-chat-actions button{padding:2px 6px}.dsh-persona-chat-compose{padding:7px 10px}}
    `;
    const CHAT_APPEARANCE_CSS = `
      .dsh-persona-chat-themes{min-width:0;margin:4px 0 14px;padding:0 0 12px;border:0;border-bottom:1px solid var(--chat-border)}
      .dsh-persona-chat-themes legend{padding:0;margin-bottom:8px;font-weight:600;font-size:13px}
      .dsh-persona-chat-swatches{display:flex;flex-wrap:wrap;gap:6px}
      .dsh-persona-chat-swatches label{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid transparent;border-radius:7px;font-size:12px;cursor:pointer}
      .dsh-persona-chat-swatches label:has(:checked){border-color:color-mix(in srgb,var(--swatch) 50%,var(--chat-border));background:color-mix(in srgb,var(--swatch) 9%,var(--chat-bg))}
      .dsh-persona-chat-swatches input{appearance:none;display:grid;place-content:center;width:16px;height:16px;flex:none;margin:0;border:1px solid var(--swatch);border-radius:50%;background:var(--swatch);cursor:pointer}
      .dsh-persona-chat-swatches input:checked::after{content:'';width:7px;height:4px;border:solid white;border-width:0 0 2px 2px;transform:translateY(-1px) rotate(-45deg)}
      .dsh-persona-chat-swatches input:focus-visible{outline:2px solid var(--chat-text);outline-offset:2px}
      @media(forced-colors:active){.dsh-persona-chat-swatches input{appearance:auto}.dsh-persona-chat-swatches input:checked::after{display:none}}
      .dsh-persona-chat-appearance{position:absolute;z-index:2;top:8px;right:8px;width:calc(100% - 16px);height:calc(100% - 16px);max-height:calc(100% - 16px);box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;padding:0;border:1px solid var(--chat-border);border-radius:12px;background:var(--chat-bg);box-shadow:0 12px 32px #0003}
      .dsh-persona-chat-settings-heading{position:relative;flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0;padding:12px 14px 10px;background:var(--chat-bg,var(--dsw-alias-bg-layer-1,#fff))}
      .dsh-persona-chat-settings-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;box-sizing:border-box;padding:4px 14px 14px;background:var(--chat-bg,var(--dsw-alias-bg-layer-1,#fff))}
    `;
    const ROOM_CHAT_CSS = `
      .dsh-persona-chat-compose{position:relative}
      .dsh-persona-chat-compose[data-image-dragging=true]{outline:2px dashed var(--chat-brand);outline-offset:-4px;background:color-mix(in srgb,var(--chat-brand) 7%,var(--chat-bg))}.dsh-persona-chat-drop-hint{position:absolute;inset:0;z-index:1;display:grid;place-items:center;pointer-events:none;background:color-mix(in srgb,var(--chat-bg) 90%,transparent);border-radius:8px;font-size:13px;color:var(--chat-brand-ink)}
      .dsh-persona-room-avatar-display{position:relative}.dsh-persona-chat-member-activity{position:absolute;right:-2px;top:-2px;display:flex;align-items:center;gap:2px;padding:2px;border-radius:8px;background:var(--chat-bg);pointer-events:none}.dsh-persona-chat-member-activity i{display:block;width:6px;height:6px;border-radius:50%;background:#299b66}.dsh-persona-chat-member-activity[data-state=listening] i{animation:dsh-chat-listening 1.8s ease-in-out infinite}.dsh-persona-chat-member-activity[data-state=typing]{right:-6px}.dsh-persona-chat-member-activity[data-state=typing] i{width:3px;height:3px;opacity:.25;animation:dsh-chat-member-typing 1.2s ease-in-out infinite}.dsh-persona-chat-member-activity[data-state=typing] i:nth-child(2){animation-delay:.18s}.dsh-persona-chat-member-activity[data-state=typing] i:nth-child(3){animation-delay:.36s}
      @keyframes dsh-chat-listening{0%,100%{opacity:.4}50%{opacity:1}}@keyframes dsh-chat-member-typing{0%,65%,100%{opacity:.25}20%,45%{opacity:1}}
      @media(prefers-reduced-motion:reduce){.dsh-persona-chat-member-activity i{animation:none!important;opacity:1!important}}
      .dsh-persona-chat-images{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px;max-width:100%}.dsh-persona-chat-images a{display:block;max-width:min(210px,100%);line-height:0}.dsh-persona-chat-images img{display:block;max-width:100%;max-height:150px;object-fit:contain;border-radius:7px}.dsh-persona-chat-images>span{font-size:11px;color:var(--chat-muted)}
      .dsh-persona-chat-image-drafts{display:flex;gap:7px;flex:none;overflow-x:auto;padding:3px 3px 5px}.dsh-persona-chat-image-drafts>div{position:relative;flex:none;width:68px;height:60px}.dsh-persona-chat-image-drafts img{width:68px;height:60px;object-fit:cover;border-radius:7px;border:1px solid var(--chat-border)}.dsh-persona-chat-image-drafts button{position:absolute;top:-3px;right:-3px;min-height:22px!important;width:22px;padding:0!important;border-radius:50%!important;font-size:15px!important}
      .dsh-persona-chat-image-note{flex:none;font-size:11px;color:var(--chat-muted);line-height:1.7;overflow-wrap:anywhere}.dsh-persona-chat-image-note button{margin-left:6px;min-height:25px;font-size:11px}
      .dsh-persona-chat-dock{--chat-bg:var(--dsw-alias-bg-layer-1,#fff);--chat-border:var(--dsw-alias-border-l1,#d6dfe9);--chat-soft:var(--dsw-alias-bg-layer-2,#f3f5f8);--chat-muted:var(--dsw-alias-label-secondary,#65758a);--chat-text:var(--dsw-alias-label-primary,#203044);--chat-brand:${CHAT_THEMES[0].color};position:fixed;z-index:1100;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));display:flex;align-items:center;gap:2px;max-width:calc(100vw - 32px);padding:3px 4px 3px 3px;border:1px solid var(--chat-border);border-radius:18px;background:var(--chat-bg);box-shadow:0 3px 16px #0002;color:var(--chat-text);font:12px/1.35 system-ui,sans-serif}
      .dsh-persona-chat-dock button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:2px 6px;border:0;border-radius:12px;background:transparent;color:inherit;cursor:pointer;font:inherit}.dsh-persona-chat-dock button:hover{background:var(--chat-soft)}.dsh-persona-chat-dock button:focus-visible{outline:2px solid var(--chat-brand);outline-offset:1px}.dsh-persona-chat-dock button:first-of-type{padding-left:2px;min-height:36px}.dsh-persona-chat-dock button:last-of-type{color:var(--chat-muted);width:24px;height:28px;font-size:16px}.dsh-persona-chat-dock .dsh-persona-room-avatar{width:30px;height:30px}
      .dsh-persona-chat-dock-count{min-width:16px;box-sizing:border-box;padding:2px 4px;border-radius:10px;text-align:center;background:var(--chat-brand);color:#fff;font:600 10px/1.2 system-ui,sans-serif;font-variant-numeric:tabular-nums}.dsh-persona-chat-dock-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      @keyframes dsh-persona-chat-arrived{0%,100%{transform:scale(1)}45%{transform:scale(1.22)}}@media(prefers-reduced-motion:no-preference){.dsh-persona-chat-dock-count{animation:dsh-persona-chat-arrived .52s ease-out 2}}
      @media(max-width:380px){
        .dsh-persona-chat .dsh-persona-chat-top[data-room=true]{grid-template-columns:40px minmax(0,1fr) repeat(3,30px);gap:2px 4px}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-room-avatar-display{grid-column:1;grid-row:1/span 2}
        .dsh-persona-chat-top[data-room=true] :is(.dsh-persona-chat-room-heading,.dsh-persona-chat-actions){display:contents}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-room-title{grid-column:2;grid-row:1}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-room-tools{grid-column:2;grid-row:2}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-actions button{padding:1px;min-height:24px;font-size:11px;grid-row:1}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-actions button:nth-child(-n+2){grid-row:2;min-height:20px;border:none;color:var(--chat-muted)}
        .dsh-persona-chat-actions button:nth-child(3){grid-column:3}.dsh-persona-chat-actions button:is(:nth-child(1),:nth-child(4)){grid-column:4}.dsh-persona-chat-actions button:is(:nth-child(2),:nth-child(5)){grid-column:5}
      }
      .dsh-persona-chat-top[data-room=true]{grid-template-columns:44px minmax(0,1fr) auto}.dsh-persona-chat-room-heading{grid-column:2;grid-row:1;min-width:0;display:flex;flex-direction:column;gap:2px}.dsh-persona-chat-room-title{display:flex;align-items:center;gap:5px;min-width:0;min-height:20px!important;border:0!important;background:transparent!important;padding:0!important;text-align:left;font-weight:600;font-size:13px!important;line-height:20px}.dsh-persona-chat-room-title>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-persona-chat-room-title>span:last-child{font-size:10px;color:var(--chat-muted)}.dsh-persona-room-avatar-display{grid-column:1;grid-row:1;align-self:center}.dsh-persona-chat-room-tools{display:flex;align-items:center;gap:10px;min-width:0}.dsh-persona-chat-room-tools button{border:0;min-height:20px;padding:0;font-size:10px;background:transparent;white-space:nowrap;color:var(--chat-muted)}.dsh-persona-chat-room-tools button:is(:hover,[aria-expanded=true]){color:var(--chat-brand-ink)}.dsh-persona-chat-room-heading+.dsh-persona-chat-actions{align-self:start}
      .dsh-persona-room-avatar{--room-avatar-letter:9px;position:relative;display:block;width:44px;height:44px;flex:none;isolation:isolate}.dsh-persona-room-avatar-tile{position:absolute;display:block;border:1px solid var(--chat-bg);border-radius:24%;background:var(--chat-bg);transform:translate(-50%,-50%) rotate(var(--tile-angle,0deg));transform-origin:center;box-shadow:0 1px 0 var(--chat-border),0 2px 4px #0002}.dsh-persona-room-avatar-tile::after{content:'';position:absolute;inset:0;border-radius:inherit;background:linear-gradient(135deg,#ffffff0c,transparent 55%);pointer-events:none}.dsh-persona-room-avatar[data-count='1']{--room-avatar-letter:12px}.dsh-persona-room-avatar[data-count='2']{--room-avatar-letter:10px}.dsh-persona-room-avatar-more{display:grid;place-items:center;color:var(--chat-muted);background:var(--chat-soft);font-size:var(--room-avatar-letter);line-height:1;font-weight:600}.dsh-persona-chat-empty>.dsh-persona-room-avatar{--room-avatar-letter:12px;width:64px;height:64px;margin-bottom:5px}.dsh-persona-chat-mentions{display:block;font-size:9px;line-height:1.4;opacity:.72;margin-bottom:3px;font-weight:400}
      .dsh-persona-chat-participants{min-width:0;flex:none;container:chat-participants / inline-size}
      .dsh-persona-chat-room-tools{container:chat-room-tools / inline-size}
      .dsh-persona-chat-source-short{display:none}
      @container chat-room-tools (max-width:145px){.dsh-persona-chat-source-full{display:none}.dsh-persona-chat-source-short{display:inline}}
      .dsh-persona-chat-recipient{display:flex;align-items:center;gap:2px 5px;min-width:0;padding:2px}
      .dsh-persona-chat-recipient-broadcast{flex:none;font-size:11px;color:var(--chat-muted);white-space:nowrap}
      .dsh-persona-chat-recipient-broadcast-short{display:none}
      .dsh-persona-chat button.dsh-persona-chat-recipient-option{display:inline-flex;align-items:center;gap:5px;min-width:36px;max-width:142px;min-height:30px;padding:3px 7px 3px 4px;border:0;border-radius:9px;background:transparent;font:inherit;font-size:11px;line-height:18px;color:var(--chat-muted);text-align:start}
      .dsh-persona-chat-recipient-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-persona-chat-recipient-portrait{position:relative;display:inline-flex;flex:none}
      .dsh-persona-chat-recipient-option .dsh-persona-chat-avatar{width:22px;height:22px;border-radius:7px;font-size:9px}
      .dsh-persona-chat button.dsh-persona-chat-recipient-option[aria-checked=true]{background:color-mix(in srgb,var(--chat-brand) 12%,var(--chat-bg));color:var(--chat-text);font-weight:600}
      .dsh-persona-chat-recipient-option[aria-checked=true] .dsh-persona-chat-recipient-portrait::after{content:'✓';position:absolute;right:-2px;bottom:-1px;display:grid;place-items:center;width:11px;height:11px;border:1px solid var(--chat-bg);border-radius:50%;background:var(--chat-brand);color:white;font:bold 8px/1 system-ui}
      .dsh-persona-chat-recipient-option[aria-checked=true] .dsh-persona-chat-recipient-portrait[data-order]::after{content:attr(data-order)}
      .dsh-persona-chat-recipient-option:not(:disabled):hover{background:var(--chat-soft)}
      @container chat-participants (max-width:460px){.dsh-persona-chat-recipient[data-density=large]{--recipient-name-display:none;--recipient-padding:3px;--recipient-min:28px;--recipient-justify:center;gap:2px}}
      @container chat-participants (max-width:350px){.dsh-persona-chat-recipient[data-density=medium]{--recipient-name-display:none;--recipient-padding:3px;--recipient-min:28px;--recipient-justify:center;gap:2px}}
      @container chat-participants (max-width:310px){.dsh-persona-chat-recipient[data-density=large] .dsh-persona-chat-recipient-broadcast-full{display:none}.dsh-persona-chat-recipient[data-density=large] .dsh-persona-chat-recipient-broadcast-short{display:inline}}
      @container chat-participants (max-width:270px){.dsh-persona-chat-recipient:is([data-density=medium],[data-density=large]){flex-wrap:wrap}.dsh-persona-chat-recipient[data-density=large] .dsh-persona-chat-recipient-broadcast{display:none}}
      @container chat-participants (max-width:220px){.dsh-persona-chat-recipient{--recipient-name-display:none;--recipient-padding:3px;--recipient-min:28px;--recipient-justify:center;flex-wrap:wrap}.dsh-persona-chat-recipient-broadcast{display:none}}
      .dsh-persona-chat .dsh-persona-chat-recipient button.dsh-persona-chat-recipient-option{min-width:var(--recipient-min,36px);padding-inline:var(--recipient-padding,4px) var(--recipient-padding,7px);justify-content:var(--recipient-justify,flex-start)}
      .dsh-persona-chat-recipient-name{display:var(--recipient-name-display,block)}
      .dsh-persona-chat-room-panel{position:absolute;z-index:5;inset:84px 10px auto;max-height:calc(100% - 98px);overflow:auto;padding:12px;border:1px solid var(--chat-border);border-radius:11px;background:var(--chat-bg);box-shadow:0 12px 35px #0003;font-size:12px}.dsh-persona-chat-room-panel header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.dsh-persona-chat-room-panel header button{min-height:25px;padding:2px 7px;font-size:11px}.dsh-persona-chat-room-panel p{font-size:11px;color:var(--chat-muted);line-height:1.7}.dsh-persona-chat-room-panel input[type=text]{box-sizing:border-box;width:100%;padding:7px 9px;margin:6px 0 10px;border:1px solid var(--chat-border);border-radius:7px;background:var(--chat-soft);font:inherit;color:inherit}.dsh-persona-chat-room-list{display:grid;gap:5px}.dsh-persona-chat-room-list>button{display:flex;align-items:center;gap:9px;width:100%;text-align:left}.dsh-persona-chat-room-list>button[aria-pressed=true]{border-color:var(--chat-brand);background:var(--chat-soft)}.dsh-persona-chat-room-list>button>span:last-child{min-width:0;display:grid;gap:2px}.dsh-persona-chat-room-list strong{font-size:12px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.dsh-persona-chat-room-list small{font-size:10px;color:var(--chat-muted)}.dsh-persona-chat-room-buttons{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.dsh-persona-chat-room-buttons button{font-size:12px;min-height:29px}
      .dsh-persona-chat-room-members{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:8px 0}.dsh-persona-chat-room-members label{display:flex;align-items:center;gap:6px;min-width:0;padding:6px;border:1px solid var(--chat-border);border-radius:7px}.dsh-persona-chat-room-members label>span:last-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-persona-chat-room-members .dsh-persona-chat-avatar{width:26px;height:26px;font-size:10px}.dsh-persona-chat-speaker{display:block;font-size:10px;line-height:1.5;color:var(--chat-muted);margin-bottom:3px}.dsh-persona-chat-message[data-user=true] .dsh-persona-chat-speaker{color:inherit;opacity:.8}.dsh-persona-chat-room-loading{padding:24px;display:grid;gap:10px;font-size:12px}
      .dsh-persona-chat{--chat-hair:color-mix(in srgb,var(--chat-border) 70%,transparent);box-shadow:0 1px 2px #0000000f,0 12px 40px -8px #00000038}
      .dsh-persona-chat-top{border-bottom-color:var(--chat-hair)}
      .dsh-persona-chat-room-title,.dsh-persona-chat-title strong{font-weight:600;letter-spacing:.01em}
      .dsh-persona-chat-actions button,.dsh-persona-chat-top[data-room=true] .dsh-persona-chat-room-tools button{border-color:transparent;background:transparent;color:var(--chat-muted)}
      .dsh-persona-chat-actions button:not(:disabled):hover,.dsh-persona-chat-room-tools button:not(:disabled):hover,.dsh-persona-chat-actions button[aria-expanded=true],.dsh-persona-chat-room-tools button[aria-expanded=true]{background:var(--chat-soft);color:var(--chat-text)}
      .dsh-persona-chat-thread{background:color-mix(in srgb,var(--chat-brand) 3%,var(--chat-bg))}
      .dsh-persona-chat-time{font-variant-numeric:tabular-nums;letter-spacing:.04em}
      .dsh-persona-chat-message[data-chat-persona]>.dsh-persona-chat-bubble{background:color-mix(in srgb,var(--chat-persona-color,var(--chat-brand)) 7%,var(--chat-bg));border-color:color-mix(in srgb,var(--chat-persona-color,var(--chat-brand)) 14%,var(--chat-bg));border-radius:5px 14px 14px;transition:box-shadow 420ms ease}
      .dsh-persona-chat-message[data-chat-continuation=true]>.dsh-persona-chat-bubble{border-top-left-radius:12px}
      .dsh-persona-chat-message[data-user=true]>.dsh-persona-chat-bubble{background:var(--chat-brand);border-radius:14px 5px 14px 14px;color:white}
      .dsh-persona-chat-message[data-chat-persona] .dsh-persona-chat-speaker{font-weight:600;font-size:11px}
      .dsh-persona-chat-message[data-user=true] .dsh-persona-chat-mentions{display:block;color:inherit;opacity:.96;margin-bottom:2px}
      .dsh-persona-chat-avatar{border-color:var(--chat-hair)}
      .dsh-persona-chat-compose{border-top:0;box-shadow:0 -1px 0 var(--chat-hair)}
      .dsh-persona-chat-compose textarea{background:var(--chat-bg);border-color:var(--chat-border)}
      .dsh-persona-chat-compose textarea:focus-visible{border-color:var(--chat-brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--chat-brand) 16%,transparent)}
      .dsh-persona-chat-compose-tools>button{border-color:transparent;background:var(--chat-soft)}
      .dsh-persona-chat-compose-tools>button:not(:disabled):hover,.dsh-persona-chat-compose-tools>button[aria-expanded=true]{background:color-mix(in srgb,var(--chat-brand) 10%,var(--chat-soft))}
      .dsh-persona-chat-compose-tools label{color:var(--chat-muted)}
      .dsh-persona-chat-compose-tools label:has(input:checked){color:var(--chat-text)}
      .dsh-persona-chat-compose button[data-primary]{background:var(--chat-brand);font-weight:600}
      .dsh-persona-chat-compose button[data-primary]:disabled{opacity:1;background:color-mix(in srgb,var(--chat-brand) 22%,var(--chat-soft));color:color-mix(in srgb,var(--chat-text) 45%,transparent)}
      .dsh-persona-chat button.dsh-persona-chat-recipient-option[aria-checked=true]{background:color-mix(in srgb,var(--chat-brand) 10%,var(--chat-bg));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--chat-brand) 28%,transparent)}
      .dsh-persona-chat-quote[data-draft=true]{border-radius:0 8px 8px 0;background:color-mix(in srgb,var(--chat-brand) 6%,var(--chat-soft))}
      /* Motion answers events only: a message arriving, a reply being written, a press, a jump. */
      .dsh-persona-chat{--chat-spring:linear(0,.009,.035 2.1%,.141,.281 6.7%,.723 12.9%,.938 16.7%,1.017,1.077,1.121,1.149 24.3%,1.159,1.163,1.161,1.154 29.9%,1.129 32.8%,1.051 39.6%,1.017 43.1%,.991,.977 51%,.974 53.8%,.975 57.1%,.997 69.8%,1.003 76.9%,1.004 83.8%,1);--chat-settle:linear(0,.25 6%,.6 15%,.86 26%,.97 38%,1.01 50%,1.005 70%,1)}
      @keyframes dsh-chat-bubble-out{from{opacity:0;transform:translate(10px,14px) scale(.86)}to{opacity:1;transform:none}}
      @keyframes dsh-chat-bubble-in{from{opacity:0;transform:translate(-6px,8px) scale(.9)}to{opacity:1;transform:none}}
      @keyframes dsh-chat-avatar-in{from{opacity:0;transform:scale(.55)}to{opacity:1;transform:none}}
      @keyframes dsh-chat-writing{from{box-shadow:inset 2px 0 0 color-mix(in srgb,var(--chat-persona-color,var(--chat-brand)) 55%,transparent),0 0 0 0 color-mix(in srgb,var(--chat-persona-color,var(--chat-brand)) 0%,transparent)}to{box-shadow:inset 2px 0 0 var(--chat-persona-color,var(--chat-brand)),0 0 0 4px color-mix(in srgb,var(--chat-persona-color,var(--chat-brand)) 16%,transparent)}}
      @keyframes dsh-chat-badge-pop{from{transform:scale(0)}to{transform:none}}
      @keyframes dsh-chat-found{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--chat-brand) 45%,transparent)}100%{box-shadow:0 0 0 14px color-mix(in srgb,var(--chat-brand) 0%,transparent)}}
      @keyframes dsh-chat-rise{from{opacity:0;transform:translateY(10px) scale(.94)}to{opacity:1;transform:none}}
      .dsh-persona-chat-message[data-arriving=true]{animation:none}
      .dsh-persona-chat-message[data-arriving=true]>.dsh-persona-chat-bubble{animation:dsh-chat-bubble-in 460ms cubic-bezier(.2,1.3,.4,1) both;animation-timing-function:var(--chat-spring);transform-origin:0 0}
      .dsh-persona-chat-message[data-arriving=true][data-user=true]>.dsh-persona-chat-bubble{animation-name:dsh-chat-bubble-out;transform-origin:100% 0}
      .dsh-persona-chat-message[data-arriving=true][data-chat-continuation=true]>.dsh-persona-chat-bubble{animation-delay:90ms}
      .dsh-persona-chat-message[data-arriving=true]>.dsh-persona-chat-avatar{animation:dsh-chat-avatar-in 380ms cubic-bezier(.2,1.3,.4,1) both;animation-timing-function:var(--chat-spring)}
      .dsh-persona-chat-message[data-chat-persona]>.dsh-persona-chat-bubble[data-live=true]{animation:dsh-chat-writing 1.1s ease-in-out infinite alternate}
      .dsh-persona-chat-message[data-arriving=true][data-chat-persona]>.dsh-persona-chat-bubble[data-live=true]{animation:dsh-chat-bubble-in 460ms both,dsh-chat-writing 1.1s 460ms ease-in-out infinite alternate;animation-timing-function:var(--chat-spring),ease-in-out}
      .dsh-persona-chat-recipient-option[aria-checked=true] .dsh-persona-chat-recipient-portrait::after{animation:dsh-chat-badge-pop 320ms cubic-bezier(.2,1.5,.4,1) both;animation-timing-function:var(--chat-spring)}
      .dsh-persona-chat-thread .dsh-persona-chat-quoted-highlight{animation:dsh-chat-found 900ms ease-out 2}
      .dsh-persona-chat button.dsh-persona-chat-jump{animation:dsh-chat-rise 360ms both;animation-timing-function:var(--chat-settle)}
      .dsh-persona-chat :is(button,select):not(:where(.dsh-persona-chat-body *)),.dsh-persona-chat-dock button{transition:background-color 120ms ease,border-color 120ms ease,color 120ms ease,box-shadow 120ms ease,opacity 120ms ease,transform 160ms cubic-bezier(.2,1.4,.4,1)}
      .dsh-persona-chat button:not(:disabled):not(:where(.dsh-persona-chat-body *)):active,.dsh-persona-chat-dock button:active{transform:scale(.95);transition-duration:60ms}
      @media(prefers-reduced-motion:reduce){
        .dsh-persona-chat-message>:is(.dsh-persona-chat-bubble,.dsh-persona-chat-avatar),.dsh-persona-chat-recipient-option .dsh-persona-chat-recipient-portrait::after,.dsh-persona-chat .dsh-persona-chat-quoted-highlight,.dsh-persona-chat button.dsh-persona-chat-jump{animation:none!important}
        .dsh-persona-chat-message>.dsh-persona-chat-bubble{transition:none!important}
        .dsh-persona-chat button:active,.dsh-persona-chat-dock button:active{transform:none!important}
      }
    `;
    const chatPalette=createChatPalette(),avatarColors=new Map(),avatarColorListeners=new Set();
    function sampleAvatarColor(src,image,catPortrait){
      if(avatarColors.has(src)||!src?.startsWith(ROUTE+'/avatar/'))return;
      let color=null;
      try{
        const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
        const context=canvas.getContext('2d',{willReadFrequently:true}),w=image.naturalWidth,h=image.naturalHeight;
        if(context&&w>0&&h>0){const square=Math.min(w,h),size=square/(catPortrait?2.15:1);
          context.drawImage(image,(w-size)/2,(h-square)*(catPortrait?0.07:0.5),size,size,0,0,32,32);
          color=chatPalette.dominant(context.getImageData(0,0,32,32).data);}
      }catch{/* A blocked/unreadable image keeps its stable local fallback. */}
      avatarColors.set(src,color);while(avatarColors.size>128)avatarColors.delete(avatarColors.keys().next().value);
      for(const update of avatarColorListeners)update();
    }
    function useChatBubbleColors(contacts,room){
      const [,redraw]=React.useState(0);
      React.useEffect(()=>{const update=()=>redraw(value=>value+1);avatarColorListeners.add(update);update();return()=>avatarColorListeners.delete(update);},[]);
      const ids=new Set([...(room?.memberIds??[]),...(room?.turns??[]).map(turn=>turn.recipientId)]);
      return chatPalette.allocate((contacts??[]).filter(person=>ids.has(person.id)).map(person=>({id:person.id,color:avatarColors.get(person.avatar)})));
    }
    function PersonaAvatar({ src, name = '角色', id, fallback = true, className = '', style }) {
      const [failed, setFailed] = React.useState(false);
      React.useEffect(() => setFailed(false), [src]);
      const safe = typeof src === 'string' && (src.startsWith(ROUTE + '/avatar/') || src.startsWith(ROUTE + '/chat-profile/avatar?'));
      if ((!safe || failed) && !fallback) return null;
      const defaults = { '大肥鱼（默认）': '鲸', '大肥龙': '龙', 'Claude小姐': 'C', '鲸鲸（实验性）': '鱼', Gemini: '猫' };
      const catPortrait = safe && src.endsWith('&frame=cat-portrait');
      const initials = Object.hasOwn(defaults, id) ? defaults[id]
        : (/^[a-z]/i.test(name) ? name.slice(0, 2).toUpperCase() : Array.from(name).slice(0, 2).join(''));
      return h('span', { className, role: 'img', 'aria-label': name + '头像', style: { overflow: 'hidden', ...style } },
        safe && !failed ? h('img', { src, alt: '', draggable: false, referrerPolicy: 'no-referrer',
          style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit',
            ...(catPortrait ? { objectPosition: 'center 7%', transform: 'scale(2.15)', transformOrigin: 'center top' } : {}) },
          onLoad:event=>sampleAvatarColor(src,event.currentTarget,catPortrait),onError: () => setFailed(true) }) : initials);
    }
    // Only the official display-safe account projection is read. No account
    // identity, address or credential is kept in plugin storage or model input.
    function createAccountAvatarSource() {
      const subscribers = new Set(), timers = new Map();
      let remote, metadata, url = null, generation = 0, stream;
      const publish = (next) => { url = next; for (const fn of subscribers) fn(); };
      const deadline = (promise) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { timers.delete(timer); reject(Error('account-timeout')); }, 5000);
        timers.set(timer, () => { clearTimeout(timer); reject(Error('account-stopped')); });
        Promise.resolve(promise).then(resolve, reject).finally(() => { clearTimeout(timer); timers.delete(timer); });
      });
      const stop = () => {
        generation++; const current = stream; stream = undefined;
        try { Promise.resolve(current?.dispose()).catch(() => {}); } catch { /* Optional account service. */ }
        for (const cancel of timers.values()) cancel(); timers.clear(); publish(null);
      };
      const profile = async (token) => {
        try {
          const result = await deadline(remote.account.getProfile(metadata()));
          if (token !== generation || !subscribers.size) return;
          const raw = result?.ok && result.value?.status === 'ready' ? result.value.value?.avatarUrl : null;
          let safe = null;
          if (typeof raw === 'string' && raw.length <= 4096) {
            try { const parsed = new URL(raw); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) safe = parsed.href; } catch { /* Hide invalid addresses. */ }
          }
          publish(safe);
        } catch { if (token === generation) publish(null); }
      };
      const refresh = async () => {
        if (!remote?.account || !subscribers.size) return;
        const token = ++generation; publish(null);
        try {
          const state = await deadline(remote.account.getState());
          if (token !== generation || !subscribers.size) return;
          if (state?.ok && state.value?.status === 'credential-stored') await profile(token);
        } catch { if (token === generation) publish(null); }
      };
      const start = () => {
        if (!remote?.account || !subscribers.size) return;
        if (typeof remote.$stream !== 'function' || typeof remote.account.watch !== 'function') { void refresh(); return; }
        try {
          const opened = remote.$stream({ name: 'persona-shell.account-avatar', open: (signal) => remote.account.watch(signal),
            ended: () => Error('account-stream-ended') }); stream = opened;
          void (async () => {
            for await (const frame of opened) {
              if (stream !== opened) return;
              const token = ++generation; publish(null); frame.accept();
              if (frame.value?.status === 'credential-stored') void profile(token);
            }
          })().catch(() => { if (stream === opened) { generation++; publish(null); } });
        } catch { void refresh(); }
      };
      return {
        read: () => url, refresh,
        subscribe(fn) { subscribers.add(fn); if (subscribers.size === 1) start(); return () => { subscribers.delete(fn); if (!subscribers.size) stop(); }; },
        bind(value, clientMetadata) { stop(); remote = value; metadata = clientMetadata; start(); return () => { if (remote === value) { stop(); remote = undefined; } }; },
      };
    }
    const accountAvatarSource = createAccountAvatarSource();
    function useAccountAvatar(enabled) {
      const [url, setUrl] = React.useState(null);
      React.useEffect(() => {
        if (!enabled) { setUrl(null); return; }
        const update = () => setUrl(accountAvatarSource.read());
        const unsubscribe = accountAvatarSource.subscribe(update); update();
        const focus = () => { void accountAvatarSource.refresh(); };
        window.addEventListener?.('focus', focus);
        return () => { unsubscribe(); window.removeEventListener?.('focus', focus); };
      }, [enabled]);
      return enabled ? url : null;
    }
    const userAvatarMode = (profile) => profile?.avatarMode ?? (profile?.avatar ? 'custom' : 'account');
    function UserChatAvatar({ profile, accountUrl, className }) {
      const mode = userAvatarMode(profile);
      const src = mode === 'account' ? accountUrl : mode === 'custom' ? profile?.avatar : null;
      const [failed, setFailed] = React.useState(false);
      React.useEffect(() => setFailed(false), [src]);
      const safe = typeof src === 'string' && (mode === 'account' ? /^https:\/\//.test(src) : src.startsWith(ROUTE + '/chat-profile/avatar?'));
      if (!safe || failed) return null;
      return h('span', { className, role: 'img', 'aria-label': '你的头像', style: { overflow: 'hidden' } },
        h('img', { src, alt: '', draggable: false, referrerPolicy: 'no-referrer', onError: () => setFailed(true),
          style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' } }));
    }
    function PersonaChatLauncher({ sessionId, conversation } = {}) {
      const [open, setOpen] = React.useState(false);
      const [error,setError]=React.useState('');
      React.useEffect(() => {
        const update = () => setOpen(chatRuntime.opened&&!chatRuntime.minimized);
        chatLaunchListeners.add(update);
        update(); return () => chatLaunchListeners.delete(update);
      }, []);
      React.useEffect(()=>{if(sessionId)chatRuntime.foreground(sessionId);},[sessionId]);
      return h(React.Fragment, null,
        h('button', { type: 'button', style: headerButtonStyle, 'aria-haspopup': 'dialog', 'aria-expanded':open, title:error||'打开聊天室', onClick: () => {
          try {chatRuntime.open(sessionId,conversation);setError('');}catch(e){setError(e.message);}
        } }, '聊天室'));
    }
    function useChatContext(sessionId,roomId,paused) {
      const [value,setValue]=React.useState(()=>chatContextCache?.roomId===roomId?chatContextCache:undefined),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false);
      const state=React.useRef({live:false,request:0,sequence:0,viewer:chatNonce(),abort:null,busy:false,value});
      const accept=next=>{state.current.value=next;chatContextCache=next;setValue(next);};
      const action=async(body,quiet=false)=>{
        const own=state.current;if(!own.live||(own.busy&&!quiet))return;
        const token=++own.request;if(!quiet){own.busy=token;setBusy(true);}own.abort?.abort();const abort=new AbortController();own.abort=abort;
        try{
          const response=await fetch(ROUTE+'/chat-context',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
            body:JSON.stringify({...body,roomId,viewer:own.viewer,sequence:++own.sequence,revision:own.value?.revision})});
          const next=await response.json();if(!own.live||token!==own.request)return;
          if(!response.ok){if(next.state?.initialized)accept(next.state);throw Error(next.error);}
          if(body.action!=='sessions')accept(next);setError('');return next;
        }catch(e){if(own.live&&token===own.request&&!abort.signal.aborted)setError(e.message==='context-capacity'
          ?'最多同时接入 6 个会话，请先移除不需要的来源。':e.message==='chat-context-changed'
            ?'参考来源已在其他窗口更新，请核对当前列表后再操作。':'参考信息暂未更新，已有来源保留，可以重试。');}
        finally{if(!quiet&&own.busy===token){own.busy=false;if(own.live)setBusy(false);}}
      };
      React.useEffect(()=>{
        if(paused)return;
        const own=state.current;own.live=true;own.busy=false;setBusy(false);let timer,active=true;
        const loop=async()=>{
          clearTimeout(timer);if(!own.live||document.visibilityState==='hidden')return;
          if(!own.busy){
            if(!own.value?.initialized)await action({action:'open',sessionId,visible:true},true);
            else{
              const token=++own.request;const abort=new AbortController();own.abort?.abort();own.abort=abort;
              try{const r=await fetch(ROUTE+'/chat-context?'+new URLSearchParams({...(roomId?{room:roomId}:{}),viewer:own.viewer,sequence:String(++own.sequence)}),{signal:abort.signal});
                const next=await r.json();if(own.live&&token===own.request){if(r.ok){accept(next);setError('');}else if(r.status===409&&next.error==='context-not-open'){accept(undefined);setError('参考服务需要重新连接，正在重试。');}else{setError('参考信息暂未更新，已有来源保留。');}}}catch{if(own.live&&token===own.request&&!abort.signal.aborted)setError('参考信息暂未更新，已有来源保留。');}
            }
          }
          if(active&&document.visibilityState!=='hidden')timer=setTimeout(loop,15000);
        };
        const presence=()=>{
          clearTimeout(timer);own.abort?.abort();
          if(document.visibilityState==='hidden')void fetch(ROUTE+'/chat-context',{method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({action:'presence',roomId,viewer:own.viewer,sequence:++own.sequence,visible:false})}).catch(()=>{});
          else void action({action:'open',sessionId,visible:true},true).then(()=>{if(active)timer=setTimeout(loop,15000);});
        };
        void action({action:'open',sessionId,visible:document.visibilityState!=='hidden'},true).then(()=>{if(active&&document.visibilityState!=='hidden')timer=setTimeout(loop,15000);});
        document.addEventListener('visibilitychange',presence);
        return()=>{active=false;own.live=false;own.request++;own.abort?.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',presence);
          if(chatContextCache?.roomId===roomId)chatContextCache=undefined;
          void fetch(ROUTE+'/chat-context',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,
            body:JSON.stringify({action:'presence',roomId,viewer:own.viewer,sequence:++own.sequence,visible:false})}).catch(()=>{});};
      },[paused]);
      return{value,error,busy,action};
    }
    const CHAT_ROUND_SEATS=32;
    const CHAT_SILENT_RECEIPTS=8;
    const roomLiveConnections=new Map();
    const roomLiveDisconnects=new Set();
    function subscribeRoomLive(roomId,instance,attempt,listener) {
      const key=JSON.stringify([roomId,instance]);let own=roomLiveConnections.get(key);
      if(!own){
        own={listeners:new Map(),abort:null,generation:0,connected:false,frames:[],live:true,timer:null,delay:750};roomLiveConnections.set(key,own);
        const emit=()=>{for(const update of own.listeners.keys())update(own.frames,own.connected);};
        const needed=()=>[...own.listeners.values()].some(id=>!own.frames.some(f=>f.attemptId===id&&['ready','failed','cancelled','silent'].includes(f.status)));
        own.start=async()=>{
          if(!own.live||own.abort||own.timer!==null||!needed()||document.visibilityState==='hidden')return;
          const token=++own.generation,abort=new AbortController();own.abort=abort;
          try{
            const response=await fetch(ROUTE+'/chat/live?'+new URLSearchParams({room:roomId,batch:'1'}),{signal:abort.signal});
            if(!response.ok||!response.body?.getReader)throw Error('stream-unavailable');
            if(!own.live||token!==own.generation){abort.abort();return;}own.connected=true;emit();
            const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
            try{while(own.live&&token===own.generation&&!abort.signal.aborted){const chunk=await reader.read();if(chunk.done||!own.live||token!==own.generation||abort.signal.aborted)break;
              buffer+=decoder.decode(chunk.value,{stream:true});if(buffer.length>262144)throw Error('stream-too-large');let end;
              while((end=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!event.startsWith('data:'))continue;
                const value=JSON.parse(event.slice(5));if(value.instanceId!==instance||value.roomId!==roomId||!Array.isArray(value.frames)
                  ||value.frames.length>CHAT_ROUND_SEATS+CHAT_SILENT_RECEIPTS||value.frames.filter(frame=>frame?.status==='silent').length>CHAT_SILENT_RECEIPTS
                  ||value.frames.filter(frame=>frame?.status!=='silent').length>CHAT_ROUND_SEATS)continue;
                own.frames=value.frames;if(value.status==='streaming')own.delay=750;emit();if(value.status!=='streaming')return;
              }
            }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
          }catch{/* Canonical snapshot polling remains available. */}
          finally{if(own.live&&token===own.generation){own.abort=null;own.connected=false;emit();
            for(const notify of roomLiveDisconnects)notify(key);
            if(needed()&&document.visibilityState!=='hidden'){
              own.timer=setTimeout(()=>{own.timer=null;void own.start();},own.delay);own.delay=Math.min(8000,own.delay*2);
            }}}
        };
        own.visibility=()=>{own.generation++;clearTimeout(own.timer);own.timer=null;own.abort?.abort();own.abort=null;own.connected=false;own.delay=750;emit();if(document.visibilityState!=='hidden')void own.start();};
        document.addEventListener('visibilitychange',own.visibility);
      }
      own.listeners.set(listener,attempt);listener(own.frames,own.connected);void own.start();
      return()=>{own.listeners.delete(listener);if(!own.listeners.size){own.live=false;own.generation++;clearTimeout(own.timer);own.abort?.abort();
        document.removeEventListener('visibilitychange',own.visibility);roomLiveConnections.delete(key);}};
    }
    function useChatLive(personaId,turn,instance,onFinish,roomId) {
      const [frame,setFrame]=React.useState(null),[connected,setConnected]=React.useState(false);
      const finish=React.useRef(onFinish);finish.current=onFinish;
      const attempt=turn?.status==='pending'?turn.attemptId:undefined;
      React.useEffect(()=>{
        if(!attempt){setConnected(false);return;}
        let live=true,abort,generation=0;setFrame(null);
        if(roomId){let finished=false;const stop=subscribeRoomLive(roomId,instance,attempt,(frames,online)=>{
          if(!live)return;setConnected(online);const value=frames.find(f=>f.attemptId===attempt&&f.personaId===personaId);
          if(!value||value.instanceId!==instance||value.roomId!==roomId||value.turnId!==turn.id||!Number.isSafeInteger(value.revision)||value.revision<0
            ||!['queued','streaming','ready','failed','cancelled','silent'].includes(value.status)
            ||!Array.isArray(value.messages)||value.messages.length>6||value.status==='silent'&&value.messages.length!==0
            ||value.messages.some(m=>typeof m.text!=='string'||m.text.length>2000||typeof m.complete!=='boolean'))return;
          setFrame(previous=>previous?.attemptId===attempt&&previous.revision>value.revision?previous:value);
          if(!['streaming','queued'].includes(value.status)&&!finished){finished=true;finish.current?.();}
        });return()=>{live=false;stop();};}
        let retryTimer,delay=750,terminal=false;
        const start=async()=>{
          if(document.visibilityState==='hidden')return;
          const token=++generation,controller=new AbortController();abort=controller;
          try{
            const response=await fetch(ROUTE+'/chat/live?'+new URLSearchParams({persona:personaId,attempt,...(roomId?{room:roomId}:{})}),{signal:controller.signal});
            if(!response.ok||!response.body?.getReader)throw Error('stream-unavailable');
            if(!live||token!==generation){controller.abort();return;}setConnected(true);
            const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
            try{while(live&&token===generation&&!controller.signal.aborted){const chunk=await reader.read();if(chunk.done||!live||token!==generation)break;buffer+=decoder.decode(chunk.value,{stream:true});
              if(buffer.length>65536)throw Error('stream-too-large');let end;
              while((end=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!event.startsWith('data:'))continue;
                const value=JSON.parse(event.slice(5));if(value.instanceId!==instance||value.personaId!==personaId||value.attemptId!==attempt||value.turnId!==turn.id
                  ||!Number.isSafeInteger(value.revision)||value.revision<0||(roomId&&value.roomId!==roomId))continue;
                if(!['streaming','ready','failed','cancelled','closed','silent'].includes(value.status)||!Array.isArray(value.messages)||value.messages.length>6
                  ||value.status==='silent'&&value.messages.length!==0
                  ||value.messages.some(m=>typeof m.text!=='string'||m.text.length>2000||typeof m.complete!=='boolean'))continue;
                if(live)setFrame(previous=>previous?.attemptId===attempt&&previous.revision>value.revision?previous:value);
                if(value.status!=='streaming'){terminal=value.status!=='closed';if(live)finish.current?.();return;}
                delay=750;
              }
            }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
          }catch{/* The canonical snapshot poller remains the compatibility fallback. */}
          finally{if(live&&token===generation){setConnected(false);if(!terminal&&document.visibilityState!=='hidden'){
            retryTimer=setTimeout(start,delay);delay=Math.min(8000,delay*2);
          }}}
        };
        const visibility=()=>{generation++;clearTimeout(retryTimer);abort?.abort();delay=750;setConnected(false);if(!terminal&&document.visibilityState!=='hidden')void start();};
        void start();document.addEventListener('visibilitychange',visibility);
        return()=>{live=false;generation++;clearTimeout(retryTimer);abort?.abort();document.removeEventListener('visibilitychange',visibility);};
      },[personaId,attempt,instance,roomId]);
      return {frame,connected};
    }
