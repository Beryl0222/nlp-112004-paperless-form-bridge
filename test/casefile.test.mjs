import assert from 'node:assert/strict';
import test from 'node:test';
import { readBundle } from '../tools/materials.mjs';
import { buildCase } from '../tools/casefile.mjs';

const bundle = readBundle(new URL('../data/', import.meta.url));
const draftsOf = caseId => bundle.drafts.filter(row => row.caseId === caseId);
const field = (caseFile, name) => caseFile.fields.find(f => f.name === name);

test('C01：更正后代理申报，货主代码凭书面确认填“无”', () => {
  const caseFile = buildCase({ bundle, caseId: 'C01', edition: '2026.1' });
  assert.deepEqual(caseFile.conditions, { domestic: true, mode: 'AGENT', windowEnabled: true, writtenProof: true });
  assert.equal(field(caseFile, 'actor').recipient.value, 'AGENT');
  const ownerCode = field(caseFile, 'ownerCode');
  assert.equal(ownerCode.status, 'explicit-none');
  assert.equal(ownerCode.recipient.value, 'NONE');
  assert.ok(ownerCode.trace.drafts.includes('d4'));
  assert.ok(ownerCode.trace.clauses.includes('a2'));
  assert.ok(ownerCode.notes.some(note => note.includes('AH-602') && note.includes('不得代用')));
  assert.equal(field(caseFile, 'hub').recipient.value, 'E-07');
  assert.equal(field(caseFile, 'domestic').recipient.value, 'Y');
  const contact = field(caseFile, 'contact');
  assert.equal(contact.status, 'exempt');
  assert.equal(contact.recipient.kind, 'omit');
  assert.ok(contact.notes.some(note => note.includes('仅本人可填')));
  assert.equal(caseFile.blocked, false);
});

test('确认只适用于记录下来的条件：客户改口后旧确认不再让旧填法有效', () => {
  const onlyD1 = draftsOf('C01').filter(row => row.id === 'd1');
  const before = buildCase({ bundle, caseId: 'C01', edition: '2026.1', drafts: onlyD1 });
  assert.equal(before.conditions.mode, 'SELF');
  assert.equal(field(before, 'ownerCode').status, 'exempt', '自行申报且国内货物时可不填货主代码');

  const confirmation = {
    id: 'cf-self', form: 'form-a', edition: '2026.1', field: 'ownerCode', group: 'disposition',
    clauseIds: ['a1'], conditions: before.conditions,
  };
  const confirmedBefore = buildCase({ bundle, caseId: 'C01', edition: '2026.1', drafts: onlyD1, confirmations: [confirmation] });
  assert.ok(confirmedBefore.confirmationStates.find(state => state.id === 'cf-self').applies);

  const after = buildCase({ bundle, caseId: 'C01', edition: '2026.1', confirmations: [confirmation] });
  const state = after.confirmationStates.find(item => item.id === 'cf-self');
  assert.equal(state.applies, false, '客户改口为代理申报后，原确认不适用');
  assert.match(state.reason, /条件已变/);
  assert.equal(field(after, 'ownerCode').status, 'explicit-none', '旧填法（省略）不再有效，按代理申报填“无”');
  assert.equal(field(after, 'domestic').recipient.value, 'Y', '未受影响的回答继续有效');
});

test('C02：无约束版本的冲突暂缓，追问说清由谁补什么', () => {
  const caseFile = buildCase({ bundle, caseId: 'C02', edition: '1.0' });
  assert.equal(field(caseFile, 'Principal ID').status, 'held');
  assert.equal(field(caseFile, 'Domestic').status, 'unanswered');
  assert.ok(field(caseFile, 'Domestic').required);
  const joint = field(caseFile, 'Office');
  assert.ok(joint.notes.some(note => note.includes('不可拆分')));
  assert.equal(caseFile.blocked, true);
  const who = caseFile.followUps.map(followUp => `${followUp.who}：${followUp.what}`);
  assert.ok(who.some(text => text.includes('柜员') && text.includes('Principal ID')));
  assert.ok(who.some(text => text.includes('芦舟货主') && text.includes('Domestic')));
  assert.ok(who.some(text => text.includes('芦舟货主') && text.includes('Office、Contact')));
});

test('C02：柜员依据原文确认后，明确没有与未回答之分在空串中丢失并说明', () => {
  const onlyD5 = draftsOf('C02').filter(row => row.id === 'd5');
  const confirmation = {
    id: 'cf-b1', form: 'form-b', edition: '1.0', field: 'Principal ID', group: 'blankMeaning',
    clauseIds: ['b1'], conditions: {},
  };
  const caseFile = buildCase({ bundle, caseId: 'C02', edition: '1.0', drafts: onlyD5, confirmations: [confirmation] });
  const principal = field(caseFile, 'Principal ID');
  assert.equal(principal.status, 'explicit-none');
  assert.deepEqual(principal.recipient, { kind: 'empty' });
  const collision = caseFile.collisions.find(item => item.field === 'Principal ID');
  assert.ok(collision, '明确没有与未回答在收件格式中同为空串，须说明丢失');
  assert.match(collision.lost, /明确没有/);
  assert.equal(collision.party, '芦舟货主');
});

test('C02 版次 1.1：两种文本已一致，无需确认；多义候选暂缓', () => {
  const caseFile = buildCase({ bundle, caseId: 'C02', edition: '1.1' });
  const principal = field(caseFile, 'Principal ID');
  assert.equal(principal.status, 'ambiguous');
  assert.ok(principal.notes.some(note => note.includes('H-61')));
  assert.ok(principal.notes.some(note => note.includes('未登记声明保留在提交记录')));
  assert.equal(caseFile.holds.length, 0);
  assert.equal(caseFile.blocked, true, '多义未清，转送暂缓');
});

test('C03：实值栏位不受空值含义冲突影响；必填未答仍暂缓', () => {
  const caseFile = buildCase({ bundle, caseId: 'C03', edition: '1.0' });
  const principal = field(caseFile, 'Principal ID');
  assert.equal(principal.status, 'answered');
  assert.equal(principal.recipient.value, 'H-33');
  assert.ok(principal.notes.some(note => note.includes('不受影响')));
  assert.equal(field(caseFile, 'Office').recipient.value, 'Q-02');
  assert.equal(field(caseFile, 'Contact').status, 'unanswered');
  assert.equal(caseFile.blocked, true, 'Domestic 必填未答');
});

test('无权填写：代办方不得代填仅限本人的联络栏', () => {
  const extra = {
    id: 'x1', caseId: 'C01', form: 'form-a', actor: 'a01', about: 'd4', kind: '代答',
    text: '货主的新私人联系电话是 13900001111。',
  };
  const caseFile = buildCase({ bundle, caseId: 'C01', edition: '2026.1', drafts: [...draftsOf('C01'), extra] });
  const contact = field(caseFile, 'contact');
  assert.equal(contact.status, 'unauthorized');
  assert.ok(contact.notes.some(note => note.includes('无权填写')));
  assert.equal(caseFile.blocked, true);
});

test('获准补答：货主本人可填联络栏', () => {
  const extra = {
    id: 'x2', caseId: 'C01', form: 'form-a', actor: 'h1', about: 'd4', kind: '自述',
    text: '新的私人联系电话是 13900001111。',
  };
  const caseFile = buildCase({ bundle, caseId: 'C01', edition: '2026.1', drafts: [...draftsOf('C01'), extra] });
  const contact = field(caseFile, 'contact');
  assert.equal(contact.status, 'answered');
  assert.equal(contact.recipient.value, '13900001111');
});
