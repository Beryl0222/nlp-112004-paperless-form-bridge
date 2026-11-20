// 柜员用填写与转送工具。
// 用法：node tools/cli.mjs <命令> [参数]
//   terms    <表单> --edition <版次>                     查看两种文本各自赋予栏位的义务与例外
//   case     <案件> --edition <版次>                     查看案件条件、栏位状态、追问与暂缓
//   confirm  <案件> --edition <版次> --field <栏位> --group <组> --clauses <条款,逗号分隔> [--note <说明>]
//   preview  <案件> --edition <版次>                     以收件方实际读法预览草稿
//   issue    <案件> --edition <版次> [--corrects <原件号>]  签发申报件并留档
//   receipts [--case <案件>]                             回查已交接的申报件
//   verify   <申报件号>                                  核对预览与申报件是否对应

import { parseArgs } from 'node:util';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBundle } from './materials.mjs';
import { availableEditions, effectiveClauses, extractFieldTerms, reconcileFields } from './clauses.mjs';
import { buildCase, STATE_MEANING } from './casefile.mjs';
import { buildPayload, renderView, verifyReceipt } from './preview.mjs';
import { loadConfirmations, saveConfirmation } from './confirmations.mjs';
import { issueCase } from './issue.mjs';
import { correctionsOf, correctsOf, findReceipt, receiptsForCase, loadReceipts } from './store.mjs';

// 默认使用随包资料与本地状态目录；可用 PFB_DATA / PFB_STATE 指向其他目录（如演练副本）。
function asDir(value, fallback) {
  if (!value) return fallback;
  const path = resolve(value);
  return pathToFileURL(path.endsWith(sep) ? path : path + sep);
}
const DATA_DIR = asDir(process.env.PFB_DATA, new URL('../data/', import.meta.url));
const STATE_DIR = asDir(process.env.PFB_STATE, new URL('../state/', import.meta.url));

const GROUP_NAMES = {
  disposition: '义务/例外',
  blankMeaning: '空值含义',
  substitution: '可否代用',
  filler: '允许补答的人',
  'explicit-none': '明确没有',
  record: '记录保留',
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parse(argv, options) {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  return { values, positionals };
}

function requireEdition(bundle, formId, edition) {
  const editions = availableEditions(bundle.instructions, formId);
  if (!edition) fail(`请用 --edition 指定说明版次（可用：${editions.join('、')}）`);
  if (!editions.includes(edition)) fail(`表单 ${formId} 没有版次 ${edition}（可用：${editions.join('、')}）`);
  return edition;
}

function describeTerm(term) {
  const parts = [];
  if (term.aspect === 'requirement') parts.push(term.ruling === 'exempt' ? '可不填' : '必填');
  if (term.aspect === 'filler') parts.push(`允许补答：${term.actors.join('、')}${term.note ? `（${term.note}）` : ''}`);
  if (term.aspect === 'substitution') parts.push(term.ruling === 'forbidden' ? `不得代用（${term.detail}）` : `可代用（${term.note ?? term.detail ?? ''}）`);
  if (term.aspect === 'blankMeaning') parts.push(`空值含义：${term.meaning}`);
  if (term.aspect === 'explicit-none') parts.push(`明确没有时${term.value ? `填「${term.value}」` : '按明确没有处理'}`);
  if (term.aspect === 'value-rule') parts.push(`填 ${term.value}`);
  if (term.aspect === 'record') parts.push(term.note);
  if (term.conditions && Object.keys(term.conditions).length > 0) {
    const names = { mode: '申报方式', domestic: '国内货物', windowEnabled: '统一窗口', writtenProof: '书面证明' };
    const text = Object.entries(term.conditions).map(([key, value]) => `${names[key] ?? key}=${value}`).join('，');
    parts.push(`触发条件：${text}`);
  }
  return `${term.clause}${term.via ? `（经 ${term.via} 引用）` : ''} ${parts.join('；')}`;
}

function cmdTerms(bundle, formId, edition) {
  const form = bundle.forms.find(row => row.id === formId);
  if (!form) fail(`未登记的表单 ${formId}`);
  requireEdition(bundle, formId, edition);
  const clauses = effectiveClauses(bundle.instructions, formId, edition);
  console.log(`表单 ${formId}（${form.partner}，${form.format}）版次 ${edition}，约束版本：${form.authority ?? '未指定'}`);
  console.log(`有效条款：${clauses.map(row => `${row.id}(${row.language} ${row.clause})`).join('、')}`);
  const { byField, distinctions, residues } = extractFieldTerms(clauses, form);
  const confirmations = loadConfirmations(STATE_DIR);
  const reconciled = reconcileFields(byField, form, { confirmations });
  for (const field of form.fields) {
    const rec = reconciled.fields[field.name];
    console.log(`\n栏位 ${field.name}（值域：${field.values.join('／')}${field.emptyMeans ? `；空串=${field.emptyMeans}` : ''}）`);
    const pair = byField[field.name] ?? { zh: [], en: [] };
    for (const lang of ['zh', 'en']) {
      for (const term of pair[lang]) console.log(`  [${lang}] ${describeTerm(term)}`);
    }
    if (pair.zh.length === 0 && pair.en.length === 0) console.log('  （两种文本均未提及）');
    for (const [group, info] of Object.entries(rec?.groups ?? {})) {
      if (info.status === 'held') console.log(`  ⚠ ${GROUP_NAMES[group] ?? group} 两种文本冲突且无约束版本，暂缓`);
      if (info.status === 'authority-resolved') console.log(`  ↳ ${GROUP_NAMES[group] ?? group} 冲突，按约束版本（${info.authority}）处理`);
      if (info.status === 'confirmed') console.log(`  ↳ ${GROUP_NAMES[group] ?? group} 冲突，按柜员确认 ${info.confirmation} 处理`);
    }
  }
  for (const item of distinctions) console.log(`\n提示：${item.clause} 要求区分 ${item.fields.join('、')}`);
  for (const residue of residues) console.log(`\n未解析残片：${residue.clause}「${residue.left}」（原句：${residue.sentence}）`);
}

function printCase(caseFile) {
  const { form } = caseFile;
  console.log(`案件 ${caseFile.caseId}｜表单 ${form.id}（${form.partner}）｜版次 ${caseFile.edition}`);
  const p = caseFile.participants;
  console.log(`身份：货主 ${p.ownerLabel}（${p.owner}）｜代办方 ${p.agentLabel ? `${p.agentLabel}（${p.agent}）` : '无'}｜收件方 ${p.recipient}`);
  console.log(`条件：${JSON.stringify(caseFile.conditions)}`);
  if (caseFile.confirmationStates.length > 0) {
    console.log('确认：');
    for (const state of caseFile.confirmationStates) {
      console.log(`  ${state.id}（${state.field}）${state.applies ? '适用中' : `不适用：${state.reason}`}`);
    }
  }
  console.log('栏位：');
  for (const field of caseFile.fields) {
    const meaning = STATE_MEANING[field.status] ?? field.status;
    const recipient = field.recipient
      ? (field.recipient.kind === 'value' ? `值 ${field.recipient.value}` : field.recipient.kind === 'omit' ? '键省略' : '空串')
      : '暂缓';
    console.log(`  ${field.name}｜${meaning}${field.required ? '（必填）' : ''}｜收件：${recipient}｜来源 ${field.trace.drafts.join('、') || '—'}｜依据 ${field.trace.clauses.join('、') || '—'}`);
    for (const note of field.notes) console.log(`    · ${note}`);
  }
  if (caseFile.conflicts.length > 0) {
    console.log('冲突处理：');
    for (const conflict of caseFile.conflicts) {
      let text = conflict.resolution;
      if (!text) {
        const held = caseFile.fields.find(field => field.name === conflict.field)?.status === 'held';
        text = held ? '暂缓，待柜员依据原文确认' : '未决；本案填法不受影响，无需确认';
      }
      console.log(`  ${conflict.field} 的${GROUP_NAMES[conflict.group] ?? conflict.group}：${text}`);
    }
  }
  if (caseFile.collisions.length > 0) {
    console.log('空值含义：');
    for (const collision of caseFile.collisions) console.log(`  ${collision.field}：${collision.lost}；${collision.detail}`);
  }
  if (caseFile.followUps.length > 0) {
    console.log('追问：');
    for (const followUp of caseFile.followUps) console.log(`  由 ${followUp.who} ${followUp.what}`);
  }
  for (const residue of caseFile.residues) console.log(`未解析残片：${residue.clause ?? residue.draft}「${residue.left}」`);
  console.log(caseFile.blocked ? '状态：暂缓，受影响的栏位及依赖它的转送已保留，草稿继续办理。' : '状态：可签发。');
}

function cmdCase(bundle, caseId, edition) {
  const drafts = bundle.drafts.filter(row => row.caseId === caseId);
  if (drafts.length === 0) fail(`没有案件 ${caseId} 的草稿`);
  requireEdition(bundle, drafts[0].form, edition);
  const caseFile = buildCase({ bundle, caseId, edition, confirmations: loadConfirmations(STATE_DIR) });
  printCase(caseFile);
  return caseFile;
}

function cmdConfirm(bundle, caseId, options) {
  const drafts = bundle.drafts.filter(row => row.caseId === caseId);
  if (drafts.length === 0) fail(`没有案件 ${caseId} 的草稿`);
  const formId = drafts[0].form;
  requireEdition(bundle, formId, options.edition);
  const { field, group, clauses } = options;
  if (!field || !group || !clauses) fail('confirm 需要 --field、--group、--clauses');
  const clauseIds = clauses.split(',').map(id => id.trim()).filter(Boolean);
  const active = new Set(effectiveClauses(bundle.instructions, formId, options.edition).map(row => row.id));
  for (const id of clauseIds) {
    if (!active.has(id)) fail(`条款 ${id} 在版次 ${options.edition} 下无效`);
  }
  // 以当前案件条件快照记录确认：确认只适用于记录下来的说明版本与条件。
  const caseFile = buildCase({ bundle, caseId, edition: options.edition, confirmations: [] });
  const record = saveConfirmation(STATE_DIR, {
    caseId,
    form: formId,
    edition: options.edition,
    field,
    group,
    clauseIds,
    conditions: caseFile.conditions,
    note: options.note ?? '',
    by: '柜员',
  });
  console.log(`已记录确认 ${record.id}：${field} 的 ${group} 按 ${clauseIds.join('、')} 处理（版次 ${options.edition}，条件 ${JSON.stringify(record.conditions)}）`);
}

function cmdPreview(bundle, caseId, edition) {
  const caseFile = cmdCase(bundle, caseId, edition);
  console.log('\n—— 收件方预览 ——');
  console.log(renderView(caseFile));
  console.log('\n—— 申报件 ——');
  console.log(caseFile.blocked ? '（暂缓，未生成）' : buildPayload(caseFile));
  return caseFile;
}

function cmdIssue(bundle, dataDir, caseId, edition, corrects) {
  try {
    const { receipt } = issueCase({
      bundle,
      dataDir,
      caseId,
      edition,
      confirmations: loadConfirmations(STATE_DIR),
      corrects,
    });
    console.log(`已签发并留档 ${receipt.id}（${receipt.sentAt}）${corrects ? `，更正 ${corrects}` : ''}`);
    console.log(receipt.payloadText);
  } catch (error) {
    if (error.caseFile) printCase(error.caseFile);
    fail(error.message);
  }
}

function cmdReceipts(dataDir, caseId) {
  const all = loadReceipts(dataDir).filter(row => !caseId || row.caseId === caseId);
  for (const row of all) {
    const corrects = correctsOf(row);
    const correctedBy = correctionsOf(dataDir, row.id);
    console.log(`${row.id}｜案件 ${row.caseId}｜${row.form} 版次 ${row.edition}｜${row.sentAt}${corrects ? `｜更正 ${corrects}` : ''}${correctedBy.length > 0 ? `｜被 ${correctedBy.map(c => c.id).join('、')} 更正` : ''}`);
    console.log(`  ${row.payloadText}`);
  }
  if (all.length === 0) console.log('（无记录）');
}

function cmdVerify(bundle, dataDir, receiptId) {
  const receipt = findReceipt(dataDir, receiptId);
  if (!receipt) fail(`找不到申报件 ${receiptId}`);
  const form = bundle.forms.find(row => row.id === receipt.form);
  const result = verifyReceipt(receipt, form);
  console.log(result.ok ? `${receiptId} 预览与申报件对应。` : `${receiptId} 无法确认对应：${result.reason}`);
  if (!result.ok) process.exitCode = 1;
}

const [command, ...rest] = process.argv.slice(2);
const bundle = readBundle(DATA_DIR);

switch (command) {
  case 'terms': {
    const { values, positionals } = parse(rest, { edition: { type: 'string' } });
    cmdTerms(bundle, positionals[0], values.edition);
    break;
  }
  case 'case': {
    const { values, positionals } = parse(rest, { edition: { type: 'string' } });
    cmdCase(bundle, positionals[0], values.edition);
    break;
  }
  case 'confirm': {
    const { values, positionals } = parse(rest, {
      edition: { type: 'string' }, field: { type: 'string' }, group: { type: 'string' },
      clauses: { type: 'string' }, note: { type: 'string' },
    });
    cmdConfirm(bundle, positionals[0], { edition: values.edition, field: values.field, group: values.group, clauses: values.clauses, note: values.note });
    break;
  }
  case 'preview': {
    const { values, positionals } = parse(rest, { edition: { type: 'string' } });
    cmdPreview(bundle, positionals[0], values.edition);
    break;
  }
  case 'issue': {
    const { values, positionals } = parse(rest, { edition: { type: 'string' }, corrects: { type: 'string' } });
    const drafts = bundle.drafts.filter(row => row.caseId === positionals[0]);
    if (drafts.length === 0) fail(`没有案件 ${positionals[0]} 的草稿`);
    requireEdition(bundle, drafts[0].form, values.edition);
    cmdIssue(bundle, DATA_DIR, positionals[0], values.edition, values.corrects ?? null);
    break;
  }
  case 'receipts': {
    const { values } = parse(rest, { case: { type: 'string' } });
    cmdReceipts(DATA_DIR, values.case ?? null);
    break;
  }
  case 'verify': {
    cmdVerify(bundle, DATA_DIR, rest[0]);
    break;
  }
  default:
    console.log('命令：terms / case / confirm / preview / issue / receipts / verify（详见文件头注释）');
}
