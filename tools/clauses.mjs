// 说明条款：版本解析 → 逐句提取栏位义务/例外 → 两种语言对账与裁决。
// 每条提取出的义务都保留来源条款与原句，未覆盖的句子残片会如实列出。

const ZH_STOP = new Set([...'的了和及与并时若如则也仍只才皆应请本该其为由在对']);
const EN_STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'if', 'is', 'be', 'by', 'in', 'on', 'see', 'note', 'may', 'only', 'their', 'its', 'per', 'where', 'a']);

export function compareEditions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function availableEditions(instructions, formId) {
  return [...new Set(instructions.filter(row => row.form === formId).map(row => row.edition))].sort(compareEditions);
}

// 某版次下有效的条款：已发行，且未被同版次内编号相同的新段落替代。
export function effectiveClauses(instructions, formId, edition) {
  const issued = instructions.filter(row => row.form === formId && compareEditions(row.edition, edition) <= 0);
  const replaced = new Set(issued.map(row => row.supersedes).filter(Boolean));
  return issued.filter(row => !replaced.has(row.id));
}

// 各表单栏位的说法对照（两种语言的措辞都可能出现）。
const FIELD_ALIASES = {
  'form-a': [
    ['ownerCode', ['货主代码', '货主登记号', '登记号', 'principal identifier']],
    ['contact', ['联络栏', '联络方式', 'contact section', 'contact']],
    ['hub', ['窗口站点', '站点']],
    ['domestic', ['国内货物', '国内', 'domestic']],
    ['actor', ['申报方式']],
    ['line', ['原话']],
  ],
  'form-b': [
    ['Principal ID', ['货主登记号', '登记号', '货主号', 'Principal ID', 'principal identifier', 'registration']],
    ['Contact', ['联络方式', 'contact']],
    ['Office', ['经办点', 'office']],
    ['Domestic', ['国内', 'domestic']],
  ],
};

export function fieldOf(form, phrase) {
  const aliases = FIELD_ALIASES[form.id] ?? [];
  const text = phrase.trim().toLowerCase();
  for (const [field, names] of aliases) {
    for (const name of names) {
      const alias = name.toLowerCase();
      if (text === alias || text.endsWith(alias)) return field;
    }
  }
  return null;
}

// 提取规则：每条规则匹配一种说法，产出结构化义务（terms）或条款引用（refs）。
// terms: {clause, language, field, aspect, ruling?, conditions?, actors?, value?, meaning?, tag?, note?, sentence}
// aspect: requirement(义务/豁免) | filler(允许补答的人) | substitution(可否代用)
//         | blankMeaning(空值含义) | explicit-none(明确没有) | value-rule(条件填法) | record(记录保留) | distinction(栏位区分)
const RULES = [
  {
    id: 'zh-self-exempt', lang: 'zh',
    pattern: /(?:货主)?自行申报的，([^，。]+)可不填([^，。]+)。/,
    emit(m, ctx) {
      const conditions = { mode: 'SELF' };
      if (/国内/.test(m[1])) conditions.domestic = true;
      return { terms: [{ field: fieldOf(ctx.form, m[2]), aspect: 'requirement', ruling: 'exempt', conditions, actors: ['货主'] }] };
    },
  },
  {
    id: 'zh-agent-ref', lang: 'zh',
    pattern: /代理申报参见注([①②③④⑤])/,
    emit(m) { return { refs: [{ to: m[1], conditions: { mode: 'AGENT' } }] }; },
  },
  {
    id: 'zh-field-ref', lang: 'zh',
    pattern: /(\S+?)同样适用注([①②③④⑤])/,
    emit(m, ctx) { return { refs: [{ to: m[2], conditions: {}, field: fieldOf(ctx.form, m[1]) }] }; },
  },
  {
    id: 'zh-filler-no-substitute', lang: 'zh',
    pattern: /(代办方|货主|联系人|柜员)填写([^，。]+)[，,]不得用([^，。]+)代替。/,
    emit(m, ctx) {
      const field = fieldOf(ctx.form, m[2]);
      return {
        terms: [
          { field, aspect: 'filler', actors: [m[1]] },
          { field, aspect: 'substitution', ruling: 'forbidden', tag: 'agent-own-code', detail: m[3] },
        ],
      };
    },
  },
  {
    id: 'zh-written-none', lang: 'zh',
    pattern: /(?:货主)?书面证明未获代码的，才由(\S+?)填[‘'“]?([^’'”]+)[’'”]?。/,
    emit(m) {
      return { terms: [{ field: null, aspect: 'explicit-none', ruling: 'allowed', actors: [m[1]], conditions: { writtenProof: true }, value: m[2] }] };
    },
  },
  {
    id: 'zh-filler-self', lang: 'zh',
    pattern: /(\S+?)由(\S+?)本人填写。/,
    emit(m, ctx) { return { terms: [{ field: fieldOf(ctx.form, m[1]), aspect: 'filler', actors: [m[2]] }] }; },
  },
  {
    id: 'zh-window-site', lang: 'zh',
    pattern: /联络方式为统一窗口的，填(\S+?)[；。]/,
    emit(m, ctx) {
      return { terms: [{ field: fieldOf(ctx.form, m[1]) ?? 'hub', aspect: 'value-rule', value: '站点代码', conditions: { windowEnabled: true } }] };
    },
  },
  {
    id: 'zh-only-blank', lang: 'zh',
    pattern: /仅(\S+?)留空/,
    emit(m, ctx, sentence) {
      const conditions = /统一窗口/.test(sentence) ? { windowEnabled: true } : {};
      return { terms: [{ field: fieldOf(ctx.form, m[1]), aspect: 'requirement', ruling: 'exempt', conditions }] };
    },
  },
  {
    id: 'zh-contact-allow-agent', lang: 'zh',
    pattern: /联系人可允许代办方填写(\S+?)。/,
    emit(m, ctx) {
      return { terms: [{ field: fieldOf(ctx.form, m[1]), aspect: 'filler', actors: ['联系人', '代办方'], note: '需联系人许可' }] };
    },
  },
  {
    id: 'zh-window-off-self', lang: 'zh',
    pattern: /统一窗口未启用时，仍由本人填(\S+?)。/,
    emit(m, ctx) {
      return { terms: [{ field: fieldOf(ctx.form, m[1]), aspect: 'filler', actors: ['联系人'], conditions: { windowEnabled: false } }] };
    },
  },
  {
    id: 'zh-none-or-blank', lang: 'zh',
    pattern: /货主没有登记号时请填无[，,]货主未回答时暂留空。/,
    emit(m, ctx) {
      const field = fieldOf(ctx.form, '登记号');
      return {
        terms: [
          { field, aspect: 'explicit-none', ruling: 'value', value: '无' },
          { field, aspect: 'blankMeaning', meaning: '未回答' },
        ],
      };
    },
  },
  {
    id: 'zh-distinction', lang: 'zh',
    pattern: /请区分(\S+?)和(\S+?)。/,
    emit(m, ctx) {
      return { terms: [{ field: null, aspect: 'distinction', fields: [fieldOf(ctx.form, m[1]), fieldOf(ctx.form, m[2])] }] };
    },
  },
  {
    id: 'en-domestic-exempt', lang: 'en',
    pattern: /For domestic goods, the ([\w ]+?) may be left blank\./i,
    emit(m, ctx) {
      return { terms: [{ field: fieldOf(ctx.form, m[1]), aspect: 'requirement', ruling: 'exempt', conditions: { domestic: true } }] };
    },
  },
  {
    id: 'en-broker-own', lang: 'en',
    pattern: /Brokers may provide their own identifier\./i,
    emit() {
      return { terms: [{ field: null, aspect: 'substitution', ruling: 'allowed', tag: 'agent-own-code', detail: "broker's own identifier" }] };
    },
  },
  {
    id: 'en-note-ref', lang: 'en',
    pattern: /For the ([\w ]+?) see note ([A-Z])\./i,
    emit(m, ctx) { return { refs: [{ to: m[2], conditions: {}, field: fieldOf(ctx.form, m[1]) }] }; },
  },
  {
    id: 'en-shared-office', lang: 'en',
    pattern: /Where a shared office handles contact, enter the ([\w ]+?) instead of a ([\w' ]+?)\./i,
    emit() {
      return { terms: [{ field: 'contact', aspect: 'value-rule', value: '站点代码', conditions: { windowEnabled: true }, note: 'office code instead of a person’s number' }] };
    },
  },
  {
    id: 'en-blank-only-if', lang: 'en',
    pattern: /Leave ([\w ]+?) blank only if ([^;.]+)[;.]/i,
    emit(m, ctx) {
      const meaning = /no identifier was issued/i.test(m[2]) ? '无登记号' : m[2].trim();
      return { terms: [{ field: fieldOf(ctx.form, m[1]), aspect: 'blankMeaning', meaning }] };
    },
  },
  {
    id: 'en-clerk-copy', lang: 'en',
    pattern: /the clerk may copy ([\w ]+?) from ([^,;]+?), not from ([^;.]+)\./i,
    emit(m, ctx) {
      const field = fieldOf(ctx.form, m[1].replace(/^a\s+/i, ''));
      return { terms: [{ field, aspect: 'substitution', ruling: 'allowed', actors: ['柜员'], tag: 'clerk-copy', medium: '签署陈述', note: `可抄自${m[2].trim()}，不得取自${m[3].trim()}` }] };
    },
  },
  {
    id: 'en-retain-record', lang: 'en',
    pattern: /Retain the explicit declaration of non-registration in the submission record\./i,
    emit() {
      return { terms: [{ field: null, aspect: 'record', note: '未登记声明须保留在提交记录中' }] };
    },
  },
  {
    id: 'en-blank-means', lang: 'en',
    pattern: /A blank ([\w ]+?) means unanswered\./i,
    emit(m, ctx) {
      return { terms: [{ field: fieldOf(ctx.form, m[1]), aspect: 'blankMeaning', meaning: '未回答' }] };
    },
  },
];

function sentencesOf(text, language) {
  // 中文只按句号切分：分号连接的短句往往共享条件（如“统一窗口…；仅联络栏留空”）。
  const parts = language === 'zh' ? text.split(/(?<=。)/) : text.split(/(?<=[.!?])\s+/);
  return parts.map(s => s.trim()).filter(Boolean);
}

function stripStopwords(residue, language) {
  if (language === 'zh') {
    return [...residue].filter(ch => !ZH_STOP.has(ch)).join('');
  }
  return residue.split(/\s+/).filter(word => word && !EN_STOP.has(word.toLowerCase())).join(' ');
}

// 单句提取：所有规则全局匹配，剩余无法解释的片段记为残片（不静默丢弃）。
function extractSentence(sentence, ctx) {
  const terms = [];
  const refs = [];
  const spans = [];
  for (const rule of RULES) {
    if (rule.lang !== ctx.clause.language) continue;
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    for (const match of sentence.matchAll(pattern)) {
      const produced = rule.emit(match, ctx, sentence);
      for (const term of produced.terms ?? []) {
        terms.push({ ...term, clause: ctx.clause.id, language: ctx.clause.language, sentence });
      }
      refs.push(...(produced.refs ?? []));
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
  residue = residue.replace(/[，。；、：：“”‘’（）()·\s,.;:'"!?\-]/g, ctx.clause.language === 'zh' ? '' : ' ');
  const left = stripStopwords(residue, ctx.clause.language);
  return { terms, refs, residue: left.length > 0 ? { clause: ctx.clause.id, sentence, left } : null };
}

// 提取一条款：句切分 → 逐句规则提取 → 未指明栏位的义务归入条款首个明指栏位。
export function extractClauseTerms(clause, form) {
  const terms = [];
  const refs = [];
  const residues = [];
  for (const sentence of sentencesOf(clause.text, clause.language)) {
    const out = extractSentence(sentence, { clause, form });
    terms.push(...out.terms);
    refs.push(...out.refs);
    if (out.residue) residues.push(out.residue);
  }
  const fallbackField = terms.find(term => term.field)?.field ?? null;
  for (const term of terms) {
    if (!term.field && term.aspect !== 'distinction') term.field = fallbackField;
  }
  return { terms, refs, residues };
}

// 汇总某版次有效条款：解析脚注引用（引用可把要求限定在特定申报方式等条件），
// 按栏位与语言分组，供对账。被引用的脚注条款只经引用条件生效，不单独重复计入。
export function extractFieldTerms(clauses, form) {
  const byClause = new Map();
  const residues = [];
  for (const clause of clauses) {
    const out = extractClauseTerms(clause, form);
    byClause.set(clause.id, { clause, ...out });
    residues.push(...out.residues);
  }
  const referenced = new Set();
  for (const { refs } of byClause.values()) {
    for (const ref of refs) {
      const target = clauses.find(row => row.clause === ref.to);
      if (target) referenced.add(target.id);
    }
  }
  const allTerms = [];
  const distinctions = [];
  for (const { clause, terms, refs } of byClause.values()) {
    if (!referenced.has(clause.id)) allTerms.push(...terms);
    for (const ref of refs) {
      const target = clauses.find(row => row.clause === ref.to);
      if (!target || !byClause.has(target.id)) continue;
      for (const term of byClause.get(target.id).terms) {
        allTerms.push({
          ...term,
          conditions: { ...ref.conditions, ...term.conditions },
          via: clause.id,
        });
      }
    }
  }
  const byField = {};
  for (const term of allTerms) {
    if (term.aspect === 'distinction') {
      distinctions.push(term);
      continue;
    }
    if (!term.field) continue;
    byField[term.field] ??= { zh: [], en: [] };
    byField[term.field][term.language].push(term);
  }
  return { byField, distinctions, residues };
}

const GROUP_OF_ASPECT = {
  requirement: 'disposition',
  'value-rule': 'disposition',
  blankMeaning: 'blankMeaning',
  substitution: 'substitution',
  filler: 'filler',
  'explicit-none': 'explicit-none',
  record: 'record',
};

function canonical(term) {
  return JSON.stringify({
    r: term.ruling ?? null,
    c: term.conditions ?? null,
    v: term.value ?? null,
    a: term.actors ? [...term.actors].sort() : null,
    m: term.meaning ?? null,
    t: term.tag ?? null,
  });
}

function conditionsMet(conditions, termConditions) {
  if (!termConditions) return true;
  return Object.entries(termConditions).every(([key, value]) => conditions[key] === value);
}

// 双语对账：同一栏位同一组义务，两种语言说法不一致即冲突。
// 裁决顺序：柜员已确认的解释（限该版次与条件）→ 收件方标明的约束版本 → 暂缓。
export function reconcileFields(byField, form, { confirmations = [], conditions = {}, activeClauseIds = new Set() } = {}) {
  const fields = {};
  const conflicts = [];
  const holds = [];
  for (const field of new Set([...Object.keys(byField), ...form.fields.map(f => f.name)])) {
    const pair = byField[field] ?? { zh: [], en: [] };
    const groups = {};
    const aspects = new Set([...pair.zh, ...pair.en].map(term => GROUP_OF_ASPECT[term.aspect] ?? term.aspect));
    for (const group of aspects) {
      const pick = terms => terms.filter(term => (GROUP_OF_ASPECT[term.aspect] ?? term.aspect) === group);
      const zh = pick(pair.zh);
      const en = pick(pair.en);
      if (zh.length === 0 || en.length === 0) {
        groups[group] = { status: 'single', terms: [...zh, ...en] };
        continue;
      }
      const zhSet = new Set(zh.map(canonical));
      const enSet = new Set(en.map(canonical));
      const agreed = zhSet.size === enSet.size && [...zhSet].every(key => enSet.has(key));
      if (agreed) {
        groups[group] = { status: 'agreed', terms: [...zh, ...en] };
        continue;
      }
      const conflict = { field, group, zh, en };
      const confirmation = confirmations.find(conf =>
        conf.form === form.id
        && conf.field === field
        && conf.group === group
        && conf.clauseIds.every(id => activeClauseIds.has(id))
        && Object.entries(conf.conditions ?? {}).every(([key, value]) => conditions[key] === value)
        && (zh.some(term => conf.clauseIds.includes(term.clause)) || en.some(term => conf.clauseIds.includes(term.clause))));
      if (confirmation) {
        const side = zh.some(term => confirmation.clauseIds.includes(term.clause)) ? zh : en;
        groups[group] = { status: 'confirmed', terms: side, confirmation: confirmation.id };
        conflicts.push({ ...conflict, resolution: `柜员确认 ${confirmation.id}` });
        continue;
      }
      if (form.authority) {
        const side = form.authority === 'zh' ? zh : en;
        groups[group] = { status: 'authority-resolved', terms: side, authority: form.authority };
        conflicts.push({ ...conflict, resolution: `按收件方标明的约束版本（${form.authority}）` });
        continue;
      }
      groups[group] = { status: 'held', zh, en };
      conflicts.push({ ...conflict, resolution: null });
      holds.push({ field, group, zh, en });
    }
    fields[field] = {
      groups,
      held: Object.values(groups).some(group => group.status === 'held'),
      terms: Object.values(groups).flatMap(group => group.terms ?? []),
    };
  }
  return { fields, conflicts, holds };
}

export { conditionsMet };
