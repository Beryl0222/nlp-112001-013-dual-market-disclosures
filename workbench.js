#!/usr/bin/env node
// 双地财报比对工作台：读取资料 → 归一化 → 比对决策 → 报告与审计轨迹。
// 用法：node workbench.js [--dir 资料目录] [--approvals 批准文件.json] [--out 输出目录] [--json]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readMaterials } from './materials.js';
import { analyze } from './src/analyze.js';
import { compareMarkets, validateSummary } from './src/decide.js';
import { buildAudit, renderReport } from './src/report.js';

function parseArgs(argv) {
  const args = { dir: '资料', approvals: null, out: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--approvals') args.approvals = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--json') args.json = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

export async function runWorkbench({ dir, approvals: approvalsPath, out, json }) {
  const tables = await readMaterials(pathToFileURL(dir.endsWith('/') ? dir : `${dir}/`));
  const approvals = approvalsPath
    ? JSON.parse(await readFile(approvalsPath, 'utf8'))
    : { conversions: [] };

  const analysis = analyze(tables);
  const comparison = compareMarkets(analysis, approvals);

  // 共同摘要候选：定性可共同引用且未被更正降级的各组成员；另附两个反例演示校验规则。
  const jointIds = [...new Set(comparison.decisions
    .filter(d => d.qualitative === '共同引用' && !d.decision.startsWith('须重审'))
    .flatMap(d => Object.values(d.members).flat()))];
  const summaryChecks = [
    { name: '共同摘要候选', ...validateSummary(jointIds, analysis, approvals) },
  ];
  const currentText = analysis.facts.find(f => f.ref.id === 'n1');
  const supersededRow = analysis.facts.find(f => f.correction?.status === '被更正取代');
  if (currentText && supersededRow) {
    summaryChecks.push({
      name: '反例：当前说明拼接重列前数字',
      ...validateSummary([currentText.ref.id, supersededRow.ref.id], analysis, approvals),
    });
  }
  const parentOnly = analysis.facts.find(f => f.entity === '母公司');
  if (currentText && parentOnly) {
    summaryChecks.push({
      name: '反例：混排不同报表主体',
      ...validateSummary([currentText.ref.id, parentOnly.ref.id], analysis, approvals),
    });
  }

  const inputs = {
    directory: dir,
    counts: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length])),
    approvals: approvalsPath ?? null,
  };
  const audit = buildAudit(analysis, comparison, summaryChecks, inputs);

  let auditPath = null;
  if (out) {
    await mkdir(out, { recursive: true });
    auditPath = join(out, '审计轨迹.json');
    await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  }

  const report = renderReport(analysis, comparison, summaryChecks, auditPath);
  return { report, audit, auditPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { report, audit } = await runWorkbench(args);
    process.stdout.write(args.json ? `${JSON.stringify(audit, null, 2)}\n` : report);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
