// 双语词表与文本提取：把正文、表行、脚注中的陈述归一化为可比对的事实要素。
// 所有函数只做词表驱动的提取，不臆造资料中没有的内容；提取不到的一律标为缺口。

export const SUBJECT_CUES = [
  { subject: '服务收入', patterns: [/服务收入/, /\bservice revenue\b/i] },
];

export const KIND_CUES = [
  { kind: '未来计划', patterns: [/将(?:会)?确认/, /将于[^。；.]*确认/, /\bwill\s+recognize\b/i, /\bgoing\s+to\s+recognize\b/i] },
  { kind: '以前期间重列', patterns: [/重列/, /\brestated\b/i, /\brestatement\b/i] },
  { kind: '本期事实', patterns: [/已确认/, /(?:本期|本年)[^。；，,.]*确认/, /\b(?:was|were)\s+recognized\b/i] },
  { kind: '政策说明', patterns: [/政策/, /\bpolicy\b/i] },
];

export const DIRECTION_CUES = [
  { direction: '将确认', patterns: [/将(?:会)?确认/, /\bwill\s+recognize\b/i, /\bgoing\s+to\s+recognize\b/i] },
  { direction: '已确认', patterns: [/已确认/, /(?:本期|本年)[^。；，,.]*确认/, /\b(?:was|were)\s+recognized\b/i] },
  { direction: '重列', patterns: [/重列/, /\brestated\b/i] },
  { direction: '更正', patterns: [/应为/, /\bshould\s+be\b/i] },
];

export const POLICY_CUES = [
  { policy: '旧政策', patterns: [/旧政策/, /\b(?:former|old|previous)\s+policy\b/i] },
  { policy: '新政策', patterns: [/新政策/, /\bnew\s+policy\b/i] },
];

export const ENTITY_CUES = [
  { entity: '母公司', patterns: [/母公司/, /\bparent(?:\s+company)?\b/i] },
  { entity: '合并', patterns: [/合并/, /\bgroup\b/i, /\bconsolidated\b/i] },
];

// 单位表：factor 为相对本币最小单位的倍率；currency 为 None 表示币种未定义。
export const UNITS = {
  '万元': { factor: 10000, currency: '元', defined: true, label: '万元' },
  '万': { factor: 10000, currency: '元', defined: true, label: '万元' },
  '千元': { factor: 1000, currency: '元', defined: true, label: '千元' },
  '千': { factor: 1000, currency: '元', defined: true, label: '千元' },
  '元': { factor: 1, currency: '元', defined: true, label: '元' },
  'thousands of local currency': { factor: 1000, currency: 'local', defined: true, label: '千本地币' },
  'thousand': { factor: 1000, currency: 'local', defined: true, label: '千本地币' },
  'thousands': { factor: 1000, currency: 'local', defined: true, label: '千本地币' },
  'units': { factor: 1, currency: null, defined: false, label: '未定义单位' },
  'unit': { factor: 1, currency: null, defined: false, label: '未定义单位' },
};

// 各地默认币种：表行等单位字段未写明币种时按出稿地口径理解。
export const MARKET_CURRENCY = { '南市': '元', '湾市': 'local' };

const ZH_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const ZH_SMALL_UNITS = { 十: 10, 百: 100, 千: 1000 };

export function parseChineseNumeral(text) {
  let total = 0;
  let section = 0;
  let number = 0;
  let seen = false;
  for (const ch of text) {
    if (ch in ZH_DIGITS) {
      number = ZH_DIGITS[ch];
      seen = true;
    } else if (ch in ZH_SMALL_UNITS) {
      section += (number === 0 ? 1 : number) * ZH_SMALL_UNITS[ch];
      number = 0;
      seen = true;
    } else if (ch === '万') {
      total += (section + number) * 10000;
      section = 0;
      number = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + section + number : null;
}

// 数字部分不含“万”：单位位置可能出现“万元/万”，避免“三十万元”被拆成“三十万+元”。
const ZH_AMOUNT = /([零一二两三四五六七八九十]+|\d+(?:\.\d+)?)(万元|千元|元|万|千)/g;
const EN_AMOUNT = /(\d+(?:\.\d+)?)\s*(thousands\s+of\s+local\s+currency|thousand|thousands|units|unit)\b/gi;

// 从文本提取金额提及，返回 { raw, value, unit, unitInfo, span }。
// value 已按单位倍率折算；币种由单位词与市场默认币种共同决定。
export function extractAmounts(text, market) {
  const found = [];
  for (const match of text.matchAll(ZH_AMOUNT)) {
    const numeric = match[1];
    const value = /^[零一二两三四五六七八九十百千万]+$/.test(numeric)
      ? parseChineseNumeral(numeric)
      : Number(numeric);
    if (value === null || Number.isNaN(value)) continue;
    const unitInfo = UNITS[match[2]];
    found.push({
      raw: match[0],
      value: value * unitInfo.factor,
      unit: match[2],
      unitInfo: { ...unitInfo, currency: unitInfo.currency ?? MARKET_CURRENCY[market] ?? null },
      span: [match.index, match.index + match[0].length],
    });
  }
  for (const match of text.matchAll(EN_AMOUNT)) {
    const unitWord = match[2].toLowerCase();
    const unitInfo = UNITS[unitWord];
    found.push({
      raw: match[0],
      value: Number(match[1]) * unitInfo.factor,
      unit: unitWord,
      unitInfo: { ...unitInfo, currency: unitInfo.currency ?? MARKET_CURRENCY[market] ?? null },
      span: [match.index, match.index + match[0].length],
    });
  }
  return found.sort((a, b) => a.span[0] - b.span[0]);
}

function matchCues(text, cues, key) {
  const hits = [];
  for (const cue of cues) {
    for (const pattern of cue.patterns) {
      const match = text.match(pattern);
      if (match) {
        hits.push({ value: cue[key], span: [match.index, match.index + match[0].length] });
        break;
      }
    }
  }
  return hits;
}

export const findKinds = (text) => [...new Set(matchCues(text, KIND_CUES, 'kind').map(h => h.value))];
export const findDirections = (text) => [...new Set(matchCues(text, DIRECTION_CUES, 'direction').map(h => h.value))];
export const findPolicies = (text) => [...new Set(matchCues(text, POLICY_CUES, 'policy').map(h => h.value))];
export const findSubjects = (text) => [...new Set(matchCues(text, SUBJECT_CUES, 'subject').map(h => h.value))];
export const findEntities = (text) => [...new Set(matchCues(text, ENTITY_CUES, 'entity').map(h => h.value))];

export function findCueSpans(text, cues, key) {
  return matchCues(text, cues, key).map(h => ({ value: h.value, span: h.span }));
}

// 期间词：以上下文记录的所属期间为“本期”。按句判断，避免邻句期间词串扰。
export function findPeriodShift(text) {
  if (/上年|去年|以前年度/.test(text) || /\bprior[- ]period|prior\s+year|comparative/i.test(text)) return -1;
  if (/本期|本年|今年/.test(text) || /\bcurrent\s+period|this\s+year\b/i.test(text)) return 0;
  return null;
}

// 文本分句（保留偏移），用于把金额归属到所在句的期间语境。
export function sentenceSpans(text) {
  const spans = [];
  let start = 0;
  for (const match of text.matchAll(/[。；.!?]/g)) {
    spans.push([start, match.index + 1]);
    start = match.index + 1;
  }
  if (start < text.length) spans.push([start, text.length]);
  return spans;
}

export function sentenceAt(text, index) {
  for (const [start, end] of sentenceSpans(text)) {
    if (index >= start && index < end) return text.slice(start, end);
  }
  return text;
}

// 跨段、跨表引用：正文指向的表与脚注。
export function extractRefs(text) {
  const tables = [];
  const footnotes = [];
  for (const match of text.matchAll(/表([一二三四五六七八九十\d]+)/g)) {
    tables.push(`表${match[1]}`);
  }
  for (const match of text.matchAll(/\btable\s+([A-Z])\b/gi)) {
    tables.push(match[1].toUpperCase());
  }
  for (const match of text.matchAll(/脚注([甲乙丙丁戊己庚辛])/g)) {
    footnotes.push(match[1]);
  }
  for (const match of text.matchAll(/\bfootnote\s+([A-Z])\b/gi)) {
    footnotes.push(match[1].toUpperCase());
  }
  return { tables: [...new Set(tables)], footnotes: [...new Set(footnotes)] };
}
