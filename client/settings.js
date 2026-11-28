    // --- settings page -------------------------------------------------------

    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px', margin: '0 0 14px' };
    /** A checkbox and its label on one line. */
    const toggleRowStyle = { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' };
    /** A degradation notice that must not read as ordinary helper text. */
    const warningStyle = {
      margin: '10px 0 0',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '0.5px solid var(--dsw-alias-border-l3)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      lineHeight: '1.5',
    };
    const labelStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' };
    const memoryLineStyle = { color: 'var(--dsw-alias-label-primary)' };
    const presetNameStyle = { color: 'var(--dsw-alias-label-primary)' };
    const presetPreviewStyle = {
      margin: '8px 0 0',
      padding: '8px 10px',
      borderRadius: '6px',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      fontSize: '12px',
      lineHeight: '1.6',
    };
    const primaryButtonStyle = {
      padding: '5px 12px',
      borderRadius: '6px',
      border: 'none',
      background: 'var(--dsw-alias-brand-primary)',
      color: '#ffffff',
      cursor: 'pointer',
      fontSize: '12px',
      fontFamily: 'inherit',
    };
    const inputStyle = {
      padding: '6px 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: '13px',
    };
    const hintStyle = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '1.65' };
    const sectionTitleStyle = { margin: '0 0 12px', fontSize: '15px', fontWeight: '600' };

    // INCLUDE settings-chat.js#thinking
    async function postSettings(patch) {
      const routeAt=chatThinkingState.routeRevision;
      try {
        const response = await fetch(`${ROUTE}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!response.ok) {
          const failure = await response.json();
          return failure?.error === 'settings-save-failed' ? failure : undefined;
        }
        const value = await response.json();
        if(value?.settings)acceptChatThinking(value.settings,{routeOnly:true,routeAt});
        if (typeof value?.settings?.progressNotices === 'boolean') setProgressEnabled(value.settings.progressNotices);
        return value;
      } catch {
        return undefined;
      }
    }

    /**
     * Send one preset operation.
     *
     * Generation is a model call, so it can take many seconds or fail outright;
     * a failure is returned as data rather than thrown, so the page can say why
     * instead of appearing to hang.
     */
    async function postPreset(body) {
      try {
        const response = await fetch(`${ROUTE}/presets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          return { ok: false, reason: detail?.error ?? `http-${response.status}` };
        }
        return await response.json();
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'network' };
      }
    }

    /**
     * Settings page: the persona pack, the rewrite route, and the on/off switch.
     * Written through the plugin's own host route so no codegen is involved.
     */
    const SETTINGS_CSS = [
      '[data-persona-shell="settings"],[data-persona-shell="memory-panel"]{--dsh-persona-accent:var(--dsw-alias-brand-primary,#3976c3);--dsh-persona-border:var(--dsw-alias-border-l1,#d8dfe7);--dsh-persona-bg:var(--dsw-alias-bg-layer-1,#fff);--dsh-persona-soft:var(--dsw-alias-bg-layer-2,#f5f7fa);--dsh-persona-text:var(--dsw-alias-label-primary,#203044);--dsh-persona-muted:var(--dsw-alias-label-secondary,#607080);color:var(--dsh-persona-text)}',
      '.dsh-persona-settings{max-width:880px;width:100%;min-width:0;font:inherit;line-height:1.6;padding:2px 0 12px}',
      '.dsh-persona-settings *,.dsh-persona-memory *{box-sizing:border-box}',
      '.dsh-persona-settings-hero{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-bottom:22px;padding:22px 24px;border:1px solid var(--dsh-persona-border);border-radius:14px;background:var(--dsh-persona-soft);background:linear-gradient(115deg,color-mix(in srgb,var(--dsh-persona-accent) 8%,var(--dsh-persona-bg)),var(--dsh-persona-bg))}',
      '.dsh-persona-eyebrow{font-size:10px;letter-spacing:.16em;color:var(--dsh-persona-accent);font-weight:650;margin-bottom:5px}',
      '.dsh-persona-settings-hero h2{font:inherit;font-size:21px;line-height:1.4;font-weight:650;letter-spacing:-.02em;margin:0 0 7px}',
      '.dsh-persona-settings-hero p{font-size:12px;line-height:1.7;margin:0;color:var(--dsh-persona-muted)}',
      '.dsh-persona-save-state{font-size:11px;white-space:nowrap;color:var(--dsh-persona-muted);padding:4px 9px;border:1px solid var(--dsh-persona-border);border-radius:20px;background:var(--dsh-persona-bg)}',
      '.dsh-persona-section{border:1px solid var(--dsh-persona-border);border-radius:12px;margin:0 0 14px;padding:20px;background:var(--dsh-persona-bg);min-width:0}',
      '.dsh-persona-section-heading{display:flex;align-items:flex-start;gap:11px;margin-bottom:16px}',
      '.dsh-persona-step{font-size:11px;font-variant-numeric:tabular-nums;line-height:25px;color:var(--dsh-persona-accent);border-bottom:2px solid var(--dsh-persona-accent);min-width:21px}',
      '.dsh-persona-section-heading h3{font:inherit;font-weight:650;font-size:15px;margin:0 0 3px;line-height:1.5}',
      '.dsh-persona-section-heading p,.dsh-persona-section-note{font-size:12px;color:var(--dsh-persona-muted);margin:0;line-height:1.7}',
      '.dsh-persona-section-note{margin:0 0 14px}',
      '.dsh-persona-preset-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;overflow:auto;overscroll-behavior:contain;padding:1px}',
      '.dsh-persona-preset-grid[data-many="true"]{max-height:320px}',
      '.dsh-persona-preset{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:13px 14px;border:1px solid var(--dsh-persona-border);border-radius:9px;min-width:0;background:var(--dsh-persona-bg)}',
      '.dsh-persona-preset-name{min-width:0;flex:1 1 130px;overflow-wrap:anywhere;font-size:13px}',
      '.dsh-persona-preset-description{display:block;font-size:11px;line-height:1.5;color:var(--dsh-persona-muted);font-weight:400;white-space:normal;margin-top:3px}',
      '.dsh-persona-preset-tag{font-size:10px;color:var(--dsh-persona-muted);align-self:flex-start;border:1px solid var(--dsh-persona-border);border-radius:4px;padding:0 5px}',
      '.dsh-persona-preset-actions{display:flex;align-items:center;gap:10px;justify-content:flex-end;flex:1 0 100%}',
      '.dsh-persona-preset-actions button{font-size:12px;line-height:1.6}',
      '.dsh-persona-preset-avatar{flex:none;display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--dsh-persona-border);border-radius:12px;background:var(--dsh-persona-soft)}',
      '.dsh-persona-avatar-editor{margin-top:14px;padding:16px;border:1px solid var(--dsh-persona-border);border-radius:10px;background:var(--dsh-persona-soft)}.dsh-persona-avatar-workbench{display:grid;grid-template-columns:128px minmax(0,1fr);gap:18px;align-items:start;margin:14px 0}.dsh-persona-avatar-workbench canvas,.dsh-persona-avatar-preview{display:grid;place-items:center;width:128px;height:128px;border:1px solid var(--dsh-persona-border);border-radius:14px;background:var(--dsh-persona-bg);font-size:26px;color:var(--dsh-persona-accent)}.dsh-persona-avatar-workbench input[type=file]{max-width:100%;font-size:12px}.dsh-persona-avatar-crop{display:grid;gap:8px}.dsh-persona-avatar-crop label{display:flex;gap:12px;align-items:center;font-size:12px}.dsh-persona-avatar-crop input{min-width:0;flex:1;accent-color:var(--dsh-persona-accent)}@media(max-width:520px){.dsh-persona-avatar-workbench{grid-template-columns:minmax(0,1fr)}.dsh-persona-avatar-workbench canvas,.dsh-persona-avatar-preview{justify-self:center}}',
      '.dsh-persona-selected-label{font-size:11px;color:var(--dsh-persona-accent)}',
      '.dsh-persona-persona-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:14px}',
      '.dsh-persona-persona-tools:has(>.dsh-persona-fold[open]){grid-template-columns:minmax(0,1fr)}',
      '.dsh-persona-fold{border:1px solid var(--dsh-persona-border);border-radius:10px;min-width:0;margin-bottom:14px;background:var(--dsh-persona-bg)}',
      '.dsh-persona-persona-tools>.dsh-persona-fold{margin-bottom:0}',
      '.dsh-persona-fold>summary{position:relative;display:flex;align-items:center;gap:12px;list-style:none;cursor:pointer;padding:15px 39px 15px 17px;min-height:66px;user-select:none}',
      '.dsh-persona-fold>summary::-webkit-details-marker{display:none}',
      '.dsh-persona-fold>summary::after{content:"+";position:absolute;right:17px;top:50%;transform:translateY(-50%);font-size:19px;line-height:1;color:var(--dsh-persona-muted);font-weight:400}',
      '.dsh-persona-fold[open]>summary::after{content:"-"}',
      '.dsh-persona-fold[open]>summary{border-bottom:1px solid var(--dsh-persona-border)}',
      '.dsh-persona-fold-title{display:block;font-size:13px;font-weight:600;line-height:1.6}',
      '.dsh-persona-fold-note{display:block;font-size:11px;line-height:1.6;color:var(--dsh-persona-muted);margin-top:2px}',
      '.dsh-persona-fold-badge{margin-left:auto;white-space:nowrap;font-size:10px;color:var(--dsh-persona-muted);border:1px solid var(--dsh-persona-border);border-radius:20px;padding:1px 7px}',
      '.dsh-persona-fold-body{padding:17px;min-width:0}',
      '.dsh-persona-inline-fold{border:0;margin:0}.dsh-persona-inline-fold>summary{min-height:30px;padding:2px 25px 2px 0}.dsh-persona-inline-fold .dsh-persona-fold-note{display:none}.dsh-persona-inline-fold .dsh-persona-fold-title{font-size:12px;font-weight:400;color:var(--dsh-persona-muted)}.dsh-persona-inline-fold>.dsh-persona-fold-body{padding:12px 0 0}.dsh-persona-inline-fold>summary::after{right:3px;font-size:15px}',
      '.dsh-persona-editor-grid,.dsh-persona-advanced-grid,.dsh-persona-common-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px 20px;min-width:0}',
      '.dsh-persona-editor-field:first-child,.dsh-persona-editor-field:last-child,.dsh-persona-wide{grid-column:1/-1}',
      '.dsh-persona-settings textarea,.dsh-persona-settings select,.dsh-persona-settings input:not([type=checkbox]):not([type=range]):not([type=number]){max-width:100%;min-width:0;width:100%}',
      '.dsh-persona-settings textarea{line-height:1.7;resize:vertical}',
      '.dsh-persona-settings input[type=checkbox],.dsh-persona-memory input[type=checkbox]{accent-color:var(--dsh-persona-accent);flex-shrink:0;width:15px;height:15px;margin:1px 0}',
      '.dsh-persona-settings .dsh-persona-setting-field{margin-bottom:0!important;gap:7px!important;min-width:0}',
      '.dsh-persona-settings .dsh-persona-setting-field>label>span{font-size:13px!important;font-weight:550;color:var(--dsh-persona-text)!important}',
      '.dsh-persona-process-options{padding-bottom:17px;margin-bottom:17px;border-bottom:1px solid var(--dsh-persona-border)}',
      '.dsh-persona-common-grid{margin-bottom:17px}',
      '.dsh-persona-settings .dsh-persona-subheading{font:inherit;font-size:13px;font-weight:600;margin:0 0 12px}',
      '.dsh-persona-help-copy{font-size:12px;line-height:1.8;color:var(--dsh-persona-muted)}',
      '.dsh-persona-help-copy p{margin:0 0 10px}.dsh-persona-help-copy p:last-child{margin-bottom:0}',
      '.dsh-persona-footer-note{font-size:11px;line-height:1.7;color:var(--dsh-persona-muted);margin:16px 2px 0}',
      '.dsh-persona-settings :is(button,input,select,textarea,summary):focus-visible,.dsh-persona-memory :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--dsh-persona-accent);outline-offset:3px}',
      '.dsh-persona-memory{font:inherit;min-width:0}',
      '.dsh-persona-memory .dsh-persona-fold{margin-top:13px;margin-bottom:0}',
      '.dsh-persona-memory .dsh-persona-fold>summary{min-height:52px;padding:11px 36px 11px 13px}',
      '.dsh-persona-memory .dsh-persona-fold-body{padding:13px}',
      '.dsh-persona-memory-list{position:relative;max-height:min(64vh,680px);overflow:auto;overscroll-behavior:contain;min-width:0;padding-right:4px;scroll-padding:10px}',
      '.dsh-persona-memory-entry{padding:14px 0;border-top:1px solid var(--dsh-persona-border)}',
      '.dsh-persona-memory-entry:first-child{border-top:0}',
      '.dsh-persona-memory-content{font-size:13px;line-height:1.8;margin:5px 0;overflow-wrap:anywhere;white-space:pre-wrap}',
      '.dsh-persona-memory-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0 8px}',
      '.dsh-persona-memory-toolbar>select{min-width:0;max-width:100%}',
      '.dsh-persona-settings .dsh-persona-memory-toolbar>select{width:auto;max-width:230px;flex:1}',
      '.dsh-persona-settings .dsh-persona-memory .dsh-persona-fold-body select{width:auto;min-width:0;flex:1}',
      '.dsh-persona-memory-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:9px}',
      '.dsh-persona-memory-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.dsh-persona-memory-tabs button{font:inherit;font-size:12px;cursor:pointer;border:1px solid transparent;border-radius:6px;padding:6px 11px;color:var(--dsh-persona-muted);background:transparent}.dsh-persona-memory-tabs button[aria-pressed=true]{color:var(--dsh-persona-text);border-color:var(--dsh-persona-border);background:var(--dsh-persona-soft);font-weight:600}',
      '.dsh-persona-memory button:disabled{opacity:.5;cursor:default}.dsh-persona-memory-review:focus{outline:2px solid var(--dsh-persona-accent);outline-offset:-2px}',
      '.dsh-persona-memory-review,.dsh-persona-memory-editor{border:1px solid var(--dsh-persona-border);border-radius:9px;padding:14px;margin:10px 0;background:var(--dsh-persona-soft);overflow-wrap:anywhere}',
      '.dsh-persona-memory-review-heading{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:13px}.dsh-persona-memory-evidence blockquote{margin:5px 0 10px;padding:8px 12px;border-left:2px solid var(--dsh-persona-accent);white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.8;background:var(--dsh-persona-bg)}',
      '.dsh-persona-usage-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0}.dsh-persona-usage-stat{padding:10px;border:1px solid var(--dsh-persona-border);border-radius:8px;background:var(--dsh-persona-soft);font-size:11px;color:var(--dsh-persona-muted)}.dsh-persona-usage-stat strong{display:block;font-size:20px;line-height:1.4;font-weight:600;color:var(--dsh-persona-text);font-variant-numeric:tabular-nums}',
      '.dsh-persona-usage-list{max-height:420px;overflow:auto;overscroll-behavior:contain;padding:1px}.dsh-persona-usage-record{border:1px solid var(--dsh-persona-border);border-radius:8px;margin:0 0 8px;overflow-wrap:anywhere}.dsh-persona-usage-record>summary{padding:11px;cursor:pointer;font-size:12px;line-height:1.7}.dsh-persona-usage-record>summary>span{margin-right:8px;display:inline-block;max-width:100%}.dsh-persona-usage-record-body{padding:0 12px 12px;font-size:12px}.dsh-persona-usage-record-body ul{list-style:none;padding:0;margin:7px 0 12px}.dsh-persona-usage-record-body li{padding:6px 0;border-bottom:1px solid var(--dsh-persona-border)}.dsh-persona-usage-reason{display:block;color:var(--dsh-persona-muted);font-size:11px;margin-top:2px}',
      '.dsh-persona-usage-bar{height:6px;display:flex;overflow:hidden;border-radius:8px;background:var(--dsh-persona-border);margin:10px 0}.dsh-persona-usage-bar>span{height:100%;background:var(--dsh-persona-accent)}.dsh-persona-usage-bar[data-sent=false]>span{background:var(--dsh-persona-muted)}',
      '.dsh-persona-memory-editor textarea,.dsh-persona-memory textarea{width:100%;min-height:72px;margin:6px 0;resize:vertical}.dsh-persona-memory-delete{margin-top:10px;font-size:11px}.dsh-persona-memory-review p{margin:8px 0}',
      '.dsh-persona-memory-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px}',
      '@media(max-width:600px){.dsh-persona-settings-hero{padding:18px;gap:12px;margin-bottom:15px}.dsh-persona-settings-hero h2{font-size:19px}.dsh-persona-section{padding:16px}.dsh-persona-editor-grid,.dsh-persona-advanced-grid,.dsh-persona-common-grid,.dsh-persona-persona-tools{grid-template-columns:minmax(0,1fr)}.dsh-persona-preset-grid[data-many="true"]{max-height:430px}.dsh-persona-common-grid{gap:20px}.dsh-persona-fold>summary{padding-left:15px}.dsh-persona-fold-body{padding:15px}.dsh-persona-inline-fold>summary{padding-left:0}.dsh-persona-inline-fold>.dsh-persona-fold-body{padding-left:0;padding-right:0}}',
      '@media(max-width:400px){.dsh-persona-preset-grid{grid-template-columns:minmax(0,1fr)}.dsh-persona-fold-note{font-size:11px}.dsh-persona-fold-badge{font-size:10px;padding:0 5px}}',
    ].join('\n');

    const SETTINGS_REDESIGN_CSS = `
      .dsh-persona-settings[data-persona-shell=settings]{max-width:800px;font:14px/1.65 system-ui,"Microsoft YaHei",sans-serif;padding:4px 0 20px;--dsh-persona-accent:var(--dsw-alias-brand-primary,#4d63d8);--dsh-persona-wash:color-mix(in srgb,var(--dsh-persona-accent) 6%,var(--dsh-persona-bg))}
      .dsh-persona-settings [hidden]{display:none!important}
      .dsh-persona-settings .dsh-persona-settings-hero{padding:0 0 18px;margin:0;border:0;border-radius:0;background:none;gap:12px;align-items:center}
      .dsh-persona-settings .dsh-persona-settings-hero h2{font-size:20px;font-weight:650;letter-spacing:-.02em;margin:0 0 5px}
      .dsh-persona-settings .dsh-persona-settings-hero p{font-size:13px;color:var(--dsh-persona-muted);margin:0}
      .dsh-persona-settings .dsh-persona-save-state{border:0;padding:0;background:none;font-size:11px;display:inline-flex;align-items:center;gap:6px;white-space:normal}
      .dsh-persona-settings .dsh-persona-save-state::before{content:'';width:6px;height:6px;border-radius:50%;background:#539574;flex:none}
      .dsh-persona-settings .dsh-persona-save-state[data-state=pending]::before{background:#7884bc}
      .dsh-persona-settings .dsh-persona-save-state[data-state=error]::before{background:#c66d55}
      .dsh-persona-settings .dsh-persona-settings-tabs{display:flex;gap:8px;padding:0 0 1px;margin:0 0 24px;border-bottom:1px solid var(--dsh-persona-border);overflow:auto;scrollbar-width:thin}
      .dsh-persona-settings button{font-family:inherit!important;font-size:12px!important;line-height:1.5!important;min-height:28px;padding:4px 10px!important;border-radius:7px!important;border:1px solid var(--dsh-persona-border)!important;transition:background .12s,border-color .12s}
      .dsh-persona-settings button:hover:not(:disabled){filter:brightness(.96)}
      .dsh-persona-settings .dsh-persona-settings-tabs button{position:relative;flex:1;min-width:48px;min-height:38px;padding:8px 10px!important;border:0!important;border-radius:0!important;background:none;color:var(--dsh-persona-muted);font-size:13px!important;font-weight:500;white-space:nowrap}
      .dsh-persona-settings .dsh-persona-settings-tabs button[aria-selected=true]{color:var(--dsh-persona-accent);font-weight:650}
      .dsh-persona-settings .dsh-persona-settings-tabs button[aria-selected=true]::after{content:'';position:absolute;bottom:0;left:16px;right:16px;height:2px;border-radius:2px;background:var(--dsh-persona-accent)}
      .dsh-persona-settings .dsh-persona-section{padding:0;margin:0;border:0;border-radius:0;background:none}
      .dsh-persona-settings .dsh-persona-section-heading{margin-bottom:18px;gap:0}
      .dsh-persona-settings .dsh-persona-step{display:none}
      .dsh-persona-settings .dsh-persona-section-heading h3{font-size:15px;font-weight:650;margin:0 0 4px}
      .dsh-persona-settings .dsh-persona-section-heading p{font-size:12px;line-height:1.6}
      .dsh-persona-settings .dsh-persona-preset-grid{grid-auto-rows:1fr;gap:10px;padding:1px;max-height:none}
      .dsh-persona-settings .dsh-persona-preset-grid[data-many=true]{max-height:400px}
      .dsh-persona-settings .dsh-persona-preset{align-items:center;padding:14px;gap:10px;border-radius:10px;border-color:var(--dsh-persona-border);background:var(--dsh-persona-bg)}
      .dsh-persona-settings .dsh-persona-preset-avatar{width:46px;height:46px;border-radius:11px;border-color:color-mix(in srgb,var(--dsh-persona-border) 60%,transparent)}
      .dsh-persona-settings .dsh-persona-preset-name{flex:1 1 100px;font-size:14px;line-height:1.45}
      .dsh-persona-settings .dsh-persona-preset-description{font-size:12px;line-height:1.55;margin-top:5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .dsh-persona-settings .dsh-persona-preset-tag{font-size:10px;padding:1px 5px;border:0;background:var(--dsh-persona-soft);border-radius:4px;align-self:flex-start}
      .dsh-persona-settings .dsh-persona-preset-actions{gap:7px;margin-top:2px;min-height:28px}
      .dsh-persona-settings .dsh-persona-selected-label{font-size:11px;color:var(--dsh-persona-accent);display:flex;align-items:center;gap:5px}
      .dsh-persona-settings .dsh-persona-selected-label::before{content:'✓';font-weight:650}
      .dsh-persona-settings .dsh-persona-persona-tools{margin-top:18px;gap:10px}
      .dsh-persona-settings .dsh-persona-fold{border-radius:9px;background:none;border-color:var(--dsh-persona-border)}
      .dsh-persona-settings .dsh-persona-fold>summary{padding:12px 34px 12px 13px;min-height:58px;gap:10px}
      .dsh-persona-settings .dsh-persona-fold>summary::after{right:13px;font-size:16px}
      .dsh-persona-settings .dsh-persona-fold-title{font-size:12px;font-weight:600}
      .dsh-persona-settings .dsh-persona-fold-note{font-size:11px}
      .dsh-persona-settings .dsh-persona-fold-body{padding:15px}
      .dsh-persona-settings .dsh-persona-inline-fold>summary{min-height:30px;padding:3px 24px 3px 0}
      .dsh-persona-settings .dsh-persona-inline-fold>.dsh-persona-fold-body{padding:10px 0}
      .dsh-persona-settings .dsh-persona-process-options{padding:18px 0;margin:0;border-bottom:1px solid var(--dsh-persona-border)}
      .dsh-persona-settings .dsh-persona-common-grid{padding:18px 0;margin:0;gap:20px;border-bottom:1px solid var(--dsh-persona-border)}
      .dsh-persona-settings .dsh-persona-common-grid>div{min-width:0}
      .dsh-persona-settings .dsh-persona-advanced-grid{gap:22px}
      .dsh-persona-settings input,.dsh-persona-settings select,.dsh-persona-settings textarea{font-size:13px!important}
      .dsh-persona-settings textarea,.dsh-persona-settings select,.dsh-persona-settings input:not([type=checkbox]):not([type=range]):not([type=file]){border-radius:7px!important;min-height:34px}
      .dsh-persona-settings .dsh-persona-footer-note{padding-top:14px;margin-top:22px;border-top:1px solid var(--dsh-persona-border);font-size:11px}
      .dsh-persona-settings .dsh-persona-avatar-editor{background:var(--dsh-persona-soft)}
      .dsh-persona-settings .dsh-persona-memory-toolbar{margin-top:18px}
      @media(max-width:520px){.dsh-persona-settings .dsh-persona-settings-hero{align-items:flex-start}.dsh-persona-settings .dsh-persona-save-state{padding-top:6px}.dsh-persona-settings .dsh-persona-preset-grid{grid-template-columns:minmax(0,1fr)}.dsh-persona-settings .dsh-persona-preset{padding:12px}.dsh-persona-settings .dsh-persona-persona-tools,.dsh-persona-settings .dsh-persona-common-grid,.dsh-persona-settings .dsh-persona-advanced-grid{grid-template-columns:minmax(0,1fr)}}
      @media(prefers-reduced-motion:reduce){.dsh-persona-settings button{transition:none}}
      @media(max-width:520px){.dsh-persona-settings .dsh-persona-settings-tabs{gap:4px}.dsh-persona-settings .dsh-persona-settings-tabs button{padding:8px 6px!important}}
    `;
    function settingsHeading(number, title, note) {
      return h('div', { className: 'dsh-persona-section-heading' }, h('span', { className: 'dsh-persona-step', 'aria-hidden': true }, number),
        h('div', null, h('h3', null, title), h('p', null, note)));
    }

    // INCLUDE settings-usage.js#usage

    function settingsFold(id, title, description, content, options = {}) {
      return h('details', { className: 'dsh-persona-fold' + (options.compact ? ' dsh-persona-inline-fold' : ''), 'data-settings-fold': id, open: options.open, onToggle: options.onToggle },
        h('summary', null, h('span', null, h('span', { className: 'dsh-persona-fold-title' }, title),
          h('span', { className: 'dsh-persona-fold-note' }, description)),
        options.badge ? h('span', { className: 'dsh-persona-fold-badge' }, options.badge) : null),
        h('div', { className: 'dsh-persona-fold-body' }, content));
    }

    // INCLUDE settings-memory.js#references
    // INCLUDE settings-persona.js#summary
    // INCLUDE settings-memory.js#entries

    // INCLUDE settings-persona.js#avatar

    function AssetBackup({presets,onImported}) {
      const [type,setType]=React.useState('both'), [history,setHistory]=React.useState(false),[file,setFile]=React.useState(null);
      const [fallback,setFallback]=React.useState(''),[preview,setPreview]=React.useState(null),[busy,setBusy]=React.useState(false),[status,setStatus]=React.useState('');
      async function download(){
        setBusy(true);setStatus('');try{
          const query=type.startsWith('card:')?'persona='+encodeURIComponent(type.slice(5)):'type='+type+'&history='+Number(history);
          const res=await fetch(ROUTE+'/backup?'+query);if(!res.ok)throw Error();
          const blob=new Blob([JSON.stringify(await res.json(),null,2)],{type:'application/json'});
          const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=type.startsWith('card:')?'persona-card.json':'persona-shell-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        }catch{setStatus('导出失败。');}finally{setBusy(false);}
      }
      async function load(confirm){setBusy(true);setStatus('');try{
        if(file.size>24*1024*1024)throw Error();const value=JSON.parse(await file.text());
        const res=await fetch(ROUTE+'/backup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:confirm?'import':'preview',file:value,token:preview?.token,fallbackPersona:fallback||null})});
        if(!res.ok){setPreview(null);throw Error(res.status===409?'现有数据已变化，请重新预览。':'备份格式或存储不可用。');}
        const result=await res.json();setPreview(confirm?null:result);
        if(confirm){setFile(null);setStatus('已导入 '+result.summary.personas.length+' 张人格卡、'+result.summary.entries+' 条记忆。');await onImported(result.summary);}
      }catch(e){setStatus(e.message?.startsWith('现有')?e.message:'无法读取或保存这份备份，请核对文件。');}finally{setBusy(false);}}
      return h('fieldset',{disabled:busy},h('legend',null,'本地备份'),h('label',null,'导出范围',h('select',{value:type,onChange:e=>setType(e.target.value)},
        h('option',{value:'both'},'自定义人格卡与记忆'),h('option',{value:'personas'},'自定义人格卡'),h('option',{value:'memory'},'记忆'),...presets.map(p=>h('option',{key:p.id,value:'card:'+p.id},'单卡 · '+p.name)))),
        ['both','memory'].includes(type)?h('div',null,h('label',null,h('input',{type:'checkbox',checked:history,onChange:e=>setHistory(e.target.checked)}),'包含候选和历史条目'),h('p',null,'文件包含你的依据原话，请妥善保管。')):null,
        type!=='memory'?h('p',null,'卡片包含你填入的聊天表达材料。'):null,
        h('button',{type:'button',onClick:download},'导出 JSON'),h('label',null,'导入文件',h('input',{type:'file',accept:'.json,application/json',onChange:e=>{
          const selected=e.currentTarget.files[0];e.currentTarget.value='';setFile(selected);setPreview(null);setStatus('');
        }})),
        file?h('div',null,h('label',null,'缺失房间的记忆',h('select',{value:fallback,onChange:e=>{setFallback(e.target.value);setPreview(null);}},h('option',{value:''},'跳过'),...presets.map(p=>h('option',{key:p.id,value:p.id},'转为私有 · '+p.name)))),
          h('span',null,file.name),h('button',{type:'button',onClick:()=>load(false)},'预览导入')):null,
        preview?h('div',null,h('p',null,'将新增人格卡 '+preview.summary.personas.length+' 张（'+(preview.summary.personas.join('、')||'无')+'），记忆 '+preview.summary.entries+' 条。导入的活跃记忆需要重新采纳。'),
          h('p',null,'跳过重复 '+preview.summary.duplicates+'，缺少人格 '+preview.summary.missingPersona+'，缺少房间 '+preview.summary.missingRoom+'，容量不足 '+preview.summary.capacity+'。'+preview.summary.rooms.join('、')),
          h('button',{type:'button',onClick:()=>load(true)},'确认导入'),h('button',{type:'button',onClick:()=>setPreview(null)},'取消')):null,
        h('p',{role:'status'},status));
    }
    // INCLUDE settings-chat.js#profile
    function useModelCatalogue(provider, visible, retry = 0) {
      const [state, setState] = React.useState({ provider: null, models: [], failed: false });
      React.useEffect(() => {
        if (!visible || !provider) return;
        let live = true;
        const abort = new AbortController();
        const fail = () => { if (live) setState({ provider, models: [], failed: true }); };
        const timeout = setTimeout(() => { abort.abort(); fail(); }, 10000);
        setState({ provider, models: [], failed: false });
        void (async () => {
          try {
            const response = await fetch(ROUTE + '/models?provider=' + encodeURIComponent(provider), { signal: abort.signal });
            if (!response.ok) throw Error('models-unavailable');
            const value = await response.json();
            if (value.error || !Array.isArray(value.models)) throw Error('models-unavailable');
            if (live && !abort.signal.aborted) setState({ provider, models: value.models, failed: false });
          } catch { fail(); }
          finally { clearTimeout(timeout); }
        })();
        return () => { live = false; clearTimeout(timeout); abort.abort(); };
      }, [provider, visible, retry]);
      return provider && state.provider === provider ? state : { models: [], failed: false };
    }

    let nextSettingsId = 0;
    function SettingsSection() {
      const [activeTab, setActiveTab] = React.useState('persona');
      const [appearanceVisited,setAppearanceVisited]=React.useState(false);
      React.useEffect(()=>{if(activeTab==='appearance')setAppearanceVisited(true);},[activeTab]);
      const tabsId = React.useRef(null);
      if (tabsId.current === null) tabsId.current = 'dsh-persona-settings-' + (++nextSettingsId);
      const [settings, setSettings] = React.useState(undefined);
      const [memoryImportRevision,setMemoryImportRevision]=React.useState(0);
      const settingsRef = React.useRef(undefined);
      const [packDrafts, setPackDrafts] = React.useState({});
      const draftsRef = React.useRef({ values: {}, versions: {}, revision: 0 });
      const writes = React.useRef(Promise.resolve());
      const editorGeneration = React.useRef(0);
      const editorScope = editorGeneration.current;
      const [presetBusy, setPresetBusy] = React.useState(false);
      const presetBusyRef = React.useRef(false);
      const presetLoadRevision = React.useRef(0);
      const statusTimer = React.useRef(undefined);
      const mounted = React.useRef(true);
      const [rendererState, setRendererState] = React.useState(chatRendererState);
      React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; clearTimeout(statusTimer.current); };
      }, []);
      React.useEffect(() => {
        const listener = () => setRendererState(chatRendererState);
        rendererListeners.add(listener);
        listener();
        return () => rendererListeners.delete(listener);
      }, []);
      const [providers, setProviders] = React.useState([]);
      const [providersFailed,setProvidersFailed]=React.useState(false),[catalogueRetry,setCatalogueRetry]=React.useState(0);
      const { models, failed: modelsFailed } = useModelCatalogue(settings?.provider, activeTab === 'advanced', catalogueRetry);
      const {models:supportModels,failed:supportModelsFailed}=useModelCatalogue(settings?.chatDeepReasoningProvider,activeTab==='chat'&&settings?.chatDeepReasoningEnabled===true&&!!settings?.chatDeepReasoningProvider,catalogueRetry);
      const { models: chatModels, failed: chatModelsFailed } = useModelCatalogue(settings?.chatProvider, activeTab === 'chat', catalogueRetry);
      const { models: visualizationModels, failed: visualizationModelsFailed } = useModelCatalogue(settings?.visualizationProvider, activeTab === 'advanced', catalogueRetry);
      const [status, setStatus] = React.useState('');
      const [failedSettingsSave, setFailedSettingsSave] = React.useState(false);
      const [reviewThresholdDraft, setReviewThresholdDraft] = React.useState(undefined);
      const [progressMinutesDraft, setProgressMinutesDraft] = React.useState(undefined);
      /** What long-term memory currently claims, so it can be inspected. */
      const [memoryLines, setMemoryLines] = React.useState([]);
      const [memoryStats, setMemoryStats] = React.useState(undefined);

      /** Named persona presets, plus the free-form prompt used to generate one. */
      const [presets, setPresets] = React.useState([]);
      const [activePresetId, setActivePresetId] = React.useState('');
      const [activePresetName, setActivePresetName] = React.useState('');
      const [personaPrompt, setPersonaPrompt] = React.useState('');
      const [generating, setGenerating] = React.useState(false);
      const [generated, setGenerated] = React.useState(undefined);
      const [generatedSource, setGeneratedSource] = React.useState('');
      const [generatedReviewOpen, setGeneratedReviewOpen] = React.useState(false);
      const generatedReview = React.useRef(null), generatedReviewReturn = React.useRef(null), generateButton = React.useRef(null);
      React.useEffect(() => {
        if (generatedReviewOpen) {
          generatedReview.current?.focus({ preventScroll: true });
          generatedReview.current?.scrollIntoView?.({ block: 'nearest' });
        }
      }, [generatedReviewOpen]);
      const generatingRef = React.useRef(false);
      const [presetStatus, setPresetStatus] = React.useState('');
      /** Name the user chose for a freshly generated preset. */
      const [generatedName, setGeneratedName] = React.useState('');
      /** Preset id being renamed, if the inline editor is open. */
      const [renaming, setRenaming] = React.useState(undefined);
      const [renameValue, setRenameValue] = React.useState('');
      const [editingAvatar, setEditingAvatar] = React.useState(undefined);

      // Keep writes in user order; card drafts remain separate from server snapshots.
      const queueWrite = (write) => {
        const task = writes.current.then(write, write);
        writes.current = task.catch(() => {});
        return task;
      };
      const acceptSettings = (value) => { settingsRef.current = value; setSettings(value); };
      const showStatus = (value, temporary = false) => {
        if (!mounted.current) return;
        clearTimeout(statusTimer.current);
        setStatus(value);
        if (temporary) statusTimer.current = setTimeout(() => setStatus(''), 1500);
      };
      const setDraft = (field, value) => {
        if (presetBusyRef.current || editorGeneration.current !== editorScope) return false;
        const draft = draftsRef.current;
        const revision = draft.revision + 1;
        draftsRef.current = { values: { ...draft.values, [field]: value },
          versions: { ...draft.versions, [field]: revision }, revision };
        setPackDrafts(draftsRef.current.values);
        return true;
      };

      const catalogueVisible = !!settings && (activeTab === 'chat' || activeTab === 'advanced');
      React.useEffect(() => {
        if (!catalogueVisible) return;
        let cancelled = false;
        const abort=new AbortController(),timeout=setTimeout(()=>{abort.abort();if(!cancelled)setProvidersFailed(true);},10000);setProvidersFailed(false);
        (async () => {
          try {
            const response = await fetch(`${ROUTE}/models`,{signal:abort.signal});
            if (!response.ok) throw Error('models-unavailable');
            const value = await response.json();
            if(value.error||!Array.isArray(value.providers))throw Error('models-unavailable');
            if (!cancelled && !abort.signal.aborted) setProviders(value.providers);
          } catch { if(!cancelled)setProvidersFailed(true); }
          finally{clearTimeout(timeout);}
        })();
        return () => { cancelled = true;clearTimeout(timeout);abort.abort(); };
      }, [catalogueVisible,catalogueRetry]);

      // Presets load once, and again whenever a preset operation returns a new
      // list: the host is the source of truth, the page only mirrors it.
      /**
       * Mirror the host's preset state.
       *
       * Takes the whole payload, not just the array. The active name and id move
       * whenever a preset is applied, renamed, deleted or saved, and updating the
       * list without them left the page showing the previous selection — so
       * 「启用」 looked like it did nothing until a reload.
       * @param {{ presets?: unknown, active?: unknown }} [payload]
       */
      const refreshPresets = async (payload) => {
        let value = payload;
        if (value === undefined) {
          const revision = presetLoadRevision.current;
          try {
            const response = await fetch(`${ROUTE}/presets`);
            if (!response.ok) return;
            value = await response.json();
            if (revision !== presetLoadRevision.current) return;
          } catch {
            return;
          }
        } else presetLoadRevision.current += 1;
        const list = Array.isArray(value?.presets) ? value.presets : [];
        setPresets(list);
        const activeName = typeof value?.active === 'string' ? value.active : '';
        setActivePresetName(activeName);
        const match = list.find((preset) => preset.name === activeName);
        setActivePresetId(match !== undefined ? match.id : '');
      };

      React.useEffect(() => { void refreshPresets(); }, []);

      const presetAction = (body) => {
        if (presetBusyRef.current) return Promise.resolve({ ok: false, reason: 'preset-change-pending' });
        presetBusyRef.current = true;
        setPresetBusy(true);
        editorGeneration.current += 1;
        const builtinAvatarOnly = body.action === 'avatar' && presets.some(preset => preset.id === body.id && preset.builtin);
        const replacesCard = body.action === 'apply' || body.action === 'save' || (body.action === 'avatar' && !builtinAvatarOnly)
          || (body.action === 'delete' && body.id === activePresetId);
        return queueWrite(async () => {
          try {
            // A failed blur save must not disappear when another card is selected.
            const changes = draftChanges();
            let requestBody = body;
            if (replacesCard && changes.length > 0) {
              const saved = await persistPackChanges(changes);
              if (!saved?.settings) {
                setPresetStatus(body.action === 'avatar' ? '保存头像前，人格修改未能保存，请重试。' : '切换前保存人格修改失败，请重试。');
                return { ok: false, reason: 'unsaved-persona-edits' };
              }
              if (body.action === 'avatar' && body.id === activePresetId) {
                const current = saved.presets?.find((p) => p.name === saved.settings.presetName);
                if (current && current.id !== body.id) requestBody = { ...body, id: current.id, expectedAvatar: current.avatar ?? null };
              }
            }
            const result = await postPreset(requestBody);
            if (result?.ok === true) {
              await refreshPresets({ presets: result.presets, active: result.active });
              if (result.settings !== undefined) acceptSettings(result.settings);
              setPresetStatus('');
              if (body.action === 'avatar') for (const update of chatUpdates) update(body.id);
            } else {
              setPresetStatus(body.action === 'avatar'
                ? result?.reason === 'avatar-conflict' ? '头像已在别处更新，请取消后重新打开。已选图片仍保留。' : '头像保存未完成，已选图片与取景仍保留，可以重试。'
                : `失败：${result?.reason ?? '未知原因'}`);
            }
            return result;
          } finally {
            presetBusyRef.current = false;
            setPresetBusy(false);
          }
        });
      };

      const returnFromGeneratedReview = (removed = false) => {
        const target = generatedReviewReturn.current;
        if (!removed && target?.isConnected) target.focus();
        else if (removed) generateButton.current?.closest('[data-settings-fold="create-persona"]')?.querySelector('summary')?.focus();
        else generateButton.current?.focus();
      };
      const closeGeneratedReview = () => {
        if (generatingRef.current || presetBusyRef.current) return;
        setGeneratedReviewOpen(false);
        returnFromGeneratedReview();
      };
      const generatePreset = async (event) => {
        if (generatingRef.current || presetBusyRef.current) return;
        generatedReviewReturn.current = event?.currentTarget ?? generateButton.current;
        generatingRef.current = true;
        const prompt = personaPrompt;
        setGenerating(true);
        setPresetStatus('正在读取人设…');
        const result = await postPreset({ action: 'generate', prompt });
        generatingRef.current = false;
        setGenerating(false);
        if (result?.ok === true) {
          setGenerated(result.preset);
          setGeneratedSource(prompt);
          // Seeded from the generated suggestion, but editable: it is a starting
          // point, not the user's decision.
          setGeneratedName(result.preset?.name ?? '');
          setGeneratedReviewOpen(true);
          setPresetStatus('已生成，确认后保存');
        } else {
          setPresetStatus(typeof result?.reason === 'string' && result.reason.startsWith('generation-')
            ? '模型返回的结构或多轮示例不完整，未采用。输入和已有预览已保留，可调整后重新生成。'
            : `生成失败：${result?.reason ?? '未知原因'}`);
        }
      };

      const startRename = (preset) => {
        setRenaming(preset.id);
        setRenameValue(preset.name);
      };

      const commitRename = async () => {
        const name = renameValue.trim();
        if (renaming === undefined || name === '') return;
        const result = await presetAction({ action: 'rename', id: renaming, name });
        if (result?.ok === true) {
          setRenaming(undefined);
          setRenameValue('');
        }
      };

      const pack = settings?.pack;

      const writeSettings = async (patch) => {
        showStatus('正在保存…');
        const result = await postSettings(patch);
        if (result?.settings !== undefined) {
          setFailedSettingsSave(false);
          acceptSettings(result.settings);
          // Saving can change the learned profile (a clear resets it), so the
          // memory panel refreshes from the same response rather than going stale.
          if (Array.isArray(result.memory)) setMemoryLines(result.memory);
          if (result.memoryStats !== undefined) setMemoryStats(result.memoryStats);
          // Editing the card writes back into a preset — or forks one from the
          // builtin — so the list and the selection both move with it.
          if (Array.isArray(result.presets)) {
            await refreshPresets({ presets: result.presets, active: result.settings.presetName });
          }
          showStatus(result.settingsPersistence === 'pending' ? '当前已生效，存储尚未就绪。'
            : result.settingsPersistence === 'memory-only' ? '仅本次生效，当前没有可用存储。' : '已保存',
            result.settingsPersistence !== 'pending' && result.settingsPersistence !== 'memory-only');
        } else {
          if (result?.error === 'settings-save-failed' && result.appliedSettings) {
            acceptSettings(result.appliedSettings);
            setFailedSettingsSave(true);
            showStatus('当前已生效，但保存失败。');
          } else showStatus('保存失败，请重试');
        }
        return result;
      };
      const save = (patch) => queueWrite(() => writeSettings(patch));
      const draftChanges = () => Object.entries(draftsRef.current.values)
        .map(([field, value]) => ({ field, value, version: draftsRef.current.versions[field] }));
      const persistPackChanges = async (changes,previewOnly=false) => {
        const ordered = [...changes].sort((a, b) => a.version - b.version);
        for (const change of ordered) if (change.field === 'chatVoice') {
          const lines = change.value.split('\n').filter(line => line.trim() !== '');
          if (lines.length > 8 || lines.some(line => line.length > 400)) {
            showStatus('聊天室语气最多8条，每条400字；请缩短后保存。');
            return { error: 'chat-voice-too-long' };
          }
        }
        const nextPack = { ...settingsRef.current?.pack };
        for (const { field, value } of ordered) {
          if (field === 'subagent') nextPack.address = { ...nextPack.address, subagent: value };
          else if (field === 'narrationMode') nextPack.narration = { ...nextPack.narration, mode: value };
          else if (field === 'selfReference') nextPack.narration = { ...nextPack.narration, selfReference: value };
          else if (field === 'selfAliases') {
            const aliases=[...new Set(value.split(/[,，、]/u).map(s=>s.trim()).filter(Boolean))];
            if (aliases.length>3 || aliases.some(s=>[...s].length>8)) {showStatus('其他自称最多 3 个，每个最多 8 字。');return {error:'invalid-self-aliases'};}
            nextPack.narration={...nextPack.narration,selfAliases:aliases};
          }
          else if (field === 'narrationAssistant') nextPack.narration = { ...nextPack.narration, assistant: value };
          else if (field === 'chatVoice') nextPack.chat = { ...(nextPack.chat ?? { samples: [] }), voice: value.split('\n').filter(line => line.trim() !== '') };
          else if (field === 'chatGender') nextPack.chat = { ...(nextPack.chat ?? {}), gender: value };
          else if (field === 'chatSource' && nextPack.chat?.source) {
            const effectiveVoice = nextPack.chat.voice ?? (nextPack.voice ?? []).filter(line => line.trim());
            if (value === 'use' && !chatSourceCanBind(nextPack.identity, effectiveVoice)) {
              const draft = draftsRef.current;
              if (!previewOnly && draft.versions.chatSource === changes.find(change => change.field === 'chatSource')?.version) {
                const values = { ...draft.values }, versions = { ...draft.versions };
                delete values.chatSource; delete versions.chatSource;
                draftsRef.current = { ...draft, values, versions }; setPackDrafts(values);
              }
              showStatus('当前身份或聊天语气超出原始参考的绑定范围，未启用，原文仍保留。');
              return { error: 'chat-source-binding-limit' };
            }
            nextPack.chat = { ...nextPack.chat, source: { ...nextPack.chat.source, enabled: value === 'use',
              ...(value === 'use' ? { identity: nextPack.identity.trim(), voice: [...effectiveVoice] } : {}) } };
          }
          else if (field === 'chatReset') {
            const gender = nextPack.chat?.gender;
            if (gender !== undefined) nextPack.chat = { gender };
            else delete nextPack.chat;
          }
          else nextPack[field] = field === 'identity' ? value : value.split('\n').filter((line) => line.trim() !== '');
        }
        if (previewOnly) return {pack:nextPack};
        const result = await writeSettings({ pack: nextPack });
        if (result?.settings !== undefined) {
          const draft = draftsRef.current;
          const values = { ...draft.values };
          const versions = { ...draft.versions };
          for (const { field, version } of changes) if (versions[field] === version) {
            delete values[field]; delete versions[field];
          }
          const resetVersion = Math.max(-1, ...changes.filter(change => change.field === 'chatReset').map(change => change.version));
          if (versions.chatVoice !== undefined && versions.chatVoice <= resetVersion) {
            delete values.chatVoice; delete versions.chatVoice;
          }
          draftsRef.current = { ...draft, values, versions };
          setPackDrafts(values);
        }
        return result;
      };
      const savePackField = (field, value) => {
        if (!setDraft(field, value)) return Promise.resolve();
        const change = { field, value, version: draftsRef.current.versions[field] };
        return queueWrite(() => persistPackChanges([change]));
      };
      const draftValue = (field, value) => Object.hasOwn(packDrafts, field) ? packDrafts[field] : value;

      if (settings === undefined) {
        return h('div', null,
          h('h2', { style: sectionTitleStyle }, '人格套壳'),
          h(LoadSettings, {
            onLoaded: (value) => {
              acceptSettings(value.settings);
              setMemoryLines(Array.isArray(value.memory) ? value.memory : []);
              setMemoryStats(value.memoryStats);
            },
          }),
        );
      }

      const colloquialControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', { type: 'checkbox', checked: settings.colloquialReports !== false,
              'aria-describedby': tabsId.current + '-colloquial-hint',
              onChange: (event) => save({ colloquialReports: event.target.checked }) }),
            h('span', { style: labelStyle }, '口语化转述')),
          h('span', { id: tabsId.current + '-colloquial-hint', style: hintStyle },
            '把书面说明讲得顺口一些，事实、条件和风险完整保留。关闭后更贴近原文句式。'));
      const processControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings?.includeToolSteps !== false,
              disabled: settings.trigger === 'report',
              'aria-describedby': tabsId.current + '-process-scope-hint',
              onChange: (event) => save({ includeToolSteps: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '同时改写阶段性输出'),
          ),
          h('span', { style: hintStyle, id: tabsId.current + '-process-scope-hint' },
            settings.trigger === 'report' ? '仅最终汇报不使用以下过程选项，原选择已保留；独立设为全部汇报的会话仍沿用这些选择。'
              : '让带工具调用的阶段汇报也使用当前人格。',
          ),
          h('label', { style: { ...toggleRowStyle, marginTop: '10px' } },
            h('input', { type: 'checkbox', checked: settings?.processToolUsage === true,
              disabled: settings.trigger === 'report' || settings?.includeToolSteps === false,
              'aria-describedby': tabsId.current + '-process-scope-hint',
              onChange: (event) => save({ processToolUsage: event.target.checked }) }),
            h('span', { style: labelStyle }, '允许过程转述参考运行信息'),
          ),
          h('span', { style: hintStyle },
            '将本段工作的分类统计随转述请求一并提供，可补充一句运行情况。'),
        );
      const quietControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', { type: 'checkbox', checked: settings.progressNotices === true,
              onChange: (event) => save({ progressNotices: event.target.checked }) }),
            h('span', { style: labelStyle }, '静默状态播报'),
          ),
          h('span', { style: hintStyle },
            '等待较久时听到一句状态播报。可选，会额外调用模型。'),
          h('label', { hidden: settings.progressNotices !== true, style: { ...toggleRowStyle, display: settings.progressNotices === true ? 'flex' : 'none', marginTop: '8px', flexWrap: 'wrap' } },
            h('span', { style: labelStyle }, '静默多久后播报（分钟）'),
            h('input', { type: 'number', min: 1, max: 60, step: 1, style: { ...inputStyle, width: '76px' },
              disabled: settings.progressNotices !== true,
              value: progressMinutesDraft ?? settings.progressMinutes ?? 5,
              onChange: (event) => setProgressMinutesDraft(event.target.value),
              onBlur: async (event) => {
                const value = Number(event.target.value);
                if (Number.isInteger(value) && value >= 1 && value <= 60 && value !== settings.progressMinutes) {
                  await save({ progressMinutes: value });
                }
                setProgressMinutesDraft(undefined);
              },
              onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur(); },
            }),
          ),
        );
      const reviewControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings.reviewHints !== false,
              onChange: (event) => save({ reviewHints: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '改写变化提示'),
          ),
          h('span', { style: hintStyle },
            '措辞变化较大，或检测到数字、局部否定变化时显示 ※，方便对照原文。只在本地检查，不增加模型调用。')
        );
      const thresholdControls = h('details', { style: { marginTop: '6px' } },
            h('summary', { style: { ...hintStyle, cursor: 'pointer' } }, '调整变化提示阈值'),
            h('label', { style: { ...toggleRowStyle, marginTop: '6px' } },
              h('span', { style: labelStyle }, `措辞变化阈值：${Math.round((reviewThresholdDraft ?? settings.reviewThreshold ?? 0.55) * 100)}/100`),
              h('input', {
                type: 'range', min: 0, max: 1, step: 0.05,
                'aria-label': '措辞变化提示阈值',
                value: reviewThresholdDraft ?? settings.reviewThreshold ?? 0.55,
                disabled: settings.reviewHints === false,
                onChange: (event) => setReviewThresholdDraft(Number(event.target.value)),
                // Commit once on blur, not one network request per slider tick.
                onBlur: async (event) => {
                  const value = Number(event.target.value);
                  if (value !== settings.reviewThreshold) await save({ reviewThreshold: value });
                  setReviewThresholdDraft(undefined);
                },
                onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur(); },
              })),
            h('span', { style: hintStyle },
              '默认 55；越低越容易提示，移开焦点后保存。低于阈值不显示；关键表达变化只作解释，不绕过阈值。'
              + '修改只影响已有评估的显示，不重新改写；旧记录不补算。'),
          );
      const subagentControls = h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('span', { style: { ...labelStyle, marginBottom: '2px' } }, '子代理会话'),
          h('label', { style: toggleRowStyle },
            h('input', {
              type: 'checkbox',
              checked: settings?.subagentSteps === true,
              onChange: (event) => save({ subagentSteps: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '改写子代理的过程输出'),
          ),
          h('span', { style: hintStyle }, '子代理的中间步骤基本没人看，默认不改写。'),
          h('label', { style: { ...toggleRowStyle, marginTop: '6px' } },
            h('input', {
              type: 'checkbox',
              checked: settings?.subagentReports === true,
              onChange: (event) => save({ subagentReports: event.target.checked }),
            }),
            h('span', { style: labelStyle }, '改写子代理的结论输出'),
          ),
          h('span', { style: hintStyle }, '子代理的最终答复；如果会转述给你，可以打开。'),
        );
    // INCLUDE settings-persona.js#editor
      const catalogueFailure=message=>h('div',{style:hintStyle,role:'status'},h('p',null,message),h('button',{type:'button',style:toggleStyle,onClick:()=>setCatalogueRetry(value=>value+1)},'重新读取模型目录'));
      const providerFailure=providersFailed?catalogueFailure('模型提供方列表暂时无法读取，已保存选择仍保留。'):null;
      const modelControls = h('div', { className: 'dsh-persona-model-fields' },providerFailure, h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
          h('span', { style: labelStyle }, '改写所用模型'),
          h('select', {
            style: inputStyle,
            'aria-label': '改写所用模型', value: settings?.provider ?? '',
            onChange: (event) => save({ provider: event.target.value, model: '' }),
          },
          h('option', { value: '' }, '跟随会话当前模型'),
          settings.provider&&!providers.some(entry=>entry.provider===settings.provider)?h('option',{value:settings.provider},settings.provider+'（暂未读取）'):null,
          providers.map((entry) => h('option', { key: entry.provider, value: entry.provider }, entry.name ?? entry.provider))),
          h('span', { style: hintStyle }, '留空即跟随当前会话；指定后所有会话都用它改写。'),
          h('span', { style: hintStyle }, settings?.reasoningEffort
            ? `推理强度已指定为 ${settings.reasoningEffort}；模型不支持时回到默认兼容策略。`
            : '改写默认优先关闭思考；模型无法关闭时使用其最低档，能力未知时按提供方默认兼容。失败仍保留原文。'),
        ),

        settings?.provider !== undefined && settings.provider !== ''
          ? h('div', { className: 'dsh-persona-setting-field', style: fieldStyle },
            h('span', { style: labelStyle }, '模型'),
            h('select', {
              style: inputStyle,
              'aria-label': '模型', value: settings.model ?? '',
              onChange: (event) => save({ model: event.target.value }),
            },
            h('option', { value: '' }, '该提供方的默认模型'),
            settings.model&&!models.some(entry=>entry.id===settings.model)?h('option',{value:settings.model},settings.model):null,
            models.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name))),
          )
          : null,modelsFailed&&!providersFailed?catalogueFailure('模型列表暂时无法读取，已保存选择仍保留。'):null);
      const settingsTabs = [['persona', '人格'], ['rewrite', '转述'], ['chat','聊天室'], ['memory', '记忆'], ['appearance', '外观'], ['usage', '用量'], ['advanced', '高级']];
      const visualizationControls=h('div',null,
        h('label',{style:fieldStyle},h('span',{style:labelStyle},'报告阅读模型'),
          h('select',{style:inputStyle,'aria-label':'报告阅读模型',value:settings.visualizationProvider??'',onChange:event=>save({visualizationProvider:event.target.value,visualizationModel:''})},
            h('option',{value:''},'跟随转述模型（默认）'),
            settings.visualizationProvider&&!providers.some(provider=>provider.provider===settings.visualizationProvider)?h('option',{value:settings.visualizationProvider},settings.visualizationProvider+'（暂不可用）'):null,
            ...providers.map(provider=>h('option',{key:provider.provider,value:provider.provider},provider.name??provider.provider)))),
        settings.visualizationProvider?h('label',{style:fieldStyle},h('span',{style:labelStyle},'模型名称'),
          h('select',{style:inputStyle,'aria-label':'报告阅读模型名称',value:settings.visualizationModel??'',onChange:event=>save({visualizationModel:event.target.value})},
            h('option',{value:''},'该提供方的默认模型'),
            settings.visualizationModel&&!visualizationModels.some(model=>model.id===settings.visualizationModel)?h('option',{value:settings.visualizationModel},settings.visualizationModel):null,
            ...visualizationModels.map(model=>h('option',{key:model.id,value:model.id},model.name??model.id)))):null,
        visualizationModelsFailed&&settings.visualizationProvider&&!providersFailed?catalogueFailure('模型列表暂时无法读取，已保存的选择仍保留。'):null,
        h('label',{style:toggleRowStyle},h('input',{type:'checkbox',checked:settings.visualizationThinking===true,onChange:event=>save({visualizationThinking:event.target.checked})}),h('span',null,'重点分析开启思考')),
        h('p',{style:hintStyle},'重点分析默认关闭思考。导览、展开和阅读主题在本地完成，不再次调用模型。'),
        h('label',{style:toggleRowStyle},h('input',{type:'checkbox',checked:settings.readableThinking!==false,onChange:event=>save({readableThinking:event.target.checked})}),h('span',null,'顺畅阅读开启思考')),
        h('p',{style:hintStyle},'顺畅阅读默认开启，强度采用模型默认档位。只在你确认生成后调用，结果计入报告阅读用量；不影响重点分析或聊天室。'));
      const panel = (id, content) => h('div', { key: id, role: 'tabpanel', id: tabsId.current + '-' + id,
        'aria-labelledby': tabsId.current + '-tab-' + id, hidden: activeTab !== id, 'data-settings-panel': id }, content);
      return h('div', { 'data-persona-shell': 'settings', className: 'dsh-persona-settings' },
        h('style', null, SETTINGS_CSS, SETTINGS_REDESIGN_CSS),
        h('header', { className: 'dsh-persona-settings-hero' },
          h('div', null,
            h('h2', null, '人格套壳'),
            h('p', null, '只换表达，原文随时可查。')),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', minWidth: 0 } },
            h('span', { className: 'dsh-persona-save-state', role: 'status', 'aria-live': 'polite',
              'data-state': /失败/.test(status) ? 'error' : /正在|尚未就绪/.test(status) ? 'pending' : 'saved' }, status || '自动保存'),
            failedSettingsSave ? h('button', { type: 'button', style: toggleStyle, disabled: status === '正在保存…', onClick: () => save({}) }, '重试保存当前设置') : null)),
        h('div', { className: 'dsh-persona-settings-tabs', role: 'tablist', 'aria-label': '设置分类',
          onKeyDown: (event) => {
            if (event.nativeEvent?.isComposing || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const current = settingsTabs.findIndex(([id]) => id === activeTab);
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? settingsTabs.length - 1
              : (current + (event.key === 'ArrowRight' ? 1 : -1) + settingsTabs.length) % settingsTabs.length;
            setActiveTab(settingsTabs[index][0]); event.currentTarget.querySelectorAll('[role=tab]')[index]?.focus();
          } }, ...settingsTabs.map(([id, label]) => h('button', { key: id, type: 'button', role: 'tab',
            id: tabsId.current + '-tab-' + id, 'aria-controls': tabsId.current + '-' + id,
            'aria-selected': activeTab === id, tabIndex: activeTab === id ? 0 : -1, onClick: () => setActiveTab(id) }, label))),
        shippedRendererOk ? null : h('div', { style: warningStyle },
          '独立原文预览暂以纯文本显示，聊天正文仍由官方组件渲染。'),
        rendererState.status === 'incompatible' || rendererState.status === 'error'
          ? h('div', { style: warningStyle, role: 'status' }, '人格显示已暂停，当前保留官方原文。',
            h('details', null, h('summary', null, '查看原因'), rendererState.reason)) : null,
        panel('persona', h('section', { className: 'dsh-persona-section', 'aria-label': '选择人格' },
          settingsHeading('', '默认人格', '用于没有单独指定角色的会话。' + (presets.length > 5 ? ' 共 ' + presets.length + ' 个，可滚动选择。' : '')),
          personaControls,
          h('div', { className: 'dsh-persona-persona-tools' },
            settingsFold('create-persona', '创建新人格', '从你的人设提示词开始', generatorControls,
              { open: generated !== undefined ? true : undefined }),
            settingsFold('edit-persona', '调整当前人格', Object.keys(packDrafts).length
              ? '有尚未保存的输入' : '身份、语气、示例与称呼',
              h('div', null, h('p', { className: 'dsh-persona-section-note' },
                '编辑后自动保存；调整内置人格会另存一份，原版始终保留。'), editorControls,
              h(PersonaTrial,{key:activePresetId,personaId:activePresetId,readDraft:()=>persistPackChanges(draftChanges(),true)})))))),
        panel('rewrite', h('section', { className: 'dsh-persona-section', 'aria-label': '日常转述' },
          settingsHeading('', '日常转述', '决定哪些汇报换一种口吻。'),
          h('label', { style: fieldStyle }, h('span', { style: labelStyle }, '默认转述范围'),
            h('select', { style: inputStyle, 'aria-label': '默认转述范围', value: settings.trigger ?? 'step',
              onChange: (e) => save({ trigger: e.target.value }) },
              h('option', { value: 'step' }, '全部汇报'), h('option', { value: 'report' }, '仅最终汇报')),
            h('span', { style: hintStyle }, '聊天顶部可以单独选择人格、范围或安排接力；独立选择的会话不随全局切换。')),
          h('div', { className: 'dsh-persona-process-options', style: { display: 'grid', gap: '16px' } }, colloquialControls, processControls),
          h('div', { className: 'dsh-persona-common-grid' }, reviewControls, quietControls),
          settingsFold('rewrite-help', '这些选项如何工作', '调用用量与原文边界',
            h('div', { className: 'dsh-persona-help-copy' },
              h('p', null, '阶段性输出关闭后跳过带工具调用的步骤。要严格只改最终汇报，请将转述范围设为仅最终汇报。'),
              h('p', null, '过程转述请求会一并收到分类统计与会话节奏，每条可补充最多 40 字，每轮最多 3 条。'),
              h('p', null, '静默播报仅为前台正在查看的主会话生成，标记为 ◈；每轮最多3次，无新事实不重复调用，也不代表任务完成。'),
              h('p', null, '※ 提示措辞、数字或局部状态变化，不保证语义一致。重要事实、条件和风险仍应对照原文。')), { compact: true }))),
        panel('chat',h(React.Fragment,null,h('section',{className:'dsh-persona-section','aria-label':'聊天室模型设置'},
          settingsHeading('','聊天室','默认跟随转述模型，可以单独选择。修改只影响之后的请求。'),
          providerFailure,
          h('label',{style:fieldStyle},h('span',{style:labelStyle},'聊天室模型'),
            h('select',{style:inputStyle,'aria-label':'聊天室模型',value:settings.chatProvider??'',onChange:e=>save({chatProvider:e.target.value,chatModel:''})},
              h('option',{value:''},'跟随转述模型（默认）'),
              settings.chatProvider&&!providers.some(p=>p.provider===settings.chatProvider)?h('option',{value:settings.chatProvider},settings.chatProvider+'（暂不可用）'):null,
              ...providers.map(p=>h('option',{key:p.provider,value:p.provider},p.name??p.provider)))),
          settings.chatProvider?h('label',{style:fieldStyle},h('span',{style:labelStyle},'模型名称'),
            h('select',{style:inputStyle,'aria-label':'聊天室模型名称',value:settings.chatModel??'',onChange:e=>save({chatModel:e.target.value})},
              h('option',{value:''},'该提供方的默认模型'),
              settings.chatModel&&!chatModels.some(m=>m.id===settings.chatModel)?h('option',{value:settings.chatModel},settings.chatModel):null,
              ...chatModels.map(m=>h('option',{key:m.id,value:m.id},m.name??m.id)))):null,
          chatModelsFailed&&settings.chatProvider&&!providersFailed?catalogueFailure('模型列表暂时无法读取，已保存的选择仍保留。'):null,
          h('div',{className:'dsh-persona-process-options',style:{borderBottom:0,paddingBottom:0}},
            h(ChatThinkingControls,{visible:activeTab==='chat',settings,save}))),h('section',{className:'dsh-persona-section','aria-label':'聊天室辅助能力'},
          settingsHeading('','辅助能力','开启后由判断线程按需使用，每条请求最多一个任务；调查只访问公开网页，推演不联网。'),
          h('label',{style:{...fieldStyle,display:'flex',gap:8}},h('input',{type:'checkbox',checked:settings.chatResearchEnabled===true,onChange:e=>save({chatResearchEnabled:e.target.checked})}),'允许调查资料'),
          h('p',{style:hintStyle},'使用 DSH 已配置的搜索服务。最多 4 个模型步骤、3 次搜索、4 次网页读取，60 秒内结束；不读取文件或执行命令。'),
          h('label',{style:{...fieldStyle,display:'flex',gap:8}},h('input',{type:'checkbox',checked:settings.chatDeepReasoningEnabled===true,onChange:e=>save({chatDeepReasoningEnabled:e.target.checked})}),'允许深入推演'),
          h('label',{style:{...fieldStyle,display:'flex',gap:8}},h('input',{type:'checkbox',checked:settings.chatSummarizeEnabled===true,onChange:e=>save({chatSummarizeEnabled:e.target.checked})}),'允许按需整理工作参考'),
          h('p',{style:hintStyle},'一次独立模型请求，默认启用思考，最多 60 秒。未另选模型时沿用聊天室模型；无法启用思考时会提示，不会静默关闭思考。'),
          settings.chatDeepReasoningEnabled?h('div',null,h('label',{style:fieldStyle},h('span',{style:labelStyle},'深入推演模型'),h('select',{style:inputStyle,'aria-label':'深入推演提供方',value:settings.chatDeepReasoningProvider??'',onChange:e=>save({chatDeepReasoningProvider:e.target.value,chatDeepReasoningModel:''})},h('option',{value:''},'沿用聊天室模型'),...providers.map(p=>h('option',{key:p.provider,value:p.provider},p.name??p.provider)))),
            settings.chatDeepReasoningProvider?h('label',{style:fieldStyle},h('span',{style:labelStyle},'模型名称'),h('select',{style:inputStyle,'aria-label':'深入推演模型名称',value:settings.chatDeepReasoningModel??'',onChange:e=>save({chatDeepReasoningModel:e.target.value})},h('option',{value:''},'提供方默认'),...supportModels.map(m=>h('option',{key:m.id,value:m.id},m.name??m.id)))):null,
            supportModelsFailed?h('p',{style:hintStyle},'模型列表暂不可用，已保存的选择仍保留。'):null):null),h(RoomReferencesPanel,{visible:activeTab==='chat'}))),
        panel('memory', h('section', { className: 'dsh-persona-section', 'aria-label': '记忆与约定' },
          settingsHeading('', '记忆与约定', '查看原话依据，确认哪些偏好继续使用。'), h(MemoryPanel, { settings, save, presets, importRevision:memoryImportRevision }))),
        panel('appearance', h('section', { className: 'dsh-persona-section', 'aria-label': '聊天室外观' },
          settingsHeading('', '聊天室外观', '用户头像只用于展示，不会发送给模型。'),
          (activeTab==='appearance'||appearanceVisited)?h(ChatUserSettings,{visible:activeTab==='appearance'}):null)),
        panel('usage', h(ModelUsagePanel, { visible: activeTab === 'usage' })),
        panel('advanced', h('section', { className: 'dsh-persona-section', 'aria-label': '高级设置' },
          settingsHeading('', '高级设置', '模型与较少使用的选项。'),
          settingsFold('asset-backup','备份与恢复','人格卡与记忆',h(AssetBackup,{presets,onImported:summary=>{
            if(summary.entries)setMemoryImportRevision(n=>n+1);
            if(summary.personas.length)return refreshPresets();
          }})),
          h('div', { className: 'dsh-persona-advanced-grid' },
            h('div', null, h('h3', { className: 'dsh-persona-subheading' }, '转述模型'), modelControls),
            h('div', null, subagentControls),
            h('div', { className: 'dsh-persona-wide' }, thresholdControls)),
          settingsFold('report-visualization-model','报告阅读','按需生成 · 默认跟随转述模型',visualizationControls))),
        h('p', { className: 'dsh-persona-footer-note' }, '转述失败时显示原文。聊天室保留独立记录。'));
    }

    /** A manual read retry never repeats a settings write or revives a closed page. */
    function LoadSettings({ onLoaded }) {
      const [attempt,setAttempt]=React.useState(0),[status,setStatus]=React.useState('loading'),owner=React.useRef(0),loaded=React.useRef(onLoaded);
      loaded.current=onLoaded;
      React.useEffect(() => {
        const readAt=chatThinkingReadAt(),token=++owner.current,abort=new AbortController();let alive=true,timedOut=false;
        const timeout=setTimeout(()=>{timedOut=true;abort.abort();},10000);setStatus('loading');
        (async () => {
          try {
            const response = await fetch(`${ROUTE}/settings`,{signal:abort.signal});
            if(!alive||token!==owner.current||abort.signal.aborted)return;
            if(!response.ok){setStatus(response.status===401||response.status===403?'auth':'error');return;}
            const value = await response.json();
            if(!alive||token!==owner.current||abort.signal.aborted)return;
            // The whole payload, not just `settings`: it also carries the learned
            // memory, and the page renders both from one fetch.
            if(!value?.settings||typeof value.settings!=='object'||Array.isArray(value.settings)){setStatus('error');return;}
            chatThinkingSnapshots.set(value.settings,{readAt});loaded.current(value);
          } catch {if(alive&&token===owner.current&&(!abort.signal.aborted||timedOut))setStatus('error');}
          finally{clearTimeout(timeout);}
        })();
        return()=>{alive=false;owner.current++;clearTimeout(timeout);abort.abort();};
      }, [attempt]);
      return h('div',{'aria-label':'读取插件设置',role:'group'},h('p',{style:hintStyle,role:'status','aria-live':'polite'},status==='loading'?'正在读取设置…'
        :status==='auth'?'设置未能读取。请重新连接 DSH 后重试。':'暂时无法读取设置，请重试。'),
        status!=='loading'?h('button',{type:'button',style:toggleStyle,onClick:()=>setAttempt(value=>value+1)},'重新读取设置'):null);
    }

