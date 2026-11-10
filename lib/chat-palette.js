/** Small, dependency-free avatar palette. Never receives chat text or model data. */
export function createChatPalette() {
  const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
  const wrap=value=>(value%360+360)%360;
  const distance=(a,b)=>Math.min(Math.abs(a-b),360-Math.abs(a-b));
  const hash=value=>{let result=2166136261;for(let i=0;i<value.length;i++)result=Math.imul(result^value.charCodeAt(i),16777619);return result>>>0;};
  const builtins={ '大肥鱼（默认）':{h:222,s:58,offset:-4},'鲸鲸（实验性）':{h:205,s:52,offset:-18},
    '大肥龙':{h:255,s:44,offset:-14},'Claude小姐':{h:25,s:62,offset:0},Gemini:{h:280,s:56,offset:24} };
  function dominant(pixels) {
    if(!pixels||pixels.length<4||pixels.length%4||pixels.length>128*128*4)return null;
    const bins=Array.from({length:24},()=>({weight:0,x:0,y:0,s:0}));
    for(let at=0;at<pixels.length;at+=4){
      const r=pixels[at]/255,g=pixels[at+1]/255,b=pixels[at+2]/255,a=pixels[at+3]/255;
      if(![r,g,b,a].every(Number.isFinite)||a<.5)continue;
      const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min,l=(max+min)/2;
      if(delta<.055||l<.1||l>.93)continue;
      const s=delta/(1-Math.abs(2*l-1));if(s<.12)continue;
      let h=max===r?((g-b)/delta)%6:max===g?(b-r)/delta+2:(r-g)/delta+4;h=wrap(h*60);
      const skin=h<52&&l>.62&&r>g&&g>b&&g-b<.2,weight=a*(.2+s*s)*(skin?0.25:1);
      const bin=bins[Math.round(h/15)%24];bin.weight+=weight;bin.x+=Math.cos(h*Math.PI/180)*weight;
      bin.y+=Math.sin(h*Math.PI/180)*weight;bin.s+=s*weight;
    }
    const best=bins.reduce((a,b)=>a.weight>=b.weight?a:b);if(best.weight<1)return null;
    return{h:Math.round(wrap(Math.atan2(best.y,best.x)*180/Math.PI)),s:Math.round(clamp(best.s/best.weight*100,30,68))};
  }
  function allocate(people) {
    const tones=new Map(),used=[];
    const members=(Array.isArray(people)?people:[]).filter((person,index,all)=>typeof person?.id==='string'&&person.id.length<=200
      &&all.findIndex(other=>other?.id===person.id)===index).slice(0,64).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    for(const person of members){
      const seed=hash(person.id),builtin=Object.hasOwn(builtins,person.id)?builtins[person.id]:null;
      const sampled=person.color&&Number.isFinite(person.color.h)&&Number.isFinite(person.color.s)?person.color:null;
      const base=sampled??builtin??{h:210+seed%65,s:38},offset=sampled?(builtin?.offset??seed%17-8):0;
      const desired=wrap(base.h+offset),s=Math.round(clamp(base.s,44,66)),gap=members.length<=6?14:10;
      let h=desired;
      for(const step of [0,-1,1,-2,2,-3,3,-4,4,-5,5]){
        const candidate=wrap(desired+step*gap);if(used.every(other=>distance(candidate,other)>=gap)){h=candidate;break;}
      }
      used.push(h);tones.set(person.id,{h:Math.round(h),s});
    }
    return tones;
  }
  const style=tone=>tone?{'--chat-persona-color':`hsl(${wrap(tone.h)} ${clamp(tone.s,44,66)}% 48%)`}:undefined;
  return{dominant,allocate,style};
}
