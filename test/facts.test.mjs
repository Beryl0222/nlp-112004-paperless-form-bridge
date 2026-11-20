import assert from 'node:assert/strict';
import test from 'node:test';
import { readBundle } from '../tools/materials.mjs';
import { extractFacts, reduceConditions, effectiveFacts } from '../tools/facts.mjs';

const bundle = readBundle(new URL('../data/', import.meta.url));
const formA = bundle.forms.find(row => row.id === 'form-a');
const formB = bundle.forms.find(row => row.id === 'form-b');

function factsOf(id) {
  const draft = bundle.drafts.find(row => row.id === id);
  const form = draft.form === 'form-a' ? formA : formB;
  return extractFacts(draft, { form, participants: bundle.participants });
}

test('草稿原话全部可解析，无残片', () => {
  for (const id of ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']) {
    assert.deepEqual(factsOf(id).residues, [], `${id} 有未解析残片`);
  }
});

test('自述提取案件条件与栏位回答', () => {
  const { facts } = factsOf('d1');
  assert.ok(facts.some(f => f.kind === 'condition' && f.key === 'domestic' && f.value === true));
  assert.ok(facts.some(f => f.kind === 'condition' && f.key === 'mode' && f.value === 'SELF'));
  assert.ok(facts.some(f => f.kind === 'answer' && f.field === 'domestic' && f.value === 'Y'));
  assert.ok(facts.some(f => f.kind === 'answer' && f.field === 'hub' && f.value === 'E-07'));
  assert.ok(facts.some(f => f.kind === 'condition' && f.key === 'windowEnabled' && f.value === true));
});

test('更正改变申报方式并撤回旧号码', () => {
  const { facts } = factsOf('d2');
  assert.ok(facts.some(f => f.kind === 'condition' && f.key === 'mode' && f.value === 'AGENT'));
  assert.ok(facts.some(f => f.kind === 'answer' && f.field === 'actor' && f.value === 'AGENT'));
  assert.ok(facts.some(f => f.kind === 'retract' && f.scope === 'personal-number'));
  assert.ok(facts.some(f => f.kind === 'answer' && f.field === 'ownerCode' && f.state === 'explicit-none' && f.written === false));
  const agent = facts.find(f => f.agent);
  assert.equal(agent.agent, 'a01');
});

test('代答与书面确认：事实按接件顺序后者为准', () => {
  const all = ['d1', 'd2', 'd3', 'd4'].flatMap(id => factsOf(id).facts);
  const { conditions } = reduceConditions(all);
  assert.equal(conditions.mode, 'AGENT');
  assert.equal(conditions.writtenProof, true, 'd4 的书面确认覆盖 d3 时的未出具状态');
  const d3 = factsOf('d3').facts;
  assert.ok(d3.some(f => f.kind === 'candidate' && f.value === 'AH-602' && f.role === '代办方代码'));
  const d4 = factsOf('d4').facts;
  assert.ok(d4.some(f => f.kind === 'answer' && f.field === 'ownerCode' && f.state === 'explicit-none' && f.written === true));
  assert.ok(d4.some(f => f.kind === 'restriction' && f.field === 'contact' && f.actors.includes('货主本人')));
});

test('撤回按标签移除更早的事实', () => {
  const synthetic = [
    { kind: 'answer', field: 'contact', value: '13800000000', tag: 'personal-number', source: 'x1' },
    { kind: 'answer', field: 'hub', value: 'E-07', tag: 'window', source: 'x1' },
    { kind: 'retract', scope: 'personal-number', source: 'x2' },
  ];
  const kept = effectiveFacts(synthetic);
  assert.ok(!kept.some(f => f.field === 'contact'));
  assert.ok(kept.some(f => f.field === 'hub'), '窗口安排不受号码撤回影响');
});

test('不可拆分的联合答复保持联合，不臆造拆分', () => {
  const { facts } = factsOf('d5');
  const joint = facts.find(f => f.kind === 'joint');
  assert.deepEqual(joint.fields, ['Office', 'Contact']);
  assert.equal(joint.splittable, false);
  assert.ok(facts.some(f => f.kind === 'answer' && f.field === 'Principal ID' && f.state === 'explicit-none'));
});

test('多义候选与明示未回答', () => {
  const d6 = factsOf('d6').facts;
  const candidate = d6.find(f => f.kind === 'candidate');
  assert.equal(candidate.value, 'H-61');
  assert.deepEqual(candidate.ambiguous, ['船舶号', '货主号']);
  assert.equal(candidate.medium, '订单');
  const d7 = factsOf('d7').facts;
  assert.ok(d7.some(f => f.kind === 'answer' && f.field === 'Principal ID' && f.value === 'H-33'));
  assert.ok(d7.some(f => f.kind === 'answer' && f.field === 'Office' && f.value === 'Q-02'));
  assert.ok(d7.some(f => f.kind === 'answer' && f.field === 'Contact' && f.state === 'unanswered-declared'));
});
