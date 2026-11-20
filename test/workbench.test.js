import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { readMaterials } from '../materials.js';
import { analyze } from '../src/analyze.js';
import { compareMarkets, groupClaims, validateSummary } from '../src/decide.js';
import { parseChineseNumeral, extractAmounts } from '../src/lexicon.js';

const execFileAsync = promisify(execFile);

async function loadAnalysis(approvals = { conversions: [] }) {
  const tables = await readMaterials();
  const analysis = analyze(tables);
  const comparison = compareMarkets(analysis, approvals);
  return { tables, analysis, comparison };
}

const factById = (analysis, id) => analysis.facts.find(f => f.ref.id === id);
const decisionOf = (comparison, predicate) => comparison.decisions.find(predicate);
const pairHas = (d, a, b) => {
  const ids = Object.values(d.members).flat();
  return ids.includes(a) && ids.includes(b);
};

test('中文数字与金额单位解析', () => {
  assert.equal(parseChineseNumeral('三十万'), 300000);
  assert.equal(parseChineseNumeral('十九万'), 190000);
  assert.equal(parseChineseNumeral('一百零五'), 105);
  assert.equal(parseChineseNumeral('千'), 1000);
  assert.equal(parseChineseNumeral('元'), null);

  const [zh] = extractAmounts('本期按旧政策已确认服务收入三十万元。', '南市');
  assert.equal(zh.value, 300000);
  assert.equal(zh.unit, '万元');
  assert.equal(zh.unitInfo.currency, '元');

  const [en] = extractAmounts('30 thousands of local currency', '湾市');
  assert.equal(en.value, 30000);
  assert.equal(en.unitInfo.currency, 'local');

  const [undefinedUnit] = extractAmounts('30 units', '湾市');
  assert.equal(undefinedUnit.unitInfo.defined, false);
});

test('陈述分类：本期事实 / 未来计划 / 政策说明 / 以前期间重列', async () => {
  const { analysis } = await loadAnalysis();

  const n1 = factById(analysis, 'n1');
  assert.deepEqual(n1.kinds.sort(), ['政策说明', '本期事实'].sort());
  assert.equal(n1.direction, '已确认');
  assert.equal(n1.policy, '旧政策');

  const n2 = factById(analysis, 'n2');
  assert.ok(n2.kinds.includes('未来计划'));
  assert.equal(n2.direction, '将确认');
  assert.equal(n2.policy, '新政策');

  const n3 = factById(analysis, 'n3');
  assert.ok(n3.kinds.includes('本期事实'));

  // 表行的重列主张由脚注分句按条件回填：只落到上年行。
  const a1 = factById(analysis, 'a1');
  assert.ok(a1.kinds.includes('以前期间重列'));
  const a2 = factById(analysis, 'a2');
  assert.ok(!a2.kinds.includes('以前期间重列'));
  const a3 = factById(analysis, 'a3');
  assert.ok(a3.kinds.includes('以前期间重列'));
});

test('金额要素：期间按所在句确定，主体与单位各自保留', async () => {
  const { analysis } = await loadAnalysis();

  // n2 的 30 units 在未来计划句中，不受邻句“Prior-period”影响。
  const n2 = factById(analysis, 'n2');
  assert.equal(n2.amounts[0].period, '2026');
  assert.equal(n2.amounts[0].unitInfo.defined, false);

  const n1 = factById(analysis, 'n1');
  assert.equal(n1.amounts[0].period, '2026');
  assert.equal(n1.amounts[0].entity, '合并');

  const n3 = factById(analysis, 'n3');
  assert.equal(n3.entity, '母公司');
});

test('术语相同不能签为等义：已确认 × 将确认 → 不可对照且不阻断本地发布', async () => {
  const { comparison } = await loadAnalysis();
  const d = decisionOf(comparison, d => pairHas(d, 'n1', 'n2'));
  assert.equal(d.qualitative, '不可对照');
  assert.equal(d.blockedLocalPublish, false);
  assert.ok(d.semanticDifferences.some(x => x.includes('确认时点')));
  assert.ok(d.semanticDifferences.some(x => x.includes('政策基础')));
  // 未发布比较数值须留痕原因。
  assert.equal(d.unpublishedNumeric.left, '三十万元');
  assert.equal(d.unpublishedNumeric.right, '30 units');
  assert.ok(d.unpublishedNumeric.reason.length > 0);
});

test('同主体同期间同方向：定性可共同引用，跨币种数值暂缓', async () => {
  const { comparison } = await loadAnalysis();
  const d = decisionOf(comparison, d => pairHas(d, 'n1', 'a4'));
  assert.equal(d.qualitative, '共同引用');
  assert.equal(d.numeric, '暂缓');
  assert.ok(d.reasons.some(r => r.includes('换算说明')));
});

test('报表主体不同：仅母公司口径不与合并口径共同引用', async () => {
  const { comparison } = await loadAnalysis();
  for (const d of comparison.decisions.filter(d => pairHas(d, 'n3', 'n2') || pairHas(d, 'n3', 'a4'))) {
    assert.equal(d.qualitative, '按各地口径发布');
    assert.equal(d.blockedLocalPublish, false);
  }
});

test('主题未指明的记录只做暂定对应并定位缺口', async () => {
  const { analysis, comparison } = await loadAnalysis();
  const d = decisionOf(comparison, d => pairHas(d, 'n4', 'n1'));
  assert.equal(d.tentative, true);
  assert.equal(d.qualitative, '暂缓');
  assert.ok(analysis.gaps.some(g => g.kind === '主题未指明' && g.where.id === 'n4'));
});

test('更正只影响合并上年数：本地可发布，被取代行须更新', async () => {
  const { analysis } = await loadAnalysis();

  const a1 = factById(analysis, 'a1');
  assert.equal(a1.correction.status, '被更正取代');
  assert.equal(a1.correction.by, 'z4');
  assert.equal(a1.correction.correctedAmount.value, 190000);

  for (const id of ['n1', 'n3', 'a2']) {
    assert.equal(factById(analysis, id).correction.status, '更正明确不影响');
  }
  // 湾市记录不受南市更正影响。
  assert.equal(factById(analysis, 'a3').correction, undefined);
});

test('共享脚注：适用范围改变后逐行重核，已签署行不能兜底整页', async () => {
  const { analysis } = await loadAnalysis();
  const scope = analysis.footnoteScopes.find(s => s.notice === '甲');
  assert.equal(scope.blanketSignoffValid, false);
  assert.deepEqual(
    Object.fromEntries(scope.rows.map(r => [r.id, r.status])),
    { a1: '需更新', a2: '有效' },
  );
  // 分句适用：重列句只覆盖上年行，单位句覆盖全部行。
  const restatedClause = scope.clauseCoverage.find(c => c.sentence.includes('重列'));
  assert.deepEqual(restatedClause.rows, ['a1']);
  const unitClause = scope.clauseCoverage.find(c => c.sentence.includes('万元列报'));
  assert.deepEqual(unitClause.rows.sort(), ['a1', 'a2']);
});

test('缺口清单：单位未定义、更正未落表、换算缺失、政策条件、对侧无对应', async () => {
  const { analysis } = await loadAnalysis();
  const kinds = analysis.gaps.map(g => g.kind);
  for (const expected of ['单位未定义', '主题未指明', '更正未落表', '换算说明缺失', '政策条件缺失', '对侧无对应事项']) {
    assert.ok(kinds.includes(expected), `缺少缺口类型：${expected}`);
  }
  const unsupported = analysis.gaps.find(g => g.kind === '对侧无对应事项');
  assert.equal(unsupported.where.id, 'n2'); // 新政策在南市无对应；旧政策有 n4 对应，不误报
});

test('摘要校验：当前说明不得拼接重列前数字', async () => {
  const { analysis } = await loadAnalysis();
  const check = validateSummary(['n1', 'a1'], analysis);
  assert.equal(check.reusable, false);
  const rules = check.violations.map(v => v.rule);
  assert.ok(rules.includes('期间一致'));
  assert.ok(rules.includes('不用重列前数字'));
  assert.ok(rules.includes('脚注逐行重核'));
});

test('摘要校验：混排母公司口径被阻断', async () => {
  const { analysis } = await loadAnalysis();
  const check = validateSummary(['n1', 'n3'], analysis);
  assert.equal(check.reusable, false);
  assert.ok(check.violations.some(v => v.rule === '合并范围一致' && v.level === '阻断'));
});

test('摘要校验：跨币种数值复用取决于批准的换算说明与合并范围', async () => {
  const { analysis } = await loadAnalysis();
  const selection = ['n1', 'a2', 'a4'];

  const noApproval = validateSummary(selection, analysis);
  assert.equal(noApproval.qualitativeReusable, true);
  assert.equal(noApproval.numericReusable, false);
  assert.ok(noApproval.violations.some(v => v.rule === '换算说明' && v.level === '数值暂缓'));

  const approvals = { conversions: [{ fromCurrency: 'local', toCurrency: '元', rate: 1, scope: '合并', conditions: '测试用' }] };
  const approved = validateSummary(selection, analysis, approvals);
  assert.equal(approved.reusable, true);

  // 批准只覆盖合并口径：混入母公司记录即不可复用。
  const mixed = validateSummary([...selection, 'n3'], analysis, approvals);
  assert.equal(mixed.reusable, false);
  assert.ok(mixed.violations.some(v => v.rule === '合并范围一致'));
});

test('换算说明批准后，同范围配对升级为共同引用并记录条件', async () => {
  const approvals = { conversions: [{ fromCurrency: 'local', toCurrency: '元', rate: 1, scope: '合并', conditions: '仅2026年度合并口径' }] };
  const { comparison } = await loadAnalysis(approvals);
  const d = decisionOf(comparison, d => pairHas(d, 'n1', 'a4'));
  assert.equal(d.numeric, '共同引用');
  assert.ok(d.conditions.some(c => c.includes('仅2026年度合并口径')));
});

test('等价组：正文与表行按主张及金额互认', async () => {
  const { analysis } = await loadAnalysis();
  const groups = groupClaims(analysis.facts);
  const current = groups.find(g => g.market === '南市' && g.period === '2026' && g.entity === '合并');
  assert.deepEqual(current.members.map(m => m.ref.id).sort(), ['a2', 'n1']);
});

test('审计轨迹：每项决定可回查证据、语义差异与未发布原因', async () => {
  const { comparison } = await loadAnalysis();
  for (const d of comparison.decisions) {
    assert.ok(d.evidence.length > 0, `${d.id} 缺证据`);
    for (const ev of d.evidence) {
      assert.ok(ev.file && ev.id, '证据须含资料名与记录编号');
    }
  }
  const unpublished = comparison.decisions.filter(d => d.unpublishedNumeric);
  assert.ok(unpublished.length > 0);
  for (const d of unpublished) {
    assert.ok(d.unpublishedNumeric.reason, `${d.id} 未发布比较数值缺原因`);
  }
});

test('CLI：输出报告各区段并写出审计轨迹', async (context) => {
  const scratch = await mkdtemp(join(tmpdir(), 'workbench-'));
  context.after(() => rm(scratch, { recursive: true, force: true }));

  const { stdout } = await execFileAsync('node', ['workbench.js', '--out', scratch], { cwd: new URL('..', import.meta.url).pathname });
  for (const section of ['一、陈述分类', '二、跨地比对决定', '三、更正与重列的影响', '四、脚注适用范围', '五、缺口', '六、双语术语对照', '七、共同摘要校验']) {
    assert.ok(stdout.includes(section), `报告缺区段：${section}`);
  }
  assert.ok(stdout.includes('不可对照'));
  assert.ok(stdout.includes('不能仅凭术语签为等义'));

  const { stdout: jsonOut } = await execFileAsync('node', ['workbench.js', '--json'], { cwd: new URL('..', import.meta.url).pathname });
  const audit = JSON.parse(jsonOut);
  assert.ok(Array.isArray(audit.decisions));
  assert.ok(Array.isArray(audit.gaps));
});

test('CLI：未知参数报错退出', async () => {
  await assert.rejects(
    execFileAsync('node', ['workbench.js', '--bogus'], { cwd: new URL('..', import.meta.url).pathname }),
    error => {
      assert.ok(error.stderr.includes('未知参数'));
      return true;
    },
  );
});

test('批准文件：带适用条件的换算说明从文件读入', async (context) => {
  const scratch = await mkdtemp(join(tmpdir(), 'workbench-'));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const approvalsPath = join(scratch, '批准.json');
  await writeFile(approvalsPath, JSON.stringify({
    conversions: [{ fromCurrency: 'local', toCurrency: '元', rate: 1, scope: '合并', conditions: '仅2026年度合并口径' }],
  }));

  const { stdout } = await execFileAsync(
    'node', ['workbench.js', '--approvals', approvalsPath],
    { cwd: new URL('..', import.meta.url).pathname },
  );
  assert.ok(stdout.includes('按已批准换算说明（仅2026年度合并口径）折算'));
  assert.ok(stdout.includes('共同摘要候选：选取 n1、a2、a4 → 可复用'));
});
