// SECTION summary
    function personaSummary(preset) {
      if (preset.builtin) {
        if (preset.id === '大肥鱼（默认）') return '鲸鲸的轻松口吻';
        if (preset.id === '大肥龙') return 'GPT，直爽又有主见';
        if (preset.id === 'Claude小姐') return '理性、克制，规矩感强';
        if (preset.id === '鲸鲸（实验性）') return '转达原助手「姐姐」的汇报';
        if (preset.id === 'Gemini') return '猫猫，好奇心旺，接梗快';
      }
      return (preset.pack?.identity ?? '你自己的说话风格').replace(/\s+/g, ' ').slice(0, 36);
    }

// SECTION avatar
    function PersonaTrial({personaId,readDraft}) {
      const [mode,setMode]=React.useState('report'),[result,setResult]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
      const pending=React.useRef(null);
      React.useEffect(()=>()=>pending.current?.abort(),[]);
      const run=async()=>{
        if(pending.current)return;const abort=new AbortController();pending.current=abort;setBusy(true);setResult(null);setError('');
        try{const draft=await readDraft();if(!draft.pack)throw Error();
          const res=await fetch(ROUTE+'/presets',{method:'POST',signal:abort.signal,headers:{'content-type':'application/json'},
            body:JSON.stringify({action:'preview',personaId,mode,pack:draft.pack})});if(!res.ok)throw Error();
          const value=await res.json();if(!abort.signal.aborted)setResult(value);
        }catch{if(!abort.signal.aborted)setError('试说未完成，请核对草稿和模型后重试。');}
        finally{pending.current=null;if(!abort.signal.aborted)setBusy(false);}
      };
      return h('fieldset',{disabled:busy},h('legend',null,'试说一句'),h('label',null,'样板',h('select',{value:mode,onChange:e=>{setMode(e.target.value);setResult(null);setError('');}},
        h('option',{value:'report'},'工作汇报'),h('option',{value:'strict'},'严格转述'),h('option',{value:'chat'},'日常闲聊'))),
        h('button',{type:'button',onMouseDown:e=>e.preventDefault(),onClick:run},busy?'正在试说…':'试说一句'),
        result?h('div',{'aria-live':'polite'},h('blockquote',null,result.original),h('p',null,result.text),
          result.fallback?h('p',null,reportFallbackReason({status:'skipped',reason:result.fallback})):null,
          result.reasons?.length?h('p',null,'建议核对措辞 · '+result.reasons.map(reason=>REVIEW_REASON_LABELS[reason]??'表达有变化').join('、')):null):null,
        error?h('p',{role:'status'},error):null);
    }

    function PersonaAvatarEditor({ preset, busy, onSave, onClose, user = false }) {
      const [picture, setPicture] = React.useState(undefined), [reading, setReading] = React.useState(false);
      const [crop, setCrop] = React.useState({ x: 50, y: 50, zoom: 1 });
      const [notice, setNotice] = React.useState('');
      const canvas = React.useRef(null), live = React.useRef(true), request = React.useRef(0), operation = React.useRef(chatNonce());
      React.useEffect(() => { live.current = true; return () => { live.current = false; request.current += 1; }; }, []);
      const draw = () => {
        if (!picture || !canvas.current) return;
        const el = canvas.current, context = el.getContext('2d');
        const scale = Math.max(256 / picture.naturalWidth, 256 / picture.naturalHeight) * crop.zoom;
        const width = picture.naturalWidth * scale, height = picture.naturalHeight * scale;
        context.clearRect(0, 0, 256, 256);
        context.drawImage(picture, -(width - 256) * crop.x / 100, -(height - 256) * crop.y / 100, width, height);
      };
      React.useEffect(draw, [picture, crop]);
      const pick = async (file) => {
        if (!file || busy) return;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
          setNotice('请选择 8MB 以内的 PNG、JPG 或 WebP 图片。'); return;
        }
        const token = ++request.current; setReading(true); setNotice('');
        const url = URL.createObjectURL(file);
        try {
          const img = new Image();
          await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
          if (!live.current || token !== request.current) return;
          if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 40000000) throw Error('size');
          setPicture(img); setCrop({ x: 50, y: 50, zoom: 1 }); operation.current = chatNonce();
        } catch { if (live.current && token === request.current) setNotice('这张图片无法读取，或尺寸过大。请选择另一张。'); }
        finally { URL.revokeObjectURL(url); if (live.current && token === request.current) setReading(false); }
      };
      const save = async (remove = false) => {
        if (busy || reading || (!picture && !remove)) return;
        draw();
        const avatar = remove ? null : canvas.current.toDataURL('image/png');
        const result = await onSave({ action: 'avatar', id: preset.id, avatar, expectedAvatar: preset.avatar ?? null,
          requestId: (remove ? 'remove-' : '') + operation.current });
        if (live.current && result?.ok !== true) setNotice(result?.reason === 'avatar-conflict'
          ? '头像已在别处更新，请取消后重新打开。已选图片仍保留。' : '保存未完成，已选图片与取景仍保留，可以重试。');
      };
      return h('section', { className: 'dsh-persona-avatar-editor', role: 'group', 'aria-label': user ? '编辑我的头像' : '编辑人格头像' },
        h('div', { className: 'dsh-persona-memory-footer' }, h('strong', null, preset.name + ' · 头像'),
          h('button', { type: 'button', style: toggleStyle, disabled: busy, onClick: onClose }, '取消头像修改')),
        h('p', { style: hintStyle }, user ? '这张头像用于所有角色聊天，只改变显示，不影响人格与记忆。' : preset.builtin ? '只覆盖这位内置人格在本机的显示头像，可恢复原图。身份、默认选择、房间成员与私人记忆归属保持不变。' : '只改变这位角色的头像，身份、聊天记录与记忆保持不变。'),
        h('div', { className: 'dsh-persona-avatar-workbench' },
          picture ? h('canvas', { ref: canvas, width: 256, height: 256, 'aria-label': '头像取景预览' })
            : h(PersonaAvatar, { src: preset.avatar, id: preset.id, name: preset.name, className: 'dsh-persona-avatar-preview' }),
          h('div', null, h('label', { style: fieldStyle }, h('span', { style: labelStyle }, '选择头像图片'),
            h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', disabled: busy || reading,
              'aria-label': '选择头像图片', onClick: (event) => { event.target.value = ''; }, onChange: (event) => { void pick(event.target.files?.[0]); } })),
            picture ? h('div', { className: 'dsh-persona-avatar-crop' },
              ...[['x', '左右位置', 0, 100, 1], ['y', '上下位置', 0, 100, 1], ['zoom', '缩放', 1, 3, 0.05]].map(([key, title, min, max, step]) =>
                h('label', { key }, title, h('input', { type: 'range', min, max, step, value: crop[key], 'aria-label': '头像' + title,
                  disabled: busy, onChange: (event) => { setCrop({ ...crop, [key]: Number(event.target.value) }); operation.current = chatNonce(); } }))))
              : h('p', { style: hintStyle }, '支持 PNG、JPG、WebP，选好后可调整取景。图片仅保存在插件内，不发送给模型。'))),
        h('div', { className: 'dsh-persona-memory-actions' },
          h('button', { type: 'button', style: primaryButtonStyle, disabled: busy || reading || !picture, onClick: () => save() },
            busy ? '正在保存…' : user ? '保存我的头像' : '保存头像'),
          (preset.builtin ? preset.avatarOverridden === true : !!preset.avatar) ? h('button', { type: 'button', style: toggleStyle, disabled: busy || reading, onClick: () => save(true) },
            user ? '使用账号头像' : preset.builtin ? '恢复原头像' : '移除头像') : null),
        h('p', { style: hintStyle, role: 'status', 'aria-live': 'polite' }, reading ? '正在读取图片…' : notice));
    }

// SECTION editor
      const personaControls = h('div', { className: 'dsh-persona-personas' },


          // Say where edits go before they are made: an edit to the builtin
          // forks a new preset, and that is surprising if it is not announced.


          presets && presets.length > 0
            ? h('div', { className: 'dsh-persona-preset-grid', 'data-many': presets.length > 5 },
              ...presets.map((preset) => h('div', {
                key: preset.id,
                className: 'dsh-persona-preset', 'data-preset-id': preset.id, 'data-active': preset.id === activePresetId,
              },
              preset.avatar ? h(PersonaAvatar, { src: preset.avatar, name: preset.name, id: preset.id, fallback: false,
                className: 'dsh-persona-preset-avatar' }) : null,
              h('span', {
                className: 'dsh-persona-preset-name',
                style: presetNameStyle,
              }, preset.name, h('small', { className: 'dsh-persona-preset-description' }, personaSummary(preset))),
              preset.builtin === true
                ? h('span', { className: 'dsh-persona-preset-tag' }, '内置')
                : null,
              h('div', { className: 'dsh-persona-preset-actions' },
                h('button', { type: 'button', style: toggleStyle, disabled: presetBusy,
                  'aria-label': '修改' + preset.name + '头像', onClick: () => setEditingAvatar(preset) }, '头像'),
                preset.id === activePresetId
                  ? h('span', { className: 'dsh-persona-selected-label' }, '已选择')
                  : h('button', {
                    type: 'button',
                    style: toggleStyle,
                    disabled: presetBusy,
                    onClick: () => presetAction({ action: 'apply', id: preset.id }),
                  }, '启用'),
                preset.builtin === true
                  ? null
                  : h('button', {
                    type: 'button',
                    style: toggleStyle,
                    disabled: presetBusy,
                    onClick: () => startRename(preset),
                  }, '改名'),
                preset.builtin === true
                  ? null
                  : h('button', {
                    type: 'button',
                    style: { ...toggleStyle, color: 'var(--dsw-alias-label-tertiary)' },
                    disabled: presetBusy,
                    onClick: () => presetAction({ action: 'delete', id: preset.id }),
                  }, '删除'),
              ))),
            )
            : null,

          editingAvatar ? h(PersonaAvatarEditor, { key: editingAvatar.id, preset: editingAvatar, busy: presetBusy,
            onClose: () => setEditingAvatar(undefined), onSave: async (body) => {
              const result = await presetAction(body); if (result?.ok === true && mounted.current) setEditingAvatar(undefined); return result;
            } }) : null,

          presets.some(p=>p.builtin&&p.character)?h('details',{className:'dsh-persona-character-guide',style:{marginTop:12}},
            h('summary',{style:{cursor:'pointer',fontSize:12,color:'var(--dsw-alias-label-secondary)'}},'内置人物关系'),
            h('p',{style:hintStyle},'大肥鱼和小肥鱼是姐妹。大家叫大肥龙「GPT」，叫 Gemini「猫猫」。这些是本插件的二创设定，自定义人格有自己的关系。'),
            h('div',{style:{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,320px),1fr))',gap:10}},
              ...presets.filter(p=>p.builtin&&p.character).map(p=>h('article',{key:p.id,style:{border:'1px solid var(--dsw-alias-border-l1)',borderRadius:9,padding:'10px 12px'}},
                h('strong',{style:{fontSize:12}},p.name+' · '+p.character.genderLabel),
                h('p',{style:{...hintStyle,margin:'5px 0 8px'}},'称呼：'+p.character.preferredAddress.join('、')),
                ...p.character.relations.map(r=>h('p',{key:r.to,style:{...hintStyle,margin:'5px 0'}},
                  h('span',{style:{color:'var(--dsw-alias-label-primary)'}},'对'+r.address+'：'),r.dynamic)))))):null,

          // Inline rename: a dialog would be heavier than the operation, and the
          // page already has the preset in hand.
          renaming !== undefined
            ? h('div', { style: { ...presetPreviewStyle, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('input', {
                style: { ...inputStyle, flex: 1 },
                value: renameValue,
                disabled: presetBusy,
                onChange: (event) => setRenameValue(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') commitRename(); },
              }),
              h('button', { type: 'button', style: primaryButtonStyle, disabled: presetBusy, onClick: commitRename }, '保存'),
              h('button', {
                type: 'button',
                style: toggleStyle,
                onClick: () => { setRenaming(undefined); setRenameValue(''); },
              }, '取消'),
            )
            : null,
        );
      const chatSourceCanBind = (identity, voice) => typeof identity === 'string' && identity.trim() && identity.trim().length <= 4000
        && Array.isArray(voice) && voice.length <= 8 && voice.every(line => typeof line === 'string' && line.trim() && line.length <= 400);
      const chatSourceActive = (profile, identity, voice) => profile?.source?.enabled === true && profile.source.identity === identity?.trim()
        && Array.isArray(profile.source.voice) && profile.source.voice.length === (profile.voice ?? voice ?? []).length
        && profile.source.voice.every((line, index) => line === (profile.voice ?? voice ?? [])[index]);
      const sourcePreview = (profile, identity, voice) => profile?.source ? h('details', { style: { marginTop: '6px' } },
        h('summary', null, `原始人设参考（${chatSourceActive(profile, identity, voice) ? '用于聊天' : '未启用'}）`),
        h('p', { style: hintStyle }, '仅作虚构角色资料，当前身份、语气和用户本次原话优先；不是实际经历、长期记忆或工具权限，不提供给工作转述。'),
        h('div', { style: { ...memoryLineStyle, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, profile.source.text)) : null;
      const chatExamplesPreview = (profile) => h(React.Fragment, null,
        profile?.samples?.length ? h('details', { style: { marginTop: '6px' } }, h('summary', null, '聊天语气示例'),
          h('div', { style: { ...memoryLineStyle, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, profile.samples.join('\n\n'))) : null,
        ...[['dialogueExamples', '日常虚构示例'], ['workDialogueExamples', '工作讨论虚构示例']].map(([key, label]) =>
          Array.isArray(profile?.[key]) && profile[key].length ? h('details', { key, style: { marginTop: '6px' } },
            h('summary', null, label), ...profile[key].map((group, index) => h('div', { key: index,
              style: { ...memoryLineStyle, marginTop: '6px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
              (group.turns ?? []).map(turn => `${turn.speaker === 'self' ? '本人' : turn.speaker === 'user' ? '用户' : turn.speaker}：${turn.text}`).join('\n')))) : null));
      const editGenerated = (section, key, value) => setGenerated(current => current
        ? section ? { ...current, [section]: { ...current[section], [key]: value } } : { ...current, [key]: value } : current);
      const generatorControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('span', { style: labelStyle }, '从人设提示词生成预设'),
          h('span', { style: hintStyle },
            '粘贴人设提示词，分别准备聊天和转述表达。先预览、改名，再保存启用；生成不会自动替换当前人格。',
          ),
          h('textarea', {
            style: { ...inputStyle, minHeight: '88px', resize: 'vertical' },
            'aria-label': '人设提示词', placeholder: '粘贴人设提示词…',
            value: personaPrompt,
            onChange: (event) => setPersonaPrompt(event.target.value),
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '6px' } },
            h('button', {
              type: 'button',
              ref: generateButton,
              style: primaryButtonStyle,
              disabled: generating || presetBusy || personaPrompt.trim().length < 20,
              onClick: (event) => generatePreset(event),
            }, generating ? '生成中…' : '生成预设'),
            presetStatus !== '' ? h('span', { style: hintStyle }, presetStatus) : null,
          ),
          generated !== undefined
            ? h('details', { style: presetPreviewStyle, open: generatedReviewOpen,
              onToggle: event => { if (event.currentTarget.open !== generatedReviewOpen) setGeneratedReviewOpen(event.currentTarget.open); } },
              h('summary', { style: { ...labelStyle, cursor: 'pointer', overflowWrap: 'anywhere' },
                'aria-disabled': generating || presetBusy,
                onClick: event => {
                  if (generating || presetBusy) event.preventDefault();
                  else if (!generatedReviewOpen) generatedReviewReturn.current = event.currentTarget;
                } }, '核对生成结果（未保存）'),
              h('section', { ref: generatedReview, role: generatedReviewOpen ? 'dialog' : undefined,
                'aria-label': '核对生成的人格', 'aria-modal': false, tabIndex: -1,
                style: { maxHeight: 'min(72vh, 760px)', overflowY: 'auto', overscrollBehavior: 'contain', padding: '8px 2px 2px', outlineOffset: '2px' },
                onKeyDown: event => {
                  if (event.key === 'Escape' && !event.nativeEvent?.isComposing) {
                    event.preventDefault(); event.stopPropagation(); closeGeneratedReview();
                  }
                } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
                h('strong', { style: labelStyle }, '保存前核对一下'),
                h('button', { type: 'button', style: toggleStyle, disabled: presetBusy || generating, onClick: closeGeneratedReview }, '稍后编辑')),
              h('p', { style: hintStyle }, '可以在这里修正身份、性别、称呼和转述关系。关闭后草稿仍保留；只有“保存并启用”才会采用。'),
              // The generated name is a suggestion, not a decision: the user
              // names their own presets.
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
                h('span', { style: labelStyle }, '名称'),
                h('input', {
                  style: { ...inputStyle, flex: 1 },
                  value: generatedName,
                  disabled: presetBusy || generating,
                  'aria-label': '新预设名称', placeholder: '给这个预设起个名字',
                  onChange: (event) => setGeneratedName(event.target.value),
                }),
              ),
              h('label', { style: fieldStyle }, h('span', { style: labelStyle }, '身份摘要（可修正）'),
                h('textarea', { style: { ...inputStyle, minHeight: '74px', resize: 'vertical' }, 'aria-label': '生成身份摘要',
                  value: generated.identity ?? '', disabled: presetBusy || generating, onChange: event => editGenerated(null, 'identity', event.target.value) })),
              h('label',{style:fieldStyle},h('span',{style:labelStyle},'人格性别（聊天室）'),
                h('select',{style:inputStyle,'aria-label':'生成人格性别（聊天室）',value:generated.chat?.gender??'unset',disabled:presetBusy||generating,
                  onChange:event=>editGenerated('chat','gender',event.target.value)},
                  h('option',{value:'unset'},'不指定'),h('option',{value:'female'},'女性'),h('option',{value:'male'},'男性'),h('option',{value:'none'},'无性别（如明确无性别的智能助手）'))),
              h('p', { style: hintStyle }, '不指定表示不作判断；无性别是明确设定，并非所有 AI 都无性别。男娘、假小子是表达风格，不能从气质、衣着或外形推定性别；请按原设或自行选择。'),
              h('label', { style: fieldStyle }, h('span', { style: labelStyle }, '发言关系'),
                h('select', { style: inputStyle, 'aria-label': '生成发言关系', value: generated.narration?.mode ?? 'voice', disabled: presetBusy || generating,
                  onChange: event => editGenerated('narration', 'mode', event.target.value) }, h('option', { value: 'voice' }, '用角色口吻重述'), h('option', { value: 'relay' }, '转达另一位助手的工作'))),
              ...[['narration','assistant','原助手称呼'],['address','user','用户称呼'],['address','subagent','子代理称呼']].map(([section,key,label]) =>
                h('label', { key: label, style: fieldStyle }, h('span', { style: labelStyle }, label), h('input', { style: inputStyle, maxLength: 20,
                  'aria-label': '生成'+label, value: generated[section]?.[key] ?? '', disabled: presetBusy || generating,
                  onChange: event => editGenerated(section, key, event.target.value) }))),
              generated.chat ? h('div', { 'aria-label': '生成的聊天表达', style: { marginTop: '8px' } },
                h('div', { style: labelStyle }, '聊天室'),
                h('div', { style: memoryLineStyle }, (generated.chat.voice ?? []).join(' ／ ')),
                h('p', { style: hintStyle }, `日常多轮示例：${generated.chat.dialogueExamples?.length ?? 0}组；工作讨论示例：${generated.chat.workDialogueExamples?.length ?? 0}组。`),
                h('p', { style: hintStyle }, '示例是虚构风格参考，不是实际经历或记忆。'), chatExamplesPreview(generated.chat),
                sourcePreview(generated.chat, generated.identity, generated.voice),
                generated.chat.source ? h('label', { style: toggleRowStyle }, h('input', { type: 'checkbox',
                  'aria-label': '生成预览参考原始人设', checked: chatSourceActive(generated.chat, generated.identity, generated.voice),
                  disabled: generating || presetBusy || !chatSourceCanBind(generated.identity, generated.chat.voice ?? generated.voice ?? []),
                  onChange: event => { const enabled = event.target.checked; setGenerated(current => current?.chat?.source ? ({ ...current, chat: { ...current.chat,
                    source: { ...current.chat.source, enabled, ...(enabled ? { identity: current.identity.trim(), voice: [...(current.chat.voice ?? current.voice ?? [])] } : {}) } } }) : current); } }), '聊天时参考原始人设') : null)
                : h('p', { style: hintStyle }, '本次未生成独立聊天表达，聊天将沿用基础语感；可以补充人设后再生成。'),
              h('div', { style: { ...labelStyle, marginTop: '8px' } }, '工作转述'),
              (generated.voice ?? []).length ? h('div', { style: memoryLineStyle }, `语气：${generated.voice.join(' ／ ')}`) : null,
              (generated.report ?? []).length > 0
                ? h('div', { style: { ...memoryLineStyle, marginTop: '4px' } },
                  `汇报规则：${generated.report.join(' ／ ')}`)
                : null,
              (generated.samples ?? []).length > 0
                ? h('div', { style: { ...memoryLineStyle, marginTop: '4px' } },
                  h('details', null, h('summary', null, '转述示例'), h('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, generated.samples.join('\n\n'))))
                : null,
              generated.avoid?.length ? h('details', { style: { marginTop: '6px' } }, h('summary', null, '表达边界'),
                h('div', { style: { ...memoryLineStyle, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, generated.avoid.join('\n'))) : null,
              h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '8px' } },
                h('button', {
                  type: 'button',
                  style: primaryButtonStyle,
                  disabled: generating || presetBusy || generatedName.trim() === '' || !generated.identity?.trim()
                    || !generated.address?.user?.trim() || !generated.address?.subagent?.trim() || !generated.narration?.assistant?.trim(),
                  onClick: async () => {
                    const result = await presetAction({
                      action: 'save',
                      name: generatedName.trim(),
                      pack: generated,
                      source: generatedSource,
                    });
                    if (result?.ok === true) {
                      setGenerated(undefined);
                      setGeneratedName('');
                      setGeneratedReviewOpen(false);
                      returnFromGeneratedReview(true);
                    }
                  },
                }, '保存并启用'),
                h('button', {
                  type: 'button',
                  style: toggleStyle,
                  disabled: presetBusy || generating,
                  onClick: () => { setGenerated(undefined); setGeneratedReviewOpen(false); setPresetStatus(''); returnFromGeneratedReview(true); },
                }, '丢弃'),
              ),
            ))
            : null,
        );
      const editorControls = h('div', { className: 'dsh-persona-editor-grid' }, h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '身份'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '身份',
            value: draftValue('identity', pack?.identity ?? ''),
            onChange: (event) => setDraft('identity', event.target.value),
            onBlur: (event) => savePackField('identity', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span',{style:labelStyle},'人格性别（聊天室）'),
          h('select',{style:inputStyle,'aria-label':'人格性别（聊天室）',
            value:presets.some(p=>p.id===activePresetId&&p.builtin)?'female':draftValue('chatGender',pack?.chat?.gender??'unset'),
            disabled:presetBusy||presets.some(p=>p.id===activePresetId&&p.builtin),onChange:event=>savePackField('chatGender',event.target.value)},
            h('option',{value:'unset'},'不指定'),h('option',{value:'female'},'女性'),h('option',{value:'male'},'男性'),h('option',{value:'none'},'无性别')),
          h('p',{style:hintStyle},'内置人格保持女性；自定义人格按原设选择。不指定不等于无性别，智能助手也不默认无性别。男娘、假小子是表达风格，不能从气质、衣着或外形判定性别。这里只调整聊天，明确选择优先于旧示例，不自动改写身份文字或转述。')),
        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '汇报里的说话规则（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '76px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '汇报里的说话规则',
            value: draftValue('report', (pack?.report ?? []).join('\n')),
            onChange: (event) => setDraft('report', event.target.value),
            onBlur: (event) => savePackField('report', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '通用语感（每行一条）'),
          h('span', { style: hintStyle }, '有独立聊天表达时，这组语感用于工作转述。'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '76px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '通用语感',
            value: draftValue('voice', (pack?.voice ?? []).join('\n')),
            onChange: (event) => setDraft('voice', event.target.value),
            onBlur: (event) => savePackField('voice', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '语气示例（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '语气示例',
            value: draftValue('samples', (pack?.samples ?? []).join('\n')),
            onChange: (event) => setDraft('samples', event.target.value),
            onBlur: (event) => savePackField('samples', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '避免出现（每行一条）'),
          h('textarea', {
            style: { ...inputStyle, minHeight: '56px', resize: 'vertical' },
            disabled: presetBusy,
            'aria-label': '避免出现',
            value: draftValue('avoid', (pack?.avoid ?? []).join('\n')),
            onChange: (event) => setDraft('avoid', event.target.value),
            onBlur: (event) => savePackField('avoid', event.target.value),
          }),
        ),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle, 'aria-label': '独立聊天表达' },
          h('span', { style: labelStyle }, '聊天室语气'),
          pack?.chat || Object.hasOwn(packDrafts, 'chatVoice') ? h(React.Fragment, null,
            h('textarea', { style: { ...inputStyle, minHeight: '90px', resize: 'vertical' }, disabled: presetBusy,
              'aria-label': '聊天室语气', value: draftValue('chatVoice', (pack.chat?.voice ?? pack.voice ?? []).join('\n')),
              onChange: event => setDraft('chatVoice', event.target.value), onBlur: event => savePackField('chatVoice', event.target.value) }),
            chatExamplesPreview(pack.chat),
            sourcePreview(pack.chat, pack.identity, pack.voice),
            pack.chat?.source ? h(React.Fragment, null,
              h('label', { style: toggleRowStyle }, h('input', { type: 'checkbox', 'aria-label': '聊天室参考原始人设',
                checked: chatSourceActive(pack.chat, pack.identity, pack.voice), disabled: presetBusy || Object.hasOwn(packDrafts, 'chatReset')
                  || !chatSourceCanBind(pack.identity, pack.chat.voice ?? pack.voice ?? []),
                onChange: event => savePackField('chatSource', event.target.checked ? 'use' : 'skip') }), '聊天时参考原始人设'),
              pack.chat.source.enabled && !chatSourceActive(pack.chat, pack.identity, pack.voice)
                ? h('button', { type: 'button', style: toggleStyle, disabled: presetBusy || Object.hasOwn(packDrafts, 'chatReset'),
                  onClick: () => savePackField('chatSource', 'skip') }, '停用这份原始参考') : null,
              h('p', { style: hintStyle }, '修改身份或聊天室语气会暂停旧参考；重新勾选时，按当前已保存的身份和语气启用。原文保留，可随时查看。')) : null,
            pack.chat?.source && !chatSourceCanBind(pack.identity, pack.chat.voice ?? pack.voice ?? [])
              ? h('p', { style: hintStyle }, '重新启用需要身份摘要在4000字内、有效聊天语气最多8条且每条400字；请调整后再启用，原始材料仍保留。') : null,
            h('p', { style: hintStyle }, '这里单独用于聊天，不改变转述语气。最多8条，每条400字。恢复基础表达会移除独立语气、示例和原始参考。'),
            h('button', { type: 'button', style: toggleStyle, disabled: presetBusy,
              onClick: () => savePackField('chatReset', 'inherit') }, '恢复基础表达并清除聊天示例'))
            : h(React.Fragment, null, h('span', { style: hintStyle }, '尚未单独设置；自定义人格沿用基础语感，内置人格使用自己的聊天材料。'),
              h('button', { type: 'button', style: toggleStyle, disabled: presetBusy,
                onClick: () => savePackField('chatVoice', (pack?.voice ?? []).join('\n')) }, '从基础语感设置聊天表达'))),

        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '子代理称呼'),
          h('input', {
            style: inputStyle,
            disabled: presetBusy,
            'aria-label': '子代理称呼',
            value: draftValue('subagent', pack?.address?.subagent ?? ''),
            onChange: (event) => setDraft('subagent', event.target.value),
            onBlur: (event) => savePackField('subagent', event.target.value),
          }),
        ),
        h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
          h('span', { style: labelStyle }, '发言关系'),
          h('select', { style: inputStyle, disabled: presetBusy, 'aria-label': '发言关系',
            value: draftValue('narrationMode', pack?.narration?.mode ?? 'voice'),
            onChange: (e) => savePackField('narrationMode', e.target.value) },
            h('option', { value: 'voice' }, '用角色口吻重述'), h('option', { value: 'relay' }, '转达另一位助手的工作')),
          h('span', { style: hintStyle }, '小肥鱼（实验性）使用转达模式；切换角色不会改变实际工作的助手。')),
        (draftValue('narrationMode', pack?.narration?.mode ?? 'voice') === 'relay')
          ? h('div', { className: 'dsh-persona-editor-field', style: fieldStyle },
            h('label',null,h('input',{type:'checkbox',disabled:presetBusy,checked:draftValue('selfReference',pack?.narration?.selfReference)==='none',
              onChange:e=>savePackField('selfReference',e.target.checked?'none':'natural')}),'严格转述：引语外避免“我”“我们”“咱们”等自称'),
            draftValue('selfReference',pack?.narration?.selfReference)==='none'?h('label',null,'其他自称（逗号分隔）',h('input',{style:inputStyle,disabled:presetBusy,
              value:draftValue('selfAliases',(pack?.narration?.selfAliases??[]).join('，')),onChange:e=>setDraft('selfAliases',e.target.value),onBlur:e=>savePackField('selfAliases',e.target.value)})):null,
            h('span', { style: labelStyle }, '称呼原助手为'),
            h('input', { style: inputStyle, disabled: presetBusy, maxLength: 20, 'aria-label': '原助手称呼',
              value: draftValue('narrationAssistant', pack?.narration?.assistant ?? '原助手'),
              onChange: (e) => setDraft('narrationAssistant', e.target.value),
              onBlur: (e) => savePackField('narrationAssistant', e.target.value) })) : null);
