import assert from 'node:assert/strict';
import test from 'node:test';
import { readBundle } from '../tools/materials.mjs';
import { availableEditions, effectiveClauses, extractFieldTerms, reconcileFields } from '../tools/clauses.mjs';

const bundle = readBundle(new URL('../data/', import.meta.url));

test('版次解析：新版段落只替代同编号旧段落', () => {
  assert.deepEqual(availableEditions(bundle.instructions, 'form-a'), ['2026.1', '2026.2']);
  assert.deepEqual(availableEditions(bundle.instructions, 'form-b'), ['1.0', '1.1']);
  assert.deepEqual(effectiveClauses(bundle.instructions, 'form-a', '2026.1').map(row => row.id), ['a1', 'a2', 'a3', 'a4', 'a5']);
  assert.deepEqual(effectiveClauses(bundle.instructions, 'form-a', '2026.2').map(row => row.id), ['a1', 'a2', 'a4', 'a5', 'a6']);
  assert.deepEqual(effectiveClauses(bundle.instructions, 'form-b', '1.1').map(row => row.id), ['b1', 'b3']);
});

test('两种文本各自赋予栏位的义务、例外、补答人与触发条件都被找出', () => {
  const form = bundle.forms.find(row => row.id === 'form-a');
  const clauses = effectiveClauses(bundle.instructions, 'form-a', '2026.1');
  const { byField, residues } = extractFieldTerms(clauses, form);
  assert.deepEqual(residues, [], '条款不应有未解析残片');

  const zhExempt = byField.ownerCode.zh.find(term => term.aspect === 'requirement');
  assert.deepEqual(zhExempt.conditions, { mode: 'SELF', domestic: true });
  const enExempt = byField.ownerCode.en.find(term => term.aspect === 'requirement');
  assert.deepEqual(enExempt.conditions, { domestic: true });

  const zhBan = byField.ownerCode.zh.find(term => term.aspect === 'substitution');
  assert.equal(zhBan.ruling, 'forbidden');
  assert.equal(zhBan.via, 'a1', '脚注①的义务经 §2 引用并带上限定条件');
  assert.deepEqual(zhBan.conditions, { mode: 'AGENT' });
  const enAllow = byField.ownerCode.en.find(term => term.aspect === 'substitution');
  assert.equal(enAllow.ruling, 'allowed');

  const filler = byField.ownerCode.zh.find(term => term.aspect === 'filler');
  assert.deepEqual(filler.actors, ['代办方']);
  const writtenNone = byField.ownerCode.zh.find(term => term.aspect === 'explicit-none');
  assert.deepEqual(writtenNone.conditions, { mode: 'AGENT', writtenProof: true });

  const contactBlank = byField.contact.zh.find(term => term.aspect === 'requirement');
  assert.deepEqual(contactBlank.conditions, { windowEnabled: true });
  const hubRule = byField.hub.zh.find(term => term.aspect === 'value-rule');
  assert.deepEqual(hubRule.conditions, { windowEnabled: true });
});

test('脚注条款只经引用条件生效，不单独重复计入', () => {
  const form = bundle.forms.find(row => row.id === 'form-a');
  const clauses = effectiveClauses(bundle.instructions, 'form-a', '2026.1');
  const { byField } = extractFieldTerms(clauses, form);
  const ownerTerms = byField.ownerCode.zh;
  assert.equal(ownerTerms.filter(term => term.aspect === 'substitution').length, 1);
  assert.ok(ownerTerms.every(term => term.via === 'a1' || term.clause === 'a1'));
});

test('新版次下脚注引用指向新段落', () => {
  const form = bundle.forms.find(row => row.id === 'form-a');
  const clauses = effectiveClauses(bundle.instructions, 'form-a', '2026.2');
  const { byField } = extractFieldTerms(clauses, form);
  const fillers = byField.contact.zh.filter(term => term.aspect === 'filler');
  assert.ok(fillers.some(term => term.clause === 'a6' && term.actors.includes('代办方')));
  assert.ok(!fillers.some(term => term.clause === 'a3'));
});

test('义务冲突：有约束版本按约束版本，无约束版本暂缓', () => {
  const formA = bundle.forms.find(row => row.id === 'form-a');
  const clausesA = effectiveClauses(bundle.instructions, 'form-a', '2026.1');
  const resolvedA = reconcileFields(extractFieldTerms(clausesA, formA).byField, formA);
  assert.equal(resolvedA.fields.ownerCode.groups.disposition.status, 'authority-resolved');
  assert.equal(resolvedA.fields.ownerCode.groups.substitution.status, 'authority-resolved');
  assert.ok(resolvedA.conflicts.every(conflict => conflict.resolution !== null));
  assert.equal(resolvedA.holds.length, 0);

  const formB = bundle.forms.find(row => row.id === 'form-b');
  const clausesB = effectiveClauses(bundle.instructions, 'form-b', '1.0');
  const resolvedB = reconcileFields(extractFieldTerms(clausesB, formB).byField, formB);
  assert.equal(resolvedB.fields['Principal ID'].groups.blankMeaning.status, 'held');
  assert.equal(resolvedB.holds.length, 1);

  const clausesB11 = effectiveClauses(bundle.instructions, 'form-b', '1.1');
  const resolvedB11 = reconcileFields(extractFieldTerms(clausesB11, formB).byField, formB);
  assert.equal(resolvedB11.fields['Principal ID'].groups.blankMeaning.status, 'agreed');
  assert.equal(resolvedB11.holds.length, 0);
});

test('柜员确认可以了结无约束版本的冲突', () => {
  const formB = bundle.forms.find(row => row.id === 'form-b');
  const clauses = effectiveClauses(bundle.instructions, 'form-b', '1.0');
  const active = new Set(clauses.map(row => row.id));
  const confirmation = {
    id: 'cf1', form: 'form-b', field: 'Principal ID', group: 'blankMeaning', clauseIds: ['b1'], conditions: {},
  };
  const resolved = reconcileFields(extractFieldTerms(clauses, formB).byField, formB, {
    confirmations: [confirmation], activeClauseIds: active,
  });
  assert.equal(resolved.fields['Principal ID'].groups.blankMeaning.status, 'confirmed');
  assert.equal(resolved.holds.length, 0);

  const stale = reconcileFields(extractFieldTerms(clauses, formB).byField, formB, {
    confirmations: [{ ...confirmation, conditions: { mode: 'SELF' } }],
    conditions: { mode: 'AGENT' },
    activeClauseIds: active,
  });
  assert.equal(stale.fields['Principal ID'].groups.blankMeaning.status, 'held', '条件已变的确认不适用');
});
