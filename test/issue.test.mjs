import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBundle } from '../tools/materials.mjs';
import { issueCase } from '../tools/issue.mjs';
import { verifyReceipt } from '../tools/preview.mjs';
import { correctionsOf, findReceipt, loadReceipts } from '../tools/store.mjs';
import { loadConfirmations, saveConfirmation } from '../tools/confirmations.mjs';

const SOURCE = new URL('../data/', import.meta.url);

function tempData(t) {
  const dir = mkdtempSync(join(tmpdir(), 'paperless-issue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(SOURCE.pathname), dir, { recursive: true });
  return pathToFileURL(dir + sep);
}

test('签发留档：预览与申报件对应，原件保持原样', t => {
  const dir = tempData(t);
  const bundle = readBundle(dir);
  const before = loadReceipts(dir).find(row => row.id === 'r1');
  // C01 已有交接 r1（自行申报时的旧填法），客户改口后只能以更正件重办。
  assert.throws(() => issueCase({ bundle, dataDir: dir, caseId: 'C01', edition: '2026.1' }), /重办须指明原件号/);
  const { receipt } = issueCase({ bundle, dataDir: dir, caseId: 'C01', edition: '2026.1', corrects: 'r1' });
  assert.equal(receipt.id, 'r3');
  assert.equal(receipt.form, 'form-a');
  assert.match(receipt.viewText, /^更正 r1。/);
  assert.deepEqual(receipt.drafts, ['d1', 'd2', 'd3', 'd4']);
  assert.equal(JSON.parse(receipt.payloadText).ownerCode, 'NONE');
  const form = bundle.forms.find(row => row.id === 'form-a');
  assert.deepEqual(verifyReceipt(receipt, form), { ok: true });
  assert.deepEqual(findReceipt(dir, 'r1'), before, '交接后的原件保留可回查且不被改动');
  readBundle(dir);
});

test('交接后只允许以关联原件的更正件重办', t => {
  const dir = tempData(t);
  const bundle = readBundle(dir);
  issueCase({ bundle, dataDir: dir, caseId: 'C01', edition: '2026.1', corrects: 'r1' });
  assert.throws(() => issueCase({ bundle, dataDir: dir, caseId: 'C01', edition: '2026.1' }), /重办须指明原件号/);
  assert.throws(() => issueCase({ bundle, dataDir: dir, caseId: 'C01', edition: '2026.1', corrects: 'r2' }), /不能更正到 C01/);
  assert.throws(() => issueCase({ bundle, dataDir: dir, caseId: 'C01', edition: '2026.1', corrects: 'r99' }), /找不到原件/);
  const { receipt } = issueCase({ bundle, dataDir: dir, caseId: 'C01', edition: '2026.1', corrects: 'r3' });
  assert.match(receipt.viewText, /^更正 r3。/);
  assert.deepEqual(correctionsOf(dir, 'r3').map(row => row.id), [receipt.id]);
});

test('暂缓案件不签发，草稿保留供继续办理', t => {
  const dir = tempData(t);
  const bundle = readBundle(dir);
  assert.throws(() => issueCase({ bundle, dataDir: dir, caseId: 'C02', edition: '1.0' }), /暂缓栏位/);
  assert.equal(loadReceipts(dir).filter(row => row.caseId === 'C02').length, 0, '未生成申报件');
  assert.ok(readBundle(dir).drafts.some(row => row.caseId === 'C02'), '草稿仍在');
});

test('确认记录可保存并只在记录的条件与版本下适用', t => {
  const dir = tempData(t);
  const bundle = readBundle(dir);
  const stateDir = new URL(`file:${join(dir.pathname, 'state')}/`);
  const saved = saveConfirmation(stateDir, {
    caseId: 'C02', form: 'form-b', edition: '1.0', field: 'Principal ID', group: 'blankMeaning',
    clauseIds: ['b1'], conditions: {}, note: '按中文第3节', by: '柜员',
  });
  assert.equal(saved.id, 'cf1');
  const loaded = loadConfirmations(stateDir);
  assert.equal(loaded.length, 1);
  // 确认了结解释冲突，但不代替未答的栏位：C02 仍因 Domestic 未答与 H-61 多义而暂缓。
  let error = null;
  try {
    issueCase({ bundle, dataDir: dir, caseId: 'C02', edition: '1.0', confirmations: loaded });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, '暂缓案件不应签发');
  assert.match(error.message, /暂缓栏位/);
  const principal = error.caseFile.fields.find(field => field.name === 'Principal ID');
  assert.notEqual(principal.status, 'held', '解释冲突已按确认了结');
  assert.equal(principal.status, 'ambiguous', '多义候选仍需货主澄清');
  assert.equal(loadReceipts(dir).filter(row => row.caseId === 'C02').length, 0);
});
