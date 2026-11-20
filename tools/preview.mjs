// 收件预览与签发：以收件方实际能读到的栏位与空值含义生成预览，
// 每个值可回到原回答或书面说明；签发的预览必须与实际申报件对应（可核对）。

import { STATE_MEANING } from './casefile.mjs';

// CSV 单元格转义（常用 CSV 约定）。
function csvCell(value) {
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function parseCsvLine(line) {
  const cells = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let cell = '';
      i += 1;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { cell += '"'; i += 2; } else if (line[i] === '"') { i += 1; break; } else { cell += line[i]; i += 1; }
      }
      cells.push(cell);
      if (line[i] === ',') { i += 1; continue; }
      break;
    }
    const next = line.indexOf(',', i);
    if (next === -1) { cells.push(line.slice(i)); break; }
    cells.push(line.slice(i, next));
    i = next + 1;
  }
  return cells;
}

// 由栏位状态生成实际申报件文本（JSON 对象或 CSV 固定列）。
export function buildPayload(caseFile) {
  const { form } = caseFile;
  const isJson = form.format.startsWith('JSON');
  if (isJson) {
    const object = {};
    for (const fieldDef of form.fields) {
      const state = caseFile.fields.find(field => field.name === fieldDef.name);
      if (state?.recipient?.kind === 'value') object[fieldDef.name] = String(state.recipient.value);
    }
    return JSON.stringify(object);
  }
  return form.fields.map(fieldDef => {
    const state = caseFile.fields.find(field => field.name === fieldDef.name);
    if (state?.recipient?.kind === 'value') return csvCell(state.recipient.value);
    return '';
  }).join(',');
}

function displayOf(state, fieldDef) {
  if (!state.recipient) return '∅暂缓';
  if (state.recipient.kind === 'value') return String(state.recipient.value);
  if (state.recipient.kind === 'omit') return '∅省略';
  return "''空串";
}

function meaningOf(state, fieldDef) {
  const parts = [];
  if (state.status && STATE_MEANING[state.status]) parts.push(STATE_MEANING[state.status]);
  if (state.recipient?.kind === 'omit') parts.push('收件方看不到此键');
  if (state.recipient?.kind === 'empty') parts.push(`收件方读作「${fieldDef.emptyMeans ?? '未提供'}」`);
  return parts.join('，');
}

// 预览文字：每行 栏位=值｜含义｜来源｜依据，可从值回到原回答或书面说明。
export function renderView(caseFile, { corrects = null } = {}) {
  const { form } = caseFile;
  const lines = [];
  if (corrects) lines.push(`更正 ${corrects}。`);
  lines.push(`申报 ${form.id}（${form.partner}）版次 ${caseFile.edition}`);
  for (const fieldDef of form.fields) {
    const state = caseFile.fields.find(field => field.name === fieldDef.name);
    if (!state) continue;
    const source = state.trace.drafts.length > 0 ? state.trace.drafts.join('、') : '—';
    const basis = state.trace.clauses.length > 0 ? state.trace.clauses.join('、') : '—';
    lines.push(`${fieldDef.name}=${displayOf(state, fieldDef)}｜${meaningOf(state, fieldDef)}｜来源 ${source}｜依据 ${basis}`);
  }
  for (const collision of caseFile.collisions) {
    lines.push(`注意：${collision.field} 的${collision.lost}；${collision.detail}。`);
  }
  return lines.join('\n');
}

// 从申报件文本重建各栏位的收件显示（核对预览与申报件是否对应）。
export function displaysFromPayload(payloadText, form) {
  const expected = new Map();
  if (form.format.startsWith('JSON')) {
    const object = JSON.parse(payloadText);
    for (const fieldDef of form.fields) {
      if (Object.hasOwn(object, fieldDef.name)) {
        if (object[fieldDef.name] === null) throw new Error(`${fieldDef.name} 以 null 代替缺失键，违反约定`);
        expected.set(fieldDef.name, String(object[fieldDef.name]));
      } else {
        expected.set(fieldDef.name, '∅省略');
      }
    }
    return expected;
  }
  const cells = parseCsvLine(payloadText);
  if (cells.length !== form.fields.length) throw new Error(`列数 ${cells.length} 与收件样式 ${form.fields.length} 不符`);
  form.fields.forEach((fieldDef, index) => {
    expected.set(fieldDef.name, cells[index] === '' ? "''空串" : cells[index]);
  });
  return expected;
}

// 核对留档申报件：预览中的每个栏位显示须与申报件实际内容一致。
export function verifyReceipt(receipt, form) {
  let expected;
  try {
    expected = displaysFromPayload(receipt.payloadText, form);
  } catch (error) {
    return { ok: false, reason: `申报件本身不合约定：${error.message}` };
  }
  const shown = new Map();
  for (const line of receipt.viewText.split('\n')) {
    const match = line.match(/^(\S+?)=(\S+?)｜/);
    if (match) shown.set(match[1], match[2]);
  }
  if (shown.size === 0) return { ok: false, reason: '预览不是本工具签发的格式，无法核对（早期留档）' };
  const mismatches = [];
  for (const [field, display] of expected) {
    if (!shown.has(field)) mismatches.push(`${field} 预览缺行`);
    else if (shown.get(field) !== display) mismatches.push(`${field} 预览为 ${shown.get(field)}，申报件为 ${display}`);
  }
  for (const field of shown.keys()) {
    if (!expected.has(field)) mismatches.push(`${field} 预览多出行，申报件无此栏位`);
  }
  return mismatches.length === 0 ? { ok: true } : { ok: false, reason: mismatches.join('；') };
}
