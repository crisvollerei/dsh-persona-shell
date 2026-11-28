// SECTION thinking
    // These two global preferences have one draft and write order across both entrances.
    // A failed save stays here when the small room panel is closed or minimized.
    const chatThinkingListeners=new Set();
    const chatThinkingState={settings:null,drafts:{},versions:{},revision:0,ackRevision:0,routeRevision:0,pending:0,errors:{}};
    const chatThinkingSnapshots=new WeakMap();
    let chatThinkingWrites=Promise.resolve();
    const chatThinkingKeys=['chatThinking','chatReasoningEffort','chatProvider','chatModel','provider','model'];
    function notifyChatThinking(){for(const update of chatThinkingListeners)update();}
    const chatThinkingReadAt=()=>({revision:chatThinkingState.revision,ackRevision:chatThinkingState.ackRevision,pending:chatThinkingState.pending,routeRevision:chatThinkingState.routeRevision});
    function acceptChatThinking(settings,context){
      if(!settings||typeof settings!=='object')return;
      const {readAt,ack,routeAt,routeOnly=false}=context??chatThinkingSnapshots.get(settings)??{};
      const current=chatThinkingState.settings;
      const freshRead=readAt&&readAt.revision===chatThinkingState.revision&&readAt.ackRevision===chatThinkingState.ackRevision
        &&readAt.routeRevision===chatThinkingState.routeRevision&&readAt.pending===0&&chatThinkingState.pending===0;
      const acceptValues=!current||(!routeOnly&&(ack!==undefined?ack>=chatThinkingState.ackRevision:readAt?freshRead
        :chatThinkingState.revision===0));
      const acceptRoute=!current||(readAt?freshRead:routeAt!==undefined?routeAt===chatThinkingState.routeRevision:chatThinkingState.revision===0);
      const next={chatThinking:settings.chatThinking!==false,chatReasoningEffort:typeof settings.chatReasoningEffort==='string'?settings.chatReasoningEffort:'',
        chatProvider:settings.chatProvider??'',chatModel:settings.chatModel??'',provider:settings.provider??'',model:settings.model??''};
      if(!acceptValues){next.chatThinking=current.chatThinking;next.chatReasoningEffort=current.chatReasoningEffort;}
      else if(ack!==undefined)chatThinkingState.ackRevision=Math.max(chatThinkingState.ackRevision,ack);
      const routeKeys=['chatProvider','chatModel','provider','model'];
      if(!acceptRoute)for(const key of routeKeys)next[key]=current[key];
      if(!current||routeKeys.some(key=>current[key]!==next[key]))chatThinkingState.routeRevision++;
      if(context)chatThinkingSnapshots.set(settings,routeOnly?{routeOnly:true,routeAt:chatThinkingState.routeRevision}:context);
      if(chatThinkingState.settings&&chatThinkingKeys.every(key=>chatThinkingState.settings[key]===next[key]))return;
      chatThinkingState.settings=next;notifyChatThinking();
    }
    function saveChatThinking(patch,save){
      const versions={};
      for(const [key,value] of Object.entries(patch)){
        const version=++chatThinkingState.revision;
        chatThinkingState.drafts[key]=value;chatThinkingState.versions[key]=version;versions[key]=version;delete chatThinkingState.errors[key];
      }
      chatThinkingState.pending++;notifyChatThinking();
      const task=chatThinkingWrites.then(async()=>{
        const routeAt=chatThinkingState.routeRevision;
        let result;try{result=await save(patch);}catch{/* Keep the current draft on transport/save failure. */}
        if(result?.settings)acceptChatThinking(result.settings,{ack:Math.max(...Object.values(versions)),routeAt});
        for(const [key,version] of Object.entries(versions))if(chatThinkingState.versions[key]===version){
          if(result?.settings){delete chatThinkingState.drafts[key];delete chatThinkingState.versions[key];delete chatThinkingState.errors[key];}
          else chatThinkingState.errors[key]=true;
        }
        chatThinkingState.pending--;notifyChatThinking();return result;
      });
      chatThinkingWrites=task.catch(()=>{});return task;
    }
    const CHAT_THINKING_CSS=`
      .dsh-persona-chat-thinking{display:grid;gap:10px;color:var(--dsw-alias-label-primary,#203044);font-size:13px;line-height:1.55}
      .dsh-persona-chat-thinking p{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#607080);line-height:1.6}
      .dsh-persona-chat-thinking-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600}
      .dsh-persona-chat-thinking-toggle input{margin:0;width:15px;height:15px;flex:none;accent-color:var(--dsw-alias-brand-primary,#3976c3)}
      .dsh-persona-chat-thinking-level{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:center}
      .dsh-persona-chat-thinking-level select{min-width:0;width:100%;max-width:100%;font:inherit;font-size:13px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1,#d8dfe7);border-radius:7px;color:inherit;background:var(--dsw-alias-bg-layer-1,#fff)}
      .dsh-persona-chat-thinking-level select:disabled{opacity:.55}
      .dsh-persona-chat-thinking-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#607080)}
      .dsh-persona-chat-thinking-status button{font:inherit;color:var(--dsw-alias-brand-primary,#3976c3);background:none;border:0;padding:2px 0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
      .dsh-persona-chat-settings-appearance{margin-top:16px;padding-top:15px;border-top:1px solid var(--dsw-alias-border-l1,#d8dfe7)}
      @media(max-width:380px){.dsh-persona-chat-thinking-level{grid-template-columns:1fr;gap:5px}}
    `;
    function ChatThinkingControls({visible=true,settings,save=postSettings,roomId,routeKey=''}){
      const [,render]=React.useState(0),[loadError,setLoadError]=React.useState(false),[reload,setReload]=React.useState(0);
      const [metadata,setMetadata]=React.useState({status:'loading',efforts:[],defaultEffort:null});
      const read=React.useRef(0),metadataRead=React.useRef(0);
      React.useEffect(()=>{const update=()=>render(value=>value+1);chatThinkingListeners.add(update);return()=>chatThinkingListeners.delete(update);},[]);
      React.useEffect(()=>{if(settings)acceptChatThinking(settings);},[settings]);
      React.useEffect(()=>{
        if(!visible||settings)return;
        const token=++read.current,abort=new AbortController(),readAt=chatThinkingReadAt();let alive=true;
        setLoadError(false);
        void(async()=>{try{const response=await fetch(ROUTE+'/settings',{signal:abort.signal});if(!response.ok)throw Error('settings-unavailable');
          const value=await response.json();if(alive&&!abort.signal.aborted&&token===read.current){if(!value?.settings)throw Error('settings-unavailable');acceptChatThinking(value.settings,{readAt});}
        }catch{if(alive&&!abort.signal.aborted&&token===read.current)setLoadError(true);}})();
        return()=>{alive=false;read.current++;abort.abort();};
      },[visible,settings!==undefined,reload]);
      const baseline=chatThinkingState.settings,thinking=chatThinkingState.drafts.chatThinking??baseline?.chatThinking??true,
        effort=chatThinkingState.drafts.chatReasoningEffort??baseline?.chatReasoningEffort??'';
      const routeSignature=JSON.stringify([baseline?.chatProvider,baseline?.chatModel,baseline?.provider,baseline?.model]);
      React.useEffect(()=>{
        if(!visible||!baseline)return;
        const token=++metadataRead.current,abort=new AbortController();let alive=true;
        setMetadata({status:'loading',efforts:[],defaultEffort:null});
        void(async()=>{try{const query=roomId?'?room='+encodeURIComponent(roomId):'',response=await fetch(ROUTE+'/chat-model-options'+query,{signal:abort.signal});
          if(!response.ok)throw Error('metadata-unavailable');const value=await response.json();
          if(!alive||abort.signal.aborted||token!==metadataRead.current)return;
          const efforts=Array.isArray(value.efforts)?value.efforts.filter((entry,index,all)=>typeof entry?.id==='string'&&entry.id.trim()&&entry.id.length<=128
            &&entry.id!=='off'&&all.findIndex(other=>other?.id===entry.id)===index).map(entry=>({id:entry.id,name:typeof entry.name==='string'&&entry.name?entry.name:entry.id})):[];
          setMetadata({status:['available','unavailable','unknown'].includes(value.status)?value.status:'unknown',efforts,
            offAvailable:Array.isArray(value.efforts)&&value.efforts.some(entry=>entry?.id==='off'),
            defaultEffort:typeof value.defaultEffort==='string'?value.defaultEffort:null,provider:typeof value.provider==='string'?value.provider:'',model:typeof value.model==='string'?value.model:'',
            error:['metadata-unavailable','no-route'].includes(value.error)?value.error:undefined});
        }catch{if(alive&&!abort.signal.aborted&&token===metadataRead.current)setMetadata({status:'unknown',efforts:[],defaultEffort:null,error:'metadata-unavailable'});}})();
        return()=>{alive=false;metadataRead.current++;abort.abort();};
      },[visible,roomId,routeKey,routeSignature,!!baseline,reload]);
      const unknownEffort=effort&&!metadata.efforts.some(entry=>entry.id===effort),failed=Object.keys(chatThinkingState.errors).length>0;
      const defaultName=metadata.efforts.find(entry=>entry.id===metadata.defaultEffort)?.name??metadata.defaultEffort;
      const hint=metadata.status==='loading'?'正在读取当前聊天室模型的思考选项…':metadata.error==='no-route'?'暂未找到可用的聊天室模型；已保存的设置仍保留。'
        :metadata.status==='unknown'?'暂未读取到模型能力；已保存的选择仍保留，调用时采用提供方兼容策略。'
        :metadata.status==='unavailable'?'当前模型没有公开可开启的思考档；设置仍保留，调用时按模型能力兼容。'
        :!thinking&&metadata.status==='available'&&!metadata.offAvailable?'当前模型没有关闭档位，将使用最低可用档；已保存强度仍保留。'
        :!thinking?'已关闭思考，上次选择的强度仍保留。'
        :effort&&unknownEffort?'当前模型未列出这个强度，调用时回到模型默认；已保存的选择仍保留。'
        :!effort&&metadata.defaultEffort==='off'?'该模型默认关闭思考；开启时会采用最低可用思考档。'
        :!effort&&metadata.defaultEffort===null?'模型未公布默认思考档，由提供方决定；不保证已开启思考。'
        :!effort&&defaultName?'默认使用模型的「'+defaultName+'」档。':'按当前模型支持的档位调用。';
      return h('div',{className:'dsh-persona-chat-thinking','data-persona-shell':'chat-thinking'},h('style',null,CHAT_THINKING_CSS),
        h('label',{className:'dsh-persona-chat-thinking-toggle'},h('input',{type:'checkbox','aria-label':'开启聊天室思考',checked:thinking,disabled:!baseline,
          onChange:event=>void saveChatThinking({chatThinking:event.target.checked},save)}),h('span',null,'开启聊天室思考')),
        h('label',{className:'dsh-persona-chat-thinking-level'},h('span',null,'思考强度'),h('select',{'aria-label':'聊天室思考强度',value:effort,disabled:!baseline||!thinking,
          onChange:event=>void saveChatThinking({chatReasoningEffort:event.target.value},save)},h('option',{value:''},'模型默认'),
          unknownEffort?h('option',{value:effort},effort+'（已保存，当前模型未列出）'):null,
          ...metadata.efforts.map(entry=>h('option',{key:entry.id,value:entry.id},entry.name)))),
        metadata.model?h('p',null,'当前模型：'+metadata.model+(metadata.provider?' · '+metadata.provider:'')):null,
        h('p',{role:'status','aria-live':'polite'},hint),
        h('p',null,'默认开启，强度跟随模型默认。思考可能稍慢、用量稍高；这里只影响之后的聊天与快捷回复。'),
        h('div',{className:'dsh-persona-chat-thinking-status',role:'status','aria-live':'polite'},
          chatThinkingState.pending?h('span',null,'正在保存…'):failed?h('span',null,'设置未保存，当前选择已保留。'):null,
          failed?h('button',{type:'button',disabled:chatThinkingState.pending>0,onClick:()=>void saveChatThinking({...chatThinkingState.drafts},save)},'重试保存思考设置'):null,
          loadError?h('span',null,'暂时无法读取已保存的设置。'):null,
          (loadError||metadata.status==='unknown'||metadata.error==='no-route')?h('button',{type:'button',onClick:()=>setReload(value=>value+1)},'重新读取思考选项'):null));
    }

// SECTION profile
    function ChatUserSettings({ onClose, visible = true }) {
      const [value, setValue] = React.useState(undefined), [editing, setEditing] = React.useState(undefined);
      const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState('');
      const [addressDraft,setAddressDraft]=React.useState(()=>chatUserAddressState.draft),[addressNotice,setAddressNotice]=React.useState(()=>chatUserAddressState.notice),
        [addressSaving,setAddressSaving]=React.useState(()=>chatUserAddressState.saving);
      const live = React.useRef(false), request = React.useRef(0), saving = React.useRef(false), state = React.useRef(undefined), retired = React.useRef(new Set()),profileRead=React.useRef(null);
      const accept = (next) => {
        if (!live.current || retiredInstances.has(next?.instanceId) || retired.current.has(next?.instanceId) || !Number.isSafeInteger(next?.revision)) return;
        if (state.current?.instanceId === next.instanceId && state.current.revision > next.revision) return;
        if (state.current?.instanceId && state.current.instanceId !== next.instanceId) retired.current.add(state.current.instanceId);
        state.current = next; setValue(next);
      };
      const refresh = async () => {
        const token = ++request.current,abort=new AbortController();profileRead.current?.abort();profileRead.current=abort;
        const timeout=setTimeout(()=>abort.abort(),10000);setNotice('正在读取个人资料…');
        try {
          const response = await fetch(ROUTE + '/chat-profile',{signal:abort.signal}); const next = await response.json();
          if(abort.signal.aborted)throw Error('profile-timeout');
          if (live.current && token === request.current) {
            if (!response.ok || !next.instanceId) throw Error('unavailable');
            accept(next); for (const update of chatProfileUpdates) update(next); setNotice('');
          }
        } catch { if (live.current && token === request.current) setNotice('个人资料暂时无法读取，可以刷新重试。'); }
        finally{clearTimeout(timeout);}
      };
      React.useEffect(() => {
        live.current = true; const update = (next) => accept(next); chatProfileUpdates.add(update);
        return () => { live.current = false; request.current += 1; profileRead.current?.abort();chatProfileUpdates.delete(update); };
      }, []);
      React.useEffect(()=>{const update=()=>{setAddressDraft(chatUserAddressState.draft);setAddressNotice(chatUserAddressState.notice);setAddressSaving(chatUserAddressState.saving);};
        chatUserAddressListeners.add(update);update();return()=>chatUserAddressListeners.delete(update);},[]);
      React.useEffect(()=>{if(visible)void refresh();},[visible]);
      const persist = async (patch, revision) => {
        if (saving.current) return { ok: false };
        saving.current = true; setBusy(true); request.current += 1;
        const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),10000);
        try {
          const response = await fetch(ROUTE + '/chat-profile', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...patch, revision }),signal:abort.signal });
          const next = await response.json();
          if(abort.signal.aborted)throw Error('profile-timeout');
          if (next.state) { accept(next.state); for (const update of chatProfileUpdates) update(next.state); }
          if (!response.ok) return { ok: false, reason: next.error === 'profile-conflict' ? 'avatar-conflict' : next.error };
          accept(next); for (const update of chatProfileUpdates) update(next);
          if (live.current&&(Object.hasOwn(patch,'avatar')||Object.hasOwn(patch,'avatarMode'))) { setEditing(undefined); setNotice('头像已保存。'); }
          return { ok: true, state:next };
        } catch { return { ok: false,reason:abort.signal.aborted?'profile-timeout':undefined }; }
        finally { clearTimeout(timeout);saving.current = false; if (live.current) setBusy(false); }
      };
      const save = ({ avatar }) => editing ? persist({ avatar }, editing.revision) : Promise.resolve({ ok: false });
      const mode = userAvatarMode(value);
      const accountUrl = useAccountAvatar(visible && !!value && mode === 'account');
      const changeMode = async (avatarMode) => {
        const result = await persist({ avatarMode }, state.current.revision);
        if (live.current && !result.ok) setNotice(result.reason === 'avatar-conflict'
          ? '外观已在别处更新，请核对当前选择后再试。' : '显示方式未保存，原设置仍保留，请重试。');
      };
      const changeGender = async (userGender) => {
        const result = await persist({ userGender }, state.current.revision);
        if (live.current) setNotice(result.ok ? '性别设置已保存，只影响之后的聊天回复。' : result.reason === 'avatar-conflict'
          ? '个人资料已在别处更新，请核对当前性别选择后重试。' : '未能确认性别设置已保存，请核对后重试。');
      };
      const [pendingReportAddress,setPendingReportAddress]=React.useState(null);
      const changeReportAddress=async reportAddress=>{
        setPendingReportAddress(reportAddress);
        const result=await persist({reportAddress},state.current.revision);
        if(live.current){setPendingReportAddress(null);setNotice(result.ok?'汇报称呼设置已保存。':result.reason==='avatar-conflict'?'个人资料已在别处更新，请核对汇报称呼选项后重试。':'设置未保存，请核对当前选择后重试。');}
      };
      const confirmedAddress=typeof value?.userAddress==='string'?value.userAddress:'',address=addressDraft?.text??confirmedAddress,
        addressError=userAddressProblem(address),addressDirty=address!==confirmedAddress;
      const editAddress=text=>{
        const next={text,version:++chatUserAddressDraftVersion};
        chatUserAddressState.draft=next;chatUserAddressState.notice='';notifyUserAddress();
      };
      const saveAddress=async()=>{
        if(!value||busy||chatUserAddressState.saving||editing||addressError||!addressDirty)return;
        const sent=addressDraft??{text:address,version:++chatUserAddressDraftVersion};chatUserAddressState.saving=true;notifyUserAddress();
        try{const result=await persist({userAddress:address},state.current.revision);
          if(result.ok){
            if(chatUserAddressState.draft?.version===sent.version)chatUserAddressState.draft=null;
            chatUserAddressState.notice=chatUserAddressState.draft?'上次称呼已保存，当前输入尚未保存。':'称呼已保存。';
          }else chatUserAddressState.notice=result.reason==='avatar-conflict'
            ?'个人资料已在别处更新，输入仍保留。请核对后重试保存。':result.reason==='profile-timeout'
              ?'未能确认保存，输入已保留。请核对后重试。':'称呼未能保存，输入仍保留，可以重试。';
        }finally{chatUserAddressState.saving=false;notifyUserAddress();}
      };
      return h('div', { 'data-persona-shell': 'user-profile', style: {
        '--dsh-persona-accent': 'var(--dsw-alias-brand-primary,#3976c3)', '--dsh-persona-border': 'var(--dsw-alias-border-l1,#d8dfe7)',
        '--dsh-persona-bg': 'var(--dsw-alias-bg-layer-1,#fff)', '--dsh-persona-soft': 'var(--dsw-alias-bg-layer-2,#f5f7fa)',
        '--dsh-persona-text': 'var(--dsw-alias-label-primary,#203044)', '--dsh-persona-muted': 'var(--dsw-alias-label-secondary,#607080)',
      } }, h('style', null, SETTINGS_CSS),
        h('div', { className: 'dsh-persona-memory-footer' }, h('strong', null, '我的资料'),
          onClose ? h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: onClose }, '收起外观') : null),
        h('label',{style:{...fieldStyle,marginTop:'14px'}},h('span',{style:labelStyle},'角色怎么称呼你'),
          h('input',{type:'text',style:inputStyle,'aria-label':'角色怎么称呼你',placeholder:'不指定，按人设自然称呼',value:address,
            'aria-invalid':!!addressError,disabled:!value,onChange:event=>editAddress(event.target.value)})),
        h('div',{style:{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'12px',marginTop:'8px'}},
          h('span',{style:hintStyle},Array.from(address.trim()).length+'/40'),h('button',{type:'button',style:toggleStyle,'aria-label':'保存称呼',
            disabled:!value||busy||addressSaving||!!editing||!!addressError||!addressDirty,onClick:()=>void saveAddress()},addressSaving?'保存中…':'保存称呼')),
        h('label',{style:{display:'flex',alignItems:'center',gap:'8px',margin:'0 0 14px',fontSize:'13px',cursor:'pointer'}},h('input',{type:'checkbox',style:{margin:0,accentColor:'var(--chat-brand,var(--dsw-alias-brand-primary))'},checked:pendingReportAddress??(value?.reportAddress===true),disabled:!value||busy||addressSaving||!!editing,
          onChange:event=>void changeReportAddress(event.target.checked)}),'工作汇报也使用这个称呼'),
        (pendingReportAddress??value?.reportAddress)&&(addressDirty||!confirmedAddress)?h('p',{style:hintStyle},'保存称呼后，新的工作汇报会使用它。'):null,
        h('p',{style:hintStyle,role:'status','aria-live':'polite'},addressError||addressNotice),
        h('label',{style:{...fieldStyle,marginTop:'14px'}},h('span',{style:labelStyle},'你的性别（聊天室）'),
          h('select',{style:inputStyle,'aria-label':'你的性别（聊天室）',value:value?.userGender??'unset',disabled:!value||busy||addressSaving||!!editing,
            onChange:event=>void changeGender(event.target.value)},
            h('option',{value:'unset'},'不指定'),h('option',{value:'female'},'女性'),h('option',{value:'male'},'男性'),h('option',{value:'none'},'无性别'))),
        h('p',{style:hintStyle},'可选，默认不指定；不指定表示不提供性别，不等于无性别。所有聊天室共用，不改工作汇报或长期记忆。默认不因性别差异拉开距离；设为男性时，女性人格会更克制，不主动肢体接触，收到你的邀请也保留分寸。女性或不指定时按性格自然相处；性别不代表同意接触。'),
        h('strong',{style:{display:'block',marginTop:'18px',marginBottom:'8px'}},'我的头像'),
        h('p', { style: hintStyle }, '默认跟随 DSH 账号头像。没有头像或加载失败时，只显示你的消息气泡。'),
        h('label', { style: { ...fieldStyle, marginTop: '14px' } }, h('span', { style: labelStyle }, '用户头像显示'),
          h('select', { style: inputStyle, 'aria-label': '用户头像显示', value: mode, disabled: !value || busy || !!editing,
            onChange: (event) => { void changeMode(event.target.value); } },
            h('option', { value: 'account' }, '跟随账号头像'), h('option', { value: 'custom', disabled: !value?.avatar }, '使用自定义头像'),
            h('option', { value: 'hidden' }, '不显示头像'))),
        editing ? h(PersonaAvatarEditor, { user: true, preset: { id: 'user', name: '你', avatar: editing.avatar }, busy, onSave: save,
          onClose: () => { setEditing(undefined); setNotice(''); } })
          : h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
            h(UserChatAvatar, { profile: value, accountUrl, className: 'dsh-persona-preset-avatar' }),
            h('button', { type: 'button', style: toggleStyle, disabled: !value || busy, onClick: () => setEditing(value) }, '修改我的头像'),
            h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: () => { void refresh(); void accountAvatarSource.refresh(); } }, '刷新头像')),
        !editing ? h('p', { style: hintStyle }, mode === 'hidden' ? '用户侧只显示消息气泡；已上传的图片仍保留。'
          : mode === 'account' ? accountUrl ? '使用当前 DSH 账号头像，不保存账号资料。' : '未获取到账号头像时，用户侧只显示消息气泡。'
            : '使用已上传的自定义图片；只保存取景后的图片，不发送给模型。') : null,
        h('p', { style: hintStyle, role: 'status' }, notice),
        notice==='个人资料暂时无法读取，可以刷新重试。'?h('button',{type:'button',style:toggleStyle,disabled:busy,onClick:()=>void refresh()},'重新读取个人资料'):null);
    }

    /** A visible model selector owns its catalogue request and retires it on hide/change. */
