// 报告与审计轨迹：每个结论都挂证据（资料名、记录编号、文本范围），供审阅人回查。

const KIND_ORDER = ['本期事实', '以前期间重列', '政策说明', '未来计划', '列报数据'];

function formatFact(fact) {
  const bits = [
    `[${fact.market}|${fact.entity}|${fact.period}]`,
    fact.kinds.length > 0 ? fact.kinds.sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b)).join('·') : '未分类',
  ];
  if (fact.direction && fact.direction !== '列报') bits.push(`方向=${fact.direction}`);
  if (fact.policy) bits.push(`政策=${fact.policy}`);
  for (const amount of fact.amounts) {
    bits.push(`金额=${amount.raw}（${amount.period}，${amount.unitInfo.defined ? amount.unitInfo.label : '单位未定义'}）`);
  }
  if (fact.correction) bits.push(`更正=${fact.correction.status}${fact.correction.correctedAmount ? `→${fact.correction.correctedAmount.raw}` : ''}`);
  return `- ${fact.ref.id} ${bits.join('；')}`;
}

function formatEvidence(evidence) {
  const spans = (evidence.spans ?? []).map(s => `“${s.quote}”@${s.start}-${s.end}`).join('，');
  return `  证据：${evidence.file}#${evidence.id}${spans ? ` ${spans}` : ''}`;
}

export function buildAudit(analysis, comparison, summaryChecks, inputs) {
  return {
    generatedAt: new Date().toISOString(),
    inputs,
    facts: analysis.facts.map(f => ({
      ref: f.ref,
      market: f.market,
      entity: f.entity,
      period: f.period,
      carrier: f.carrier,
      kinds: f.kinds,
      direction: f.direction,
      policy: f.policy,
      subject: f.subject,
      amounts: f.amounts.map(a => ({
        raw: a.raw,
        value: a.value,
        unit: a.unit,
        unitDefined: a.unitInfo.defined,
        currency: a.unitInfo.currency,
        period: a.period,
        span: a.span,
      })),
      refs: f.refs,
      correction: f.correction ?? null,
      evidence: f.evidence,
    })),
    claimGroups: comparison.groups.map(g => ({
      id: g.id,
      market: g.market,
      entity: g.entity,
      period: g.period,
      subject: g.subject,
      direction: g.direction,
      policy: g.policy,
      members: g.members.map(m => m.ref.id),
    })),
    decisions: comparison.decisions,
    corrections: analysis.corrections,
    footnoteScopes: analysis.footnoteScopes,
    gaps: analysis.gaps,
    terms: analysis.terms,
    summaryValidations: summaryChecks,
    unpublishedComparisons: comparison.decisions
      .filter(d => d.unpublishedNumeric)
      .map(d => ({ decision: d.id, pair: d.members, ...d.unpublishedNumeric })),
  };
}

export function renderReport(analysis, comparison, summaryChecks, auditPath) {
  const lines = [];
  const push = (...xs) => lines.push(...xs);

  push('双地财报比对报告', '='.repeat(40), '');

  push('一、陈述分类与金额要素（期间 / 主体 / 单位 / 方向）');
  for (const fact of analysis.facts) {
    push(formatFact(fact));
    if (fact.text) push(`    “${fact.text}”`);
  }
  push('');

  push('二、跨地比对决定（共同引用 / 按各地口径 / 不可对照 / 暂缓）');
  for (const decision of comparison.decisions) {
    const pair = Object.entries(decision.members).map(([market, ids]) => `${market}:${ids.join('+')}`).join(' × ');
    push(`- ${decision.id} ${pair} → ${decision.decision}${decision.blockedLocalPublish ? '（阻断本地发布）' : '（不阻断本地发布）'}`);
    for (const diff of decision.semanticDifferences) push(`  语义差异：${diff}`);
    for (const reason of decision.reasons) push(`  理由：${reason}`);
    for (const cond of decision.conditions) push(`  条件：${cond}`);
    for (const evidence of decision.evidence.slice(0, 4)) push(formatEvidence(evidence));
  }
  push('');

  push('三、更正与重列的影响');
  for (const correction of analysis.corrections) {
    push(`- ${correction.ref.id}（${correction.market}）：${correction.text}`);
    for (const target of correction.targets) {
      push(`  更正对象：${target.entity ?? '?'} ${target.period ?? '?'} → ${target.correctedAmount.raw}`);
    }
  }
  const superseded = analysis.facts.filter(f => f.correction?.status === '被更正取代');
  const exempt = analysis.facts.filter(f => f.correction?.status === '更正明确不影响');
  push(`- 本地发布：${exempt.map(f => f.ref.id).join('、') || '（无）'} 不受更正影响，可按本地口径发布`);
  push(`- 须更新或附更正：${superseded.map(f => `${f.ref.id}（重列前 ${f.amounts[0]?.raw}）`).join('、') || '（无）'}`);
  push('- 共同摘要：凡引用被取代行的摘要须重审，禁止把当前说明与重列前数字拼接');
  push('');

  push('四、脚注适用范围（共享脚注逐行重核）');
  for (const scope of analysis.footnoteScopes) {
    push(`- 脚注${scope.notice}（${scope.market}）覆盖行：${scope.rows.map(r => `${r.id}[${r.period}|${r.status}]`).join('、') || '（无）'}`);
    for (const clause of scope.clauseCoverage) {
      push(`  句“${clause.sentence}” → 适用行：${clause.rows.join('、') || '（无）'}`);
    }
    if (!scope.blanketSignoffValid) {
      push(`  适用范围已被 ${scope.scopeChangedBy.join('、')} 改变：任一行已签署不能为整页兜底，须逐行重核`);
    }
  }
  push('');

  push('五、缺口（定位供人工确认）');
  for (const gap of analysis.gaps) {
    const where = gap.where ? `（${gap.where.file}#${gap.where.id}）` : '';
    push(`- ${gap.id} [${gap.kind}]${where} ${gap.detail}`);
  }
  push('');

  push('六、双语术语对照（术语相同不等于语义等义）');
  for (const term of analysis.terms) {
    push(`- ${term.term}：${term.aligned ? '用法一致' : '不一致，不可签等义'}`);
    push(`  中文用例：${term.zhUsage.join('、') || '（无）'}；其他用例：${term.enUsage.map(u => typeof u === 'string' ? u : `${u.id}(${u.sense})`).join('、') || '（无）'}`);
    push(`  说明：${term.note}`);
  }
  push('');

  push('七、共同摘要校验');
  for (const check of summaryChecks) {
    const verdict = check.reusable ? '可复用'
      : check.qualitativeReusable ? '定性可复用，数值暂缓'
      : '不可复用';
    push(`- ${check.name ?? '校验'}：选取 ${check.selection.join('、') || '（空）'} → ${verdict}`);
    for (const violation of check.violations) {
      push(`  [${violation.level}|${violation.rule}] ${violation.detail}`);
    }
  }
  push('');

  if (auditPath) push(`审计轨迹（证据、语义差异、未发布比较数值的原因）：${auditPath}`);
  return `${lines.join('\n')}\n`;
}
