import assert from 'node:assert/strict';
import test from 'node:test';
import { readBundle } from '../tools/materials.mjs';
import { buildCase } from '../tools/casefile.mjs';
import { buildPayload, renderView, verifyReceipt, displaysFromPayload, parseCsvLine } from '../tools/preview.mjs';

const bundle = readBundle(new URL('../data/', import.meta.url));
const formA = bundle.forms.find(row => row.id === 'form-a');
const formB = bundle.forms.find(row => row.id === 'form-b');

test('JSON 申报件：OMIT 的键完全不存在，且不以 null 代替', () => {
  const caseFile = buildCase({ bundle, caseId: 'C01', edition: '2026.1' });
  const payload = JSON.parse(buildPayload(caseFile));
  assert.deepEqual(Object.keys(payload), ['actor', 'ownerCode', 'hub', 'domestic']);
  assert.equal(payload.actor, 'AGENT');
  assert.equal(payload.ownerCode, 'NONE');
  assert.ok(!Object.hasOwn(payload, 'contact'));
  assert.ok(!Object.hasOwn(payload, 'line'));
  assert.ok(Object.values(payload).every(value => value !== null));
});

test('CSV 申报件：按列次输出，空串与转义遵守约定', () => {
  const fake = {
    form: formB,
    fields: [
      { name: 'Contact', recipient: { kind: 'empty' } },
      { name: 'Domestic', recipient: { kind: 'value', value: 'Y' } },
      { name: 'Principal ID', recipient: { kind: 'value', value: 'H,3"3' } },
      { name: 'Office', recipient: { kind: 'empty' } },
    ],
  };
  assert.equal(buildPayload(fake), ',Y,"H,3""3",');
  assert.deepEqual(parseCsvLine(',Y,"H,3""3",'), ['', 'Y', 'H,3"3', '']);
});

test('预览可从值回到原回答或书面说明', () => {
  const caseFile = buildCase({ bundle, caseId: 'C01', edition: '2026.1' });
  const view = renderView(caseFile);
  assert.match(view, /ownerCode=NONE｜明确没有｜来源 d2、d3、d4｜依据 a2/);
  assert.match(view, /contact=∅省略｜按条件无需填写/);
  assert.match(view, /注意：contact 的「按条件无需填写」/);
});

test('签发的预览与实际申报件对应；篡改预览即不符', () => {
  const caseFile = buildCase({ bundle, caseId: 'C01', edition: '2026.1' });
  const receipt = {
    id: 'r9', caseId: 'C01', form: 'form-a', edition: '2026.1',
    sentAt: '2026-11-20T00:00:00.000Z', drafts: ['d1', 'd2', 'd3', 'd4'],
    payloadText: buildPayload(caseFile),
    viewText: renderView(caseFile),
  };
  assert.deepEqual(verifyReceipt(receipt, formA), { ok: true });
  const tampered = { ...receipt, viewText: receipt.viewText.replace('ownerCode=NONE', 'ownerCode=∅省略') };
  const check = verifyReceipt(tampered, formA);
  assert.equal(check.ok, false);
  assert.match(check.reason, /ownerCode/);
});

test('早期留档不是本工具格式时如实报告', () => {
  const r1 = bundle.receipts.find(row => row.id === 'r1');
  const check = verifyReceipt(r1, formA);
  assert.equal(check.ok, false);
  assert.match(check.reason, /早期留档/);
});

test('申报件本身不合约定（null 代缺失键、列数不符）即拒绝', () => {
  assert.throws(() => displaysFromPayload('{"actor":null}', formA), /null/);
  assert.throws(() => displaysFromPayload(',Y,H-33', formB), /列数/);
  const cells = displaysFromPayload(',Y,H-33,Q-02', formB);
  assert.equal(cells.get('Contact'), "''空串");
  assert.equal(cells.get('Principal ID'), 'H-33');
});
