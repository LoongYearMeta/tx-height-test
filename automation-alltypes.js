'use strict';

/**
 * automation-alltypes.js — 混合类型全自动压测框架
 *
 * 在 automation.js 架构基础上新增：
 *   · 策略注册表（STRATEGIES）：每种测试场景在此注册，主逻辑不动
 *   · 策略轮换：启动/每 N 块 → showcase 验证；其余 → mesh 压测
 *   · 钩子系统（HOOKS）：gen完成/broadcast完成/每轮结束，可注入自定义逻辑
 *   · JSON 配置文件支持，覆盖任意默认值
 *
 * 未来添加新场景（如 reorg-test）：
 *   1. 在 STRATEGIES 加一条记录（script/extraArgs/broadcastArgs）
 *   2. 在 selectStrategy() 里决定何时触发
 *   3. 在 HOOKS 里注册验证逻辑（可选）
 *   无需修改主循环和账本逻辑
 *
 * 用法：
 *   node automation-alltypes.js [--config ./my-config.json]
 */

(function checkDependencies() {
    const required = ['axios', 'minimist'];
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
const minimist = require('minimist');

const argv = minimist(process.argv.slice(2), { string: ['config'] });

// ==================== 默认配置 ====================

const DEFAULTS = {
    rpc: {
        url:      'http://localhost:8332',
        username: 'username',
        password: 'randompasswd',
    },
    coinbasePrivKey: 'L1u2TmR7hMMMSV9Bx2Lyt3sujbboqEFqnKygnPRnQERhKB4qptuK',
    outputBaseDir:   './mesh-chain-output',
    ledgerFile:      './automation-alltypes-ledger.json',

    // 策略轮换：每隔多少个 mesh 轮次插入一次 showcase
    showcaseInterval: 10,
    // showcase 的每种类型建多少层
    showcaseDepth: 5,

    // 自适应流控（与 automation.js 相同算法）
    flow: {
        initialDepth: 1000,
        minDepth:     100,
        maxDepth:     10000,
    },

    // broadcast 最多重试次数
    maxBroadcastRetries: 5,

    // 混合场景允许有限构造并行；集合广播默认单路，避免争抢节点验证资源。
    maxGenerators: 2,
    maxBroadcasts: 1,
    shutdownTimeoutMs: 45000,
    stopCreatingNew: false,
    dontCheckFee: true,
    resourceLimits: {
        minAvailableMemoryMb: 4096,
        minFreeDiskMb: 20480,
        maxGeneratedBacklog: 2,
        maxMempoolUsageRatio: 0.75,
    },

    // RPC 轮询间隔 (ms)
    pollInterval: 2000,
    rpcTimeout:   5000,
};

// 合并外部配置
let CONFIG = JSON.parse(JSON.stringify(DEFAULTS));
if (argv.config && fs.existsSync(argv.config)) {
    const ext = JSON.parse(fs.readFileSync(argv.config, 'utf-8'));
    CONFIG = deepMerge(CONFIG, ext);
    console.log(`[配置] 已加载: ${argv.config}`);
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

// ==================== 策略注册表 ====================
//
// 每条记录描述一种完整的测试场景：
//   script       : 生成器脚本文件名
//   mode         : 'mesh' | 'showcase' | 'custom'
//   extraArgs    : 传给生成器的额外参数（数组）
//   broadcastArgs: 传给 broadcast.js 的额外参数（[] 或 ['--batch']）
//   minSatoshis  : 该策略最低资金要求（低于此跳过）
//   description  : 日志展示用
//
// 添加新策略：在此添加一条记录，主循环自动支持

const STRATEGIES = {
    'showcase-alltypes': {
        script:        'generator-mesh-alltypes-tx.js',
        mode:          'showcase',
        extraArgs:     () => ['--showcase', '--showcasedepth', String(CONFIG.showcaseDepth)],
        broadcastArgs: ['--batch'],
        minSatoshis:   10_010_000,   // 5 slots × 2M + 10k
        description:   '全类型展示验证（证明所有类型可持续生成）',
    },

    'mesh-alltypes': {
        script:        'generator-mesh-alltypes-tx.js',
        mode:          'mesh',
        extraArgs:     () => [],     // depth 由流控决定，主循环注入
        broadcastArgs: ['--batch'],
        minSatoshis:   200_000,      // depth * fee * 2 的近似下界
        description:   '混合类型网状链压测（P2PKH/FT/NFT/PoolNFT/Other）',
    },

    'mesh-p2pkh': {
        script:        'generator-mesh-tx.js',
        mode:          'mesh',
        extraArgs:     () => [],
        broadcastArgs: ['--batch'],
        minSatoshis:   100_000,
        description:   '纯P2PKH网状链压测（兼容旧 automation.js 场景）',
    },

    // ---- 未来场景示例（注释中，需要时取消注释） ----
    // 'reorg-test': {
    //     script:        'test-reorg.js',
    //     mode:          'custom',
    //     extraArgs:     () => ['gen', '--txid1', '...', ...],
    //     broadcastArgs: [],
    //     minSatoshis:   0,
    //     description:   '重组+冲突覆盖测试（手动触发）',
    // },
};

// ==================== 策略选择器 ====================
//
// 决定本轮用哪个策略。修改此函数即可改变轮换规则，不影响主循环。

function selectStrategy(roundStats) {
    const { meshRounds, lastShowcasePassed } = roundStats;

    // 每次启动仅触发一次 showcase，之后全走 mesh
    if (sessionShowcaseQueued) return 'mesh-alltypes';

    if (meshRounds === 0 || meshRounds % CONFIG.showcaseInterval === 0) {
        return 'showcase-alltypes';
    }
    if (lastShowcasePassed === false) {
        return 'showcase-alltypes';
    }
    return 'mesh-alltypes';
}

// ==================== 钩子系统 ====================
//
// 每个阶段结束后触发对应 hooks，供外部注入验证逻辑。
// 添加钩子：HOOKS['generate:done'].push(async (entry, strategy) => { ... });

const HOOKS = {
    'generate:done':   [],   // (entry, strategy) → 生成完成后
    'broadcast:done':  [],   // (entry, strategy, success) → 广播完成后
    'round:done':      [],   // (roundStats) → 每轮结束后
    'showcase:result': [],   // (entry, passed) → showcase 广播完后（可解析日志确认通过）
};

async function runHooks(event, ...args) {
    for (const fn of HOOKS[event] || []) {
        try { await fn(...args); } catch (e) {
            console.error(`[hook:${event}] 异常: ${e.message}`);
        }
    }
}

// ==================== RPC ====================

async function rpcCall(method, params = [], timeout = 30000) {
    const res = await axios.post(CONFIG.rpc.url, {
        jsonrpc: '1.0', id: 'auto', method, params,
    }, {
        auth: { username: CONFIG.rpc.username, password: CONFIG.rpc.password },
        timeout,
    });
    if (res.data.error) throw res.data.error;
    return res.data.result;
}

async function getHeight() { return rpcCall('getblockcount', [], CONFIG.rpcTimeout); }

async function getLatestBlock() {
    const hash = await rpcCall('getbestblockhash');
    return rpcCall('getblock', [hash]);
}

async function extractCoinbaseUTXO(block) {
    const coinbaseTxId = block.tx[0];
    const raw     = await rpcCall('getrawtransaction', [coinbaseTxId]);
    const decoded = await rpcCall('decoderawtransaction', [raw]);
    const vout    = decoded.vout[1];
    return {
        txId:        coinbaseTxId,
        outputIndex: 1,
        satoshis:    Math.floor(vout.value * 1e6),
    };
}

async function checkNodeHealth() {
    try {
        await Promise.race([
            rpcCall('getblockcount', []),
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), CONFIG.rpcTimeout)),
        ]);
        return true;
    } catch { return false; }
}

// ==================== 账本 ====================

function loadLedger() {
    if (!fs.existsSync(CONFIG.ledgerFile)) return { entries: [] };
    try { return JSON.parse(fs.readFileSync(CONFIG.ledgerFile, 'utf-8')); }
    catch { return { entries: [] }; }
}

function saveLedger(ledger) {
    const tmp = `${CONFIG.ledgerFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmp, CONFIG.ledgerFile);
}

function isUtxoUsed(ledger, utxo) {
    return ledger.entries.some(e =>
        e.sourceUtxo?.txId === utxo.txId &&
        e.sourceUtxo?.outputIndex === utxo.outputIndex
    );
}

function addEntry(ledger, height, depth, utxo, strategyName) {
    const id = `${height}-${depth}-${strategyName}`;
    const entry = {
        id, height, depth, strategyName,
        status: 'pending',
        sourceUtxo: utxo,
        txFile: path.join(CONFIG.outputBaseDir, id, 'transactions.txt'),
        outputDir:  path.join(CONFIG.outputBaseDir, id),
        broadcastRetries: 0,
        generatorPid: null,
        generatorStartedAt: null, generatorFinishedAt: null,
        broadcastStartedAt: null, broadcastFinishedAt: null,
        seed: null,
        createdAt: new Date().toISOString(),
        error: null,
    };
    ledger.entries.push(entry);
    saveLedger(ledger);
    return entry;
}

function updateEntry(ledger, id, status, extra = {}) {
    const entry = ledger.entries.find(e => e.id === id);
    if (entry) { entry.status = status; Object.assign(entry, extra); saveLedger(ledger); }
    return entry;
}

function byStatus(ledger, status) { return ledger.entries.filter(e => e.status === status); }

function recoverStale(ledger) {
    let changed = false;
    for (const e of ledger.entries) {
        if (e.status === 'generating') {
            // 构造不拼接半成品；保留 seed，从头确定性重建同一集合。
            e.status = 'pending'; e.generatorPid = null; e.error = null; changed = true;
            console.log(`[恢复] ${e.id}: generating → pending（原 seed 重建）`);
        } else if (e.status === 'broadcasting') {
            // 进程被杀时 tx 文件已存在，回退到 generated 让广播重试
            e.status = 'generated'; e.error = null; changed = true;
            console.log(`[恢复] ${e.id}: broadcasting → generated (tx文件保留，等待重试广播)`);
        } else if (
            e.status === 'failed' &&
            e.error === 'recovery: broadcast died on restart' &&
            e.broadcastRetries < CONFIG.maxBroadcastRetries &&
            e.txFile && fs.existsSync(e.txFile)
        ) {
            // 历史遗留：之前的 recoverStale 错误地把 broadcasting→failed，
            // 但 tx 文件仍在，可以继续广播
            e.status = 'generated'; e.error = null; changed = true;
            console.log(`[恢复] ${e.id}: failed(broadcast-killed) → generated (tx文件存在，补救重试)`);
        }
    }
    if (changed) saveLedger(ledger);
}

// ==================== 自适应流控 ====================

const flowState = {
    currentDepth:    CONFIG.flow.initialDepth,
    maxReachedDepth: CONFIG.flow.initialDepth,
    congested: false,
};

function adjustDepth(success, healthy) {
    const old = flowState.currentDepth;
    if (!success || !healthy) {
        flowState.currentDepth = Math.max(CONFIG.flow.minDepth, Math.floor(flowState.currentDepth / 2));
        flowState.congested = true;
    } else {
        const inc = Math.max(1, Math.floor(Math.sqrt(flowState.currentDepth)));
        flowState.currentDepth = Math.min(CONFIG.flow.maxDepth, flowState.currentDepth + inc);
        flowState.congested = false;
    }
    flowState.maxReachedDepth = Math.max(flowState.maxReachedDepth, flowState.currentDepth);
    const arrow = flowState.congested ? '↓' : '↑';
    console.log(`[流控] broadcast=${success} healthy=${healthy}  depth ${old} ${arrow} ${flowState.currentDepth}`);
}

// ==================== 进程管理 ====================

const MAX_GENERATORS = Math.max(1, Number(CONFIG.maxGenerators) || 1);
const MAX_BROADCASTS = Math.max(1, Number(CONFIG.maxBroadcasts) || 1);
const SHUTDOWN_TIMEOUT_MS = Math.max(1000, Number(CONFIG.shutdownTimeoutMs) || 45000);

// 设为 true 则不再创建新 pending 条目，仅消耗现有队列
const STOP_CREATING_NEW = Boolean(CONFIG.stopCreatingNew);

const activeGenerators = new Map();
const activeBroadcasts = new Map();
let shuttingDown = false;
let shutdownPromise = null;
let resourceState = { generationAllowed: true, broadcastAllowed: true, reason: '' };
let lastResourceMessage = null;

function startGenerator(ledger, entry, depth) {
    const strategy = STRATEGIES[entry.strategyName];
    if (!strategy) { console.error(`[生成] 未知策略: ${entry.strategyName}`); return; }

    console.log(`\n[生成] 启动 ${entry.strategyName}  id=${entry.id}`);
    console.log(`       script=${strategy.script}  ${strategy.description}`);

    fs.mkdirSync(entry.outputDir, { recursive: true });
    const logFd = fs.openSync(path.join(entry.outputDir, 'generator.log'), 'a');

    // 构造中断后沿用该 seed，从头确定性重建同一交易集合。
    const seed = entry.seed || Date.now();
    const args = [
        strategy.script,
        '--txid',     entry.sourceUtxo.txId,
        '--vout',     String(entry.sourceUtxo.outputIndex),
        '--satoshis', String(entry.sourceUtxo.satoshis),
        '--privkey',  CONFIG.coinbasePrivKey,
        '--outputdir', entry.outputDir,
        '--seed', String(seed),
        '--reuse-keys',
    ];

    // mesh 模式注入深度；showcase/custom 模式用策略自定义 args
    if (strategy.mode === 'mesh') {
        args.push('--depth', String(depth));
    }
    args.push(...strategy.extraArgs());

    const child = spawn('node', args, { stdio: ['ignore', logFd, logFd] });

    updateEntry(ledger, entry.id, 'generating', {
        generatorPid: child.pid,
        generatorStartedAt: new Date().toISOString(),
        seed,
    });
    activeGenerators.set(entry.id, { pid: child.pid, process: child, logFd });

    child.on('exit', async (code) => {
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
            await runHooks('generate:done', entry, strategy);
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

    // 主广播：始终保持一个在跑，只要节点健康（mainLoop 已做健康门控）
    if (activeBroadcasts.size < 1) {
        startBroadcast(ledger, ready.shift());
    }

    // 备广播：仅在节点非拥塞时启动，节点压力大时让出带宽给主广播
    if (activeBroadcasts.size < MAX_BROADCASTS && !flowState.congested && ready.length > 0) {
        startBroadcast(ledger, ready[0]);
    }
}

function startBroadcast(ledger, entry) {
    const strategy = STRATEGIES[entry.strategyName];
    console.log(`\n[广播] 启动  id=${entry.id}`);

    updateEntry(ledger, entry.id, 'broadcasting', {
        broadcastStartedAt: new Date().toISOString(),
    });

    const logFd = fs.openSync(path.join(entry.outputDir, 'broadcast.log'), 'a');
    const args  = ['broadcast.js', '--file', entry.txFile,
        '--rpc-url',  CONFIG.rpc.url,
        '--rpc-user', CONFIG.rpc.username,
        '--rpc-pass', CONFIG.rpc.password,
        ...(CONFIG.dontCheckFee ? ['--dont-check-fee'] : []),
        ...(strategy?.broadcastArgs || [])];
    const child = spawn('node', args, { stdio: ['ignore', logFd, logFd] });

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
        const permanentReject = code === 2;  // broadcast.js 明确判定为节点永久拒绝

        if (success) {
            console.log(`[广播完成] ${entry.id}`);
            updateEntry(ledger, entry.id, 'completed', { broadcastFinishedAt: ts });
            roundStats.totalRounds++;
            if (entry.strategyName.startsWith('showcase')) {
                roundStats.lastShowcasePassed = true;
                if (roundStats.meshRounds === 0) roundStats.meshRounds = 1;
                await runHooks('showcase:result', entry, true);
            } else {
                roundStats.meshRounds++;
            }
        } else if (permanentReject) {
            // 节点明确拒绝（low_fee / 全量 missing_inputs），后代也无法上链，不再重试
            console.error(`[广播拒绝] ${entry.id}  节点永久拒绝，放弃`);
            updateEntry(ledger, entry.id, 'rejected', {
                broadcastFinishedAt: ts,
                error: 'broadcast permanently rejected by node (exit code 2)',
            });
            if (entry.strategyName.startsWith('showcase')) {
                roundStats.lastShowcasePassed = false;
                await runHooks('showcase:result', entry, false);
            }
        } else {
            const cur     = ledger.entries.find(e => e.id === entry.id);
            const retries = (cur?.broadcastRetries || 0) + 1;
            if (retries >= CONFIG.maxBroadcastRetries) {
                console.error(`[广播放弃] ${entry.id}  重试 ${retries} 次`);
                updateEntry(ledger, entry.id, 'failed', {
                    broadcastFinishedAt: ts,
                    broadcastRetries: retries,
                    error: `broadcast failed after ${retries} retries`,
                });
                if (entry.strategyName.startsWith('showcase')) {
                    roundStats.lastShowcasePassed = false;
                    await runHooks('showcase:result', entry, false);
                }
            } else {
                console.error(`[广播失败] ${entry.id}  code=${code}  重试${retries}/${CONFIG.maxBroadcastRetries}`);
                updateEntry(ledger, entry.id, 'generated', {
                    broadcastFinishedAt: ts,
                    broadcastRetries: retries,
                    error: `broadcast exit code=${code}`,
                });
            }
        }

        const healthy = await checkNodeHealth();
        adjustDepth(success, healthy);
        await runHooks('broadcast:done', entry, strategy, success);
        await runHooks('round:done', roundStats);
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
        if (retries >= CONFIG.maxBroadcastRetries) {
            updateEntry(ledger, entry.id, 'failed', { error: err.message, broadcastRetries: retries });
        } else {
            updateEntry(ledger, entry.id, 'generated', { error: err.message, broadcastRetries: retries });
        }
        const healthy = await checkNodeHealth();
        adjustDepth(false, healthy);
        drainReadyBroadcasts(ledger);
    });
}

// ==================== 统计 ====================

const roundStats = {
    meshRounds:        0,
    totalRounds:       0,
    lastShowcasePassed: null,  // null=未运行, true=通过, false=失败
};

let sessionShowcaseQueued = false;  // 每次启动仅触发一次 showcase

let lastStatsTime = 0;

function printStats(ledger) {
    const counts = {};
    for (const s of ['pending','generating','generated','broadcasting','completed','failed']) {
        counts[s] = byStatus(ledger, s).length;
    }
    console.log('\n=== 运行统计 ===');
    console.log(`深度: ${flowState.currentDepth} | 峰值: ${flowState.maxReachedDepth} | 拥塞: ${flowState.congested}`);
    console.log(`总轮次: ${roundStats.totalRounds} | mesh轮: ${roundStats.meshRounds} | showcase: ${roundStats.lastShowcasePassed === null ? '未运行' : roundStats.lastShowcasePassed ? '最近通过' : '最近失败'}`);
    console.log(`状态: pending=${counts.pending} gen=${counts.generating} generated=${counts.generated} bc=${counts.broadcasting} done=${counts.completed} fail=${counts.failed}`);
    console.log('================\n');
}

// ==================== 主循环 ====================

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
        console.log('[策略表]', Object.entries(STRATEGIES).map(([k, v]) => `\n  ${k}: ${v.description}`).join(''));
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
                return;
            }

            // 选策略
            const strategyName = selectStrategy(roundStats);
            const strategy     = STRATEGIES[strategyName];

            // 资金检查
            if (utxo.satoshis < strategy.minSatoshis) {
                console.log(`[跳过] ${strategyName} 需要 ${strategy.minSatoshis} sat，当前 ${utxo.satoshis} sat`);
                return;
            }

            const depth = strategy.mode === 'mesh' ? flowState.currentDepth : 0;
            const entry = addEntry(ledger, height, depth, utxo, strategyName);
            console.log(`[账本] 新记录: ${entry.id}  策略=${strategyName}  ${strategy.description}`);

            if (strategyName.startsWith('showcase')) sessionShowcaseQueued = true;

            if (resourceState.generationAllowed && activeGenerators.size < MAX_GENERATORS) {
                startGenerator(ledger, entry, depth);
            } else {
                console.log(`[限流] ${entry.id} 等待 pending（active=${activeGenerators.size}/${MAX_GENERATORS}${resourceState.reason ? `, ${resourceState.reason}` : ''}）`);
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
    const limits = CONFIG.resourceLimits;
    const availableMemoryMb = getAvailableMemoryMb();
    const freeDiskMb = getFreeDiskMb(CONFIG.outputBaseDir);
    const backlog = ledger.entries.filter(e => e.status === 'generated' || e.status === 'broadcasting').length;
    let mempool = null;
    try { mempool = await rpcCall('getmempoolinfo', [], CONFIG.rpcTimeout); } catch (_) {}
    const usage = Number(mempool?.usage ?? mempool?.bytes ?? 0);
    const maximum = Number(mempool?.maxmempool ?? 0);
    const mempoolRatio = maximum > 0 ? usage / maximum : 0;
    const reasons = [];
    if (availableMemoryMb < limits.minAvailableMemoryMb) reasons.push(`memory ${availableMemoryMb}MB<${limits.minAvailableMemoryMb}MB`);
    if (freeDiskMb < limits.minFreeDiskMb) reasons.push(`disk ${freeDiskMb}MB<${limits.minFreeDiskMb}MB`);
    if (backlog >= limits.maxGeneratedBacklog) reasons.push(`backlog ${backlog}>=${limits.maxGeneratedBacklog}`);
    if (mempoolRatio >= limits.maxMempoolUsageRatio) reasons.push(`mempool ${(mempoolRatio * 100).toFixed(1)}%`);
    resourceState = {
        generationAllowed: reasons.length === 0,
        broadcastAllowed: mempoolRatio < limits.maxMempoolUsageRatio,
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

// ==================== 启动 ====================

console.log('='.repeat(60));
console.log('automation-alltypes.js — 混合类型全自动压测框架');
console.log('='.repeat(60));
console.log(`RPC: ${CONFIG.rpc.url}`);
console.log(`showcase 间隔: 每 ${CONFIG.showcaseInterval} 个mesh轮次`);
console.log(`流控: depth ${CONFIG.flow.minDepth}~${CONFIG.flow.maxDepth}  初始=${CONFIG.flow.initialDepth}`);

const loopTimer = setInterval(() => mainLoop().catch(e => console.error('[mainLoop]', e.message)), CONFIG.pollInterval);

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
