'use strict';

/**
 * automation-ftonly.js
 *
 * 每检测到新区块推进：
 *   1. 按高度逐个追补缺失区块的 coinbase vout 1 funding UTXO
 *   2. 调用 genGroupsFtChains-ftonly.js 生成纯 FT 压测交易集
 *   3. 目标大小默认在 100MB..1000MB 之间随机
 *   4. 可选自动广播
 *
 * 用法：
 *   node automation-ftonly.js
 *   node automation-ftonly.js --config ./automation-ftonly.config.json
 */

(function checkDependencies() {
  const required = ['axios', 'minimist'];
  const missing = required.filter((pkg) => {
    try { require.resolve(pkg); return false; } catch (_) { return true; }
  });
  if (missing.length > 0) {
    console.error('\n缺少依赖包:\n');
    missing.forEach((p) => console.error('  - ' + p));
    console.error('\n请运行: npm install\n');
    process.exit(1);
  }
})();

const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const minimist = require('minimist');

const argv = minimist(process.argv.slice(2), { string: ['config'] });

const DEFAULTS = {
  rpc: {
    url: 'http://127.0.0.1:8332',
    username: 'username',
    password: 'randompasswd',
  },
  coinbasePrivKey: 'L1u2TmR7hMMMSV9Bx2Lyt3sujbboqEFqnKygnPRnQERhKB4qptuK',
  outputBaseDir: './ftonly-output',
  ledgerFile: './automation-ftonly-ledger.json',

  generator: {
    script: 'genGroupsFtChains-ftonly.js',
    groups: 4,
    perGroup: 10,
    ftAmount: 1,
    decimal: 6,
    to: '1Nykpv2CofTzpE1knswfVtLgrHFnHavsK7',
    randomMinMb: 900,
    randomMaxMb: 1100,
    maxFtCount: 0,
    broadcast: true,
    broadcastBatchSize: 10,
    broadcastDelayMs: 250,
    writeLocalTxs: false,
    cli: '/home/nemo/TBCNODE/bin/bitcoin-cli',
    conf: '/home/nemo/TBCNODE/node.main.conf',
  },

  maxGenerators: 2,
  maxBroadcasts: 2,
  maxBroadcastRetries: 3,
  pollInterval: 10000,
  rpcTimeout: 30000,
  generatorStallTimeoutMs: 10 * 60 * 1000,
  rpcCooldownAfterGeneratorMs: 60 * 1000,
  stopCreatingNew: false,
};

let CONFIG = JSON.parse(JSON.stringify(DEFAULTS));
if (argv.config) {
  const ext = JSON.parse(fs.readFileSync(argv.config, 'utf8'));
  CONFIG = deepMerge(CONFIG, ext);
  console.log(`[配置] 已加载: ${argv.config}`);
}

const activeGenerators = new Map();
const activeBroadcasts = new Map();
let ledger = loadLedger();
let lastHeight = 0;
let loopRunning = false;
let rpcGateClosedUntil = 0;
let rpcGateReason = '';

recoverStale(ledger);

runLoopOnce();
setInterval(runLoopOnce, CONFIG.pollInterval);

async function runLoopOnce() {
  if (loopRunning) return;
  loopRunning = true;
  try {
    await mainLoop();
  } catch (e) {
    console.error(`[主循环错误] ${e.stack || e.message}`);
  } finally {
    loopRunning = false;
  }
}

async function mainLoop() {
  checkGeneratorWatchdogs();
  if (isRpcGateClosed()) {
    printStats();
    return;
  }

  const healthy = await checkNodeHealth();
  if (!healthy) {
    console.log('[警告] 节点RPC不响应');
    return;
  }

  const height = await rpc('getblockcount', [], CONFIG.rpcTimeout);
  if (lastHeight === 0) {
    const ledgerMaxHeight = getLedgerMaxHeight(ledger);
    lastHeight = ledgerMaxHeight > 0 ? ledgerMaxHeight : height;
    console.log(`[初始化] 当前高度=${height}  账本记录=${ledger.entries.length}  起始补建高度=${lastHeight}`);
    drainPending();
    drainReadyBroadcasts();
    return;
  }

  if (height > lastHeight) {
    console.log(`\n[新区块] ${lastHeight} -> ${height}`);
    for (let h = lastHeight + 1; h <= height; h++) {
      if (CONFIG.stopCreatingNew) {
        lastHeight = h;
        continue;
      }

      try {
        const block = await getBlockByHeight(h);
        const utxo = await extractCoinbaseUTXO(block);

        if (isHeightTracked(ledger, h)) {
          console.log(`[跳过] 高度已存在: ${h}`);
        } else if (isUtxoUsed(ledger, utxo)) {
          console.log(`[跳过] UTXO已使用: ${utxo.txId}:${utxo.outputIndex}`);
        } else {
          const entry = addEntry(ledger, h, utxo);
          console.log(`[账本] 新记录: ${entry.id} ${utxo.txId}:${utxo.outputIndex} sats=${utxo.satoshis}`);
        }
        lastHeight = h;
      } catch (e) {
        console.error(`[错误] 补建高度 ${h} 失败: ${e.message}`);
        break;
      }
    }
  }

  drainPending();
  drainReadyBroadcasts();
  printStats();
}

function isRpcGateClosed() {
  if (Date.now() >= rpcGateClosedUntil) {
    if (rpcGateClosedUntil !== 0) console.log(`[RPC] 打开: ${rpcGateReason || 'cooldown complete'}`);
    rpcGateClosedUntil = 0;
    rpcGateReason = '';
    return false;
  }
  return true;
}

function closeRpcGate(ms, reason) {
  const until = Date.now() + ms;
  if (until > rpcGateClosedUntil) {
    rpcGateClosedUntil = until;
    rpcGateReason = reason;
    console.log(`[RPC] 关闭 ${Math.ceil(ms / 1000)}s: ${reason}`);
  }
}

async function rpc(method, params = [], timeout = 30000) {
  const res = await axios.post(CONFIG.rpc.url, {
    jsonrpc: '1.0',
    id: 'ftonly-auto',
    method,
    params,
  }, {
    auth: {
      username: CONFIG.rpc.username,
      password: CONFIG.rpc.password,
    },
    timeout,
  });
  if (res.data.error) throw new Error(JSON.stringify(res.data.error));
  return res.data.result;
}

async function checkNodeHealth() {
  try {
    await rpc('getblockcount', [], CONFIG.rpcTimeout);
    return true;
  } catch (_) {
    return false;
  }
}

async function getBlockByHeight(height) {
  const hash = await rpc('getblockhash', [height]);
  return rpc('getblock', [hash]);
}

async function extractCoinbaseUTXO(block) {
  const coinbaseTxId = block.tx[0];
  const raw = await rpc('getrawtransaction', [coinbaseTxId]);
  const decoded = await rpc('decoderawtransaction', [raw]);
  const vout = decoded.vout[1];
  if (!vout) throw new Error(`coinbase tx ${coinbaseTxId} 缺少 vout 1`);
  return {
    txId: coinbaseTxId,
    outputIndex: 1,
    satoshis: Math.floor(Number(vout.value) * 1e6),
  };
}

function drainPending() {
  if (isRpcGateClosed()) return;
  while (activeGenerators.size < CONFIG.maxGenerators) {
    const entry = ledger.entries.find((e) => e.status === 'pending');
    if (!entry) return;
    startGenerator(entry);
  }
}

function startGenerator(entry) {
  fs.mkdirSync(entry.outputDir, { recursive: true });
  const logFd = fs.openSync(path.join(entry.outputDir, 'automation-ftonly.log'), 'a');
  const seed = `${entry.id}-${Date.now()}`;
  const g = CONFIG.generator;

  const args = [
    g.script,
    '--privkey', CONFIG.coinbasePrivKey,
    '--txid', entry.sourceUtxo.txId,
    '--vout', String(entry.sourceUtxo.outputIndex),
    '--satoshis', String(entry.sourceUtxo.satoshis),
    '--groups', String(g.groups),
    '--per-group', String(g.perGroup),
    '--ft-amount', String(g.ftAmount),
    '--decimal', String(g.decimal),
    '--to', g.to,
    '--random-min-mb', String(g.randomMinMb),
    '--random-max-mb', String(g.randomMaxMb),
    '--seed', seed,
    '--outputdir', entry.outputDir,
    '--rpc-url', CONFIG.rpc.url,
    '--rpc-user', CONFIG.rpc.username,
    '--rpc-pass', CONFIG.rpc.password,
  ];

  if (g.maxFtCount > 0) args.push('--max-ft-count', String(g.maxFtCount));
  if (g.writeLocalTxs) args.push('--write-local-txs');

  console.log(`[生成] ${entry.id} seed=${seed}`);
  const child = spawn('node', args, { stdio: ['ignore', logFd, logFd] });
  activeGenerators.set(entry.id, {
    process: child,
    logFd,
    lastBytes: generatedBytes(entry.outputDir),
    lastChangedAt: Date.now(),
  });
  updateEntry(entry.id, 'generating', {
    generatorPid: child.pid,
    generatorStartedAt: new Date().toISOString(),
    seed,
  });

  child.on('exit', (code, signal) => {
    safeClose(logFd);
    activeGenerators.delete(entry.id);
    if (code === 0) {
      const nextStatus = CONFIG.generator.broadcast ? 'generated' : 'completed';
      console.log(CONFIG.generator.broadcast ? `[生成完成] ${entry.id}` : `[完成] ${entry.id}`);
      updateEntry(entry.id, nextStatus, {
        generatorFinishedAt: new Date().toISOString(),
      });
      drainReadyBroadcasts();
    } else {
      const reason = signal ? `signal=${signal}` : `code=${code}`;
      console.error(`[失败] ${entry.id} ${reason}`);
      closeRpcGate(CONFIG.rpcCooldownAfterGeneratorMs, `generator failed: ${entry.id}`);
      updateEntry(entry.id, 'failed', {
        generatorFinishedAt: new Date().toISOString(),
        error: signal ? `generator killed by signal=${signal}` : `generator exit code=${code}`,
      });
    }
    drainPending();
  });

  child.on('error', (err) => {
    safeClose(logFd);
    activeGenerators.delete(entry.id);
    closeRpcGate(CONFIG.rpcCooldownAfterGeneratorMs, `generator error: ${entry.id}`);
    updateEntry(entry.id, 'failed', {
      generatorFinishedAt: new Date().toISOString(),
      error: err.message,
    });
    drainPending();
  });
}

function drainReadyBroadcasts() {
  if (!CONFIG.generator.broadcast) return;
  while (activeBroadcasts.size < CONFIG.maxBroadcasts) {
    const entry = ledger.entries.find((e) => e.status === 'generated' && broadcastFilesReady(e));
    if (!entry) return;
    startBroadcast(entry);
  }
}

function startBroadcast(entry) {
  console.log(`[广播] ${entry.id}`);
  updateEntry(entry.id, 'broadcasting', {
    broadcastStartedAt: new Date().toISOString(),
    broadcastFinishedAt: null,
  });

  const logFile = path.join(entry.outputDir, 'broadcast.log');
  activeBroadcasts.set(entry.id, { logFile });
  runBroadcast(entry, logFile).catch((err) => {
    console.error(`[广播异常] ${entry.id}: ${err.message}`);
  });
}

async function runBroadcast(entry, logFile) {
  let success = false;
  try {
    appendBroadcastLog(logFile, `[start] ${new Date().toISOString()} id=${entry.id} pid=${process.pid} rpc=${CONFIG.rpc.url}`);
    for (const file of getBroadcastFiles(entry)) {
      appendBroadcastLog(logFile, `[file] ${path.basename(file)}`);
      await broadcastFile(file, logFile);
    }
    success = true;
    console.log(`[广播完成] ${entry.id}`);
    updateEntry(entry.id, 'completed', {
      broadcastFinishedAt: new Date().toISOString(),
      error: null,
    });
  } catch (err) {
    const cur = ledger.entries.find((e) => e.id === entry.id);
    const retries = (cur?.broadcastRetries || 0) + 1;
    const giveUp = retries >= CONFIG.maxBroadcastRetries;
    console.error(`[广播失败] ${entry.id}: ${err.message} retry=${retries}/${CONFIG.maxBroadcastRetries}`);
    appendBroadcastLog(logFile, `[error] ${new Date().toISOString()} ${err.stack || err.message}`);
    updateEntry(entry.id, giveUp ? 'failed' : 'generated', {
      broadcastFinishedAt: new Date().toISOString(),
      broadcastRetries: retries,
      error: err.message,
    });
  } finally {
    activeBroadcasts.delete(entry.id);
    if (!success) closeRpcGate(CONFIG.rpcCooldownAfterGeneratorMs, `broadcast failed: ${entry.id}`);
    drainReadyBroadcasts();
    drainPending();
  }
}

function broadcastFilesReady(entry) {
  return getBroadcastFiles(entry).every((file) => fs.existsSync(file));
}

function getBroadcastFiles(entry) {
  const metadataFile = path.join(entry.outputDir, 'metadata.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    if (meta.files?.prepare && Array.isArray(meta.files.groups)) {
      return [meta.files.prepare, ...meta.files.groups];
    }
  } catch (_) {}

  const files = [path.join(entry.outputDir, 'ft_prepare.txt')];
  for (let i = 0; i < CONFIG.generator.groups; i++) {
    files.push(path.join(entry.outputDir, `ft_group_${i}.txt`));
  }
  return files;
}

async function broadcastFile(file, logFile) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  const batchSize = CONFIG.generator.broadcastBatchSize;
  const delayMs = CONFIG.generator.broadcastDelayMs;
  let batch = [];
  let sent = 0;

  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;
    if (batchSize > 1) {
      batch.push(raw);
      if (batch.length >= batchSize) {
        await broadcastBatch(batch, logFile);
        sent += batch.length;
        batch = [];
        await delay(delayMs);
      }
    } else {
      await sendRawAllowAlready(raw);
      sent++;
      await delay(delayMs);
    }
    if (sent > 0 && sent % 1000 === 0) {
      const mp = await getMempoolSummary();
      appendBroadcastLog(logFile, `  ${path.basename(file)} sent=${sent}${mp ? ` mempool=${mp}` : ''}`);
    }
  }

  if (batch.length > 0) {
    await broadcastBatch(batch, logFile);
    sent += batch.length;
    await delay(delayMs);
  }
  appendBroadcastLog(logFile, `  ${path.basename(file)} done=${sent}`);
}

async function broadcastBatch(batch, logFile) {
  if (batch.length === 1) {
    await sendRawAllowAlready(batch[0]);
    return;
  }
  try {
    const result = await rpc('sendrawtransactions', [
      batch.map((hex) => ({
        hex,
        allowhighfees: false,
        dontcheckfee: false,
      })),
    ], CONFIG.rpcTimeout);
    const summary = summarizeBatchResult(result);
    if (summary.note) appendBroadcastLog(logFile, `  batch=${batch.length} ${summary.note}`);
    if (summary.rejected > 0) {
      throw new Error(`sendrawtransactions rejected ${summary.rejected}/${summary.total}: ${summary.firstError || 'unknown'}`);
    }
  } catch (err) {
    appendBroadcastLog(logFile, `  batch=${batch.length} fallback-single: ${err.message}`);
    for (const raw of batch) await sendRawAllowAlready(raw);
  }
}

function summarizeBatchResult(result) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const invalid = Array.isArray(result.invalid) ? result.invalid : [];
    const evicted = Array.isArray(result.evicted) ? result.evicted : [];
    const known = Array.isArray(result.known) ? result.known : [];
    const rejected = invalid.length + evicted.length;
    const first = invalid[0] || evicted[0] || null;
    const firstError = first
      ? (first.reject_reason || first.rejectReason || first.txid || JSON.stringify(first))
      : null;
    const parts = [];
    if (known.length > 0) parts.push(`known=${known.length}`);
    if (invalid.length > 0) parts.push(`invalid=${invalid.length}`);
    if (evicted.length > 0) parts.push(`evicted=${evicted.length}`);
    return {
      total: known.length + rejected,
      rejected,
      firstError,
      note: parts.length > 0 ? `rpc-result ${parts.join(' ')}` : null,
    };
  }
  if (!Array.isArray(result)) {
    return { total: 0, rejected: 0, firstError: null, note: `unexpected-result=${JSON.stringify(result).slice(0, 500)}` };
  }
  let rejected = 0;
  let firstError = null;
  for (const item of result) {
    const text = JSON.stringify(item);
    const ok =
      item === true ||
      item?.accepted === true ||
      item?.success === true ||
      item?.result === true ||
      typeof item === 'string';
    if (!ok || item?.accepted === false || item?.success === false || item?.error || item?.rejectReason) {
      rejected++;
      if (!firstError) firstError = item?.error?.message || item?.rejectReason || text;
    }
  }
  return { total: result.length, rejected, firstError, note: `array-result size=${result.length} rejected=${rejected}` };
}

async function getMempoolSummary() {
  try {
    const info = await rpc('getmempoolinfo', [], CONFIG.rpcTimeout);
    if (info && typeof info === 'object') {
      const size = info.size ?? info.transactions ?? info.txcount ?? '?';
      const bytes = info.bytes ?? info.usage ?? '?';
      return `${size} bytes=${bytes}`;
    }
  } catch (_) {}
  try {
    const txids = await rpc('getrawmempool', [], CONFIG.rpcTimeout);
    if (Array.isArray(txids)) return String(txids.length);
  } catch (_) {}
  return null;
}

async function sendRawAllowAlready(raw) {
  try {
    await rpc('sendrawtransaction', [raw], CONFIG.rpcTimeout);
  } catch (err) {
    if (isAlreadyAcceptedError(err)) return;
    throw err;
  }
}

function isAlreadyAcceptedError(err) {
  const text = String(err?.message || err);
  return /already|known|duplicate|txn-already/i.test(text);
}

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendBroadcastLog(file, message) {
  fs.appendFileSync(file, message + '\n');
}

function checkGeneratorWatchdogs() {
  const now = Date.now();
  for (const [id, active] of activeGenerators.entries()) {
    const entry = ledger.entries.find((e) => e.id === id);
    if (!entry) continue;

    const bytes = generatedBytes(entry.outputDir);
    if (bytes > active.lastBytes) {
      active.lastBytes = bytes;
      active.lastChangedAt = now;
      continue;
    }

    if (now - active.lastChangedAt < CONFIG.generatorStallTimeoutMs) continue;

    console.error(`[watchdog] ${id} 生成日志 ${Math.floor((now - active.lastChangedAt) / 1000)}s 未增长，终止生成器`);
    try { active.process.kill('SIGTERM'); } catch (_) {}
    safeClose(active.logFd);
    activeGenerators.delete(id);
    closeRpcGate(CONFIG.rpcCooldownAfterGeneratorMs, `watchdog stopped generator: ${id}`);
    updateEntry(id, 'failed', {
      generatorFinishedAt: new Date().toISOString(),
      error: `watchdog: generated files/log stalled for ${CONFIG.generatorStallTimeoutMs}ms`,
    });
  }
}

function generatedBytes(outputDir) {
  let total = 0;
  const names = ['ft_prepare.txt', 'metadata.json', 'automation-ftonly.log'];
  for (let i = 0; i < CONFIG.generator.groups; i++) names.push(`ft_group_${i}.txt`);
  for (const name of names) {
    const file = path.join(outputDir, name);
    try {
      total += fs.statSync(file).size;
    } catch (_) {}
  }
  return total;
}

function safeClose(fd) {
  try { fs.closeSync(fd); } catch (_) {}
}

function loadLedger() {
  if (!fs.existsSync(CONFIG.ledgerFile)) return { entries: [] };
  try {
    return JSON.parse(fs.readFileSync(CONFIG.ledgerFile, 'utf8'));
  } catch (_) {
    return { entries: [] };
  }
}

function saveLedger() {
  fs.writeFileSync(CONFIG.ledgerFile, JSON.stringify(ledger, null, 2));
}

function addEntry(ledgerObj, height, utxo) {
  const id = `${height}-ftonly`;
  const entry = {
    id,
    height,
    status: 'pending',
    sourceUtxo: utxo,
    outputDir: path.join(CONFIG.outputBaseDir, id),
    generatorPid: null,
    generatorStartedAt: null,
    generatorFinishedAt: null,
    broadcastStartedAt: null,
    broadcastFinishedAt: null,
    broadcastRetries: 0,
    seed: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  ledgerObj.entries.push(entry);
  saveLedger();
  return entry;
}

function getLedgerMaxHeight(ledgerObj) {
  return ledgerObj.entries.reduce((max, entry) => {
    return Number.isFinite(entry.height) && entry.height > max ? entry.height : max;
  }, 0);
}

function isHeightTracked(ledgerObj, height) {
  return ledgerObj.entries.some((e) => e.height === height);
}

function updateEntry(id, status, extra = {}) {
  const entry = ledger.entries.find((e) => e.id === id);
  if (!entry) return null;
  entry.status = status;
  Object.assign(entry, extra);
  saveLedger();
  return entry;
}

function recoverStale(ledgerObj) {
  let changed = false;
  for (const e of ledgerObj.entries) {
    if (e.status === 'generating') {
      e.status = 'failed';
      e.error = 'recovery: generator died on restart';
      changed = true;
      console.log(`[恢复] ${e.id}: generating -> failed`);
    } else if (e.status === 'broadcasting') {
      e.status = 'generated';
      e.error = 'recovery: broadcast died on restart';
      changed = true;
      console.log(`[恢复] ${e.id}: broadcasting -> generated`);
    }
  }
  if (changed) saveLedger();
}

function isUtxoUsed(ledgerObj, utxo) {
  return ledgerObj.entries.some((e) =>
    e.sourceUtxo?.txId === utxo.txId &&
    e.sourceUtxo?.outputIndex === utxo.outputIndex
  );
}

let lastStatsAt = 0;
function printStats() {
  const now = Date.now();
  if (now - lastStatsAt < 30000) return;
  lastStatsAt = now;
  const counts = {};
  for (const s of ['pending', 'generating', 'generated', 'broadcasting', 'completed', 'failed']) {
    counts[s] = ledger.entries.filter((e) => e.status === s).length;
  }
  const gate = rpcGateClosedUntil > Date.now()
    ? (rpcGateClosedUntil === Number.MAX_SAFE_INTEGER
      ? ' rpc=closed(active)'
      : ` rpc=closed(${Math.ceil((rpcGateClosedUntil - Date.now()) / 1000)}s)`)
    : ' rpc=open';
  console.log(`[统计] pending=${counts.pending} generating=${counts.generating} generated=${counts.generated} broadcasting=${counts.broadcasting} completed=${counts.completed} failed=${counts.failed}${gate}`);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const k of Object.keys(override)) {
    if (override[k] !== null && typeof override[k] === 'object' && !Array.isArray(override[k])) {
      out[k] = deepMerge(base[k] || {}, override[k]);
    } else {
      out[k] = override[k];
    }
  }
  return out;
}
