    // Drafts stay on the client; closing a dialog never submits or discards them.
    const conversationDrafts = new Map();
    const feedbackDrafts = new Map();
    function keepDraft(map, key, value) {
      if (!map.has(key) && map.size >= 100) map.delete(map.keys().next().value);
      map.set(key, value);
    }
    const ACTION_CSS = `
      .dsh-persona-action[data-native]{box-sizing:border-box;position:fixed;inset:0;margin:auto;transform:none;width:min(520px,calc(100vw - 32px));height:fit-content;max-width:calc(100vw - 32px);max-height:calc(100dvh - 48px);border:0;padding:0;background:transparent;color:var(--dsw-alias-label-primary);overflow:visible;text-align:left}
      .dsh-persona-action::backdrop{background:#0007}
      .dsh-persona-action-surface{box-sizing:border-box;position:relative;width:100%;max-width:100%;min-width:0;max-height:calc(100dvh - 48px);overflow:auto;overscroll-behavior:contain;padding:24px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 20px 80px #0003;font-size:14px;line-height:1.65;overflow-wrap:anywhere}
      .dsh-persona-action-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
      .dsh-persona-action-top h2{font-size:18px;margin:0}.dsh-persona-action-top button{flex:none}
      .dsh-persona-action-surface label{display:grid;gap:6px;margin:14px 0}
      .dsh-persona-action-surface select,.dsh-persona-action-surface textarea{box-sizing:border-box;width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-2,#f6f8fb);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:9px;min-width:0}
      .dsh-persona-action-surface textarea{min-height:96px;resize:vertical}
      .dsh-persona-action-surface button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 12px;background:var(--dsw-alias-bg-layer-2,#f6f8fb);cursor:pointer;min-height:34px}
      .dsh-persona-action-surface button:disabled{opacity:.5;cursor:default}.dsh-persona-action-surface button:focus-visible,.dsh-persona-action-surface select:focus-visible,.dsh-persona-action-surface textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
      .dsh-persona-action-surface button[data-primary]{background:var(--dsw-alias-brand-primary,#386fba);color:var(--dsw-alias-on-brand-primary,var(--dsw-alias-bg-layer-1,#fff));border-color:transparent}
      .dsh-persona-action-note{color:var(--dsw-alias-label-secondary);font-size:12px;margin:8px 0}
      .dsh-persona-action-box{padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f6f8fb);margin:16px 0}
      .dsh-persona-action-buttons{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
      @media(max-width:520px){.dsh-persona-action-surface{padding:18px}}
    `;
    function ActionDialog({ title, onClose, children }) {
      const surface = React.useRef(null);
      const floating=useFloatingWindow({id:'action:'+title,getNode:()=>surface.current?.closest?.('dialog'),minHeight:180,topGap:16});
      useLayoutEffect(() => lockComparisonScroll(surface.current.ownerDocument), []);
      // Native top-layer geometry is independent of the header container and host Modal sizing.
      return h(NativeComparisonModal, { onClose, title, className: 'dsh-persona-action' },
        h('style', null, ACTION_CSS,FLOATING_WINDOW_CSS), h('div', { ref: surface, className: 'dsh-persona-action-surface' },
          h('div', { ...floating.dragProps,className: 'dsh-persona-action-top' }, h('h2', null, title),
            h('button', { type: 'button', onClick: onClose, 'aria-label': `关闭${title}` }, '关闭')), children,h(FloatingWindowHandles,{controls:floating,label:title})));
    }
    const actionError = (error) => ({
      'conversation-conflict': '会话选择已在别处更新。已读入最新状态，请核对后重新保存。',
      'relay-conflict': '这次接力状态已经变化，请核对最新状态。',
      'relay-already-pending': '已有一项等待中的接力，请先取消。',
      'relay-same-persona': '请选择另一位接手角色。',
      'session-capacity': '独立会话选择已达上限，暂时无法新增。已有会话仍可调整。',
      'persona-not-found': '这个人格已经被删除，请重新选择。',
      'storage-not-ready': '保存服务尚未就绪，请稍后重试。输入已经保留。',
      'memory-capacity': '记忆已满，请先在设置里整理旧条目。输入已经保留。',
      'memory-conflict': '保存期间记忆又有更新，请核对后重试。输入已经保留。',
      'memory-disabled': '记忆已关闭。可以只调整这一次，或先到设置开启记忆。',
      'report-conflict': '这份汇报已经更新，请核对后再提交。输入已经保留。',
      'feedback-in-progress': '这份汇报正在调整，请等本次完成。',
      'rewrite-disabled': '当前转述已关闭，开启后可以重试。',
      'source-unavailable': '这份旧汇报没有保存原始来源，暂时不能重新转述。',
      'report-incomplete': '这份汇报还没有完成，请等正文稳定后再调整。',
      'report-no-prose': '这份汇报没有可调整的文字，代码等原样保留。',
      'feedback-rewrite-failed': '这次调整没有完成，已保留原来的汇报和你的输入。',
      'feedback-thinking-unavailable':'当前模型无法启用思考，原汇报与输入已保留；可更换模型，或关闭本次思考后重试。',
    }[error] ?? '没有保存成功，请重试。你的输入已经保留。');
    async function actionRequest(path, body) {
      const response = await fetch(`${ROUTE}/${path}`, body === undefined ? undefined
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const value = await response.json();
      return { ok: response.ok, value };
    }

    const REPORT_THEME_PREFERENCE_KEY='dsh-persona-shell:report-reading-appearance:v1';
    const reportThemePreference=value=>({theme:['system','catppuccin','nord','rosepine'].includes(value?.theme)?value.theme:'system',
      appearance:['auto','light','dark'].includes(value?.appearance)?value.appearance:'auto'});
    function parseReportThemePreference(raw){
      try{return typeof raw==='string'&&raw.length<=1024?reportThemePreference(JSON.parse(raw)):reportThemePreference(null);}
      catch{return reportThemePreference(null);}
    }
    function readReportThemePreference(){try{return parseReportThemePreference(localStorage.getItem(REPORT_THEME_PREFERENCE_KEY));}catch{return reportThemePreference(null);}}
    function reportHostAppearance(){
      const root=document.documentElement,body=document.body;
      // The native ThemePresenter marks the actual appearance on body, including an empty boolean attribute.
      if(body?.hasAttribute('data-ds-dark-theme'))return'dark';
      if(root.hasAttribute('data-ds-theme-source'))return'light';
      for(const node of [root,body].filter(Boolean)){
        for(const name of ['data-theme','data-color-scheme','data-color-mode','data-theme-mode']){
          const value=node.getAttribute(name)?.toLowerCase();if(value==='dark'||value==='light')return value;
        }
        if(node.classList.contains('dark')||node.classList.contains('theme-dark')||node.classList.contains('dark-theme'))return'dark';
        if(node.classList.contains('light')||node.classList.contains('theme-light')||node.classList.contains('light-theme'))return'light';
      }
      const scheme=getComputedStyle(root).colorScheme?.trim();if(scheme==='dark'||scheme==='light')return scheme;
      const background=body?getComputedStyle(body):getComputedStyle(root);
      const colors=[background.getPropertyValue('--dsw-alias-bg-layer-1'),background.backgroundColor,getComputedStyle(root).backgroundColor];
      for(const color of colors){
        const value=color.trim(),hex=/^#([\da-f]{3}|[\da-f]{6})$/iu.exec(value),rgb=/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/iu.exec(value);
        const channels=hex? (hex[1].length===3?[...hex[1]].map(part=>parseInt(part+part,16)):[0,2,4].map(index=>parseInt(hex[1].slice(index,index+2),16)))
          :rgb&&(!rgb[4]||Number(rgb[4])>.9)?rgb.slice(1,4).map(Number):null;
        if(channels)return channels.reduce((total,part,index)=>total+part*[.2126,.7152,.0722][index],0)<128?'dark':'light';
      }
      return typeof window.matchMedia==='function'&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
    }
    function useReportTheme(){
      const [preference,setPreference]=React.useState(readReportThemePreference),[hostAppearance,setHostAppearance]=React.useState(reportHostAppearance),[notice,setNotice]=React.useState('');
      const current=React.useRef(preference);current.current=preference;
      React.useEffect(()=>{
        const update=()=>setHostAppearance(previous=>{const next=reportHostAppearance();return previous===next?previous:next;});
        const media=typeof window.matchMedia==='function'?window.matchMedia('(prefers-color-scheme: dark)'):null;
        const observer=typeof MutationObserver==='function'?new MutationObserver(update):null;
        const options={attributes:true,attributeFilter:['class','style','data-theme','data-color-scheme','data-color-mode','data-theme-mode','data-ds-dark-theme','data-ds-theme-source']};
        observer?.observe(document.documentElement,options);if(document.body)observer?.observe(document.body,options);
        media?.addEventListener?.('change',update);
        const storage=event=>{if(event.key!==REPORT_THEME_PREFERENCE_KEY)return;const next=parseReportThemePreference(event.newValue);current.current=next;setPreference(next);setNotice('');};
        window.addEventListener('storage',storage);update();
        return()=>{observer?.disconnect();media?.removeEventListener?.('change',update);window.removeEventListener('storage',storage);};
      },[]);
      const change=patch=>{const next=reportThemePreference({...current.current,...patch});current.current=next;setPreference(next);setNotice('');
        try{localStorage.setItem(REPORT_THEME_PREFERENCE_KEY,JSON.stringify({version:1,...next}));}
        catch{setNotice('本页配色已应用，暂时无法保存在本机。');}};
      const appearance=preference.theme==='system'||preference.appearance==='auto'?hostAppearance:preference.appearance;
      const theme=React.useMemo(()=>createReportTheme(preference.theme,appearance),[preference.theme,appearance]);
      return{preference,theme,change,notice};
    }
    const REPORT_READING_CSS = `
      [role=dialog][aria-label="报告图片预览"]{z-index:1160}
      .dsh-report-reading,.dsh-report-reading-dock{--rr-bg:var(--dsw-alias-bg-layer-1,#fff);--rr-soft:var(--dsw-alias-bg-layer-2,#f5f7fa);--rr-ink:var(--dsw-alias-label-primary,#243244);--rr-muted:var(--dsw-alias-label-secondary,#687788);--rr-border:var(--dsw-alias-border-l1,#dce3eb);--rr-accent:var(--dsw-alias-brand-primary,#436cba);--rr-risk:color-mix(in srgb,#b47a24 78%,var(--rr-ink));--rr-support:color-mix(in srgb,#398b91 73%,var(--rr-ink));box-sizing:border-box;color:var(--rr-ink);font:13px/1.65 system-ui,'Microsoft YaHei',sans-serif;-webkit-app-region:no-drag}
      .dsh-report-reading{position:fixed;z-index:1150;right:max(16px,env(safe-area-inset-right));bottom:max(14px,env(safe-area-inset-bottom));width:min(860px,calc(100vw - 32px));height:min(820px,calc(100dvh - 72px));max-height:calc(100dvh - 72px);display:flex;flex-direction:column;overflow:hidden;background:var(--rr-bg);border:1px solid var(--rr-border);border-radius:15px;box-shadow:0 18px 70px #0003;animation:rr-enter 180ms ease-out both}
      .dsh-report-reading[data-wide=true]{width:min(1120px,calc(100vw - 32px));height:calc(100dvh - 72px)}
      .dsh-report-reading button:not(:where(.rr-document *)),.dsh-report-reading-dock button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--rr-border);border-radius:7px;background:var(--rr-bg);padding:4px 9px;min-height:29px;line-height:1.45}.dsh-report-reading button:not(:where(.rr-document *)):hover,.dsh-report-reading-dock button:hover{background:var(--rr-soft)}.dsh-report-reading button:not(:where(.rr-document *)):disabled{opacity:.45;cursor:default}.dsh-report-reading :focus-visible:not(:where(.rr-document *)),.dsh-report-reading-dock :focus-visible{outline:2px solid var(--rr-accent);outline-offset:2px}.dsh-report-reading button[data-primary]:not(:where(.rr-document *)){background:var(--rr-accent);color:var(--rr-on-accent,#fff);border-color:transparent}
      .dsh-report-reading .rr-head{display:flex;align-items:center;gap:10px;padding:13px 17px;border-bottom:1px solid var(--rr-border);flex:none}.dsh-report-reading .rr-head-title{flex:1;min-width:0}.dsh-report-reading .rr-head-title h2{font-size:14px;font-weight:650;margin:0}.dsh-report-reading .rr-head-title small{display:block;color:var(--rr-muted);font-size:10px;margin-top:1px}.dsh-report-reading .rr-head-actions{display:flex;gap:4px;flex:none}.dsh-report-reading .rr-head-actions button{font-size:11px;padding:4px 7px}
      .dsh-report-reading .rr-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:10px 17px;flex:none}
      .dsh-report-reading .rr-reading-mode{display:flex;align-items:center;gap:3px;padding:2px;border:1px solid var(--rr-border);border-radius:8px}.dsh-report-reading .rr-reading-mode button{border:0;background:transparent;min-height:27px;padding:3px 10px;font-size:11px;color:var(--rr-muted)}.dsh-report-reading .rr-reading-mode button[aria-pressed=true]{background:var(--rr-soft);color:var(--rr-ink);font-weight:600}.dsh-report-reading .rr-appearance{position:relative;font-size:10px;color:var(--rr-muted)}.dsh-report-reading .rr-appearance summary{cursor:pointer;list-style:none;padding:4px}.dsh-report-reading .rr-appearance summary::-webkit-details-marker{display:none}.dsh-report-reading .rr-appearance summary:after{content:'⌄';margin-left:5px}.dsh-report-reading .rr-appearance[open] summary:after{content:'⌃'}.dsh-report-reading .rr-appearance-options{position:absolute;z-index:3;top:calc(100% + 5px);right:0;width:max-content;max-width:calc(100vw - 42px);padding:9px;border:1px solid var(--rr-border);border-radius:9px;box-shadow:0 7px 22px #0002;background:var(--rr-bg)}.dsh-report-reading .rr-guide{display:flex;align-items:center;gap:3px 9px;flex-wrap:wrap;flex:none;margin:0 17px;padding:0 0 9px;border-bottom:1px solid var(--rr-border);font-size:10px;color:var(--rr-muted)}.dsh-report-reading .rr-guide>span{font-size:9px;margin-right:2px}.dsh-report-reading .rr-guide button{display:inline-flex;align-items:center;gap:5px;font-size:10px;border:0;border-radius:5px;background:transparent;min-height:24px;padding:2px 5px;color:var(--rr-muted)}.dsh-report-reading .rr-guide button[aria-pressed=true]{color:var(--rr-accent);background:var(--rr-soft)}.dsh-report-reading .rr-guide button[data-kind=risk]{color:var(--rr-risk)}.dsh-report-reading .rr-guide button>span{font-variant-numeric:tabular-nums;font-size:9px;opacity:.75}.dsh-report-reading .rr-reading-status{margin:0 auto 16px;max-width:740px;font-size:10px;line-height:1.75;color:var(--rr-muted)}.dsh-report-reading .rr-sr-only{position:absolute;clip:rect(0,0,0,0);clip-path:inset(50%);width:1px;height:1px;overflow:hidden;white-space:nowrap}.dsh-report-reading .rr-document [data-rr-hidden=true]{display:none!important}.dsh-report-reading .rr-document button.rr-fold-toggle{display:flex;align-items:center;gap:7px;min-height:29px;max-width:100%;margin:.45em 0 .85em;padding:3px 7px;border:0;border-radius:5px;background:var(--rr-soft);color:var(--rr-muted);font:10px/1.7 system-ui,'Microsoft YaHei',sans-serif;text-align:left;cursor:pointer}.dsh-report-reading .rr-document button.rr-fold-toggle:before{content:'›';font-size:15px;line-height:1;transform-origin:center}.dsh-report-reading .rr-document button.rr-fold-toggle[aria-expanded=true]:before{transform:rotate(90deg)}.dsh-report-reading .rr-document button.rr-fold-toggle:hover{color:var(--rr-ink)}.dsh-report-reading .rr-document button.rr-fold-toggle:focus-visible,.dsh-report-reading .rr-document p:focus-visible{outline:2px solid var(--rr-accent);outline-offset:3px}.dsh-report-reading .rr-document p[data-rr-locate]{position:relative}.dsh-report-reading .rr-document p[data-rr-locate]:before{content:"";position:absolute;inset-inline-start:-11px;top:.28em;width:2px;height:1.35em;border-radius:2px;background:var(--rr-accent);pointer-events:none;animation:rr-locate 2200ms ease-out both}.dsh-report-reading .rr-document p[data-rr-locate=risk]:before{background:var(--rr-risk)}

      .dsh-report-reading .rr-content{overflow:auto;overscroll-behavior:contain;min-width:0;min-height:0;flex:1;padding:29px 34px 38px;scrollbar-gutter:stable}.dsh-report-reading .rr-document{max-width:740px;margin:0 auto;font-size:14px;line-height:1.95;overflow-wrap:anywhere}.dsh-report-reading .rr-document h1{font-size:1.65em;line-height:1.5;margin:1.4em 0 .75em;letter-spacing:-.02em}.dsh-report-reading .rr-document h2{font-size:1.3em;line-height:1.6;margin:1.65em 0 .7em;letter-spacing:-.01em}.dsh-report-reading .rr-document h3{font-size:1.1em;line-height:1.65;margin:1.4em 0 .55em}.dsh-report-reading .rr-document :is(h1,h2,h3):first-child{margin-top:0}.dsh-report-reading .rr-document p{margin:0 0 1.05em}.dsh-report-reading .rr-document strong{font-weight:650}.dsh-report-reading .rr-document :is(ul,ol){padding-inline-start:1.65em;margin:.7em 0 1.25em}.dsh-report-reading .rr-document li{padding-left:.15em;margin:.4em 0}.dsh-report-reading .rr-document li>p{margin:.45em 0}.dsh-report-reading .rr-document :not(pre)>code{font-size:.9em;overflow-wrap:anywhere}.dsh-report-reading .rr-document pre{max-width:100%;overflow:auto;border-radius:9px}.dsh-report-reading .rr-document table{max-width:100%;display:block;overflow:auto;border-collapse:collapse;font-size:.92em;margin:1.2em 0}.dsh-report-reading .rr-document :is(td,th){padding:8px 11px;border:1px solid var(--rr-border)}.dsh-report-reading .rr-document blockquote{margin:1.3em 0;padding:.1em 0 .1em 1em;border-left:2px solid var(--rr-border);color:var(--rr-muted)}.dsh-report-reading .rr-document hr{border:0;border-top:1px solid var(--rr-border);margin:1.8em 0}.dsh-report-reading .rr-document img{max-width:100%}
      .dsh-report-reading .rr-intro,.dsh-report-reading .rr-unavailable{max-width:740px;margin:0 auto 22px;color:var(--rr-muted);font-size:12px;line-height:1.8}.dsh-report-reading .rr-intro{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:0 0 17px;border-bottom:1px solid var(--rr-border)}.dsh-report-reading .rr-intro p{margin:0}.dsh-report-reading .rr-intro button{white-space:nowrap;font-size:11px}.dsh-report-reading .rr-unavailable{padding:28px 0}.dsh-report-reading .rr-unavailable h3{color:var(--rr-ink);font-size:17px;margin:0 0 10px}.dsh-report-reading .rr-unavailable button{margin-top:10px}.dsh-report-reading .rr-note{font-size:11px;color:var(--rr-muted);margin:12px auto 0;max-width:740px;line-height:1.75}
      .dsh-report-reading .rr-explanation{max-width:740px;margin:0 auto 18px;font-size:11px;color:var(--rr-muted);line-height:1.75}.dsh-report-reading .rr-explanation summary{cursor:pointer}.dsh-report-reading .rr-explanation p{margin:6px 0 0}.dsh-report-reading .rr-status{padding:7px 17px;background:var(--rr-soft);font-size:11px;flex:none;line-height:1.75}.dsh-report-reading .rr-status p{margin:0}.dsh-report-reading .rr-status details{margin-top:3px}.dsh-report-reading .rr-status summary{cursor:pointer}.dsh-report-reading .rr-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 17px;border-top:1px solid var(--rr-border);font-size:10px;color:var(--rr-muted);flex:none}.dsh-report-reading .rr-footer>span{flex:1;min-width:120px;overflow-wrap:anywhere}.dsh-report-reading .rr-footer button{font-size:11px;min-height:27px}
      .dsh-report-reading-dock{position:fixed;z-index:1100;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));display:flex;align-items:center;gap:2px;max-width:calc(100vw - 32px);padding:3px 4px 3px 3px;background:var(--rr-bg);border:1px solid var(--rr-border);border-radius:18px;box-shadow:0 3px 16px #0002;animation:rr-enter 150ms ease-out both;font:12px/1.35 system-ui,sans-serif}.dsh-report-reading-dock button{border:0;background:transparent;border-radius:12px;min-height:28px;padding:2px 6px}.dsh-report-reading-dock button:first-child{display:flex;gap:7px;align-items:center;min-height:36px;padding-left:4px}.dsh-report-reading-dock .rr-dock-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:26px;font-size:18px;color:var(--rr-accent)}.dsh-report-reading-dock button:last-child{width:24px;height:28px;color:var(--rr-muted);font-size:16px}.dsh-report-reading-dock[data-busy=true] .rr-dock-icon{opacity:.6}
      .dsh-report-reading .rr-document>div{color:var(--rr-ink)}.dsh-report-reading .rr-document h1{color:var(--rr-heading-1,var(--rr-accent))}.dsh-report-reading .rr-document h2{color:var(--rr-heading-2,var(--rr-accent))}.dsh-report-reading .rr-document :is(h3,h4,h5,h6){color:var(--rr-ink)}.dsh-report-reading .rr-document li::marker{color:var(--rr-muted)}.dsh-report-reading .rr-document a:not(:where(pre *,code *)){color:var(--rr-link,var(--rr-accent))}.dsh-report-reading .rr-document :not(pre)>code{color:var(--rr-ink)}.dsh-report-reading:not([data-reading-theme=system]) .rr-document :not(pre)>code{background-color:var(--rr-soft)}
      .dsh-report-reading .rr-theme-fields{display:grid;gap:8px}.dsh-report-reading .rr-theme-field{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:11px;color:var(--rr-ink)}.dsh-report-reading .rr-theme-field select{font:inherit;color:var(--rr-ink);background:var(--rr-bg);border:1px solid var(--rr-border);border-radius:6px;padding:4px 7px;min-height:29px;min-width:145px;max-width:190px}.dsh-report-reading .rr-theme-field select:disabled{opacity:.65}.dsh-report-reading .rr-theme-current,.dsh-report-reading .rr-theme-notice{margin:0;font-size:10px;color:var(--rr-muted);line-height:1.7;max-width:290px}.dsh-report-reading .rr-theme-notice{padding-top:3px}
      .dsh-report-reading .rr-appearance{margin-inline-start:auto}.dsh-report-reading .rr-readable-note{max-width:740px;margin:0 auto 24px;display:flex;align-items:flex-start;gap:12px;color:var(--rr-muted);font-size:11px}.dsh-report-reading .rr-readable-note p{flex:1;margin:0}.dsh-report-reading .rr-readable-note button{flex:none;font-size:10px}
      .dsh-report-reading .rr-readable-passage{position:relative;margin-bottom:1.15em;min-width:0}.dsh-report-reading .rr-readable-source{margin:0;color:var(--rr-muted)}
      .dsh-report-reading .rr-source-toggle{position:absolute;inset-inline-start:-28px;top:0;display:flex;align-items:center;justify-content:center;width:28px;height:28px;box-sizing:border-box;padding:0;border-radius:5px;list-style:none;cursor:pointer;color:var(--rr-muted);font:17px/1 system-ui,sans-serif;opacity:0;pointer-events:none;-webkit-tap-highlight-color:transparent}
      .dsh-report-reading .rr-source-toggle::-webkit-details-marker{display:none}.dsh-report-reading .rr-readable-passage:hover .rr-source-toggle,.dsh-report-reading .rr-readable-passage:focus-within .rr-source-toggle,.dsh-report-reading .rr-readable-source[open]>.rr-source-toggle{opacity:1;pointer-events:auto}
      .dsh-report-reading .rr-source-toggle:hover{color:var(--rr-accent);background:var(--rr-soft)}.dsh-report-reading .rr-source-toggle:focus-visible{opacity:1;outline:2px solid var(--rr-accent);outline-offset:1px}
      .dsh-report-reading .rr-readable-original{border-inline-start:2px solid var(--rr-border);padding:3px 0 1px 12px;margin:.35em 0 1em;font-size:.94em;line-height:1.85}
      .dsh-report-reading .rr-source-caption{font-size:10px;color:var(--rr-muted);margin-bottom:5px}.dsh-report-reading .rr-readable-original :last-child{margin-bottom:0}
      @media(hover:none),(pointer:coarse){.dsh-report-reading .rr-source-toggle{opacity:.55;pointer-events:auto}}
      @media(max-width:600px){.dsh-report-reading .rr-readable-document{padding-inline-start:13px;box-sizing:border-box}}
      @keyframes rr-enter{from{opacity:0;transform:translateY(7px) scale(.99)}to{opacity:1;transform:none}}@keyframes rr-locate{0%,70%{opacity:.9}100%{opacity:0}}@media(prefers-reduced-motion:reduce){.dsh-report-reading,.dsh-report-reading-dock{animation:none;scroll-behavior:auto}.dsh-report-reading .rr-document p[data-rr-locate]:before{animation:none;opacity:.9}}
      .dsh-report-reading .rr-review-nav,.dsh-report-reading .rr-review-marker{display:flex;align-items:center;gap:4px 10px;flex-wrap:wrap;font-size:12px;color:var(--rr-muted)}
      .dsh-report-reading .rr-review-nav{max-width:740px;margin:0 auto 18px;padding-bottom:8px;border-bottom:1px solid var(--rr-border)}
      .dsh-report-reading .rr-review-marker{margin:0 0 5px}.dsh-report-reading .rr-review-marker span{border-inline-start:2px solid var(--rr-accent);padding-inline-start:7px}
      .dsh-report-reading :is(.rr-review-nav,.rr-review-marker) button{font:inherit;color:var(--rr-accent);border:0;background:transparent;padding:3px 2px;text-decoration:underline;text-underline-offset:3px}
      .dsh-report-reading .rr-readable-passage:focus-visible{outline:2px solid var(--rr-accent);outline-offset:4px}
      @media(max-width:600px){.dsh-report-reading,.dsh-report-reading[data-wide=true]{right:7px;bottom:max(7px,env(safe-area-inset-bottom));width:calc(100vw - 14px);height:calc(100dvh - 60px);max-height:calc(100dvh - 60px);border-radius:12px}.dsh-report-reading .rr-head{padding:10px;gap:5px}.dsh-report-reading .rr-head-title h2{font-size:13px}.dsh-report-reading .rr-head-title small{font-size:9px}.dsh-report-reading .rr-head-actions{gap:3px}.dsh-report-reading .rr-head-actions button{font-size:10px;padding:4px 6px}.dsh-report-reading .rr-toolbar{padding:9px 10px;gap:4px}.dsh-report-reading .rr-content{padding:23px 17px 30px}.dsh-report-reading .rr-document{font-size:14px;line-height:1.95}.dsh-report-reading .rr-intro{align-items:flex-start;gap:9px;font-size:11px}.dsh-report-reading .rr-footer{padding:8px 10px}.dsh-report-reading .rr-status{padding:7px 10px}}
      @media(max-width:330px){.dsh-report-reading .rr-head-title small{display:none}.dsh-report-reading .rr-head-actions button{padding:3px 5px;min-width:26px}.dsh-report-reading .rr-toolbar{align-items:flex-start}.dsh-report-reading .rr-content{padding:18px 13px}}
    `;
    const reportReadingListeners=new Set();
    const reportReadingRuntime={root:null,container:null,target:null,minimized:false,previousFocus:null,
      open(sessionId,seq,markdownOwner){
        if(typeof createChatRoot!=='function')throw Error('当前客户端暂不支持独立阅读页，请升级 DSH。');
        if(chatRuntime.opened&&!chatRuntime.minimized)chatRuntime.setMinimized(true);
        if(!this.root){this.container=document.createElement('div');this.container.dataset.personaShell='report-reading-runtime';document.body.appendChild(this.container);this.root=createChatRoot(this.container);}
        this.previousFocus=document.activeElement;this.minimized=false;this.target={sessionId,seq};
        this.root.render(h(ReportVisualizationWindow,{key:rowKey(sessionId,seq),sessionId,seq,markdownOwner,onClose:()=>this.close()}));
        for(const notify of reportReadingListeners)notify(false);
      },
      minimize(){if(!this.target||this.minimized)return;this.minimized=true;for(const notify of reportReadingListeners)notify(true);},
      restore(){if(!this.target)return;if(chatRuntime.opened&&!chatRuntime.minimized)chatRuntime.setMinimized(true);this.minimized=false;for(const notify of reportReadingListeners)notify(false);},
      close(){this.root?.render(null);this.target=null;this.minimized=false;if(this.previousFocus?.isConnected)this.previousFocus.focus({preventScroll:true});},
      dispose(){this.root?.unmount();this.container?.remove();this.root=null;this.container=null;this.target=null;this.minimized=false;reportReadingListeners.clear();}
    };
    const reportReadingError=reason=>({
      'report-not-found':'这份报告尚未保留完整原文。可以在后续任务的最终汇报中使用阅读页。',
      'report-unavailable':'这份报告尚未保留完整原文。可以在后续任务的最终汇报中使用阅读页。',
      'source-unavailable':'这份报告没有可读取的完整原文。',
      'report-incomplete':'报告还没有完整结束，请等最终汇报完成后再打开。',
      'report-too-long':'原报告超过本次分析的上限，没有截断处理。请在工作会话查看完整原文。',
      'too-long':'原报告超过本次可整理的上限，没有截断处理。',
      'report-source-changed':'这份报告的原文已更新，请重新读取后再整理。',
      'report-visualization-conflict':'报告原文或整理设置已变化，请重新读取后再试。',
      'report-visualization-invalid':'这次整理未通过内容或原文依据检查，原报告和已有阅读页均保留。',
      'report-invalid-output':'这次整理未通过检查，原报告和已有阅读页均保留。',
      'report-visualization-busy':'这份报告正在整理，请稍后重新读取。',
      'report-busy':'这份报告正在整理，请稍后重新读取。',
      'report-request-conflict':'本次整理请求已变化，请重新读取后再试。',
      'report-capacity':'同时整理的报告较多，请等已有任务完成后再试。',
      'report-model-unavailable':'暂时没有可用模型，请在设置中选择转述或报告阅读模型。',
      'report-thinking-unavailable':'当前报告阅读模型无法启用思考，原文和已有顺畅稿均保留；请更换模型，或在插件设置中关闭顺畅阅读思考后重试。',
      'report-save-failed':'这次阅读页没有保存成功，原报告和已有阅读页均保留，可以重新整理。',
      'report-timeout':'这次整理等待超时，原报告和已有阅读页均保留，可以手动重试。',
      'report-cancelled':'这次整理已停止，原报告和已有阅读页均保留。',
      'storage-not-ready':'本地保存服务尚未就绪，请稍后重新读取。',
      'model-unavailable':'暂时没有可用模型，请在设置中选择转述或报告阅读模型。',
      'disposed':'插件已重载，请关闭后重新打开阅读页。',
    }[reason]??'这次读取或整理没有完成，原报告和已有阅读页均保留，可以手动重试。');
    function reportIssueExplanation(issue){
      const code=typeof issue?.code==='string'?issue.code:'';
      if(code==='readable-all-fallback')return'这次返回的正文没有可采用的段落。当前显示的仍是上次保存的顺畅稿，没有自动重试。';
      if(code==='source-invalid')return'原文快照暂时无法核对。请先重新读取这份报告，再决定是否重新生成。';
      if(/(?:refs?|reference|citation|evidence)/i.test(code))return'有内容缺少有效的原文依据，无法安全整理。请先查看原文，或手动重新生成一次。';
      if(/(?:number|literal|command|path|version|ground)/i.test(code))return'有数字、路径或命令无法与引用的原文对应。为避免改错技术内容，这次没有采用该结果。';
      if(/(?:length|long|limit|budget)/i.test(code))return'返回的内容超过阅读页的长度限制。原文没有被截断；可以尝试使用输出更简洁的模型。';
      if(/(?:state|badge|status)/i.test(code))return'返回的验证状态无法从原文确认，这次没有把它当成已验证的结果。';
      if(/(?:unsafe|execut|script|html)/i.test(code))return'返回内容含有阅读页不支持的代码或界面指令，因此没有显示。原文仍可查看。';
      if(/(?:json|schema|format|field|type|duplicate|structure|template)/i.test(code))return'模型返回的结构没有完整匹配阅读页格式。这通常是输出格式问题，原文和已有结果没有改变。';
      return'这次返回内容未能完成格式或原文依据核对。没有自动追加模型调用，原文与已有阅读页仍然保留。';
    }
    function useReportReadingLayout(root,source,plan,focused,jump,onStatus,active=true){
      const opened=React.useRef({hash:source.hash,ids:new Set()}),handledJump=React.useRef(null),continuity=React.useRef(null),locator=React.useRef(null),activeView=React.useRef(active);
      activeView.current=active;
      const clearLocator=()=>{const own=locator.current;if(!own)return;locator.current=null;own.view.clearTimeout(own.timer);
        if(own.blur)own.node.removeEventListener('blur',own.blur);
        for(const [name,value]of own.attrs){if(own.node.getAttribute(name)!==value.written)continue;if(value.before===null)own.node.removeAttribute(name);else own.node.setAttribute(name,value.before);}};
      useLayoutEffect(()=>{if(!active)clearLocator();return clearLocator;},[active,source.hash]);
      if(opened.current.hash!==source.hash){opened.current={hash:source.hash,ids:new Set()};handledJump.current=null;continuity.current=null;}
      useLayoutEffect(()=>{
        const element=root.current,view=element?.ownerDocument.defaultView;if(!element||!view)return;
        let frame,live=true,observer,records=[],targets=new Map(),foldRecords=[];
        const normalize=text=>String(text??'').replace(/\s+/gu,' ').trim();
        const remember=(node,name,value)=>{let record=records.find(item=>item.node===node);if(!record){record={node,attrs:new Map()};records.push(record);}if(!record.attrs.has(name))record.attrs.set(name,{before:node.getAttribute(name),written:value});else record.attrs.get(name).written=value;
          if(value===null)node.removeAttribute(name);else node.setAttribute(name,value);};
        const clear=()=>{for(const item of foldRecords)item.button.remove();foldRecords=[];
          for(const {node,attrs}of records)for(const [name,value]of attrs){if(node.getAttribute(name)!==value.written)continue;if(value.before===null)node.removeAttribute(name);else node.setAttribute(name,value.before);}records=[];};
        const report=()=>onStatus?.({targets:[...targets.keys()],foldable:[...targets.values()].filter(item=>item.entry.foldable===true&&item.entry.keep===false).length,folded:foldRecords.filter(item=>!opened.current.ids.has(item.entry.blockId)).length});
        const observe=()=>observer?.observe(element,{subtree:true,childList:true,characterData:true});
        const visibleAnchor=()=>{const content=element.closest('.rr-content');if(!content)return null;const top=content.getBoundingClientRect().top;
          const node=[...element.querySelectorAll('p')].find(paragraph=>!paragraph.closest('[hidden]')&&paragraph.getBoundingClientRect().bottom>top+10);
          return node?{node,top:node.getBoundingClientRect().top-top,hash:source.hash}:null;};
        const setDisclosure=(record,expanded)=>{
          if(expanded){remember(record.node,'hidden',null);remember(record.node,'data-rr-hidden',null);}else{remember(record.node,'hidden','');remember(record.node,'data-rr-hidden','true');}
          record.button.textContent=expanded?'收起这段说明':'展开这段说明';record.button.setAttribute('aria-expanded',String(expanded));
          const preview=record.entry.matchText.slice(0,96);record.button.title=preview;
          record.button.setAttribute('aria-label',(expanded?'收起':'展开')+'第 '+record.index+' 段说明：'+preview);
        };
        const apply=()=>{frame=undefined;if(!live||!element.isConnected)return;observer?.disconnect();
          const focusedBlock=foldRecords.find(item=>item.button===element.ownerDocument.activeElement)?.entry.blockId;
          const content=element.closest('.rr-content'),previous=continuity.current?.hash===source.hash&&continuity.current.node.isConnected?continuity.current:visibleAnchor();continuity.current=null;
          const anchor=previous?.node,oldTop=previous?.top;
          clear();targets=new Map();
          if(plan?.sourceHash!==source.hash||!Array.isArray(plan?.entries)||source.blocks.map(block=>block.text).join('')!==source.text){report();observe();return;}
          const paragraphs=[...element.querySelectorAll('p')],byText=new Map(),entryTexts=new Map(),sourceBlocks=new Map();let offset=0;
          for(const block of source.blocks){sourceBlocks.set(block.id,{...block,start:offset});offset+=block.text.length;}
          for(const node of paragraphs){const text=normalize(node.textContent);if(text)byText.set(text,[...(byText.get(text)??[]),node]);}
          for(const entry of plan.entries)if(typeof entry.matchText==='string'&&normalize(entry.matchText))entryTexts.set(normalize(entry.matchText),(entryTexts.get(normalize(entry.matchText))??0)+1);
          for(const entry of plan.entries){const text=typeof entry.matchText==='string'?normalize(entry.matchText):'',matches=byText.get(text),block=sourceBlocks.get(entry.blockId);
            if(!text||entryTexts.get(text)!==1||matches?.length!==1||!block||block.kind==='code'||entry.start!==block.start||entry.end!==block.start+block.text.length)continue;
            const node=matches[0];if(node.closest('li,table,blockquote,pre,code,button,svg,math,.katex,[hidden]')||node.querySelector('a,button,input,textarea,svg,math,.katex,[data-no-emphasis]'))continue;
            targets.set(entry.blockId,{entry,node});
          }
          const pending=locator.current;if(pending&&(!pending.node.isConnected||targets.get(pending.blockId)?.node!==pending.node))clearLocator();
          const requested=activeView.current&&jump?.sourceHash===source.hash&&handledJump.current!==jump.token?targets.get(jump.blockId):null;
          if(requested)opened.current.ids.add(jump.blockId);
          if(focused)for(const {entry,node}of targets.values())if(entry.foldable===true&&entry.keep===false){
            const button=element.ownerDocument.createElement('button'),index=plan.entries.findIndex(item=>item.blockId===entry.blockId)+1;
            button.type='button';button.className='rr-fold-toggle';button.dataset.rrOwned='fold';
            const id=node.id||'rr-'+source.hash.slice(0,12)+'-'+entry.blockId;remember(node,'id',id);button.setAttribute('aria-controls',id);
            const record={entry,node,button,index};foldRecords.push(record);setDisclosure(record,opened.current.ids.has(entry.blockId));node.before(button);
            button.addEventListener('click',()=>{observer?.disconnect();const expanded=!opened.current.ids.has(entry.blockId);
              if(expanded)opened.current.ids.add(entry.blockId);else opened.current.ids.delete(entry.blockId);
              setDisclosure(record,expanded);report();observe();});
          }
          if(requested){handledJump.current=jump.token;clearLocator();
            const own={node:requested.node,blockId:jump.blockId,view,attrs:new Map(),timer:null};
            const locate=(name,value)=>{own.attrs.set(name,{before:own.node.getAttribute(name),written:value});own.node.setAttribute(name,value);};
            locate('data-rr-locate',requested.entry.role==='risk'?'risk':'context');
            if(jump.keyboard)locate('tabindex','-1');
            locator.current=own;own.timer=view.setTimeout(()=>{if(locator.current!==own)return;own.timer=null;
              const cue=own.attrs.get('data-rr-locate');if(own.node.getAttribute('data-rr-locate')===cue.written){if(cue.before===null)own.node.removeAttribute('data-rr-locate');else own.node.setAttribute('data-rr-locate',cue.before);}own.attrs.delete('data-rr-locate');
              // Removing tabindex while the paragraph is focused makes Chromium drop keyboard focus.
              if(own.attrs.has('tabindex')&&own.node.ownerDocument.activeElement===own.node){own.blur=()=>{if(locator.current===own)clearLocator();};own.node.addEventListener('blur',own.blur,{once:true});}
              else clearLocator();},2200);
            if(content){const bounds=content.getBoundingClientRect();content.scrollTop+=requested.node.getBoundingClientRect().top-bounds.top-18;}
            if(jump.keyboard)requested.node.focus({preventScroll:true});
          }else if(content&&anchor?.isConnected&&oldTop!==undefined){const replacement=anchor.hidden?foldRecords.find(item=>item.node===anchor)?.button:anchor;
            if(replacement)content.scrollTop+=replacement.getBoundingClientRect().top-content.getBoundingClientRect().top-oldTop;}
          if(!requested&&focusedBlock)foldRecords.find(item=>item.entry.blockId===focusedBlock)?.button.focus({preventScroll:true});
          report();observe();
        };
        const schedule=()=>{if(frame===undefined)frame=view.requestAnimationFrame(apply);};
        observer=typeof view.MutationObserver==='function'?new view.MutationObserver(schedule):null;apply();
        return()=>{live=false;observer?.disconnect();if(frame!==undefined)view.cancelAnimationFrame(frame);clearLocator();continuity.current=activeView.current?visibleAnchor():null;clear();};
      },[source.hash,source.text,source.blocks,plan,focused,jump]);
    }
    function ReportOriginalDocument({source,readingPlan,focused,jump,onReadingStatus,active,media}){
      const root=React.useRef(null);
      const markdown=React.useMemo(()=>renderMarkdown(source.text,false,{margin:0},media),[source.text,media]);
      useReportReadingLayout(root,source,readingPlan,focused,jump,onReadingStatus,active);
      return h('div',{ref:root,className:'rr-document','data-source-hash':source.hash,'aria-label':'原始报告全文'},markdown);
    }
    function readableReportMatches(value,source){
      return value?.schemaVersion===3&&Array.isArray(value.blocks)&&value.blocks.length===source.blocks.length
        &&value.blocks.every((block,index)=>block?.ref===source.blocks[index].id&&typeof block.text==='string'&&block.text.trim());
    }
    function readableReviewLocations(warnings,length){
      const marked=new Map(),unlocated=new Set();
      for(const warning of Array.isArray(warnings)?warnings:[]){
        const code=warning?.code;
        if(code!=='readable-block-original'&&code!=='readable-wording-review')continue;
        const match=/^\$\.blocks\[(0|[1-9]\d*)\](?:\.text)?$/.exec(warning.path);
        const index=match?Number(match[1]):-1;
        if(index<0||index>=length){unlocated.add(code);continue;}
        if(!marked.has(index)||code==='readable-block-original')marked.set(index,code);
      }
      return {marked,ordered:[...marked.keys()].sort((a,b)=>a-b),unlocated};
    }
    function ReportReadableSource({text,media,references}){
      const [expanded,setExpanded]=React.useState(false);
      const original=React.useMemo(()=>expanded?renderMarkdown(text,false,{margin:0},media,references):null,[expanded,text,media,references]);
      return h('details',{className:'rr-readable-source',onToggle:event=>setExpanded(event.currentTarget.open)},
        h('summary',{className:'rr-source-toggle',title:expanded?'收起本段原文':'核对本段原文','aria-label':'核对本段原文'},
          h('span',{'aria-hidden':true},'↔'),h('span',{className:'rr-sr-only'},'核对原文')),
        expanded?h('div',{className:'rr-readable-original',role:'region','aria-label':'本段原文'},h('div',{className:'rr-source-caption'},'原文'),original):null);
    }
    function ReportReadableDocument({source,result,warnings,media}){
      const root=React.useRef(null);
      const passages=React.useMemo(()=>result.blocks.map((block,index)=>({ref:block.ref,text:block.text,
        original:source.blocks[index].text,references:source.blocks[index].kind!=='code',content:renderMarkdown(block.text,false,{margin:0},media,source.blocks[index].kind!=='code')})),[source,result,media]);
      const {marked,ordered,unlocated}=React.useMemo(()=>readableReviewLocations(warnings,passages.length),[warnings,passages.length]);
      const locate=index=>{
        const section=root.current?.children[index],pane=root.current?.closest('.rr-content');
        if(!pane||!section||section.dataset.readableRef!==passages[index]?.ref)return;
        section.focus({preventScroll:true});
        pane.scrollTop+=section.getBoundingClientRect().top-pane.getBoundingClientRect().top-18;
      };
      return h(React.Fragment,null,
        ordered.length?h('nav',{className:'rr-review-nav','aria-label':'顺畅稿段落核对'},h('span',null,'已标出 '+ordered.length+' 段'),h('button',{type:'button',onClick:()=>locate(ordered[0])},'查看第一处')):null,
        unlocated.has('readable-block-original')?h('p',{className:'rr-reading-status'},'部分段落保留了原文，可就地核对。'):null,
        unlocated.has('readable-wording-review')?h('p',{className:'rr-reading-status'},'部分表达建议对照原文核对。'):null,
        h('div',{ref:root,className:'rr-document rr-readable-document','data-source-hash':source.hash,'aria-label':'顺畅阅读稿'},
        ...passages.map((block,index)=>{
          const code=marked.get(index),label=code==='readable-block-original'?'已保留原文':'建议核对措辞';
          return h('section',{key:block.ref,className:'rr-readable-passage','data-readable-ref':block.ref,
            ...(code?{tabIndex:-1,'aria-label':'第 '+(index+1)+' 段：'+label}:{})},
          code?h('div',{className:'rr-review-marker'},h('span',null,label),ordered.length>1?h('button',{type:'button',onClick:()=>locate(ordered[(ordered.indexOf(index)+1)%ordered.length])},'下一处'):null):null,block.content,
          block.text.trim()!==block.original.trim()?h(ReportReadableSource,{text:block.original,media,references:block.references}):null);
        })));
    }
    const READABLE_NOTICE_KEY='dsh-persona-shell:readable-notice:v1';
    function readableLocalDate(){const date=new Date();return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');}
    function readableNoticeDismissedToday(){try{return localStorage.getItem(READABLE_NOTICE_KEY)===readableLocalDate();}catch{return false;}}
    function ReadableGenerationNotice({onClose,onConfirm}){
      const [today,setToday]=React.useState(false),content=React.useRef(null),cancel=React.useRef(null);
      useLayoutEffect(()=>{const dialog=content.current?.closest('dialog');if(!dialog)return;cancel.current?.focus({preventScroll:true});
        const trap=event=>{if(event.key!=='Tab')return;const controls=[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')].filter(node=>!node.closest('[hidden]'));
          const first=controls[0],last=controls.at(-1),active=dialog.ownerDocument.activeElement;
          if((event.shiftKey&&(active===first||!dialog.contains(active)))||(!event.shiftKey&&(active===last||!dialog.contains(active)))){event.preventDefault();(event.shiftKey?last:first)?.focus();}};
        dialog.addEventListener('keydown',trap,true);return()=>dialog.removeEventListener('keydown',trap,true);},[]);
      return h(ActionDialog,{title:'生成前请留意',onClose},h('div',{ref:content},
        h('p',null,'顺畅稿由模型润色，不保证信息准确，也可能遗漏内容或改变原意。重要结论和操作条件，请对照原文核对。'),
        h('label',{style:{display:'flex',alignItems:'center',gap:8}},h('input',{type:'checkbox',checked:today,onChange:event=>setToday(event.target.checked)}),'今日不再提醒'),
        h('div',{className:'dsh-persona-action-buttons'},h('button',{ref:cancel,type:'button',onClick:onClose},'取消'),
          h('button',{type:'button','data-primary':'',onClick:()=>onConfirm(today)},'确认生成'))));
    }
    function ReportVisualizationWindow({sessionId,seq,onClose,markdownOwner}){
      const readingTheme=useReportTheme(),themeStyle={...readingTheme.theme.vars,colorScheme:readingTheme.theme.appearance};
      const [data,setData]=React.useState(null),[loading,setLoading]=React.useState(true),[busy,setBusy]=React.useState(false),[info,setInfo]=React.useState(''),[issue,setIssue]=React.useState(null);
      const [wide,setWide]=React.useState(false),[minimized,setMinimized]=React.useState(reportReadingRuntime.minimized);
      const [focused,setFocused]=React.useState(false),[readingStatus,setReadingStatus]=React.useState({targets:[],foldable:0,folded:0}),[jump,setJump]=React.useState(null),[guidePosition,setGuidePosition]=React.useState(null);
      const [readable,setReadable]=React.useState(false),[readableData,setReadableData]=React.useState(null),[readableLoading,setReadableLoading]=React.useState(false),[readableBusy,setReadableBusy]=React.useState(false),[readableInfo,setReadableInfo]=React.useState(''),[readableIssue,setReadableIssue]=React.useState(null);
      const [readableNotice,setReadableNotice]=React.useState(null),readableNoticeRef=React.useRef(null);
      const readableLifetime=React.useRef({live:true,revision:0,abort:null,task:null,loadedHash:null});
      const guideCursors=React.useRef(new Map()),jumpSequence=React.useRef(0);
      const lifetime=React.useRef({live:true,revision:0,abort:null,task:null}),heading=React.useRef(null),surface=React.useRef(null),dock=React.useRef(null),dockSurface=React.useRef(null),readingPosition=React.useRef(0);
      const modePositions=React.useRef({original:0,readable:0});
      const floating=useFloatingWindow({id:'report-reading',ref:surface,active:!minimized,wide,onWideChange:setWide,minWidth:320,minHeight:300});
      useFloatingDock(dockSurface,minimized);
      const latest=React.useRef(data);latest.current=data;
      const clearReadableNotice=()=>{readableNoticeRef.current=null;setReadableNotice(null);};
      const stop=()=>{const own=lifetime.current,task=own.task;own.revision++;own.abort?.abort();own.abort=null;own.task=null;
        if(task)void actionRequest('report-visualization',{action:'cancel',sessionId,seq,presentation:'emphasis',requestId:task.requestId,sourceHash:task.hash}).catch(()=>{});};
      const stopReadable=()=>{clearReadableNotice();const own=readableLifetime.current,task=own.task;own.revision++;own.abort?.abort();own.abort=null;own.task=null;
        if(task)void actionRequest('report-visualization',{action:'cancel',sessionId,seq,presentation:'readable',requestId:task.requestId,sourceHash:task.hash}).catch(()=>{});};
      const acceptReadable=(value,source)=>{
        if(!value?.source||value.source.sessionId!==sessionId||value.source.seq!==seq||value.source.hash!==source.hash)throw Error('report-source-changed');
        if(value.result&&!readableReportMatches(value.result,source))throw Error('report-invalid-output');
        if(!value.result&&value.cached!==false)throw Error('report-invalid-output');
        setReadableData(value);
      };
      const loadReadable=async(force=false)=>{const own=readableLifetime.current,source=latest.current?.source;
        if(!source||(!force&&own.loadedHash===source.hash)||own.abort)return;
        stopReadable();const token=own.revision,abort=new AbortController();own.abort=abort;setReadableLoading(true);setReadableInfo('');setReadableIssue(null);
        try{const response=await fetch(ROUTE+'/report-visualization?session='+encodeURIComponent(sessionId)+'&seq='+seq+'&presentation=readable',{signal:abort.signal});const value=await response.json();
          if(!own.live||token!==own.revision)return;if(!response.ok)throw Object.assign(Error(value.error??value.reason),{issue:value.issue});
          if(latest.current?.source?.hash!==source.hash)throw Error('report-source-changed');acceptReadable(value,source);own.loadedHash=source.hash;
        }catch(error){if(own.live&&token===own.revision&&!abort.signal.aborted){setReadableInfo(reportReadingError(error.message));setReadableIssue(error.issue??null);}}
        finally{if(own.live&&token===own.revision){own.abort=null;setReadableLoading(false);}}
      };
      const generateReadable=async(regenerate=false,expectedHash)=>{const own=readableLifetime.current,source=latest.current?.source;
        // Local jobs own the live busy state. A cache read's running flag is only a snapshot;
        // the Host still rejects a conflicting job without permanently disabling this action.
        if(!source||(expectedHash&&source.hash!==expectedHash)||!own.live||own.abort||own.task||reportReadingRuntime.minimized||readableBusy||readableLoading||busy||loading||!latest.current?.available)return;
        stopReadable();const token=own.revision,abort=new AbortController(),requestId=chatNonce();own.abort=abort;own.task={requestId,hash:source.hash};setReadableBusy(true);setReadableInfo('正在整理句子，原文和已有顺畅稿保留。');setReadableIssue(null);
        try{const response=await fetch(ROUTE+'/report-visualization',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
          body:JSON.stringify({action:'generate',sessionId,seq,presentation:'readable',sourceHash:source.hash,requestId,...(regenerate?{regenerate:true}:{})})});const value=await response.json();
          if(!own.live||token!==own.revision)return;if(!response.ok)throw Object.assign(Error(value.error??value.reason),{issue:value.issue});
          if(latest.current?.source?.hash!==source.hash)throw Error('report-source-changed');if(!readableReportMatches(value.result,source))throw Error('report-invalid-output');acceptReadable(value,source);own.loadedHash=source.hash;setReadableInfo(own.task?.stopRequested?'已保存本次顺畅稿。':'');
        }catch(error){if(own.live&&token===own.revision&&!abort.signal.aborted){setReadableInfo(error.message==='report-cancelled'?'已停止整理，原文和已有顺畅稿保留。':error.issue?.code==='readable-all-fallback'?'这次没有可用的润色段落，已保留上次的顺畅稿。':reportReadingError(error.message));setReadableIssue(error.issue??null);}}
        finally{if(own.live&&token===own.revision){own.abort=null;own.task=null;setReadableBusy(false);}}
      };
      const requestReadable=(regenerate=false)=>{const own=readableLifetime.current,source=latest.current?.source;
        if(!source||!own.live||own.abort||own.task||readableNoticeRef.current||readableBusy||readableLoading||busy||loading||!latest.current?.available)return;
        if(readableNoticeDismissedToday()){void generateReadable(regenerate,source.hash);return;}
        const pending={hash:source.hash,regenerate};readableNoticeRef.current=pending;setReadableNotice(pending);
      };
      const confirmReadable=today=>{const pending=readableNoticeRef.current;clearReadableNotice();
        if(!pending||!readableLifetime.current.live||reportReadingRuntime.minimized||latest.current?.source?.hash!==pending.hash
          ||reportReadingRuntime.target?.sessionId!==sessionId||reportReadingRuntime.target?.seq!==seq)return;
        if(today)try{localStorage.setItem(READABLE_NOTICE_KEY,readableLocalDate());}catch{/* This confirmation still applies; a later request may remind again. */}
        void generateReadable(pending.regenerate,pending.hash);
      };
      const accept=value=>{
        if(value?.source&&(value.source.sessionId!==sessionId||value.source.seq!==seq||typeof value.source.hash!=='string'||typeof value.source.text!=='string'||!Array.isArray(value.source.blocks)))throw Error('report-source-changed');
        const compatible=value?.result?.schemaVersion===2&&Array.isArray(value.result.annotations);
        const next={...value,result:compatible?value.result:undefined,cached:compatible&&value.cached===true};setData(next);latest.current=next;
      };
      const load=async(refreshReadable=false)=>{stop();const own=lifetime.current,token=own.revision,abort=new AbortController(),previousHash=latest.current?.source?.hash;own.abort=abort;setLoading(true);setInfo('');setIssue(null);
        try{const response=await fetch(ROUTE+'/report-visualization?session='+encodeURIComponent(sessionId)+'&seq='+seq+'&presentation=emphasis',{signal:abort.signal});const value=await response.json();
          if(!own.live||token!==own.revision)return;if(!response.ok)throw Object.assign(Error(value.error??value.reason),{issue:value.issue});accept(value);
          if(!value.available)setInfo(reportReadingError(value.reason));
          else if(refreshReadable&&previousHash===value.source?.hash)await loadReadable(true);
        }catch(error){if(own.live&&token===own.revision&&!abort.signal.aborted){setInfo(reportReadingError(error.message));setIssue(error.issue??null);if(refreshReadable){setReadableInfo(reportReadingError(error.message));setReadableIssue(error.issue??null);}}}
        finally{if(own.live&&token===own.revision){setLoading(false);own.abort=null;}}
      };
      React.useEffect(()=>{lifetime.current.live=true;readableLifetime.current.live=true;void load();return()=>{lifetime.current.live=false;readableLifetime.current.live=false;stop();stopReadable();};},[sessionId,seq]);
      React.useEffect(()=>{const update=value=>{if(value){clearReadableNotice();readingPosition.current=surface.current?.querySelector('.rr-content')?.scrollTop??0;}setMinimized(value);};reportReadingListeners.add(update);return()=>reportReadingListeners.delete(update);},[]);
      useLayoutEffect(()=>{if(minimized){dock.current?.focus({preventScroll:true});return;}const content=surface.current?.querySelector('.rr-content');if(content)content.scrollTop=readingPosition.current;heading.current?.focus({preventScroll:true});return enterChatSurface(surface.current);},[minimized]);
      useLayoutEffect(()=>{const content=surface.current?.querySelector('.rr-content');if(content)content.scrollTop=modePositions.current[readable?'readable':'original'];},[readable]);
      const generate=async(regenerate=false)=>{const own=lifetime.current,source=latest.current?.source;if(busy||loading||!latest.current?.available||!source)return;
        stop();const token=own.revision,abort=new AbortController(),requestId=chatNonce();own.abort=abort;own.task={requestId,hash:source.hash};setBusy(true);setInfo('正在分析阅读重点，原始报告保持不变。');setIssue(null);
        try{const response=await fetch(ROUTE+'/report-visualization',{method:'POST',headers:{'content-type':'application/json'},signal:abort.signal,
          body:JSON.stringify({action:'generate',sessionId,seq,presentation:'emphasis',sourceHash:source.hash,requestId,...(regenerate?{regenerate:true}:{})})});const value=await response.json();
          if(!own.live||token!==own.revision)return;if(!response.ok)throw Object.assign(Error(value.error??value.reason),{issue:value.issue});
          if(value.result?.schemaVersion!==2||!Array.isArray(value.result.annotations)||value.source?.hash!==source.hash)throw Error('report-source-changed');accept(value);setInfo(own.task?.stopRequested?'已保存本次阅读重点。':'');
        }catch(error){if(own.live&&token===own.revision&&!abort.signal.aborted){setInfo(error.message==='report-cancelled'?'已停止分析，原文和已有导览保留。':reportReadingError(error.message));setIssue(error.issue??null);}}
        finally{if(own.live&&token===own.revision){setBusy(false);own.abort=null;own.task=null;}}
      };
      const source=data?.source,result=data?.result;
      // The opener owns this report's resource scope, even after the main session changes.
      // A changed report must never inherit another source's cwd or callbacks.
      const media=React.useMemo(()=>reportMarkdownMedia(markdownOwner?.sessionId===sessionId&&markdownOwner?.seq===seq
        &&markdownOwner?.text===source?.text?markdownOwner:undefined,source),[markdownOwner,sessionId,seq,source?.text]);
      const readableResult=source&&readableData?.source?.hash===source.hash&&readableReportMatches(readableData.result,source)?readableData.result:null;
      const readingPlan=React.useMemo(()=>source?createReportReadingPlan(source,result):null,[source,result]);
      React.useEffect(()=>{setFocused(false);setJump(null);setGuidePosition(null);guideCursors.current.clear();stopReadable();readableLifetime.current.loadedHash=null;setReadableData(null);setReadableLoading(false);setReadableBusy(false);setReadableInfo('');setReadableIssue(null);modePositions.current={original:0,readable:0};setReadable(false);},[source?.hash]);
      const guideLabels={result:'主要结果',risk:'风险与条件',decision:'需要你确认',evidence:'验证依据',next:'下一步'};
      const targetIds=new Set(readingStatus.targets),guideGroups=['result','risk','decision','evidence','next'].map(kind=>({kind,items:(readingPlan?.navigation??[]).filter(item=>item.kind===kind&&targetIds.has(item.blockId))})).filter(group=>group.items.length);
      const navigate=(group,event)=>{const index=((guideCursors.current.get(group.kind)??-1)+1)%group.items.length;guideCursors.current.set(group.kind,index);
        setGuidePosition({kind:group.kind,index:index+1,total:group.items.length});setJump({blockId:group.items[index].blockId,token:++jumpSequence.current,sourceHash:source.hash,keyboard:event.detail===0});};
      const warnings=Array.isArray(data?.warnings)?data.warnings:[],contentWarnings=warnings.filter(warning=>!['json-fence-normalized','schema-version-defaulted','duplicate-refs-normalized'].includes(warning?.code));
      // Keep the generation response attached: only it can report whether a pending save committed.
      const requestStop=async(isReadable)=>{
        const own=(isReadable?readableLifetime:lifetime).current,task=own.task;
        if(!own.live||!task||task.stopRequested)return;
        const show=isReadable?setReadableInfo:setInfo;
        task.stopRequested=true;show('正在请求停止…');
        try{
          const {ok,value}=await actionRequest('report-visualization',{action:'cancel',sessionId,seq,presentation:isReadable?'readable':'emphasis',requestId:task.requestId,sourceHash:task.hash});
          if(!own.live||own.task!==task)return;
          if(!ok)throw Error('cancel-request-failed');
          if(value?.outcome==='saving')show('正在保存，完成后会显示结果。');
        }catch{if(own.live&&own.task===task){task.stopRequested=false;show('停止请求未送达，仍在等待本次结果。');}}
      };
      const copy=async()=>{if(!source)return;try{await navigator.clipboard.writeText(source.text);setInfo('已复制完整原文。');}catch{setInfo('当前环境暂不支持复制，请选中原文后复制。');}};
      const copyReadable=async()=>{if(!readableResult)return;try{await navigator.clipboard.writeText(readableResult.blocks.map(block=>block.text.trim()).join('\n\n'));setReadableInfo('已复制顺畅稿。原始报告仍可在「完整原文」中核对。');}catch{setReadableInfo('当前环境暂不支持复制，请选中顺畅稿后复制。');}};
      const close=()=>{stop();stopReadable();onClose();};
      const selectReadable=value=>{if(!value)clearReadableNotice();if(value!==readable){modePositions.current[readable?'readable':'original']=surface.current?.querySelector('.rr-content')?.scrollTop??0;setReadable(value);}if(value)void loadReadable();};
      const visibleInfo=readable?readableInfo:info,visibleIssue=readable?readableIssue:issue,visibleModel=readable?readableData?.model:data?.model,anyBusy=busy||readableBusy;
      const readingChanged=value=>setReadingStatus(previous=>previous.foldable===value.foldable&&previous.folded===value.folded&&previous.targets.join('|')===value.targets.join('|')?previous:value);
      return h(React.Fragment,null,h('style',null,REPORT_READING_CSS,FLOATING_WINDOW_CSS),readableNotice&&!minimized?h(ReadableGenerationNotice,{onClose:clearReadableNotice,onConfirm:confirmReadable}):null,minimized?h('div',{ref:dockSurface,className:'dsh-report-reading-dock','data-dock-order':1,'data-busy':anyBusy,style:themeStyle,role:'region','aria-label':'已最小化的报告阅读页'},
        h('button',{ref:dock,type:'button','aria-label':'恢复报告阅读页',title:anyBusy?'正在整理报告':'原始报告与阅读导览',onClick:()=>reportReadingRuntime.restore()},h('span',{className:'rr-dock-icon','aria-hidden':true},'▤'),h('span',null,anyBusy?'整理中':'阅读页')),
        h('button',{type:'button','aria-label':'关闭报告阅读页',title:anyBusy?'关闭并停止本页未完成的生成':'关闭报告阅读页',onClick:close},'×')):null,
        h('section',{ref:surface,className:'dsh-report-reading',role:'dialog','aria-label':'报告阅读页','aria-modal':false,'data-wide':wide,'data-reading-theme':readingTheme.theme.id,'data-reading-appearance':readingTheme.theme.appearance,style:minimized?{...themeStyle,display:'none'}:themeStyle,onKeyDown:event=>{
          if(event.key==='Escape'&&!event.nativeEvent?.isComposing){event.preventDefault();event.stopPropagation();close();}}},
          h(FloatingWindowHandles,{controls:floating,label:'报告阅读页'}),
          h('header',{...floating.dragProps,className:'rr-head'},h('div',{className:'rr-head-title'},h('h2',{ref:heading,tabIndex:-1},'报告阅读页'),h('small',null,'保留原文 · 按需展开')),
            h('div',{className:'rr-head-actions'},h('button',{type:'button','aria-label':'复制完整原文',disabled:!source,onClick:()=>void copy()},'复制'),
              h('button',{type:'button','aria-label':'最小化报告阅读页',title:'最小化',onClick:()=>reportReadingRuntime.minimize()},'—'),
              h('button',{type:'button','aria-label':wide?'还原报告阅读页':'放大报告阅读页',onClick:()=>setWide(!wide)},wide?'还原':'放大'),h('button',{type:'button','aria-label':'关闭报告阅读页',title:anyBusy?'关闭并停止本页未完成的生成':'关闭报告阅读页',onClick:close},'关闭'))),
          source?h('div',{className:'rr-toolbar'},h('div',{className:'rr-reading-mode',role:'group','aria-label':'阅读范围'},h('button',{type:'button','aria-pressed':!readable&&!focused,onClick:()=>{selectReadable(false);setFocused(false);}},'完整原文'),h('button',{type:'button','aria-pressed':!readable&&focused,onClick:()=>{selectReadable(false);setFocused(true);}},'重点阅读'),h('button',{type:'button','aria-pressed':readable,onClick:()=>selectReadable(true)},'顺畅阅读')),
            h('details',{className:'rr-appearance'},h('summary',null,'阅读外观'),h('div',{className:'rr-appearance-options'},
              h('div',{className:'rr-theme-fields'},h('label',{className:'rr-theme-field'},'阅读主题',h('select',{'aria-label':'阅读主题',value:readingTheme.preference.theme,onChange:event=>readingTheme.change({theme:event.target.value})},...[['system','跟随 DSH'],['catppuccin','Catppuccin'],['nord','Nord'],['rosepine','Rosé Pine']].map(([value,label])=>h('option',{key:value,value},label)))),
                h('label',{className:'rr-theme-field'},'外观',h('select',{'aria-label':'阅读页外观',disabled:readingTheme.preference.theme==='system',value:readingTheme.preference.theme==='system'?'auto':readingTheme.preference.appearance,title:readingTheme.preference.theme==='system'?'跟随 DSH 主题时，明暗由客户端决定':undefined,onChange:event=>readingTheme.change({appearance:event.target.value})},h('option',{value:'auto'},'跟随客户端'),h('option',{value:'light'},'浅色'),h('option',{value:'dark'},'深色'))),
                h('p',{className:'rr-theme-current'},readingTheme.theme.name+(readingTheme.theme.flavour?' · '+readingTheme.theme.flavour:'')),
                readingTheme.notice?h('p',{className:'rr-theme-notice',role:'status'},readingTheme.notice):null)))):null,
          !readable&&guideGroups.length?h('nav',{className:'rr-guide','aria-label':'原文导览'},h('span',null,'跳到'),...guideGroups.map(group=>h('button',{key:group.kind,type:'button','data-kind':group.kind,'aria-pressed':guidePosition?.kind===group.kind,'aria-label':'查看'+guideLabels[group.kind]+'，共 '+group.items.length+' 处',title:'逐处定位原文，保留原顺序',onClick:event=>navigate(group,event)},guideLabels[group.kind],h('span',{'aria-hidden':true},group.items.length))),h('span',{className:'rr-sr-only',role:'status','aria-live':'polite'},guidePosition?'已定位'+guideLabels[guidePosition.kind]+'，第 '+guidePosition.index+' 处，共 '+guidePosition.total+' 处':'')):null,
          h('main',{className:'rr-content','aria-label':'报告阅读内容'},source?h(React.Fragment,null,
            !readable&&focused?h('p',{className:'rr-reading-status',role:'status'},readingStatus.folded?'已收起 '+readingStatus.folded+' 段补充说明；结论、条件与风险仍保留，可逐段展开。':readingStatus.foldable?'补充说明已全部展开，原文顺序保持不变。':!result?'完整原文保持可读。分析阅读重点后，可收起能可靠定位的补充说明。':!Array.isArray(result.reading)?'这份分析没有段落分类，原文保持完整；可按需重新分析。':'没有可安全收起的说明，原文保持完整。'):null,
            !readable&&!result?h('div',{className:'rr-intro'},h('p',null,'原文已完整载入。按需分析阅读重点，生成段落导览和可展开的补充说明。'),h('button',{type:'button','data-primary':'',disabled:anyBusy||loading||data?.running,onClick:()=>void generate()},busy?'正在分析…':'分析阅读重点')):null,
            !readable&&warnings.length?h('details',{className:'rr-explanation','aria-label':'本次分析说明'},h('summary',null,contentWarnings.length?'部分结果未采用，原文保持完整':'已规范化分析格式'),h('p',null,'只有能与原文可靠对应的段落才会加入导览或收起。无法核对的结果会被忽略，原文保持完整。')):null,
            readable?h(React.Fragment,null,h('div',{className:'rr-readable-note'},h('p',null,'段旁 ↔ 可对照原文；重要事实、条件与风险请核对。'),
              readableResult?h('button',{type:'button',onClick:()=>void copyReadable()},'复制顺畅稿'):null),
              readableResult?h(ReportReadableDocument,{source,result:readableResult,warnings:readableData.warnings,media}):h('div',{className:'rr-intro'},h('p',null,readableLoading?'正在读取已有顺畅稿…':'首次生成会调用一次模型，原始报告保持不变。'),h('button',{type:'button','data-primary':'',disabled:anyBusy||loading||readableLoading||data?.running,onClick:()=>requestReadable()},readableBusy?'正在整理…':'生成顺畅稿'))):null,
            h('div',{hidden:readable,'aria-hidden':readable||undefined},h(ReportOriginalDocument,{source,readingPlan,focused,jump,onReadingStatus:readingChanged,active:!minimized&&!readable,media}))):
            h('div',{className:'rr-unavailable'},loading?h('p',{role:'status'},'正在读取原始报告…'):h(React.Fragment,null,h('h3',null,'这份报告暂时无法读取'),h('p',null,reportReadingError(data?.reason)),h('button',{type:'button',onClick:()=>void load()},'重新读取')))),
          visibleInfo?h('div',{className:'rr-status',role:'status','aria-live':'polite'},h('p',null,visibleInfo),visibleIssue?h('details',{'aria-label':'本次分析未完成的原因'},h('summary',null,'查看原因'),h('p',null,reportIssueExplanation(visibleIssue))):null):null,
          h('footer',{className:'rr-footer'},h('span',null,visibleModel?.model?'整理模型：'+visibleModel.model+(visibleModel.provider?' · '+visibleModel.provider:'')+((readable?readableData?.cached:data.cached)?' · 已缓存':''):'导览、展开和外观切换均在本地完成。'),
            readable?(readableBusy?h('button',{type:'button',disabled:!!readableLifetime.current.task?.stopRequested,onClick:()=>void requestStop(true)},'停止整理'):readableResult?h('button',{type:'button',disabled:loading||busy||readableLoading||!data?.available,onClick:()=>requestReadable(true)},'重新生成顺畅稿'):null):busy?h('button',{type:'button',disabled:!!lifetime.current.task?.stopRequested,onClick:()=>void requestStop(false)},'停止分析'):result?h('button',{type:'button',disabled:loading||readableBusy||!data?.available,onClick:()=>void generate(true)},'重新分析'):null,
            h('button',{type:'button',disabled:loading||anyBusy||readableLoading,onClick:()=>void load(readable)},'重新读取'))));
    }
