import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatPalette} from '../lib/chat-palette.js';
const palette=createChatPalette(),diff=(a,b)=>Math.min(Math.abs(a-b),360-Math.abs(a-b));
const pixels=(color,n)=>Array.from({length:n},()=>color).flat();

test('avatar sampling finds the dominant colored region without white, transparent or skin pixels taking over',()=>{
  const input=Uint8ClampedArray.from([...pixels([255,255,255,255],600),...pixels([247,207,187,255],180),...pixels([70,110,192,255],220),...pixels([255,0,0,0],20)]);
  const color=palette.dominant(input);assert.ok(color.h>210&&color.h<230);assert.ok(color.s>=30&&color.s<=68);
  assert.equal(palette.dominant(Uint8ClampedArray.from(pixels([240,240,240,255],1024))),null);
  for(const invalid of [null,[],[1,2,3],new Uint8Array(128*128*4+4)])assert.equal(palette.dominant(invalid),null);
});

test('similar avatar hues get small distinct stable room colors independent of list order',()=>{
  const people=[{id:'大肥鱼（默认）',color:{h:222,s:54}},{id:'鲸鲸（实验性）',color:{h:222,s:54}},
    {id:'Claude小姐',color:{h:25,s:62}},{id:'Gemini',color:{h:270,s:50}}];
  const first=palette.allocate(people),second=palette.allocate(people.toReversed());
  assert.deepEqual([...first],[...second]);assert.ok(diff(first.get(people[0].id).h,first.get(people[1].id).h)>=8);
  assert.ok(people.every(person=>diff(first.get(person.id).h,person.color.h)<=24),'related hues retain their family');
  assert.ok(diff(first.get('Claude小姐').h,25)<10);
});

test('eight matching custom portraits are bounded and distinguishable; missing or broken avatars have deterministic fallbacks',()=>{
  const people=Array.from({length:8},(_,index)=>({id:'actor-'+index,color:{h:220,s:55}}));
  const values=[...palette.allocate(people).values()];for(let i=0;i<values.length;i++)for(let j=i+1;j<values.length;j++)assert.ok(diff(values[i].h,values[j].h)>=8);
  const inputs=[{id:'__proto__'},{id:'custom'},{id:'custom'},{id:'bad',color:{h:NaN,s:Infinity}}];
  assert.deepEqual([...palette.allocate(inputs)],[...palette.allocate(inputs)]);
  for(const tone of palette.allocate(inputs).values())assert.match(palette.style(tone)['--chat-persona-color'],/^hsl\(\d+ \d+% 48%\)$/);
  assert.equal(palette.style(null),undefined);
});
