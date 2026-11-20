// 案件装配：说明义务 + 草稿事实 + 柜员确认 → 每个栏位的填写状态。
// 状态区分：answered 已回答 / explicit-none 明确没有 / exempt 按条件无需填写
//          / unanswered 未回答 / unauthorized 无权填写 / ambiguous 多义 / held 暂缓。

import { effectiveClauses, extractFieldTerms, reconcileFields, conditionsMet } from './clauses.mjs';
import { extractFacts, reduceConditions, effectiveFacts } from './facts.mjs';

const CASE_ROLES = ['货主', '代办方', '联系人', '窗口'];

const GROUP_NAMES = {
  disposition: '义务/例外',
  blankMeaning: '空值含义',
  substitution: '可否代用',
  filler: '允许补答的人',
  'explicit-none': '明确没有',
  record: '记录保留',
};

function rolesOf(participants, actorId) {
  const found = participants.find(p => p.id === actorId);
  return (found?.roles ?? []).filter(role => CASE_ROLES.includes(role));
}

function labelOf(participants, actorId) {
  return participants.find(p => p.id === actorId)?.label ?? actorId;
}

// 栏位是否允许空值（OMIT 或空串）。
export function allowsEmpty(fieldDef) {
  return fieldDef.values.includes('OMIT') || fieldDef.values.includes('空串');
}

// 值域检查：条件填法产出的值须落在收件样式的已登记值域内。
function valueRuleFits(term, fieldDef) {
  return fieldDef.values.some(value => value === term.value || value.includes(term.value) || term.value.includes(value));
}

function actorLabels(actors, caseParties) {
  return actors.map(actor => {
    if (actor === '货主本人') return `${caseParties.ownerLabel}（本人）`;
    if (actor === '货主') return caseParties.ownerLabel;
    if (actor === '代办方') return caseParties.agentLabel ?? '代办方';
    if (actor === '联系人') return caseParties.contactLabel ?? '联系人';
    return actor;
  }).join('、');
}

export function buildCase({ bundle, caseId, edition, confirmations = [], drafts = null }) {
  const caseDrafts = drafts ?? bundle.drafts.filter(row => row.caseId === caseId);
  if (caseDrafts.length === 0) throw new Error(`案件 ${caseId} 没有草稿`);
  const form = bundle.forms.find(row => row.id === caseDrafts[0].form);
  const participants = bundle.participants;
  const clauses = effectiveClauses(bundle.instructions, form.id, edition);
  const activeClauseIds = new Set(clauses.map(row => row.id));
  const { byField, distinctions, residues: clauseResidues } = extractFieldTerms(clauses, form);

  const extracted = caseDrafts.map(draft => extractFacts(draft, { form, participants }));
  const rawFacts = extracted.flatMap(out => out.facts);
  const factResidues = extracted.flatMap(out => out.residues);
  const facts = effectiveFacts(rawFacts);
  const { conditions } = reduceConditions(facts);

  const ownerId = caseDrafts.find(draft => draft.kind === '自述')?.actor ?? caseDrafts[0].actor;
  const agentId = caseDrafts.find(draft => draft.kind === '代答')?.actor
    ?? rawFacts.find(fact => fact.agent)?.agent
    ?? null;
  const contactId = participants.find(p => p.id !== agentId && p.roles.includes('联系人') && [ownerId, agentId].includes(p.id))?.id ?? null;
  const caseParties = {
    owner: ownerId,
    ownerLabel: labelOf(participants, ownerId),
    agent: agentId,
    agentLabel: agentId ? labelOf(participants, agentId) : null,
    contact: contactId,
    contactLabel: contactId ? labelOf(participants, contactId) : null,
    recipient: form.partner,
  };

  const validConfirmations = confirmations.filter(conf => conf.form === form.id);
  const reconciled = reconcileFields(byField, form, { confirmations: validConfirmations, conditions, activeClauseIds });

  const confirmationStates = validConfirmations.map(conf => {
    const clauseOk = conf.clauseIds.every(id => activeClauseIds.has(id));
    const conditionMisses = Object.entries(conf.conditions ?? {}).filter(([key, value]) => conditions[key] !== value);
    return {
      id: conf.id,
      field: conf.field,
      applies: clauseOk && conditionMisses.length === 0,
      reason: !clauseOk ? '说明版本已变' : (conditionMisses.length > 0 ? `条件已变（${conditionMisses.map(([key]) => key).join('、')}）` : null),
    };
  });

  const fields = [];
  const followUps = [];
  const collisions = [];

  for (const fieldDef of form.fields) {
    const name = fieldDef.name;
    const rec = reconciled.fields[name];
    const notes = [];
    const trace = { drafts: [], clauses: [] };

    // 义务冲突未决即暂缓；空值含义冲突只在真会留空时才改变填法（实值不受影响）。
    const heldGroups = rec ? Object.entries(rec.groups).filter(([, g]) => g.status === 'held') : [];
    const hardHeld = heldGroups.find(([groupName]) => groupName !== 'blankMeaning');
    const softBlankHeld = heldGroups.find(([groupName]) => groupName === 'blankMeaning')?.[1] ?? null;
    if (hardHeld) {
      const [groupName, held] = hardHeld;
      const describe = terms => terms.map(term => `${term.clause}「${term.sentence}」`).join('；');
      fields.push({
        name,
        status: 'held',
        recipient: null,
        notes: [`两种文本对${name}的${GROUP_NAMES[groupName] ?? groupName}要求不一致，收件方未标明约束版本`],
        trace,
        followUp: null,
      });
      followUps.push({
        field: name,
        who: '柜员',
        what: `依据原文确认 ${name} 的填法（zh：${describe(held.zh)}；en：${describe(held.en)}）`,
      });
      continue;
    }

    const terms = (rec?.terms ?? []).filter(term => conditionsMet(conditions, term.conditions));
    // 条件填法若与收件值域不符则不采用（如把站点代码填进联系方式栏）。
    const usableTerms = terms.filter(term => {
      if (term.aspect !== 'value-rule') return true;
      const fits = valueRuleFits(term, fieldDef);
      if (!fits) notes.push(`${term.clause} 的填法「${term.value}」与栏位 ${name} 的已登记值域不符，未采用`);
      return fits;
    });
    const exemptTerm = usableTerms.find(term => term.aspect === 'requirement' && term.ruling === 'exempt');
    const fillerTerms = usableTerms.filter(term => term.aspect === 'filler');
    const explicitNoneTerm = usableTerms.find(term => term.aspect === 'explicit-none');
    const recordTerm = usableTerms.find(term => term.aspect === 'record');
    const restrictions = facts.filter(fact => fact.kind === 'restriction' && fact.field === name);
    for (const restriction of restrictions) {
      notes.push(`${restriction.note ?? '填写人受限'}（${restriction.source}）`);
      trace.drafts.push(restriction.source);
    }

    const answers = facts.filter(fact =>
      (fact.kind === 'answer' || fact.kind === 'candidate') && fact.field === name);
    const joints = facts.filter(fact => fact.kind === 'joint' && fact.fields.includes(name));

    let current = null;
    for (const fact of answers) {
      const roles = rolesOf(participants, fact.actor);
      const traceOf = () => {
        trace.drafts.push(fact.source);
      };
      // 多义候选：几种语义都说得通，不能选定。
      if (fact.ambiguous) {
        current = {
          status: 'ambiguous',
          value: fact.value,
          notes: [`${fact.value} 多义（${fact.ambiguous.join('／')}），来源${fact.medium ?? '草稿'} ${fact.source}`],
        };
        traceOf();
        continue;
      }
      // 代用禁止：如以代办方代码冒充货主代码。
      const ban = usableTerms.find(term => term.aspect === 'substitution' && term.ruling === 'forbidden'
        && ((term.tag === 'agent-own-code' && fact.role === '代办方代码')));
      if (ban) {
        notes.push(`${fact.source} 提供的 ${fact.value} 是${fact.role}，不得代用（${ban.clause}）`);
        traceOf();
        trace.clauses.push(ban.clause);
        continue;
      }
      // 来源受限的代用（如柜员只能抄自签署陈述）。
      if (fact.medium) {
        const limited = usableTerms.find(term => term.aspect === 'substitution' && term.medium && term.medium !== fact.medium);
        if (limited) notes.push(`${fact.source} 的 ${fact.value} 取自${fact.medium}，非${limited.medium}，不可照抄（${limited.clause}）`);
      }
      if (fact.state === 'explicit-none') {
        if (fieldDef.values.includes('NONE')) {
          if (explicitNoneTerm && conditionsMet(conditions, explicitNoneTerm.conditions ?? {})) {
            current = { status: 'explicit-none', value: 'NONE', note: `代办方据货主书面确认补填“无”（${explicitNoneTerm.clause}）` };
            traceOf();
            trace.clauses.push(explicitNoneTerm.clause);
          } else {
            current = { status: 'explicit-none-pending', notes: ['货主未获代码尚需书面证明'] };
            traceOf();
          }
        } else {
          current = { status: 'explicit-none', value: null, note: '收件格式无法表示“无”，只能留空' };
          traceOf();
          if (recordTerm) {
            notes.push(`按 ${recordTerm.clause}，未登记声明保留在提交记录（${fact.source}）`);
            trace.clauses.push(recordTerm.clause);
          }
        }
        continue;
      }
      if (fact.state === 'unanswered-declared') {
        current = { status: 'unanswered', explicit: true };
        traceOf();
        continue;
      }
      // 普通值：核对填写人是否获准。
      const allowedByFiller = fillerTerms.length === 0
        || fillerTerms.some(term => term.actors.some(actor => roles.includes(actor)));
      const allowedByRestriction = restrictions.length === 0
        || restrictions.some(restriction => restriction.actors.some(actor =>
          (actor === '货主本人' && fact.actor === ownerId) || roles.includes(actor)));
      if (!allowedByFiller || !allowedByRestriction) {
        const who = actorLabels(
          restrictions.length > 0 ? restrictions.flatMap(r => r.actors) : fillerTerms.flatMap(t => t.actors),
          caseParties,
        );
        current = { status: 'unauthorized', notes: [`${labelOf(participants, fact.actor)} 无权填写 ${name}，须由 ${who} 填写`] };
        traceOf();
        continue;
      }
      current = { status: 'answered', value: fact.value };
      traceOf();
      const valueRule = usableTerms.find(term => term.aspect === 'value-rule');
      if (valueRule) trace.clauses.push(valueRule.clause);
    }

    let state;
    if (current) {
      state = { name, ...current, notes: [...(current.notes ?? []), ...notes] };
      if (current.note) state.notes.unshift(current.note);
    } else if (exemptTerm) {
      state = { name, status: 'exempt', notes: [...notes] };
      trace.clauses.push(exemptTerm.clause);
    } else {
      const required = !allowsEmpty(fieldDef) || fillerTerms.length > 0 || usableTerms.some(term => term.aspect === 'value-rule');
      state = { name, status: 'unanswered', required, notes: [...notes] };
    }

    // 联合答复：一段原话覆盖多个栏位，不拆开臆造值。
    for (const joint of joints) {
      if (state.status === 'answered') continue;
      state.notes.push(`原答复（${joint.source}）同时涉及 ${joint.fields.join('、')}，由 ${joint.delegate} 经手，不可拆分臆造`);
      trace.drafts.push(joint.source);
      state.followUp = {
        field: name,
        who: caseParties.ownerLabel,
        what: `分别说明 ${joint.fields.join('、')}（原答复不可拆分）`,
      };
    }

    // 空值含义冲突未决且本栏位将留空：暂缓；实值则填法不受影响，仅注明。
    if (softBlankHeld) {
      const preview = (state.status === 'unanswered' && state.required) ? null : recipientOf(state, fieldDef, form);
      if (!preview || preview.kind !== 'value') {
        const describe = terms => terms.map(term => `${term.clause}「${term.sentence}」`).join('；');
        state.status = 'held';
        state.notes.push(`两种文本对${name}的空值含义要求不一致，收件方未标明约束版本`);
        state.followUp = {
          field: name,
          who: '柜员',
          what: `依据原文确认 ${name} 的空值含义（zh：${describe(softBlankHeld.zh)}；en：${describe(softBlankHeld.en)}）`,
        };
      } else {
        state.notes.push('空值含义两种文本未决；本栏位为实值，填法不受影响');
      }
    }

    // 追问：说清由谁补什么。
    if (!state.followUp) {
      if (state.status === 'unanswered' && state.required) {
        const actors = restrictions.length > 0
          ? restrictions.flatMap(restriction => restriction.actors)
          : (fillerTerms.length > 0 ? [...new Set(fillerTerms.flatMap(t => t.actors))] : null);
        const who = actors ? actorLabels(actors, caseParties) : caseParties.ownerLabel;
        state.followUp = { field: name, who, what: `补答 ${name}` };
      } else if (state.status === 'ambiguous') {
        state.followUp = { field: name, who: caseParties.ownerLabel, what: `澄清 ${state.value} 的含义` };
      } else if (state.status === 'explicit-none-pending') {
        state.followUp = { field: name, who: caseParties.ownerLabel, what: '出具未获代码的书面证明' };
      } else if (state.status === 'unauthorized') {
        state.followUp = { field: name, who: '相应填写人', what: `由获准者本人填写 ${name}` };
      }
    }
    if (state.followUp) followUps.push(state.followUp);
    // 收件映射（必填而未答的栏位不可生成收件值，保持暂缓）。
    state.recipient = (state.status === 'unanswered' && state.required) ? null : recipientOf(state, fieldDef, form);
    state.trace = { drafts: [...new Set(trace.drafts)], clauses: [...new Set(trace.clauses)] };
    fields.push(state);

    // 空值含义冲突：两种有效状态在对方格式中含义相同。
    const collision = collisionOf(state, fieldDef, form, caseParties);
    if (collision) collisions.push(collision);
  }

  const blocked = fields.some(field =>
    field.status === 'held'
    || field.status === 'ambiguous'
    || field.status === 'unauthorized'
    || field.status === 'explicit-none-pending'
    || (field.status === 'unanswered' && field.required));

  const seenFollowUps = new Set();
  const uniqueFollowUps = followUps.filter(followUp => {
    const key = `${followUp.who}｜${followUp.what}`;
    if (seenFollowUps.has(key)) return false;
    seenFollowUps.add(key);
    return true;
  });

  return {
    caseId,
    form,
    edition,
    clauses: clauses.map(row => row.id),
    participants: caseParties,
    conditions,
    fields,
    conflicts: reconciled.conflicts,
    holds: reconciled.holds,
    followUps: uniqueFollowUps,
    collisions,
    confirmationStates,
    distinctions,
    residues: [...clauseResidues, ...factResidues],
    blocked,
  };
}

const STATE_MEANING = {
  answered: '申报值',
  'explicit-none': '明确没有',
  exempt: '按条件无需填写',
  unanswered: '未回答',
};

function recipientOf(state, fieldDef, form) {
  const isJson = form.format.startsWith('JSON');
  switch (state.status) {
    case 'answered':
      return { kind: 'value', value: state.value };
    case 'explicit-none':
      if (state.value === 'NONE') return { kind: 'value', value: 'NONE' };
      return isJson ? { kind: 'omit' } : { kind: 'empty' };
    case 'exempt':
    case 'unanswered':
      return isJson ? { kind: 'omit' } : { kind: 'empty' };
    default:
      return null;
  }
}

// 判断真实状态经收件格式表达后是否丢失区分。
function collisionOf(state, fieldDef, form, caseParties) {
  if (!state.recipient || state.recipient.kind === 'value') return null;
  const trueMeaning = STATE_MEANING[state.status];
  if (!trueMeaning) return null;
  const seen = state.recipient.kind === 'omit'
    ? '键省略（OMIT）'
    : `空串（${fieldDef.emptyMeans ?? '未提供'}）`;
  // 明确没有 → 未提供：丢失“明确没有”与“未回答”之分。
  if (state.status === 'explicit-none') {
    return {
      field: state.name,
      lost: `「明确没有」在收件格式中与「未回答」同为${seen}`,
      party: caseParties.ownerLabel,
      detail: `需 ${caseParties.ownerLabel} 澄清时以提交记录中的原话为准`,
    };
  }
  // 按条件无需填写 → 与未回答同形。
  if (state.status === 'exempt') {
    return {
      field: state.name,
      lost: `「按条件无需填写」在收件格式中与「未回答」同为${seen}`,
      party: '柜员',
      detail: '依据已在预览溯源中注明，收件方如在意区分可查提交记录',
    };
  }
  // 未回答 → 不适用：含义被改写。
  if (state.status === 'unanswered' && state.recipient.kind === 'empty' && fieldDef.emptyMeans === '不适用') {
    return {
      field: state.name,
      lost: `「未回答」在收件格式中显示为${seen}`,
      party: caseParties.ownerLabel,
      detail: `需 ${caseParties.ownerLabel} 补答或确认确实不适用`,
    };
  }
  return null;
}

export { STATE_MEANING };
