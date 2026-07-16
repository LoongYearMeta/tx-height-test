'use strict';

(function checkDependencies() {
    const required = ['axios'];
    const missing = required.filter(pkg => {
        try { require.resolve(pkg); return false; } catch { return true; }
    });
    if (missing.length > 0) {
        console.error('\n缺少依赖包:\n');
        missing.forEach(p => console.error('  - ' + p));
        console.error('\n请运行: npm install\n');
        process.exit(1);
    }
})();

const axios  = require('axios');
const { spawn } = require('child_process');
const fs     = require('fs');
const path   = require('path');

// ========================
// RPC 配置
// ========================
const RPC = {
    url:  'http://localhost:8332',
    auth: { username: 'username', password: 'randompasswd' },
};

// ========================
// 账本配置
// ========================
const LEDGER_FILE     = './mesh-chain-ledger.json';
const OUTPUT_BASE_DIR = './mesh-chain-output';

const COINBASE_PRIV_KEY = 'L1u2TmR7hMMMSV9Bx2Lyt3sujbboqEFqnKygnPRnQERhKB4qptuK';

// ========================
// 自适应流控配置
// ========================
const FLOW_CONFIG = {
    initialDepth:        6000,
    minDepth:            100,
    maxDepth:            10000,
    rpcTimeout:          5000,
    maxBroadcastRetries: 5,
};

// 长子孙链是本脚本的测试对象：单集合构造、单集合广播，避免并行集合污染测量。
const MAX_GENERATORS = 1;
const MAX_BROADCASTS = 1;
const SHUTDOWN_TIMEOUT_MS = 45000;
const RESOURCE_LIMITS = {
    minAvailableMemoryMb: 4096,
    minFreeDiskMb: 20480,
    maxGeneratedBacklog: 2,
    maxMempoolUsageRatio: 0.75,
};

// 设为 true 则不再创建新 pending 条目，仅消耗现有队列
const STOP_CREATING_NEW = false;

// 流控状态
const flowState = {
    currentDepth:    FLOW_CONFIG.initialDepth,
    maxReachedDepth: FLOW_CONFIG.initialDepth,
    congested:       false,
};

const activeGenerators = new Map();
const activeBroadcasts = new Map();
let shuttingDown = false;
let shutdownPromise = null;
let resourceState = { generationAllowed: true, broadcastAllowed: true, reason: '' };
let lastResourceMessage = null;

// ========================
// RPC
// ========================
async function rpc(method, params = [], timeout = 30000) {
    const res = await axios.post(RPC.url, {
        jsonrpc: '1.0', id: 'auto', method, params,
    }, { auth: RPC.auth, timeout });
    if (res.data.error) throw res.data.error;
    return res.data.result;
}

async function getHeight()      { return rpc('getblockcount', [], FLOW_CONFIG.rpcTimeout); }
async function getLatestBlock() {
    const hash = await rpc('getbestblockhash');
    return rpc('getblock', [hash]);
}

async function checkNodeHealth() {
    try {
        await Promise.race([
            rpc('getblockcount', []),
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), FLOW_CONFIG.rpcTimeout)),
        ]);
        return true;
    } catch { return false; }
}

// ========================
// coinbase
// ========================
async function extractCoinbaseUTXO(block) {
    const coinbaseTxId = block.tx[0];
    const raw     = await rpc('getrawtransaction', [coinbaseTxId]);
    const decoded = await rpc('decoderawtransaction', [raw]);
    const vout    = decoded.vout[1];
    return {
        txId:        coinbaseTxId,
        outputIndex: 1,
        satoshis:    Math.floor(vout.value * 1e6),
    };
}

// ========================
// 账本管理
// ========================
function loadLedger() {
    if (!fs.existsSync(LEDGER_FILE)) return { entries: [] };
    try { return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf-8')); }
    catch { return { entries: [] }; }
}

function saveLedger(ledger) {
    const tmp = `${LEDGER_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmp, LEDGER_FILE);
}

function isUtxoUsed(ledger, utxo) {
    return ledger.entries.some(e =>
        e.sourceUtxo?.txId === utxo.txId &&
        e.sourceUtxo?.outputIndex === utxo.outputIndex
    );
}

function addEntry(ledger, height, depth, utxo) {
    const id = `${height}-${depth}`;
    const entry = {
        id, height, depth,
        status:              'pending',
        sourceUtxo:          utxo,
        txFile:              path.join(OUTPUT_BASE_DIR, id, 'transactions.txt'),
        outputDir:           path.join(OUTPUT_BASE_DIR, id),
        broadcastRetries:    0,
        generatorPid:        null,
        generatorStartedAt:  null,
        generatorFinishedAt: null,
        broadcastStartedAt:  null,
        broadcastFinishedAt: null,
        seed:                 null,
        createdAt:           new Date().toISOString(),
        error:               null,
    };
    ledger.entries.push(entry);
    saveLedger(ledger);
    return entry;
}

function byStatus(ledger, status) { return ledger.entries.filter(e => e.status === status); }

function updateEntry(ledger, id, status, extra = {}) {
    const entry = ledger.entries.find(e => e.id === id);
    if (entry) { entry.status = status; Object.assign(entry, extra); saveLedger(ledger); }
    return entry;
}

// ========================
// 启动时状态恢复
// ========================
function recoverStale(ledger) {
    let changed = false;
    for (const e of ledger.entries) {
        if (e.status === 'generating') {
            // 构造文件不做中间拼接；保留 seed，从头确定性重建。
            e.status = 'pending'; e.generatorPid = null; e.error = null; changed = true;
            console.log(`[恢复] ${e.id}: generating → pending（原 seed 重建）`);
        } else if (e.status === 'broadcasting') {
            // tx 文件已写入磁盘，回退到 generated 让广播重试
            e.status = 'generated'; e.error = null; changed = true;
            console.log(`[恢复] ${e.id}: broadcasting → generated (tx文件保留，等待重试广播)`);
        } else if (
            e.status === 'failed' &&
            e.error === 'recovery: broadcast died on restart' &&
            e.broadcastRetries < FLOW_CONFIG.maxBroadcastRetries &&
            e.txFile && fs.existsSync(e.txFile)
        ) {
            // 历史遗留：旧版本错误地把 broadcasting→failed，但 tx 文件仍在，可补救重试
            e.status = 'generated'; e.error = null; changed = true;
            console.log(`[恢复] ${e.id}: failed(broadcast-killed) → generated (tx文件存在，补救重试)`);
        }
    }
    if (changed) saveLedger(ledger);
}

// ========================
// 自适应流控
// ========================
function adjustDepth(success, healthy) {
    const old = flowState.currentDepth;
    if (!success || !healthy) {
        flowState.currentDepth = Math.max(FLOW_CONFIG.minDepth, Math.floor(flowState.currentDepth / 2));
        flowState.congested = true;
    } else {
        const inc = Math.max(1, Math.floor(Math.sqrt(flowState.currentDepth)));
        flowState.currentDepth = Math.min(FLOW_CONFIG.maxDepth, flowState.currentDepth + inc);
        flowState.congested = false;
    }
    flowState.maxReachedDepth = Math.max(flowState.maxReachedDepth, flowState.currentDepth);
    const arrow = flowState.congested ? '↓' : '↑';
    console.log(`[流控] broadcast=${success} healthy=${healthy}  depth ${old} ${arrow} ${flowState.currentDepth}`);
}

// ========================
// 进程管理
// ========================
function startGenerator(ledger, entry, depth) {
    console.log(`\n[生成] 启动 generator: ${entry.id}  depth=${depth}`);

    fs.mkdirSync(entry.outputDir, { recursive: true });
    const logFd = fs.openSync(path.join(entry.outputDir, 'generator.log'), 'a');

    const seed = entry.seed || Date.now();
    const args = [
        'generator-mesh-tx.js',
        '--txid',     entry.sourceUtxo.txId,
        '--vout',     String(entry.sourceUtxo.outputIndex),
        '--satoshis', String(entry.sourceUtxo.satoshis),
        '--depth',    String(depth),
        '--outputdir', entry.outputDir,
        '--privkey',  COINBASE_PRIV_KEY,
        '--seed',     String(seed),
        '--reuse-keys',
    ];

    const child = spawn('node', args, { stdio: ['ignore', logFd, logFd] });

    updateEntry(ledger, entry.id, 'generating', {
        generatorPid:       child.pid,
        generatorStartedAt: new Date().toISOString(),
        seed,
    });
    activeGenerators.set(entry.id, { pid: child.pid, process: child, logFd });

    child.on('exit', (code) => {
        try { fs.closeSync(logFd); } catch (_) {}
        activeGenerators.delete(entry.id);
        const ts = new Date().toISOString();
        if (shuttingDown) {
            console.log(`[退出保存] ${entry.id}: generating → pending`);
            updateEntry(ledger, entry.id, 'pending', {
                generatorPid: null, generatorFinishedAt: ts, interruptedAt: ts, error: null,
            });
        } else if (code === 0) {
            console.log(`[生成完成] ${entry.id}`);
            updateEntry(ledger, entry.id, 'generated', { generatorFinishedAt: ts });
            drainReadyBroadcasts(ledger);
        } else {
            console.error(`[生成失败] ${entry.id}  code=${code}`);
            updateEntry(ledger, entry.id, 'failed', {
                generatorFinishedAt: ts,
                error: `generator exit code=${code}`,
            });
        }
        // 生成器槽位释放，立即尝试启动等待中的 pending
        if (!shuttingDown) drainPendingGenerators(ledger);
    });

    child.on('error', (err) => {
        try { fs.closeSync(logFd); } catch (_) {}
        activeGenerators.delete(entry.id);
        if (shuttingDown) {
            updateEntry(ledger, entry.id, 'pending', {
                generatorPid: null, interruptedAt: new Date().toISOString(), error: null,
            });
            return;
        }
        console.error(`[生成错误] ${entry.id}: ${err.message}`);
        updateEntry(ledger, entry.id, 'failed', {
            generatorFinishedAt: new Date().toISOString(),
            error: err.message,
        });
        drainPendingGenerators(ledger);
    });
}

function drainPendingGenerators(ledger) {
    if (shuttingDown) return;
    if (!resourceState.generationAllowed) return;
    while (activeGenerators.size < MAX_GENERATORS) {
        const pending = byStatus(ledger, 'pending');
        if (pending.length === 0) break;
        startGenerator(ledger, pending[0], pending[0].depth);
    }
}

function drainReadyBroadcasts(ledger) {
    if (shuttingDown) return;
    if (!resourceState.broadcastAllowed) return;
    const ready = byStatus(ledger, 'generated').filter(e => fs.existsSync(e.txFile));
    if (ready.length === 0) return;

    // 主广播：始终保持一个在跑
    if (activeBroadcasts.size < 1) {
        startBroadcast(ledger, ready.shift());
    }

    // 备广播：仅在节点非拥塞时启动
    if (activeBroadcasts.size < MAX_BROADCASTS && !flowState.congested && ready.length > 0) {
        startBroadcast(ledger, ready[0]);
    }
}

function startBroadcast(ledger, entry) {
    console.log(`\n[广播] 启动  id=${entry.id}`);

    updateEntry(ledger, entry.id, 'broadcasting', {
        broadcastStartedAt: new Date().toISOString(),
    });

    const logFd = fs.openSync(path.join(entry.outputDir, 'broadcast.log'), 'a');
    const child = spawn('node', ['broadcast.js', '--file', entry.txFile, '--batch',
        '--rpc-url',  RPC.url,
        '--rpc-user', RPC.auth.username,
        '--rpc-pass', RPC.auth.password,
        '--dont-check-fee',
    ], {
        stdio: ['ignore', logFd, logFd],
    });

    activeBroadcasts.set(entry.id, { process: child, logFd });

    child.on('exit', async (code) => {
        try { fs.closeSync(logFd); } catch (_) {}
        activeBroadcasts.delete(entry.id);
        const ts              = new Date().toISOString();
        if (shuttingDown || code === 3) {
            console.log(`[退出保存] ${entry.id}: broadcasting → generated`);
            updateEntry(ledger, entry.id, 'generated', {
                broadcastFinishedAt: ts, interruptedAt: ts, error: null,
            });
            return;
        }
        const success         = code === 0;
        const permanentReject = code === 2;  // 节点明确永久拒绝（low_fee / missing_inputs 全量）

        if (success) {
            console.log(`[广播完成] ${entry.id}`);
            updateEntry(ledger, entry.id, 'completed', { broadcastFinishedAt: ts });
        } else if (permanentReject) {
            console.error(`[广播拒绝] ${entry.id}  节点永久拒绝，放弃`);
            updateEntry(ledger, entry.id, 'rejected', {
                broadcastFinishedAt: ts,
                error: 'broadcast permanently rejected by node (exit code 2)',
            });
        } else {
            const cur     = ledger.entries.find(e => e.id === entry.id);
            const retries = (cur?.broadcastRetries || 0) + 1;
            if (retries >= FLOW_CONFIG.maxBroadcastRetries) {
                console.error(`[广播放弃] ${entry.id}  重试 ${retries} 次`);
                updateEntry(ledger, entry.id, 'failed', {
                    broadcastFinishedAt: ts,
                    broadcastRetries: retries,
                    error: `broadcast failed after ${retries} retries`,
                });
            } else {
                console.error(`[广播失败] ${entry.id}  code=${code}  重试${retries}/${FLOW_CONFIG.maxBroadcastRetries}`);
                updateEntry(ledger, entry.id, 'generated', {
                    broadcastFinishedAt: ts,
                    broadcastRetries: retries,
                    error: `broadcast exit code=${code}`,
                });
            }
        }

        const healthy = await checkNodeHealth();
        adjustDepth(success, healthy);
        drainReadyBroadcasts(ledger);
    });

    child.on('error', async (err) => {
        try { fs.closeSync(logFd); } catch (_) {}
        activeBroadcasts.delete(entry.id);
        if (shuttingDown) {
            updateEntry(ledger, entry.id, 'generated', {
                interruptedAt: new Date().toISOString(), error: null,
            });
            return;
        }
        const cur     = ledger.entries.find(e => e.id === entry.id);
        const retries = (cur?.broadcastRetries || 0) + 1;
        if (retries >= FLOW_CONFIG.maxBroadcastRetries) {
            updateEntry(ledger, entry.id, 'failed', { error: err.message, broadcastRetries: retries });
        } else {
            updateEntry(ledger, entry.id, 'generated', { error: err.message, broadcastRetries: retries });
        }
        const healthy = await checkNodeHealth();
        adjustDepth(false, healthy);
        drainReadyBroadcasts(ledger);
    });
}

// ========================
// 统计
// ========================
let lastStatsTime = 0;

function printStats(ledger) {
    const counts = {};
    for (const s of ['pending','generating','generated','broadcasting','completed','failed','rejected']) {
        counts[s] = byStatus(ledger, s).length;
    }
    console.log('\n=== 系统统计 ===');
    console.log(`depth: ${flowState.currentDepth} | 峰值: ${flowState.maxReachedDepth} | 拥塞: ${flowState.congested}`);
    console.log(`状态: pending=${counts.pending} gen=${counts.generating} generated=${counts.generated} bc=${counts.broadcasting} done=${counts.completed} fail=${counts.failed} rejected=${counts.rejected}`);
    console.log('================\n');
}

// ========================
// 主循环
// ========================
let ledger     = loadLedger();
let lastHeight = 0;
recoverStale(ledger);

async function mainLoop() {
    if (shuttingDown) return;
    const healthy = await checkNodeHealth();
    if (!healthy) { console.log('[警告] 节点RPC不响应'); return; }
    await refreshResourceState();

    let height;
    try { height = await getHeight(); }
    catch { return; }

    if (lastHeight === 0) {
        lastHeight = height;
        console.log(`[初始化] 当前高度=${height}  账本记录=${ledger.entries.length}`);
        return;
    }

    // ---- 新区块 ----
    if (height > lastHeight) {
        console.log(`\n[新区块] ${lastHeight} → ${height}`);
        lastHeight = height;

        if (STOP_CREATING_NEW) {
            console.log(`[跳过] STOP_CREATING_NEW=${STOP_CREATING_NEW}，不再创建新pending条目`);
        } else {
            let utxo;
            try {
                const block = await getLatestBlock();
                utxo = await extractCoinbaseUTXO(block);
            } catch (e) {
                console.error(`[错误] 提取coinbase失败: ${e.message}`);
                return;
            }

            if (isUtxoUsed(ledger, utxo)) {
                console.log(`[跳过] UTXO已使用: ${utxo.txId}:${utxo.outputIndex}`);
            } else {
                const depth = flowState.currentDepth;
                const entry = addEntry(ledger, height, depth, utxo);
                console.log(`[账本] 新记录: ${entry.id}  depth=${depth}`);

                if (resourceState.generationAllowed && activeGenerators.size < MAX_GENERATORS) {
                    startGenerator(ledger, entry, depth);
                } else {
                    console.log(`[限流] ${entry.id} 等待 pending（active=${activeGenerators.size}/${MAX_GENERATORS}${resourceState.reason ? `, ${resourceState.reason}` : ''}）`);
                }
            }
        }
    }

    // ---- pending 生成器补空 ----
    drainPendingGenerators(ledger);

    // ---- 已生成 → 广播（主备双发）----
    drainReadyBroadcasts(ledger);

    // ---- 定期统计 ----
    if (Date.now() - lastStatsTime > 30000) {
        printStats(ledger);
        lastStatsTime = Date.now();
    }

    // ---- 队列耗尽检测 ----
    const hasPending = byStatus(ledger, 'pending').length > 0;
    const hasGenerating = byStatus(ledger, 'generating').length > 0;
    const hasGenerated = byStatus(ledger, 'generated').length > 0;
    const hasBroadcasting = byStatus(ledger, 'broadcasting').length > 0;

    if (STOP_CREATING_NEW && !hasPending && !hasGenerating && !hasGenerated && !hasBroadcasting) {
        console.log('\n[完成] 所有队列已清空（无 pending/generating/generated/broadcasting），程序退出');
        requestShutdown('completed');
    }
}

async function refreshResourceState() {
    const availableMemoryMb = getAvailableMemoryMb();
    const freeDiskMb = getFreeDiskMb(OUTPUT_BASE_DIR);
    const backlog = ledger.entries.filter(e => e.status === 'generated' || e.status === 'broadcasting').length;
    let mempool = null;
    try { mempool = await rpc('getmempoolinfo', [], FLOW_CONFIG.rpcTimeout); } catch (_) {}
    const usage = Number(mempool?.usage ?? mempool?.bytes ?? 0);
    const maximum = Number(mempool?.maxmempool ?? 0);
    const mempoolRatio = maximum > 0 ? usage / maximum : 0;
    const reasons = [];
    if (availableMemoryMb < RESOURCE_LIMITS.minAvailableMemoryMb) reasons.push(`memory ${availableMemoryMb}MB<${RESOURCE_LIMITS.minAvailableMemoryMb}MB`);
    if (freeDiskMb < RESOURCE_LIMITS.minFreeDiskMb) reasons.push(`disk ${freeDiskMb}MB<${RESOURCE_LIMITS.minFreeDiskMb}MB`);
    if (backlog >= RESOURCE_LIMITS.maxGeneratedBacklog) reasons.push(`backlog ${backlog}>=${RESOURCE_LIMITS.maxGeneratedBacklog}`);
    if (mempoolRatio >= RESOURCE_LIMITS.maxMempoolUsageRatio) reasons.push(`mempool ${(mempoolRatio * 100).toFixed(1)}%`);
    resourceState = {
        generationAllowed: reasons.length === 0,
        broadcastAllowed: mempoolRatio < RESOURCE_LIMITS.maxMempoolUsageRatio,
        reason: reasons.join(', '),
    };
    const signature = reasons.length ? `paused:${reasons.join('|')}` : 'healthy';
    if (signature !== lastResourceMessage) {
        console.log(reasons.length
            ? `[资源暂停] ${resourceState.reason}`
            : `[资源正常] memory=${availableMemoryMb}MB disk=${freeDiskMb}MB mempool=${(mempoolRatio * 100).toFixed(1)}%`);
        lastResourceMessage = signature;
    }
}

function getAvailableMemoryMb() {
    try {
        const match = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB$/m);
        if (match) return Math.floor(Number(match[1]) / 1024);
    } catch (_) {}
    return Number.MAX_SAFE_INTEGER;
}

function getFreeDiskMb(target) {
    try {
        fs.mkdirSync(target, { recursive: true });
        const stat = fs.statfsSync(target);
        return Math.floor(Number(stat.bavail) * Number(stat.bsize) / 1024 / 1024);
    } catch (_) {
        return Number.MAX_SAFE_INTEGER;
    }
}

// ========================
// 启动
// ========================
console.log('=== 自动压测控制器启动（P2PKH）===');
console.log(`[流控] 初始 depth=${FLOW_CONFIG.initialDepth}  范围=${FLOW_CONFIG.minDepth}~${FLOW_CONFIG.maxDepth}`);

const loopTimer = setInterval(() => mainLoop().catch(e => console.error('[mainLoop]', e.message)), 2000);

process.on('SIGINT',  () => requestShutdown('SIGINT'));
process.on('SIGTERM', () => requestShutdown('SIGTERM'));

function requestShutdown(sig) {
    if (shutdownPromise) return process.exit(1);
    shutdownPromise = shutdown(sig).catch(err => {
        console.error('[退出失败]', err);
        process.exit(1);
    });
}

async function shutdown(sig) {
    shuttingDown = true;
    clearInterval(loopTimer);
    console.log(`\n[退出] ${sig}，停止派发新任务`);
    const waits = [];
    for (const [id, { process: p }] of activeGenerators) {
        console.log(`  停止 generator ${id}（重启后原 seed 重建）`);
        waits.push(waitForExit(p));
        try { p.kill('SIGTERM'); } catch (_) {}
    }
    for (const [id, { process: p }] of activeBroadcasts) {
        console.log(`  暂停 broadcast ${id}（保存 progress.json）`);
        waits.push(waitForExit(p));
        try { p.kill('SIGTERM'); } catch (_) {}
    }
    await Promise.race([Promise.allSettled(waits), delay(SHUTDOWN_TIMEOUT_MS)]);
    for (const id of activeGenerators.keys()) updateEntry(ledger, id, 'pending', { generatorPid: null, error: null });
    for (const id of activeBroadcasts.keys()) updateEntry(ledger, id, 'generated', { error: null });
    saveLedger(ledger);
    console.log('[退出完成] 状态已保存');
    process.exit(0);
}

function waitForExit(child) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => child.once('exit', resolve));
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
