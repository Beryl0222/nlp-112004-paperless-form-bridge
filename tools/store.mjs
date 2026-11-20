// 留档：申报件只增不改。交接后的原件保留可回查，
// 之后只允许以关联原件的更正件重办（更正件在预览首行注明原件号）。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readBundle } from './materials.mjs';

function receiptsPath(dataDir) {
  return join(fileURLToPath(dataDir), 'receipts.json');
}

export function loadReceipts(dataDir) {
  return JSON.parse(readFileSync(receiptsPath(dataDir), 'utf8'));
}

export function findReceipt(dataDir, id) {
  return loadReceipts(dataDir).find(row => row.id === id) ?? null;
}

export function receiptsForCase(dataDir, caseId) {
  return loadReceipts(dataDir).filter(row => row.caseId === caseId);
}

// 追加申报件并整包复检（列类型、编号、组间引用），保证留档始终可读。
export function appendReceipt(dataDir, receipt) {
  const all = loadReceipts(dataDir);
  if (all.some(row => row.id === receipt.id)) throw new Error(`申报件编号 ${receipt.id} 已存在`);
  all.push(receipt);
  writeFileSync(receiptsPath(dataDir), `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  readBundle(dataDir);
  return receipt;
}

export function nextReceiptId(dataDir) {
  const max = loadReceipts(dataDir)
    .map(row => /^r(\d+)$/.exec(row.id))
    .filter(Boolean)
    .reduce((acc, m) => Math.max(acc, Number(m[1])), 0);
  return `r${max + 1}`;
}

// 更正件在预览首行以「更正 <原件号>。」标明所更正的交接。
export function correctionsOf(dataDir, receiptId) {
  return loadReceipts(dataDir).filter(row => row.viewText.startsWith(`更正 ${receiptId}。`));
}

export function correctsOf(receipt) {
  const match = receipt.viewText.match(/^更正 (\S+?)。/);
  return match ? match[1] : null;
}
