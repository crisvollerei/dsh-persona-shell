    function chatQuotedSource(room,ref,scope){
      if(!room||!ref||ref.roomId!==room.id||(ref.generation??0)!==(room.generation??0))return null;
      const turn=ref.kind==='user'?room.turns.find(t=>chatUserParts(t).some(part=>part.id===ref.messageId)):room.turns.find(t=>t.id===ref.turnId&&t.attemptId===ref.attemptId);
      if(!turn||(turn.scopeKey??turn.contextKey??null)!==scope)return null;
      const text=ref.kind==='user'?chatUserParts(turn).find(part=>part.id===ref.messageId)?.text:turn.status==='ready'?turn.assistant[ref.index]:null;
      return typeof text==='string'?{turn,text}:null;
    }
    function ChatQuotedMessage({quote,available,onJump,draft=false,onCancel}){
      const [expanded,setExpanded]=React.useState(false),key=JSON.stringify(quote.ref),long=quote.text.length>100||quote.text.includes('\n');
      React.useEffect(()=>setExpanded(false),[key]);
      return h('div',{className:'dsh-persona-chat-quote','data-draft':draft,'data-expanded':expanded,'aria-label':draft?'正在引用的消息':'引用的原消息'},
        h('div',null,h('div',{className:'dsh-persona-chat-quote-heading'},h('strong',null,(draft?'引用 ':'')+(quote.author.role==='user'?'我':quote.author.name)),
          long?h('button',{type:'button','aria-expanded':expanded,'aria-label':expanded?'收起引用全文':'展开引用全文',onClick:()=>setExpanded(!expanded)},expanded?'收起':'全文'):null),
          h('span',{className:'dsh-persona-chat-quote-text',tabIndex:expanded?0:undefined,'aria-label':expanded?'引用原话全文':undefined},quote.text),
          !available?h('small',{role:draft?'status':undefined},'原消息已更改或不在当前参考范围，请重新选择。'):null),
        h('div',{className:'dsh-persona-chat-quote-actions'},onJump?h('button',{type:'button',disabled:!available,'aria-label':'查看引用原消息',title:available?'定位到原消息':'原消息暂不可用',onClick:onJump},'↗'):null,
          draft?h('button',{type:'button','aria-label':'取消引用',title:'取消引用 · Esc',onClick:onCancel},'×'):null));
    }
    function ChatMessageAction({remember=false,label,title,onClick}) {
      // Lucide bookmark and reply, bundled locally; see LICENSE.
      return h('button',{type:'button',className:'dsh-persona-chat-quote-action','aria-label':label,title,onClick},
        h('svg',{width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.8,
          strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:false},
          !remember && h('polyline',{points:'9 17 4 12 9 7'}),
          h('path',{d:remember?'m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z':'M20 18v-2a4 4 0 0 0-4-4H4'})));
    }
    function ChatReplyBubbles({turn,frame,avatar,colorStyle,onPresented,latest=true,running=false,showSpeaker=false,showTyping=true,onQuote}) {
      const animate=latest&&(chatAnimatedAttempts.has(turn.attemptId)||turn.status==='pending');
      const [entrance]=React.useState(()=>animate&&!chatSurfaceMotion);
      const messages=turn.status==='ready'?turn.assistant.map(text=>({text,complete:true}))
        :turn.status==='pending'&&frame?.attemptId===turn.attemptId?frame.messages??[]:[];
      const [count,setCount]=React.useState(()=>animate?1:messages.length);
      const visible=animate?messages.slice(0,count):messages;
      const displayed=visible.map((message,index)=>({message,index})).filter(({message})=>message.text);
      const waiting = (turn.status === 'pending' && running) || (turn.status === 'ready' && animate && count < messages.length);
      const typing = waiting && (!visible.at(-1)?.text || visible.at(-1).complete);
      React.useEffect(()=>{
        if(!animate)return;
        if(turn.status==='pending')markChatAnimation(turn.attemptId);
        if(turn.status!=='pending'&&turn.status!=='ready'){chatAnimatedAttempts.delete(turn.attemptId);return;}
        if(count>=messages.length){if(turn.status==='ready'){chatAnimatedAttempts.delete(turn.attemptId);onPresented?.(turn);}return;}
        if(count===0){setCount(1);return;}
        if(!messages[count-1]?.complete)return;
        const wait=Math.min(500,200+messages[count-1].text.length*5);
        const timer=setTimeout(()=>setCount(n=>n+1),wait);return()=>clearTimeout(timer);
      },[turn.attemptId,turn.status,count,messages.length,messages[Math.max(0,count-1)]?.complete,animate]);
      const portrait=continuation=>continuation?h('span',{className:'dsh-persona-chat-avatar-spacer','aria-hidden':true}):avatar();
      return h(React.Fragment,null,...displayed.map(({message,index},position)=>h('div',{key:index,className:'dsh-persona-chat-message','data-user':'false','data-chat-bubble':index,'data-arriving':entrance||undefined,
        'data-chat-persona':turn.recipientId,style:colorStyle,
        'data-chat-continuation':position>0||undefined,'data-provisional':turn.status==='pending'},portrait(position>0),h('div',{className:'dsh-persona-chat-bubble','data-live':!message.complete},
          showSpeaker&&position===0?h('small',{className:'dsh-persona-chat-speaker'},turn.speakerName):null,
          h('div',{className:'dsh-persona-chat-body'},renderMarkdown(message.text,turn.status==='pending'&&!message.complete,{margin:0}))),
          onQuote&&turn.status==='ready'?h(ChatMessageAction,{label:'引用'+turn.speakerName+'的第'+(index+1)+'条消息',title:'引用这句；回复对象仍按 @ 选择',onClick:()=>onQuote(turn,index,message.text)}):null)),
        typing&&showTyping ? h('div', { key:visible.length, className:'dsh-persona-chat-message dsh-persona-chat-typing', 'data-user':'false',
          'data-chat-persona':turn.recipientId,style:colorStyle,
          'data-chat-continuation':displayed.length>0||undefined,role:'status','aria-label':turn.status==='pending'?'角色输入中':'还有后续消息','aria-live':'polite','aria-atomic':true }, portrait(displayed.length>0),
          h('div',{className:'dsh-persona-chat-bubble'},turn.status==='pending'?'输入中':'',h('span',{className:'dsh-persona-chat-typing-dots','aria-hidden':true},h('span',null,'...')))) : null);
    }
    function chatDateBoundary(at,previous){
      const next=new Date(at),before=new Date(previous);if(!Number.isFinite(next.getTime())||!Number.isFinite(before.getTime()))return false;
      return next.getFullYear()!==before.getFullYear()||next.getMonth()!==before.getMonth()||next.getDate()!==before.getDate();
    }
    function chatMessageTime(at,now=Date.now()){
      if(!Number.isFinite(at))return null;const date=new Date(at);if(!Number.isFinite(date.getTime()))return null;
      const today=new Date(now),yesterday=new Date(now);yesterday.setDate(yesterday.getDate()-1);
      const pad=value=>String(value).padStart(2,'0'),clock=pad(date.getHours())+':'+pad(date.getMinutes());
      const day=date.getFullYear()+'/'+(date.getMonth()+1)+'/'+date.getDate(),full=day+' '+clock+':'+pad(date.getSeconds());
      const label=!chatDateBoundary(at,today.getTime())?clock:!chatDateBoundary(at,yesterday.getTime())?'昨天 '+clock:day+' '+clock;
      return{label,title:full,dateTime:date.toISOString()};
    }
    function ChatMessageTime({at,now}){
      const value=chatMessageTime(at,now);return value?h('p',{className:'dsh-persona-chat-time'},h('time',{dateTime:value.dateTime,title:value.title,'aria-label':value.title},value.label)):null;
    }
    function chatClientTime(){
      const value={};try{const offset=-new Date().getTimezoneOffset();if(Number.isInteger(offset)&&Math.abs(offset)<=840)value.utcOffsetMinutes=offset;}catch{}
      try{const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;if(typeof zone==='string'&&zone.length>0&&zone.length<=80&&!/[\s\u0000-\u001f\u007f]/u.test(zone))value.timeZone=zone;}catch{}
      return Object.keys(value).length?value:undefined;
    }
    const memoryTagList = value => [...new Set(value.trim().split(/[\s,，、]+/u).filter(Boolean))];
    function suggestedMemoryTags(text) {
      if (!Intl.Segmenter) return '';
      const words = [...new Intl.Segmenter('zh',{granularity:'word'}).segment(text)].filter(s=>s.isWordLike)
        .map(s=>s.segment).filter(s=>s.length>=2 && s.length<=12 && !/^(?:以后|今天|昨天|我们|你们|他们|希望|一起|觉得|可以|还是|一下|就是|一个|已经|不要|自己)$/u.test(s));
      return [...new Set(words)].slice(0,3).join('，');
    }
    function MemoryMetadataFields({value, change}) {
      return h(React.Fragment,null,h('label',null,'标签（最多 6 个）',h('input',{value:value.tags??'',onChange:e=>change({tags:e.target.value}),placeholder:'用逗号或空格分隔'})),
        h('label',null,'有效期',h('select',{'aria-label':'有效期',value:value.ttl??'',onChange:e=>change({ttl:e.target.value})},...['','7','30','long'].map((id,i)=>h('option',{key:id,value:id},['默认','7 天','30 天','长期'][i])))),
        h('label',null,'发生日期（可选）',h('input',{type:'date',value:value.date??'',onChange:e=>change({date:e.target.value})})));
    }
    function memoryMetadata(value) {
      return {tags:memoryTagList(value.tags??''),expiresAt:value.ttl==='long'?null:value.ttl?Date.now()+Number(value.ttl)*86400000:undefined,
        occurredAt:value.date?new Date(value.date+'T00:00:00').getTime():undefined};
    }
    function RememberChatPart({room, contacts, head, part, scopeKey, onClose}) {
      const [content,setContent]=React.useState(part.text.slice(0,240)), [kind,setKind]=React.useState('agreement');
      const [target,setTarget]=React.useState(head.recipients.find(p=>room.memberIds.includes(p.id))?.id??room.memberIds[0]);
      const [busy,setBusy]=React.useState(false), [error,setError]=React.useState('');
      const [selection,setSelection]=React.useState(null),[excerpt,setExcerpt]=React.useState(null);
      const [meta,setMeta]=React.useState(()=>({tags:suggestedMemoryTags(part.text)}));
      const [includeReply,setIncludeReply]=React.useState(false);
      const [capacityData,setCapacityData]=React.useState(null);
      async function organize(action){
        setBusy(true);try{const result=await fetch(ROUTE+'/memory',action?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(action)}:undefined);
          if(!result.ok)throw Error();setCapacityData(await result.json());}catch{setError('整理未完成，请重新读取当前记录。');}finally{setBusy(false);}}
      const save=async event=>{
        event.preventDefault(); if (busy || !content.trim()) return;
        const form = event.currentTarget;
        setBusy(true); setError('');
        try {
          const response=await fetch(ROUTE+'/chat/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
            room:room.id,generation:room.generation,scopeKey,messageId:head.messageId,part:head.userParts?.findIndex(p=>p.id===part.id)??0,
            kind,scope:target?'persona':'room',personaId:target||undefined,content,includeReply,...memoryMetadata(meta),...excerpt})});
          const value=await response.json(); if (!response.ok) throw Error(value.capacity?'记忆已满（200 条）。请到设置 → 记忆管理整理。可清理 '+value.capacity.cleanable+' 条，相近 '+value.capacity.groups+' 组。':value.error);
          if (form.isConnected) onClose(true);
        } catch (e) {setBusy(false);setError(({'chat-memory-source':'原话或参考范围已变化，请重新选择。','chat-memory-member':'这位人格已离开房间。',
          'memory-disabled':'请先在设置中开启记忆。','invalid-memory-tags':'最多 6 个标签，每个最多 32 字。'})[e.message]??(e.message.startsWith('记忆已满')?e.message:'未能保存，请重试。'));}
      };
      const returnToForm=()=>{setCapacityData(null);setError('');};
      if(capacityData)return h('section',{role:'dialog','aria-label':'整理记忆',className:'dsh-persona-chat-info',onKeyDown:e=>{
        if(e.key==='Escape'&&!e.nativeEvent?.isComposing){e.stopPropagation();e.preventDefault();if(!busy)returnToForm();}}},h('h3',null,'记忆占用 '+capacityData.capacity.used+' / '+capacityData.capacity.limit),
        h(CapacityTools,{data:capacityData,write:organize,busy}),h('button',{type:'button',autoFocus:true,disabled:busy,onClick:returnToForm},'返回记住这句'),!error.startsWith('记忆已满')?h('p',{role:'status'},error):null);
      return h('form',{onSubmit:save,role:'dialog','aria-label':'记住这句',className:'dsh-persona-chat-info',style:{display:'grid',gap:6,minWidth:0},
        onKeyDown:e=>{if(e.key==='Escape'&&!e.nativeEvent?.isComposing){e.stopPropagation();if(!busy)onClose(false);}}},h('strong',null,'记住这句'),
        h('label',null,'原话',h('textarea',{readOnly:true,value:part.text,style:{width:'100%',boxSizing:'border-box'},onSelect:e=>{
          const {selectionStart:start,selectionEnd:end}=e.currentTarget;setSelection(start<end && (start>0||end<part.text.length)?{start,end}:null);}})),
        excerpt?h('div',null,h('blockquote',null,part.text.slice(excerpt.start,excerpt.end)),h('span',null,'所选片段仅留档核对，不会自动带入聊天。要在聊天中使用，请选择整段原话。'),
          h('button',{type:'button',onClick:()=>setExcerpt(null)},'使用整段原话')):selection?h('button',{type:'button',onClick:()=>setExcerpt(selection)},'以所选片段为依据'):null,
        h('label',null,'类型 ',h('select',{autoFocus:true,value:kind,onChange:e=>setKind(e.target.value)},h('option',{value:'agreement'},'约定'),h('option',{value:'episode'},'经历'))),
        h('label',null,'范围 ',h('select',{value:target,onChange:e=>setTarget(e.target.value)},...room.memberIds.map(id=>h('option',{key:id,value:id},'只限 '+(contacts.find(p=>p.id===id)?.name??id))),h('option',{value:''},'本房间所有成员'))),
        h('label',null,'内容',h('textarea',{style:{width:'100%',boxSizing:'border-box'},maxLength:240,value:content,onChange:e=>setContent(e.target.value)})),
        h('details',null,h('summary',null,'标签与日期'),h(MemoryMetadataFields,{value:meta,change:patch=>setMeta({...meta,...patch})})),
        room.turns.some(t=>t.messageId===head.messageId && t.phase!=='anchor' && t.status==='ready' && t.assistant?.length)?h('label',null,h('input',{type:'checkbox',checked:includeReply,onChange:e=>setIncludeReply(e.target.checked)}),'附上紧邻回复供设置页核对'):null,
        error?h('span',{role:'alert'},error):null,error.startsWith('记忆已满')?h('button',{type:'button',disabled:busy,onClick:()=>organize()},'去整理'):null,
        h('div',null,h('button',{type:'button',disabled:busy,onClick:()=>onClose(false)},'取消'),h('button',{type:'submit',disabled:busy||!content.trim()},'记住')));
    }
    function ReplyMemory({roomId,turn,count,revision}) {
      const [open,setOpen]=React.useState(false),[record,setRecord]=React.useState(null),[error,setError]=React.useState('');
      const [edit,setEdit]=React.useState(null),[busy,setBusy]=React.useState(false),[refresh,setRefresh]=React.useState(0);
      React.useEffect(()=>{
        if (!open) return;
        const abort=new AbortController();setRecord(null);setEdit(null);setError('');
        (async()=>{const res=await fetch(ROUTE+'/chat-references?room='+encodeURIComponent(roomId),{signal:abort.signal});
          if (!res.ok) throw Error();const data=await res.json();if(abort.signal.aborted)return;
          setRecord(data.records.find(r=>r.inScope && r.attemptId===turn.attemptId && r.messageId===turn.messageId)??{memory:[]});
        })().catch(()=>{if(!abort.signal.aborted)setError('暂时读不到参考记录。');});return ()=>abort.abort();
      },[roomId,turn.attemptId,revision,open,refresh]);
      const submit=async e=>{e.preventDefault();if(busy)return;const fields=e.currentTarget.elements;setBusy(true);setError('');
        const write=async body=>{const res=await fetch(ROUTE+'/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!res.ok)throw Error();return (await res.json()).result;};
        try {const op=await write({action:'propose',operation:edit.op,id:edit.ref.id,version:edit.ref.version,
          statement:fields.statement?.value??'用户在回复中撤销了这条记忆',content:fields.content?.value});
          await write({action:'confirm',id:op.id,version:op.version});setEdit(null);setRefresh(v=>v+1);
        }catch{setError('未能保存，请重新核对当前版本。');}finally{setBusy(false);}};
      return h('details',{onToggle:e=>{if(e.target===e.currentTarget)setOpen(e.currentTarget.open);},style:{maxWidth:'100%',overflowWrap:'anywhere'}},
        h('summary',null,'参考了 '+count+' 条记忆'),open?h('div',null,...(record?.memory??[]).filter(r=>r.personal).map(ref=>h('div',{key:ref.id},ref.available?h(React.Fragment,null,
          h('p',null,ref.content+' · '+(ref.scope==='persona'?'只限 '+record.personaName:'本房间')+(ref.recordedAt?' · '+new Date(ref.recordedAt).toLocaleDateString():'')),
          ...ref.evidence.map((q,i)=>h('blockquote',{key:i},q)),h('button',{type:'button',disabled:busy,onClick:()=>setEdit({op:'revise',ref})},'这条不对'),h('button',{type:'button',disabled:busy,onClick:()=>setEdit({op:'retract',ref})},'不再用于聊天')):ref.status??'原版本已不可用')),
          edit?h('form',{key:edit.ref.id+edit.op,onSubmit:submit},edit.op==='revise'?h(React.Fragment,null,h('label',null,'更正内容',h('textarea',{required:true,name:'content',maxLength:240,defaultValue:edit.ref.content})),h('label',null,'更正说明',h('input',{name:'statement',required:true,maxLength:1000}))):h('p',null,'撤销后，这条记忆在原适用范围内停用。'),
            h('button',{disabled:busy},edit.op==='revise'?'确认更正':'确认撤销'),h('button',{type:'button',disabled:busy,onClick:()=>setEdit(null)},'取消')):null,
          error?h('span',{role:'status'},error):null):null);
    }
    function ChatImages({images,roomId,generation=0}){
      const [failed,setFailed]=React.useState({});
      if(!Array.isArray(images)||!images.length||!roomId)return null;
      return h('div',{className:'dsh-persona-chat-images','aria-label':'用户附图'},...images.map((image,index)=>{
        const src=ROUTE+'/chat-image?room='+encodeURIComponent(roomId)+'&generation='+generation+'&id='+encodeURIComponent(image.attachmentId);
        return failed[image.attachmentId]?h('span',{key:image.attachmentId+':'+index,role:'status'},'图片暂时无法读取'):
          h('a',{key:image.attachmentId+':'+index,href:src,target:'_blank',rel:'noopener noreferrer','aria-label':'查看图片 '+(index+1)},
            h('img',{src,alt:image.name||'用户图片 '+(index+1),loading:'lazy',onError:()=>setFailed(old=>({...old,[image.attachmentId]:true}))}));
      }));
    }
    function chatUserParts(turn){
      const parts=turn?.userParts;
      if(Array.isArray(parts)&&!parts.length)return[];
      return Array.isArray(parts)&&parts.length&&parts.every(part=>part&&chatUiId(part.id)&&typeof part.text==='string'&&part.text.length<=4000&&Number.isFinite(part.at))
        ?parts:[{id:turn?.messageId,text:turn?.user??'',at:turn?.at}];
    }
    const chatSupportRequestPrefixes={research:'请先调查公开资料，附上来源，再回答下面的问题：\n',reason:'请使用深入推演，分析下面的问题与关键条件：\n'};
    const chatSupportCards = {
      research:{name:'调查资料',setting:'chatResearchEnabled',description:'联网查公开网页，带回来源。',request:'调查请求'},
      reason:{name:'深入推演',setting:'chatDeepReasoningEnabled',description:'用思考模式分析条件与取舍，不联网。',request:'推演请求'},
      summarize:{name:'整理工作参考',setting:'chatSummarizeEnabled',description:'梳理已接入会话的目标、报告和上轮结果。'},
    };
    function ChatSupportMenu({id,capabilities,disabled,busy,notice,onToggle,onInsert,onClose}){
      const known=typeof capabilities?.research==='boolean'&&typeof capabilities?.reason==='boolean';
      return h('section',{id,'aria-label':'聊天室子代理能力','aria-busy':busy,style:{padding:'8px 10px',marginBottom:7,border:'1px solid var(--chat-border)',borderRadius:8,background:'var(--chat-soft)',fontSize:12,maxHeight:'min(240px,30vh)',overflowY:'auto',overflowWrap:'anywhere'}},
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}},h('strong',null,'子代理辅助'),h('button',{type:'button','aria-label':'收起子代理入口',onClick:onClose},'收起')),
        h('p',{style:{margin:'4px 0 7px',fontSize:11,color:'var(--chat-muted)'}},'发送消息后，成员可按需调查、推演或整理会话参考。'),
        h('div',{style:{display:'flex',flexWrap:'wrap',gap:8}},...Object.entries(chatSupportCards).filter(([id])=>id!=='summarize'||typeof capabilities?.summarize==='boolean').map(([template,card])=>{
          const {name,description,request}=card,enabled=capabilities?.[template]===true,available=template!=='research'||capabilities?.searchService===true;
          return h('div',{key:template,style:{flex:'1 1 180px',minWidth:0,padding:7,border:'1px solid var(--chat-border)',borderRadius:6}},
            h('strong',null,name),h('p',{style:{margin:'3px 0',fontSize:11}},description),
            h('label',{style:{display:'flex',alignItems:'center',gap:5,fontSize:11,margin:'5px 0'}},h('input',{type:'checkbox',checked:enabled,disabled:disabled||busy||!known||!available&&!enabled,'aria-label':'允许按需'+name,onChange:e=>void onToggle(template,e.target.checked)}),'允许按需调用'),
            !available?h('p',{style:{margin:'3px 0',fontSize:11}},'当前宿主没有搜索服务，暂不能调查资料。'):null,
            request?h('button',{type:'button',disabled:disabled||busy||!known||!available,onClick:()=>void onInsert(template)},(enabled?'填入':'启用并填入')+request):null);
        })),
        h('p',{style:{margin:'6px 0 0',fontSize:11,color:'var(--chat-muted)'}},'开关对所有聊天室生效，开启后也可由判断线程按需使用。更多模型配置见插件设置 → 聊天室。'),
        !known?h('p',{role:'status',style:{margin:'5px 0 0'}},'辅助能力状态暂未就绪，请稍后重试。'):null,
        busy?h('p',{role:'status',style:{margin:'5px 0 0'}},'正在保存辅助设置…'):null,
        notice?h('p',{role:'status',style:{margin:'5px 0 0'}},notice):null);
    }
    function ChatSupportStatus({tasks=[],onStop,minimized=false}){
      const task=tasks.find(t=>t.status==='running')??tasks.at(-1),[,tick]=React.useState(0);
      const received=React.useRef({id:null,elapsed:0,at:0});
      if(task&&(received.current.id!==task.id||received.current.elapsed!==task.elapsedMs))received.current={id:task.id,elapsed:task.elapsedMs??0,at:Date.now()};
      React.useEffect(()=>{if(!task||task.status!=='running'||minimized)return;const timer=setInterval(()=>tick(v=>v+1),1000);return()=>clearInterval(timer);},[task?.id,task?.status,minimized]);
      if(!task)return null;
      const name=chatSupportCards[task.template]?.name??'辅助任务',running=task.status==='running';
      const stages={preparing:'准备任务',thinking:'整理检索方向',searching:'正在搜索',reading:'正在阅读网页',reasoning:'正在深入推演',summarizing:'正在整理会话原文'};
      const terminal={completed:'已完成',partial:'部分完成',failed:'未完成',cancelled:'已停止',interrupted:'上次任务已中断'};
      const errors={timeout:'已到时间上限',budget:'已到调用上限',format:'结果格式未通过检查',capacity:'其他辅助任务正在运行',unavailable:'模型、搜索或网络暂不可用',
        stale:'原话或参考已变化',cancelled:'已停止',interrupted:'没有自动重跑', 'save-failed':'任务记录暂未保存',
        'reference-unavailable':'本次暂未取得可整理的工作会话原文。','thinking-unavailable':'当前模型无法启用已声明的思考模式，请在设置中选择支持思考的推演模型。'};
      const elapsed=Math.max(0,(received.current.elapsed??0)+(running?Date.now()-received.current.at:0));
      return h('section',{className:'dsh-persona-support', 'aria-label':'聊天室辅助任务',style:{flex:'none',margin:'4px 12px',padding:'7px 9px',border:'1px solid var(--chat-border,#dce3eb)',borderRadius:8,fontSize:11,color:'var(--chat-muted)',overflowWrap:'anywhere'}},
        h('div',{style:{display:'flex',alignItems:'center',gap:'4px 8px',flexWrap:'wrap'}},
          h('span',{role:'status','aria-live':'polite'},(task.actorName?task.actorName+' · ':'')+name+' · '+(running?stages[task.stage]??'进行中':terminal[task.status]??'未完成')),
          h('span',{'aria-hidden':true},Math.floor(elapsed/1000)+' 秒'),
          running?h('button',{type:'button',onClick:()=>onStop(task.id),'aria-label':'停止'+name,style:{marginInlineStart:'auto',font:'inherit',padding:'2px 7px',cursor:'pointer'}},'停止'):null),
        task.error?h('p',{style:{margin:'3px 0 0'}},errors[task.error]??'本次任务未完整完成；不会当作已经查明。'):null,
        h('details',null,h('summary',{style:{cursor:'pointer',marginTop:3}},'任务详情'),
          h('p',{style:{margin:'4px 0'}},task.goal),
          h('p',{style:{margin:'4px 0'}},task.countsIncomplete?'上次任务中断，计数可能未完整保存；不会自动重跑。':'模型步骤 '+(task.counts?.calls??0)+' / '+(task.limits?.calls??4)
            +(task.template==='research'?' · 搜索 '+(task.counts?.searches??0)+' / '+(task.limits?.searches??3)+' · 阅读 '+(task.counts?.reads??0)+' / '+(task.limits?.reads??4):' · 未联网')),
          task.model?h('p',{style:{margin:'4px 0'}},'模型：'+task.model.model+(task.model.provider?' · '+task.model.provider:'')+(task.model.thinking?' · 思考：'+task.model.thinking:'')):null,
          ...(task.sources??[]).filter(s=>typeof s.url==='string'&&/^https:\/\//u.test(s.url)).map((source,i)=>h('p',{key:i,style:{margin:'4px 0'}},h('a',{href:source.url,target:'_blank',rel:'noopener noreferrer'},source.title||source.url)))));
    }

    function SlowChatStatus({data,minimized}){
      const [clock,setClock]=React.useState(Date.now()),[visible,setVisible]=React.useState(document.visibilityState!=='hidden');
      const anchor=React.useRef({id:null,elapsed:0,at:Date.now()});
      const reported=Math.max(0,Number(data?.roundElapsedMs)||0);
      if(anchor.current.id!==data?.roundId||reported!==anchor.current.reported)anchor.current={id:data?.roundId,reported,elapsed:reported,at:Date.now()};
      React.useEffect(()=>{const update=()=>setVisible(document.visibilityState!=='hidden');document.addEventListener('visibilitychange',update);return()=>document.removeEventListener('visibilitychange',update);},[]);
      React.useEffect(()=>{if(!data?.running||!data.roundId||minimized||!visible)return;setClock(Date.now());const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[data?.running,data?.roundId,minimized,visible]);
      if(!data?.running||!data.roundId||minimized||!visible)return null;
      const elapsed=Math.max(reported,anchor.current.elapsed+clock-anchor.current.at);if(elapsed<8000)return null;
      const active=data.room?.turns.find(turn=>turn.status==='pending'&&data.activeAttemptIds?.includes(turn.attemptId));
      const stage=data.roundPhase==='preparing'?'还在准备这次回应…':data.roundPhase==='listening'?'还在等这一轮的后续回应…':active?'还在等'+active.speakerName+'的回复…':'还在接收本轮回应…';
      const timing='本轮已用时 '+Math.floor(elapsed/1000)+' 秒',model=typeof data.roundModel?.model==='string'?data.roundModel.model:null;
      return h('details',{className:'dsh-persona-chat-wait','aria-label':'本轮等待情况',title:timing+(model?' · 模型 '+model:'')},
        h('summary',null,stage),h('span',null,timing,model?' · 当前调用模型：'+model+(data.roundModel.provider?'（'+data.roundModel.provider+'）':''):' · 尚未取得模型信息'));
    }
    function ChatExpandIcon({ expanded }) {
      return h('svg', { width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,
        strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:false },
        h('path', { d:expanded ? 'M20 4l-6 6M14 4v6h6M4 20l6-6M4 14h6v6' : 'M14 4h6v6M20 4l-6 6M10 20H4v-6M4 20l6-6' }));
    }
    function ChatTurnReply({turn,instance,roomId,running,started,onFinish,onSilent,held,...props}) {
      const live=useChatLive(turn.recipientId,turn,instance,onFinish,roomId);
      const silent=live.frame?.attemptId===turn.attemptId&&live.frame.status==='silent';
      useLayoutEffect(()=>{if(silent)onSilent?.(turn);},[silent,turn.attemptId]);
      return held||silent?null:h(ChatReplyBubbles,{...props,turn,showTyping:!roomId,running:running&&(live.frame?live.frame.status==='streaming':started),frame:live.frame});
    }
    function chatMemberStatus(data,id){
      const state=data?.running&&data.memberActivity?.find(item=>item.id===id)?.state;
      if(!['listening','typing'].includes(state))return null;
      const text=state==='typing'?'输入中':'在听',elapsed=(Number.isFinite(data.roundElapsedMs)?' · 本轮 '+Math.floor(Math.max(0,data.roundElapsedMs)/1000)+' 秒':'')
        +(Number.isFinite(data.roundFirstTextMs)?' · 首字 '+(data.roundFirstTextMs/1000).toFixed(1)+' s':'');
      const model=typeof data.roundModel?.model==='string'?' · 模型 '+data.roundModel.model:'';
      return {state,text,detail:text+elapsed+model};
    }
    function ChatMemberActivity({status,name}){
      return status?h('span',{className:'dsh-persona-chat-member-activity','data-state':status.state,role:'status','aria-live':'polite','aria-label':name+'：'+status.text,title:status.detail},
        ...Array.from({length:status.state==='typing'?3:1},(_,index)=>h('i',{key:index,'aria-hidden':true}))):null;
    }
    function RoomAvatar({ memberIds = [], contacts = [] }) {
      const count=memberIds.length,visible=memberIds.slice(0,count>4?3:4);
      const layout=count===1?[[50,50,82,0]]:count===2?[[32,32,64,-2],[68,68,64,2]]
        :count===3?[[27,27,55,-2],[73,27,55,2],[50,73,55,0]]:[[25,25,46,0],[75,25,46,0],[25,75,46,0],[75,75,46,0]];
      const position=index=>{const [left,top,size,angle]=layout[index];return{left:left+'%',top:top+'%',width:size+'%',height:size+'%',
        '--tile-angle':angle+'deg',zIndex:index+1};};
      const names=memberIds.map(id=>contacts.find(p=>p.id===id)?.name??'已移除的人格');
      return h('span',{className:'dsh-persona-room-avatar','data-count':String(count),'data-visible-count':String(visible.length),role:'img',
        'aria-label':count?'聊天室成员：'+names.join('、')+'，共 '+count+' 位':'暂无成员的聊天室'},
        ...visible.map((id,index)=>{const person=contacts.find(p=>p.id===id);return h('span',{key:id,'aria-hidden':true,
          className:'dsh-persona-room-avatar-tile',style:position(index)},h(PersonaAvatar,{id,name:person?.name??'角色',src:person?.avatar,
            style:{display:'grid',placeItems:'center',width:'100%',height:'100%',borderRadius:'inherit',background:'var(--chat-soft)',
              color:'var(--chat-text)',fontSize:'var(--room-avatar-letter)'}}));}),
        count>4?h('span',{className:'dsh-persona-room-avatar-tile dsh-persona-room-avatar-more','aria-hidden':true,style:position(3)},'+'+(count-3)):null);
    }
    function RoomRecipient({ contacts, memberIds, value, disabled, onChange,activityData }) {
      const root=React.useRef(null);
      if(memberIds.length<2)return null;
      const targets=value.filter(id=>memberIds.includes(id)&&contacts.some(p=>p.id===id&&!p.archived));
      return h('div',{className:'dsh-persona-chat-recipient',ref:root,role:'group','aria-label':'回复对象','aria-description':targets.length?'已选 '+targets.length+' 位，第一位优先回应，其余按顺序关注':'发给房间，未指定回复对象','data-density':memberIds.length>6?'large':memberIds.length>4?'medium':'small',title:'不点名时发给房间；第一位点名对象优先，其余依次关注',onKeyDown:e=>{
        if(disabled||!['ArrowRight','ArrowLeft','ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
        e.preventDefault();const options=[...root.current.querySelectorAll('[role=checkbox]:not(:disabled)')];
        if(!options.length)return;const index=options.indexOf(document.activeElement);
        const next=e.key==='Home'?0:e.key==='End'?options.length-1:(index+(['ArrowRight','ArrowDown'].includes(e.key)?1:-1)+options.length)%options.length;
        options[next].focus({preventScroll:true});
      }},
        !targets.length?h('small',{className:'dsh-persona-chat-recipient-broadcast'},
          h('span',{className:'dsh-persona-chat-recipient-broadcast-full'},'发给房间'),h('span',{className:'dsh-persona-chat-recipient-broadcast-short'},'房间')):null,
        ...memberIds.map(id=>{const person=contacts.find(p=>p.id===id),selected=targets.includes(id);
        const order=selected&&targets.length>1?targets.indexOf(id)+1:undefined,status=chatMemberStatus(activityData,id);
        const hint=person?.archived?'这位角色已移除':selected?targets.indexOf(id)===0?'优先回应，点击取消 @'+person.name:'第 '+order+' 位关注对象，点击取消 @'+person.name:'同时 @'+(person?.name??'角色');
        return h('button',{
        key:id,type:'button',role:'checkbox',className:'dsh-persona-chat-recipient-option','aria-label':person?.name??'已移除的人格',
        'aria-checked':selected,'aria-description':hint+(status?' · '+status.text:''),disabled:disabled||!person||person.archived,
        title:(person?.name??'已移除的人格')+' · '+hint+(status?' · '+status.detail:''),onClick:()=>{const next=selected?targets.filter(p=>p!==id):[...targets,id];void onChange(next);}},
        h('span',{className:'dsh-persona-chat-recipient-portrait','data-order':order},h(PersonaAvatar,{id,name:person?.name??'已移除的人格',src:person?.avatar,className:'dsh-persona-chat-avatar'}),h(ChatMemberActivity,{status,name:person?.name??'角色'})),
        h('span',{className:'dsh-persona-chat-recipient-name'},((id==='大肥鱼（默认）'&&person?.name==='大肥鱼（默认）')?'大肥鱼':(id==='鲸鲸（实验性）'&&person?.name==='小肥鱼（实验性）')?'小肥鱼':person?.name??'已移除的人格')+(person?.archived?'（已移除）':'')));}));
    }
    function roomReferenceHint(context, foreground) {
      if (!context?.initialized) return { text: '连接中', title: '正在初始化参考来源', different: false };
      const sources = Array.isArray(context.sources) ? context.sources : [];
      const primary = sources.find(source => source.sessionId === context.primarySessionId) ?? sources[0];
      const name = typeof primary?.name === 'string' ? primary.name.trim() : '';
      const different = !!foreground && !!primary?.sessionId && foreground !== primary.sessionId;
      const names = sources.map(source => typeof source.name === 'string' ? source.name.trim() : '').filter(Boolean);
      return {
        text: name ? (different ? '固定 · ' : '来源 · ') + name + (sources.length > 1 ? ' +' + (sources.length - 1) : '') : '来源 · ' + sources.length,
        title: '固定参考 · ' + (names.length ? names.join('、') : sources.length + ' 个会话')
          + '。切换工作页不会更换来源。' + (different ? '主要参考与当前工作页不同。' : ''),
        different,
      };
    }

    function WorkDraftPanel({roomId,scopeKey,generation,referenceRevision,discussionRevision,onClose,onMinimize}){
      const [saved,setSaved]=React.useState(()=>chatWorkDrafts.get(roomId)??{instruction:'',refs:[],draft:'',basis:null});
      const [data,setData]=React.useState(null),[loading,setLoading]=React.useState(false),[busy,setBusy]=React.useState(false),[placing,setPlacing]=React.useState(false);
      const [info,setInfo]=React.useState(''),[filter,setFilter]=React.useState(''),[confirmation,setConfirmation]=React.useState(null),[,redraw]=React.useState(0);
      const own=React.useRef({live:true,token:0,abort:null,requestId:null,busy:false,editing:0}),state=React.useRef(saved),output=React.useRef(null),heading=React.useRef(null);
      const confirmationRoot=React.useRef(null),draftAction=React.useRef(null),conclusionAction=React.useRef(null);
      useLayoutEffect(()=>{if(confirmation)confirmationRoot.current?.querySelector('button')?.focus();},[confirmation]);
      const cancelConfirmation=()=>{const action=confirmation?.intent.mode==='conclusion'?conclusionAction:draftAction;setConfirmation(null);action.current?.focus({preventScroll:true});};
      state.current=saved;
      const refKey=ref=>JSON.stringify(ref),choices=data?.choices??[],selected=saved.refs.map(ref=>choices.find(q=>refKey(q.ref)===refKey(ref)));
      const unavailable=selected.filter(q=>!q).length,available=selected.filter(Boolean);
      const keep=value=>{state.current=value;keepDraft(chatWorkDrafts,roomId,value);setSaved(value);};
      const stop=(update=true)=>{const current=own.current,id=current.requestId;current.token++;current.abort?.abort();current.abort=null;current.requestId=null;current.busy=false;
        if(id)void fetch(ROUTE+'/chat-work-draft',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,body:JSON.stringify({action:'cancel',roomId,requestId:id})}).catch(()=>{});
        if(update&&current.live){setBusy(false);setPlacing(false);setLoading(false);setConfirmation(null);}};
      const load=async()=>{
        if(own.current.busy)return;const current=own.current,token=++current.token;current.abort?.abort();const abort=new AbortController();current.abort=abort;
        let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;abort.abort();},10000);
        setLoading(true);setInfo('');setData(null);setConfirmation(null);
        try{const response=await fetch(ROUTE+'/chat-work-draft?room='+encodeURIComponent(roomId),{signal:abort.signal}),value=await response.json();
          if(!response.ok)throw Error(value.error);if(value.room?.id!==roomId||!Array.isArray(value.choices))throw Error('invalid');
          if(current.live&&current.token===token&&!abort.signal.aborted)setData(value);
        }catch{if(current.live&&current.token===token&&(!abort.signal.aborted||timedOut))setInfo('暂时无法读取原话，草稿保留。请重试。');}
        finally{clearTimeout(timeout);if(current.live&&current.token===token)setLoading(false);}
      };
      React.useEffect(()=>{own.current.live=true;heading.current?.focus({preventScroll:true});void load();
        const refresh=()=>redraw(v=>v+1);workInputListeners.add(refresh);chatForegroundListeners.add(refresh);
        return()=>{own.current.live=false;stop(false);workInputListeners.delete(refresh);chatForegroundListeners.delete(refresh);};},[]);
      const context=React.useRef({scopeKey,generation,referenceRevision,discussionRevision});
      React.useEffect(()=>{const previous=context.current;context.current={scopeKey,generation,referenceRevision,discussionRevision};
        if(previous.scopeKey===scopeKey&&previous.generation===generation&&previous.referenceRevision===referenceRevision&&previous.discussionRevision===discussionRevision)return;
        stop();setData(null);setInfo('房间参考或讨论状态已变化，请刷新核对原话。已有草稿保留。');
      },[scopeKey,generation,referenceRevision,discussionRevision]);
      const edit=value=>{own.current.editing++;setConfirmation(null);keep({...state.current,...value});};
      const sameBasis=(basis,expected)=>basis?.roomId===roomId&&basis.scopeKey===expected.scopeKey&&basis.epoch===expected.epoch
        &&(basis.referenceRevision??0)===(expected.referenceRevision??0)&&basis.discussionRevision===expected.discussionRevision&&JSON.stringify(basis.refs)===JSON.stringify(expected.refs);
      const emptyInput=value=>value?.phase==='plain'&&value.draft===''
        &&Array.isArray(value.attachmentIds)&&value.attachmentIds.length===0&&Array.isArray(value.occurrences)&&value.occurrences.length===0;
      const captureTarget=()=>{
        const fixed=chatForegroundSession,adapter=workInputBindings.get(fixed),snapshot=adapter?.state;
        if(!fixed||!adapter){setInfo('工作输入框暂不可用。可先整理草稿并复制。');return null;}
        if(!emptyInput(snapshot)){setInfo('工作输入框已有文字、附件或正在发送。请先处理原输入，也可以只整理草稿。');return null;}
        let span;try{span=adapter.actions.captureInsertion();}catch{setInfo('工作输入框暂不可用，草稿保留，可以复制。');return null;}
        if(span?.start!==0||span.end!==0||span.draftRev!==snapshot.draftRev){setInfo('工作输入框已变化，请重新核对后再试。');return null;}
        const captured = {fixed,adapter,span,title:adapter.title||'当前工作会话'};
        own.current.targetTitle = captured.title;
        return captured;
      };
      const targetUnchanged=captured=>captured&&chatForegroundSession===captured.fixed&&workInputBindings.get(captured.fixed)===captured.adapter
        &&emptyInput(captured.adapter.state)&&captured.adapter.state.draftRev===captured.span.draftRev;
      const insertDraft=async(value,captured,token,editing,abort,automatic)=>{
        const current=own.current;if(!targetUnchanged(captured))throw Error('target-changed');
        setPlacing(true);let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;abort.abort();},10000);
        try{const response=await fetch(ROUTE+'/chat-work-draft',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
          body:JSON.stringify({action:'validate',...value.basis,instruction:value.instruction})}),checked=await response.json();
          if(!response.ok||checked.valid!==true||!sameBasis(checked.basis,value.basis))throw Error('source-changed');
          if(!current.live||current.token!==token||abort.signal.aborted)return false;
          if(current.editing!==editing||!targetUnchanged(captured))throw Error('target-changed');
          if(captured.adapter.actions.insertText(value.draft,captured.span)!==true)throw Error('target-changed');
          try{captured.adapter.actions.persistDraft?.();}catch{/* The native draft already contains the text; never duplicate the insertion. */}
          setInfo('已填入工作会话输入框，请在工作区检查后发送。');
          if(automatic)onMinimize?.({preserveWorkFocus:true});
          return true;
        }catch(error){if(timedOut)throw Object.assign(Error('source-changed'),{timedOut:true});throw error;}
        finally{clearTimeout(timeout);}
      };
      const begin=async mode=>{
        if(own.current.busy||!data||!saved.refs.length||unavailable)return;
        const captured=mode==='conclusion'?captureTarget():null;if(mode==='conclusion'&&!captured)return;
        const current=own.current,editing=current.editing,token=++current.token,abort=new AbortController(),previous=data;
        current.targetTitle = captured?.title ?? null;
        const intent={mode,captured,editing,basis:{roomId,epoch:data.epoch,scopeKey:data.scopeKey,referenceRevision:data.referenceRevision??0,discussionRevision:data.discussionRevision,refs:saved.refs},instruction:saved.instruction};
        current.abort?.abort();current.abort=abort;current.busy=true;setLoading(true);setInfo('');setConfirmation(null);
        let checkedIntent=null,timedOut=false;const timeout=setTimeout(()=>{timedOut=true;abort.abort();},10000);
        try{const response=await fetch(ROUTE+'/chat-work-draft?room='+encodeURIComponent(roomId),{signal:abort.signal}),value=await response.json();
          if(!response.ok)throw Error(value.error);
          if(!current.live||current.token!==token||abort.signal.aborted)return;
          if(value.room?.id!==roomId||!Array.isArray(value.choices))throw Error('invalid');
          if(value.scopeKey!==intent.basis.scopeKey||(value.referenceRevision??0)!==intent.basis.referenceRevision||value.discussionRevision!==intent.basis.discussionRevision){
            setData(value);setInfo('房间参考或讨论状态已变化，请刷新核对原话。已有草稿保留。');return;}
          if(current.editing!==editing){setData(value);setInfo('你已修改选择或草稿，请核对后重新整理。');return;}
          const missing=intent.basis.refs.filter(ref=>!value.choices.some(q=>refKey(q.ref)===refKey(ref)));
          if(missing.length){
            const validation=await fetch(ROUTE+'/chat-work-draft',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
              body:JSON.stringify({action:'validate',...intent.basis,instruction:intent.instruction})}),valid=await validation.json();
            if(!current.live||current.token!==token||abort.signal.aborted)return;
            if(!validation.ok||valid.valid!==true||!sameBasis(valid.basis,intent.basis)){setData(value);setInfo('所选原话已变化，请刷新核对。已有草稿保留。');return;}
            for(const ref of missing){const quote=previous.choices.find(q=>refKey(q.ref)===refKey(ref));if(quote)value.choices.push(quote);}
          }
          if(!current.live||current.token!==token||abort.signal.aborted)return;
          if(current.editing!==editing){setInfo('你已修改选择或草稿，请核对后重新整理。');return;}
          setData(value);checkedIntent={...intent,defaultThinking:value.thinking===true};
        }catch{if(current.live&&current.token===token&&(!abort.signal.aborted||timedOut))setInfo('暂时无法核对原话与思考设置，已有草稿保留。请重试。');}
        finally{clearTimeout(timeout);if(current.live&&current.token===token){current.busy=false;setLoading(false);}}
        if(!checkedIntent||!current.live||current.token!==token)return;
        if(checkedIntent.mode==='conclusion'&&!targetUnchanged(checkedIntent.captured)){setInfo('工作会话或输入框已变化，没有开始整理。请重新核对目标。');return;}
        if(state.current.draft){setConfirmation({stage:'replace',intent:checkedIntent});return;}chooseThinking(checkedIntent);
      };
      const chooseThinking=intent=>{
        if(own.current.busy||intent.editing!==own.current.editing)return;
        if(intent.mode==='conclusion'&&!targetUnchanged(intent.captured)){setConfirmation(null);setInfo('工作会话或输入框已变化，没有开始整理。请重新核对目标。');return;}
        if(intent.defaultThinking===true)void generate(intent,true);else setConfirmation({stage:'thinking',intent});
      };
      const generate=async(intent,thinking)=>{
        if(own.current.busy||!data||intent.editing!==own.current.editing)return;
        if(intent.mode==='conclusion'&&!targetUnchanged(intent.captured)){setConfirmation(null);setInfo('工作会话或输入框已变化，没有开始整理。请重新核对目标。');return;}
        const current=own.current,token=++current.token,editing=current.editing,abort=new AbortController(),requestId=chatNonce();
        current.targetTitle = intent.captured?.title ?? null;
        current.abort?.abort();current.abort=abort;current.requestId=requestId;current.busy=true;setBusy(true);setInfo('');setConfirmation(null);
        const basis=intent.basis;
        let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;abort.abort();
          void fetch(ROUTE+'/chat-work-draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'cancel',roomId,requestId})}).catch(()=>{});},thinking?70000:25000);
        try{const response=await fetch(ROUTE+'/chat-work-draft',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
          body:JSON.stringify({action:'generate',requestId,...basis,instruction:intent.instruction,thinking})}),value=await response.json();
          if(!response.ok)throw Object.assign(Error(value.error),{status:response.status});
          if(current.live&&current.token===token&&!abort.signal.aborted){
            if(value.requestId!==requestId||!sameBasis(value.basis,basis)||typeof value.draft!=='string'||value.draft.length>6000||value.thinking!==thinking
              ||!['enabled','unavailable','unknown','off'].includes(value.thinkingStatus))throw Error('invalid');
            if(current.editing!==editing){setInfo('整理已结束，但你已修改草稿，保留你的编辑。');return;}
            const next={...state.current,draft:value.draft,basis:value.basis,thinking:value.thinking,thinkingStatus:value.thinkingStatus};keep(next);
            clearTimeout(timeout);current.requestId=null;
            if(thinking&&value.thinkingStatus==='unavailable'){setInfo('模型不支持本次思考，已保留草稿。请核对后手动填入。');return;}
            if(intent.mode==='conclusion'&&thinking&&value.thinkingStatus==='unknown'){
              setInfo('无法确认模型本次思考方式，结论已保留为草稿。请核对后手动填入。');return;}
            if(intent.mode==='conclusion')await insertDraft(next,intent.captured,token,editing,abort,true);
            else setInfo(value.thinkingStatus==='unknown'?'草稿已整理；思考方式由模型提供方决定。请核对后使用。':'草稿已整理，可修改后复制，或填入当前工作输入框。不会自动发送。');
          }
        }catch(error){if(current.live&&current.token===token&&(!abort.signal.aborted||timedOut||error.timedOut))setInfo(error.status===409
          ?'所选原话或讨论状态已变化，请刷新核对。已有草稿保留。':error.message==='target-changed'
            ?'工作会话或输入框已变化，没有填入。结论草稿已保留，可核对后手动填入或复制。':error.message==='source-changed'
              ?'原话依据已变化或暂不可核对，没有填入。结论草稿已保留。':'这次未能整理完成，要求、选择和已有草稿都保留，可以重试。');}
        finally{clearTimeout(timeout);if(current.live&&current.token===token){current.busy=false;current.requestId=null;setBusy(false);setPlacing(false);}}
      };
      const copy=async()=>{const text=state.current.draft;if(!text.trim())return;
        try{if(typeof navigator.clipboard?.writeText!=='function')throw Error('unavailable');await navigator.clipboard.writeText(text);
          if(own.current.live)setInfo('已复制工作指令草稿；尚未发送到工作会话。');
        }catch{if(own.current.live){output.current?.focus();output.current?.select();setInfo('复制未完成，已选中文本，请按 Ctrl+C 或长按复制。');}};
      };
      const target=chatForegroundSession,binding=workInputBindings.get(target);
      const capturedTargetTitle = confirmation?.intent?.captured?.title ?? (own.current.busy ? own.current.targetTitle : null);
      const targetTitle = capturedTargetTitle ? capturedTargetTitle
        : target ? binding?.title || '当前工作会话（名称暂不可用）' : '暂无前台工作会话';
      const place=async()=>{
        const value=state.current,current=own.current;if(current.busy||!value.draft.trim()||!value.basis)return;
        const captured=captureTarget();if(!captured)return;
        const token=++current.token,abort=new AbortController(),editing=current.editing;current.abort?.abort();current.abort=abort;current.busy=true;setPlacing(true);setInfo('');
        try{await insertDraft(value,captured,token,editing,abort,false);
        }catch(error){if(current.live&&current.token===token&&(!abort.signal.aborted||error.timedOut))setInfo(error.message==='target-changed'
          ?'工作会话或输入框已变化，没有填入。草稿保留，可重新核对或复制。':'原话依据已变化或暂不可核对，没有填入。请刷新后重新整理，也可以复制草稿。');}
        finally{if(current.live&&current.token===token){current.busy=false;setPlacing(false);}}
      };
      const selectedKeys=new Set(saved.refs.map(refKey)),filtered=choices.filter(q=>!filter.trim()||(q.author.name+' '+q.text).toLowerCase().includes(filter.trim().toLowerCase()));
      return h('section',{className:'dsh-persona-work-draft',role:'region','aria-label':'工作指令草稿',onKeyDown:event=>{
        if(event.key==='Escape'&&!event.nativeEvent?.isComposing&&confirmation){event.stopPropagation();event.preventDefault();cancelConfirmation();}
      }},h('style',null,
        `.dsh-persona-work-draft{position:absolute;z-index:4;inset:80px 10px 10px;overflow:auto;overscroll-behavior:contain;background:var(--chat-bg);border:1px solid var(--chat-border);border-radius:11px;box-shadow:0 12px 35px #0002;padding:12px;min-width:0;font-size:12px}.dsh-persona-work-draft header{position:sticky;top:-12px;z-index:1;display:flex;align-items:center;gap:10px;margin:-12px -12px 8px;padding:10px 12px;background:var(--chat-bg);border-bottom:1px solid var(--chat-border)}.dsh-persona-work-draft header strong{flex:1;font-size:14px}.dsh-persona-work-draft p{margin:7px 0;color:var(--chat-muted);line-height:1.65;overflow-wrap:anywhere}.dsh-persona-work-draft label{display:block;margin:9px 0}.dsh-persona-work-draft input[type=search],.dsh-persona-work-draft textarea{width:100%;min-width:0;font:inherit;line-height:1.65;color:var(--chat-text);background:var(--chat-soft);border:1px solid var(--chat-border);border-radius:7px;padding:7px 9px;box-sizing:border-box}.dsh-persona-work-draft textarea{resize:vertical;min-height:62px}.dsh-persona-work-draft .dsh-persona-work-output{min-height:170px}.dsh-persona-work-choice-list{max-height:190px;overflow:auto;border-block:1px solid var(--chat-border);padding:5px 0}.dsh-persona-work-choice{display:flex;align-items:start;gap:7px;padding:5px 0}.dsh-persona-work-choice input{flex:none;margin-top:5px;accent-color:var(--chat-brand)}.dsh-persona-work-choice details{min-width:0;flex:1}.dsh-persona-work-choice summary{cursor:pointer;line-height:1.7;overflow-wrap:anywhere}.dsh-persona-work-choice blockquote{white-space:pre-wrap;overflow-wrap:anywhere;margin:7px 0;padding:7px 9px;border-inline-start:2px solid var(--chat-brand);max-height:130px;overflow:auto}.dsh-persona-work-draft-actions{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}.dsh-persona-work-draft-actions button{font-size:11px;min-height:29px}.dsh-persona-work-draft-status{font-size:11px}@media(max-width:420px){.dsh-persona-work-draft{inset:70px 7px 7px;padding:10px}.dsh-persona-work-draft header{top:-10px;margin:-10px -10px 8px;padding:9px 10px}.dsh-persona-work-choice-list{max-height:160px}}`),
        h('style',null,'.dsh-persona-work-draft-actions button[data-primary]{background:var(--chat-brand);color:#fff;border-color:transparent}'),
        h('header',null,h('strong',{ref:heading,tabIndex:-1},'整理工作指令'),h('button',{type:'button','aria-label':'收起指令草稿',onClick:onClose},'收起')),
        h('p',null,'选择本房间原话，整理成可编辑的工作指令。生成只在你点击后进行；不会自动发送或写入记忆。'),
        h('div',{className:'dsh-persona-work-draft-actions'},h('button',{type:'button',disabled:busy||placing||loading,onClick:load},loading?'正在读取原话…':'刷新可选原话'),h('span',null,'已选 '+saved.refs.length+'/12')),
        data?h(React.Fragment,null,h('label',null,'筛选原话',h('input',{type:'search','aria-label':'筛选整理原话',value:filter,onChange:e=>setFilter(e.target.value)})),
          unavailable?h('p',{role:'status'},'有 '+unavailable+' 条原话已失效，请取消选择后重新核对。',h('button',{type:'button',disabled:busy||placing,onClick:()=>edit({refs:available.map(q=>q.ref)})},'清除失效选择')):null,
          h('div',{className:'dsh-persona-work-choice-list','aria-label':'可整理的原话'},...filtered.map((q,index)=>{const key=refKey(q.ref),checked=selectedKeys.has(key),author=q.author.role==='user'?'我':q.author.name;
            return h('div',{key,className:'dsh-persona-work-choice'},h('input',{type:'checkbox','aria-label':'选择原话 '+author+' '+q.text.slice(0,28),checked,disabled:busy||placing||(!checked&&saved.refs.length>=12),onChange:()=>edit({refs:checked?saved.refs.filter(ref=>refKey(ref)!==key):[...saved.refs,q.ref]})}),
              h('details',null,h('summary',null,author+' · '+Array.from(q.text.replace(/\s+/g,' ')).slice(0,70).join('')),h('blockquote',null,q.text)));}),
            !choices.length?h('p',null,'当前范围还没有可整理的原话，先聊几句再来。'):!filtered.length?h('p',null,'没有匹配的原话，试试其他关键词。'):null)) :null,
        h('label',null,'整理要求（可选）',h('textarea',{'aria-label':'工作指令整理要求',maxLength:2000,rows:2,value:saved.instruction,disabled:busy||placing,onChange:e=>edit({instruction:e.target.value})})),
        h('p',{'data-work-draft-target':'conclusion'},'填入目标：'+targetTitle+'。'+(capturedTargetTitle?'本次目标已固定，不会改投其他会话。':'只填入空输入框，由你在工作区发送。')),
        h('div',{className:'dsh-persona-work-draft-actions'},h('button',{type:'button',ref:draftAction,disabled:loading||busy||placing||!data||!saved.refs.length||!!unavailable,onClick:()=>begin('draft')},busy?'正在整理…':'整理草稿'),
          h('button',{type:'button',ref:conclusionAction,'data-primary':'',disabled:loading||busy||placing||!data||!saved.refs.length||!!unavailable,onClick:()=>begin('conclusion')},'整理结论并填入'),
          busy?h('button',{type:'button',onClick:()=>{stop();setInfo('已停止这次整理，已有草稿保留。');}},'停止整理'):null),
        confirmation?h('div',{ref:confirmationRoot,className:'dsh-persona-chat-info',role:'group','aria-label':confirmation.stage==='thinking'?'本次结论思考设置':'重新整理确认'},
          confirmation.stage==='replace'?h(React.Fragment,null,'重新整理会替换下方已有草稿。',
            h('button',{type:'button',onClick:()=>chooseThinking(confirmation.intent)},'确认重新整理'),
            h('button',{type:'button',onClick:cancelConfirmation},'保留当前草稿'))
            :h(React.Fragment,null,h('strong',null,'这次整理是否开启思考？'),h('p',null,'只影响本次整理，不改变聊天室设置。思考能力以模型支持为准。'),
              confirmation.intent.mode==='conclusion'?h('p',null,'结论将填入：'+confirmation.intent.captured.title+'。成功后聊天室会最小化，仍由你修改并发送。'):null,
              h('button',{type:'button',onClick:()=>void generate(confirmation.intent,true)},'开启思考并继续'),
              h('button',{type:'button',onClick:()=>void generate(confirmation.intent,false)},'保持关闭并继续'),
              h('button',{type:'button',onClick:cancelConfirmation},'取消本次整理'))):null,
        h('p',{className:'dsh-persona-work-draft-status',role:'status','aria-live':'polite'},info),
        h('label',null,'工作指令草稿',h('textarea',{ref:output,className:'dsh-persona-work-output','aria-label':'可编辑的工作指令草稿',maxLength:6000,rows:7,value:saved.draft,onChange:e=>edit({draft:e.target.value})})),
        saved.thinkingStatus==='unknown'?h('p',null,'本次思考方式由模型提供方决定，请核对结论。'):saved.thinkingStatus==='unavailable'?h('p',null,'模型不支持本次思考。草稿保留供你核对，不会自动填入。'):null,
        h('div',{className:'dsh-persona-work-draft-actions'},h('button',{type:'button',disabled:!saved.draft.trim(),onClick:()=>void copy()},'复制草稿'),
          h('button',{type:'button',disabled:busy||placing||!saved.draft.trim()||!saved.basis||!binding||!emptyInput(binding.state),onClick:()=>void place()},placing?'正在核对…':'填入当前工作输入框')),
        h('p',{'data-work-draft-target':'manual'},'填入目标：'+targetTitle+'。'+(!binding?'宿主尚未提供可用的输入框接口，可以复制草稿。':!emptyInput(binding.state)?'输入框已有文字、附件或正在发送时不会填入。':'只填入空输入框，由你在工作区确认发送。')));
    }
    function RoomChatWorkspace({sessionId,conversation,onClose}) {
      const [data,setData]=React.useState(null),[roomId,setRoomId]=React.useState(null),[panel,setPanel]=React.useState(null);
      const [notice,setNotice]=React.useState(''),[busy,setBusy]=React.useState(false),[name,setName]=React.useState(''),[members,setMembers]=React.useState([]),[deleting,setDeleting]=React.useState(false);
      const [retractMemories,setRetractMemories]=React.useState(true);
      const [search,setSearch]=React.useState('');
      const openingSurface=React.useRef(null);
      const openingFloating=useFloatingWindow({id:'chat',ref:openingSurface,active:!(roomId&&data?.room&&data.chatSchema===3&&data.discussionVersion===2),wide:chatRoomLayout.wide,onWideChange:value=>{chatRoomLayout.wide=value;},minHeight:360});
      // The loading surface already represents this opening. Replacing its content must not restart the fade.
      useLayoutEffect(()=>enterChatSurface(openingSurface.current),[]);
      const lifetime=React.useRef({live:true,sequence:0,busy:false,readAbort:null,needsFirstRoom:true}),selected=React.useRef(null),creation=React.useRef(chatNonce()),editVersion=React.useRef(0);
      const draftMembersEdited=React.useRef(false);
      const accept=value=>{useChatUiNamespace(value.localStateKey,value.instanceId);restoreChatUi(value.room,value.scopeKey);
        if(value.ready&&Array.isArray(value.rooms)){const ids=new Set(value.rooms.map(room=>room.id));for(const id of chatUi.keys())if(!ids.has(id))clearChatUi(id);}
        if(value.room&&selected.current!==value.room.id)updateChatUi(value.room.id,{visitedAt:Date.now()});
        setData(value);selected.current=value.room?.id??null;if(selected.current)lifetime.current.needsFirstRoom=false;setRoomId(selected.current);};
      const readChat=async(signal)=>{
        const query=new URLSearchParams(),foreground=chatForegroundSession??sessionId;
        if(selected.current)query.set('room',selected.current);if(foreground)query.set('session',foreground);
        const response=await fetch(ROUTE+'/chat?'+query,{signal}),value=await response.json();
        if(!response.ok)throw Error(value.error);return value;
      };
      const request=async(body)=>{const response=await fetch(ROUTE+'/chat-rooms',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
        const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{state:value.state});return value;};
      const load=async(createDefault=false)=>{
        const own=lifetime.current,token=++own.sequence;setNotice('');
        own.readAbort?.abort();const abort=new AbortController();own.readAbort=abort;
        try{let value=await readChat(abort.signal);
          if(!own.live||token!==own.sequence)return;
          if(value.chatSchema!==3||value.discussionVersion!==2){accept(value);setNotice('聊天室后台需要重新加载，请完整退出并重新打开 DSH。');return;}
          if(!value.room&&createDefault&&value.ready){const id=value.reportPersonaId??value.defaultPersonaId,person=value.contacts.find(p=>p.id===id&&!p.archived);
            if(person)value=await request({action:'ensure-first',requestId:creation.current,name:('与'+person.name+'的聊天').slice(0,60),memberIds:[id],targetPersonaId:id,epoch:value.epoch});}
          if(own.live&&token===own.sequence)accept(value);
        }catch(error){if(own.live&&token===own.sequence&&!abort.signal.aborted)setNotice(chatErrorText(error.message));}
      };
      React.useEffect(()=>{lifetime.current.live=true;void load(true);return()=>{lifetime.current.live=false;lifetime.current.sequence++;lifetime.current.readAbort?.abort();lifetime.current.discovery?.abort();};},[]);
      const dismissPanel=()=>{setPanel(null);lifetime.current.discovery?.abort();};
      const discover=async()=>{
        const own=lifetime.current;if(!own.live||own.busy||selected.current!==roomId)return;
        const abort=new AbortController(),token=++own.sequence;own.discovery=abort;own.busy=true;setBusy(true);setNotice('');
        const current=()=>own.live&&!abort.signal.aborted&&token===own.sequence&&selected.current===roomId;
        try{
          const response=await fetch(ROUTE+'/chat/memory',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
            body:JSON.stringify({action:'discover',room:roomId,generation:room.generation??0,referenceRevision:room.referenceRevision??0,scopeKey:data.scopeKey})});
          const result=await response.json();if(current())setNotice(response.ok?'已整理 '+result.count+' 条候选，可在设置页「待确认」核对。':'整理未完成，请核对房间与记忆开关后重试。');
        }catch{if(current())setNotice('整理未完成，请重试。');}
        finally{if(own.discovery===abort){own.discovery=null;own.busy=false;if(own.live)setBusy(false);}}
      };
      const change=async(body)=>{
        const own=lifetime.current;if(own.busy)return;own.busy=true;setBusy(true);setNotice('');const token=++own.sequence;
        chatUiFlushers.get(selected.current)?.();
        try{const value=await request({...body,epoch:data.epoch});if(!own.live||token!==own.sequence)return;
          if(body.action==='delete')clearChatUi(body.roomId);
          accept(value);setPanel(value.room?null:'rooms');setDeleting(false);return true;
        }catch(error){if(own.live&&token===own.sequence){if(error.state?.room?.id===selected.current)setData(error.state);
          setNotice(error.message==='chat-conflict'?'聊天室资料已变化，草稿保留。请重新载入成员核对后保存。':chatErrorText(error.message));}return false;
        }finally{own.busy=false;if(own.live)setBusy(false);}
      };
      const openCreate=()=>{creation.current=chatNonce();let number=1;while(data?.rooms?.some(r=>r.name==='新聊天室 '+number))number++;
        setName('新聊天室 '+number);draftMembersEdited.current=false;setMembers([]);setPanel('create');setDeleting(false);setNotice('');};
      React.useEffect(()=>{
        if(panel!=='create')return;
        // Read the foreground work persona when starting this draft. Room snapshots normally describe the fixed source.
        const abort=new AbortController();
        void readChat(abort.signal).then(value=>{
          if(abort.signal.aborted)return;
          const id=value.reportPersonaId??value.defaultPersonaId;
          if(!value.ready||!value.contacts.some(p=>p.id===id&&!p.archived))throw Error('persona-unavailable');
          setData(previous=>previous?{...previous,contacts:value.contacts}:previous);
          if(!draftMembersEdited.current)setMembers([id]);
        }).catch(()=>{if(!abort.signal.aborted&&!draftMembersEdited.current)setNotice('暂时无法读取当前汇报人格，请手动选择参与人格。');});
        return()=>abort.abort();
      },[panel]);
      const openEdit=()=>{if(!data?.room)return;setName(data.room.name);setMembers([...data.room.memberIds]);editVersion.current=data.room.configRevision;setPanel('edit');setDeleting(false);setNotice('');};
      const openRooms=()=>{lifetime.current.discovery?.abort();setPanel('rooms');setDeleting(false);void load(false);};
      const contacts=data?.contacts??[],room=data?.room;
      const matchingRooms=(data?.rooms??[]).filter(item=>!search.trim()||(item.name+' '+item.memberIds.map(id=>contacts.find(person=>person.id===id)?.name??'').join(' ')).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
        .sort((a,b)=>(chatUi.get(b.id)?.visitedAt??b.at??0)-(chatUi.get(a.id)?.visitedAt??a.at??0));
      const panelView=panel?h('div',{className:'dsh-persona-chat-room-panel',role:'region','aria-label':panel==='rooms'?'聊天室列表':panel==='create'?'创建聊天室':'管理聊天室'},
        h('header',null,h('strong',null,panel==='rooms'?'聊天室':panel==='create'?'新建聊天室':'房间资料与成员'),h('button',{type:'button',onClick:dismissPanel},'收起面板')),
        notice?h('p',{role:'status'},notice):null,
        panel==='edit' && data.memoryEnabled?h('button',{type:'button',disabled:busy,onClick:discover},'整理本房近期记忆候选'):null,
        panel==='rooms'?h(React.Fragment,null,h('input',{type:'search','aria-label':'搜索聊天室',value:search,placeholder:'搜索房间或成员',onChange:event=>setSearch(event.target.value),style:{width:'100%',minWidth:0,marginBottom:10,padding:'7px 9px',border:'1px solid var(--chat-border)',borderRadius:7,background:'var(--chat-soft)',color:'inherit'}}),
          h('div',{className:'dsh-persona-chat-room-list'},...matchingRooms.map(item=>h('button',{
          key:item.id,type:'button','aria-label':'打开聊天室 '+item.name,'aria-pressed':item.id===roomId,disabled:busy,onClick:()=>void change({action:'select',roomId:item.id})},
          h(RoomAvatar,{memberIds:item.memberIds,contacts}),h('span',null,h('strong',null,item.name),h('small',null,item.memberIds.length+' 位人格 · '+item.turnCount+' 轮聊天'
            +((chatDrafts.get(item.id)?.text.trim()||chatDrafts.get(item.id)?.quote||chatUi.get(item.id)?.draft.text.trim()||chatUi.get(item.id)?.draft.quoteRef)?' · 有草稿':'')+(item.running?' · 正在回复':'')))))),
          !matchingRooms.length?h('p',{role:'status'},'没有找到匹配的聊天室。'):null,
          h('div',{className:'dsh-persona-chat-room-buttons'},h('button',{type:'button',disabled:busy||!data?.ready,onClick:openCreate},'新建聊天室'),h('button',{type:'button',disabled:busy,onClick:()=>void load(false)},'刷新列表')))
          :h(React.Fragment,null,h('label',null,'聊天室名称',h('input',{type:'text','aria-label':'聊天室名称',maxLength:60,value:name,disabled:busy,onChange:e=>setName(e.target.value)})),
            h('strong',null,'参与人格 · '+members.length+'/8'),
            h('div',{className:'dsh-persona-chat-room-members'},...contacts.map(person=>h('label',{key:person.id},h('input',{type:'checkbox','aria-label':'成员 '+person.name,
              checked:members.includes(person.id),disabled:busy||(person.archived&&!members.includes(person.id))||(!members.includes(person.id)&&members.length>=8),onChange:e=>{draftMembersEdited.current=true;const checked=e.target.checked;setMembers(previous=>checked?[...previous,person.id]:previous.filter(id=>id!==person.id));}}),
              h(PersonaAvatar,{id:person.id,name:person.name,src:person.avatar,className:'dsh-persona-chat-avatar'}),h('span',null,person.name+(person.archived?'（已移除）':''))))),
            h('p',null,'加入的角色可以阅读本房间近期聊天。其他房间的记录和各人格的私有记忆仍分别隔离；修改成员不会自动发言。'),
            h('div',{className:'dsh-persona-chat-room-buttons'},h('button',{type:'button','data-primary':'',disabled:busy||!name.trim()||!members.length,onClick:()=>void change(panel==='create'
              ?{action:'create',requestId:creation.current,name:name.trim(),memberIds:members,targetPersonaId:members[0]}
              :{action:'update',roomId,configRevision:editVersion.current,name:name.trim(),memberIds:members})},busy?'保存中…':panel==='create'?'创建聊天室':'保存聊天室'),
              panel==='edit'?h('button',{type:'button',disabled:busy,onClick:openEdit},'重新载入成员'):null,
              panel==='edit'?h('button',{type:'button',disabled:busy,onClick:()=>{setRetractMemories(true);setDeleting(true);}},'删除聊天室'):null),
            deleting?h('div',null,h('p',null,'删除「'+room.name+'」？聊天记录和房间讨论状态会一起删除。'),data.roomMemoryCount>0?h('label',null,
              h('input',{type:'checkbox',checked:retractMemories,onChange:e=>setRetractMemories(e.target.checked)}),'同时撤销本房间的 '+data.roomMemoryCount+' 条房间记忆（人格专属约定保留）'):null,h('div',{className:'dsh-persona-chat-room-buttons'},
              h('button',{type:'button',disabled:busy,onClick:()=>void change({action:'delete',roomId,revision:room.revision,retractMemories:data.roomMemoryCount>0&&retractMemories})},'确认删除聊天室'),
              h('button',{type:'button',onClick:()=>setDeleting(false)},'取消删除'))):null)) : null;
      if(roomId&&room&&data.chatSchema===3&&data.discussionVersion===2)return h(PersonaChatWindow,{key:roomId,roomId,initialState:data,roomBusy:busy,sessionId:chatForegroundSession??sessionId,conversation,onClose,animateEntrance:false,
        roomPanel:panelView,onDismissPanel:dismissPanel,onOpenRooms:openRooms,onOpenMembers:openEdit,
        onRoomState:value=>{if(lifetime.current.live&&value.room?.id===selected.current)setData(value);},onRoomMissing:()=>{selected.current=null;setRoomId(null);setPanel('rooms');void load(false);}});
      return h('section',{ref:openingSurface,className:'dsh-persona-chat',style:{'--chat-brand':readChatTheme().color},'data-wide':String(chatRoomLayout.wide),role:'dialog','aria-label':'聊天室',onKeyDown:e=>{if(e.key==='Escape'&&!e.nativeEvent?.isComposing){e.stopPropagation();if(panel)setPanel(null);else onClose();}}},h('style',null,CHAT_CSS,ROOM_CHAT_CSS,FLOATING_WINDOW_CSS),
        h(FloatingWindowHandles,{controls:openingFloating,label:'聊天室'}),
        h('header',{...openingFloating.dragProps,style:{display:'flex',justifyContent:'space-between',padding:'12px'}},h('strong',null,'聊天室'),h('button',{type:'button','aria-label':'关闭聊天室',onClick:onClose},'关闭')),
        h('div',{className:'dsh-persona-chat-room-loading'},h('p',{role:'status'},notice||(!data?'正在读取聊天室…':!data.ready?'聊天存储正在准备，稍后可重新读取。':'选择一个聊天室，或新建一段讨论。')),
          h('button',{type:'button',onClick:()=>void load(lifetime.current.needsFirstRoom)},'重新读取'),data?.chatSchema===3&&data.ready&&!panel?h('button',{type:'button',onClick:openCreate},'新建聊天室'):null),panelView);
    }
    function PersonaChatWindow({ onClose, sessionId, conversation,roomId:explicitRoomId,initialState,roomBusy=false,onRoomState,onRoomMissing,
      roomPanel,onDismissPanel,onOpenRooms,onOpenMembers,animateEntrance=true }) {
      const [minimized,setMinimized]=React.useState(()=>chatRuntime.minimized);
      const dockButton=React.useRef(null),dockSession=React.useRef(null),surface=React.useRef(null);
      useFloatingDock(surface,minimized);
      useLayoutEffect(()=>{const update=()=>setMinimized(chatRuntime.minimized);chatLaunchListeners.add(update);update();
        return()=>chatLaunchListeners.delete(update);},[]);
      const contextState=useChatContext(sessionId,explicitRoomId,minimized),context=contextState.value;
      const fixedSessionId=context?.primarySessionId??sessionId;
      const fixedReportPersona=context?.reportPersonaId??conversation?.effectivePersonaId;
      const [foreground,setForeground]=React.useState(chatForegroundSession??sessionId);
      const [sourcesOpen,setSourcesOpen]=React.useState(false),[projectId,setProjectId]=React.useState(''),[sessionChoices,setSessionChoices]=React.useState([]);
      const [sessionChoice,setSessionChoice]=React.useState('');
      React.useEffect(()=>{const update=()=>setForeground(chatForegroundSession);chatForegroundListeners.add(update);return()=>chatForegroundListeners.delete(update);},[]);
      const [data, setData] = React.useState(initialState);
      const [silenced,setSilenced]=React.useState({owner:null,attempts:[]});
      const latestData=React.useRef(initialState),roomMembers=React.useRef(initialState?.room?.memberIds??[]);
      const windowOwner = React.useRef({});
      const scope = '@global-chat';
      const [choice, setChoice] = React.useState(() => chatPersonaChoices.get(scope) ?? '');
      const [persona, setPersona] = React.useState(() => explicitRoomId?initialState?.personaId:chatPersonaChoices.get(scope) || fixedReportPersona);
      const personaRef = React.useRef(persona); personaRef.current = persona;
      const draftScope=explicitRoomId??persona;
      const [draft, setDraft] = React.useState(() => chatDrafts.get(explicitRoomId??persona) ?? emptyChatDraft());
      const imageScope=(explicitRoomId??persona)+':'+(data?.room?.generation??0),imageScopeRef=React.useRef(imageScope);imageScopeRef.current=imageScope;
      const [images,setImages]=React.useState(()=>chatImageDrafts.get(imageScope)??[]),[imageBusy,setImageBusy]=React.useState(false),[imageInfo,setImageInfo]=React.useState('');
      const imageInput=React.useRef(null),imageSending=React.useRef(false);
      const [imageDragging,setImageDragging]=React.useState(false),imageDragDepth=React.useRef(0);
      React.useEffect(()=>{setImages(chatImageDrafts.get(imageScope)??[]);setImageInfo('');setImageBusy(false);imageSending.current=false;imageDragDepth.current=0;setImageDragging(false);},[imageScope]);
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const [info, setInfo] = React.useState('');
      const [supportOpen,setSupportOpen]=React.useState(false),[supportSaving,setSupportSaving]=React.useState(false),[supportNotice,setSupportNotice]=React.useState('');
      const supportButton=React.useRef(null),supportWrite=React.useRef(null),supportMenuId=React.useRef('dsh-chat-support-'+chatNonce());
      React.useEffect(()=>()=>supportWrite.current?.abort(),[]);
      React.useEffect(()=>{supportWrite.current?.abort();supportWrite.current=null;setSupportSaving(false);setSupportNotice('');setSupportOpen(false);},[imageScope]);
      const [syncDelayed,setSyncDelayed]=React.useState(false);
      const activityData=syncDelayed?null:data;
      const [wide, setWide] = React.useState(()=>explicitRoomId?chatRoomLayout.wide:false);
      const floating=useFloatingWindow({id:'chat',ref:surface,active:!minimized,wide,onWideChange:value=>{if(explicitRoomId)chatRoomLayout.wide=value;setWide(value);},minHeight:360});
      const [composeExpanded, setComposeExpanded] = React.useState(()=>explicitRoomId?chatRoomLayout.composeExpanded:false);
      const firstSurface=React.useRef(true);
      useLayoutEffect(()=>{const initial=firstSurface.current;firstSurface.current=false;
        if(initial&&!animateEntrance)return;return enterChatSurface(surface.current);},[minimized]);
      const [clearConfirm, setClearConfirm] = React.useState(false);
      const [retryConfirm, setRetryConfirm] = React.useState(null);
      const [appearance, setAppearance] = React.useState(false);
      const { theme, choose:chooseTheme, notice:themeNotice } = useChatTheme();
      const [workOpen,setWorkOpen]=React.useState(false);
      const [remember,setRemember]=React.useState(null);
      const [suggestMode, setSuggestMode] = React.useState(false);
      const [suggestions, setSuggestions] = React.useState([]);
      const [suggestBusy, setSuggestBusy] = React.useState(false);
      const [suggestInfo, setSuggestInfo] = React.useState('');
      const suggestRequest = React.useRef({ revision: 0, abort: undefined, busy: false });
      const [scrolledUp, setScrolledUp] = React.useState(false);
      const [newReplies,setNewReplies]=React.useState(0);
      const readRevision = React.useRef(0), live = React.useRef(true), reading = React.useRef(undefined);
      const host = React.useRef({ id: undefined, retired: new Set() });
      const input = React.useRef(null), thread = React.useRef(null), atBottom = React.useRef(chatUi.get(explicitRoomId)?.reading?.atBottom!==false), appearanceButton = React.useRef(null),workButton=React.useRef(null);
      const threadContent=React.useRef(null),threadPosition=React.useRef(null);
      const readingRestore=React.useRef(chatUi.get(explicitRoomId)?.reading??null),readingRestored=React.useRef(false),readingTimer=React.useRef(null);
      const knownReading=React.useRef(new Set(chatUi.get(explicitRoomId)?.reading?.known??(initialState?.room?.turns??[]).filter(turn=>turn.status==='ready'&&turn.phase!=='anchor').map(turn=>turn.attemptId)));
      const knownGeneration=React.useRef(initialState?.room?.generation??0);
      const boundUiScope=React.useRef(chatUiNamespace);
      const layoutTop=(node,root)=>{let top=0;for(let current=node;current&&current!==root;current=current.offsetParent)top+=current.offsetTop;return top;};
      const saveReading=()=>{
        if(!explicitRoomId||!thread.current?.isConnected||!readingRestored.current||chatUi.get(explicitRoomId)?.generation!==(latestData.current?.room?.generation??0))return;
        const element=thread.current;
        const bubble=[...element.querySelectorAll('.dsh-persona-chat-message')].find(node=>layoutTop(node,element)+node.offsetHeight>element.scrollTop+8);
        if(!bubble&&latestData.current?.room?.turns.length)return;
        const owner=bubble?.closest('[data-chat-turn],[data-chat-user-head]'),anchor=owner?{turnId:owner.getAttribute('data-chat-turn')??owner.getAttribute('data-chat-user-head'),kind:bubble.dataset.user==='true'?'user':'assistant',index:Number(bubble.dataset.chatBubble??0),
          ...(bubble.dataset.user==='true'&&bubble.dataset.chatUserPart?{messageId:bubble.dataset.chatUserPart}:{})}:null;
        updateChatUi(explicitRoomId,{selection:{start:input.current?.selectionStart??0,end:input.current?.selectionEnd??0},reading:{
          atBottom:atBottom.current,scrollTop:element.scrollTop,anchor,offset:bubble?layoutTop(bubble,element)-element.scrollTop:0,known:[...knownReading.current].slice(-256)}});
      };
      const scheduleReading=()=>{clearTimeout(readingTimer.current);readingTimer.current=setTimeout(saveReading,120);};
      const noteReadyReplies=value=>{
        const ids=(value?.room?.turns??[]).filter(turn=>turn.status==='ready'&&turn.phase!=='anchor').map(turn=>turn.attemptId);
        if(atBottom.current){knownReading.current=new Set(ids);setNewReplies(0);}
        else{knownReading.current=new Set(ids.filter(id=>knownReading.current.has(id)));setNewReplies(ids.filter(id=>!knownReading.current.has(id)).length);}
      };
      const readThreadPosition=element=>({top:element.scrollTop,height:element.scrollHeight,viewport:element.clientHeight});
      const syncThreadLayout=()=>{
        const element=thread.current;
        if(!element?.clientHeight)return;
        const position=readThreadPosition(element);
        if(atBottom.current&&position.height-position.viewport-position.top>1){
          element.scrollTop=position.height;
          position.top=element.scrollTop;
        }
        threadPosition.current=position;
      };
      const followLatest=value=>{
        atBottom.current=value;
        setScrolledUp(!value);
        syncThreadLayout();
        noteReadyReplies(latestData.current);
        scheduleReading();
      };
      const onThreadScroll=event=>{
        const position=readThreadPosition(event.currentTarget),previous=threadPosition.current;
        const sameLayout=previous?.height===position.height&&previous.viewport===position.viewport;
        const gap=position.height-position.viewport-position.top;
        // Reflow can change the scrollbar range and dispatch its own scroll event.
        // Only movement within the same layout changes which position the user follows.
        if(sameLayout&&position.top!==previous.top){
          if(atBottom.current&&position.top<previous.top&&gap>1){followLatest(false);return;}
          if(!atBottom.current&&position.top>previous.top&&gap<=1){followLatest(true);return;}
        }
        syncThreadLayout();
        scheduleReading();
      };
      useLayoutEffect(()=>{
        const element=thread.current,content=threadContent.current;
        if(minimized||!element||!content)return;
        const observer=new ResizeObserver(syncThreadLayout);
        observer.observe(element);
        observer.observe(content);
        return()=>observer.disconnect();
      },[minimized]);
      const minimize=(options={})=>{
        saveReading();
        const snapshot=latestData.current;
        const known=new Set((snapshot?.room?.turns??[]).filter(t=>t.status==='ready'&&t.phase!=='anchor').map(t=>t.attemptId));
        for(const id of known)chatAnimatedAttempts.delete(id);
        dockSession.current={instance:snapshot?.instanceId,generation:snapshot?.room?.generation,known,count:0,
          scroll:thread.current?.scrollTop??0,start:input.current?.selectionStart,end:input.current?.selectionEnd,preserveWorkFocus:options.preserveWorkFocus===true};
        chatRuntime.setMinimized(true);
      };
      useLayoutEffect(()=>{
        if(minimized){if(!dockSession.current?.preserveWorkFocus)dockButton.current?.focus({preventScroll:true});return;}
        const last=dockSession.current;if(!last)return;
        dockSession.current=null;
        if(last.missing){onRoomMissing?.();return;}
        if(thread.current&&!atBottom.current)thread.current.scrollTop=last.scroll;
        syncThreadLayout();
        input.current?.focus({preventScroll:true});if(last.start!=null)input.current?.setSelectionRange(last.start,last.end);
        if(!busyRef.current)void currentLoad.current(undefined,true);
      },[minimized]);
      const closeAppearance = () => { setAppearance(false); appearanceButton.current?.focus(); };
      const closeWorkDraft = () => {setWorkOpen(false);workButton.current?.focus({preventScroll:true});};
      const focusOnce = React.useRef(true);
      const contact = data?.contacts?.find((p) => p.id === persona);
      const bubbleColors=useChatBubbleColors(data?.contacts,data?.room);
      const ready = data?.personaId === persona && (!explicitRoomId||data?.room?.id===explicitRoomId) && data?.ready && context?.initialized;
      roomMembers.current=data?.room?.memberIds??[];
      const turns = ready ? data.room?.turns ?? [] : [];
      const chatNow=Date.now();
      const committedInputs=new Set(),userPartsByTurn=new Map();
      for(const turn of turns){const parts=chatUserParts(turn).filter(part=>!committedInputs.has(part.id));if(parts.length)userPartsByTurn.set(turn.id,parts);for(const part of parts)committedInputs.add(part.id);}
      const activeAttempts=new Set(data?.activeAttemptIds??[]),emitted=turn=>Number.isSafeInteger(turn.emittedOrder)&&turn.emittedOrder>=0&&turn.emittedOrder<CHAT_ROUND_SEATS;
      const silenceOwner=JSON.stringify([data?.instanceId,explicitRoomId??persona]);
      const silenceKey=turn=>JSON.stringify([turn.id,turn.attemptId]);
      const silentAttempts=new Set(silenced.owner===silenceOwner?silenced.attempts:[]);
      const rememberSilence=turn=>setSilenced(previous=>{
        const attempts=previous.owner===silenceOwner?previous.attempts:[],key=silenceKey(turn);
        return attempts.includes(key)?previous:{owner:silenceOwner,attempts:[...attempts.slice(-255),key]};
      });
      const groups=[],byMessage=new Map();
      for(const turn of turns){let group=byMessage.get(turn.messageId);if(!group){group={id:turn.messageId,head:turn,parts:[],turns:[]};byMessage.set(turn.messageId,group);groups.push(group);}group.parts.push(...(userPartsByTurn.get(turn.id)??[]));group.turns.push(turn);}
      for(const group of groups)group.responses=group.turns.map((turn,index)=>({turn,index})).filter(({turn})=>turn.phase!=='anchor'&&!silentAttempts.has(silenceKey(turn))&&(turn.status!=='pending'||emitted(turn)||activeAttempts.has(turn.attemptId))
          &&!(turn.status==='cancelled'&&!emitted(turn)&&!turn.assistant?.length&&['reaction','followup'].includes(turn.phase)))
        .sort((a,b)=>(emitted(a.turn)?a.turn.emittedOrder:a.index)-(emitted(b.turn)?b.turn.emittedOrder:b.index)||a.index-b.index).map(({turn})=>turn);
      const responseTurns=groups.flatMap(group=>group.responses),responseIndex=new Map(responseTurns.map((turn,index)=>[turn.id,index]));
      const queuedInputs=(ready&&Array.isArray(data.queuedInputs)?data.queuedInputs:[]).map(batch=>({...batch,
        parts:(Array.isArray(batch.parts)?batch.parts:[]).filter(part=>part&&chatUiId(part.id)&&typeof part.text==='string'&&!committedInputs.has(part.id))})).filter(batch=>chatUiId(batch.id)&&batch.parts.length);
      const queueWaiting=queuedInputs.some(batch=>batch.status==='pending'||batch.status==='sending');
      const latestMessage=turns.at(-1)?.messageId;
      const directorIssue=data?.directorFailure&&data.directorFailure.messageId===latestMessage?data.directorFailure:null;
      const directorAnswered=!!directorIssue&&turns.some(turn=>turn.messageId===latestMessage&&turn.phase!=='anchor'&&turn.status==='ready'&&turn.assistant?.length);
      const directorIssueReason=directorIssue?chatDirectorIssueReason(directorIssue):'';
      const [presented,setPresented]=React.useState({messageId:null,attempts:[]});
      const afterPresentation=turn=>setPresented(old=>{
        const attempts=old.messageId===turn.messageId?old.attempts:[];
        return attempts.includes(turn.attemptId)?old:{messageId:turn.messageId,attempts:[...attempts.slice(1-CHAT_ROUND_SEATS),turn.attemptId]};
      });
      // A queued speaker can receive stream updates, but cannot appear ahead of an earlier speaker's last bubble.
      // Historical groups render immediately, including when the user sends a new message during local playback.
      const presentationPending=t=>t.status==='pending'||(t.status==='ready'&&chatAnimatedAttempts.has(t.attemptId)
        &&!(presented.messageId===latestMessage&&presented.attempts.includes(t.attemptId)));
      const barrier=responseTurns.findIndex(t=>t.messageId===latestMessage&&presentationPending(t));
      const responseHeld=t=>barrier>=0&&responseIndex.get(t.id)>barrier&&(t.status!=='ready'||presentationPending(t));
      const pending = ready && data.running;
      const stopMessageId=pending && data.roundId && (data.roundMessageId??latestMessage);
      const pendingTurn=stopMessageId?turns.find(t=>t.messageId===stopMessageId && t.status==='pending'):undefined;
      const stopTurn=pendingTurn??(stopMessageId && ['preparing','listening','support'].includes(data.roundPhase)?turns.find(t=>t.messageId===stopMessageId):undefined);
      const currentContextKey = context?.id ? context.id + ':' + context.revision : null;
      const summaryScope = data?.scopeKey ?? null;
      const summaryAvailable = !!summaryScope && data?.supportCapabilities?.workReferences === true;
      const quoteScope=context?.scopeKey??data?.scopeKey??null;
      useLayoutEffect(()=>{
        if(!ready||minimized||readingRestored.current||!thread.current)return;
        const saved=readingRestore.current,element=thread.current;
        if(saved){atBottom.current=saved.atBottom;const owner=[...element.querySelectorAll('[data-chat-turn],[data-chat-user-head]')].find(node=>(node.getAttribute('data-chat-turn')??node.getAttribute('data-chat-user-head'))===saved.anchor?.turnId);
          const bubble=saved.anchor?.kind==='user'?(saved.anchor.messageId?[...element.querySelectorAll('[data-user=true][data-chat-user-part]')].find(node=>node.dataset.chatUserPart===saved.anchor.messageId):owner?.querySelector('[data-user=true]')):owner?.querySelector('[data-chat-bubble="'+(saved.anchor?.index??0)+'"]');
          if(!saved.atBottom)element.scrollTop=bubble?layoutTop(bubble,element)-saved.offset:saved.scrollTop;
          setScrolledUp(!saved.atBottom);
        }else atBottom.current=true;
        syncThreadLayout();
        const selection=chatUi.get(explicitRoomId)?.selection;if(selection)input.current?.setSelectionRange(selection.start,selection.end);
        readingRestored.current=true;noteReadyReplies(latestData.current);saveReading();
      },[ready,minimized,turns.length,data?.instanceId,data?.localStateKey,data?.room?.generation]);
      useLayoutEffect(()=>{const save=()=>saveReading();window.addEventListener('pagehide',save);if(explicitRoomId)chatUiFlushers.set(explicitRoomId,save);
        return()=>{clearTimeout(readingTimer.current);saveReading();window.removeEventListener('pagehide',save);if(chatUiFlushers.get(explicitRoomId)===save)chatUiFlushers.delete(explicitRoomId);};},[]);
      React.useEffect(()=>{
        if(!explicitRoomId||!data?.room)return;
        const next=restoreChatUi(data.room,quoteScope);if(next)setDraft(next);
      },[quoteScope,data?.room?.generation]);
      React.useEffect(()=>{const update=()=>{
        const snapshot=latestData.current;if(!snapshot?.room||!explicitRoomId)return;
        if(chatUiIssues.has(explicitRoomId))setInfo(chatUiIssues.get(explicitRoomId));
        if(!chatUi.has(explicitRoomId)||chatUi.get(explicitRoomId).generation>(snapshot.room.generation??0)){void currentLoad.current();return;}
        const old=chatDrafts.get(explicitRoomId),next=restoreChatUi(snapshot.room,snapshot.scopeKey);
        if(next&&old?.requestId!==next.requestId){setDraft(next);setInfo('此房间的草稿已在另一页面更新，已同步最新内容。');}
      };chatUiListeners.add(update);return()=>chatUiListeners.delete(update);},[]);
      const quoteAvailable=!draft.quote||!!chatQuotedSource(data?.room,draft.quote.ref,quoteScope);
      const avatar = (id, name) => h(PersonaAvatar, { src:data?.contacts?.find(p=>p.id===id)?.avatar, id, name, className: 'dsh-persona-chat-avatar' });
      const accept = (value, token) => {
        if (!live.current || token !== readRevision.current || (explicitRoomId?value.room?.id!==explicitRoomId:personaRef.current && value.personaId !== personaRef.current)) return;
        if (host.current.retired.has(value.instanceId) || retiredInstances.has(value.instanceId)) return;
        if(latestData.current?.instanceId===value.instanceId&&latestData.current.room?.id===value.room?.id
          &&latestData.current.room?.revision>value.room?.revision)return;
        const previousInput=latestData.current;
        if(previousInput?.instanceId===value.instanceId&&previousInput.room?.id===value.room?.id
          &&previousInput.room?.generation===value.room?.generation&&previousInput.scopeKey===value.scopeKey
          &&Number.isSafeInteger(value.inputRevision)&&previousInput.inputRevision>value.inputRevision)
          value={...value,inputRevision:previousInput.inputRevision,queuedInputs:previousInput.queuedInputs,nextReplyAt:previousInput.nextReplyAt};
        if (host.current.id && host.current.id !== value.instanceId) host.current.retired.add(host.current.id);
        host.current.id = value.instanceId;
        personaRef.current = value.personaId; setPersona(value.personaId);
        // Reactions or retry successors may finish between two snapshots. Pace those new attempts
        // just like the original recipients, without replaying a room's saved history on opening.
        useChatUiNamespace(value.localStateKey,value.instanceId);restoreChatUi(value.room,value.scopeKey);
        if(knownGeneration.current!==(value.room?.generation??0)||boundUiScope.current!==chatUiNamespace){knownGeneration.current=value.room?.generation??0;boundUiScope.current=chatUiNamespace;
          const stored=chatUi.get(explicitRoomId)?.reading;knownReading.current=new Set(stored?.known??[]);readingRestore.current=stored??null;
          readingRestored.current=false;atBottom.current=stored?.atBottom!==false;setScrolledUp(!atBottom.current);setNewReplies(0);}
        const previous=latestData.current,lastMessage=value.room?.turns.at(-1)?.messageId;
        if(lastMessage&&previous?.instanceId===value.instanceId&&previous.room?.id===value.room.id
          &&(previous.room.turns.at(-1)?.messageId===lastMessage||chatAnimatedAttempts.has(lastMessage))){
          const known=new Set(previous.room.turns.filter(t=>t.messageId===lastMessage).map(t=>t.attemptId));
          for(const t of value.room.turns)if(t.phase!=='anchor'&&t.messageId===lastMessage&&!known.has(t.attemptId))markChatAnimation(t.attemptId);
        }
        if(previous?.instanceId===value.instanceId&&previous.room?.id===value.room.id){const queuedIds=new Set((previous.queuedInputs??[]).flatMap(batch=>(batch.parts??[]).map(part=>part.id)));
          for(const turn of value.room.turns)if(turn.messageId===lastMessage&&chatUserParts(turn).some(part=>queuedIds.has(part.id)))markChatAnimation(turn.attemptId);}
        latestData.current=value;
        noteReadyReplies(value);
        setData((previous) => previous?.instanceId === value.instanceId && (previous.userProfile?.revision ?? -1) > (value.userProfile?.revision ?? -1)
          ? { ...value, userProfile: previous.userProfile } : value);
        const key=explicitRoomId??value.personaId;
        const imageKey=key+':'+(value.room?.generation??0),submitted=chatImageSends.get(imageKey);
        const imageParts=[...(value.queuedInputs??[]).flatMap(b=>b.parts??[]),...(value.room?.turns??[]).flatMap(t=>chatUserParts(t))];
        if(submitted&&imageParts.some(p=>p.id===submitted.requestId&&(p.images?.length??0)>0)){
          const remaining=(chatImageDrafts.get(imageKey)??[]).filter(image=>!submitted.ids.includes(image.id));
          rememberChatImages(imageKey,remaining);chatImageSends.delete(imageKey);
          if(imageScopeRef.current===imageKey)setImages(remaining);
        }
        for(const turn of value.room?.turns??[])if(chatRetryIds.get(key+':'+turn.id)===turn.attemptId)chatRetryIds.delete(key+':'+turn.id);
        const current = chatDrafts.get(key);
        const acknowledged=current&&((value.queuedInputs??[]).some(batch=>batch.parts?.some(part=>part.id===current.requestId&&part.text===current.text))
          ||value.room?.turns.some(turn=>chatUserParts(turn).some(part=>part.id===current.requestId&&part.text===current.text)));
        if (acknowledged) {
          for(const turn of value.room.turns)if(turn.phase!=='anchor'&&turn.messageId===current.requestId)markChatAnimation(turn.attemptId);
          const empty = saveChatDraft(key,emptyChatDraft(),current.requestId,value.room,value.scopeKey);setDraft(empty);
        } else setDraft(current ?? emptyChatDraft());
        // Only durable replies completed while this particular room was tucked away are unread.
        // A streaming delta, a cancelled attempt and the three bubbles of a single answer are not three replies.
        const dock=dockSession.current;
        if(dock&&chatRuntime.minimized){
          const reset=dock.instance!==value.instanceId||dock.generation!==value.room?.generation;
          if(reset){dock.instance=value.instanceId;dock.generation=value.room?.generation;dock.known.clear();dock.count=0;}
          for(const t of value.room?.turns??[])if(t.status==='ready'&&t.phase!=='anchor'){
            if(!reset&&!dock.known.has(t.attemptId))dock.count++;
            dock.known.add(t.attemptId);chatAnimatedAttempts.delete(t.attemptId);
          }
        }
        onRoomState?.(value);
      };
      const load = async (id = personaRef.current, background = false) => {
        reading.current?.abort();
        const abort = new AbortController(); reading.current = abort;
        let timedOut=false;
        const timeout=setTimeout(()=>{timedOut=true;abort.abort();},10000);
        const token = ++readRevision.current;
        try {
          const query = new URLSearchParams(); if(explicitRoomId)query.set('room',explicitRoomId);else if (id) query.set('persona', id); if (fixedSessionId) query.set('session', fixedSessionId);
          const response = await fetch(ROUTE + '/chat' + (query.size ? '?' + query : ''), { signal: abort.signal });
          if (!live.current || token !== readRevision.current) return;
          if (response.status === 404 && id) {
            if(explicitRoomId){
              if(chatRuntime.minimized&&dockSession.current){
                // Another window removed the room. Stay tucked away until the user opens the room list.
                dockSession.current.missing=true;setSyncDelayed(false);setData(old=>old?.running?{...old,running:false}:old);return true;
              }
              onRoomMissing?.();return;
            }
            personaRef.current = undefined; chatPersonaChoices.delete(scope); setChoice(''); setPersona(undefined); void load(undefined); return;
          }
          const value = await response.json();
          if (!live.current||token!==readRevision.current||abort.signal.aborted)return;
          if (!response.ok) throw new Error(value.error);
          accept(value, token);setSyncDelayed(false);return true;
        } catch (error) {
          if (live.current && token === readRevision.current && (!abort.signal.aborted||timedOut)) {
            setSyncDelayed(true);
            if(!background&&error.message!=='Failed to fetch')setInfo(chatErrorText(error.message));
          }
          return false;
        }finally{clearTimeout(timeout);}
      };
      const currentLoad=React.useRef(load);currentLoad.current=load;
      React.useEffect(() => {
        live.current = true; const previous = typeof document !== 'undefined' ? document.activeElement : undefined;
        const update = (id, owner) => { if (owner !== windowOwner.current && (explicitRoomId?id===explicitRoomId||roomMembers.current.includes(id):id === personaRef.current) && !busyRef.current) void load(id); };
        const profileUpdate = (value) => setData((previous) => previous?.instanceId === value.instanceId
          && (previous.userProfile?.revision ?? -1) <= value.revision ? { ...previous, userProfile: value } : previous);
        chatUpdates.add(update);
        chatProfileUpdates.add(profileUpdate);
        void load(); input.current?.focus();
        return () => { live.current = false; chatUpdates.delete(update); chatProfileUpdates.delete(profileUpdate); readRevision.current += 1; reading.current?.abort();
          if(explicitRoomId)for(const turn of latestData.current?.room?.turns??[])chatAnimatedAttempts.delete(turn.attemptId);
          suggestRequest.current.revision += 1; suggestRequest.current.abort?.abort(); if (previous?.isConnected) previous.focus(); };
      }, []);
      React.useEffect(()=>{if(explicitRoomId&&initialState)accept(initialState,readRevision.current);},[initialState]);
      React.useEffect(() => {
        if (explicitRoomId || choice || !fixedReportPersona || personaRef.current === fixedReportPersona) return;
        const id = fixedReportPersona;
        personaRef.current = id; setPersona(id); setData(undefined); setInfo(''); setClearConfirm(false);
        atBottom.current = true; setScrolledUp(false); void load(id);
      }, [choice, fixedReportPersona]);
      const accountAvatar = useAccountAvatar(!minimized && !!data?.userProfile && userAvatarMode(data.userProfile) === 'account');
      React.useEffect(() => {
        if (ready && focusOnce.current) { input.current?.focus(); focusOnce.current = false; }
      }, [ready]);
      React.useEffect(() => {
        if ((!pending&&!queueWaiting&&!syncDelayed) || busy) return;
        let timer,sequence=0,alive=true,interval=1000;
        const streamKey=JSON.stringify([explicitRoomId,data?.instanceId]);
        const poll=async()=>{
          if(!alive||busyRef.current||document.visibilityState==='hidden')return;
          const token=++sequence,ok=await currentLoad.current(undefined,true);
          if(!alive||token!==sequence||document.visibilityState==='hidden'||(ok&&!latestData.current?.running&&!(latestData.current?.queuedInputs??[]).some(batch=>batch.status==='pending'||batch.status==='sending')))return;
          const state=latestData.current,stream=roomLiveConnections.get(streamKey);
          const covered=ok&&state?.roundPhase==='speaking'&&!state.queuedInputs?.length&&stream?.connected
            &&stream.frames.some(frame=>frame.status==='streaming'&&state.activeAttemptIds?.includes(frame.attemptId));
          interval=ok?(covered?8000:1000):Math.min(8000,interval*2);
          timer=setTimeout(poll,interval);
        };
        const visibility=()=>{sequence++;clearTimeout(timer);interval=1000;
          if(document.visibilityState!=='hidden')void poll();else reading.current?.abort();
        };
        if(document.visibilityState!=='hidden')timer=setTimeout(poll,interval);
        const disconnected=key=>{if(key===streamKey&&interval===8000){clearTimeout(timer);interval=1000;timer=setTimeout(poll,0);}};
        roomLiveDisconnects.add(disconnected);document.addEventListener('visibilitychange',visibility);
        return()=>{alive=false;sequence++;clearTimeout(timer);roomLiveDisconnects.delete(disconnected);document.removeEventListener('visibilitychange',visibility);};
      }, [pending,queueWaiting,syncDelayed,busy,explicitRoomId,persona,data?.instanceId]);
      const resetSuggestions = () => {
        suggestRequest.current.revision += 1; suggestRequest.current.abort?.abort(); suggestRequest.current.busy = false;
        setSuggestions([]); setSuggestBusy(false); setSuggestInfo('');
      };
      const chatGeneration=explicitRoomId?(data?.room?.generation??0):data?.epoch;
      React.useEffect(resetSuggestions, [persona, data?.room?.id, data?.room?.revision, data?.instanceId, chatGeneration, suggestMode, context?.id, context?.revision]);
      React.useEffect(() => setRetryConfirm(null), [persona, data?.room?.revision, data?.instanceId, chatGeneration, currentContextKey]);
      const edit = (text) => {
        resetSuggestions();
        const next = { ...draft,text, requestId: chatNonce() }; saveChatDraft(draftScope, next); setDraft(next);
      };
      const toggleSupport=async(template,enabled)=>{
        if(!Object.hasOwn(chatSupportCards,template)||supportWrite.current)return false;
        const owner=imageScope,field=chatSupportCards[template].setting,abort=new AbortController();
        supportWrite.current=abort;setSupportSaving(true);setSupportNotice('');const timeout=setTimeout(()=>abort.abort(),10000);
        try{
          const response=await fetch(ROUTE+'/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({[field]:enabled}),signal:abort.signal}),value=await response.json();
          if(!live.current||imageScopeRef.current!==owner||abort.signal.aborted)return false;
          if(!response.ok||value.settings?.[field]!==enabled)throw Error('support-settings-save');
          const current=latestData.current;if(!current)return false;
          reading.current?.abort();readRevision.current++;
          const next={...current,supportCapabilities:{...current.supportCapabilities,[template]:enabled}};latestData.current=next;setData(next);void currentLoad.current(undefined,true);return true;
        }catch{if(live.current&&imageScopeRef.current===owner)setSupportNotice('辅助设置暂未保存，草稿保持原样；请重试。');return false;}
        finally{clearTimeout(timeout);if(supportWrite.current===abort)supportWrite.current=null;if(live.current&&imageScopeRef.current===owner)setSupportSaving(false);}
      };
      const insertSupportRequest=async template=>{
        const prefix=chatSupportRequestPrefixes[template];if(!prefix||supportWrite.current)return;
        const owner=imageScope;
        const build=current=>{const existing=Object.values(chatSupportRequestPrefixes).find(value=>current.text.startsWith(value));return prefix+(existing?current.text.slice(existing.length):current.text);};
        if(build(chatDrafts.get(draftScope)??draft).length>4000){setSupportNotice('当前草稿较长，请先缩短后再填入辅助请求。');return;}
        if(!latestData.current?.supportCapabilities?.[template]&&!await toggleSupport(template,true))return;
        if(!live.current||imageScopeRef.current!==owner)return;
        const current=chatDrafts.get(draftScope)??draft,text=build(current);
        if(text.length>4000){setSupportNotice('草稿已更新，请先缩短后再填入辅助请求。');return;}
        resetSuggestions();const next={...current,text,requestId:chatNonce()};saveChatDraft(draftScope,next);setDraft(next);setSupportOpen(false);
        setInfo('已填入'+(template==='research'?'调查':'推演')+'请求，可修改后发送。');input.current?.focus();
      };
      const chooseQuote=(turn,index,text,partId)=>{
        resetSuggestions();
        const ref={roomId:explicitRoomId,generation:data.room.generation??0,...(index===null?{kind:'user',messageId:partId??turn.messageId}
          :{kind:'assistant',turnId:turn.id,attemptId:turn.attemptId,index})};
        const author=index===null?{role:'user',name:'我'}:{role:'assistant',id:turn.recipientId,name:turn.speakerName};
        const next={...draft,requestId:chatNonce(),quote:{ref,author,text}};saveChatDraft(draftScope,next);setDraft(next);input.current?.focus();
      };
      const cancelQuote=()=>{const {quote,...rest}=draft;const next={...rest,requestId:chatNonce()};saveChatDraft(draftScope,next);setDraft(next);resetSuggestions();input.current?.focus();};
      const jumpQuote=ref=>{
        const source=chatQuotedSource(data.room,ref,quoteScope);if(!source||!thread.current)return;
        const node=[...thread.current.querySelectorAll('[data-chat-turn]')].find(el=>el.getAttribute('data-chat-turn')===source.turn.id);
        const target=ref.kind==='user'?[...thread.current.querySelectorAll('[data-user=true]')].find(element=>element.dataset.chatUserPart===ref.messageId):node?.querySelector('[data-chat-bubble="'+ref.index+'"]');
        if(!target)return;
        thread.current.querySelectorAll('.dsh-persona-chat-quoted-highlight').forEach(el=>el.classList.remove('dsh-persona-chat-quoted-highlight'));
        atBottom.current=false;target.scrollIntoView({block:'center',behavior:'instant'});followLatest(false);target.tabIndex=-1;target.focus({preventScroll:true});
        target.classList.add('dsh-persona-chat-quoted-highlight');target.addEventListener('blur',()=>target.classList.remove('dsh-persona-chat-quoted-highlight'),{once:true});
      };
      const generateSuggestions = async () => {
        if (!ready || !suggestMode || suggestRequest.current.busy || pending || queueWaiting || contact?.archived) return;
        const suggestionPersona=explicitRoomId?(data.room.targetPersonaIds[0]??data.room.memberIds.find(id=>data.contacts.some(p=>p.id===id&&!p.archived))):persona;
        if(!suggestionPersona)return;
        const abort = new AbortController(), token = ++suggestRequest.current.revision;
        suggestRequest.current.abort = abort; suggestRequest.current.busy = true;
        setSuggestBusy(true); setSuggestInfo(''); setSuggestions([]);
        try {
          const response = await fetch(ROUTE + '/chat/suggestions', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ personaId: suggestionPersona, roomId: data.room?.id ?? null, revision: data.room?.revision ?? 0, epoch: data.epoch, instruction: draft.text,
              contextKey:context?.id?context.id+':'+context.revision:undefined }), signal: abort.signal });
          const value = await response.json();
          if (!live.current || token !== suggestRequest.current.revision || abort.signal.aborted) return;
          if (!response.ok) throw new Error(value.error);
          setSuggestions(value.suggestions);
        } catch (error) {
          if (live.current && token === suggestRequest.current.revision && !abort.signal.aborted) setSuggestInfo(error.message === 'suggestions-context-changed'
            ? '讨论或参考来源已经更新，请重新生成参考。' : error.message==='suggestions-no-context'
              ?'请先在当前参考范围下聊几句，或在输入框中说明希望生成什么。':'暂时没有生成参考，输入仍保留，可以重试。');
        } finally {
          if (token === suggestRequest.current.revision) { suggestRequest.current.busy = false; if (live.current) setSuggestBusy(false); }
        }
      };
      const act = async (body,endpoint='chat') => {
        if (busyRef.current || !ready) return;
        busyRef.current = true; setBusy(true); setInfo(''); reading.current?.abort();
        const id = persona, token = ++readRevision.current;
        try {
          const { ok, value } = await actionRequest(endpoint, { ...body,roomId:explicitRoomId, personaId: id, epoch: data.epoch,
            contextKey:context?.id?context.id+':'+context.revision:undefined });
          if(ok&&body.action==='send')for(const turn of (value?.state??value)?.room?.turns??[])if(turn.phase!=='anchor'&&chatUserParts(turn).some(part=>part.id===body.requestId))markChatAnimation(turn.attemptId);
          if (value?.state) accept(value.state, token); else if (ok) accept(value, token);
          if (!ok) throw new Error(value.error);
          if (body.action === 'clear' && live.current && personaRef.current === id) {
            setClearConfirm(false); setInfo('已清空此角色的聊天记录，已保存偏好仍在设置中管理。');
            if (!value.contacts?.some((p) => p.id === id)) { personaRef.current = undefined; setPersona(undefined); void load(); }
          }
        } catch (error) {
          if (live.current && token === readRevision.current) { setInfo(chatErrorText(error.message)); void load(id); }
        } finally {
          busyRef.current = false; if (live.current) setBusy(false);
          for (const update of chatUpdates) update(explicitRoomId??id, windowOwner.current);
        }
      };
      const inspectImageModel=async(owner)=>{
        try{
          const response=await fetch(ROUTE+'/chat-model-options?room='+encodeURIComponent(explicitRoomId),{signal:AbortSignal.timeout(8500)});
          const value=await response.json();
          if(!live.current||imageScopeRef.current!==owner)return null;
          const status=value.vision??'unknown';
          setImageInfo(status==='unsupported'?'当前模型只支持文字。可切换视觉模型，或仅发送文字；图片会保留。':status==='unknown'?'当前模型未声明视觉能力，将尝试发送；若不支持，可换模型重试。':'');
          return status;
        }catch{return live.current&&imageScopeRef.current===owner?'unknown':null;}
      };
      const addImages=async(files)=>{
        if(!explicitRoomId||!ready||imageSending.current||imageBusy)return;
        if(data?.imagesAvailable===false){setImageInfo(chatErrorText('chat-images-unavailable'));return;}
        if(busyRef.current){setImageInfo('正在发送，请稍候再添加图片。');return;}
        const owner=imageScopeRef.current,old=chatImageDrafts.get(owner)??[],chosen=Array.from(files??[]);
        if(!chosen.length)return;
        if(old.length+chosen.length>3||chosen.some(f=>!['image/png','image/jpeg','image/webp','image/gif'].includes(chatImageType(f))||!f.size||f.size>4*1024*1024)
          ||old.reduce((n,i)=>n+i.bytes,0)+chosen.reduce((n,f)=>n+f.size,0)>8*1024*1024){setImageInfo(chatErrorText('invalid-chat-images'));return;}
        imageSending.current=owner;setImageBusy(true);setImageInfo('');
        try{
          const selected=await Promise.all(chosen.map(file=>new Promise((resolve,reject)=>{
            const reader=new FileReader();reader.onerror=reject;reader.onload=()=>resolve({id:chatNonce(),mediaType:chatImageType(file),data:String(reader.result).split(',')[1],name:file.name,bytes:file.size});
            reader.readAsDataURL(file);
          })));
          if(!live.current||imageScopeRef.current!==owner)return;
          const next=[...(chatImageDrafts.get(owner)??[]),...selected];
          rememberChatImages(owner,next);setImages(next);
          const changed={...(chatDrafts.get(draftScope)??draft),requestId:chatNonce()};saveChatDraft(draftScope,changed);setDraft(changed);
          void inspectImageModel(owner);
        }catch{if(live.current&&imageScopeRef.current===owner)setImageInfo('图片暂时无法读取，原输入保留。');}
        finally{if(imageSending.current===owner)imageSending.current=false;if(live.current&&imageScopeRef.current===owner)setImageBusy(false);}
      };
      const removeImage=id=>{
        const next=(chatImageDrafts.get(imageScope)??[]).filter(i=>i.id!==id);rememberChatImages(imageScope,next);setImages(next);setImageInfo('');
        const changed={...draft,requestId:chatNonce()};saveChatDraft(draftScope,changed);setDraft(changed);
      };
      const send = async (textOnly=false) => {
        const selected=textOnly===true?[]:[...(chatImageDrafts.get(imageScope)??[])];
        if ((!draft.text.trim()&&!selected.length) || imageBusy || imageSending.current || !quoteAvailable || (pending&&!data?.canQueue&&!data?.canYield) || roomBusy || contact?.archived || !data?.modelReady || contextState.busy) return;
        const owner=imageScope;imageSending.current=owner;setImageBusy(true);
        try{
        if(selected.length&&await inspectImageModel(owner)==='unsupported')return;
        if(!live.current||imageScopeRef.current!==owner)return;
        resetSuggestions();
        const current={...draft,text:draft.text.trim()?draft.text:'（发送了 '+selected.length+' 张图片）',...(textOnly===true&&images.length?{requestId:chatNonce()}:{})};
        if(selected.length)chatImageSends.set(owner,{requestId:current.requestId,ids:selected.map(i=>i.id)});
        else chatImageSends.delete(owner);
        while(chatImageSends.size>32)chatImageSends.delete(chatImageSends.keys().next().value);
        if((chatDrafts.get(draftScope)?.requestId??draft.requestId)===draft.requestId){saveChatDraft(draftScope, current);setDraft(current);}
        followLatest(true);
        markChatAnimation(current.requestId);
        return await act({ action: 'send', requestId: current.requestId, content: current.text, revision: data.room?.revision ?? 0,clientTime:chatClientTime(),
          ...(summaryAvailable&&current.summaryScope===summaryScope?{summarize:true}:{}),
          ...(selected.length?{images:selected.map(({mediaType,data,name})=>({mediaType,data,name}))}:{}),
          ...(textOnly===true?{withoutImages:true}:{}),
          ...(draft.quote?{quote:draft.quote.ref}:{}),
          ...(explicitRoomId?{recipientIds:data.room.targetPersonaIds}:{}),
          ...(data.canYield&&!data.canQueue?{afterMessageId:data.roundMessageId,configRevision:data.room.configRevision}:{}) });
        }finally{if(imageSending.current===owner)imageSending.current=false;if(live.current&&imageScopeRef.current===owner)setImageBusy(false);}
      };
      const retry = (turn, confirmed = false) => {
        if (!ready || busyRef.current || roomBusy || contextState.busy || pending || !data.modelReady) return;
        const sameScope=explicitRoomId&&turn.scopeKey&&turn.scopeKey===(context?.scopeKey??data.scopeKey);
        if ((turn.contextKey ?? null) !== currentContextKey && !sameScope && !confirmed) { setRetryConfirm(turn); return; }
        setRetryConfirm(null); resetSuggestions(); followLatest(true);
        const key = draftScope + ':' + turn.id, id = chatRetryIds.get(key) ?? chatNonce();
        keepDraft(chatRetryIds, key, id); markChatAnimation(id);
        return act({ action: 'retry', id: turn.id, attemptId: id, revision: data.room.revision,clientTime:chatClientTime(),
          ...(confirmed ? { previousContextKey: turn.contextKey ?? null } : {}) });
      };
      const unread=dockSession.current?.count??0;
      const sourceHint = roomReferenceHint(context, foreground);
      const resetImageDrag=()=>{imageDragDepth.current=0;setImageDragging(false);};
      const dragImages=event=>{
        if(!explicitRoomId||!chatTransferHasFiles(event.dataTransfer))return;
        event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';setImageDragging(true);
      };
      const themeStyle = {'--chat-brand':theme.color};
      const view = minimized?h('aside',{ref:surface,className:'dsh-persona-chat-dock',style:themeStyle,'data-dock-order':0,'aria-label':'已最小化的聊天室'},
        h('style',null,ROOM_CHAT_CSS),
        h('button',{type:'button',ref:dockButton,'aria-label':'还原聊天室'+(unread?'，'+unread+' 条新回复':''),title:'还原 · '+(data?.room?.name??'聊天室'),onClick:()=>chatRuntime.setMinimized(false)},
          h('span',{'aria-hidden':true},h(RoomAvatar,{memberIds:data?.room?.memberIds,contacts:data?.contacts})),h('span',null,'聊天室'),
          unread?h('span',{key:unread,className:'dsh-persona-chat-dock-count','aria-hidden':true},unread>99?'99+':String(unread)):null),
        h('button',{type:'button','aria-label':'关闭聊天室',title:pending?'关闭窗口，已发送的回复会继续保存；需要中止请先停止回复。':'关闭聊天室',onClick:onClose},'×'),
        h('span',{className:'dsh-persona-chat-dock-status',role:'status','aria-live':'polite','aria-atomic':true},unread?'聊天室收到 '+unread+' 条新回复':'')):
        h('section', { ref:surface,className: 'dsh-persona-chat', style:themeStyle, 'data-wide': String(wide), 'data-compose-expanded':String(composeExpanded), role: 'dialog', 'aria-modal': false,
        onDragEnterCapture:event=>{if(explicitRoomId&&chatTransferHasFiles(event.dataTransfer)){imageDragDepth.current++;dragImages(event);}},
        onDragOverCapture:dragImages,onDragEndCapture:resetImageDrag,
        onDragLeaveCapture:()=>{if(imageDragDepth.current>0&&!--imageDragDepth.current)setImageDragging(false);},
        onDropCapture:event=>{if(!explicitRoomId||!chatTransferHasFiles(event.dataTransfer))return;event.preventDefault();event.stopPropagation();resetImageDrag();
          const files=chatTransferImages(event.dataTransfer);if(files.length)void addImages(files);else setImageInfo('这里只支持图片；文字草稿已保留。');},
        'aria-label': '聊天室', onKeyDown: (event) => { if (event.key === 'Escape' && !event.nativeEvent?.isComposing) {
          event.stopPropagation(); if(workOpen){event.preventDefault();closeWorkDraft();}else if(supportOpen){event.preventDefault();setSupportOpen(false);supportButton.current?.focus();}else if (roomPanel) onDismissPanel?.(); else if (appearance) closeAppearance(); else if(draft.quote){event.preventDefault();cancelQuote();}else onClose();
        } } },
        h('style', null, CHAT_CSS, CHAT_APPEARANCE_CSS,ROOM_CHAT_CSS,FLOATING_WINDOW_CSS),
        h(FloatingWindowHandles,{controls:floating,label:'聊天室'}),
        h('header', { ...floating.dragProps,className: 'dsh-persona-chat-top','data-room':String(!!explicitRoomId) }, explicitRoomId?h('span',{className:'dsh-persona-room-avatar-display',title:data?.room?.memberIds.length===1?chatMemberStatus(activityData,data.room.memberIds[0])?.detail:undefined},
          h(RoomAvatar,{memberIds:data?.room?.memberIds,contacts:data?.contacts}),data?.room?.memberIds.length===1?h(ChatMemberActivity,{status:chatMemberStatus(activityData,data.room.memberIds[0]),name:data.contacts.find(p=>p.id===data.room.memberIds[0])?.name??'角色'}):null):avatar(persona, contact?.name),
          explicitRoomId?h('div',{className:'dsh-persona-chat-room-heading'},
            h('button',{type:'button',className:'dsh-persona-chat-room-title','aria-label':'切换聊天室',disabled:roomBusy,title:'切换聊天室 · '+(data?.room?.name??'聊天室'),onClick:()=>{setWorkOpen(false);onOpenRooms?.();}},
              h('span',null,data?.room?.name??'聊天室'),h('span',{'aria-hidden':true},'⌄')),
            h('nav',{className:'dsh-persona-chat-room-tools','aria-label':'聊天室管理'},
              h('button',{type:'button','aria-label':'管理聊天室成员',disabled:roomBusy,
                title:'管理成员 · '+(data?.room?.memberIds.length??0)+' 位人格',onClick:()=>{setWorkOpen(false);onOpenMembers?.();}},'成员'),
              h('button',{type:'button','aria-label':sourcesOpen?'收起来源':'参考来源','aria-expanded':sourcesOpen,'aria-controls':'dsh-persona-chat-source-panel',
                title:sourceHint.title,'data-source-different':sourceHint.different,'data-source-count':context?.initialized?context.sources?.length??0:undefined,style:{flex:'0 1 auto',minWidth:0,maxWidth:180,overflow:'hidden',textOverflow:'ellipsis'},
                onClick:()=>{setWorkOpen(false);setSourcesOpen(!sourcesOpen);}},
                h('span',{className:'dsh-persona-chat-source-full'},sourceHint.text),h('span',{className:'dsh-persona-chat-source-short'},sourceHint.different?'固定':'来源')),
              h('button',{type:'button',ref:workButton,'aria-label':'整理工作指令','aria-expanded':workOpen,disabled:roomBusy||!ready,
                onClick:()=>{onDismissPanel?.();setAppearance(false);setSourcesOpen(false);setWorkOpen(!workOpen);}},'整理指令'))):h('strong', { className:'dsh-persona-chat-title' }, '聊天室'),
          h('div', { className:'dsh-persona-chat-actions' },
            h('button', { type: 'button', onClick: () => {setWorkOpen(false);setClearConfirm(!clearConfirm);}, disabled: !turns.length || busy || roomBusy }, '清空'),
            h('button', { type: 'button', ref: appearanceButton, 'aria-label':'聊天室设置','aria-expanded': appearance, onClick: () => {setWorkOpen(false);setAppearance(!appearance);} }, '设置'),
            h('button', { type:'button',disabled:roomBusy,'aria-label':'最小化聊天室',title:'最小化到右下角，收到回复时提醒',onClick:minimize },
              h('svg',{width:13,height:13,viewBox:'0 0 16 16',fill:'none','aria-hidden':true,style:{verticalAlign:'middle'}},
                h('path',{d:'M3 11h10',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round'}))),
            h('button', { type: 'button', onClick: () => {if(explicitRoomId)chatRoomLayout.wide=!wide;setWide(!wide);} }, wide ? '还原' : '放大'),
            h('button', { type: 'button', 'aria-label': '关闭聊天室', title:pending?'关闭窗口，已发送的回复会继续保存；需要中止请先停止回复。':'关闭聊天室', onClick: onClose }, '关闭')),
          !explicitRoomId?h('div', { className:'dsh-persona-chat-context-row' },
            h('select', { 'aria-label': '聊天人格',title:choice?contact?.name:'跟随主要参考会话的汇报人格', value: choice, disabled: busy || !data,
              onChange: (event) => {
                resetSuggestions();
                const selected = event.target.value; setChoice(selected);
                if (selected) keepDraft(chatPersonaChoices, scope, selected); else chatPersonaChoices.delete(scope);
                const id = selected || fixedReportPersona || data?.reportPersonaId || data?.defaultPersonaId;
                personaRef.current = id; setPersona(id);
                setDraft(chatDrafts.get(id) ?? emptyChatDraft()); setInfo(''); setClearConfirm(false); atBottom.current = true; setScrolledUp(false); void load(id);
              } }, !data ? h('option', { value: '' }, '正在读取…') : null,
              data ? h('option', { value: '' }, '跟随汇报 · ' + (data.contacts?.find(p => p.id === (fixedReportPersona || data.reportPersonaId || data.defaultPersonaId))?.name ?? '默认人格')) : null,
              ...(data?.contacts ?? []).map((p) => h('option', { key: p.id, value: p.id }, p.name + (p.archived ? '（已移除）' : '')))),
            h('button',{type:'button','aria-label':sourcesOpen?'收起来源':'参考来源','aria-expanded':sourcesOpen,'aria-controls':'dsh-persona-chat-source-panel',
              title:sourceHint.title,'data-source-different':sourceHint.different,'data-source-count':context?.initialized?context.sources?.length??0:undefined,style:{flex:'0 1 auto',minWidth:0,maxWidth:180,overflow:'hidden',textOverflow:'ellipsis'},
              onClick:()=>setSourcesOpen(!sourcesOpen)},sourceHint.text)):null),
        sourcesOpen || contextState.error ? h('div', { id:'dsh-persona-chat-source-panel', className: 'dsh-persona-chat-info dsh-persona-chat-sources' },
          contextState.error?h('p',{role:'status'},contextState.error,h('button',{type:'button',disabled:contextState.busy,onClick:()=>contextState.action({action:'open',sessionId,visible:true})},'重试连接')):null,
          sourcesOpen?h('div',null,
            h('p',null,'切换工作页会保留这些来源。未接入项目只显示文件夹名称，不读取会话正文。'),
            ...(context?.sources??[]).map(source=>h('div',{key:source.sessionId,className:'dsh-persona-source-item'},
              h('span',null,source.sessionId===context.primarySessionId?'主要 · ':'',source.name,source.focused?' · 焦点':'',source.error?' · 更新暂未完成':!source.available?' · 暂不可读':''),
              h('button',{type:'button',disabled:contextState.busy,'aria-label':'移除来源'+source.name,onClick:()=>contextState.action({action:'detach',sessionId:source.sessionId})},'移除'))),
            h('div',{className:'dsh-persona-chat-source-actions'},
              h('button',{type:'button',disabled:contextState.busy,onClick:()=>contextState.action({action:'refresh'})},'刷新参考'),
              h('button',{type:'button',disabled:!foreground||!context?.initialized||contextState.busy,onClick:()=>contextState.action({action:'attach',sessionId:foreground,primary:true})},'接入当前会话'),
              h('select',{'aria-label':'选择项目',value:projectId,disabled:contextState.busy,onChange:async e=>{const id=e.target.value;setProjectId(id);setSessionChoices([]);setSessionChoice('');
                if(id){const result=await contextState.action({action:'sessions',projectId:id});if(result?.items)setSessionChoices(result.items);}}},
                h('option',{value:''},'其他项目…'),...(context?.projects??[]).map(p=>h('option',{key:p.id,value:p.id},p.name))),
              projectId?h('select',{'aria-label':'选择参考会话',value:sessionChoice,onChange:e=>setSessionChoice(e.target.value)},h('option',{value:''},sessionChoices.length?'选择会话…':'没有可用会话'),
                ...sessionChoices.map(s=>h('option',{key:s.sessionId,value:s.sessionId},s.name))):null,
              sessionChoice?h('button',{type:'button',disabled:contextState.busy,onClick:()=>contextState.action({action:'attach',sessionId:sessionChoice})},'接入所选会话'):null),
            h('p',null,'焦点依据近期查看、接入和聊天操作计算，仅调整已接入来源的更新频率。改变参考范围后，后续回复使用新的来源；旧范围的聊天不自动提供给模型。')):null) : null,
          (context?.notices??[]).some(n=>!n.read)?h('details',{className:'dsh-persona-context-notices'},h('summary',null,'相关会话更新 · '+context.notices.filter(n=>!n.read).length),
            ...context.notices.filter(n=>!n.read).map(n=>h('div',{key:n.id,className:'dsh-persona-source-item'},
              h('span',null,n.name+' · '+(n.kind==='error'?'出现运行异常':'一轮汇报已结束')),
              !n.attached?h('button',{type:'button',disabled:contextState.busy,onClick:()=>contextState.action({action:'attach',sessionId:n.sessionId})},'接入查看'):null,
              h('button',{type:'button',onClick:()=>contextState.action({action:'dismiss',noticeId:n.id})},'已读')))):null,
        appearance ? h('section', { className: 'dsh-persona-chat-appearance','aria-label':'聊天室设置' },
          h('div',{className:'dsh-persona-chat-settings-heading'},h('strong',null,'聊天室设置'),h('button',{type:'button',onClick:closeAppearance},'收起设置')),
          h('div',{className:'dsh-persona-chat-settings-body'},
            h('fieldset',{className:'dsh-persona-chat-themes'},h('legend',null,'主题色'),
              h('div',{className:'dsh-persona-chat-swatches'},...CHAT_THEMES.map(option=>
                h('label',{key:option.id,style:{'--swatch':option.color}},
                  h('input',{type:'radio',name:'dsh-persona-chat-theme',value:option.id,checked:option.id===theme.id,onChange:()=>chooseTheme(option)}),option.name))),
              themeNotice?h('small',{role:'status'},themeNotice):null),
            h(ChatThinkingControls,{visible:!minimized,roomId:explicitRoomId,routeKey:context?.primarySessionId??fixedSessionId}),
            h('div',{className:'dsh-persona-chat-settings-appearance'},h(ChatUserSettings)))) : null,
        workOpen&&explicitRoomId?h(WorkDraftPanel,{key:explicitRoomId,roomId:explicitRoomId,scopeKey:quoteScope,generation:data?.room?.generation,
          referenceRevision:data?.room?.referenceRevision??0,discussionRevision:data?.room?.discussion?.revision??0,onClose:closeWorkDraft,onMinimize:minimize}):null,
        roomPanel,
        remember&&remember.scopeKey===quoteScope&&remember.generation===data.room.generation?h(RememberChatPart,{...remember,key:JSON.stringify([remember.head.messageId,remember.part.id]),room:data.room,contacts:data.contacts,
          onClose:saved=>{setRemember(null);remember.button?.focus();if(saved)void load(undefined,true);}}):null,
        clearConfirm ? h('div', { className: 'dsh-persona-chat-info' }, explicitRoomId?'清空这个聊天室的记录？成员、参考来源和长期记忆仍保留。':'清空这个角色的聊天？已保存偏好仍保留。',
          h('button', { type: 'button', disabled: busy, onClick: () => act({ action: 'clear', revision: data.room?.revision ?? 0 }) }, '确认清空聊天'),
          h('button', { type: 'button', onClick: () => setClearConfirm(false) }, '取消清空')) : null,
        info ? h('div', { className: 'dsh-persona-chat-info', role: 'status', 'aria-live': 'polite' }, info,
          h('button', { type: 'button', onClick: () => { setInfo(''); void load(); } }, '刷新')) : null,
        syncDelayed?h('div',{className:'dsh-persona-chat-info',role:'status'},'连接暂时中断，正在重新读取回复…'):null,
        contact?.archived ? h('div', { className: 'dsh-persona-chat-info' }, explicitRoomId?'这位角色已移除，请选择其他回复对象，或在成员管理中加入新角色。原有聊天保留。':'角色已移除，可以查看或清空历史记录。') : null,
        h('div', { className: 'dsh-persona-chat-thread-wrap' }, h('div', { className: 'dsh-persona-chat-thread', ref: thread, 'aria-label': '聊天消息', 'data-following':!scrolledUp,onScroll:onThreadScroll }, turns.length === 0 && queuedInputs.length === 0 ? h('div', { className: 'dsh-persona-chat-empty' },
          explicitRoomId?h(RoomAvatar,{memberIds:data?.room?.memberIds,contacts:data?.contacts}):avatar(persona, contact?.name),
          h('strong', null, ready ? data?.room?.targetPersonaIds.length!==1?'和大家聊点什么吧':`和${contact?.name ?? '这位角色'}聊点什么吧` : '正在读取聊天记录…'),
          h('p', null, explicitRoomId&&data?.room?.memberIds.length>1?'不点名时发给房间，也可以在下方 @ 想先听的人。':'从一个想法，或今天的小事开始。')) : null,
          h('div',{className:'dsh-persona-chat-thread-content',ref:threadContent},...groups.map((group,groupIndex)=>h('div',{key:group.id,'data-chat-message':group.id},
            h('div',{'data-chat-user-head':group.head.id},
            (groupIndex === 0 || group.head.at - groups[groupIndex-1].head.at > 300000 || chatDateBoundary(group.head.at,groups[groupIndex-1].head.at)) ? h(ChatMessageTime,{at:group.head.at,now:chatNow}) : null,
            group.parts.map((part,partIndex)=>h('div', { key:part.id,className: 'dsh-persona-chat-message', 'data-user': 'true','data-chat-user-part':part.id,
              'data-arriving':group.id===latestMessage&&(group.head.status==='pending'||chatAnimatedAttempts.has(group.head.attemptId))||undefined },
              h(UserChatAvatar, { profile: data.userProfile, accountUrl: accountAvatar, className: 'dsh-persona-chat-avatar' }), h('div', { className: 'dsh-persona-chat-bubble' },
                explicitRoomId&&(group.head.memberIdsAtSend?.length>1||group.head.recipients.length>1)?h('small',{className:'dsh-persona-chat-mentions'},group.head.recipients.map(p=>'@'+p.name).join(' ')):null,
                partIndex===0&&group.head.quote?h(ChatQuotedMessage,{quote:group.head.quote,available:!!chatQuotedSource(data.room,group.head.quote.ref,quoteScope),onJump:()=>jumpQuote(group.head.quote.ref)}):null,part.text,
                h(ChatImages,{images:part.images,roomId:data.room?.id,generation:data.room?.generation??0})),
              explicitRoomId&&(group.head.scopeKey??group.head.contextKey??null)===quoteScope?h(React.Fragment,null,
                h(ChatMessageAction,{label:'引用我的消息',title:'引用这句',onClick:()=>chooseQuote(group.head,null,part.text,part.id)}),
                part.text&&data.memoryEnabled?h(ChatMessageAction,{remember:true,label:'记住我的这句',title:'记住这句',
                  onClick:e=>setRemember({part,head:group.head,scopeKey:quoteScope,generation:data.room.generation,button:e.currentTarget})}):null):null))),
            ...group.responses.map(turn=>h('div',{key:turn.id,'data-chat-turn':turn.id},
            h(ChatTurnReply,{key:turn.attemptId,turn,instance:data.instanceId,roomId:explicitRoomId,running:data.running,
              held:responseHeld(turn),latest:turn.messageId===latestMessage,onPresented:afterPresentation,onSilent:rememberSilence,
              started:data.activeAttemptIds?.includes(turn.attemptId),
              onFinish:()=>{if(live.current&&!busyRef.current&&document.visibilityState!=='hidden')void load(undefined,true);},
              showSpeaker:!!explicitRoomId&&(data.room.memberIds.length>1||turn.recipientId!==persona),
              onQuote:explicitRoomId&&(turn.scopeKey??turn.contextKey??null)===quoteScope?chooseQuote:undefined,
              avatar:()=>avatar(turn.recipientId??persona,turn.speakerName),
              colorStyle:chatPalette.style(bubbleColors.get(turn.recipientId??persona))}),
            turn.status==='ready' && data.personalCounts?.[turn.attemptId]?h(ReplyMemory,{key:turn.attemptId,roomId:explicitRoomId,turn,count:data.personalCounts[turn.attemptId],revision:data.memoryRevision}):null,
            !responseHeld(turn)&&turn.status !== 'ready' && !(turn.status === 'pending' && data.running)
              && !(turn.status==='interrupted'&&turn.messageId!==latestMessage&&['reaction','followup'].includes(turn.phase)) ? h('div', { className: 'dsh-persona-chat-turn-state', role: 'status', 'aria-live': 'polite' },
              explicitRoomId&&(data.room.memberIds.length>1||turn.recipients.length>1||turn.phase==='reaction')?h('strong',null,turn.speakerName+' · '):null,
              h('span',null,chatReplyStateText(turn, data.running)),
              turn.messageId === turns.at(-1)?.messageId && !pending
                &&(!explicitRoomId||data.room.memberIds.includes(turn.recipientId)&&!data.contacts.find(p=>p.id===turn.recipientId)?.archived)
                ? h('button', { type: 'button', disabled: busy || roomBusy || contextState.busy || !ready || !data.modelReady,
                  title:turn.directedPlanId?'只重试 '+turn.speakerName+' 的这条回复，其他已完成回复保留。':'从 '+turn.speakerName+' 开始重试；后续接话会重新生成，前面的回复保留。',onClick: () => void retry(turn) },
                  !turn.directedPlanId&&group.responses.indexOf(turn)<group.responses.length-1?'从这里重试':'重试回复') : null) : null)))),
          ...queuedInputs.map(batch=>h('div',{key:'input-'+batch.id,'data-chat-user-head':batch.id,'data-queued-input':batch.id,role:'group','aria-label':'待回应的消息'},
            ...batch.parts.map((part,partIndex)=>h('div',{key:part.id,className:'dsh-persona-chat-message','data-user':'true','data-chat-user-part':part.id},
              h(UserChatAvatar,{profile:data.userProfile,accountUrl:accountAvatar,className:'dsh-persona-chat-avatar'}),
              h('div',{className:'dsh-persona-chat-bubble'},batch.recipients?.length?h('small',{className:'dsh-persona-chat-mentions'},batch.recipients.map(person=>'@'+person.name).join(' ')):null,
                partIndex===0&&batch.quote?.ref&&typeof batch.quote.text==='string'?h(ChatQuotedMessage,{quote:batch.quote,available:!!chatQuotedSource(data.room,batch.quote.ref,quoteScope),onJump:()=>jumpQuote(batch.quote.ref)}):null,part.text,
                h(ChatImages,{images:part.images,roomId:data.room?.id,generation:data.room?.generation??0})))),
            h('div',{className:'dsh-persona-chat-input-state',role:'status','aria-live':'polite'},batch.status==='failed'
              ?h(React.Fragment,null,h('span',null,'这几条暂时没接上，原话已保留。'),
                h('button',{type:'button',disabled:busy||roomBusy||!ready,'aria-label':'重试这组消息',onClick:()=>act({action:'retry-input',requestId:batch.id})},'重试'),
                h('button',{type:'button',disabled:busy||roomBusy||!ready,'aria-label':'取消这组消息',onClick:()=>act({action:'cancel-input',requestId:batch.id})},'取消'))
              :batch.status==='sending'?'正在接上这几句…':'等待回应'))))),
        scrolledUp&&(turns.length||queuedInputs.length)?h('button',{type:'button',className:'dsh-persona-chat-jump',onClick:()=>followLatest(true)},newReplies?newReplies+' 条新回复 · 回到最新消息':'回到最新消息'):null),
        !explicitRoomId&&pending&&(data.roundPhase==='preparing'||barrier<0)?h('div',{role:'status',style:{fontSize:11,color:'var(--chat-muted)',padding:'0 12px 6px'}},data.roundPhase==='preparing'?'正在接上这句话…':data.roundPhase==='listening'?'大家在听…':'等待回应'):null,
        h(ChatSupportStatus,{tasks:(data?.supportTasks??[]).filter(t=>t.messageId===(data?.roundMessageId??turns.at(-1)?.messageId)),minimized,onStop:jobId=>act({action:'cancel-support',jobId})}),
        directorIssue&&!data?.activeAttemptIds?.length?h('div',{className:'dsh-persona-chat-info',role:'status','aria-live':'polite',style:{display:'flex',alignItems:'center',flexWrap:'wrap',gap:'4px 8px'}},
          h('span',null,directorAnswered?'后续接话暂未继续':'暂时没接上，原话已保留'),h('small',{style:{color:'var(--chat-muted)'}},directorIssueReason),
          h('button',{type:'button',disabled:busy||roomBusy||contextState.busy||!ready||!data.modelReady,title:'重新判断接话安排',
            onClick:()=>act({action:'retry-director',messageId:directorIssue.messageId})},directorAnswered?'继续接话':'重试回应')):null,
        !explicitRoomId?h(SlowChatStatus,{data,minimized}):null,
        retryConfirm ? h('div', { className: 'dsh-persona-chat-info', role: 'status' },
          '参考来源与这条消息发送时不同。按当前来源重试同一句话？旧范围的聊天不会带入，用户消息不会重复。',
          h('button', { type: 'button', disabled: busy || contextState.busy, onClick: () => void retry(retryConfirm, true) }, '按当前来源重试'),
          h('button', { type: 'button', onClick: () => setRetryConfirm(null) }, '暂不重试')) : null,
        h('div', { className: 'dsh-persona-chat-compose','data-image-dragging':imageDragging||undefined,style:supportOpen?{maxHeight:'calc(100% - 100px)',overflowY:'auto'}:undefined,
          onPasteCapture:event=>{const files=chatTransferImages(event.clipboardData);if(files.length){event.stopPropagation();if(!event.clipboardData.getData('text/plain'))event.preventDefault();void addImages(files);}} },
          imageDragging?h('span',{className:'dsh-persona-chat-drop-hint',role:'status'},'松开以添加图片'):null,
          h('input',{ref:imageInput,type:'file',hidden:true,multiple:true,accept:'image/png,image/jpeg,image/webp,image/gif','aria-label':'选择聊天图片',
            onChange:event=>{const files=Array.from(event.target.files??[]);event.target.value='';void addImages(files);}}),
          images.length?h('div',{className:'dsh-persona-chat-image-drafts','aria-label':'待发送图片'},...images.map((image,index)=>
            h('div',{key:image.id},h('img',{src:'data:'+image.mediaType+';base64,'+image.data,alt:image.name||'待发图片 '+(index+1)}),
              h('button',{type:'button',disabled:imageBusy||busy,'aria-label':'移除图片 '+(index+1),title:'移除图片',onClick:()=>removeImage(image.id)},'×')))):null,
          imageInfo?h('div',{className:'dsh-persona-chat-image-note',role:'status'},imageInfo,
            images.length&&draft.text.trim()?h('button',{type:'button',disabled:imageBusy||busy,onClick:()=>void send(true)},'仅发送文字'):null):null,
          explicitRoomId&&data?.room?.memberIds.length>1?h('div',{className:'dsh-persona-chat-participants'},
            h(RoomRecipient,{contacts:data?.contacts??[],memberIds:data?.room?.memberIds??[],value:data.room.targetPersonaIds,disabled:busy||roomBusy||!data,activityData,
              onChange:ids=>act({action:'update',targetPersonaIds:ids,configRevision:data.room.configRevision},'chat-rooms')})):null,
          draft.quote?h(ChatQuotedMessage,{quote:draft.quote,available:quoteAvailable,draft:true,onCancel:cancelQuote,onJump:()=>jumpQuote(draft.quote.ref)}):null,
          suggestMode ? h('div', { className: 'dsh-persona-chat-suggest' }, h('div', { className: 'dsh-persona-chat-suggest-head' },
            h('small',null,'点选参考后，可修改再发送。'),
            h('button', { type: 'button', onClick: generateSuggestions, disabled: suggestBusy || busy || !ready || pending || queueWaiting || contact?.archived
              || !data?.modelReady || (!draft.text.trim() && !turns.length) }, suggestBusy ? '正在生成…' : '生成参考')),
            suggestInfo ? h('small', { role: 'status', 'aria-live': 'polite' }, suggestInfo) : null,
            h('div', { className: 'dsh-persona-chat-suggestions', 'aria-label': '参考快捷回复' }, ...suggestions.map((text, index) =>
              h('button', { type: 'button', key: index, onClick: () => {
                const next = { ...draft,text, requestId: chatNonce() }; saveChatDraft(draftScope, next); setDraft(next); input.current?.focus(); setSuggestInfo('已填入，可修改后发送。');
              } }, text)))) : null,
          supportOpen?h(ChatSupportMenu,{id:supportMenuId.current,capabilities:data?.supportCapabilities,disabled:busy||roomBusy||!ready,busy:supportSaving,notice:supportNotice,onToggle:toggleSupport,onInsert:insertSupportRequest,onClose:()=>{setSupportOpen(false);supportButton.current?.focus();}}):null,
          h('textarea', { id:'dsh-persona-chat-input', ref: input, value: draft.text, maxLength: 4000, rows:2,
          'aria-label': '发送给角色的消息', title:'Enter 发送 · Shift+Enter 换行', placeholder: contact?.archived ? '这位角色已移除' : '说点什么…', disabled: !ready, readOnly: contact?.archived === true,
          onSelect:()=>{if(explicitRoomId)updateChatUi(explicitRoomId,{selection:{start:input.current?.selectionStart??0,end:input.current?.selectionEnd??0}});},
          onChange: (event) => edit(event.target.value), onKeyDown: (event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
          } }),
          !data?.modelReady && ready ? h('p', { style: { fontSize: '11px', margin: '0 0 7px' } }, '请先在插件设置中选择聊天室或转述模型。') : null,
          h('div', { className: 'dsh-persona-chat-compose-row' },
            h('div', { className: 'dsh-persona-chat-compose-tools' },
            explicitRoomId?h('button',{type:'button',disabled:!ready||busy||imageBusy||data?.imagesAvailable===false||images.length>=3,title:data?.imagesAvailable===false?'当前宿主没有图片附件服务':'添加图片，也可粘贴截图或拖入','aria-label':'添加图片',onClick:()=>imageInput.current?.click()},'图片'):null,
            explicitRoomId?h('button',{type:'button',ref:supportButton,'aria-label':'聊天室子代理','aria-expanded':supportOpen,'aria-controls':supportMenuId.current,title:'调查资料、深入推演和整理工作参考',onClick:()=>{setSupportOpen(!supportOpen);setSupportNotice('');}},'子代理'):null,
            summaryAvailable?h('label',{title:'仅整理下一条消息用到的工作会话原文'},h('input',{
              type:'checkbox',checked:draft.summaryScope===summaryScope,disabled:!ready||imageBusy||contextState.busy,'aria-label':'本条整理工作参考',onChange:event=>{
                const next={...draft,summaryScope:event.target.checked?summaryScope:undefined,requestId:chatNonce()};saveChatDraft(draftScope,next);setDraft(next);
              }}),h('span',{className:'dsh-persona-chat-compose-full'},'整理工作参考'),h('span',{className:'dsh-persona-chat-compose-short'},'整理参考')):null,
            h('label', {title:'快捷回复参考'}, h('input', { type: 'checkbox', checked: suggestMode, 'aria-label': '快捷回复参考', onChange: (event) => setSuggestMode(event.target.checked) }),
              h('span',{className:'dsh-persona-chat-compose-full'},'快捷回复参考'),h('span',{className:'dsh-persona-chat-compose-short'},'回复参考'))),
            h('div', { className: 'dsh-persona-chat-compose-actions' },
            h('small', {title:'Enter 发送 · Shift+Enter 换行'}, 'Enter 发送'),
            h('button', {type:'button',className:'dsh-persona-chat-compose-expand','aria-label':composeExpanded?'收起输入框':'展开输入框',
              title:composeExpanded?'收起输入框':'展开输入框','aria-expanded':composeExpanded,'aria-controls':'dsh-persona-chat-input',
              onClick:()=>{if(explicitRoomId)chatRoomLayout.composeExpanded=!composeExpanded;setComposeExpanded(!composeExpanded);input.current?.focus({preventScroll:true});}},h(ChatExpandIcon,{expanded:composeExpanded})),
            stopTurn && !((data.canQueue||data.canYield)&&(draft.text.trim()||images.length)) ? h('button', { type: 'button', disabled: busy, onClick: () => {
              void act({ action: 'cancel', id: stopTurn.id, attemptId: stopTurn.attemptId,messageId:stopTurn.messageId,roundId:data.roundId,
                attempts:turns.filter(t=>t.messageId===stopTurn.messageId&&t.status==='pending').map(t=>({id:t.id,attemptId:t.attemptId})) });
            } }, data.roundPhase==='listening'?'停止接话':'停止回复') : h('button', { type: 'button', 'data-primary': '', disabled: !quoteAvailable || (pending&&!data.canQueue&&!data.canYield) || busy || imageBusy || roomBusy || contextState.busy || !ready || (!draft.text.trim()&&!images.length) || contact?.archived || !data?.modelReady,
              title:data?.canQueue&&draft.text.trim()?'发送后先保留这几句，再一起回应':data?.canYield&&draft.text.trim()?'发送新消息，结束本轮接话':undefined,
              onClick:()=>void send() }, pending&&!data.canQueue&&!data.canYield ? (data.roundPhase==='preparing'?'正在确认…':'同步中…') : busy||imageBusy ? '发送中…' : '发送')))));
      // The workspace already has a dedicated body root; another portal would remount the loaded window.
      return view;
    }

