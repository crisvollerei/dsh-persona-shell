// SECTION references
    const discussionLabels={discussing:'讨论中',proposal:'候选方案',confirmed:'已确定',deferred:'已搁置',rejected:'已否定'};
    const assignmentLabels={respond:'先回应用户',complement:'承接并补充',contribute:'旁听补充', 'answer-peer':'回应同伴'};
    function RoomDiscussionPanel({data,busy,saving,change}){
      const [editor,setEditor]=React.useState(null),[removeId,setRemoveId]=React.useState(null);
      const board=data.discussion??{revision:0,entries:[],canUndo:false},choices=data.discussionChoices??[],locked=busy||saving;
      const key=ref=>ref?JSON.stringify(ref):'';
      const short=(text,max=38)=>Array.from(text.replace(/\s+/g,' ').trim()).slice(0,max).join('');
      const author=quote=>quote?.author?.role==='user'?'我':quote?.author?.name??'原消息';
      const label=quote=>author(quote)+' · '+short(quote.text);
      const allChoices=[...choices],currentEntry=board.entries.find(item=>item.id===editor?.id&&item.inScope&&item.source?.text);
      for(const value of [currentEntry?.source,currentEntry?.evidence])if(value?.text&&!allChoices.some(q=>key(q.ref)===key(value.ref)))allChoices.push(value);
      const source=allChoices.find(q=>key(q.ref)===key(editor?.source)),evidence=allChoices.find(q=>key(q.ref)===key(editor?.evidence));
      const terminal=editor&&['confirmed','deferred','rejected'].includes(editor.status);
      const openAdd=()=>{const quote=choices.find(q=>q.author.role==='user')??choices[0];
        setRemoveId(null);setEditor({action:'add',requestId:chatNonce(),title:quote?short(quote.text,80):'',status:quote?.author.role==='assistant'?'proposal':'discussing',source:quote?.ref??null,evidence:null});};
      const edit=item=>{setRemoveId(null);setEditor({action:'update',id:item.id,version:item.version,title:item.title,status:item.status,
        source:item.source.ref,evidence:item.available?item.evidence?.ref??null:null});};
      const update=value=>setEditor(old=>({...old,...value}));
      const submit=async event=>{event.preventDefault();if(locked||!editor||!source||!editor.title.trim()||(terminal&&!evidence))return;
        const saved=await change(editor);if(saved)setEditor(null);};
      const quote=(value,title)=>h('details',null,h('summary',null,title),value?.text?h(React.Fragment,null,h('p',null,author(value)),h('blockquote',null,value.text))
        :h('p',{style:hintStyle},'原话已更改、超出保留范围或来源已变，不恢复旧内容。'));
      return h('section',{'aria-label':'房间讨论状态',className:'dsh-persona-room-discussion'},
        h('style',null,`.dsh-persona-room-discussion{margin:14px 0;min-width:0}.dsh-persona-room-discussion>details{border:1px solid var(--dsh-persona-border);border-radius:10px;overflow:hidden}.dsh-persona-room-discussion>details>summary{padding:11px 12px;font-weight:600}.dsh-persona-room-discussion-body{padding:0 12px 12px}.dsh-persona-room-discussion-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0}.dsh-persona-room-discussion-toolbar button{font-size:12px}.dsh-persona-room-discussion-row{border-top:1px solid var(--dsh-persona-border);padding:11px 0;min-width:0}.dsh-persona-room-discussion-heading{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.dsh-persona-room-discussion-heading strong{font-size:13px;overflow-wrap:anywhere}.dsh-persona-discussion-badge{font-size:11px;white-space:nowrap;border-radius:5px;padding:2px 6px;background:var(--dsh-persona-soft);color:var(--dsh-persona-muted)}.dsh-persona-discussion-badge[data-state=confirmed]{color:var(--dsh-persona-accent)}.dsh-persona-room-discussion-editor{padding:12px;border:1px solid var(--dsh-persona-border);border-radius:8px;background:var(--dsh-persona-soft);margin:10px 0}.dsh-persona-room-discussion-editor label{display:flex;flex-direction:column;gap:5px;margin-bottom:12px;font-size:12px}.dsh-persona-room-discussion-editor :is(input,select){min-width:0;width:100%;box-sizing:border-box}.dsh-persona-room-discussion-editor p{font-size:12px;margin:7px 0}.dsh-persona-room-discussion-editor button{font-size:12px}.dsh-persona-room-discussion-counts{display:flex;gap:7px;flex-wrap:wrap;font-size:11px;color:var(--dsh-persona-muted);margin:8px 0}.dsh-persona-room-discussion-counts span{padding:2px 6px;background:var(--dsh-persona-soft);border-radius:5px}`),
        h('details',null,h('summary',null,'房间讨论 · '+board.entries.length),h('div',{className:'dsh-persona-room-discussion-body'},
          h('p',{style:hintStyle},'从本房间原话整理话题与决定。只用于这里的讨论，不写入长期记忆，也不代表工作已经完成。'),
          board.entries.length?h('div',{className:'dsh-persona-room-discussion-counts','aria-label':'房间讨论状态概览'},...Object.entries(discussionLabels).map(([state,text])=>{
            const count=board.entries.filter(e=>e.status===state).length;return count?h('span',{key:state},text+' '+count):null;})):h('p',{style:hintStyle},'还没有整理过的话题。可以选一句原话，留作本房间的讨论依据。'),
          h('div',{className:'dsh-persona-room-discussion-toolbar'},h('button',{type:'button',style:toggleStyle,disabled:locked||!!editor||!choices.length||board.entries.length>=16,onClick:openAdd},'新增讨论条目'),
            h('button',{type:'button',style:toggleStyle,disabled:locked||!!editor||!board.canUndo,onClick:()=>void change({action:'undo'})},'撤销最近修改')),
          editor?h('form',{className:'dsh-persona-room-discussion-editor','aria-label':editor.action==='add'?'新增房间讨论':'更正房间讨论',onSubmit:submit},
            editor.action==='add'?h('label',null,'原话来源',h('select',{style:inputStyle,'aria-label':'讨论原话来源',value:key(editor.source),disabled:locked,onChange:event=>{
              const selected=choices.find(q=>key(q.ref)===event.target.value);if(selected)update({source:selected.ref,title:short(selected.text,80),status:selected.author.role==='assistant'?'proposal':'discussing',evidence:null});}},
              ...choices.map(q=>h('option',{key:key(q.ref),value:key(q.ref)},label(q))))):null,
            source?quote(source,'核对条目原话'):h('p',{style:hintStyle},'这句原话已不可用，请取消后重新选择。'),
            h('label',null,'整理标题',h('input',{style:inputStyle,'aria-label':'讨论条目标题',value:editor.title,maxLength:100,autoFocus:true,disabled:locked,onChange:event=>update({title:event.target.value})})),
            h('p',{style:hintStyle},'标题只用于整理，不改写原消息。'),
            h('label',null,'讨论状态',h('select',{style:inputStyle,'aria-label':'讨论条目状态',value:editor.status,disabled:locked,onChange:event=>{
              const status=event.target.value;update({status,evidence:['confirmed','deferred','rejected'].includes(status)?editor.evidence:null});}},
              ...Object.entries(discussionLabels).map(([value,text])=>h('option',{key:value,value},text)))),
            terminal?h(React.Fragment,null,h('label',null,'用户原话依据',h('select',{style:inputStyle,'aria-label':'讨论状态用户依据',value:key(editor.evidence),disabled:locked,onChange:event=>update({evidence:allChoices.find(q=>key(q.ref)===event.target.value)?.ref??null})},
              h('option',{value:''},'选择用户明确表达这项决定的原话…'),...allChoices.filter(q=>q.author.role==='user').map(q=>h('option',{key:key(q.ref),value:key(q.ref)},label(q))))),
              h('p',{style:hintStyle},'角色建议本身不是用户决定。请选同房间的用户原话；确认角色方案时，依据应来自方案之后。'),evidence?quote(evidence,'核对用户依据'):null):null,
            h('div',{className:'dsh-persona-room-discussion-toolbar'},h('button',{type:'submit',style:toggleStyle,disabled:locked||!source||!editor.title.trim()||(terminal&&!evidence)},saving?'正在保存…':'保存讨论条目'),
              h('button',{type:'button',style:toggleStyle,disabled:saving,onClick:()=>setEditor(null)},'取消编辑'))):null,
          ...board.entries.map(item=>h('article',{key:item.id,className:'dsh-persona-room-discussion-row','aria-label':'讨论条目 '+(item.title??'旧参考范围条目')},
            h('div',{className:'dsh-persona-room-discussion-heading'},h('strong',null,item.title??'旧参考范围的讨论条目'),h('span',{className:'dsh-persona-discussion-badge','data-state':item.status},discussionLabels[item.status]??'状态未知')),
            !item.available?h('p',{style:hintStyle},'原话依据已不可用，这项状态不会提供给角色。'):null,
            item.inScope?quote(item.source,'查看条目原话'):null,item.evidence&&item.inScope?quote(item.evidence,'查看状态依据'):null,
            h('div',{className:'dsh-persona-room-discussion-toolbar'},h('button',{type:'button',style:toggleStyle,disabled:locked||!!editor||!item.inScope||!item.source?.text,onClick:()=>edit(item)},'更正'),
              h('button',{type:'button',style:toggleStyle,disabled:locked||!!editor,onClick:()=>setRemoveId(item.id)},'移除')),
            removeId===item.id?h('div',{role:'group','aria-label':'确认移除讨论条目'},h('p',{style:hintStyle},'仅移除整理条目，保留原聊天。可撤销最近修改。'),
              h('div',{className:'dsh-persona-room-discussion-toolbar'},h('button',{type:'button',style:toggleStyle,disabled:locked,onClick:async()=>{if(await change({action:'remove',id:item.id,version:item.version}))setRemoveId(null);}},'确认移除'),
                h('button',{type:'button',style:toggleStyle,disabled:saving,onClick:()=>setRemoveId(null)},'保留条目'))):null)),
          h('p',{style:hintStyle},'保存、更正或撤销会停止本房间尚未完成的旧回复。其他房间不受影响；最多 16 项，最近 10 次修改可撤销。'))));
    }

    function RoomReferencesPanel({visible}){
      const [expanded,setExpanded]=React.useState(false),[data,setData]=React.useState(null),[busy,setBusy]=React.useState(false),[saving,setSaving]=React.useState(false);
      const [info,setInfo]=React.useState(''),[roomId,setRoomId]=React.useState(''),[recordId,setRecordId]=React.useState('');
      const current=React.useRef({token:0,room:'',record:'',abort:null,writing:0});
      const accept=value=>{setData(value);const room=value.room?.id??'';
        if(room!==current.current.room)current.current.record='';current.current.room=room;setRoomId(room);
        if(!value.records?.some(r=>r.id===current.current.record))current.current.record=value.records?.find(r=>r.sentAt!==null)?.id??value.records?.[0]?.id??'';
        setRecordId(current.current.record);};
      const load=async(target=current.current.room)=>{
        const own=current.current;if(own.writing)return;const token=++own.token;own.abort?.abort();const abort=new AbortController();own.abort=abort;
        setBusy(true);setInfo('');
        try{const response=await fetch(ROUTE+'/chat-references'+(target?'?room='+encodeURIComponent(target):''),{signal:abort.signal});
          const value=await response.json();if(!response.ok)throw Object.assign(Error(),{status:response.status});
          if(typeof value.initialized!=='boolean'||!Array.isArray(value.rooms)||!Array.isArray(value.records))throw Error();
          if(token===own.token&&!abort.signal.aborted)accept(value);
        }catch(error){if(token===own.token&&!abort.signal.aborted){if(error.status===404){own.room='';setRoomId('');setData(null);}
          setInfo(error.status===404?'这个房间已删除，请刷新房间列表。':'参考信息暂时无法读取，可以重试。');}}
        finally{if(token===own.token)setBusy(false);}
      };
      React.useEffect(()=>{
        if(visible&&expanded)void load();
        return()=>{current.current.token++;current.current.abort?.abort();current.current.writing=0;setBusy(false);setSaving(false);};
      },[visible,expanded]);
      const change=async(ref,excluded)=>{
        if(busy||saving||current.current.writing||!data?.room)return;const own=current.current,token=++own.token,abort=new AbortController();own.abort?.abort();own.abort=abort;own.writing=token;
        setSaving(true);setInfo('');
        try{const response=await fetch(ROUTE+'/chat-references',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
          body:JSON.stringify({roomId:data.room.id,referenceRevision:data.referenceRevision,epoch:data.epoch,ref,excluded})});
          const value=await response.json();if(!response.ok)throw Object.assign(Error(),{status:response.status});
          if(token===own.token&&!abort.signal.aborted){accept(value);setInfo(excluded?'已暂停自动旧话题引用；聊天原记录保留。':'已恢复自动旧话题引用。');}
        }catch(error){if(token===own.token&&!abort.signal.aborted)setInfo(error.status===409?'参考设置已变化，请刷新后再试。':'暂时无法确认修改结果，请刷新核对后重试。');}
        finally{if(own.writing===token)own.writing=0;if(token===own.token)setSaving(false);}
      };
      const retract=async ref=>{
        if(current.current.writing)return;
        const own=current.current,token=++own.token; own.writing=token;setSaving(true);
        const write=async body=>{const response=await fetch(ROUTE+'/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
          if(!response.ok)throw Error();return (await response.json()).result;};
        try{const op=await write({action:'propose',operation:'retract',id:ref.id,version:ref.version,statement:'在本轮参考中撤销这条记忆'});
          await write({action:'confirm',id:op.id,version:op.version});}
        catch{if(token===own.token)setInfo('未能确认撤销，请刷新后核对。');return;}
        finally{if(own.writing===token){own.writing=0;setSaving(false);}}
        if(token===own.token)await load();
      };
      const changeDiscussion=async(body)=>{
        if(busy||saving||current.current.writing||!data?.room)return false;const own=current.current,token=++own.token,abort=new AbortController();own.abort?.abort();own.abort=abort;own.writing=token;
        setSaving(true);setInfo('');
        try{const response=await fetch(ROUTE+'/chat-discussion',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
          body:JSON.stringify({...body,roomId:data.room.id,epoch:data.epoch,discussionRevision:data.discussion?.revision??0})});
          const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{status:response.status});
          if(token===own.token&&!abort.signal.aborted){accept(value);setInfo(body.action==='undo'?'已撤销最近一次讨论状态修改。':'房间讨论已保存，原聊天与长期记忆保持各自范围。');return true;}
        }catch(error){if(token===own.token&&!abort.signal.aborted)setInfo(error.status===409?'房间讨论已变化，请刷新核对后再保存。编辑草稿仍保留。'
          :error.message==='chat-discussion-evidence-required'?'请选能够支持这项状态的用户原话；角色方案需要之后的用户确认。编辑仍保留。'
          :error.message==='chat-quote-unavailable'?'原话依据已经改变，请刷新核对或取消后重新选择。编辑仍保留。'
          :error.message==='chat-discussion-capacity'?'房间讨论已满，请先整理或移除不再需要的条目。'
          :error.message==='chat-discussion-duplicate'?'这句原话已经整理过，请更正已有条目。'
          :'暂时无法确认保存结果，请刷新核对后重试。编辑草稿仍保留。');}
        finally{if(own.writing===token)own.writing=0;if(token===own.token)setSaving(false);}return false;
      };
      const record=data?.records?.find(r=>r.id===recordId),sent=record?.sentAt!==null&&record?.sentAt!==undefined;
      const selection=record?.coordination&&typeof record.coordination==='object'?record.coordination:null;
      const workChoice={required:'按需参考工作', 'not-needed':'这轮不带工作参考',unclear:'暂不判断为工作请求'};
      const requestChoice={answer:'回应问题',advice:'讨论建议',listen:'以倾听为主',open:'开放交流',unclear:'表达需求尚不明确'};
      const selectionBasis={model:'本轮轻量判断',omitted:'本轮未提供新的资料选择','no-sources':'没有接入工作会话',invalid:'判断返回未通过校验',timeout:'判断超时',unavailable:'判断暂不可用',explicit:'本轮明确指定'};
      const selectedSources=(Array.isArray(selection?.selectedSourceIds)?selection.selectedSourceIds:[]).filter((id,index,all)=>typeof id==='string'&&all.indexOf(id)===index).slice(0,6);
      const sourceLabel=id=>record.work?.find(source=>source.sessionId===id)?.name
        ||data.currentSources?.find(source=>source.sessionId===id)?.name||'来源未提供';
      const time=value=>Number.isFinite(value)?new Date(value).toLocaleString():'未记录';
      const phase=r=>r.request?.responseKind==='normal'?(r.request.replyTo==='user'?'回应用户':'回应同伴'):r.request?.responseKind==='peer'?'回应同伴'
        :r.request?.phase==='reaction'?'旁听接话':r.request?.phase==='followup'?'再次回应':r.request?.available?'主讲 '+r.request.order:'回应';
      const brief=text=>Array.from(text.replace(/\s+/g,' ').trim()).slice(0,38).join('');
      const status={pending:'进行中',generated:'回复已完成',silent:'未发言',failed:'请求失败',rejected:'结果未采用',cancelled:'已停止',interrupted:'结束状态未知'};
      const excerpt=(item,action=false)=>h('div',{className:'dsh-persona-room-reference-item',key:JSON.stringify(item.ref)},
        h('div',null,h('strong',null,item.author?.role==='user'?'我':item.author?.name??'原消息'),
          item.available?h('details',null,h('summary',null,'查看出处'),h('blockquote',null,item.text))
            :h('p',null,'原消息已更改、已清空或不属于当前来源，不显示旧内容。')),
        action?h('button',{type:'button',style:toggleStyle,disabled:busy||saving||(!item.available&&!item.excluded),
          onClick:()=>void change(item.ref,!item.excluded)},item.excluded?'恢复引用':'暂停引用'):null);
      const content=h('section',{'aria-label':'房间参考信息',className:'dsh-persona-room-references'},
        h('style',null,`.dsh-persona-room-references{min-width:0}.dsh-persona-room-reference-toolbar{display:flex;align-items:end;flex-wrap:wrap;gap:10px;margin-bottom:12px}.dsh-persona-room-reference-toolbar label{flex:1;min-width:min(170px,100%)}.dsh-persona-room-reference-toolbar label span{display:block;font-size:12px;margin-bottom:4px}.dsh-persona-room-reference-toolbar select{width:100%}.dsh-persona-room-reference-status{font-size:12px;color:var(--dsw-alias-label-secondary,#65758a);line-height:1.7}.dsh-persona-room-reference-grid{display:grid;gap:10px;margin:12px 0}.dsh-persona-room-reference-card{min-width:0;border:1px solid var(--dsw-alias-border-l1,#d6dfe9);border-radius:10px;padding:12px}.dsh-persona-room-reference-card h4{font-size:13px;margin:0 0 6px}.dsh-persona-room-reference-card p{font-size:12px;line-height:1.65;margin:6px 0;overflow-wrap:anywhere}.dsh-persona-room-reference-item{display:flex;align-items:start;justify-content:space-between;gap:10px;margin-top:10px}.dsh-persona-room-reference-item>div{min-width:0;flex:1}.dsh-persona-room-reference-item strong{font-size:12px}.dsh-persona-room-reference-item button{flex:none;font-size:11px}.dsh-persona-room-references details summary{font-size:12px;cursor:pointer}.dsh-persona-room-references blockquote{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;padding:8px 10px;border-inline-start:2px solid var(--dsw-alias-border-l1,#d6dfe9);max-height:210px;overflow:auto}.dsh-persona-room-reference-counts{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.dsh-persona-room-reference-counts span{font-size:11px;border-radius:6px;padding:3px 7px;background:var(--dsw-alias-bg-layer-2,#f3f5f8)}@media(max-width:420px){.dsh-persona-room-reference-item{flex-wrap:wrap}.dsh-persona-room-reference-item button{margin-inline-start:auto}}`),
        h('p',{style:hintStyle},'只核对已经记录的参考，不启动聊天、刷新工作会话或调用模型。'),
        h('div',{className:'dsh-persona-room-reference-toolbar'},
          data?.rooms?.length?h('label',null,h('span',null,'查看房间'),h('select',{style:inputStyle,'aria-label':'查看房间参考',value:roomId,disabled:saving,
            onChange:e=>{const id=e.target.value;current.current.room=id;current.current.record='';setRoomId(id);setRecordId('');setData(old=>({...old,room:null,records:[],excluded:[]}));void load(id);}},
            ...data.rooms.map(room=>h('option',{key:room.id,value:room.id},room.name)))):null,
          h('button',{type:'button',style:toggleStyle,disabled:busy||saving,onClick:()=>void load()},busy?'正在读取…':'刷新参考信息')),
        h('p',{className:'dsh-persona-room-reference-status',role:'status','aria-live':'polite'},info||(!data&&busy?'正在读取房间参考…':'')),
        data?.initialized===false?h('p',{style:hintStyle},'本次运行尚未打开聊天室。打开后，这里会显示房间和实际使用记录。'):null,
        data?.initialized&&!data.room&&!busy?h('p',{style:hintStyle},'还没有聊天室，可以先从工作页打开一间。'):null,
        data?.room?h(React.Fragment,null,
          h('p',{className:'dsh-persona-room-reference-status'},'当前接入：'+(data.currentSources?.length?data.currentSources.map(s=>s.name+(s.primary?'（主要）':'')).join('、'):'未接入工作会话')+'。这里只显示已保存的选择。'),
          h(RoomDiscussionPanel,{key:data.room.id,data,busy,saving,change:changeDiscussion}),
          data.records?.length?h('label',{style:fieldStyle},h('span',{style:labelStyle},'查看哪次回复'),
            h('select',{style:inputStyle,'aria-label':'选择房间参考记录',value:recordId,disabled:saving,onChange:e=>{current.current.record=e.target.value;setRecordId(e.target.value);}},
              ...data.records.map(r=>h('option',{key:r.id,value:r.id},r.personaName+' · '+phase(r)+' · '+time(r.at)
                +(r.sentAt===null?' · 尚未发出':'')+(r.request?.available?' · '+brief(r.request.text):'')))))
            :h('p',{style:hintStyle},'这个房间还没有参考使用记录。发送聊天后会在这里记录。'),
          record?h(React.Fragment,null,h('p',{className:'dsh-persona-room-reference-status'},
            (sent?'已提供给模型':'准备选入，尚未提供')+' · '+(status[record.outcome]??'状态未知')+' · '+time(record.sentAt??record.at)),
            !record.inScope?h('p',{style:warningStyle},'这次记录属于之前的参考范围。保留用量信息，旧正文与偏好不在这里展开。'):null,
            h('section',{className:'dsh-persona-room-reference-card','aria-label':'本次回复归属'},h('h4',null,'这次回应了什么'),
              record.request?.available?h(React.Fragment,null,
                h('p',null,record.personaName+' · '+phase(record)),
                record.assignment?.kind?h('p',{className:'dsh-persona-room-reference-status'},'本轮职责：'+(assignmentLabels[record.assignment.kind]??'按本次消息回应')):null,
                h('p',{className:'dsh-persona-room-reference-status'},record.request.recipients.length?'当时点名：'+record.request.recipients.map(p=>'@'+p.name).join(' '):'当时发给整个房间'),
                h('p',{className:'dsh-persona-room-reference-question',style:{display:'-webkit-box',WebkitLineClamp:2,WebkitBoxOrient:'vertical',overflow:'hidden',whiteSpace:'pre-wrap'}},record.request.text),
                record.request.text.length>120||record.request.text.includes('\n')?h('details',null,h('summary',null,'展开本轮用户原话'),h('blockquote',null,record.request.text)):null)
                :h('p',null,'原轮次已被替换、超出保留范围或来源已变，不用其他消息代替当时的提问。')),
            h('section',{className:'dsh-persona-room-reference-card','aria-label':'本次参考选择',style:{marginTop:10}},h('h4',null,'本轮参考选择'),
              selection?h(React.Fragment,null,
                h('div',{className:'dsh-persona-room-reference-counts'},h('span',null,workChoice[selection.work]??'工作参考选择未记录'),
                  h('span',null,requestChoice[selection.request]??'表达需求未记录')),
                h('p',null,selectedSources.length?'选择的来源：'+selectedSources.map(sourceLabel).join('、')+'。':'这轮没有选择工作来源。'),
                h('details',null,h('summary',null,'查看选择依据'),h('p',null,selectionBasis[selection.basis]??'依据方式未记录'),
                  h('p',null,'参考选择只作用于这条消息，不修改 @ 对象、房间来源或长期偏好；不是对用户意图的确认。'),
                  ['invalid','timeout','unavailable'].includes(selection.basis)?h('p',null,'判断未完成时不扩大工作参考范围，不把已接入会话的正文全部带入。'):null))
                :h('p',null,'这条记录没有保存本轮参考选择，不从现有来源倒推当时的判断。')),
            h('div',{className:'dsh-persona-room-reference-counts','aria-label':'本次参考概览'},
              ...[['工作来源',record.work.length],['旧话题',record.notes.length],...(record.discussion?.length?[['讨论状态',record.discussion.length]]:[]),...(record.quote?[['主动引用',1]]:[]),['偏好',record.memory.length],['近期对话',record.historyCount]].map(([label,count])=>h('span',{key:label},label+' '+count))),
            record.discussion?.length?h('details',null,h('summary',null,'本次采用的房间状态 · '+record.discussion.length),
              ...record.discussion.map(item=>h('p',{key:item.id,style:hintStyle},item.available?(item.title+' · '+(discussionLabels[item.status]??'已核对状态')):'这项状态版本已更改或原话不再适用，不恢复旧内容。'))):null,
            h('div',{className:'dsh-persona-room-reference-grid'},
              h('section',{className:'dsh-persona-room-reference-card','aria-label':'本次工作来源'},h('h4',null,'工作来源'),
                !record.work.length?h('p',null,'这次没有提供工作会话正文。'):null,
                ...record.work.map(s=>h('div',{key:s.sessionId},h('strong',null,s.name||'工作会话'),
                  h('p',null,'读取于 '+time(s.readAt)+' · '+(s.reportStatus==='final'?'本轮结束的原始汇报':s.reportStatus==='progress'?'过程汇报':'尚无汇报')),
                  h('details',null,h('summary',null,'查看来源依据'),h('p',null,'第 '+(s.turn??'—')+' 轮 · 目标事件 '+(s.goalSeq??'—')+' · 汇报事件 '+(s.reportSeq??'—')),
                    s.goalHasAttachments?h('p',null,'目标包含附件，只提供存在性，不读取附件内容。'):null,
                    s.goalOmitted?h('p',null,'目标正文超过预算，本次未提供完整目标。'):null,
                    s.reportOmitted?h('p',null,s.reportExcerpt?.includedChars>0?'本次只提供报告的完整原文片段，省略部分仍未知，不代表已检查全文。':'报告正文超过预算，本次未提供正文。'):null,
                    s.previousReportOmitted?h('p',null,s.previousReport?.excerpt?.includedChars>0?'上轮参考只提供了部分原文，未提供部分仍未知。':'上轮参考正文超过预算，本次未提供正文。'):null,
                    s.previousReport?h('p',null,'另含上轮参考 · 第 '+(s.previousReport.turn??'—')+' 轮 · 事件 '+(s.previousReport.seq??'—')+'，不代表本轮结果。'):null,
                    s.available?h(React.Fragment,null,s.goal?h('div',null,h('strong',null,'本轮目标'),h('blockquote',null,s.goal)):null,
                      s.report?h('div',null,h('strong',null,s.reportStatus==='final'?'本轮原始汇报':'本轮过程汇报'),h('blockquote',null,s.report)):null,
                      s.previousReport?.text?h('div',null,h('strong',null,'上轮参考 · 不代表本轮结果'),h('blockquote',null,s.previousReport.text)):null)
                      :h('p',null,'原始缓存已更新或尚未载入，仅保留当时的来源与轮次，不用新正文冒充旧参考。')))),
                ...record.omitted.map((s,i)=>h('p',{key:i},(s.name||'工作来源')+' · 本次未提供：'+({budget:'超过内容预算','update-pending':'等待更新','read-failed':'读取未完成',unavailable:'暂不可用'}[s.reason]??'暂不可用')))),
              h('section',{className:'dsh-persona-room-reference-card','aria-label':'本次旧话题原话'},h('h4',null,'旧话题原话'),
                h('p',null,'只说明当时说过什么，不代表问题仍未解决或建议已经采纳。'),
                record.notes.length?h('p',null,'暂停仅影响额外选入的旧话题，并停止本房间未完成的旧请求；不删除最近对话，也不阻止主动引用。'):null,
                ...record.notes.map(n=>excerpt(n,record.inScope)),
                !record.notes.length?h('p',null,'这次没有额外选入较早的聊天片段。'):null,
                record.quote?h('div',null,h('strong',null,'用户本次明确引用'),excerpt(record.quote)):null),
              h('section',{className:'dsh-persona-room-reference-card','aria-label':'本次人格偏好'},h('h4',null,'人格偏好 · '+record.personaName),
                h('p',null,'只用于这位人格的这次回应；其他成员不会因此取得她的私有偏好。'),
                ...[false,true].map(personal=>{const refs=record.memory.filter(ref=>!!ref.personal===personal);return refs.length?h('div',{key:String(personal)},
                  h('strong',null,personal?'本人经历与房间约定':'表达偏好与约定'),...refs.map(ref=>h('div',{key:ref.id},ref.available?h(React.Fragment,null,
                    h('p',null,ref.content+' · '+({persona:record.personaName,session:data.room.name,shared:'所有人格'}[ref.scope]??'')),
                    ...(ref.evidence??[]).map((quote,i)=>h('blockquote',{key:i},quote)),h('button',{type:'button',disabled:saving,onClick:()=>void retract(ref)},'撤销')):
                    (ref.status??'该版本已更改、撤销或不再适用，不显示旧内容。')))):null;}),
                !record.memory.length?h('p',null,record.memoryEnabled?'这次没有选入表达偏好。':'发起这次请求时，记忆功能未开启。'):null))) :null,
          data.excluded?.length?h('details',null,h('summary',null,'已暂停的旧话题 · '+data.excluded.length),
            h('p',{style:hintStyle},'仅停止自动选入旧话题，不删除聊天，也不阻止你主动引用。修改会停止本房间尚未完成的旧请求。'),
            ...data.excluded.map(n=>excerpt(n,true))):null,
          data.persistence==='failed'?h('p',{style:hintStyle},'使用记录暂未保存成功，重启后可能缺少最近记录。'):null):null);
      return settingsFold('room-references','房间参考','整理房间讨论，核对来源、旧话题和偏好',content,
        {onToggle:event=>{if(event.target===event.currentTarget)setExpanded(event.currentTarget.open);}});
    }

    function MemoryUsagePanel({ data, presets, settings, filter, refresh, busy, scopePending }) {
      const [channel, setChannel] = React.useState('all');
      const [refreshing, setRefreshing] = React.useState(false);
      const [refreshInfo, setRefreshInfo] = React.useState('');
      const refreshState = React.useRef({ busy: false, personaId: undefined });
      refreshState.current.personaId = data?.activePersonaId;
      React.useEffect(() => { setRefreshInfo(''); }, [data?.activePersonaId]);
      const reload = async () => {
        if (refreshState.current.busy || busy || scopePending) return;
        const personaId = data?.activePersonaId;
        refreshState.current.busy = true; setRefreshing(true); setRefreshInfo('');
        try {
          const ok = await refresh();
          if (refreshState.current.personaId === personaId) setRefreshInfo(ok ? '已刷新' : '暂未更新，已有记录仍保留，请稍后重试。');
        } catch { if (refreshState.current.personaId === personaId) setRefreshInfo('暂未更新，已有记录仍保留，请稍后重试。'); }
        finally { refreshState.current.busy = false; setRefreshing(false); }
      };
      const channels = { report: '汇报转述', process: '过程转述与补充', retry: '单次重说', progress: '静默播报', chat: '角色聊天' };
      const outcomes = { pending: '请求进行中', generated: '转述已生成', rejected: '生成内容未采用',
        silent:'未发言',failed: '生成未完成', cancelled: '请求已取消', interrupted: '重启前结束状态未知' };
      const reasons = { candidate: '等待确认', superseded: '已被替代', rejected: '已忽略', retracted: '已撤销',
        expired: '已过期', 'not-expression': '共同经历或会话情况，不用于表达转述', overridden: '已有优先级更高的同类偏好',
        budget: '超出本次内容预算', limit: '超出本次条数上限', irrelevant:'与当前话题无关' };
      const name = (id) => presets.find((p) => p.id === id)?.name ?? '已移除的人格';
      const allRecords = scopePending || data?.usage?.version !== 1 ? [] : (data.usage.records ?? []);
      const records = allRecords.filter((record) =>
        (filter!=='current'&&filter!=='all' ? record.sessionId===filter : filter === 'all' || record.personaId === data.activePersonaId)
        && (channel === 'all' || channel === record.channel)).slice().reverse();
      const sent = (record) => Number.isFinite(record.sentAt);
      const resolve = (ref, record, selected) => {
        const entry = (data.entries ?? []).find((e) => e.id === ref.id && e.version === ref.version);
        const allowed = entry && (entry.scope === 'shared' || (entry.scope === 'persona' && entry.personaId === record.personaId)
          || (entry.scope === 'session' && entry.sessionId === record.sessionId && (!entry.personaId || entry.personaId === record.personaId)));
        if (!allowed || (selected && (entry.status !== 'active' || (entry.expiresAt !== null && entry.expiresAt <= Date.now())))) return undefined;
        return entry.content;
      };
      const list = records.map((record) => {
        const provided = sent(record); const total = record.selected.length + record.omitted.length;
        const selectionLabel = (provided ? '已提供 ' : '准备选入 ') + record.selected.length + ' 条';
        const refList = (refs, selected) => refs.length ? h('ul', null, ...refs.map((ref) => h('li', { key: ref.id },
          resolve(ref, record, selected) ?? '原版本已更改、删除或不再适用，无法展示当时内容。',
          h('span', { className: 'dsh-persona-usage-reason' }, selected ? ({tag:'标签命中', relevant:'话题相关', expression:'表达偏好或约定', pinned:'话题相关 · 已置顶', recent:'最近'}[ref.basis] ?? '') : reasons[ref.reason] ?? '本次未选中'))))
          : h('p', { style: hintStyle }, selected ? '本次没有选入表达偏好。' : '没有其他同范围记忆被排除。');
        return h('details', { key: record.id, className: 'dsh-persona-usage-record', 'data-memory-usage': record.id },
          h('summary', null, h('span', null, channels[record.channel]), h('span', { style: hintStyle }, name(record.personaId)),
            h('span', { style: hintStyle }, new Date(record.at).toLocaleString()), h('span', { style: { whiteSpace: 'nowrap' } }, selectionLabel)),
          h('div', { className: 'dsh-persona-usage-record-body' },
            h('p', { style: hintStyle }, (record.sessionId === data.sessionId ? '当前会话' : '其他会话') + ' · '
              + (provided ? '已提供给模型请求' : '尚未提供给模型请求') + ' · ' + (outcomes[record.outcome] ?? '状态未知')),
            total ? h('div', { className: 'dsh-persona-usage-bar', 'data-sent': String(provided), role: 'img',
              'aria-label': selectionLabel + '，未选中 ' + record.omitted.length + ' 条' },
              h('span', { style: { width: (record.selected.length / total * 100) + '%' } })) : null,
            h('strong', null, provided ? '已提供的偏好' : '准备选入的偏好（尚未提供）'), refList(record.selected, true),
            record.omitted.length ? h('details', null, h('summary', { style: hintStyle }, '为什么其他 ' + record.omitted.length + ' 条没有选中'),
              refList(record.omitted, false)) : null));
      });
      const content = h('section', { 'aria-label': '记忆使用情况', 'data-persona-shell': 'memory-usage' },
        h('p', { style: hintStyle }, '这里只记录偏好是否提供给模型，不代表模型一定遵守。只保留最近 24 次请求，不保存原话或汇报副本。'),
        h('div', { className: 'dsh-persona-memory-actions' },
          h('select', { style: inputStyle, value: channel, 'aria-label': '筛选使用渠道', onChange: (e) => setChannel(e.target.value) },
            h('option', { value: 'all' }, '所有发言渠道'), ...Object.entries(channels).map(([id, label]) => h('option', { key: id, value: id }, label))),
          h('button', { type: 'button', style: toggleStyle, disabled: busy || scopePending || refreshing, onClick: reload }, refreshing ? '正在刷新…' : '刷新使用情况'),
          h('span', { style: hintStyle, role: 'status', 'aria-live': 'polite' }, refreshInfo)),
        h('div', { className: 'dsh-persona-usage-stats' }, ...[
          ['已记录请求', records.length], ['提供了偏好', records.filter((r) => sent(r) && r.selected.length > 0).length],
          ['未发出请求', records.filter((r) => !sent(r)).length],
        ].map(([label, value]) => h('div', { key: label, className: 'dsh-persona-usage-stat' }, h('strong', null, value), label))),
        settings.memory === false ? h('p', { style: hintStyle }, '记忆已关闭，暂停记录新的使用情况；已有记录保留。') : null,
        data?.usage?.persistence === 'failed' ? h('p', { style: hintStyle }, '最近记录暂未保存成功，重启后可能丢失；不影响正常转述。') : null,
        h('div', { className: 'dsh-persona-usage-list' }, ...list),
        records.length === 0 ? h('p', { style: hintStyle }, scopePending ? '正在读取使用情况…'
          : '这个筛选下还没有记录。开启记忆后发起人格转述，即可在这里查看。') : null,
        filter !== 'all' && records.length === 0 && allRecords.some((record) => record.personaId !== data?.activePersonaId
          && (channel === 'all' || record.channel === channel))
          ? h('p', { style: hintStyle }, '其他人格还有记录，可在上方选择「全部人格」查看。') : null,
        h('p', { style: hintStyle }, '跟随上方人格筛选。展开面板时刷新，也可以手动刷新；不会在聊天中显示。'));
      return settingsFold('memory-usage', '最近使用情况', '看看偏好有没有提供，以及未选中的原因', content,
        { badge: records.length ? records.length + ' 次' : undefined,
          onToggle: (event) => { if (event.target === event.currentTarget && event.currentTarget.open) void reload(); } });
    }

// SECTION entries
    const memoryAddDrafts = new Map();
    const memoryEditDrafts = new Map();
    function CapacityTools({data,write,busy}) {
      if(!data?.capacity)return null;
      const capacity=data.capacity;
      return h('div',null,h('p',null,'表达偏好与约定 '+data.entries.filter(e=>e.status!=='candidate'&&['preference','agreement'].includes(e.kind)).length+
        '　会话情况 '+data.entries.filter(e=>e.status!=='candidate'&&e.kind==='context').length+'　经历 '+data.entries.filter(e=>e.status!=='candidate'&&e.kind==='episode').length+
        '　待核对 '+data.entries.filter(e=>e.status==='candidate').length),
        h('button',{type:'button',disabled:busy||!capacity.cleanable,onClick:()=>write({action:'cleanup',revision:data.revision})},'清理到期或过期历史 '+capacity.cleanable+' 条'),
        ...capacity.similar.map(group=>{const records=group.map(ref=>data.entries.find(e=>e.id===ref.id));return h('form',{key:JSON.stringify(group),onSubmit:event=>{
          event.preventDefault();const fields=event.currentTarget.elements;void write({action:'merge',refs:group,keep:fields.keep.value,content:fields.content.value.trim()||records.find(e=>e.id===fields.keep.value).content});}},
          h('label',null,'相近条目 · 选择保留项',h('select',{name:'keep'},...records.map(e=>h('option',{key:e.id,value:e.id},e.content)))),h('input',{name:'content',maxLength:240,placeholder:'可选：合并后的内容'}),h('button',{disabled:busy},'确认合并'));}),
        capacity.used>=capacity.limit?h('p',null,'合并后的旧条目保留为历史。需要立即腾出空间时，可在记忆设置的历史列表中删除已核对的条目。'):null);
    }
    function MemoryPanel({ settings, save, presets, importRevision }) {
      const [data, setData] = React.useState(undefined);
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const revision = React.useRef(0);
      const currentPreset = React.useRef(settings.presetName);
      currentPreset.current = settings.presetName;
      const expectedPersona = presets.find((p) => p.name === settings.presetName)?.id;
      const draftKey = expectedPersona ?? settings.presetName;
      const [manual, setManual] = React.useState(() => memoryAddDrafts.get(draftKey)
        ?? { content: '', kind: 'preference', scope: 'persona' });
      const editManual = (patch) => {
        const next = { ...manual, ...patch }; setManual(next); keepDraft(memoryAddDrafts, draftKey, next);
      };
      const scopePending = !data || (data.activePresetName !== undefined
        ? data.activePresetName !== settings.presetName : expectedPersona && expectedPersona !== data.activePersonaId);
      const [filter, setFilter] = React.useState('current');
      const [view, setView] = React.useState('active');
      const [query,setQuery]=React.useState(''),[kindFilter,setKindFilter]=React.useState('');
      const [rooms,setRooms]=React.useState([]);
      const roomRead=React.useRef(null);
      const loadRooms=async()=>{
        if(roomRead.current)return;
        const abort=new AbortController();roomRead.current=abort;
        try{const response=await fetch(ROUTE+'/chat',{signal:abort.signal});if(response.ok){const value=await response.json();if(!abort.signal.aborted&&Array.isArray(value.rooms))setRooms(value.rooms);}}
        catch{/* Focusing the room selector can retry a failed read. */}
        finally{if(roomRead.current===abort)roomRead.current=null;}
      };
      React.useEffect(()=>{
        if(manual.scope==='room')void loadRooms();
        return()=>{roomRead.current?.abort();roomRead.current=null;};
      },[draftKey,manual.scope]);
      const memoryList = React.useRef(null);
      const focusOperation = React.useRef(undefined);
      const [editing, setEditing] = React.useState(undefined);
      const [editDraft, setEditDraft] = React.useState({ content: '', statement: '' });
      const [clearConfirm, setClearConfirm] = React.useState(false);
      React.useEffect(() => {
        const list = memoryList.current;
        if (!list) return;
        const review = [...list.querySelectorAll('[data-memory-operation]')].find((el) => el.dataset.memoryOperation === focusOperation.current);
        if (review) {
          list.scrollTop = review.offsetTop;
          review.focus({ preventScroll: true });
          review.querySelector('.dsh-persona-memory-review-heading')?.scrollIntoView({ block: 'nearest' });
          focusOperation.current = undefined;
        }
      }, [data, view]);
      const labels = { preference: '表达偏好', agreement: '互动约定', context: '会话情况', episode: '共同经历',
        active: '使用中', candidate: '待核对', superseded: '已替代', rejected: '已忽略', retracted: '已撤销',
        chat:'聊天室原话',manual: '手动记录', explicit: '用户明确表达', model: '后台整理', legacy: '旧版迁移', correction: '已确认更正' };
      const personaName = (id) => presets.find((p) => p.id === id)?.name ?? '已移除的人格';
      const scopeLabel = (entry) => entry.scope === 'shared' ? '所有人格共享'
        : entry.scope === 'persona' ? '仅 ' + personaName(entry.personaId)
        : (entry.sessionId?.startsWith('room:')||/^chat:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(entry.sessionId)?'房间 · '+(rooms.find(r=>r.id===entry.sessionId)?.name??data?.roomNames?.[entry.sessionId]??'已移除房间')
          : '会话 · '+(data?.sessionTitles?.[entry.sessionId]??(entry.sessionId===data?.sessionId?'当前会话':String(entry.sessionId).slice(0, 32))))
          + (entry.personaId ? ' · 仅 ' + personaName(entry.personaId) : ' · 角色共享');
      const errorText = (code) => ({
        'memory-conflict': '记录已变化，尚未应用这次操作。请刷新后重新核对；草稿会保留。',
        'storage-not-ready': '存储尚未就绪，请稍后重试。',
        'memory-save-failed': '保存失败，内容仍保留，请稍后重试。',
        'memory-capacity': '记忆已满（200 条）。展开「记忆占用」可清理过期记录或核对相近条目。',
        'memory-operation-capacity': '待确认项目已满，请先处理不再需要的项目。',
        'memory-target-inactive': '这条记录已失效，请刷新后核对当前记录。',
        'memory-statement-required': '请留下你这次更正或撤销的原话。',
        'invalid-memory-tags': '最多 6 个标签，每个最多 32 字。',
        'invalid-memory-replacement': '请填写与旧记录不同的新内容。',
        'private-memory-needs-scope': '互动约定和共同经历请保留在对应人格或会话中。',
        'memory-extraction-disabled': '请先开启记忆与后台整理。',
      }[code] ?? '操作未完成，输入仍保留，请刷新后重试。');
      const refresh = async () => {
        if (busyRef.current) return false;
        const token = ++revision.current;
        try {
          const response = await fetch(ROUTE + '/memory');
          if (!response.ok) throw new Error('load');
          const value = await response.json();
          if (revision.current === token) {
            setData(value);
            setNotice((previous) => previous.startsWith('暂时无法读取记忆') ? '' : previous);
            return true;
          }
          return false;
        } catch {
          if (revision.current === token) setNotice('暂时无法读取记忆，请稍后刷新。');
          return false;
        }
      };
      React.useEffect(() => {
        setManual(memoryAddDrafts.get(draftKey) ?? { content: '', kind: 'preference', scope: 'persona' });
        setEditing(undefined); setClearConfirm(false); setNotice('');
      }, [draftKey]);
      React.useEffect(() => {
        // A persona change retires the old response, even if it is still saving.
        revision.current += 1;
        void (async () => {
          const token = revision.current;
          try {
            const response = await fetch(ROUTE + '/memory');
            if (!response.ok) throw new Error('load');
            const value = await response.json();
            if (revision.current === token) setData(value);
          } catch { if (revision.current === token) setNotice('暂时无法读取记忆，请稍后刷新。'); }
        })();
        return () => { revision.current += 1; };
      }, [settings.memory, settings.memoryExtraction, settings.presetName, importRevision]);
      const write = async (body) => {
        if (busyRef.current || scopePending || currentPreset.current !== settings.presetName) return false;
        busyRef.current = true; setBusy(true);
        const token = ++revision.current;
        setNotice('正在保存…');
        try {
          const response = await fetch(ROUTE + '/memory', { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error);
          if (revision.current !== token) return false;
          if (['propose', 'propose-add'].includes(body.action)) focusOperation.current = value.result?.id;
          setData(value); setNotice(body.action === 'consolidate' ? '已安排整理，稍后可刷新查看。'
            : ['propose', 'propose-add'].includes(body.action) ? '已生成核对单，确认前不会改变正在使用的记忆。'
            : body.action === 'confirm' ? '已确认，后续转述会使用新状态；历史汇报保持原样。'
            : body.action === 'dismiss' ? '已放弃这次操作，原记录保持原样。' : '已保存');
          return true;
        } catch (error) {
          if (revision.current === token) setNotice(errorText(error.message));
          return false;
        } finally { busyRef.current = false; setBusy(false); }
      };
      const scoped = (entry) => filter!=='current'&&filter!=='all' ? entry.sessionId===filter : filter === 'all' || entry.scope === 'shared'
        || (entry.scope === 'persona' && entry.personaId === data?.activePersonaId)
        || (entry.scope === 'session' && entry.sessionId === data?.sessionId
          && (!entry.personaId || entry.personaId === data?.activePersonaId));
      const live = (entry) => entry.status === 'active' && (entry.expiresAt === null || entry.expiresAt > Date.now());
      const matches=e=>(!kindFilter||kindFilter===e.kind)&&(!query||[e.content,...(e.tags??[])].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
      const all = scopePending ? [] : (data?.entries ?? []).filter(e=>scoped(e)&&matches(e));
      const pending = scopePending ? [] : (data?.operations ?? []).filter((op) => op.status === 'pending' && scoped(op.target) && matches(op.target));
      const adoptionIds = new Set(pending.filter((op) => op.kind === 'accept').map((op) => op.targetId));
      const candidates = all.filter((entry) => entry.status === 'candidate' && !adoptionIds.has(entry.id));
      const entries = all.filter((entry) => view === 'history' ? !live(entry) && entry.status !== 'candidate'
        : view === 'pending' ? entry.status === 'candidate' && !adoptionIds.has(entry.id) : live(entry));
      const evidenceView = (evidence, missing = '没有保存完整原话，请根据实际情况核对。') => evidence?.length
        ? h('div', { className: 'dsh-persona-memory-evidence' }, ...evidence.map((ref, i) => h('div', { key: i },
          h('span', { style: hintStyle }, ref.source === 'settings' ? '你在设置页的说明'
            : ref.complete ? '用户原话 · 当前保存的完整片段' : '历史片段 · 完整原话未保存'),
          ref.quote.length > 320 ? h('details', null,
            h('summary', { style: hintStyle }, (ref.source === 'settings' ? '展开完整说明'
              : ref.complete ? '展开完整原话' : '展开已保存片段') + '（' + ref.quote.length + ' 字符）'),
            h('blockquote', null, ref.quote)) : h('blockquote', null, ref.quote)))) : h('p', { style: hintStyle }, missing);
      const beginEdit = (entry, operation) => {
        const key = entry.id + ':' + operation;
        setEditing({ ...entry, operation });
        setEditDraft(memoryEditDrafts.get(key) ?? { content: operation === 'revise' ? entry.content : '', statement: '' });
      };
      const changeEdit = (patch) => {
        const next = { ...editDraft, ...patch }; setEditDraft(next);
        keepDraft(memoryEditDrafts, editing.id + ':' + editing.operation, next);
      };
      const pendingRows = pending.map((op) => {
        const target = data.entries.find((e) => e.id === op.targetId);
        const currentConflicts = target && op.kind === 'accept' ? data.entries.filter((e) => e.id !== target.id && live(e)
          && e.kind === target.kind && e.key === target.key && e.scope === target.scope
          && e.personaId === target.personaId && e.sessionId === target.sessionId && (e.origin==='chat')===(target.origin==='chat')).map((e) => ({ id: e.id, version: e.version })) : [];
        const stale = !target || target.version !== op.targetVersion
          || (target.expiresAt !== null && target.expiresAt <= Date.now())
          || (op.kind === 'accept' && JSON.stringify(currentConflicts) !== JSON.stringify(op.conflicts));
        const name = { revise: '更正', retract: '撤销', accept: '采用' }[op.kind];
        return h('section', { key: op.id, className: 'dsh-persona-memory-review', 'data-memory-operation': op.id, tabIndex: -1,
          'aria-label': '待确认' + name },
        h('div', { className: 'dsh-persona-memory-review-heading' }, h('strong', null, '核对' + name),
          h('span', { style: hintStyle }, scopeLabel(op.target))),
        h('p', { style: hintStyle }, op.origin === 'model' ? '后台整理建议，尚未确认。'
          : op.origin === 'local' ? '从明确表达识别，尚未确认。' : '由你在设置页提出。'),
        target?.expiresAt ? h('p', { style: hintStyle }, '有效至 ' + new Date(target.expiresAt).toLocaleString() + '，本次操作不会延长。') : null,
        h('p', { style: hintStyle }, op.kind === 'accept' ? '准备采用的内容' : '原先的记录'),
        h('div', { className: 'dsh-persona-memory-content' }, op.target.content),
        op.kind === 'revise' ? h('div', null, h('p', { style: hintStyle }, '更正后'),
          h('div', { className: 'dsh-persona-memory-content', 'data-memory-replacement': '' }, op.content)) : null,
        op.kind === 'retract' ? h('p', { style: hintStyle }, '确认后停止使用这条记录。保留撤销记录，不建立相反偏好，也不恢复同范围内已被替代的偏好。') : null,
        evidenceView(op.evidence),
        op.kind === 'accept' && op.conflicts?.length ? h('div', null,
          h('p', { style: hintStyle }, '采用后将替代以下同范围记录：'),
          ...op.conflicts.map((ref) => h('p', { key: ref.id, className: 'dsh-persona-memory-content' },
            data.entries.find((e) => e.id === ref.id)?.content ?? '记录已变化，请重新核对。'))) : null,
        h('p', { style: hintStyle }, '仅影响上述范围的后续表达。原汇报的事实、条件和风险仍以原文为准。'),
        stale ? h('p', { role: 'status', style: hintStyle }, '原记录已经变化，请放弃这张核对单，再对当前记录操作。') : null,
        h('div', { className: 'dsh-persona-memory-actions' },
          h('button', { type: 'button', style: primaryButtonStyle, disabled: busy || stale || scopePending,
            onClick: () => write({ action: 'confirm', id: op.id, version: op.version }) }, '确认' + name),
          h('button', { type: 'button', style: toggleStyle, disabled: busy,
            onClick: () => write({ action: 'dismiss', id: op.id, version: op.version }) }, '放弃这次操作')));
      });
      const memoryRows = entries.map((entry) => h('div', { key: entry.id, 'data-persona-shell': 'memory-entry', 'data-memory-id': entry.id,
        className: 'dsh-persona-memory-entry' },
      h('div', { style: hintStyle }, (labels[entry.kind] ?? entry.kind) + ' · '
        + (entry.expiresAt !== null && entry.expiresAt <= Date.now() ? '已过期' : labels[entry.status] ?? entry.status)),
      h('div', { className: 'dsh-persona-memory-content' }, entry.content),
      h('div', { style: hintStyle }, scopeLabel(entry) + (entry.pinned ? ' · 已置顶' : '')),
      entry.origin==='chat'&&!entry.evidence.some(e=>e.complete && e.source==='message')?h('small',null,'仅留档核对（不注入聊天）'):null,
      entry.key==='address'&&data.hasUserAddress?h('small',null,'聊天室已保存的用户称呼优先'):null,
      h('details',null,h('summary',null,'标签'+(entry.tags?.length?' · '+entry.tags.join('，'):'')),h('form',{key:entry.version,onSubmit:e=>{e.preventDefault();void write({action:'tags',id:entry.id,version:entry.version,tags:memoryTagList(e.currentTarget.elements.tags.value)});}},
        h('input',{name:'tags','aria-label':'编辑记忆标签',defaultValue:entry.tags?.join('，')}),h('button',{disabled:busy},'保存标签'))),
      h('details', null, h('summary', { style: hintStyle }, '查看来源'),
        h('p', { style: hintStyle }, labels[entry.origin] ?? '未知来源'), evidenceView(entry.evidence,
          entry.origin === 'legacy' ? '来自旧版迁移，没有逐条原始依据。' : '旧记录没有保存原话依据。'),
        entry.contextRef?h('p',null,entry.contextNote?'当时的公开回复 · '+entry.contextNote.author+'「'+entry.contextNote.text+'」':'当时的公开回复已不可用'):null,
        ...(data.operations ?? []).filter((op) => op.status === 'applied' && op.targetId === entry.id).map((op) =>
          h('div', { key: op.id }, h('p', { style: hintStyle }, { revise: '更正时的说明', retract: '撤销时的说明', accept: '采用时的依据' }[op.kind]),
            op.kind === 'revise' ? h('p', { className: 'dsh-persona-memory-content' }, '更正为：' + op.content) : null,
            evidenceView(op.evidence)))),
      editing?.id === entry.id ? h('div', { className: 'dsh-persona-memory-editor', 'aria-label': editing.operation === 'revise' ? '更正记忆' : '撤销记忆' },
        h('p', { style: hintStyle }, scopeLabel(editing) + '。更正与撤销不会改变记录的归属。'),
        editing.operation === 'revise' ? h('label', { style: labelStyle }, '现在应该怎样记',
          h('textarea', { style: inputStyle, maxLength: 240, value: editDraft.content, disabled: busy,
            'aria-label': '更正后的记忆内容', onChange: (e) => changeEdit({ content: e.target.value }) })) : null,
        h('label', { style: labelStyle }, '你的原话',
          h('textarea', { style: inputStyle, maxLength: 1000, value: editDraft.statement, disabled: busy,
            'aria-label': '本次更正或撤销的原话', placeholder: editing.operation === 'revise'
              ? '例如：以前说要简短，现在我希望把必要的解释讲清楚。' : '例如：不用再记着提醒我休息了。',
            onChange: (e) => changeEdit({ statement: e.target.value }) })),
        h('span', { style: hintStyle }, '这段说明按原样保存，仅作为你在设置页提交的依据；不会发送到工作对话。'),
        h('div', { className: 'dsh-persona-memory-actions' },
          h('button', { type: 'button', style: primaryButtonStyle,
            disabled: busy || !editDraft.statement.trim() || (editing.operation === 'revise'
              && (!editDraft.content.trim() || editDraft.content.trim() === editing.content)),
            onClick: async () => {
              const key = editing.id + ':' + editing.operation;
              if (await write({ action: 'propose', operation: editing.operation, id: editing.id,
                version: editing.version, content: editDraft.content, statement: editDraft.statement })) {
                memoryEditDrafts.delete(key); setEditing(undefined); setView('pending');
              }
            } }, editing.operation === 'revise' ? '预览更正' : '预览撤销'),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: () => setEditing(undefined) }, '收起，保留草稿')))
        : h('div', { className: 'dsh-persona-memory-actions' },
          entry.status === 'candidate' ? h('button', { type: 'button', style: primaryButtonStyle, disabled: busy,
            onClick: async () => { if (await write({ action: 'propose', operation: 'accept', id: entry.id, version: entry.version })) setView('pending'); } }, '核对并采用') : null,
          entry.status === 'candidate' ? h('button', { type: 'button', style: toggleStyle, disabled: busy,
            onClick: () => write({ action: 'reject', id: entry.id, version: entry.version }) }, '忽略') : null,
          ...(['revise', 'retract'].filter(() => live(entry)).map((operation) => h('button', { key: operation,
            type: 'button', style: toggleStyle, disabled: busy, onClick: () => beginEdit(entry, operation) },
          operation === 'revise' ? '更正' : '撤销'))),
          live(entry) ? h('button', { type: 'button', style: toggleStyle, disabled: busy,
            onClick: () => write({ action: 'pin', id: entry.id, version: entry.version, pinned: !entry.pinned }) }, entry.pinned ? '取消置顶' : '置顶') : null),
      h('details', { className: 'dsh-persona-memory-delete' }, h('summary', { style: hintStyle }, '彻底删除'),
        h('p', { style: hintStyle }, '删除这条记录、相关核对单和待整理来源。只想停用时可选择撤销。'),
        h('button', { type: 'button', style: toggleStyle, disabled: busy,
          onClick: () => write({ action: 'delete', id: entry.id, version: entry.version }) }, '确认删除这条记录'))));
      const scopeFields = (value) => ({ scope: value==='room'?'session':value, personaId: value === 'persona' ? data?.activePersonaId : null,
        sessionId: value === 'room'?manual.roomId:value === 'session' ? data?.sessionId : null });
      const manualEditor = h('div', null,
        h(MemoryMetadataFields,{value:manual,change:editManual}),
        h('textarea', { style: inputStyle, value: manual.content, maxLength: 240, disabled: busy,
          'aria-label': '新增记忆内容', placeholder: '例如：称呼我为阿晴；汇报先说结果，再补充条件。',
          onChange: (e) => editManual({ content: e.target.value }) }),
        h('div', { className: 'dsh-persona-memory-actions' },
          h('select', { style: inputStyle, value: manual.kind, disabled: busy, 'aria-label': '记忆类型',
            onChange: (e) => editManual({ kind: e.target.value }) },
          ...['preference', 'agreement', 'context', 'episode'].map((value) => h('option', { key: value, value }, labels[value]))),
          h('select', { style: inputStyle, value: manual.scope, disabled: busy || scopePending, 'aria-label': '记忆适用范围',
            onChange: (e) => editManual({ scope: e.target.value }) },
          h('option', { value: 'persona' }, '当前人格'), h('option', { value: 'shared', disabled: ['agreement', 'episode'].includes(manual.kind) }, '所有人格'),
          h('option', { value: 'session', disabled: !data?.sessionId }, '工作会话（角色共享）'),h('option',{value:'room'},'聊天室房间')),
          manual.scope==='room'?h('select',{value:manual.roomId??'','aria-label':'选择聊天室房间',onFocus:loadRooms,onChange:e=>editManual({roomId:e.target.value})},
            h('option',{value:''},'选择房间'),...rooms.map(r=>h('option',{key:r.id,value:r.id},r.name))):null,
          h('button', { type: 'button', style: primaryButtonStyle, disabled: busy || scopePending || !manual.content.trim()
            || (manual.scope === 'room' && !rooms.some(r=>r.id===manual.roomId)) || (manual.scope === 'session' && !data?.sessionId) || (manual.scope === 'shared' && ['agreement', 'episode'].includes(manual.kind)),
            onClick: async () => {
              if (await write({ action: 'propose-add', entry: { kind: manual.kind, content: manual.content, ...scopeFields(manual.scope), ...memoryMetadata(manual) } })) {
                const next = { ...manual, content: '' }; setManual(next); keepDraft(memoryAddDrafts, draftKey, next);
                if(manual.scope==='room')setFilter('all');setView('pending');
              }
            } }, '预览新记忆')),
        h('p', { style: hintStyle }, manual.scope === 'shared' ? '这条内容会供所有人格使用，请只记录确实通用的偏好。'
          : manual.scope === 'room'?'供所选房间所有成员使用，默认长期有效。':manual.scope === 'session' ? '供当前会话中的角色共享，默认一天后失效。' : '只交给当前人格，新建或另存人格不会继承。'));
      const clearControl = h('div', null, h('p', { style: hintStyle }, '清空所有人格的记忆、原话依据、待确认项目和交接记录。'),
        clearConfirm ? h('div', { className: 'dsh-persona-memory-actions' },
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: async () => {
            if (busyRef.current) return;
            busyRef.current = true; setBusy(true); const token = ++revision.current;
            try {
              const result = await save({ clearMemory: true });
              if (revision.current !== token) return;
              if (result?.settings) {
                setEditing(undefined); memoryEditDrafts.clear(); setClearConfirm(false);
                setData((previous) => previous ? { ...previous, entries: [], operations: [], usage: { version: 1, records: [] },
                  extraction: { status: 'idle', pending: 0 } } : previous);
                busyRef.current = false; await refresh(); setNotice('已清空记忆、原话依据和待确认项目。');
              } else setNotice('清空未完成，请稍后重试。');
            } catch { if (revision.current === token) setNotice('清空未完成，请稍后重试。');
            } finally { busyRef.current = false; setBusy(false); }
          } }, '确认清空全部记忆'),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: () => setClearConfirm(false) }, '取消清空'))
          : h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: () => setClearConfirm(true) }, '清空记忆'));
      return h('div', { className: 'dsh-persona-memory', style: { ...fieldStyle, marginBottom: 0 }, 'data-persona-shell': 'memory-panel' },
        h('style', null, SETTINGS_CSS),
        h('label', { style: toggleRowStyle }, h('input', { type: 'checkbox', checked: settings.memory !== false,
          onChange: (e) => save({ memory: e.target.checked }) }), h('span', { style: labelStyle }, '记住偏好与约定')),
        h('span', { style: hintStyle }, '从已启用的主工作会话识别明确偏好，供适用的人格表达参考。聊天室不会自动提炼长期记忆；可在这里手动管理。关闭后停止采集和使用，已有记录与房间聊天分别保留。'),
        settingsFold('memory-extraction', '后台整理', '可选，额外调用转述模型',
          h('div', null, h('label', { style: toggleRowStyle }, h('input', { type: 'checkbox', checked: settings.memoryExtraction === true,
            disabled: settings.memory === false, onChange: (e) => save({ memoryExtraction: e.target.checked }) }),
          h('span', { style: labelStyle }, '后台整理记忆候选（默认关闭）')),
          h('p', { style: hintStyle }, '开启后把有限的用户短消息片段交给转述模型整理。约每5分钟或积累8条同会话消息处理一次。候选、更正和撤销都在这里核对，不打扰对话。'),
          h('div', { className: 'dsh-persona-memory-footer' }, h('span', { style: hintStyle }, data?.extraction?.status === 'running' ? '正在整理…'
            : data?.extraction?.status === 'failed' ? '上次整理未完成，可稍后重试。' : '待整理 ' + (data?.extraction?.pending ?? 0) + ' 条'),
          h('button', { type: 'button', style: toggleStyle, disabled: busy || !settings.memory || !settings.memoryExtraction,
            onClick: () => write({ action: 'consolidate' }) }, '整理一次'))), { badge: settings.memoryExtraction ? '已开启' : '已关闭' }),
        h('div', { className: 'dsh-persona-memory-toolbar' }, h('span', { style: labelStyle }, '记忆管理'),
          h('select', { style: inputStyle, value: filter, 'aria-label': '筛选记忆', onChange: (e) => { setFilter(e.target.value); setEditing(undefined); } },
          h('option', { value: 'current' }, '当前人格与共享'), ...Object.entries(data?.roomNames??{}).map(([id,name])=>h('option',{key:id,value:id},'房间 · '+name)),h('option', { value: 'all' }, '全部人格')),
          h('select',{'aria-label':'筛选类型',value:kindFilter,onChange:e=>setKindFilter(e.target.value)},h('option',{value:''},'全部类型'),...['preference','agreement','context','episode'].map(id=>h('option',{key:id,value:id},labels[id]))),
          h('input',{type:'search','aria-label':'搜索记忆',placeholder:'搜索内容或标签',value:query,onChange:e=>setQuery(e.target.value)}),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: refresh }, '刷新记忆')),
        h(MemoryUsagePanel, { data, presets, settings, filter, refresh, busy, scopePending }),
        data?.capacity?h('details',null,h('summary',null,'记忆占用 '+data.capacity.used+' / '+data.capacity.limit),h(CapacityTools,{data,write,busy})):null,
        h('div', { className: 'dsh-persona-memory-tabs', role: 'group', 'aria-label': '记忆状态' },
          ...[['active', '使用中', all.filter(live).length], ['pending', '待确认', pending.length + candidates.length],
            ['history', '历史', all.filter((e) => !live(e) && e.status !== 'candidate').length]].map(([id, name, count]) =>
            h('button', { key: id, type: 'button', 'aria-pressed': view === id,
              onClick: () => { setView(id); setEditing(undefined); if (memoryList.current) memoryList.current.scrollTop = 0; } }, name + ' ' + count))),
        h('div', { className: 'dsh-persona-memory-footer' }, h('span', { style: hintStyle, role: 'status', 'aria-live': 'polite' }, notice)),
        h('div', { className: 'dsh-persona-memory-list', ref: memoryList }, ...(view === 'pending' ? pendingRows : []), ...memoryRows),
        scopePending ? h('p', { style: hintStyle }, '正在读取当前人格的记忆…') : entries.length + (view === 'pending' ? pending.length : 0) === 0
          ? h('p', { style: hintStyle }, view === 'pending' ? '暂时没有需要确认的内容。' : view === 'history' ? '还没有历史记录。'
            : '还没有正在使用的记忆，可以手动记一条。') : null,
        settingsFold('memory-add', '手动记一条', '选择内容与适用范围', manualEditor, { badge: manual.content.trim() ? '有草稿' : undefined }),
        settingsFold('memory-clear', '清理记忆', '清空所有人格的记忆与待确认内容', clearControl));
    }
