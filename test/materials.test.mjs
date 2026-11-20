import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBundle, readCollection } from '../tools/materials.mjs';

test('接件资料包含原文和原始记录', () => {
  const bundle = readBundle();
  const excerpts = [["instructions", "a2", "未获代码"], ["instructions", "b2", "not from a shipping label"], ["drafts", "d2", "请溪浦代办"], ["receipts", "r1", "SELF"]];
  for (const [group, id, phrase] of excerpts) {
    const entry = bundle[group].find(row => row.id === id);
    assert.ok(entry, `${group}/${id} 缺少来件`);
    if (phrase) assert.ok(Object.values(entry).some(value => typeof value === 'string' && value.includes(phrase)), `${group}/${id} 的源文字缺少约定片段`);
  }
});

test('拒绝缺少正式字段的接件', t => {
  const directory = mkdtempSync(join(tmpdir(), 'paperless-form-bridge-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'forms.json'), JSON.stringify([{ id: 'bad' }]));
  assert.throws(() => readCollection('forms', pathToFileURL(directory + sep)), TypeError);
});

test('收件表的目标列与已交接对象保持原样', () => {
  const { forms, drafts, receipts } = readBundle();
  const union = new Set(forms[1].fields.map(field => field.name));
  assert.equal(union.size, forms[1].fields.length);
  assert.equal(forms[1].fields[0].name, 'Contact');
  const accepted = JSON.parse(receipts[0].payloadText);
  assert.equal(accepted.actor, 'SELF');
  assert.ok(receipts[0].drafts.every(id => drafts.some(row => row.id === id && row.caseId === receipts[0].caseId)));
});
