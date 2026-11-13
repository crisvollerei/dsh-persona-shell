import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function load(base='https://dsh.invalid/prefix/'){
 let definition;
 const sandbox={window:{__ModuleLoader__:{load:d=>definition=d}},document:{baseURI:base},URL,console};
 vm.runInNewContext(readFileSync(new URL('../client.js',import.meta.url),'utf8'),sandbox);
 const react={createElement:(type,props,...children)=>({type,props,children}),useEffect(){}};
 return definition.factory(id=>id==='react'?react:undefined).__testing;
}
test('report file URLs retain the native transport, deployment prefix and decoded path',()=>{
 const api=load();
 for(const base of ['https://dsh.invalid/prefix/','http://localhost:3000/','dsh-app://app/']){
  const url=new URL(api.reportFileMediaUrl(base,'D:\\工作\\chart one.png'));
  assert.equal(url.searchParams.get('path'),'D:\\工作\\chart one.png');
  assert.equal(url.pathname,new URL(base).pathname+'api/file');
 }
 for(const value of ['relative.png','\\\\server\\secret.png','//server/a.png','D:/bad\npath.png','javascript:alert(1)'])assert.equal(api.reportFileMediaUrl('https://dsh.invalid/',value),undefined);
 assert.equal(api.reportFileMediaUrl('file:///C:/app/','D:/a.png'),undefined);
});
test('report resources capture their originating cwd and use the native legacy fallback',()=>{
 const api=load(),owner={cwd:'D:\\workspace\\'},media=api.reportMarkdownMedia(owner);owner.cwd='E:/elsewhere';
 assert.equal(new URL(media.fileImages.resolve('./images/chart.png')).searchParams.get('path'),'D:\\workspace\\./images/chart.png');
 assert.equal(new URL(media.fileImages.resolve('/tmp/a.png')).searchParams.get('path'),'/tmp/a.png');
 assert.equal(new URL(media.pathImages.resolve('D:/chart%20one.png?v=1#old')).searchParams.get('path'),'D:/chart one.png');
 assert.equal(media.pathImages.resolve('D:/bad%XX.png'),undefined);
 assert.equal(api.reportMarkdownMedia().fileImages.resolve('./image.png'),undefined);
});
test('only standalone reference definitions enter the split-document vocabulary',()=>{
 const api=load(),source={blocks:[{kind:'text',text:'[plot]: D:/chart.png'},{kind:'text',text:'[other]: /tmp/b.png\n  "标题"'},{kind:'code',text:'[code]: /tmp/code.png'},{kind:'text',text:'[mixed]: /tmp/mixed.png\n正文不能被追加。'},{kind:'text',text:'    [indented-code]: /tmp/ignored.png'}]};
 const media=api.reportMarkdownMedia(undefined,source);
 assert.equal(media.definitions,'[plot]: D:/chart.png\n[other]: /tmp/b.png\n  "标题"');
});
