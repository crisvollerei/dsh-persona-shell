import {lookup as dnsLookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {publicSupportUrl} from './chat-support-templates.js';

export function publicIpv4(value){
  const p=value.split('.').map(Number);if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
  const [a,b,c]=p;return a!==0&&a!==10&&a!==127&&a<224&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)
    &&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0||b===2))&&!(a===198&&(b===18||b===19||b===51&&c===100))&&!(a===203&&b===0&&c===113);
}
export function supportAbortable(value,signal){
  signal?.throwIfAborted();return new Promise((resolve,reject)=>{
    const stop=()=>reject(signal.reason??Error('support-cancelled'));signal?.addEventListener('abort',stop,{once:true});
    Promise.resolve(value).then(resolve,reject).finally(()=>signal?.removeEventListener('abort',stop));
  });
}
function pageText(raw){return raw.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,' ').replace(/<[^>]*>/gu,' ')
  .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gu,s=>({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[s]))
  .replace(/\s+/gu,' ').trim().slice(0,5000);}
/** Anonymous HTTPS only; DNS is pinned on every hop, not merely checked before a second lookup. */
export function createSupportPageReader({lookup=dnsLookup,request=httpsRequest}={}){
  return async function readPage(raw,{signal}={}){
    const original=publicSupportUrl(raw);if(!original)throw Error('support-url');let current=new URL(original);
    for(let hop=0;hop<=2;hop++){
      signal?.throwIfAborted();const addresses=await supportAbortable(lookup(current.hostname,{family:4,all:true}),signal);
      if(!addresses.length||addresses.some(a=>a.family!==4||!publicIpv4(a.address)))throw Error('support-private-address');
      const pinned=addresses[0].address;
      const response=await new Promise((resolve,reject)=>{
        const req=request(current,{family:4,signal,headers:{'user-agent':'dsh-persona-shell/0.5.3','accept':'text/html,text/plain','accept-encoding':'identity'},
          lookup:(_host,options,cb)=>options?.all?cb(null,[{address:pinned,family:4}]):cb(null,pinned,4)},resolve);
        req.on('error',reject);req.setTimeout(15000,()=>req.destroy(Error('support-page-timeout')));req.end();
      });
      if([301,302,303,307,308].includes(response.statusCode)){
        response.resume();const next=new URL(response.headers.location??'',current);
        if(hop===2||next.origin!==current.origin||!publicSupportUrl(next.href)||!response.headers.location)throw Error('support-redirect');current=next;continue;
      }
      if(response.statusCode<200||response.statusCode>=300){response.resume();throw Error('support-page-status');}
      const type=String(response.headers['content-type']??'');
      if(!/^(?:text\/html|text\/plain|application\/xhtml\+xml)(?:;|$)/iu.test(type)||response.headers['content-encoding']&&!/^identity$/iu.test(response.headers['content-encoding'])){
        response.resume();throw Error('support-page-type');
      }
      let size=0;const chunks=[];
      try{for await(const chunk of response){signal?.throwIfAborted();size+=chunk.length;if(size>262144)throw Error('support-page-size');chunks.push(chunk);}}
      catch(error){response.destroy();throw error;}
      const text=pageText(Buffer.concat(chunks).toString('utf8'));if(!text)throw Error('support-page-empty');
      return {url:current.href,text};
    }
    throw Error('support-redirect');
  };
}
