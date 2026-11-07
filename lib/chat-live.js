import { chatResponseBody, plainChatMessages } from './persona-chat.js';

/** Decode message text only. Incomplete escapes and UTF-16 pairs wait for the next delta. */
export function partialChatReply(wire) {
  const response = chatResponseBody(wire, true);
  if (!response) return [];
  wire = response.body;
  if (response.kind === 'text') {
    if (/[\uD800-\uDBFF]$/.test(wire)) wire = wire.slice(0, -1);
    const messages = plainChatMessages(wire);
    return messages?.map((text, index) => ({ text, complete: index < messages.length - 1 })) ?? [];
  }
  const prefix=/^\s*\{\s*"messages"\s*:\s*\[/.exec(wire);
  if(!prefix)return [];
  let i=prefix[0].length,total=0;const messages=[];
  const space=()=>{while(/\s/.test(wire[i]??'')&&i<wire.length)i++;};
  while(i<wire.length&&messages.length<6){
    space();if(wire[i]===']')break;if(wire[i]!=='"')return [];
    i++;let text='',complete=false;
    while(i<wire.length){
      const c=wire[i++];if(c==='"'){complete=true;break;}
      if(c==='\\'){
        if(i>=wire.length)break;const escape=wire[i++];
        if(escape==='u'){
          if(wire.length-i<4)break;const digits=wire.slice(i,i+4);if(!/^[\da-f]{4}$/i.test(digits))return [];
          text+=String.fromCharCode(parseInt(digits,16));i+=4;
        }else{const values={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};
          if(!Object.hasOwn(values,escape))return [];text+=values[escape];}
      }else{if(c.charCodeAt(0)<32)return [];text+=c;}
      if(text.length>2000||total+text.length>6000)return [];
    }
    if(!complete&&/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);
    if(text.length>2000||total+text.length>6000)return [];
    total+=text.length;messages.push({text,complete});if(!complete)break;
    space();if(i>=wire.length||wire[i]===']')break;if(wire[i++]!==',')return [];
  }
  return messages;
}

/** Coalesced ephemeral snapshots, never a token journal or a persisted draft. */
export function createChatLive({limit=32}={}){
  const values=new Map(),listeners=new Map();let stopped=false,active=0;
  const changed=key=>{for(const fn of listeners.get(key)??[])fn();};
  return{
    publish(key,value){if(stopped)return;values.delete(key);values.set(key,structuredClone(value));while(values.size>64)values.delete(values.keys().next().value);changed(key);},
    clear(key){values.delete(key);changed(key);},
    clearRoom(roomId){for(const [key,value] of values)if(value.roomId===roomId){values.delete(key);changed(key);}},
    close(){stopped=true;for(const key of listeners.keys())changed(key);values.clear();},
    read:key=>values.get(key),
    async *observe(key,signal){
      if(active>=limit)throw Error('chat-live-capacity');if(stopped||signal.aborted)return;
      let dirty=true,wake;const notify=()=>{dirty=true;wake?.();};
      let own=listeners.get(key);if(!own){own=new Set();listeners.set(key,own);}own.add(notify);active++;signal.addEventListener('abort',notify);
      try{while(!stopped&&!signal.aborted){if(!dirty){await new Promise(r=>{wake=r;});wake=undefined;continue;}
        dirty=false;yield values.has(key)?structuredClone(values.get(key)):null;}}
      finally{active--;own.delete(notify);if(!own.size)listeners.delete(key);signal.removeEventListener('abort',notify);}
    },
  };
}
