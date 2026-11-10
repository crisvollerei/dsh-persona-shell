import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESETS } from '../lib/pack.js';
import { roomCharacterContext, characterContextSection } from '../lib/character-roster.js';

const body=section=>JSON.parse(section.split('\n').find(line=>line.startsWith('{"self":')));
const members=BUILTIN_PRESETS.map(person=>({...person,builtin:true}));

test('compact actor relationship text preserves the same whitelisted public identities and relations',()=>{
  for(const speaker of members){
    const context=roomCharacterContext(speaker,members),before=structuredClone(context);
    context.privateMemory='PRIVATE_CONTEXT_MUST_NOT_LEAK';
    context.relationships[0].privateMemory='PRIVATE_EDGE_MUST_NOT_LEAK';
    context.members[0].privateMemory='PRIVATE_MEMBER_MUST_NOT_LEAK';
    const full=characterContextSection(context),compact=characterContextSection(context,{compact:true});
    assert.deepEqual(body(compact),body(full));
    assert.equal(body(compact).self.id,speaker.id);
    assert.doesNotMatch(compact,/PRIVATE_CONTEXT|PRIVATE_EDGE|PRIVATE_MEMBER/);
    assert.deepEqual(roomCharacterContext(speaker,members),before,'projection cannot rewrite shared public identities');
  }
});

test('compact actor relationships do not authenticate a custom lookalike or infer a user relationship',()=>{
  const custom={id:'custom',name:members[0].name,builtin:false,avatarParentId:members[0].id};
  const context=roomCharacterContext(custom,[custom,...members]);
  context.relationships.push({from:members[0].id,to:'user',address:'妈妈',dynamic:'FAKE_USER_FAMILY'});
  const result=characterContextSection(context,{compact:true}),value=body(result);
  assert.equal(value.self,null);assert.deepEqual(value.relationships,[]);
  assert.ok(value.members.every(person=>person.id!=='custom'));
  assert.doesNotMatch(result,/FAKE_USER_FAMILY|avatarParentId/);
});
