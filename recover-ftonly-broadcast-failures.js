#!/usr/bin/env node
'use strict';

// 一次性恢复“广播阶段 HTTP 500”任务。
// 不重新构造、不修改 funding UTXO、不触碰 generator 失败任务。
const fs = require('fs');
const path = require('path');

const ledgerFile = path.resolve(process.argv[2] || './automation-ftonly-ledger.json');
const dryRun = process.argv.includes('--dry-run');
const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
const backup = `${ledgerFile}.bak-${Date.now()}`;

function hasBroadcastFiles(entry) {
  const dir = path.resolve(entry.outputDir);
  const metaFile = path.join(dir, 'metadata.json');
  if (!fs.existsSync(metaFile)) return false;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) { return false; }
  const files = Array.isArray(meta.files?.layers) && meta.files.layers.length > 0
    ? meta.files.layers
    : [meta.files?.prepare, ...(Array.isArray(meta.files?.groups) ? meta.files.groups : [])].filter(Boolean);
  return files.length > 0 && files.every((file) => fs.existsSync(file));
}

const candidates = ledger.entries.filter((entry) => {
  const error = String(entry.error || '').toLowerCase();
  return entry.status === 'failed' &&
    entry.broadcastRetries > 0 &&
    (error.includes('http 500') || error.includes('status code 500')) &&
    hasBroadcastFiles(entry);
});

console.log(`候选广播任务: ${candidates.length}`);
for (const entry of candidates) console.log(`  ${entry.id}`);
if (dryRun || candidates.length === 0) {
  console.log(dryRun ? 'dry-run：未修改 ledger' : '没有可恢复任务');
  process.exit(0);
}

fs.copyFileSync(ledgerFile, backup);
for (const entry of candidates) {
  entry.status = 'generated';
  entry.broadcastRetries = 0;
  entry.broadcastStartedAt = null;
  entry.broadcastFinishedAt = null;
  entry.error = `recovered from HTTP 500; source ledger=${path.basename(backup)}`;
}
fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
console.log(`已恢复 ${candidates.length} 个任务`);
console.log(`备份文件: ${backup}`);
