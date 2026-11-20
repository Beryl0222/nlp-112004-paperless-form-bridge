// 草稿原话 → 结构化事实。每条事实保留来源草稿编号与原句；
// 无法拆开的原答复记为 joint（不臆造拆分），无法解析的句子残片如实列出。

import { fieldOf } from './clauses.mjs';

// 业务窗口站点码（见 README 使用约定）。
export const SITE_CODES = { 东泠: 'E-07', 桥浦: 'Q-02' };

const ZH_STOP = new Set([...'的了和及与并时若如则也仍只才皆应请本该其为由在我但这回']);
const EN_STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'if', 'is', 'be', 'by', 'in', 'on', 'my', 'i', 'not', 'yet', 'can', 'you', 'about', 'both', 'me']);

// facts 种类：
// condition  案件条件（申报方式、货物情况、窗口是否启用、书面证明是否出具）
// answer     栏位回答（value 值 / explicit-none 明确没有 / unanswered-declared 明示未回答）
// candidate  候选值（可能多义或来源受限，未定）
// retract    撤回（按标签撤回此前事实）
// restriction 填写人限制（如“只供我本人填写”）
// joint      不可拆分的联合答复（一段原话覆盖多个栏位）
// note       参考信息
const RULES = [
  {
    id: 'zh-domestic', lang: 'zh',
    pattern: /国内的/,
    emit(m, ctx) {
      return [
        { kind: 'condition', key: 'domestic', value: true },
        { kind: 'answer', field: fieldOf(ctx.form, '国内'), value: 'Y' },
      ];
    },
  },
  {
    id: 'zh-self', lang: 'zh',
    pattern: /我自己办/,
    emit() {
      return [
        { kind: 'condition', key: 'mode', value: 'SELF' },
        { kind: 'answer', field: 'actor', value: 'SELF' },
      ];
    },
  },
  {
    id: 'zh-agent', lang: 'zh',
    pattern: /请(\S+?)代办/,
    emit(m, ctx) {
      const agent = ctx.participants.find(p => p.label === m[1] || p.label.startsWith(m[1]));
      return [
        { kind: 'condition', key: 'mode', value: 'AGENT' },
        { kind: 'answer', field: 'actor', value: 'AGENT' },
        { kind: 'note', note: `代办方：${m[1]}${agent ? `（${agent.id}）` : '（未登记）'}`, agent: agent?.id ?? null },
      ];
    },
  },
  {
    id: 'zh-window-contact', lang: 'zh',
    pattern: /联系就填(\S+?)窗口/,
    emit(m) {
      const code = SITE_CODES[m[1]] ?? null;
      return [
        { kind: 'answer', field: 'hub', value: code ?? m[1], tag: 'window', note: code ? undefined : '未登记的站点' },
        { kind: 'condition', key: 'windowEnabled', value: true },
      ];
    },
  },
  {
    id: 'zh-office-phone-only', lang: 'zh',
    pattern: /只收工位电话/,
    emit() { return [{ kind: 'note', note: '仅收工位电话' }]; },
  },
  {
    id: 'zh-learned-later', lang: 'zh',
    pattern: /刚问清/,
    emit() { return [{ kind: 'note', note: '随后问清' }]; },
  },
  {
    id: 'zh-retract-numbers', lang: 'zh',
    pattern: /以前的号码不要了/,
    emit() { return [{ kind: 'retract', scope: 'personal-number' }]; },
  },
  {
    id: 'zh-no-code-yet', lang: 'zh',
    pattern: /登记号没有拿到/,
    emit(m, ctx) {
      return [{ kind: 'answer', field: fieldOf(ctx.form, '登记号'), state: 'explicit-none', written: false }];
    },
  },
  {
    id: 'zh-no-code-written', lang: 'zh',
    pattern: /没有取得货主登记号/,
    emit(m, ctx) {
      const written = ctx.draft.kind === '书面确认';
      return [
        { kind: 'answer', field: fieldOf(ctx.form, '货主登记号'), state: 'explicit-none', written },
        ...(written ? [{ kind: 'condition', key: 'writtenProof', value: true }] : []),
      ];
    },
  },
  {
    id: 'zh-agent-own-code', lang: 'zh',
    pattern: /代理登记号是\s*(\S+?)[，。]/,
    emit(m, ctx) {
      return [{ kind: 'candidate', field: fieldOf(ctx.form, '登记号'), value: m[1], role: '代办方代码' }];
    },
  },
  {
    id: 'zh-no-written-statement', lang: 'zh',
    pattern: /(?:货主)?没有出具未登记说明/,
    emit() { return [{ kind: 'condition', key: 'writtenProof', value: false }]; },
  },
  {
    id: 'zh-window-collect', lang: 'zh',
    pattern: /窗口可以代收/,
    emit() { return [{ kind: 'condition', key: 'windowEnabled', value: true }]; },
  },
  {
    id: 'zh-owner-only-contact', lang: 'zh',
    pattern: /(?:新的)?私人联系电话只供我本人填写/,
    emit() {
      return [{ kind: 'restriction', field: 'contact', actors: ['货主本人'], note: '新私人联系电话仅本人可填', tag: 'personal-number' }];
    },
  },
  {
    id: 'zh-contact-number', lang: 'zh',
    pattern: /联系电话[是为]?\s*([\d][\d-]{4,})/,
    emit(m, ctx) {
      return [{ kind: 'answer', field: fieldOf(ctx.form, '联络方式'), value: m[1], tag: 'personal-number' }];
    },
  },
  {
    id: 'zh-ambiguous-order-code', lang: 'zh',
    pattern: /订单上有\s*(\S+?)[，。]\s*暂不清楚是(\S+?)还是(\S+?)。/,
    emit(m, ctx) {
      return [{
        kind: 'candidate',
        field: fieldOf(ctx.form, m[3]) ?? fieldOf(ctx.form, '登记号'),
        value: m[1],
        ambiguous: [m[2], m[3]],
        medium: '订单',
      }];
    },
  },
  {
    id: 'en-not-registered', lang: 'en',
    pattern: /Not registered\./i,
    emit(m, ctx) {
      return [{ kind: 'answer', field: fieldOf(ctx.form, 'registration'), state: 'explicit-none', written: false }];
    },
  },
  {
    id: 'en-dock-desk-joint', lang: 'en',
    pattern: /dock desk can tell you about both the office and the contact\./i,
    emit(m, ctx) {
      return [{
        kind: 'joint',
        fields: [fieldOf(ctx.form, 'office'), fieldOf(ctx.form, 'contact')],
        delegate: 'dock desk（未登记参与人）',
        splittable: false,
      }];
    },
  },
  {
    id: 'en-registration', lang: 'en',
    pattern: /registration is (\S+?)(?:\s+and|\s*[.,])/i,
    emit(m, ctx) {
      return [{ kind: 'answer', field: fieldOf(ctx.form, 'registration'), value: m[1] }];
    },
  },
  {
    id: 'en-office', lang: 'en',
    pattern: /office I use is (\S+?)(?:\s*[.,])/i,
    emit(m, ctx) {
      return [{ kind: 'answer', field: fieldOf(ctx.form, 'office'), value: m[1] }];
    },
  },
  {
    id: 'en-not-replied', lang: 'en',
    pattern: /have not replied about ([\w ]+?) yet\./i,
    emit(m, ctx) {
      return [{ kind: 'answer', field: fieldOf(ctx.form, m[1]), state: 'unanswered-declared' }];
    },
  },
];

function sentencesOf(text, language) {
  const parts = language === 'zh' ? text.split(/(?<=。)/) : text.split(/(?<=[.!?])\s+/);
  return parts.map(s => s.trim()).filter(Boolean);
}

export function extractFacts(draft, { form, participants }) {
  const language = /[一-鿿]/.test(draft.text) ? 'zh' : 'en';
  const ctx = { draft, form, participants };
  const facts = [];
  const residues = [];
  for (const sentence of sentencesOf(draft.text, language)) {
    const spans = [];
    for (const rule of RULES) {
      if (rule.lang !== language) continue;
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
      for (const match of sentence.matchAll(pattern)) {
        for (const fact of rule.emit(match, ctx)) {
          facts.push({ ...fact, source: draft.id, actor: draft.actor, kindOfDraft: draft.kind, sentence });
        }
        spans.push([match.index, match.index + match[0].length]);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    let residue = '';
    let cursor = 0;
    for (const [start, end] of spans) {
      residue += sentence.slice(cursor, start);
      cursor = Math.max(cursor, end);
    }
    residue += sentence.slice(cursor);
    residue = residue.replace(/[，。；、：：“”‘’（）()·\s,.;:'"!?\-]/g, language === 'zh' ? '' : ' ');
    const left = language === 'zh'
      ? [...residue].filter(ch => !ZH_STOP.has(ch)).join('')
      : residue.split(/\s+/).filter(word => word && !EN_STOP.has(word.toLowerCase())).join(' ');
    if (left.length > 0) residues.push({ draft: draft.id, sentence, left });
  }
  return { facts, residues };
}

// 按接件顺序归并：撤回先生效，同键条件后者为准。
export function reduceConditions(facts) {
  const retracts = facts.filter(fact => fact.kind === 'retract');
  const conditions = {};
  for (const fact of facts) {
    if (fact.kind === 'condition') conditions[fact.key] = fact.value;
  }
  return { conditions, retracts };
}

// 撤回作用后的事实序列（retract 按 tag 移除更早的事实）。
export function effectiveFacts(facts) {
  const kept = [];
  for (const fact of facts) {
    if (fact.kind === 'retract') {
      for (let i = kept.length - 1; i >= 0; i -= 1) {
        if (kept[i].tag === fact.scope) kept.splice(i, 1);
      }
      continue;
    }
    kept.push(fact);
  }
  return kept;
}
