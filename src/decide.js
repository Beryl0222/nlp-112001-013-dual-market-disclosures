// 比对决策：把事实按主张聚成等价组，跨出稿地比较，给出
// 共同引用 / 按各地口径发布 / 不可对照 / 暂缓（待确认）的结论及理由。

// 同地等价组：同一出稿地、主体、期间、主题且金额可互认的正文与表行。
// 主题未指明的记录单独成组，留给暂定对应，不并入任何主张。
export function groupClaims(facts) {
  const groups = [];
  const sorted = [...facts].sort((a, b) => (a.carrier === '正文' ? -1 : 1) - (b.carrier === '正文' ? -1 : 1));
  for (const fact of sorted) {
    const amount = fact.amounts[0] ?? null;
    const group = groups.find(g =>
      g.market === fact.market &&
      g.entity === fact.entity &&
      g.period === fact.period &&
      g.subject === fact.subject &&
      amountsCompatible(g.amount, amount));
    if (group) {
      group.members.push(fact);
      mergeGroup(group, fact);
    } else {
      groups.push({
        id: `C${groups.length + 1}`,
        market: fact.market,
        entity: fact.entity,
        period: fact.period,
        subject: fact.subject,
        amount,
        direction: fact.direction,
        policy: fact.policy,
        kinds: [...fact.kinds],
        members: [fact],
      });
    }
  }
  return groups;
}

function mergeGroup(group, fact) {
  group.direction ??= fact.direction;
  group.policy ??= fact.policy;
  for (const kind of fact.kinds) {
    if (!group.kinds.includes(kind)) group.kinds.push(kind);
  }
}

function amountsCompatible(a, b) {
  if (!a || !b) return true; // 一方无金额时不拆组，由比对阶段处理
  if (!a.unitInfo.defined || !b.unitInfo.defined) return false;
  return a.value === b.value && a.unitInfo.currency === b.unitInfo.currency;
}

// 跨地比对。approvals.conversions 为财务批准的换算说明（可空）。
// 第一遍按相同主题配对；第二遍把主题未指明的组与条件相符的组暂定对应。
export function compareMarkets(analysis, approvals = { conversions: [] }) {
  const groups = groupClaims(analysis.facts);
  const decisions = [];
  let seq = 0;

  const markets = [...new Set(groups.map(g => g.market))];

  for (const left of groups) {
    if (left.subject === null) continue;
    for (const right of groups) {
      if (markets.indexOf(left.market) >= markets.indexOf(right.market)) continue;
      if (right.subject === null || right.subject !== left.subject) continue;
      seq += 1;
      decisions.push(decidePair(`D${seq}`, left, right, approvals, false));
    }
  }

  for (const orphan of groups.filter(g => g.subject === null)) {
    const candidates = groups.filter(g =>
      g.market !== orphan.market &&
      g.subject !== null &&
      g.entity === orphan.entity &&
      g.period === orphan.period);
    for (const candidate of candidates) {
      seq += 1;
      decisions.push(decidePair(`D${seq}`, orphan, candidate, approvals, true));
    }
  }

  return { groups, decisions };
}

function decidePair(id, left, right, approvals, tentative) {
  const semanticDifferences = [];
  const conditions = [];
  const reasons = [];
  let qualitative;
  let numeric = null;
  const blockedLocalPublish = false;

  if (left.entity !== right.entity) {
    qualitative = '按各地口径发布';
    semanticDifferences.push(`报表主体不同：${left.market}为${left.entity}、${right.market}为${right.entity}`);
    reasons.push('报表主体不同，不能共同引用，各自按本地口径发布');
  } else if (left.period !== right.period) {
    qualitative = '不可对照';
    semanticDifferences.push(`所属期间不同：${left.period} 与 ${right.period}`);
    reasons.push('金额所属期间不同，不能拼接为同一期间的对照');
  } else if (conflicts(left.direction, right.direction) || conflicts(left.policy, right.policy)) {
    qualitative = '不可对照';
    if (conflicts(left.direction, right.direction)) {
      semanticDifferences.push(`确认时点不同：${left.direction ?? '未明'} 与 ${right.direction ?? '未明'}`);
    }
    if (conflicts(left.policy, right.policy)) {
      semanticDifferences.push(`政策基础不同：${left.policy ?? '未明'} 与 ${right.policy ?? '未明'}`);
    }
    reasons.push('术语表面相同但陈述性质不同（本期事实 / 未来计划 / 政策说明），不能签为等义；不阻断本地发布');
  } else {
    qualitative = '共同引用';
    conditions.push('共同引用时保留各自单位与币种表述');
    if (!left.policy || !right.policy) {
      conditions.push('一侧未载明政策口径，共同引用时以正文政策说明为准');
    }
  }

  if (tentative && qualitative === '共同引用') {
    qualitative = '暂缓';
    numeric = '暂缓';
    reasons.push('一侧未指明主张主题，对应关系只能暂定，待人工确认后方可共同引用');
  }

  // 数值层面
  const la = left.amount;
  const ra = right.amount;
  if (qualitative === '共同引用' && la && ra) {
    if (!la.unitInfo.defined || !ra.unitInfo.defined) {
      numeric = '暂缓';
      reasons.push('存在未定义单位，数值比较暂缓，待人工确认');
    } else if (la.unitInfo.currency === ra.unitInfo.currency) {
      numeric = '共同引用';
      if (!(la.value === ra.value)) {
        semanticDifferences.push(`同币种数值不同：${la.raw} 与 ${ra.raw}`);
      }
    } else {
      const conversion = findConversion(approvals, la.unitInfo.currency, ra.unitInfo.currency);
      const sameScope = left.entity === right.entity;
      if (conversion && sameScope && left.entity === (conversion.scope ?? left.entity)) {
        numeric = '共同引用';
        conditions.push(`按已批准换算说明（${conversion.conditions}）折算，适用范围：${conversion.scope}`);
      } else if (conversion && !sameScope) {
        numeric = '暂缓';
        reasons.push('换算说明已批准，但两份报表不属于同一合并范围，摘要数值不可复用');
      } else {
        numeric = '暂缓';
        reasons.push(`币种不同（${la.unitInfo.currency} 与 ${ra.unitInfo.currency}），未见财务批准且附适用条件的换算说明，比较数值暂不发布`);
      }
    }
  } else if (qualitative !== '共同引用' && numeric === null) {
    numeric = '不可对照';
  }

  const superseded = [...left.members, ...right.members].filter(m => m.correction?.status === '被更正取代');
  if (superseded.length > 0) {
    reasons.push(`成员 ${superseded.map(m => m.ref.id).join('、')} 已被更正取代，共同摘要引用前须重审`);
  }
  // 仅当本可共同引用时，更正取代才把结论降为须重审；期间/主体冲突优先。
  const downgraded = superseded.length > 0 && qualitative === '共同引用';

  return {
    id,
    pair: [left.id, right.id],
    members: {
      [left.market]: left.members.map(m => m.ref.id),
      [right.market]: right.members.map(m => m.ref.id),
    },
    subject: left.subject ?? right.subject ?? null,
    tentative,
    qualitative,
    numeric,
    decision: downgraded ? '须重审（成员被更正取代）'
      : qualitative === '共同引用' && numeric !== '暂缓' ? '共同引用'
      : qualitative === '共同引用' ? '定性共同引用，数值暂缓'
      : qualitative,
    semanticDifferences,
    conditions,
    reasons,
    blockedLocalPublish,
    unpublishedNumeric: numeric === '暂缓' || numeric === '不可对照'
      ? { left: la?.raw ?? null, right: ra?.raw ?? null, reason: reasons[reasons.length - 1] ?? null }
      : null,
    evidence: [
      ...left.members.map(m => m.evidence),
      ...right.members.map(m => m.evidence),
    ],
  };
}

// 双方都明确主张且互不相同才算冲突；一侧未载明时不据此判异。
function conflicts(a, b) {
  if (!a || !b) return false;
  return a !== b;
}

function findConversion(approvals, currencyA, currencyB) {
  return (approvals.conversions ?? []).find(c =>
    (c.fromCurrency === currencyA && c.toCurrency === currencyB) ||
    (c.fromCurrency === currencyB && c.toCurrency === currencyA));
}

// 共同摘要校验：从句子、表格、脚注选取的内容必须仍属同一期间、同一合并范围，
// 不得引用被更正取代的重列前数字；数值复用另需换算说明覆盖同一合并范围。
// 违例分级：阻断（摘要不可复用）/ 数值暂缓（定性可发，数值暂缓）。
export function validateSummary(selectionIds, analysis, approvals = { conversions: [] }) {
  const selected = analysis.facts.filter(f => selectionIds.includes(f.ref.id));
  const missing = selectionIds.filter(id => !analysis.facts.some(f => f.ref.id === id));
  const violations = [];
  const block = (rule, detail, ids) => violations.push({ level: '阻断', rule, detail, ids });
  const hold = (rule, detail, ids) => violations.push({ level: '数值暂缓', rule, detail, ids });

  for (const id of missing) {
    block('资料缺失', `所选 ${id} 不在资料中`, [id]);
  }

  const periods = new Set(selected.map(f => f.period));
  if (periods.size > 1) {
    block('期间一致',
      `摘要选取内容横跨 ${[...periods].join('、')} 多个期间，不能把当前说明与其他期间的数字拼接`,
      selected.map(f => f.ref.id));
  }

  const entities = new Set(selected.map(f => f.entity));
  if (entities.size > 1) {
    block('合并范围一致',
      `摘要混排了 ${[...entities].join(' 与 ')} 不同报表主体，不属于同一合并范围`,
      selected.map(f => f.ref.id));
  }

  for (const fact of selected) {
    if (fact.correction?.status === '被更正取代') {
      block('不用重列前数字',
        `${fact.ref.id} 已被 ${fact.correction.by} 更正（应为 ${fact.correction.correctedAmount?.raw}），摘要不得引用重列前数值`,
        [fact.ref.id]);
    }
  }

  // 共享脚注：适用范围变化后，逐行重核，不允许整页兜底。
  for (const scope of analysis.footnoteScopes) {
    if (scope.blanketSignoffValid) continue;
    const picked = scope.rows.filter(row => selectionIds.includes(row.id));
    if (picked.length > 0 && picked.some(row => row.status === '需更新')) {
      block('脚注逐行重核',
        `脚注${scope.notice}的适用范围已被 ${scope.scopeChangedBy.join('、')} 改变，共享该脚注的行须逐行重核，不能靠已签署行为整页兜底`,
        picked.map(row => row.id));
    }
  }

  // 数值复用：跨币种时须有批准的换算说明，且所选均属同一合并范围。
  const currencies = new Set();
  for (const fact of selected) {
    for (const amount of fact.amounts) {
      if (amount.unitInfo.defined && amount.unitInfo.currency) currencies.add(amount.unitInfo.currency);
    }
  }
  if (currencies.size > 1) {
    const list = [...currencies];
    const conversion = findConversion(approvals, list[0], list[1]);
    if (!conversion) {
      hold('换算说明', '摘要跨币种复用数值，但无财务批准且附适用条件的换算说明', selected.map(f => f.ref.id));
    } else if (![...entities].every(entity => entity === (conversion.scope ?? entity))) {
      hold('合并范围一致',
        `换算说明仅适用于${conversion.scope}口径，所选内容不全属于该合并范围，数值不可复用`,
        selected.map(f => f.ref.id));
    }
  }

  const blocked = violations.some(v => v.level === '阻断');
  const held = violations.some(v => v.level === '数值暂缓');
  return {
    selection: selectionIds,
    periods: [...periods],
    entities: [...entities],
    violations,
    qualitativeReusable: !blocked,
    numericReusable: !blocked && !held,
    reusable: !blocked && !held,
  };
}
