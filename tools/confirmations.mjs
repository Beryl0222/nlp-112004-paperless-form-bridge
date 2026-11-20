// 柜员确认记录：依据原文确认一项解释，只适用于记录下来的说明版本与条件。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export function loadConfirmations(stateDir) {
  const path = join(fileURLToPath(stateDir), 'confirmations.json');
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data)) throw new TypeError('confirmations.json 应为 JSON 数组');
  return data;
}

export function saveConfirmation(stateDir, confirmation) {
  const all = loadConfirmations(stateDir);
  const id = `cf${all.length + 1}`;
  const record = { id, at: new Date().toISOString(), ...confirmation };
  all.push(record);
  const dir = fileURLToPath(stateDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'confirmations.json'), `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  return record;
}

// 确认是否适用于当前案件：说明版本相同、所引条款仍有效、记录的条件与当前一致。
export function confirmationApplies(confirmation, { form, edition, conditions, activeClauseIds }) {
  return confirmation.form === form
    && confirmation.edition === edition
    && confirmation.clauseIds.every(id => activeClauseIds.has(id))
    && Object.entries(confirmation.conditions ?? {}).every(([key, value]) => conditions[key] === value);
}
