// 把三类资料归一化为事实、更正、脚注适用范围与缺口清单。
import {
  MARKET_CURRENCY,
  UNITS,
  extractAmounts,
  extractRefs,
  findCueSpans,
  findDirections,
  findEntities,
  findKinds,
  findPolicies,
  findPeriodShift,
  findSubjects,
  sentenceAt,
  DIRECTION_CUES,
  ENTITY_CUES,
  KIND_CUES,
  POLICY_CUES,
} from './lexicon.js';

const FILE_TEXT = '正文.json';
const FILE_ROWS = '表行.json';
const FILE_NOTES = '脚注与通告.json';

const shiftPeriod = (period, shift) => String(Number(period) + shift);

// 各出稿地的“本期”：取该地正文与表行中出现的最大年度。
function marketCurrentPeriods(tables) {
  const periods = {};
  for (const record of [...tables[FILE_TEXT], ...tables[FILE_ROWS]]) {
    const current = periods[record.market];
    if (current === undefined || Number(record.period) > Number(current)) {
      periods[record.market] = record.period;
    }
  }
  return periods;
}

function evidenceOf(file, record, spans = []) {
  const text = record.text ?? '';
  const seen = new Set();
  const unique = [];
  for (const [start, end] of spans) {
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ start, end, quote: text.slice(start, end) });
  }
  return { file, id: record.id, spans: unique };
}

function analyzeTextRecord(record, currentPeriods) {
  const kinds = findKinds(record.text);
  const directions = findDirections(record.text);
  const policies = findPolicies(record.text);
  const subjects = findSubjects(record.text);
  const amounts = extractAmounts(record.text, record.market).map(amount => {
    // 金额期间按所在句的期间词确定，邻句的“上年/比较期”不串扰。
    const shift = findPeriodShift(sentenceAt(record.text, amount.span[0]));
    return {
      ...amount,
      period: shift === null ? record.period : shiftPeriod(currentPeriods[record.market], shift),
      entity: record.entity,
    };
  });
  return {
    ref: { file: FILE_TEXT, id: record.id },
    market: record.market,
    entity: record.entity,
    period: record.period,
    language: record.language,
    carrier: '正文',
    kinds,
    direction: directions[0] ?? null,
    policy: policies[0] ?? null,
    subject: subjects[0] ?? null,
    amounts,
    refs: extractRefs(record.text),
    cueSpans: {
      kinds: findCueSpans(record.text, KIND_CUES, 'kind'),
      directions: findCueSpans(record.text, DIRECTION_CUES, 'direction'),
      policies: findCueSpans(record.text, POLICY_CUES, 'policy'),
      entities: findCueSpans(record.text, ENTITY_CUES, 'entity'),
    },
    text: record.text,
    evidence: evidenceOf(FILE_TEXT, record, [
      ...amounts.map(a => a.span),
      ...findCueSpans(record.text, KIND_CUES, 'kind').map(c => c.span),
      ...findCueSpans(record.text, DIRECTION_CUES, 'direction').map(c => c.span),
    ]),
  };
}

function analyzeRowRecord(record, currentPeriods) {
  const unitInfo = UNITS[record.unit];
  const amount = {
    raw: `${record.amount}${record.unit}`,
    value: Number(record.amount) * (unitInfo?.factor ?? 1),
    unit: record.unit,
    unitInfo: unitInfo
      ? { ...unitInfo, currency: MARKET_CURRENCY[record.market] ?? unitInfo.currency }
      : { factor: 1, currency: MARKET_CURRENCY[record.market] ?? null, defined: false, label: '未定义单位' },
    period: record.period,
    entity: record.entity,
    span: null,
  };
  return {
    ref: { file: FILE_ROWS, id: record.id },
    market: record.market,
    entity: record.entity,
    period: record.period,
    language: null,
    carrier: '表行',
    table: record.table,
    footnote: record.footnote,
    kinds: ['列报数据'],
    // 本期列报即本期事实的表格载体；比较期行只作列报数据。
    direction: record.period === currentPeriods[record.market] ? '已确认' : '列报',
    policy: null,
    subject: null, // 由引用该表的正文按主张回填
    amounts: [amount],
    refs: { tables: [], footnotes: [record.footnote] },
    text: null,
    evidence: evidenceOf(FILE_ROWS, record),
  };
}

// 更正通告：解析“某主体某期间应为某金额；其余无需调整”。
function parseCorrection(record, currentPeriods) {
  if (!/应为|无需调整|更正/.test(record.text)) return null;
  const current = currentPeriods[record.market];
  const sentences = record.text.split(/(?<=[。；.])/).filter(s => s.trim().length > 0);
  const targets = [];
  const unaffected = [];
  for (const sentence of sentences) {
    const shift = findPeriodShift(sentence);
    const period = shift === null ? null : shiftPeriod(current, shift);
    const entities = findEntities(sentence);
    const amounts = extractAmounts(sentence, record.market);
    if (/应为/.test(sentence) && amounts.length > 0) {
      targets.push({
        entity: entities[0] ?? null,
        period,
        correctedAmount: amounts[0],
        sentence,
      });
    }
    if (/无需调整/.test(sentence)) {
      if (shift !== null) unaffected.push({ period });
      for (const entity of entities) unaffected.push({ entity });
    }
  }
  if (targets.length === 0) return null;
  return {
    ref: { file: FILE_NOTES, id: record.id },
    market: record.market,
    targets,
    unaffected,
    text: record.text,
    evidence: evidenceOf(FILE_NOTES, record),
  };
}

// 脚注分句并按条件（期间词、主体词）确定每句的适用范围。
function parseFootnoteClauses(record, currentPeriods) {
  const current = currentPeriods[record.market];
  return record.text
    .split(/(?<=[。；.])/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0)
    .map(sentence => {
      const shift = findPeriodShift(sentence);
      return {
        sentence,
        kinds: findKinds(sentence),
        period: shift === null ? null : shiftPeriod(current, shift),
        entities: findEntities(sentence),
        appliesToAllRows: /各行|所有行|unless\s+specified/i.test(sentence),
      };
    });
}

function correctionAffects(correction, fact) {
  return correction.targets.some(target =>
    (target.entity === null || target.entity === fact.entity) &&
    (target.period === null || target.period === fact.period));
}

function correctionExempts(correction, fact) {
  return correction.unaffected.some(scope =>
    (scope.entity !== undefined && scope.entity === fact.entity) ||
    (scope.period !== undefined && scope.period === fact.period));
}

export function analyze(tables) {
  const currentPeriods = marketCurrentPeriods(tables);
  const facts = [];
  const corrections = [];
  const footnotes = [];

  for (const record of tables[FILE_TEXT]) facts.push(analyzeTextRecord(record, currentPeriods));
  for (const record of tables[FILE_ROWS]) facts.push(analyzeRowRecord(record, currentPeriods));
  for (const record of tables[FILE_NOTES]) {
    const correction = parseCorrection(record, currentPeriods);
    if (correction) {
      corrections.push(correction);
    } else {
      footnotes.push({
        ref: { file: FILE_NOTES, id: record.id },
        market: record.market,
        notice: record.notice,
        clauses: parseFootnoteClauses(record, currentPeriods),
        text: record.text,
        evidence: evidenceOf(FILE_NOTES, record),
      });
    }
  }

  // 正文按主张把主题回填给被引用的表行（跨段、跨表对应）。
  const rows = facts.filter(f => f.carrier === '表行');
  const texts = facts.filter(f => f.carrier === '正文');
  for (const text of texts) {
    if (!text.subject) continue;
    for (const tableName of text.refs.tables) {
      for (const row of rows.filter(r => r.market === text.market && r.table === tableName)) {
        row.subject ??= text.subject;
        row.referencedBy ??= [];
        row.referencedBy.push(text.ref.id);
      }
    }
  }

  // 更正落位：被取代的行、明确不受影响的行。
  for (const correction of corrections) {
    for (const fact of facts) {
      if (fact.market !== correction.market) continue;
      if (correctionAffects(correction, fact) && !correctionExempts(correction, fact)) {
        fact.correction = {
          status: '被更正取代',
          by: correction.ref.id,
          correctedAmount: correction.targets.find(t =>
            (t.entity === null || t.entity === fact.entity) &&
            (t.period === null || t.period === fact.period))?.correctedAmount ?? null,
        };
      } else if (correctionExempts(correction, fact)) {
        fact.correction = { status: '更正明确不影响', by: correction.ref.id };
      }
    }
  }

  // 脚注适用范围：覆盖哪些行，每句按条件落到哪些行；更正是否改变了适用范围。
  const footnoteScopes = footnotes.map(note => {
    const coveredRows = rows.filter(row => row.market === note.market && row.footnote === note.notice);
    const clauseCoverage = note.clauses.map(clause => ({
      ...clause,
      rows: coveredRows
        .filter(row =>
          (clause.appliesToAllRows || clause.period === null || clause.period === row.period) &&
          (clause.entities.length === 0 || clause.entities.includes(row.entity)))
        .map(row => row.ref.id),
    }));
    // 分句主张按条件回填到对应行（如“上年数重列”只落到上年行）。
    for (const clause of clauseCoverage) {
      for (const rowId of clause.rows) {
        const row = rows.find(r => r.ref.id === rowId);
        for (const kind of clause.kinds) {
          if (!row.kinds.includes(kind)) row.kinds.push(kind);
        }
      }
    }
    const scopeChangedBy = corrections
      .filter(correction => coveredRows.some(row => row.correction?.by === correction.ref.id && row.correction.status === '被更正取代'))
      .map(correction => correction.ref.id);
    return {
      notice: note.notice,
      market: note.market,
      ref: note.ref,
      text: note.text,
      rows: coveredRows.map(row => ({
        id: row.ref.id,
        period: row.period,
        entity: row.entity,
        status: row.correction?.status === '被更正取代' ? '需更新' : '有效',
        correction: row.correction ?? null,
      })),
      clauseCoverage,
      scopeChangedBy,
      // 共享脚注的任一行已签署，不能为整页兜底：适用范围变化后逐行重核。
      blanketSignoffValid: scopeChangedBy.length === 0,
    };
  });

  const gaps = findGaps({ facts, corrections, footnotes, footnoteScopes });
  const terms = buildTermTable(facts, footnotes);

  return { facts, corrections, footnotes, footnoteScopes, gaps, terms, currentPeriods };
}

function findGaps({ facts, corrections, footnotes }) {
  const gaps = [];
  let seq = 0;
  const push = (kind, detail, where, extra = {}) => {
    seq += 1;
    gaps.push({ id: `G${seq}`, kind, detail, where: where ?? null, ...extra });
  };

  // 单位未定义的金额。
  for (const fact of facts) {
    for (const amount of fact.amounts) {
      if (!amount.unitInfo.defined) {
        push('单位未定义',
          `${fact.ref.id} 的“${amount.raw}”单位未定义，无法折算，需人工确认单位与币种`,
          { file: fact.ref.file, id: fact.ref.id, span: amount.span });
      }
    }
  }

  // 正文未指明主张主题：转述或译文可能遗漏，不能静默归入任一主张。
  for (const fact of facts) {
    if (fact.carrier === '正文' && fact.subject === null) {
      push('主题未指明',
        `${fact.ref.id} 未写明金额所属主题，与其他记录的对应关系只能暂定，需人工确认`,
        { file: fact.ref.file, id: fact.ref.id });
    }
  }

  // 更正数未落到任何表行。
  for (const correction of corrections) {
    for (const target of correction.targets) {
      push('更正未落表',
        `${correction.ref.id} 将${target.entity ?? '某主体'}${target.period ?? '某期间'}数更正为 ${target.correctedAmount.raw}，但无表行承载该更正值`,
        { file: correction.ref.file, id: correction.ref.id });
    }
  }

  // 跨币种金额缺经批准的换算说明。
  const currencies = new Set();
  for (const fact of facts) {
    for (const amount of fact.amounts) {
      if (amount.unitInfo.defined && amount.unitInfo.currency) currencies.add(amount.unitInfo.currency);
    }
  }
  if (currencies.size > 1) {
    push('换算说明缺失',
      `资料涉及 ${[...currencies].join(' 与 ')} 两种币种，未见财务批准且附适用条件的换算说明，数值比较暂缓`,
      null,
      { currencies: [...currencies] });
  }

  // 政策说明缺适用条件。
  for (const fact of facts) {
    if (fact.policy === '新政策' && !/生效|自\d|起适用|effective/i.test(fact.text ?? '')) {
      push('政策条件缺失',
        `${fact.ref.id} 提及新政策但资料未载明生效日期与适用条件`,
        { file: fact.ref.file, id: fact.ref.id });
    }
  }

  // 跨语言事项缺对侧支持：一侧出现的政策/方向条件在另一侧无任何对应。
  // 支持集不按主题过滤：主题未指明的记录（如转述）仍可能提供对应。
  const markets = [...new Set(facts.map(f => f.market))];
  if (markets.length >= 2) {
    for (const fact of facts) {
      if (!fact.policy) continue;
      const others = facts.filter(other => other.market !== fact.market);
      if (others.length === 0) continue;
      if (!others.some(other => other.policy === fact.policy)) {
        push('对侧无对应事项',
          `${fact.ref.id} 的“${fact.policy}”条件在其他出稿地资料中无对应，需确认是否译文或转述增加了原文不支持的事项`,
          { file: fact.ref.file, id: fact.ref.id });
      }
    }
  }

  return gaps;
}

// 双语术语对照：同一术语在两地的实际用法与定义是否一致。
function buildTermTable(facts, footnotes) {
  const terms = [];
  const usage = (predicate) => facts.filter(predicate).map(f => f.ref.id);

  const recognized = usage(f => f.direction === '已确认');
  const willRecognize = usage(f => f.direction === '将确认');
  terms.push({
    term: '确认 / recognize',
    zhUsage: recognized.filter(id => facts.find(f => f.ref.id === id)?.language === 'zh'),
    enUsage: [
      ...willRecognize.map(id => ({ id, sense: '将确认（未来）' })),
      ...recognized.filter(id => facts.find(f => f.ref.id === id)?.language === 'en').map(id => ({ id, sense: '已确认（本期）' })),
    ],
    aligned: willRecognize.length === 0,
    note: willRecognize.length > 0
      ? '表面同为“确认/recognize”，但一侧为本期已确认、另一侧为未来将确认，不能仅凭术语签为等义'
      : '用法一致',
  });

  const restatedTexts = footnotes.filter(n => n.clauses.some(c => c.kinds.includes('以前期间重列')));
  terms.push({
    term: '重列 / restated',
    zhUsage: restatedTexts.filter(n => /重列/.test(n.text)).map(n => n.ref.id),
    enUsage: restatedTexts.filter(n => /restated/i.test(n.text)).map(n => ({ id: n.ref.id, sense: '比较数重列' })),
    aligned: true,
    note: '两地均指比较期间数字的追溯重列',
  });

  terms.push({
    term: '合并 / group',
    zhUsage: usage(f => f.entity === '合并' && f.language === 'zh'),
    enUsage: usage(f => f.entity === '合并' && f.language === 'en').map(id => ({ id, sense: '集团（合并）' })),
    aligned: true,
    note: '均指合并报表主体',
  });

  terms.push({
    term: '母公司 / parent',
    zhUsage: usage(f => f.entity === '母公司'),
    enUsage: usage(f => f.entity === '母公司' && f.language === 'en').map(id => ({ id, sense: '母公司' })),
    aligned: true,
    note: '仅母公司口径，不与合并口径混排',
  });

  const unitTerms = new Map();
  for (const fact of facts) {
    for (const amount of fact.amounts) {
      const key = amount.unitInfo.label;
      if (!unitTerms.has(key)) unitTerms.set(key, []);
      unitTerms.get(key).push(`${fact.ref.id}(${amount.raw})`);
    }
  }
  terms.push({
    term: '金额单位',
    zhUsage: unitTerms.has('万元') ? unitTerms.get('万元') : [],
    enUsage: [...unitTerms.entries()]
      .filter(([label]) => label !== '万元')
      .map(([label, usages]) => ({ id: usages.join('、'), sense: label })),
    aligned: false,
    note: '万元、千本地币与未定义单位并存，数值语义不同，比较前需经批准的换算说明',
  });

  return terms;
}
