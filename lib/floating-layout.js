/** Local window geometry, independent of chat, reports and model state. */
export function createFloatingLayout() {
  const number=(value,fallback)=>Number.isFinite(value)?value:fallback;
  const clamp=(value,min,max)=>Math.max(min,Math.min(value,max));
  const area=value=>({left:number(value?.left,8),top:number(value?.top,52),
    width:Math.max(1,number(value?.width,800)),height:Math.max(1,number(value?.height,600))});
  const limits=(bounds,options)=>({width:Math.min(bounds.width,Math.max(1,number(options?.minWidth,280))),
    height:Math.min(bounds.height,Math.max(1,number(options?.minHeight,240)))});
  function fit(rect,view,options){
    const b=area(view),min=limits(b,options);
    const width=clamp(number(rect?.width,min.width),min.width,b.width),height=clamp(number(rect?.height,min.height),min.height,b.height);
    return {left:clamp(number(rect?.left,b.left),b.left,b.left+b.width-width),
      top:clamp(number(rect?.top,b.top),b.top,b.top+b.height-height),width,height};
  }
  function move(rect,dx,dy,view,options){
    const start=fit(rect,view,options);
    return fit({...start,left:start.left+number(dx,0),top:start.top+number(dy,0)},view,options);
  }
  function resize(rect,direction,dx,dy,view,options){
    const b=area(view),min=limits(b,options),start=fit(rect,b,options),next={...start};
    if(!['n','ne','e','se','s','sw','w','nw'].includes(direction))return next;
    dx=number(dx,0);dy=number(dy,0);
    if(direction.includes('e'))next.width=clamp(start.width+dx,min.width,b.left+b.width-start.left);
    if(direction.includes('s'))next.height=clamp(start.height+dy,min.height,b.top+b.height-start.top);
    if(direction.includes('w')){next.width=clamp(start.width-dx,min.width,start.left+start.width-b.left);next.left=start.left+start.width-next.width;}
    if(direction.includes('n')){next.height=clamp(start.height-dy,min.height,start.top+start.height-b.top);next.top=start.top+start.height-next.height;}
    return fit(next,b,options);
  }
  return {fit,move,resize};
}
