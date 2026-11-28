    function ProgressNotice({ sessionId, t }) {
      const master = useGlobalEnabled();
      const sessionOn = useSessionSwitch(sessionId);
      const enabled = master && progressEnabled && sessionOn;
      const [visible, setVisible] = React.useState(typeof document === 'undefined' || document.visibilityState !== 'hidden');
      React.useEffect(() => {
        if (!enabled || !usableSessionId(sessionId)) return undefined;
        const update = () => {
          const shown = typeof document === 'undefined' || document.visibilityState !== 'hidden';
          setVisible(shown);
          announceProgressView(shown ? sessionId : undefined);
        };
        update();
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update);
        return () => {
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update);
          // Do not let an old Session's cleanup release a newer Session's lease.
          if (progressViewerSession === sessionId) announceProgressView(undefined);
        };
      }, [sessionId, enabled]);
      // This subscriber exists even before the first assistant node is committed.
      const { state } = useHostState(sessionId, enabled && visible ? PROGRESS_WATCH : undefined);
      const notice = enabled && visible && state?.settings?.progressNotices === true
        && state?.settings?.enabled !== false && state?.sessionEnabled !== false ? state?.progress : undefined;
      if (typeof notice?.text !== 'string' || notice.text === '') return null;
      const label = shellTranslate(t)('shell.progressNotice') ?? '静默状态播报（插件生成，不是主模型消息）';
      return h('div', {
        'data-persona-shell': 'progress', role: 'status', 'aria-live': 'polite', 'aria-atomic': true, 'aria-label': label,
        style: { display: 'flex', gap: '8px', padding: '8px 12px', minWidth: 0, maxWidth: '100%',
          color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)',
          borderRadius: '8px', fontSize: '13px', lineHeight: '1.6', overflowWrap: 'anywhere' },
      }, h('span', { 'aria-hidden': true, title: `${label}\n${notice.source ?? ''}`,
        style: { color: 'var(--dsw-alias-brand-primary)', flex: 'none', cursor: 'help' } }, PROGRESS_PREFIX),
      h('span', { style: { minWidth: 0, whiteSpace: 'pre-wrap' } }, notice.text));
    }

    /**
     * The per-session switch in the conversation header.
     *
     * It also tells the controller which Session is on screen: the chat
     * takeover is page-wide, so "this session is off" is implemented by
     * releasing it while that Session is viewed, which gives the official
     * renderer back in full (reasoning, images, interrupted/running states).
     */
    function SessionPersonaSwitch({ sessionId, t, useInput, inputActions, useSessions }) {
      const enabled = useSessionSwitch(sessionId);
      const ready = useSwitchReady();
      const global = useGlobalEnabled();
      const [pending, setPending] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const [panel, setPanel] = React.useState(false);
      const { state } = useHostState(sessionId, -2);
      const conversation = state?.conversation;

      useLayoutEffect(() => {
        if (typeof sessionId !== 'string') return undefined;
        setActiveSession(sessionId);
        return () => setActiveSession(undefined);
      }, [sessionId]);
      const toggle = async () => {
        if (pending || global !== true || typeof sessionId !== 'string') return;
        setPending(true);
        setFailed(false);
        const request = ++requestSequence;
        try {
          const response = await fetch(`${ROUTE}/session-switch`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, enabled: !enabled }),
          });
          if (!response.ok) throw new Error(String(response.status));
          const value = await response.json();
          applySessionSwitches(value?.sessionSwitches, request);
        } catch {
          setFailed(true);
        } finally {
          setPending(false);
        }
      };

      const label = t?.('shell.personaSwitch') ?? '人格';
      const stateText = !ready
        ? '…'
        : pending
          ? '…'
          : enabled
            ? (t?.('shell.personaSwitchOn') ?? '开')
            : (t?.('shell.personaSwitchOff') ?? '关');
      const title = !ready
        ? (t?.('shell.personaSwitchLoading') ?? '正在读取会话开关')
        : global !== true
          ? (t?.('shell.personaSwitchGlobalOff') ?? '总开关已关闭')
          : failed
            ? (t?.('shell.personaSwitchFailed') ?? '保存失败')
            : (t?.('shell.personaSwitchHint') ?? '仅对当前会话生效');

      return h(React.Fragment, null, h(WorkInputBridge,{sessionId,useInput,inputActions,useSessions}),h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': enabled,
        title,
        disabled: !ready || pending || global !== true,
        onClick: toggle,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          height: '24px',
          padding: '0 8px',
          borderRadius: '999px',
          border: `0.5px solid ${enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
          background: enabled ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
          color: failed
            ? 'var(--dsw-alias-state-error-primary)'
            : enabled
              ? 'var(--dsw-alias-brand-primary)'
              : 'var(--dsw-alias-label-tertiary)',
          fontSize: '12px',
          lineHeight: '1',
          cursor: pending || global !== true ? 'default' : 'pointer',
          opacity: pending ? 0.6 : 1,
        },
      }, h('span', null, label), h('span', null, stateText)),
      h('button', { type: 'button', onClick: () => setPanel(true), style: headerButtonStyle,
        'aria-haspopup': 'dialog', title: '设置当前会话的人格、转述范围与接力' },
        '会话设置'),
      panel ? h(ConversationPanel, { key: sessionId, sessionId, conversation, onClose: () => setPanel(false) }) : null,
      h(PersonaChatLauncher, { sessionId, conversation }));
    }

    const chatDrafts = new Map();
    const chatWorkDrafts = new Map();
    const workInputBindings = new Map(), workInputListeners = new Set();
    const notifyWorkInput = () => { for(const update of workInputListeners)update(); };
    function WorkInputBridge(props){
      return typeof props.useInput==='function'&&typeof props.inputActions?.captureInsertion==='function'&&typeof props.inputActions?.insertText==='function'
        ?typeof props.useSessions==='function'?h(NamedWorkInput,props):h(BoundWorkInput,props):null;
    }
    function NamedWorkInput(props){const title=props.useSessions(list=>list.byId[props.sessionId]?.displayTitle??'');return h(BoundWorkInput,{...props,title});}
    function BoundWorkInput({sessionId,useInput,inputActions,title}){
      const state=useInput(value=>value),own=React.useMemo(()=>({actions:inputActions,state:null}),[sessionId,inputActions]);
      own.state=state;own.title=title;
      useLayoutEffect(()=>{if(typeof sessionId!=='string')return;workInputBindings.set(sessionId,own);notifyWorkInput();
        return()=>{if(workInputBindings.get(sessionId)===own){workInputBindings.delete(sessionId);notifyWorkInput();}};},[sessionId,own]);
      useLayoutEffect(notifyWorkInput,[state,title]);
      return null;
    }
