// 签发：生成申报件并留档。已有交接记录的案件只许以关联原件的更正件重办。

import { buildCase } from './casefile.mjs';
import { buildPayload, renderView, verifyReceipt } from './preview.mjs';
import { appendReceipt, findReceipt, nextReceiptId, receiptsForCase } from './store.mjs';

export function issueCase({ bundle, dataDir, caseId, edition, confirmations = [], corrects = null, now = () => new Date() }) {
  const caseFile = buildCase({ bundle, caseId, edition, confirmations });
  const prior = receiptsForCase(dataDir, caseId);
  if (prior.length > 0 && !corrects) {
    throw new Error(`案件 ${caseId} 已有交接记录（${prior.map(row => row.id).join('、')}），重办须指明原件号`);
  }
  if (corrects) {
    const original = findReceipt(dataDir, corrects);
    if (!original) throw new Error(`找不到原件 ${corrects}`);
    if (original.caseId !== caseId) throw new Error(`原件 ${corrects} 属于案件 ${original.caseId}，不能更正到 ${caseId}`);
  }
  if (caseFile.blocked) {
    const reasons = caseFile.fields
      .filter(field => field.status === 'held' || field.status === 'ambiguous' || field.status === 'unauthorized'
        || field.status === 'explicit-none-pending' || (field.status === 'unanswered' && field.required))
      .map(field => field.name);
    const error = new Error(`存在暂缓栏位（${reasons.join('、')}），申报件未签发；草稿保留，可继续办理`);
    error.caseFile = caseFile;
    throw error;
  }
  const receipt = {
    id: nextReceiptId(dataDir),
    caseId,
    form: caseFile.form.id,
    edition,
    sentAt: now().toISOString(),
    drafts: bundle.drafts.filter(row => row.caseId === caseId).map(row => row.id),
    payloadText: buildPayload(caseFile),
    viewText: renderView(caseFile, { corrects }),
  };
  appendReceipt(dataDir, receipt);
  const check = verifyReceipt(receipt, caseFile.form);
  if (!check.ok) throw new Error(`签发后核对失败：${check.reason}`);
  return { receipt, caseFile };
}
