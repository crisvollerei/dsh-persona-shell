import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFloatingLayout} from '../lib/floating-layout.js';
const layout=createFloatingLayout(),view={left:8,top:52,width:984,height:740},rect={left:300,top:180,width:430,height:500};
test('window bounds keep every edge visible without mutating the desired restore position',()=>{
 const wanted={...rect},small={left:8,top:52,width:264,height:320};
 assert.deepEqual(layout.fit(wanted,small,{minWidth:280,minHeight:360}),{left:8,top:52,width:264,height:320});
 assert.deepEqual(wanted,rect);assert.deepEqual(layout.fit(wanted,view),rect);
 assert.deepEqual(layout.move(rect,-10000,10000,view),{left:8,top:292,width:430,height:500});
});
test('resizing keeps the opposite edges anchored, with local minimums and viewport bounds',()=>{
 assert.deepEqual(layout.resize(rect,'nw',40,30,view),{left:340,top:210,width:390,height:470});
 assert.deepEqual(layout.resize(rect,'nw',10000,10000,view),{left:450,top:440,width:280,height:240});
 assert.deepEqual(layout.resize(rect,'se',10000,10000,view),{left:300,top:180,width:692,height:612});
 for(const edge of ['n','ne','e','se','s','sw','w','nw']){
   const next=layout.resize(rect,edge,-10000,-10000,view);
   assert.ok(next.left>=view.left&&next.top>=view.top&&next.left+next.width<=view.left+view.width&&next.top+next.height<=view.top+view.height);
 }
});
test('malformed local geometry cannot create nonfinite or offscreen controls',()=>{
 const next=layout.fit({left:Infinity,top:NaN,width:-4,height:Infinity},view);
 assert.deepEqual(next,{left:8,top:52,width:280,height:240});
 assert.deepEqual(layout.resize(rect,'unknown',0,0,view),rect);
});
test('browser geometry is the same dependency-free implementation',()=>{
 const source=readFileSync(new URL('../client.js',import.meta.url),'utf8');
 assert.ok(source.includes(createFloatingLayout.toString()));
});
