#!/usr/bin/env node
/**
 * sync-shared.js
 *
 * 将 shared/ 下的共享源文件（定价数据、catalog schema 与校验器）同步到
 * backend 与 worker 的对应目录。在 build/dev 前自动运行，确保两端使用同一份
 * 逻辑/数据。
 *
 * 唯一真实来源位于 shared/ 下；本脚本只负责把它们复制到各端的目标路径，
 * 且仅在内容有变化时才写入（避免无谓的重建）。
 *
 * 新增共享文件时，只需在下面的 jobs 表中追加一项即可。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// 每个条目: 源文件 -> 需要复制到的所有目标相对路径（相对仓库根目录）
const jobs = [
  {
    name: 'model-pricing',
    source: 'shared/model-pricing.json',
    targets: [
      'backend/src/data/model-pricing.json',
      'worker/src/data/model-pricing.json',
    ],
  },
  {
    name: 'catalog-schema',
    source: 'shared/catalog.schema.json',
    targets: [
      'backend/src/services/catalog.schema.json',
      'worker/src/services/catalog.schema.json',
    ],
  },
  {
    name: 'catalog-validator',
    source: 'shared/catalogValidator.ts',
    targets: [
      'backend/src/services/catalogValidator.ts',
      'worker/src/services/catalogValidator.ts',
    ],
  },
];

function copyIfChanged(src, dest) {
  const content = fs.readFileSync(src, 'utf-8');
  let existing = '';
  try {
    existing = fs.readFileSync(dest, 'utf-8');
  } catch {}
  if (existing !== content) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf-8');
    console.log(`[sync-shared] synced ${path.relative(root, dest)}`);
  }
}

let failed = false;
for (const job of jobs) {
  const src = path.join(root, job.source);
  if (!fs.existsSync(src)) {
    console.error(`[sync-shared] ERROR: ${job.source} not found`);
    failed = true;
    continue;
  }
  for (const t of job.targets) {
    copyIfChanged(src, path.join(root, t));
  }
}

if (failed) {
  process.exit(1);
}
console.log('[sync-shared] done');
