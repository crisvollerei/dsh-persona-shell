    function ConversationPanel({ sessionId, conversation, onClose }) {
      const [data, setData] = React.useState(conversation);
      const [draft, setDraft] = React.useState(() => conversationDrafts.get(sessionId) ?? null);
      const [target, setTarget] = React.useState('');
      const [summary,setSummary]=React.useState(''), [choices,setChoices]=React.useState([]), [selected,setSelected]=React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const [message, setMessage] = React.useState('');
      const accept = (next, request) => {
        if (!acceptInstance(next, request)) return false;
        setData((old) => {
          if (!old || old.instanceId !== next.instanceId) return next;
          if (Number.isSafeInteger(old.stateRev) && Number.isSafeInteger(next.stateRev)) {
            return next.stateRev >= old.stateRev ? next : old;
          }
          return next.revision >= old.revision ? next : old;
        });
        return true;
      };
      React.useEffect(() => { if (conversation) accept(conversation, ++requestSequence); }, [conversation]);
      React.useEffect(() => {
        let stopped = false;
        const request = ++requestSequence;
        actionRequest(`conversation?session=${encodeURIComponent(sessionId)}`).then(({ ok, value }) => {
          if (!stopped) { if (ok) accept(value, request); else setMessage(actionError(value.error)); }
        }).catch(() => { if (!stopped) setMessage('暂时无法读取会话设置，请关闭后重试。'); });
        return () => { stopped = true; };
      }, [sessionId]);
      const choice = draft ?? { personaId: data?.personaId ?? null, trigger: data?.trigger ?? 'inherit' };
      const edit = (patch) => { const next = { ...choice, ...patch }; setDraft(next); keepDraft(conversationDrafts, sessionId, next); };
      const write = async (body) => {
        if (busyRef.current || !data) return;
        busyRef.current = true; setBusy(true); setMessage('正在保存…');
        const request = ++requestSequence;
        try {
          const { ok, value } = await actionRequest('conversation', { sessionId, revision: data.revision, ...body });
          if (!ok) { if (value.conversation) accept(value.conversation, request); setMessage(actionError(value.error)); return; }
          if (!accept(value, request)) { setMessage('插件状态已更新，请核对当前会话后重试。输入已经保留。'); return; }
          if (body.action==='relay') {setSummary('');setSelected([]);}
          if (body.action === 'select' && conversationDrafts.get(sessionId) === draft) {
            conversationDrafts.delete(sessionId); setDraft(null);
          }
          setMessage(body.action === 'relay' ? '已安排，下一份符合范围的原始汇报到达后接手。'
            : body.action === 'cancel' ? '已取消等待中的接力。' : '已保存，从后续汇报开始生效。');
          void refresh(sessionId);
        } catch { setMessage(actionError()); }
        finally { busyRef.current = false; setBusy(false); }
      };
      const presets = data?.presets ?? [];
      const relay = data?.relay;
      const name = (id) => presets.find((p) => p.id === id)?.name ?? '已删除的人格';
      const disabled = busy || !data?.ready;
      return h(ActionDialog, { title: '当前会话的人格', onClose },
        h('p', { className: 'dsh-persona-action-note' }, '只影响这个会话的后续转述。其他会话和历史署名保持各自的选择。'),
        data ? h('div', null,
          h('div', { className: 'dsh-persona-action-box' }, `正在使用：${data.effectivePersonaName}`,
            data.missingPersona ? h('p', { className: 'dsh-persona-action-note' }, '原先选择的人格已被删除，当前使用全局默认。') : null),
          data.relayError ? h('p', { role: 'status', className: 'dsh-persona-action-note' }, data.relayError) : null,
          h('label', null, '会话人格', h('select', { 'aria-label': '会话人格', value: choice.personaId ?? '', disabled,
            onChange: (e) => edit({ personaId: e.target.value || null }) }, h('option', { value: '' }, '跟随全局默认'),
            choice.personaId && !presets.some((p) => p.id === choice.personaId)
              ? h('option', { value: choice.personaId, disabled: true }, '已删除的人格，请重新选择') : null,
            presets.map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
          h('label', null, '转述范围', h('select', { 'aria-label': '会话转述范围', value: choice.trigger, disabled,
            onChange: (e) => edit({ trigger: e.target.value }) },
            h('option', { value: 'inherit' }, '跟随全局设置'), h('option', { value: 'step' }, '全部汇报'),
            h('option', { value: 'report' }, '仅最终汇报'))),
          h('div', { className: 'dsh-persona-action-buttons' },
            h('button', { type: 'button', disabled: disabled || (!!choice.personaId && !presets.some((p) => p.id === choice.personaId)),
              'data-primary': '', onClick: () => write({ action: 'select', ...choice }) }, '保存会话选择'),
            draft ? h('button', { type: 'button', disabled: busy, onClick: () => { setDraft(null); conversationDrafts.delete(sessionId); setMessage('已放弃未提交的选择。'); } }, '放弃修改') : null),
          h('details', { style: { marginTop: '22px' } }, h('summary', { style: { cursor: 'pointer' } },
            relay?.status === 'pending' ? `等待${name(relay.toPersonaId)}接手 · 查看接力` : '交给另一位角色'),
            h('p', { className: 'dsh-persona-action-note' }, '从下一份原始汇报接手，不重写对方的改写稿，也不接管底层工作。仅共享偏好与适用的会话偏好会继续参考。'),
            relay ? h('div', { className: 'dsh-persona-action-box', role: 'status' },
              `${relay.status === 'pending' ? '等待接手' : relay.status === 'active' ? '上次接力已接手' : '上次接力已取消'}：${name(relay.toPersonaId)}`,
              relay.status === 'pending' ? h('div', { className: 'dsh-persona-action-buttons' },
                h('button', { type: 'button', disabled, onClick: () => write({ action: 'cancel', relayId: relay.id }) }, '取消接力')) : null) : null,
            h('label', null, '接手角色', h('select', { 'aria-label': '接手角色', disabled: disabled || relay?.status === 'pending',
              value: relay?.status === 'pending' ? relay.toPersonaId : target, onChange: (e) => setTarget(e.target.value) }, h('option', { value: '' }, '选择一位角色'),
              presets.filter((p) => p.id !== data.effectivePersonaId).map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
            relay?.status!=='pending'?h('details',{onToggle:async e=>{if(e.target!==e.currentTarget || !e.currentTarget.open)return;
              try{const {ok,value}=await actionRequest('memory/handoffs?session='+encodeURIComponent(sessionId)+'&persona='+encodeURIComponent(data.effectivePersonaId));
                if(!ok)throw Error();setChoices(value.choices??[]);if(!value.enabled)setMessage('使用交接卡需要先开启记忆。');}catch{setMessage('读取交接记忆失败。');}}},
              h('summary',null,'附上交接卡'),h('label',null,'交接说明',h('textarea',{value:summary,maxLength:240,onChange:e=>setSummary(e.target.value)})),
              ...choices.map(c=>h('label',{key:c.id},h('input',{type:'checkbox',checked:selected.includes(c.id),disabled:!selected.includes(c.id)&&selected.length>=10,
                onChange:e=>setSelected(e.target.checked?[...selected,c.id]:selected.filter(id=>id!==c.id))}),c.content))):null,
            h('button', { type: 'button', disabled: disabled || !target || relay?.status === 'pending' || !!draft || (selected.length>0 && !summary.trim()),
              onClick: () => write({ action: 'relay', toPersonaId: target, ...(summary.trim()?{handoff:{summary:summary.trim(),memoryIds:selected}}:{}) }) }, '安排下一份汇报接力'),
            draft ? h('p', { className: 'dsh-persona-action-note' }, '请先保存或放弃上面的会话选择，再安排接力。') : null))
          : h('p', null, '正在读取…'),
        h('p', { role: 'status', 'aria-live': 'polite', className: 'dsh-persona-action-note' }, message || (!data?.ready ? '正在等待保存服务就绪…' : '修改后点击保存。')));
    }

    function ReportFeedback({ sessionId, row, onClose, showResult = false }) {
      const key = rowKey(sessionId, row.seq);
      const [target,setTarget]=React.useState(()=>({sessionId,seq:row.seq,version:row.version,sourceHash:row.sourceHash,personaId:row.speaker?.id,name:row.speaker?.name??'原汇报人格'}));
      const [acceptedVersion,setAcceptedVersion]=React.useState(null);
      const [draft, setDraft] = React.useState(() => {
        const existing = feedbackDrafts.get(key);
        if (existing?.scope === 'once') return existing;
        const next = { content: existing?.content ?? '', scope: 'once',thinking:true };
        if (existing) keepDraft(feedbackDrafts, key, next);
        return next;
      });
      const [busy, setBusy] = React.useState(false);
      const busyRef = React.useRef(false);
      const input=React.useRef(null);
      const [message, setMessage] = React.useState('');
      const edit = (patch) => { const next = { ...draft, ...patch }; setDraft(next); keepDraft(feedbackDrafts, key, next); };
      const identityChanged=sessionId!==target.sessionId||row.seq!==target.seq||row.speaker?.id!==target.personaId||row.sourceHash!==target.sourceHash;
      const awaitingOwnUpdate=!identityChanged&&acceptedVersion===target.version&&row.version<target.version;
      const stale=identityChanged||(row.version!==target.version&&!awaitingOwnUpdate);
      const unavailable=!row.canRetry||!target.personaId;
      const quickChoices=[['短一点','这次短一点，保留结论、必要条件和风险。'],['先说结论','先说结论，再按需要补充依据。'],
        ['少些调侃','少些调侃，直接说明结果和需要注意的事。'],['更正式','表达更正式一些，保留事实与不确定性。']];
      const choose=text=>{
        const old=draft.content.trim(),content=!old||quickChoices.some(([,value])=>value===old)?text:old.includes(text)?old:old+'\n'+text;
        if(content.length>240){setMessage('输入已接近上限，请先精简一些，再添加这项要求。');return;}
        edit({content});setMessage('已填入要求，可修改后再重新转述。');input.current?.focus({preventScroll:true});
      };
      const submit = async () => {
        if (busyRef.current || row.retrying || unavailable || stale || awaitingOwnUpdate || !draft.content.trim() || draft.content.length>240) return;
        busyRef.current = true; setBusy(true); setMessage('正在调整，当前正文会保留到新版本完成…');
        try {
          const { ok, value } = await actionRequest('feedback', { sessionId:target.sessionId, seq: target.seq, version: target.version,
            personaId: target.personaId, ...(target.sourceHash?{sourceHash:target.sourceHash}:{}), content: draft.content, scope: 'once',thinking:draft.thinking!==false });
          if (!ok) { setMessage(actionError(value.error)); void refresh(sessionId); return; }
          if (feedbackDrafts.get(key) === draft) {
            feedbackDrafts.delete(key); setDraft({ content: '', scope: 'once',thinking:draft.thinking!==false });
          }
          if(Number.isSafeInteger(value.version)&&value.version===target.version+1&&value.personaId===target.personaId){
            setTarget({...target,version:value.version});setAcceptedVersion(value.version);
          }
          setMessage(showResult?'已按这次偏好重新转述，可在下方查看。':'已按这次偏好重新转述。'); void refresh(sessionId);
        } catch { setMessage(actionError()); }
        finally { busyRef.current = false; setBusy(false); }
      };
      return h(ActionDialog, { title: '调整这份汇报的表达', onClose },
        h('p', { className: 'dsh-persona-action-note' }, `对应人格：${target.name}。只调整措辞，事实、条件和风险仍以原文为准。`),
        h('div',{className:'dsh-persona-action-buttons',role:'group','aria-label':'常用表达要求',style:{marginTop:10}},
          ...quickChoices.map(([name,text])=>h('button',{key:name,type:'button',disabled:busy||row.retrying,
            'aria-pressed':draft.content.trim()===text,title:'只填入要求，确认后再重新转述',onClick:()=>choose(text)},name))),
        h('label', null, '希望怎么说', h('textarea', { ref:input,'aria-label': '表达反馈','aria-describedby':'dsh-persona-feedback-limit', maxLength: 240,
          disabled: busy || row.retrying, value: draft.content, placeholder: '例如：少一点调侃，先说结论，再解释原因。',
          onChange: (e) => edit({ content: e.target.value }) })),
        h('p',{id:'dsh-persona-feedback-limit',className:'dsh-persona-action-note'},draft.content.length+' / 240 字符'),
        h('label',{style:{display:'flex',alignItems:'center',gap:7}},h('input',{type:'checkbox','aria-label':'本次调整开启思考',checked:draft.thinking!==false,disabled:busy||row.retrying||unavailable||stale||awaitingOwnUpdate,onChange:e=>edit({thinking:e.target.checked})}),'本次调整开启思考'),
        h('p', { className: 'dsh-persona-action-note' }, '仅调整这份汇报，不改变人格开关；开关关闭时主消息保留原文，结果在本弹窗查看。长期偏好与记忆请在插件设置中管理。'),
        stale?h('p',{className:'dsh-persona-action-note',role:'status'},'这份汇报的会话、版本或说话者已变化。输入已保留，请关闭后重新打开，核对目标再调整。')
          :unavailable?h('p',{className:'dsh-persona-action-note',role:'status'},actionError(row.retryUnavailableReason??(!target.personaId?'persona-not-found':'source-unavailable'))):null,
        h('div', { className: 'dsh-persona-action-buttons' },
          h('button', { type: 'button', 'data-primary': '', disabled: busy || row.retrying || !draft.content.trim() || draft.content.length>240 || unavailable || stale || awaitingOwnUpdate,
            onClick: submit }, busy || row.retrying ? '处理中…' : '重新转述'),
          h('button', { type: 'button', disabled: busy, onClick: () => { edit({ content: '' }); setMessage('已清空输入。'); } }, '清空输入')),
        h('p', { role: 'status', 'aria-live': 'polite', className: 'dsh-persona-action-note' }, message || '关闭后保留未提交的输入。'),
        showResult&&!stale&&row.status==='ready'&&row.text?h('section',{'aria-label':'表达结果'},
          h('h3',null,acceptedVersion===row.version?'本次调整结果':'当前表达'),renderMarkdown(row.text),
          h('button',{type:'button',onClick:async()=>{try{await navigator.clipboard.writeText(row.text);setMessage('已复制本次调整结果。');}catch{setMessage('暂时无法复制，请选中结果复制。');}}},'复制调整结果')):null);
    }

    /**
     * Whether a value is usable as a session id.
     *
     * A literal `"undefined"` or `"null"` passes a plain `typeof` check and then
     * silently fetches nothing: the host answers `rows: []` for an unknown
     * session, so every row falls back to the plain report and the whole persona
     * view disappears with no error anywhere. Rejecting those values turns a
     * silent blank into a visible one.
     * @param {unknown} value
     */
    function usableSessionId(value) {
      if (typeof value !== 'string' || value === '') return false;
      if (value === 'undefined' || value === 'null') return false;
      return true;
    }

    function useHostState(sessionId, seq) {
      const [version, setVersion] = React.useState(0);
      React.useEffect(() => {
        const listener = () => setVersion((value) => value + 1);
        listeners.add(listener);
        const stop = usableSessionId(sessionId) && typeof seq === 'number' ? watch(sessionId, seq) : () => {};
        if (!usableSessionId(sessionId)) {
          // Report once per page: this is the difference between "the plugin is
          // off" and "the plugin cannot see the session", and they look identical.
          reportDiagnostics({ sessionId: String(sessionId), sessionIdUsable: false });
        }
        return () => {
          listeners.delete(listener);
          stop();
        };
      }, [sessionId, seq]);
      return { state: states.get(sessionId), version };
    }

    // --- text rendering ------------------------------------------------------

    /**
     * The shipped markdown renderer, resolved from the shell's module table.
     *
     * `@deepseek-ai/dsh-client-ui-primitives` is part of the frozen
     * `PLATFORM_MODULES` baseline the shell seeds before any plugin runs: the
     * shipped chat package resolves it exactly this way and declares no
     * `dsh.client.external` entry for it. Reusing it means the persona view runs
     * the host's real renderer — same parser, same Shiki highlighting, same
     * KaTeX, same tables — instead of a look-alike.
     *
     * Isolated previews and role-chat bubbles use this helper; the transcript uses the full
     * official assistant adapter below. Missing primitives get plain text,
     * never an imitation Markdown implementation.
     */
    /**
     * @typedef {object} MarkdownRenderer
     * @property {(props: object) => unknown} component - renderer for one markdown document.
     */

    /**
     * Resolve the shipped markdown renderer from the shell's module table.
     *
     * `MarkdownText` is `React.memo(...)`, so its runtime value is an exotic
     * object, **not** a function: a `typeof === 'function'` check rejects the
     * very thing it is looking for. What matters for rendering is that React can
     * treat the value as an element type, which is true for memo and forwardRef
     * objects alike, so the check asks for something callable *or* one of those
     * wrapper shapes.
     * @param {unknown} value
     * @returns {boolean}
     */
    function isElementType(value) {
      if (typeof value === 'function') return true;
      if (value === null || typeof value !== 'object') return false;
      // React.memo({$$typeof: Symbol(react.memo), type}) and forwardRef both
      // carry a $$typeof marker; either one is a valid element type.
      return typeof value.$$typeof === 'symbol';
    }

    /**
     * Whether the shipped renderer resolved. Mirrored locally so the settings
     * page can warn without a round trip: the degradation is visible in the
     * transcript, but the reason belongs next to the controls that cause it.
     */
    let shippedRendererOk = true;

    function shippedMarkdownText() {
      if (markdownResolved) return markdownComponent;
      markdownResolved = true;
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
        const candidate = primitives?.MarkdownText;
        markdownComponent = isElementType(candidate) ? candidate : undefined;
        shippedRendererOk = markdownComponent !== undefined;
        reportDiagnostics({
          ...describePrimitives(primitives, candidate),
          accepted: markdownComponent !== undefined,
        });
      } catch (error) {
        markdownComponent = undefined;
        shippedRendererOk = false;
        reportDiagnostics({
          shippedMarkdown: 'unresolvable',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return markdownComponent;
    }

    /**
     * Describe what the module table actually handed over.
     *
     * A bare "not a function" is not enough to act on: the value could be a
     * namespace without the key, a lazy proxy, or a module object that needs a
     * different access path. Reporting the shape once per page turns guesswork
     * into a fact.
     * @param {unknown} primitives
     * @param {unknown} component
     * @returns {Record<string, unknown>}
     */
    function describePrimitives(primitives, component) {
      const accepted = isElementType(component);
      const report = {
        shippedMarkdown: accepted ? 'ok' : 'missing',
        reason: accepted ? '' : `MarkdownText is ${component === null ? 'null' : typeof component}`,
        componentType: component === null ? 'null' : typeof component,
        moduleType: typeof primitives,
      };
      try {
        if (primitives !== null && typeof primitives === 'object') {
          const keys = Object.keys(primitives);
          report.keyCount = keys.length;
          report.markdownKeys = keys.filter((key) => /mark/i.test(key)).slice(0, 12);
          report.hasDefault = 'default' in primitives;
        }
      } catch (error) {
        report.shapeError = error instanceof Error ? error.message : String(error);
      }
      return report;
    }

    /**
     * Tell the host half whether the shipped renderer resolved in this page.
     *
     * There is no way to see a page's module table from the outside, and a
     * silent fallback is indistinguishable from a working one. Reporting it once
     * per page turns "did it work?" into a queryable fact.
     * @param {{ shippedMarkdown: string, reason: string }} payload
     */
    function reportDiagnostics(payload) {
      try {
        void fetch(`${ROUTE}/diagnostics`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Every report carries the build id. The page cannot be force-reloaded
          // in the desktop client, so "is the running code the installed code?"
          // is otherwise unanswerable — and a stale bundle silently invalidates
          // every fix made since the last restart.
          body: JSON.stringify({ clientBuild: CLIENT_BUILD, ...payload }),
        }).catch(() => {});
      } catch {
        // Diagnostics must never interfere with rendering.
      }
    }

    let markdownResolved = false;
    let markdownComponent;

    /** Labels the shipped renderer shows on code blocks and footnote sections. */
    const MARKDOWN_LABELS = {
      code: {
        copyLabel: '复制',
        copiedLabel: '已复制',
        toolbarLabels: {
          codeLabel: '代码',
          wrapLabel: '自动换行',
          unwrapLabel: '取消换行',
        },
      },
      footnotes: '脚注',
    };

    /**
     * Last-resort body when the shipped renderer cannot be resolved.
     *
     * Intentionally obvious: plain preformatted text with no attempt to look
     * like markdown. A fake markdown renderer would hide its own gaps (no
     * highlighting, no KaTeX, no footnotes) behind a plausible appearance, so
     * the reader would keep using a broken view for months. This cannot be
     * mistaken for correct, and the settings page raises a warning alongside it.
     */
    const PLAIN_FALLBACK_STYLE = {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      font: 'var(--dsw-font-markdown-base, inherit)',
      margin: '16px 0',
    };

    /**
     * Render one block of markdown through the shipped renderer.
     *
     * There is deliberately no local re-implementation behind this. A copy of
     * the shipped renderer never keeps up with the original, and "looks nearly
     * right but silently lacks highlighting, KaTeX and footnotes" is a worse
     * outcome than an obviously degraded one: the first hides the problem for
     * months, the second gets reported immediately.
     *
     * If the module table ever stops carrying `MarkdownText`, the preview degrades
     * to plain preformatted text — visibly wrong, cheap to maintain — and the
     * settings page shows a warning. Fidelity is the shipped component's job.
     * @param {string} text
     * @returns {any}
     */
    // Match the published AssistantMarkdown/ChatView file-image rules. The existing
    // authenticated Host route owns file access; this is only a display URL.
    function reportFileMediaUrl(base,path) {
      if(typeof path!=='string'||(!/^https?:/u.test(base)&&!base.startsWith('dsh-app://app/'))
        ||!(/^[A-Za-z]:[/\\]/u.test(path)||path.startsWith('/'))||/^[/\\]{2}/u.test(path)||/[\u0000-\u001f\u007f]/u.test(path))return undefined;
      return new URL('api/file?path='+encodeURIComponent(path),base).href;
    }
    function reportMarkdownMedia(owner,source) {
      const base=document.baseURI,cwd=typeof owner?.cwd==='string'?owner.cwd:'';
      const fileImages={resolve:path=>{
        const absolute=path.startsWith('/')||/^[A-Za-z]:[/\\]/u.test(path)||path.startsWith('\\\\');
        const separator=(/^[A-Za-z]:[/\\]/u.test(cwd)||cwd.startsWith('\\\\'))&&cwd.includes('\\')?'\\':'/';
        return reportFileMediaUrl(base,absolute||!cwd?path:cwd.replace(/[/\\]+$/u,'')+separator+path.replace(/^[/\\]+/u,''));
      },labels:{open:'打开图片',loading:'正在加载图片…',failed:'图片加载失败',dialog:'报告图片预览',close:'关闭'}};
      // Definition-only source blocks supply the document vocabulary to split readable
      // passages. Leave mixed/ambiguous Markdown to the complete original document.
      const definitions=(source?.blocks??[]).filter(block=>block.kind!=='code'
        &&/^(?: {0,3}\[(?!\^)[^\]\n]+\]:[^\n]+(?:\n[ \t]+["'(][^\n]*["')][ \t]*)?)(?:\n {0,3}\[(?!\^)[^\]\n]+\]:[^\n]+(?:\n[ \t]+["'(][^\n]*["')][ \t]*)?)*[ \t]*$/u.test(block.text.trimEnd()))
        .map(block=>block.text).join('\n');
      return {fileImages,definitions,openFile:owner?.openFile,pathImages:{resolve:value=>{
        try{return reportFileMediaUrl(base,decodeURIComponent(value.split(/[?#]/u)[0]??''));}catch{return undefined;}
      }}};
    }
    function renderMarkdown(text, streaming = false, plainStyle, media, references = false) {
      const MarkdownText = shippedMarkdownText();
      if (MarkdownText !== undefined) {
        const body=h(MarkdownText, { text:references&&media?.definitions?text+'\n\n'+media.definitions:text, streaming, labels: MARKDOWN_LABELS, ...(media?{pathImages:media.pathImages}:{}) });
        if(media){
          const Provider=require('@deepseek-ai/dsh-client-ui-primitives').MarkdownDelegateProvider;
          if(isElementType(Provider))return h(Provider,{fileImages:media.fileImages,openFile:media.openFile},body);
        }
        return body;
      }
      return h('div', { style: plainStyle ? { ...PLAIN_FALLBACK_STYLE, ...plainStyle } : PLAIN_FALLBACK_STYLE }, text);
    }

    // --- official assistant adapter -----------------------------------------

    const CHAT_SLOT = 'conversation.chat.node';
    const CHILD_FACTORIES = {
      'conversation.chat.reasoning.body': 'conversation.chat.reasoning.content',
      'conversation.chat.message.images': 'conversation.images.content',
    };
    let chatRendererState = { status: 'disabled', reason: '' };
    const rendererListeners = new Set();

    function setChatRendererState(status, reason = '') {
      if (chatRendererState.status === status && chatRendererState.reason === reason) return;
      chatRendererState = { status, reason };
      reportDiagnostics({ chatRenderer: status, chatRendererReason: reason });
      for (const listener of rendererListeners) listener();
    }

    function componentName(component) {
      return typeof component === 'function' ? component.name : component?.type?.name;
    }

    /** Read-only inspection; an unknown host/extension keeps its own renderer. */
    function resolveChatDelegate(slots, ownComponent) {
      const reject = (reason) => ({ ok: false, reason });
      if (['entries', 'entriesOfSlot', 'subscribe', 'snapshot', 'onEntryError'].some((key) => typeof slots?.[key] !== 'function')) {
        return reject('registry-api-unavailable');
      }
      const entries = slots.entries(CHAT_SLOT).filter((entry) => entry.options?.key === 'assistant-step'
        && entry.component !== ownComponent);
      if (entries.length !== 1) return reject(entries.length === 0 ? 'official-assistant-missing' : 'assistant-slot-conflict');
      const entry = entries[0];
      // `registrant` is a Cordis display name (often an ancestor's name), not
      // a package id. Check the supported contract, not diagnostic provenance.
      if (componentName(entry.component) !== 'AssistantNodeView' || (entry.options.priority ?? 0) !== 0
        || !isElementType(entry.component) || entry.locale !== 'chat' || typeof entry.inject !== 'function'
        || entry.store !== undefined || entry.select !== undefined) return reject('unsupported-assistant-contract');
      const childKeys = Object.keys(entry.children ?? {});
      if (childKeys.length !== 2 || childKeys.some((key) => !Object.hasOwn(CHILD_FACTORIES, key)
        || entry.children[key]?.kind !== 'single' || entry.children[key]?.scope !== 'session'
        || Object.keys(entry.children[key]).some((field) => field !== 'kind' && field !== 'scope'))) {
        return reject('unsupported-assistant-children');
      }
      const children = [];
      for (const key of childKeys) {
        const expectedName = key.endsWith('.images') ? 'MessageImages' : 'DefaultReasoningBody';
        const candidates = slots.entries(key);
        const winners = slots.entriesOfSlot(key);
        const child = winners[0];
        if (candidates.length !== 1 || winners.length !== 1 || child !== candidates[0]
          || child.options?.priority !== 100
          || componentName(child.component) !== expectedName
          || child.inject !== undefined || child.children !== undefined || child.store !== undefined
          || child.locale !== undefined || child.select !== undefined) return reject('child-slot-conflict');
        const factory = slots.snapshot(`factory:${CHILD_FACTORIES[key]}`)[0];
        if (factory?.type !== 'factory' || factory.name !== CHILD_FACTORIES[key]
          || factory.scope !== 'root' || factory.registrant !== child.registrant
          || factory.children?.length > 0) return reject('official-factory-unavailable');
        children.push(child);
      }
      return { ok: true, entry, children };
    }

    /** Only a display copy changes; the durable finalNode and other blocks stay shared. */
    function displayNode(node, text) {
      if (typeof text !== 'string' || node?.data?.status !== 'settled') return node;
      const blocks = node.data.blocks;
      const content=Array.isArray(blocks)?blocks.filter(block=>block?.kind==='text' && typeof block.text==='string' && block.text.trim()):[];
      if (content.length!==1 || content[0].text===text) return node;
      return { ...node, data: { ...node.data, blocks: blocks.map(block => block===content[0] ? { ...block, text } : block) } };
    }

    const childRendererCache = new WeakMap();
    const childAnchorStyle = { display: 'contents' };

    /** Equivalent to the two official default adapters, without claiming their children. */
    function renderOfficial(delegate, props, node = props.node) {
      if (typeof props.renderFactorySlot !== 'function') throw new Error('persona-shell: Factory renderer unavailable');
      let renderSlot = childRendererCache.get(props.renderFactorySlot);
      if (renderSlot === undefined) {
        const renderFactorySlot = props.renderFactorySlot;
        renderSlot = (key, owner) => {
          if (!Object.hasOwn(CHILD_FACTORIES, key)) throw new Error('persona-shell: unsupported official child');
          // Preserve the default outlet's addressable, layout-neutral anchor;
          // themes may select it even though we cannot borrow its authorization.
          return h('div', { 'data-slot': key, style: childAnchorStyle }, renderFactorySlot(CHILD_FACTORIES[key], owner));
        };
        childRendererCache.set(renderFactorySlot, renderSlot);
      }
      return h(delegate.entry.component, { ...props, node, renderSlot });
    }

    /** Chat owns its own locale seat; missing shell copy must not display a key. */
    function shellTranslate(t) {
      return (key) => {
        const value = t?.(key);
        return typeof value === 'string' && value !== key && !value.endsWith(`.${key}`) ? value : undefined;
      };
    }

    // --- components ----------------------------------------------------------

    const headerStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginBottom: '4px',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '1.4',
    };
    const badgeStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 6px',
      borderRadius: '4px',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '11px',
    };
    const toggleStyle = {
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-brand-primary)',
      cursor: 'pointer',
      font: 'inherit',
      padding: 0,
    };
    const headerButtonStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      height: '24px', padding: '0 8px', margin: 0, borderRadius: '999px',
      border: '0.5px solid var(--dsw-alias-border-l2,#d8dce4)',
      background: 'var(--dsw-alias-bg-layer-1,#fff)', color: 'var(--dsw-alias-label-secondary,#525c6b)',
      fontFamily: 'inherit', fontSize: '12px', fontWeight: 400, lineHeight: 1, whiteSpace: 'nowrap', cursor: 'pointer',
    };
    const paneLabelStyle = {
      marginBottom: '4px',
      fontSize: '11px',
      lineHeight: '16px',
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      color: 'var(--dsw-alias-label-tertiary)',
    };

    const COMPARISON_NARROW_WIDTH = 720;
    const COMPARISON_CSS = `
      .persona-shell-comparison[role="dialog"] {
        width: min(1100px, 100%); max-width: 100%; min-width: 0;
        height: min(720px, 80vh); height: min(720px, 80dvh);
        max-height: 100%; min-height: 0; padding: 0; gap: 0;
        color: var(--dsw-alias-label-primary);
      }
      .persona-shell-comparison-surface {
        display: flex; flex-direction: column; flex: 1;
        min-width: 0; min-height: 0; overflow: hidden;
        font-size: var(--dsh-content-font-size, 14px); line-height: 1.6;
      }
      .persona-shell-comparison-header {
        display: flex; align-items: center; justify-content: space-between;
        flex: none; gap: 12px; padding: 14px 18px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l1);
      }
      .persona-shell-comparison-header h2 {
        margin: 0; font-size: 16px; font-weight: 500; overflow-wrap: anywhere;
      }
      .persona-shell-comparison button {
        font: inherit; cursor: pointer; border: 0; border-radius: 4px;
        padding: 4px 10px; min-height: 32px;
        color: var(--dsw-alias-label-secondary); background: transparent;
      }
      .persona-shell-comparison button:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .persona-shell-comparison-header button { flex: none; }
      .persona-shell-comparison-tabs { display: flex; flex: none; gap: 4px; padding: 8px 12px; }
      .persona-shell-comparison-tabs button { flex: 1; }
      .persona-shell-comparison-tabs [aria-selected="true"] {
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover);
      }
      .persona-shell-comparison-panes { display: grid; flex: 1; min-width: 0; min-height: 0; }
      .persona-shell-comparison-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
      .persona-shell-comparison-pane + .persona-shell-comparison-pane {
        border-inline-start: 0.5px solid var(--dsw-alias-border-l1);
      }
      .persona-shell-comparison-surface[data-narrow="true"] .persona-shell-comparison-pane { border: 0; }
      .persona-shell-comparison-pane h3 {
        flex: none; margin: 0; padding: 10px 18px; font-size: 12px;
        font-weight: 500; color: var(--dsw-alias-label-secondary);
      }
      .persona-shell-comparison-scroll {
        flex: 1; min-width: 0; min-height: 0; padding: 4px 18px 18px;
        overflow: auto; overscroll-behavior: contain; overflow-wrap: anywhere;
        scrollbar-gutter: stable;
      }
      .persona-shell-comparison-scroll pre { max-width: 100%; overflow: auto; }
      .persona-shell-comparison [hidden] { display: none; }
      .persona-shell-comparison[data-native] {
        box-sizing: border-box; position: fixed; margin: auto;
        width: min(1100px, calc(100vw - 48px));
        max-height: calc(100dvh - 48px); border: 0;
        border-radius: var(--dsw-radius-panel, 12px); overflow: hidden;
        background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent);
      }
      .persona-shell-comparison[data-native][open] { display: flex; flex-direction: column; }
      .persona-shell-comparison[data-native]::backdrop { background: var(--dsw-alias-bg-mask-1); }
      @media (pointer: coarse) { .persona-shell-comparison button { min-height: 44px; min-width: 44px; } }
    `;
    let nextComparisonId = 0;
    let comparisonModal;
    let comparisonModalResolved = false;
    const comparisonScrollLocks = new WeakMap();

    /** The host Modal traps focus, but wheel/page keys can still scroll the page. */
    function lockComparisonScroll(doc) {
      if (!doc.documentElement?.style || !doc.body?.style) return () => {};
      let lock = comparisonScrollLocks.get(doc);
      if (lock === undefined) {
        const root = doc.documentElement;
        const saved = [root, doc.body].map((element) => ({ element,
          overflow: ['overflow-x', 'overflow-y'].map((name) => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]),
        }));
        const gutter = root.style.getPropertyValue('scrollbar-gutter');
        const gutterPriority = root.style.getPropertyPriority('scrollbar-gutter');
        const reserveGutter = doc.defaultView?.innerWidth > root.clientWidth
          && !/\bstable\b/.test(doc.defaultView.getComputedStyle(root).scrollbarGutter);
        if (reserveGutter) root.style.setProperty('scrollbar-gutter', 'stable');
        for (const { element } of saved) element.style.setProperty('overflow', 'hidden');
        lock = { count: 0, restore() {
          for (const { element, overflow } of saved) {
            if (element.style.getPropertyValue('overflow') === 'hidden') {
              element.style.removeProperty('overflow');
              for (const [name, value, priority] of overflow) if (value) element.style.setProperty(name, value, priority);
            }
          }
          if (reserveGutter && root.style.getPropertyValue('scrollbar-gutter') === 'stable') {
            if (gutter) root.style.setProperty('scrollbar-gutter', gutter, gutterPriority);
            else root.style.removeProperty('scrollbar-gutter');
          }
        } };
        comparisonScrollLocks.set(doc, lock);
      }
      lock.count += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--lock.count !== 0) return;
        lock.restore(); comparisonScrollLocks.delete(doc);
      };
    }

    function shippedComparisonModal() {
      if (!comparisonModalResolved) {
        comparisonModalResolved = true;
        try {
          const candidate = require('@deepseek-ai/dsh-client-ui-primitives')?.Modal;
          if (isElementType(candidate)) comparisonModal = candidate;
        } catch { /* Older hosts can still use the browser's modal dialog. */ }
        if (comparisonModal === undefined) reportDiagnostics({ comparisonModal: 'native-fallback' });
      }
      return comparisonModal ?? NativeComparisonModal;
    }

    /** Only used when a host lacks Modal; native top-layer focus/escape semantics. */
    function NativeComparisonModal({ onClose, title, className, children }) {
      const ref = React.useRef(null);
      useLayoutEffect(() => {
        const dialog = ref.current;
        const previous = dialog.ownerDocument.activeElement;
        dialog.showModal();
        return () => {
          dialog.close();
          if (previous?.isConnected) previous.focus({ preventScroll: true });
        };
      }, []);
      return h('dialog', {
        ref, className, role: 'dialog', 'aria-modal': true, 'aria-label': title, 'data-native': '',
        onCancel: (event) => { event.preventDefault(); onClose(); },
        onClick: (event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
        },
      }, children);
    }

    /** Read-only snapshots in a body portal; the live assistant is never moved. */
    function ComparisonDialog({ original, persona, onClose, t }) {
      const [active, setActive] = React.useState('original');
      const [narrow, setNarrow] = React.useState(false);
      const surfaceRef = React.useRef(null);
      const floating=useFloatingWindow({id:'comparison',getNode:()=>surfaceRef.current?.closest?.('[role=dialog]'),minWidth:320,minHeight:260,topGap:16});
      const originalRef = React.useRef(null);
      const personaRef = React.useRef(null);
      const originalTabRef = React.useRef(null);
      const personaTabRef = React.useRef(null);
      const positions = React.useRef({ original: 0, persona: 0 });
      const idRef = React.useRef(null);
      if (idRef.current === null) idRef.current = `persona-shell-comparison-${++nextComparisonId}`;
      const id = idRef.current;
      useLayoutEffect(() => {
        const element = surfaceRef.current;
        const view = element.ownerDocument.defaultView;
        const releaseScroll = lockComparisonScroll(element.ownerDocument);
        const measure = () => {
          const width = element.getBoundingClientRect().width;
          if (width > 0) setNarrow(width < COMPARISON_NARROW_WIDTH);
        };
        measure();
        const observer = typeof view?.ResizeObserver === 'function' ? new view.ResizeObserver(measure) : undefined;
        observer?.observe(element);
        view?.addEventListener('resize', measure);
        return () => { observer?.disconnect(); view?.removeEventListener('resize', measure); releaseScroll(); };
      }, []);
      useLayoutEffect(() => {
        for (const [side, ref] of [['original', originalRef], ['persona', personaRef]]) {
          if (!narrow || active === side) ref.current.scrollTop = positions.current[side];
        }
      }, [active, narrow]);
      const title = t?.('shell.compareTitle') ?? '原文对照';
      const labels = { original: t?.('shell.originalLabel') ?? '原文', persona: t?.('shell.personaLabel') ?? '人格版' };
      const tabs = [['original', originalTabRef], ['persona', personaTabRef]];
      return h(shippedComparisonModal(), { open: true, onClose, title, headless: true, className: 'persona-shell-comparison' },
        h('style', null, COMPARISON_CSS,FLOATING_WINDOW_CSS),
        h('div', { ref: surfaceRef, className: 'persona-shell-comparison-surface', 'data-narrow': narrow },
          h('div', { ...floating.dragProps,className: 'persona-shell-comparison-header' },
            h('h2', null, title),
            h('button', { type: 'button', 'data-modal-autofocus': '', onClick: onClose,
              'aria-label': t?.('shell.compareClose') ?? '关闭原文对照' }, t?.('shell.compareCloseShort') ?? '关闭'),
          ),
          h('div', { className: 'persona-shell-comparison-tabs', role: 'tablist', 'aria-label': title, hidden: !narrow,
            onKeyDown: (event) => {
              if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey
                || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const side = event.key === 'Home' ? 'original' : event.key === 'End' ? 'persona' : active === 'original' ? 'persona' : 'original';
              setActive(side);
              (side === 'original' ? originalTabRef : personaTabRef).current.focus({ preventScroll: true });
            },
          }, tabs.map(([side, ref]) => h('button', { key: side, ref, type: 'button', role: 'tab',
            id: `${id}-${side}-tab`, 'aria-controls': `${id}-${side}`, 'aria-selected': active === side,
            tabIndex: active === side ? 0 : -1, onClick: () => setActive(side), onFocus: () => setActive(side),
          }, labels[side]))),
          h('div', { className: 'persona-shell-comparison-panes',
            style: { gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : 'repeat(2, minmax(0, 1fr))' } },
            [['original', original, originalRef], ['persona', persona, personaRef]].map(([side, text, ref]) => h('section', {
              key: side, className: 'persona-shell-comparison-pane', id: `${id}-${side}`,
              role: narrow ? 'tabpanel' : 'region', hidden: narrow && active !== side,
              'aria-labelledby': `${id}-${side}-${narrow ? 'tab' : 'label'}`,
            },
            h('h3', { id: `${id}-${side}-label`, hidden: narrow }, labels[side]),
            h('div', { ref, className: 'persona-shell-comparison-scroll', 'data-comparison-side': side,
              tabIndex: 0, role: 'region', 'aria-label': labels[side],
              onScroll: (event) => { if (!narrow || active === side) positions.current[side] = event.currentTarget.scrollTop; },
            }, renderMarkdown(text)),
            )),
          ),
          h(FloatingWindowHandles,{controls:floating,label:title}),
        ),
      );
    }

    // Cache integrity only, not a security hash. Keep in sync with lib/review.js.
    function reviewFingerprint(text) {
      let a = 0x811c9dc5;
      let b = 0x9e3779b9;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        a = Math.imul(a ^ code, 0x01000193);
        b = Math.imul(b ^ code, 0x85ebca6b);
      }
      return `v1:${text.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
    }

    const REVIEW_REASON_LABELS = {
      'negation-change':'否定表达变化', 'condition-change':'条件表达变化',
      'uncertainty-change':'不确定性表达变化', 'quantity-change':'数字表达变化',
      'literal-order':'字面量顺序变化', 'self-reference':'转述者可能使用了自称',
    };
    const REVIEW_REASONS = Object.keys(REVIEW_REASON_LABELS);

    function reviewNeeded(row, original, settings) {
      const review = row?.review;
      if (settings?.reviewHints === false || row?.status !== 'ready'
        || typeof row.text !== 'string' || typeof original !== 'string'
        || review?.version !== 1 || review.scope !== 'message' || review.method !== 'local-lexical-v1'
        || !Number.isFinite(review.editScore) || review.editScore < 0 || review.editScore > 1
        || !Array.isArray(review.reasons) || review.reasons.some((reason) => !REVIEW_REASONS.includes(reason))
        || (review.criticalReasons !== undefined && (!Array.isArray(review.criticalReasons)
          || review.criticalReasons.some(reason => !['quantity-change','negation-change'].includes(reason) || !review.reasons.includes(reason))))) return false;
      const threshold = Number.isFinite(settings?.reviewThreshold)
        && settings.reviewThreshold >= 0 && settings.reviewThreshold <= 1 ? settings.reviewThreshold : 0.55;
      // A small edit can change a count or a local assertion. These signals
      // invite a comparison independently of the overall wording threshold.
      const factual = review.reasons.includes('quantity-change') || review.reasons.includes('literal-order') || review.reasons.includes('self-reference') || review.criticalReasons?.length > 0;
      if (!factual && !(review.editScore > 0 && review.editScore >= threshold)) return false;
      return review.sourceHash === reviewFingerprint(original) && review.targetHash === reviewFingerprint(row.text);
    }

    let nextReviewId = 0;
    let reviewPortal;
    try { reviewPortal = require('react-dom').createPortal; } catch { /* Old/minimal hosts keep the fixed-position fallback. */ }
    const reviewPanelStyle = {
      position: 'fixed',
      left: 0,
      top: 0,
      zIndex: 100,
      boxSizing: 'border-box',
      width: 'min(560px, calc(100vw - 24px))',
      maxHeight: 'min(420px, 55vh)',
      overflow: 'auto',
      overscrollBehavior: 'contain',
      padding: '12px',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 4px 18px #0002',
      fontSize: '13px',
      lineHeight: '1.6',
      overflowWrap: 'anywhere',
    };

    /** Prefer above when it fits; never hang a long preview underneath the composer. */
    function reviewPlacement(anchor, height, bounds) {
      const gap = 6;
      const width = Math.max(0, Math.min(560, bounds.right - bounds.left));
      const cap = Math.max(0, Math.min(420, (bounds.bottom - bounds.top) * 0.55));
      const above = Math.max(0, anchor.top - gap - bounds.top);
      const below = Math.max(0, bounds.bottom - anchor.bottom - gap);
      const onTop = above >= Math.min(height, cap) || above >= below;
      const maxHeight = Math.min(cap, onTop ? above : below);
      return {
        left: Math.max(bounds.left, Math.min(anchor.left, bounds.right - width)),
        top: onTop ? Math.max(bounds.top, anchor.top - gap - Math.min(height, maxHeight)) : anchor.bottom + gap,
        width,
        maxHeight,
      };
    }

    /** Hover/focus is a non-interactive preview; click pins an accessible dialog. */
    function ReviewHint({ original, review, t, renderOriginal }) {
      const [hovered, setHovered] = React.useState(false);
      const [focused, setFocused] = React.useState(false);
      const [pinned, setPinned] = React.useState(false);
      const [dismissed, setDismissed] = React.useState(false);
      const [position, setPosition] = React.useState(null);
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);
      const panelRef = React.useRef(null);
      const leaveTimer = React.useRef(undefined);
      const idRef = React.useRef(null);
      if (idRef.current == null) idRef.current = `persona-shell-review-${++nextReviewId}`;
      const id = idRef.current;
      const open = pinned || (!dismissed && (hovered || focused));
      const label = t?.('shell.reviewHint') ?? '改写变化提示，查看原文';
      const closeLabel = t?.('shell.reviewClose') ?? '关闭原文预览';
      const contains = (target) => rootRef.current?.contains(target) || panelRef.current?.contains(target);
      const cancelLeave = () => {
        if (leaveTimer.current !== undefined) clearTimeout(leaveTimer.current);
        leaveTimer.current = undefined;
      };
      const enter = () => { cancelLeave(); setHovered(true); setDismissed(false); };
      const leave = () => {
        cancelLeave();
        leaveTimer.current = setTimeout(() => { leaveTimer.current = undefined; setHovered(false); }, 150);
      };
      const dismiss = (restoreFocus) => {
        cancelLeave();
        setPinned(false);
        setDismissed(true);
        if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
      };

      React.useEffect(() => () => cancelLeave(), []);
      useLayoutEffect(() => {
        if (!open) { setPosition(null); return undefined; }
        const trigger = triggerRef.current;
        const panel = panelRef.current;
        const doc = trigger?.ownerDocument;
        const win = doc?.defaultView;
        if (!trigger || !panel || !win) return undefined;
        const scrollParents = new Set();
        const place = () => {
          const viewport = win.visualViewport;
          const width = viewport?.width ?? doc.documentElement?.clientWidth ?? win.innerWidth;
          const height = viewport?.height ?? doc.documentElement?.clientHeight ?? win.innerHeight;
          if (!(width > 0 && height > 0)) return;
          const left = viewport?.offsetLeft ?? 0;
          const top = viewport?.offsetTop ?? 0;
          const bounds = { left: left + 12, right: left + width - 12, top: top + 12, bottom: top + height - 12 };
          const clearance = Number.parseFloat(win.getComputedStyle?.(doc.documentElement).getPropertyValue('--dsh-frame-top-clearance'));
          if (Number.isFinite(clearance)) bounds.top = Math.max(bounds.top, (doc.documentElement.hasAttribute('data-fullscreen') ? 0 : clearance) + 20);
          // The chat scroller ends above the composer. Respect its vertical
          // reading area, but portal out of its clipping/transform context.
          for (let parent = trigger.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
            const overflow = win.getComputedStyle?.(parent).overflowY;
            if (!/^(auto|scroll)$/.test(overflow)) continue;
            scrollParents.add(parent);
            const rect = parent.getBoundingClientRect();
            bounds.top = Math.max(bounds.top, rect.top + 12);
            bounds.bottom = Math.min(bounds.bottom, rect.bottom - 12);
          }
          const anchor = trigger.getBoundingClientRect();
          if (anchor.bottom <= bounds.top || anchor.top >= bounds.bottom || anchor.right <= bounds.left || anchor.left >= bounds.right) {
            setHovered(false); setFocused(false); dismiss(false);
            return;
          }
          const next = reviewPlacement(anchor, panel.getBoundingClientRect().height, bounds);
          setPosition((current) => current && Object.keys(next).every((key) => current[key] === next[key]) ? current : next);
        };
        place();
        const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(place) : undefined;
        observer?.observe(trigger); observer?.observe(panel);
        for (const parent of scrollParents) observer?.observe(parent);
        win.addEventListener('scroll', place, true);
        win.addEventListener('resize', place);
        win.visualViewport?.addEventListener('resize', place);
        win.visualViewport?.addEventListener('scroll', place);
        return () => {
          observer?.disconnect();
          win.removeEventListener('scroll', place, true);
          win.removeEventListener('resize', place);
          win.visualViewport?.removeEventListener('resize', place);
          win.visualViewport?.removeEventListener('scroll', place);
        };
      }, [open, pinned]);
      React.useEffect(() => {
        const doc = rootRef.current?.ownerDocument ?? (typeof document === 'undefined' ? undefined : document);
        if (!open || doc === undefined) return undefined;
        const onPointer = (event) => {
          if (!contains(event.target)) {
            setHovered(false);
            setFocused(false);
            dismiss(false);
          }
        };
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          dismiss(pinned);
        };
        doc.addEventListener('pointerdown', onPointer, true);
        doc.addEventListener('keydown', onKey, true);
        return () => {
          doc.removeEventListener('pointerdown', onPointer, true);
          doc.removeEventListener('keydown', onKey, true);
        };
      }, [open, pinned]);
      React.useEffect(() => {
        if (pinned) panelRef.current?.focus({ preventScroll: true });
      }, [pinned]);

      const panel = open ? h('div', {
        id,
        ref: panelRef,
        'data-persona-shell': 'review-panel',
        role: pinned ? 'dialog' : 'tooltip',
        'aria-label': pinned ? label : undefined,
        tabIndex: pinned ? -1 : undefined,
        style: { ...reviewPanelStyle, ...position, visibility: position === null ? 'hidden' : undefined },
        onMouseEnter: enter,
        onMouseLeave: leave,
      },
      h('div', { style: { ...headerStyle, justifyContent: 'space-between' } },
        h('span', null, t?.('shell.originalLabel') ?? '原文'),
        pinned ? h('button', {
          type: 'button', style: toggleStyle, 'aria-label': closeLabel,
          onClick: () => dismiss(true),
        }, t?.('shell.reviewCloseShort') ?? '关闭') : null),
      h('div', { style: { ...paneLabelStyle, textTransform: 'none', letterSpacing: 'normal' } },
        t?.('shell.reviewNotice') ?? '本地表达对照提示，不代表事实错误；低分也不保证语义一致。',
        ` (${Math.round(review.editScore * 100)}/100)`,
        review.reasons.length > 0
          ? h('div', null, review.reasons.map((reason) => t?.(`shell.reviewReasons.${reason}`) ?? REVIEW_REASON_LABELS[reason]).join(' · '))
          : null),
      renderOriginal?.() ?? renderMarkdown(original),
      ) : null;
      const doc = rootRef.current?.ownerDocument;
      return h('div', {
        ref: rootRef,
        'data-persona-shell': 'review-hint',
        style: { display: 'inline-flex', width: 'fit-content', verticalAlign: 'middle', marginTop: '4px' },
        onMouseEnter: enter,
        onMouseLeave: leave,
        onFocus: (event) => {
          setFocused(true);
          if (!contains(event.relatedTarget)) setDismissed(false);
        },
        onBlur: (event) => {
          if (!contains(event.relatedTarget)) setFocused(false);
        },
      },
      h('button', {
        ref: triggerRef,
        type: 'button',
        'aria-label': label,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-controls': open ? id : undefined,
        'aria-describedby': open && !pinned ? id : undefined,
        style: {
          ...toggleStyle, color: 'var(--dsw-alias-state-warning-primary, var(--dsw-alias-brand-primary))', fontSize: '15px', fontWeight: 600,
          minWidth: '28px', minHeight: '28px', borderRadius: '4px',
        },
        onClick: () => {
          if (pinned) dismiss(false);
          else { setPinned(true); setDismissed(false); }
        },
      }, h('span', { 'aria-hidden': true }, '※')),
      panel && typeof reviewPortal === 'function' && doc?.body ? reviewPortal(panel, doc.body) : panel);
    }

    /** Text of one assistant step, in the order the blocks carry it. */
    function textOf(data) {
      const blocks = data?.blocks ?? [];
      return blocks
        .filter((block) => block !== undefined && block.kind === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }

    /**
     * How long a placeholder may stand in for a rewrite that is genuinely coming.
     *
     * Deliberately short. It exists to cover the second between a step settling
     * and its rewrite arriving; anything longer turns "opening an old session"
     * into a page of blank boxes, because history rows reach this branch too.
     */
    const HOLD_PLACEHOLDER_MS = 2500;

    /**
     * How long an eligible row may stay in the state-loading placeholder
     * before falling back to the official report. The host's state route is
     * local and normally answers in a frame or two; this bound only protects
     * a failed or stalled request from leaving a permanent blank.
     */
    const STATE_LOADING_MS = 500;

    /**
     * Which body one settled row should render.
     *
     * Split out as a pure function because the interesting cases are timing
     * cases, and timing is exactly what a mocked React cannot reproduce.
     * @param {{ status?: string, text?: string } | undefined} row - the host's record for this step.
     * @param {boolean} conceded - whether the hold window for a pending rewrite has expired.
     * @param {boolean} [fresh] - this step arrived while the page was live, so a
     *   rewrite is plausibly on its way. History rows opened from a restart pass
     *   `false`: nothing is coming for them and a placeholder would be a lie.
     * @returns {'persona' | 'plain' | 'placeholder' | 'streaming'}
     */
    function rowBranch(row, conceded, fresh = false, keepOriginal = false) {
      if (row !== undefined && row.status === 'ready' && typeof row.text === 'string' && row.text !== '') {
        return 'persona';
      }
      // Once the reader has seen the live original, keep it in place until a
      // complete rewrite is ready. Never erase it to replay a partial version.
      if (keepOriginal) return 'plain';
      // Streaming text arrived before the row settled: show it growing rather
      // than a placeholder that says nothing.
      if (row !== undefined && typeof row.partial === 'string' && row.partial !== '') {
        return 'streaming';
      }
      // A rewrite that already failed will never arrive, so the report is the
      // honest answer immediately.
      if (row !== undefined && row.status !== 'pending') return 'plain';
      // A pending row is the only case where text is genuinely on its way.
      // The host keeps a rewrite pending until its own timeout; conceding here
      // would show the original report while the rewrite is still running.
      if (row !== undefined) return 'placeholder';
      // No row at all: the state has not caught up with this step yet. Showing
      // the report here is what produced the flash — the row is new, its rewrite
      // is being computed, and the plain text appeared first and was replaced a
      // moment later. A placeholder is the honest body for that gap, but only for
      // a step that just arrived; a restored history row would otherwise sit on a
      // blank box until its fetch landed.
      return fresh && !conceded ? 'placeholder' : 'plain';
    }

    /**
     * Put the shielded literals back into a partial rewrite.
     *
     * The streaming text is still masked, so `[[0]]` style markers stand in for
     * code, paths and commands. Those markers are only meaningful to the host
     * that issued them, so the row carries the table alongside.
     * @param {string} text
     * @param {readonly string[] | undefined} literals
     * @returns {string}
     */
    function unmaskPartial(text, literals) {
      if (!Array.isArray(literals) || literals.length === 0) return text;
      return text.replace(/\[\[\s*(\d+)\s*\]\]/g, (whole, digits) => {
        const index = Number(digits);
        return literals[index] ?? whole;
      });
    }

    /** Explain a fallback on demand without exposing provider errors or internal codes. */
    function reportFallbackReason(row) {
      if (!row || !['failed', 'skipped'].includes(row.status)) return '';
      const reason = row.reason;
      if (['source-quantity-change', 'source-quantity-attribution', 'source-worker-change', 'source-permission-change', 'source-scope-change', 'source-status-change'].includes(reason)) {
        return '这次转述的数值表达、工作归属或执行条件未通过现有检查，未采用改写。原始汇报仍可阅读；这些检查不构成完整语义核验。';
      }
      if (['dropped-marker', 'unknown-marker', 'duplicate-marker', 'invented-fence'].includes(reason)) {
        return '这次转述没有完整保留受保护的技术内容，未采用改写。原始汇报保持不变。';
      }
      if (reason === 'too-long') return '这次转述超过长度上限，未采用改写。原始汇报保持不变。';
      if (['no-route', 'no-llm'].includes(reason)) return '暂时没有可用的转述模型，当前显示原始汇报。';
      if (reason === 'persona-changed') return '转述期间人格设置已变化，这次结果未采用，当前保留原始汇报。';
      if (reason === 'no-prose') return '这份汇报没有适合转述的普通说明，保留原始内容。';
      if (['disabled', 'session-disabled', 'rewrite-disabled'].includes(reason)) return '按当前开关设置保留原始汇报。';
      if (typeof reason === 'string' && /timeout|timed.out/iu.test(reason)) return '这次转述未能在时限内完成，当前保留原始汇报。';
      return '这次转述没有完成或未被采用，当前保留原始汇报。可以按需要调整表达；不会重新执行工作。';
    }

    /** Keep the official component mounted; change only one settled text block. */
    function PersonaStep({ delegate, ...props }) {
      const { node, sessionId, groupPart } = props;
      const data = node?.data;
      const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
      const seq = data?.finalNode?.seq;
      const original = textOf(data);
      const textBlocks = blocks.filter(block=>block?.kind==='text' && typeof block.text==='string' && block.text.trim());
      const t = shellTranslate(props.t);
      const eligible = data?.status === 'settled' && groupPart !== 'reasoning'
        && (groupPart === undefined || groupPart === 'response') && typeof seq === 'number'
        && usableSessionId(sessionId) && original !== ''
        && textBlocks.length === 1;
      const readingEligible=data?.status==='settled'&&groupPart!=='reasoning'&&(groupPart===undefined||groupPart==='response')
        &&Number.isSafeInteger(seq)&&usableSessionId(sessionId)&&textBlocks.length>0;
      const key = rowKey(sessionId, seq);
      const liveKey = rowKey(sessionId, node?.key);
      if (typeof node?.key === 'string' && data?.status === 'running') liveSeen.add(liveKey);
      const { state } = useHostState(sessionId, readingEligible ? seq : undefined);
      const [comparison, setComparison] = React.useState(undefined);
      const [feedbackOpen, setFeedbackOpen] = React.useState(false);
      const [expiredKey, setExpiredKey] = React.useState(undefined);
      const [stateExpiredKey, setStateExpiredKey] = React.useState(undefined);
      const [readingError,setReadingError]=React.useState('');
      const row = eligible ? state?.rows?.find((candidate) => candidate.seq === seq) : undefined;
      const switchesReady = state?.switchesReady !== false;
      const switchLoading = eligible && globalEnabled && state !== undefined && !switchesReady;
      const allowed = eligible && globalEnabled && !switchLoading && state?.sessionEnabled !== false
        && state?.settings?.enabled !== false && sessionOff.get(sessionId) !== false;
      React.useEffect(() => {
        if (!allowed) return undefined;
        const timer = setTimeout(() => setExpiredKey(key), HOLD_PLACEHOLDER_MS);
        return () => clearTimeout(timer);
      }, [allowed, key]);
      React.useEffect(() => {
        if (!allowed || state !== undefined) return undefined;
        const timer = setTimeout(() => setStateExpiredKey(key), STATE_LOADING_MS);
        return () => clearTimeout(timer);
      }, [allowed, key, state]);
      React.useEffect(() => { setComparison(undefined); }, [key, allowed, row?.status, row?.final]);
      React.useEffect(() => { setFeedbackOpen(false); }, [key]);

      if (allowed && !freshDecided.has(key) && state !== undefined) {
        freshDecided.set(key, liveSeen.has(liveKey));
      }
      const stateLoading = allowed && state === undefined && stateExpiredKey !== key;
      const keepOriginal = eligible && liveSeen.has(liveKey);
      const branch = !allowed
        ? (switchLoading && !keepOriginal ? 'placeholder' : 'plain')
        : stateLoading && !keepOriginal ? 'placeholder'
          : rowBranch(row, expiredKey === key, freshDecided.get(key) === true, keepOriginal);
      if (allowed && branchHistory.get(key) !== branch) {
        branchHistory.set(key, branch);
        const trace = diagnosticsTrail.get(key) ?? [];
        trace.push({ branch, at: Date.now() });
        diagnosticsTrail.set(key, trace.slice(-4));
        if (trace.length <= 4) reportDiagnostics({ branchTrail: { [key]: trace } });
      }
      const text = branch === 'persona' ? row.text
        : branch === 'streaming' ? unmaskPartial(row.partial, row.partialLiterals)
          : branch === 'placeholder' ? placeholderText(t) : undefined;
      const report = renderOfficial(delegate, props, displayNode(node, text));
      const ready = branch === 'persona';
      const showHeader = eligible && row?.final === true && ['ready','failed','skipped'].includes(row.status);
      const showReading=readingEligible&&(state?.reports?.some(report=>report.seq===seq&&report.final===true)
        ||(!Array.isArray(state?.reports)&&row?.final===true));
      // Original previews contain text only; images/reasoning remain in the
      // continuously mounted main renderer, not duplicated in a comparison.
      const renderOriginal = () => renderOfficial(delegate, { ...props, groupPart: 'response' }, {
        ...node, data: { ...data, blocks: blocks.filter((block) => block?.kind === 'text') },
      });
      const comparisonOpen = comparison?.key === key;
      const rewriteWaiting = allowed && keepOriginal && !comparisonOpen && (row?.status === 'pending'
        || (row === undefined && expiredKey !== key && stateExpiredKey !== key));
      // No layout wrapper or reparenting, even while the portaled modal is open.
      return h(React.Fragment, null,
        // The persona badge and original toggle belong above the report, where
        // the reader meets the row; the ※ review hint stays at the end, where
        // it does not compete with the reading flow.
        showHeader||showReading ? h('div', { style: headerStyle, 'data-persona-shell': 'controls' },
          h('span', { style: badgeStyle }, ready?(row.speaker?.name??'历史人格'):'原始汇报', ready&&row.speaker?.mode === 'relay' ? ' · 转述' : ''),
          showHeader&&ready?h('button', {
            type: 'button', style: toggleStyle, 'aria-expanded': comparisonOpen, 'aria-haspopup': 'dialog',
            onClick: () => setComparison({ key, original:textBlocks[0].text, persona: row.text }),
          }, t('shell.showOriginal') ?? 'origin'):null,
          showHeader?h('button', { type: 'button', style: toggleStyle, 'aria-haspopup': 'dialog',
            onClick: () => setFeedbackOpen({key,row}) }, row.retrying ? '正在调整…' : '调整表达'):null,
          showReading?h('button',{type:'button',style:toggleStyle,'aria-haspopup':'dialog',onClick:()=>{try{reportReadingRuntime.open(sessionId,seq,{sessionId,seq,text:original,cwd:props.cwd,openFile:props.openFile});setReadingError('');}catch(error){setReadingError(error.message);}}},'阅读报告'):null,
        ) : null,
        showHeader && !ready && reportFallbackReason(row) ? h('details', { 'data-persona-shell': 'fallback-reason',
          style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: 1.6, marginBottom: '6px' } },
          h('summary', { style: { cursor: 'pointer' } }, '为什么显示原文'),
          h('span', { style: { display: 'block', maxWidth: '42em', marginTop: '3px' } }, reportFallbackReason(row))) : null,
        readingError?h('small',{role:'status',style:{display:'block',color:'var(--dsw-alias-label-secondary)'}},readingError):null,
        report,
        ready && row.final !== true && state?.settings?.processToolUsage === true
          && state?.settings?.includeToolSteps !== false && typeof row.processNote === 'string'
          && row.processNote !== '' && Array.from(row.processNote).length <= 40
          ? h('small', { 'data-persona-shell': 'process-note',
            title: t('shell.processNote') ?? '过程补充：依据本阶段工具统计与会话节奏生成，不计入正文措辞评分。',
            style: { display: 'block', marginTop: '4px', fontSize: '12px', lineHeight: '1.6',
              color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, row.processNote)
          : null,
        rewriteWaiting ? h('small', { role: 'status', 'data-persona-shell': 'rewrite-pending',
          style: { display:'block', fontSize:'12px', lineHeight:1.6, color:'var(--dsw-alias-label-secondary)' } }, '正在转述，原文可继续阅读。') : null,
        ready && !comparisonOpen && reviewNeeded(row, original, state?.settings)
          ? h(ReviewHint, { key: `${key}:${row.review.sourceHash}:${row.review.targetHash}`, original, review: row.review, t, renderOriginal })
          : null,
        showHeader && ready && comparisonOpen ? h(ComparisonDialog, { original: comparison.original,
          persona: comparison.persona, t, onClose: () => setComparison(undefined) }) : null,
        eligible && feedbackOpen?.key===key ? h(ReportFeedback, { key, sessionId,showResult:!allowed,
          row:row??{...feedbackOpen.row,canRetry:false,retryUnavailableReason:'source-unavailable'},onClose: () => setFeedbackOpen(false) }) : null,
        showHeader && row.feedbackError ? h('small', { role: 'status', style: { display: 'block', color: 'var(--dsw-alias-label-secondary)' } }, row.feedbackError) : null,
      );
    }

    /** The three dots the placeholder shows while the rewrite is in flight. */
    function placeholderText(t) {
      const label = typeof t === 'function' ? t('shell.rewriting') : undefined;
      return typeof label === 'string' && label !== '' ? label : '…';
    }

