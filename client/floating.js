    // BEGIN GENERATED FLOATING LAYOUT
    // END GENERATED FLOATING LAYOUT
    const floatingLayout=createFloatingLayout(),floatingRects=new Map();
    const keepFloatingRect=(id,value)=>{floatingRects.set(id,{...value});while(floatingRects.size>32)floatingRects.delete(floatingRects.keys().next().value);};
    let floatingInteraction;
    const floatingGeometryKeys=['position','inset','left','top','right','bottom','width','height','max-width','max-height','min-width','min-height','margin','transform'];
    const floatingSnapshot=node=>floatingGeometryKeys.map(key=>[key,node.style.getPropertyValue(key),node.style.getPropertyPriority(key)]);
    const restoreFloatingStyle=(node,saved)=>{for(const [key,value,priority] of saved)value?node.style.setProperty(key,value,priority):node.style.removeProperty(key);};
    const applyFloatingRect=(node,rect)=>{Object.assign(node.style,{position:'fixed',inset:'auto',left:rect.left+'px',top:rect.top+'px',right:'auto',bottom:'auto',width:rect.width+'px',height:rect.height+'px',maxWidth:'none',maxHeight:'none',minWidth:0,minHeight:0,margin:0,transform:'none'});node.dataset.floatingCustom='true';};
    const floatingView=topGap=>{const v=window.visualViewport,width=v?.width??window.innerWidth,height=v?.height??window.innerHeight;
      const top=Math.min(topGap,Math.max(8,height-100));return{left:(v?.offsetLeft??0)+8,top:(v?.offsetTop??0)+top,width:Math.max(1,width-16),height:Math.max(1,height-top-8)};};
    function useFloatingWindow({id,ref,getNode,active=true,wide=false,onWideChange,minWidth=280,minHeight=300,topGap=52}){
      const [rect,setRect]=React.useState(()=>floatingRects.get(id)??null),[,refresh]=React.useState(0);
      const owner=React.useRef({}),base=React.useRef(null),options=React.useRef(null);
      options.current={id,ref,getNode,active,wide,onWideChange,minWidth,minHeight,topGap,rect};
      const nodeOf=()=>options.current.getNode?.()??options.current.ref?.current;
      const commit=value=>{keepFloatingRect(id,value);setRect(value);};
      const reset=()=>{floatingInteraction?.owner===owner.current&&floatingInteraction.finish(true);floatingRects.delete(id);setRect(null);onWideChange?.(false);
        const node=nodeOf();if(node&&base.current?.node===node){restoreFloatingStyle(node,base.current.style);delete node.dataset.floatingCustom;}};
      useLayoutEffect(()=>setRect(floatingRects.get(id)??null),[id]);
      useLayoutEffect(()=>{
        const node=nodeOf();if(!active||!node)return;
        base.current={node,style:floatingSnapshot(node)};node.dataset.floatingWindow=id;
        const resize=()=>refresh(value=>value+1);
        window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);window.visualViewport?.addEventListener('scroll',resize);
        return()=>{if(floatingInteraction?.owner===owner.current)floatingInteraction.finish(false,true);
          window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('scroll',resize);
          restoreFloatingStyle(node,base.current.style);delete node.dataset.floatingWindow;delete node.dataset.floatingCustom;};
      },[id,active]);
      useLayoutEffect(()=>{
        const node=nodeOf();if(!active||!node||base.current?.node!==node)return;
        if(floatingInteraction?.owner===owner.current){applyFloatingRect(node,floatingLayout.fit(floatingInteraction.rect,floatingView(topGap),{minWidth,minHeight}));return;}
        if(rect)applyFloatingRect(node,wide?floatingView(topGap):floatingLayout.fit(rect,floatingView(topGap),{minWidth,minHeight}));
        else{restoreFloatingStyle(node,base.current.style);delete node.dataset.floatingCustom;}
      });
      const begin=(event,direction='move')=>{
        if(!active||event.button!==0||event.isPrimary===false)return;
        if(direction==='move'&&event.target.closest?.('button,input,textarea,select,a,summary,[role=button],[role=checkbox]'))return;
        const node=nodeOf();if(!node)return;
        event.preventDefault();event.stopPropagation();cancelChatMotion();floatingInteraction?.finish(true);
        if(!node.isConnected||node!==nodeOf())return;
        for(const animation of node.getAnimations?.()??[])if(animation.effect?.target===node)animation.cancel();
        const origin=node.getBoundingClientRect(),before=floatingSnapshot(node),custom=node.dataset.floatingCustom;
        let start={left:origin.left,top:origin.top,width:origin.width,height:origin.height};
        if(wide&&rect&&direction==='move')start=floatingLayout.fit({...rect,left:event.clientX-(event.clientX-origin.left)/origin.width*rect.width,
          top:event.clientY-Math.min(60,event.clientY-origin.top)},floatingView(topGap),{minWidth,minHeight});
        const previous=rect,wasWide=wide,pointer=event.pointerId,target=event.currentTarget,doc=node.ownerDocument,view=doc.defaultView??window;
        const x=event.clientX,y=event.clientY,body=doc.body.style,bodyStyle=['user-select','-webkit-user-select','cursor'].map(key=>[key,body.getPropertyValue(key),body.getPropertyPriority(key)]);
        let moved=false;
        const current={owner:owner.current,rect:start,finish};floatingInteraction=current;
        node.dataset.floatingInteracting='true';
        function finish(cancel,quiet=false){
          if(floatingInteraction!==current)return;floatingInteraction=null;
          delete node.dataset.floatingInteracting;
          view.removeEventListener('pointermove',move,true);view.removeEventListener('pointerup',up,true);view.removeEventListener('pointercancel',cancelPointer,true);
          view.removeEventListener('blur',cancelBlur);view.removeEventListener('keydown',key,true);target.removeEventListener('lostpointercapture',cancelBlur);
          try{if(target.hasPointerCapture?.(pointer))target.releasePointerCapture(pointer);}catch{/* The surface may have been retired. */}
          for(const [name,value,priority] of bodyStyle)value?body.setProperty(name,value,priority):body.removeProperty(name);
          if(cancel){restoreFloatingStyle(node,before);if(custom)node.dataset.floatingCustom=custom;else delete node.dataset.floatingCustom;
            if(moved&&!quiet){setRect(previous);options.current.onWideChange?.(wasWide);}}
          else if(moved){if(quiet)keepFloatingRect(id,current.rect);else commit(current.rect);}
        }
        function move(e){if(e.pointerId!==pointer)return;const dx=e.clientX-x,dy=e.clientY-y;if(!moved&&direction==='move'&&Math.abs(dx)+Math.abs(dy)<2)return;
          const o=options.current,bounds=floatingView(o.topGap),limits={minWidth:o.minWidth,minHeight:o.minHeight};
          current.rect=direction==='move'?floatingLayout.move(start,dx,dy,bounds,limits):floatingLayout.resize(start,direction,dx,dy,bounds,limits);
          if(!moved){moved=true;setRect(current.rect);o.onWideChange?.(false);}applyFloatingRect(node,current.rect);e.preventDefault();}
        function up(e){if(e.pointerId===pointer)finish(false);}
        function cancelPointer(e){if(e.pointerId===pointer)finish(true);}
        function cancelBlur(){finish(true);}
        function key(e){if(e.key==='Escape'&&!e.isComposing){e.preventDefault();e.stopPropagation();finish(true);}}
        body.setProperty('user-select','none');body.setProperty('-webkit-user-select','none');body.setProperty('cursor',direction==='move'?'grabbing':direction+'-resize');
        view.addEventListener('pointermove',move,true);view.addEventListener('pointerup',up,true);view.addEventListener('pointercancel',cancelPointer,true);
        view.addEventListener('blur',cancelBlur);view.addEventListener('keydown',key,true);target.addEventListener('lostpointercapture',cancelBlur);
        try{target.setPointerCapture?.(pointer);}catch{/* Window listeners also cover older pointer implementations. */}
      };
      const keyboard=event=>{
        if(event.isComposing)return;
        if(event.key==='Home'){event.preventDefault();event.stopPropagation();reset();return;}
        if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)||floatingInteraction)return;
        event.preventDefault();event.stopPropagation();cancelChatMotion();const node=nodeOf();if(!node)return;
        for(const animation of node.getAnimations?.()??[])if(animation.effect?.target===node)animation.cancel();
        const r=node.getBoundingClientRect(),start={left:r.left,top:r.top,width:r.width,height:r.height},step=event.shiftKey?1:10;
        const dx=event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0,dy=event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0;
        const next=(event.ctrlKey?floatingLayout.move:floatingLayout.resize)(start,...(event.ctrlKey?[dx,dy]:['se',dx,dy]),floatingView(topGap),{minWidth,minHeight});
        onWideChange?.(false);commit(next);applyFloatingRect(node,next);
      };
      return {begin,keyboard,reset,dragProps:{'data-floating-drag':'',title:'拖动标题栏移动窗口；拖动边缘调整大小；双击空白标题栏恢复默认',
        onPointerDown:event=>begin(event),onDoubleClick:event=>{if(!event.target.closest?.('button,input,textarea,select,a,summary'))reset();}}};
    }
    function FloatingWindowHandles({controls,label}){
      return h(React.Fragment,null,...['n','ne','e','se','s','sw','w','nw'].map(edge=>h(edge==='se'?'button':'span',{key:edge,
        type:edge==='se'?'button':undefined,className:'dsh-floating-resize','data-edge':edge,'aria-hidden':edge!=='se'||undefined,
        'aria-label':edge==='se'?'调整'+label+'窗口大小':undefined,title:edge==='se'?'拖动调整大小；方向键调整，Ctrl+方向键移动，Home恢复默认':undefined,
        onPointerDown:event=>controls.begin(event,edge),onKeyDown:edge==='se'?controls.keyboard:undefined})));
    }
    const FLOATING_WINDOW_CSS=`
      [data-floating-custom],[data-floating-interacting]{transition:none!important}
      .dsh-persona-chat[data-floating-custom]{container-type:inline-size;container-name:dsh-floating-chat}.dsh-report-reading[data-floating-custom]{container-type:inline-size;container-name:dsh-floating-report}
      @container dsh-floating-chat (max-width:364px){
        .dsh-persona-chat .dsh-persona-chat-top[data-room=true]{grid-template-columns:40px minmax(0,1fr) repeat(3,30px);gap:2px 4px;padding:8px 10px 7px}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-room-avatar-display{grid-column:1;grid-row:1/span 2}.dsh-persona-chat-top[data-room=true] :is(.dsh-persona-chat-room-heading,.dsh-persona-chat-actions){display:contents}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-room-title{grid-column:2;grid-row:1}.dsh-persona-chat-top[data-room=true] .dsh-persona-chat-room-tools{grid-column:2;grid-row:2}
        .dsh-persona-chat-top[data-room=true] .dsh-persona-chat-actions button{padding:1px;min-height:24px;font-size:11px;grid-row:1}.dsh-persona-chat-top[data-room=true] .dsh-persona-chat-actions button:nth-child(-n+2){grid-row:2;min-height:20px;border:none;color:var(--chat-muted)}
        .dsh-persona-chat-actions button:nth-child(3){grid-column:3}.dsh-persona-chat-actions button:is(:nth-child(1),:nth-child(4)){grid-column:4}.dsh-persona-chat-actions button:is(:nth-child(2),:nth-child(5)){grid-column:5}
      }
      @container dsh-floating-report (max-width:586px){.rr-head{padding:10px!important;gap:5px!important}.rr-head-title h2{font-size:13px!important}.rr-head-title small{font-size:9px!important}.rr-head-actions{gap:3px!important}.rr-head-actions button{font-size:10px!important;padding:4px 6px!important}.rr-toolbar{padding:9px 10px!important;gap:4px!important}.rr-content{padding:23px 17px 30px!important}.rr-footer{padding:8px 10px!important}}
      [data-floating-drag]{cursor:grab;touch-action:none}[data-floating-drag] :is(button,input,select,a,summary){touch-action:auto}
      .dsh-floating-resize{position:absolute;display:block;margin:0!important;padding:0!important;min-width:0!important;min-height:0!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important;z-index:5;touch-action:none}
      .dsh-floating-resize[data-edge=n],.dsh-floating-resize[data-edge=s]{left:14px;right:14px;height:5px;cursor:ns-resize}.dsh-floating-resize[data-edge=n]{top:0}.dsh-floating-resize[data-edge=s]{bottom:0}
      .dsh-floating-resize[data-edge=e],.dsh-floating-resize[data-edge=w]{top:14px;bottom:14px;width:5px;cursor:ew-resize}.dsh-floating-resize[data-edge=e]{right:0}.dsh-floating-resize[data-edge=w]{left:0}
      .dsh-floating-resize:is([data-edge=ne],[data-edge=se],[data-edge=sw],[data-edge=nw]){width:14px;height:14px}.dsh-floating-resize[data-edge=ne]{top:0;right:0;cursor:nesw-resize}.dsh-floating-resize[data-edge=nw]{top:0;left:0;cursor:nwse-resize}.dsh-floating-resize[data-edge=sw]{bottom:0;left:0;cursor:nesw-resize}.dsh-floating-resize[data-edge=se]{right:0;bottom:0;cursor:nwse-resize}
      .dsh-floating-resize[data-edge=se]:after{content:'';position:absolute;right:3px;bottom:3px;width:6px;height:6px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;opacity:.3}.dsh-floating-resize[data-edge=se]:focus-visible{outline:2px solid var(--chat-brand,var(--rr-accent,var(--dsw-alias-brand-primary,#4f6cdb)))!important;outline-offset:-2px}
      .dsh-persona-chat[data-floating-custom] .dsh-persona-chat-thread-wrap{min-height:0}
      .dsh-persona-action[data-floating-custom]>.dsh-persona-action-surface{height:100%;max-height:100%;min-height:0}
      [data-floating-custom]>.persona-shell-comparison-surface{width:100%;height:100%;max-height:100%;min-height:0}
    `;
    const chatRoomLayout = { wide:false, composeExpanded:false };
    const chatRetryIds = new Map();
    const chatAnimatedAttempts = new Set();
    const markChatAnimation=id=>{chatAnimatedAttempts.add(id);while(chatAnimatedAttempts.size>200)chatAnimatedAttempts.delete(chatAnimatedAttempts.values().next().value);};
    const chatLaunchListeners = new Set();
    const floatingDocks=new Set();
    function layoutFloatingDocks(){
      const gap=7;
      const nodes=[...floatingDocks].filter(node=>node.isConnected).sort((a,b)=>(Number(a.dataset.dockOrder)||0)-(Number(b.dataset.dockOrder)||0));
      let bottom=0;
      for(const node of nodes){
        const height=node.offsetHeight;
        node.style.right='max(16px, env(safe-area-inset-right))';
        node.style.bottom='calc(max(16px, env(safe-area-inset-bottom)) + '+bottom+'px)';
        bottom+=height+gap;
      }
    }
    function useFloatingDock(ref,active){
      useLayoutEffect(()=>{
        const node=ref.current;if(!active||!node)return;
        floatingDocks.add(node);layoutFloatingDocks();
        const observer=typeof ResizeObserver==='function'?new ResizeObserver(layoutFloatingDocks):null;observer?.observe(node);
        if(floatingDocks.size===1)window.addEventListener('resize',layoutFloatingDocks);
        return()=>{observer?.disconnect();floatingDocks.delete(node);if(!floatingDocks.size)window.removeEventListener('resize',layoutFloatingDocks);layoutFloatingDocks();};
      },[active]);
    }
