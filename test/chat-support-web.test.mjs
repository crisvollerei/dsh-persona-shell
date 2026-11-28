import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {gzipSync,deflateSync} from 'node:zlib';
import {createSupportPageReader,publicIpv4} from '../lib/chat-support-web.js';
function transport(responses,seen){return(url,options,cb)=>{
 seen.push({url:url.href,options});const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=error=>req.emit('error',error);req.end=()=>queueMicrotask(()=>{
  const config=responses.shift(),body=Readable.from([Buffer.from(config.body??'<h1>Official</h1><script>ignored</script><p>真实正文 &amp; 条件。</p>')]);
  body.statusCode=config.status??200;body.headers=config.headers??{'content-type':'text/html'};cb(body);
 });return req;
};}
test('private/reserved IPv4 DNS answers are rejected before any connection',async()=>{
 for(const address of ['0.0.0.0','10.2.3.4','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','198.18.0.1','224.0.0.1','203.0.113.1']){
  assert.equal(publicIpv4(address),false);let connections=0;
  await assert.rejects(createSupportPageReader({lookup:async()=>[{address,family:4}],request:()=>{connections++;}})('https://example.com'),/private-address/);assert.equal(connections,0);
 }
});

test('an unresolved DNS read shares the page deadline and rejected responses are destroyed immediately',async()=>{
 const reader=createSupportPageReader({timeoutMs:10,lookup:()=>new Promise(()=>{}),request:()=>assert.fail('no connection')});
 await assert.rejects(reader('https://example.com'),/support-page-timeout/);
 for(const [statusCode,headers] of [[503,{}],[200,{'content-type':'application/octet-stream'}],[301,{location:'https://elsewhere.example/'}]]){
   const body=new Readable({read(){assert.fail('rejected body must not be drained');}});Object.assign(body,{statusCode,headers});
   const read=createSupportPageReader({lookup:async()=>[{address:'93.184.216.34',family:4}],request(_url,_options,deliver){
     const req=new EventEmitter();req.end=()=>queueMicrotask(()=>deliver(body));return req;
   }});
   await assert.rejects(read('https://example.com'),/support-(?:page-|redirect)/);assert.equal(body.destroyed,true);
 }
});
test('actual HTTPS connections use the validated DNS address, anonymous headers and bounded decoded text',async()=>{
 const seen=[],reader=createSupportPageReader({lookup:async()=>[{address:'93.184.216.34',family:4}],request:transport([{}],seen)});
 const result=await reader('https://example.com/page');assert.equal(result.url,'https://example.com/page');assert.equal(result.text,'Official 真实正文 & 条件。');
 seen[0].options.lookup('ignored.example',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'93.184.216.34');assert.equal(family,4);});
 assert.equal(seen[0].options.headers.cookie,undefined);assert.equal(seen[0].options.headers.authorization,undefined);
});
test('page reader handles unknown charset labels and honors recognized non-UTF-8 encodings',async()=>{
 const lookup=async()=>[{address:'93.184.216.34',family:4}];
 for(const [charset,body,expected] of [['utf8mb4',Buffer.from('网页正文'),'网页正文'],['windows-1252',Buffer.from([0x63,0x61,0x66,0xe9]),'café']]) {
   const reader=createSupportPageReader({lookup,request:transport([{headers:{'content-type':'text/plain;charset='+charset},body}],[])});
   assert.equal((await reader('https://example.com')).text,expected);
 }
});
test('cross-origin redirects are not followed, and a same-origin DNS rebind is blocked before the second connection',async()=>{
 let seen=[];const redirect={status:302,headers:{location:'https://elsewhere.com/secret'}};
 await assert.rejects(createSupportPageReader({lookup:async()=>[{address:'93.184.216.34',family:4}],request:transport([redirect],seen)})('https://example.com'),/redirect/);assert.equal(seen.length,1);
 seen=[];let lookups=0;
 await assert.rejects(createSupportPageReader({lookup:async()=>[{address:++lookups===1?'93.184.216.34':'127.0.0.1',family:4}],
  request:transport([{status:302,headers:{location:'/next'}}],seen)})('https://example.com'),/private-address/);assert.equal(seen.length,1);
});
test('non-text, oversized bodies and cancellation cannot become page evidence',async()=>{
 for(const response of [{headers:{'content-type':'application/octet-stream'}},{body:'a'.repeat(262145)}]){
  await assert.rejects(createSupportPageReader({lookup:async()=>[{address:'93.184.216.34',family:4}],request:transport([response],[])})('https://example.com'),/page-(?:type|size)/);
 }
 const abort=new AbortController(),reader=createSupportPageReader({lookup:async()=>{abort.abort(Error('stopped'));return[{address:'93.184.216.34',family:4}];},request:()=>assert.fail('no post-cancel connection')});
 await assert.rejects(reader('https://example.com',{signal:abort.signal}),/stopped/);
});
test('compressed main content and the www variant retain DNS checks and bounded decompression',async()=>{
 const lookup=async()=>[{address:'93.184.216.34',family:4}];
 for(const [encoding,compress] of [['gzip',gzipSync],['deflate',deflateSync]]){
  const seen=[],headers={'content-type':'text/html;charset=UTF-8','content-encoding':encoding};
  const body=compress('<nav>'+('导航 '.repeat(2000))+'</nav><main><p>真正的正文。</p></main>');
  const reader=createSupportPageReader({lookup,request:transport([{status:301,headers:{location:'https://www.example.com/info'}},{headers,body}],seen)});
  assert.deepEqual(await reader('https://example.com'),{url:'https://www.example.com/info',text:'真正的正文。'});
  assert.equal(seen.length,2);
  const oversized=createSupportPageReader({lookup,request:transport([{headers,body:compress('x'.repeat(1048577))}],[])});
  await assert.rejects(oversized('https://example.com'),/page-size/);
 }
});
