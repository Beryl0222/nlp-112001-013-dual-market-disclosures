import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { readMaterials } from '../materials.js';

const representativeFile = "正文.json";
const expectedCounts = {
  "正文.json": 4,
  "表行.json": 4,
  "脚注与通告.json": 4
};

test('全部来稿可按原值读取', async () => {
  const inputs = await readMaterials();
  const counts = Object.fromEntries(Object.entries(inputs).map(([name, rows]) => [name, rows.length]));
  assert.deepEqual(counts, expectedCounts);
  assert.equal(inputs[representativeFile][0]["text"], "本期按旧政策已确认服务收入三十万元，比较数见表二及脚注甲。");
});

test('损坏的记录给出资料名和行号', async (context) => {
  const scratch = await mkdtemp(join(tmpdir(), 'materials-'));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const directory = join(scratch, '材料');
  await mkdir(directory);
  await cp(new URL('../资料/', import.meta.url), directory, { recursive: true });
  await writeFile(join(directory, representativeFile), '[{}]');
  await assert.rejects(readMaterials(pathToFileURL(directory + sep)), error => {
    assert.ok(error instanceof TypeError);
    assert.ok(error.message.includes(representativeFile));
    assert.ok(error.message.includes('第 1 条'));
    return true;
  });
});
