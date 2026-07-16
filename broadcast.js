(function checkDependencies() {
    const required = ['axios', 'minimist', 'tbc-lib-js'];
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

const axios = require('axios');
const fs = require('fs');
const minimist = require('minimist');
const Transaction = require('tbc-lib-js/lib/transaction/transaction');
const Output = require('tbc-lib-js/lib/transaction/output');
const Opcode = require('tbc-lib-js/lib/opcode');

// 计算 TBC 交易 txid：使用项目自带的 tbc-lib-js Transaction（与节点、generator graph.json 一致）
function rawTxToTxid(hex) {
    return new Transaction(hex).hash;
}

// 把 opcode 数值转回可读名（用于失败步骤显示）
function opcodeName(num) {
    if (num === undefined || num === null) return 'N/A';
    if (typeof num !== 'number') return String(num);
    try { return new Opcode(num).toString(); } catch { return `op_0x${num.toString(16)}`; }
}

// 本地脚本验证：用 tbc-lib-js Interpreter 逐 input 跑 scriptSig + lockingScript
// 需要从同一文件里的其它交易拿到 prev output（外部 UTXO 跳过）
// 返回每个 input 的 {idx, prevTxid, prevVout, success, error, failedAt}
function verifyInputsLocally(failingItem, allItems) {
    const tx = new Transaction(failingItem.hex);
    // 缓存解析过的 tx，按 txid 索引
    const txByTxid = new Map();
    for (const it of allItems) {
        if (!it._parsedTx) it._parsedTx = new Transaction(it.hex);
        txByTxid.set(it._parsedTx.hash, it._parsedTx);
    }
    const results = [];
    for (let i = 0; i < tx.inputs.length; i++) {
        const inp = tx.inputs[i];
        const prevTxid = inp.prevTxId.toString('hex');
        const prevVout = inp.outputIndex;
        const prevTx = txByTxid.get(prevTxid);
        if (!prevTx) {
            results.push({ idx: i, prevTxid, prevVout, success: null, note: 'prev tx 不在本批文件中（外部 UTXO，无法本地验证）' });
            continue;
        }
        const prevOut = prevTx.outputs[prevVout];
        if (!prevOut) {
            results.push({ idx: i, prevTxid, prevVout, success: false, error: `prev tx 缺少 vout[${prevVout}]` });
            continue;
        }
        // Input.verify 要求 this.output 是 Output 实例
        inp.output = new Output({ satoshis: prevOut.satoshis, script: prevOut.script });
        try {
            const r = tx.verifyScript(i);
            results.push({ idx: i, prevTxid, prevVout, ...r });
        } catch (e) {
            results.push({ idx: i, prevTxid, prevVout, success: false, error: `verifyScript 抛异常: ${e.message}` });
        }
    }
    return results;
}

// 预校验：对每笔 tx 跑本地脚本验证；若某笔脚本不通过，标记为 bad，
// 然后通过 input.prevTxId 拓扑传播，标记所有引用 bad 输出的下游 tx 为 tainted。
// 返回 { goodItems, badItems, taintedItems }，badItems[i].failures 是逐 input 详情
// parentLookupItems：父交易查找池（必须是文件全量 allItems，不能只用 txItems，
//   否则历史成功批次里的父会被当成"外部 UTXO 无法验证"放过——掩盖真正的脚本 bug）
function prevalidateAll(txItems, parentLookupItems) {
    // 先解析全部 tx，按 txid 索引
    for (const it of parentLookupItems) {
        if (!it._parsedTx) it._parsedTx = new Transaction(it.hex);
    }
    const badTxids = new Set();
    const badItems = [];

    // 第一轮：本地脚本验证（父查找用全量）
    for (const item of txItems) {
        const results = verifyInputsLocally(item, parentLookupItems);
        const failures = results.filter(r => r.success === false);
        if (failures.length > 0) {
            badTxids.add(item.txid);
            badItems.push({ item, failures });
        }
    }

    // 第二轮：拓扑传播 —— 凡是 input 指向 badTxids 中某笔的，都是 tainted
    const taintedTxids = new Set();
    const taintedItems = [];
    let changed = true;
    while (changed) {
        changed = false;
        for (const item of txItems) {
            if (badTxids.has(item.txid) || taintedTxids.has(item.txid)) continue;
            const tx = item._parsedTx;
            const taintedParent = tx.inputs.find(inp => {
                const pid = inp.prevTxId.toString('hex');
                return badTxids.has(pid) || taintedTxids.has(pid);
            });
            if (taintedParent) {
                taintedTxids.add(item.txid);
                taintedItems.push({
                    item,
                    parentTxid: taintedParent.prevTxId.toString('hex'),
                    parentVout: taintedParent.outputIndex
                });
                changed = true;
            }
        }
    }

    const goodItems = txItems.filter(it => !badTxids.has(it.txid) && !taintedTxids.has(it.txid));
    return { goodItems, badItems, taintedItems };
}

// RPC 配置
// CLI 参数
const argv = minimist(process.argv.slice(2), {
    string: ['file', 'rpc-url', 'rpc-user', 'rpc-pass'],
    boolean: ['batch', 'prevalidate', 'dont-check-fee'],
    default: {
        file: './mesh-chain-output/transactions.txt',
        batch: false,
        prevalidate: false,  // 发送前用 tbc-lib-js Interpreter 本地跑每笔 tx 的脚本，剔除已知坏 tx 及其下游
        'dont-check-fee': false,
        c: 4,  // 单发模式并发数
        p: 2,  // batch 模式层内并行路数（--parallel 或 -p）
    }
});

const RPC_CONFIG = {
    url:      argv['rpc-url']  || 'http://localhost:8332',
    username: argv['rpc-user'] || 'username',
    password: argv['rpc-pass'] || 'randompasswd',
};

const filePath = argv.file;
const useBatch = argv.batch;
const prevalidate = argv.prevalidate;
const dontCheckFee = Boolean(argv['dont-check-fee']);
let stopRequested = false;
let stopSignal = null;
let stopRequestedAt = 0;
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (stopRequested) {
            // 终端 Ctrl+C 会同时送达父控制器和本子进程，父进程随后还会转发
            // SIGTERM；忽略这个紧邻的不同信号，避免跳过当前批次的进度落盘。
            if (signal !== stopSignal && Date.now() - stopRequestedAt < 1000) return;
            process.exit(3);
        }
        stopRequested = true;
        stopSignal = signal;
        stopRequestedAt = Date.now();
        console.log(`\n[退出] 收到 ${signal}，等待当前RPC完成并保存progress.json`);
    });
}
// 单发模式用 -c 并发；batch 模式用 -p/--parallel 控制层内并行路数
const concurrency = useBatch ? 1 : (parseInt(argv.c) || 4);
const batchParallelism = parseInt(argv.parallel ?? argv.p) || 2;

// 自适应流控配置
const AUTO_CONFIG = {
    initialBatch: 500,     // 高起点，避免从 1 爬坡；仍会根据节点响应时间动态调整
    maxBatch: 10000,       // 上限（自适应流控会动态调整，但设置安全上限）
    slowThreshold: 1000,   // 超过此时间视为阻塞(ms)，触发缩小 batch
    fastThreshold: 200,    // 低于此时间视为畅通(ms)，触发扩大 batch
    recoveryBatch: 4,      // batch <= 此值时，即使慢于 fastThreshold 也强制恢复增长（避免 batch=1 永久陷阱）
};

// 进度文件路径（与 transactions.txt 同目录）
const progressFile = pathForSibling(filePath, 'progress.json');

function pathForSibling(source, siblingName) {
    const marker = 'transactions.txt';
    return source.endsWith(marker)
        ? source.slice(0, -marker.length) + siblingName
        : `${source}.${siblingName}`;
}

// 已成功广播的 txid 集合（跨重播持久化；以 txid 为 key，不受文件行号变化影响）
let completedTxids = new Set();
// 本次启动时是否从非空 progress.json 恢复（用于检测 mempool 蒸发场景）
let resumedWithProgress = false;

// 全局状态
const state = {
    total: 0,
    sent: 0,
    success: 0,
    failed: 0,
    startTime: 0,
    errors: {},
    // 自适应流控状态
    currentBatch: AUTO_CONFIG.initialBatch,
    maxReachedBatch: AUTO_CONFIG.initialBatch,
    congested: false,
    // 首次错误日志标志（分离，避免互相屏蔽）
    firstBatchRpcErrorLogged: false,
    firstSingleFailLogged: false,
    firstNetworkErrorLogged: false
};

// 加载进度文件
function loadProgress() {
    if (fs.existsSync(progressFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(progressFile, 'utf-8'));
            if (Array.isArray(data.completedTxids) && data.algoVersion === PROGRESS_ALGO_VERSION) {
                completedTxids = new Set(data.completedTxids);
                if (completedTxids.size > 0) resumedWithProgress = true;
                console.log(`[进度] 已加载 ${completedTxids.size} 笔历史成功 txid，本次跳过`);
            } else if (Array.isArray(data.completedTxids)) {
                // txid 算法版本不一致（如早期 sha256d 实现产生的非 TBC 链 txid），强制重算
                console.log(`[进度] 检测到 progress.json 使用了不同的 txid 算法（algoVersion=${data.algoVersion || 'unknown'}），已忽略`);
                completedTxids = new Set();
            } else if (Array.isArray(data.completedIndices)) {
                // 旧格式：以行号为 key，遇到 transactions.txt 重新生成会误判，强制忽略
                console.log(`[进度] 检测到旧版本 progress.json（按行号记录，已不安全），已忽略并重新开始`);
                completedTxids = new Set();
            } else {
                completedTxids = new Set();
            }
        } catch {
            completedTxids = new Set();
        }
    }
}

// 进度文件 schema 版本（algoVersion 用于在 txid 算法变化时强制失效旧记录）
const PROGRESS_ALGO_VERSION = 'tbc-lib-js@hash';

// 保存进度文件
function saveProgress() {
    const tmp = `${progressFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({
        algoVersion: PROGRESS_ALGO_VERSION,
        completedTxids: Array.from(completedTxids),
        updatedAt: new Date().toISOString()
    }));
    fs.renameSync(tmp, progressFile);
}

// 读取交易（过滤已成功的）
function loadTxs() {
    const allLines = fs.readFileSync(filePath, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean);

    // txItems 保留原始行号（用于层信息映射）+ txid（用于幂等去重，跨文件重生成依然稳定）
    const allItems = allLines.map((hex, lineIdx) => ({
        hex,
        lineIdx,
        txid: rawTxToTxid(hex)
    }));
    const txItems = allItems.filter(item => !completedTxids.has(item.txid));

    const skipped = allItems.length - txItems.length;
    if (skipped > 0) {
        console.log(`[进度] 跳过 ${skipped} 笔已成功交易，待发送 ${txItems.length} 笔`);
    }

    const graphFile = pathForSibling(filePath, 'graph.json');

    // 读取层信息（仅用于统计和验证）
    let layerInfo = null;
    if (fs.existsSync(graphFile)) {
        const graphData = JSON.parse(fs.readFileSync(graphFile, 'utf-8'));
        if (graphData.nodes && graphData.nodes.length === allLines.length) {
            const maxDepth = Math.max(...graphData.nodes.map(n => n.depth));
            const layerCount = new Set(graphData.nodes.map(n => n.depth)).size;
            layerInfo = { maxDepth, layerCount, nodes: graphData.nodes };
            console.log(`[INFO] 从 graph.json 读取到 ${allLines.length} 笔交易，共 ${layerCount} 层，最大深度 ${maxDepth}`);
        }
    }

    if (!layerInfo) {
        console.warn(`[警告] 未找到 graph.json，所有交易按顺序发送`);
    }

    // allItems 是文件全量（含已成功的），用于本地脚本验证时查找父交易 prev output —
    // 父可能已在历史成功批次里、不再出现在 txItems 中。
    return { txItems, layerInfo, allItems };
}

// 错误分类
function classifyError(err) {
    const msg = typeof err === 'string' ? err : JSON.stringify(err);

    // ── 已确认 / 已在 mempool：视为成功 ──────────────────────────────────────
    if (msg.includes('already in block chain'))    return 'already_confirmed';
    if (msg.includes('transaction already known')) return 'already_confirmed';
    if (msg.includes('txn-already-known'))         return 'already_confirmed';
    if (msg.includes('AlreadyKnown'))              return 'already_confirmed';
    if (msg.includes('txn-mempool-conflict'))      return 'conflict';

    // ── 暂时性：等出块或 mempool 腾空后重试 ──────────────────────────────────
    if (msg.includes('missing inputs') || msg.includes('Missing inputs') || msg.includes('missing-inputs')) return 'missing_inputs';
    if (msg.includes('too-long-mempool-chain'))    return 'chain_limit';
    if (msg.includes('mempool full'))              return 'mempool_full';
    if (msg.includes('timeout'))                   return 'timeout';

    // ── 永久：手续费不足，固化在 tx 里，重播无效 ─────────────────────────────
    if (msg.includes('insufficient priority'))     return 'low_fee';
    if (msg.includes('min relay fee not met'))     return 'low_fee';
    if (msg.includes('fees-too-low'))              return 'low_fee';
    if (msg.includes('fee rate below minimum'))    return 'low_fee';
    if (msg.includes('mempool min fee not met'))   return 'low_fee';
    if (msg.includes('absurdly-high-fee'))         return 'low_fee';  // 超高费同样固化，不可重试

    // ── 永久：脚本 / 签名验证失败 ────────────────────────────────────────────
    if (msg.includes('mandatory-script-verify-flag-failed'))  return 'script_invalid';
    if (msg.includes('non-mandatory-script-verify-flag'))     return 'script_invalid';
    if (msg.includes('scriptsig-not-pushonly'))               return 'script_invalid';
    if (msg.includes('Script evaluated without error'))       return 'script_invalid';

    // ── 永久：交易格式 / 结构非法，生成器 bug 才会出现，重播永远被拒 ────────
    if (msg.includes('TX decode failed'))          return 'tx_malformed';
    if (msg.includes('bad-txns-'))                 return 'tx_malformed';  // bad-txns-* 整族
    if (msg.includes('dust'))                      return 'tx_malformed';  // 输出低于 dust 阈值
    if (msg.includes('transaction-too-small'))     return 'tx_malformed';
    if (msg.includes('tx-size'))                   return 'tx_malformed';  // 超过最大 tx 大小
    if (msg.includes('non-final'))                 return 'tx_malformed';  // nLockTime 未满足

    return 'other';
}

// 单条发送
async function sendSingle(rawTx) {
    try {
        const res = await axios.post(RPC_CONFIG.url, {
            jsonrpc: '1.0',
            id: 'single',
            method: 'sendrawtransaction',
            params: [rawTx, false, dontCheckFee]
        }, {
            auth: {
                username: RPC_CONFIG.username,
                password: RPC_CONFIG.password
            },
            timeout: 30000
        });
        return res.data;
    } catch (err) {
        // Bitcoin RPC 在交易被拒绝时返回 HTTP 500，真正的原因在响应体里
        if (err.response && err.response.data) {
            return err.response.data;  // 交给上层 classifyError 处理
        }
        throw err;
    }
}

// 批量发送
async function sendBatchBSV(rawTxList) {
    const payload = {
        jsonrpc: '1.0',
        id: 'batch',
        method: 'sendrawtransactions',
        params: [
            rawTxList.map(tx => ({
                hex: tx,
                allowhighfees: false,
                dontcheckfee: dontCheckFee
            }))
        ]
    };
    // 节点持有 cs_main 验证整批，大批次需要更长等待时间：每笔预留 100ms，最低 30s，最高 5min
    const dynamicTimeout = Math.min(300000, Math.max(30000, rawTxList.length * 100));
    const res = await axios.post(RPC_CONFIG.url, payload, {
        auth: {
            username: RPC_CONFIG.username,
            password: RPC_CONFIG.password
        },
        timeout: dynamicTimeout
    });
    return res.data;
}

// 标准化批量结果
function normalizeBatchResult(result, batch) {
    // TBC 节点在所有交易被接受时返回 {}（空对象），视为全部成功
    if (result && typeof result === 'object' && !Array.isArray(result) && Object.keys(result).length === 0) {
        return batch.map(() => ({ txid: null, error: null }));
    }

    if (result && typeof result === 'object' &&
        !Array.isArray(result) &&
        !result.valid && !result.invalid) {
        console.log('\n[批量响应格式未识别] 原始 result:', JSON.stringify(result).substring(0, 500));
        return batch.map(() => ({ txid: null, error: 'unknown_response_format' }));
    }

    if (Array.isArray(result)) return result;

    if (result && typeof result === 'object') {
        // valid/invalid 是两个分组，不保证仍按请求顺序排列；必须按 txid 回填。
        const valid = new Set(result.valid || []);
        const invalid = new Map((result.invalid || []).map(errObj => [
            errObj.txid,
            errObj.reject_reason || errObj.error || 'unknown'
        ]));
        return batch.map(item => {
            if (valid.has(item.txid)) return { txid: item.txid, error: null };
            if (invalid.has(item.txid)) return { txid: item.txid, error: invalid.get(item.txid) };
            return { txid: item.txid, error: 'unknown_response_format' };
        });
    }

    return batch.map(() => ({ txid: null, error: 'unknown_response_format' }));
}

// 发送一批并更新状态
// batch: Array<{ hex: string, lineIdx: number }>
async function sendBatchAdaptive(batch) {
    const startTime = Date.now();
    let success = true;

    try {
        // results[i] 对应 batch[i]
        let results = [];

        if (!useBatch || batch.length === 1) {
            // 单条模式
            for (const item of batch) {
                const r = await sendSingle(item.hex);
                if (r.error) {
                    results.push({ item, error: r.error });
                } else {
                    results.push({ item, txid: r.result, error: null });
                }
            }
        } else {
            // 批量模式
            const rawResponse = await sendBatchBSV(batch.map(b => b.hex));

            // 即使 rawResponse.error 存在，也尝试解析 result 中的部分成功/失败
            if (rawResponse.result) {
                const normalized = normalizeBatchResult(rawResponse.result, batch);
                results = normalized.map((r, i) => ({ item: batch[i], ...r }));
            } else {
                // 完全没有 result，整个 batch 失败
                for (const item of batch) {
                    results.push({ item, error: rawResponse.error || { message: 'unknown_rpc_error' } });
                }
            }

            // 只在第一次遇到 RPC 错误时打印详情
            if (rawResponse.error && !state.firstBatchRpcErrorLogged) {
                console.log("\n=== 首次批量 RPC 错误详情 ===");
                console.log("batch size:", batch.length);
                console.log("rpc error:", JSON.stringify(rawResponse.error, null, 2));
                if (batch.length > 0) {
                    console.log("首笔示例 (hex):", batch[0].hex.substring(0, 100) + "...");
                }
                console.log("========================");
                state.firstBatchRpcErrorLogged = true;
            }
        }

        // 统计结果，记录成功行号
        let hasCriticalError = false;
        let progressDirty = false;

        results.forEach(r => {
            if (!r.error) {
                state.success++;
                completedTxids.add(r.item.txid);
                progressDirty = true;
            } else {
                const type = classifyError(r.error);
                state.errors[type] = (state.errors[type] || 0) + 1;

                if (type === 'conflict' || type === 'already_confirmed') {
                    // 已在 mempool 或已上链确认：视为成功，记录 txid 避免下次重播
                    state.success++;
                    completedTxids.add(r.item.txid);
                    progressDirty = true;
                } else {
                    state.failed++;

                    // 只在第一个真实失败时打印详细错误
                    if (!state.firstSingleFailLogged) {
                        console.log("\n=== 首次单笔失败详情 ===");
                        console.log("raw tx (hex):", r.item ? r.item.hex.substring(0, 100) + "..." : "unknown");
                        console.log("error:", r.error);
                        console.log("========================");
                        state.firstSingleFailLogged = true;
                    }

                    if (type === 'timeout') {
                        hasCriticalError = true;
                    }
                }
            }
        });

        // 有新成功记录就持久化进度
        if (progressDirty) {
            saveProgress();
        }

        state.sent += batch.length;

        if (hasCriticalError) {
            success = false;
        }

    } catch (err) {
        // work queue 满 或 超时：让外层重试同一批，不更新 state
        // 超时时节点可能已处理该批（响应未及时返回），重试后 already_confirmed 计为成功
        const isQueueFull = err.response?.status === 500 &&
            String(err.response?.data ?? '').includes('Work queue depth exceeded');
        const isTimeout = err.code === 'ECONNABORTED' || String(err.message ?? '').includes('timeout');
        if (isQueueFull || isTimeout) {
            if (!state.firstNetworkErrorLogged) {
                if (isQueueFull) {
                    console.log("\n=== 节点 work queue 满载（HTTP 500）===");
                    console.log("batch size:", batch.length);
                    console.log("response data:", err.response.data);
                } else {
                    console.log("\n=== 请求超时，等待后重试同一批 ===");
                    console.log("batch size:", batch.length);
                    console.log("timeout:", err.message);
                }
                console.log("========================");
                state.firstNetworkErrorLogged = true;
            }
            return { shouldRetry: true };
        }

        state.failed += batch.length;
        state.sent += batch.length;
        success = false;
        // 只在第一次 catch 时打印整个异常
        if (!state.firstNetworkErrorLogged) {
            console.log("\n=== 首次网络/连接异常详情 ===");
            console.log("batch size:", batch.length);
            console.log("error message:", err.message);
            console.log("error stack:", err.stack);
            if (err.response) {
                console.log("status:", err.response.status);
                console.log("response data:", err.response.data);
            }
            console.log("first raw tx (hex):", batch[0] ? batch[0].hex.substring(0, 100) + "..." : "none");
            console.log("========================");
            state.firstNetworkErrorLogged = true;
        }
    }

    // 自适应调整 batch 大小（仅批量模式）
    if (useBatch) {
        const elapsed = Date.now() - startTime;

        if (!success || elapsed > AUTO_CONFIG.slowThreshold) {
            state.currentBatch = Math.max(1, Math.floor(state.currentBatch / 2));
            state.congested = true;
        } else if (elapsed < AUTO_CONFIG.fastThreshold || state.currentBatch <= AUTO_CONFIG.recoveryBatch) {
            // 畅通（<fastThreshold）或处于最小批量恢复中（避免 batch=1 永久陷阱）
            if (state.currentBatch < AUTO_CONFIG.maxBatch) {
                const increment = Math.max(1, Math.floor(Math.sqrt(state.currentBatch)));
                state.currentBatch = Math.min(AUTO_CONFIG.maxBatch, state.currentBatch + increment);
                state.congested = false;
            }
        }
        // else: 中速（fastThreshold ~ slowThreshold），维持当前 batch 不变

        if (state.currentBatch > state.maxReachedBatch) {
            state.maxReachedBatch = state.currentBatch;
        }
    }
    return { shouldRetry: false };
}

// 批量模式：分层屏障 + 层内并行批量发送
// 层间有序（Layer N 完成才发 Layer N+1）→ 消灭 missing-inputs
// 层内并行（同层 tx 互相独立）→ 提升吞吐量
async function broadcastBatchMode(txItems, layerInfo, allItems) {
    const txsByLayer = new Map();
    if (layerInfo && layerInfo.nodes) {
        for (const item of txItems) {
            const depth = layerInfo.nodes[item.lineIdx].depth;
            if (!txsByLayer.has(depth)) txsByLayer.set(depth, []);
            txsByLayer.get(depth).push(item);
        }
    } else {
        txsByLayer.set(0, txItems);
    }

    const sortedLayers = Array.from(txsByLayer.entries()).sort((a, b) => a[0] - b[0]);
    const hasLayerInfo = layerInfo && layerInfo.nodes;
    // 无层信息时退回单路（不能并行，会出现 missing-inputs）
    const parallelism = hasLayerInfo ? batchParallelism : 1;

    state.total = txItems.length;
    state.startTime = Date.now();

    console.log(`\n[INFO] 总交易=${state.total} 层数=${sortedLayers.length} 批量模式=true 并行=${parallelism}`);
    console.log(`[流控] 初始batch=${state.currentBatch} 最大batch=${AUTO_CONFIG.maxBatch}`);
    if (hasLayerInfo) {
        console.log(`[模式] 分层屏障并行批量（层间顺序保证无 missing-inputs，层内 ${parallelism} 路并发）\n`);
    } else {
        console.log(`[模式] 无 graph.json，全局拓扑序单路发送\n`);
    }

    const MAX_QUEUE_RETRIES = 8;
    let firstBatchDone = false;  // 用于 resume 场景首批检测

    function printProgress() {
        const progress = ((state.sent / state.total) * 100).toFixed(1);
        const elapsedTotal = ((Date.now() - state.startTime) / 1000).toFixed(1);
        const tps = state.sent > 0
            ? (state.sent / (Date.now() - state.startTime) * 1000).toFixed(0)
            : '0';
        const statusChar = state.congested ? '↓' : (state.currentBatch >= state.maxReachedBatch ? '↑' : '=');
        process.stdout.write(
            `\r[${elapsedTotal}s] ${progress}% | batch=${state.currentBatch}${statusChar} | sent=${state.sent}/${state.total} | ok=${state.success} | fail=${state.failed} | TPS=${tps}`
        );
    }

    for (const [, layerItems] of sortedLayers) {
        // 层内并行：多个 worker 共用一个游标，各自抢占下一个 chunk
        let layerCursor = 0;
        const layerTotal = layerItems.length;
        let restartNeeded = false;

        async function layerWorker() {
            while (true) {
                if (stopRequested) break;
                // 原子性取得本 worker 的 chunk 范围（JS 单线程，await 之前不会被中断）
                const start = layerCursor;
                if (start >= layerTotal) break;
                const end = Math.min(start + state.currentBatch, layerTotal);
                layerCursor = end;
                const chunk = layerItems.slice(start, end);

                // work queue 满时本 worker 自行退避重试
                let qRetries = 0;
                while (true) {
                    const { shouldRetry } = await sendBatchAdaptive(chunk);
                    if (stopRequested) break;
                    if (!shouldRetry) break;
                    if (++qRetries > MAX_QUEUE_RETRIES) {
                        console.log(`\n[中止] work queue 满载重试 ${qRetries} 次仍失败，退出`);
                        process.exit(1);
                    }
                    const delay = Math.min(30000, 2000 * Math.pow(2, qRetries - 1));
                    console.log(`\n[等待] work queue 满 (${qRetries}/${MAX_QUEUE_RETRIES})，${(delay / 1000).toFixed(0)}s 后重试...`);
                    await new Promise(r => setTimeout(r, delay));
                }

                // resume 场景：首批全 missing-inputs → mempool 已蒸发，重头广播
                if (!firstBatchDone && resumedWithProgress) {
                    firstBatchDone = true;
                    if (state.success === 0 && (state.errors['missing_inputs'] || 0) > 0) {
                        console.log('\n[恢复] 首批全部 missing-inputs —— 父交易已从节点 mempool 蒸发，清除进度，重头广播...');
                        completedTxids.clear();
                        saveProgress();
                        resumedWithProgress = false;
                        Object.assign(state, {
                            sent: 0, success: 0, failed: 0, errors: {},
                            currentBatch: AUTO_CONFIG.initialBatch, maxReachedBatch: AUTO_CONFIG.initialBatch,
                            congested: false,
                            firstBatchRpcErrorLogged: false, firstSingleFailLogged: false, firstNetworkErrorLogged: false,
                        });
                        restartNeeded = true;
                        layerCursor = layerTotal; // 让其余 worker 退出
                        break;
                    }
                }
                firstBatchDone = true;

                printProgress();
            }
        }

        await Promise.all(Array.from({ length: parallelism }, layerWorker));

        if (restartNeeded) {
            return broadcastBatchMode(allItems ?? txItems, layerInfo, allItems);
        }
    }

    console.log();
}

// 单发模式：分层并发（父先于子）
async function broadcastSingleMode(txItems, layerInfo) {
    // 按层分组（用 lineIdx 映射到原始层信息）
    const txsByLayer = new Map();
    if (layerInfo) {
        for (const item of txItems) {
            const depth = layerInfo.nodes[item.lineIdx].depth;
            if (!txsByLayer.has(depth)) txsByLayer.set(depth, []);
            txsByLayer.get(depth).push(item);
        }
    } else {
        txsByLayer.set(1, txItems);
    }

    const sortedLayers = Array.from(txsByLayer.entries()).sort((a, b) => a[0] - b[0]);
    state.total = txItems.length;
    state.startTime = Date.now();

    console.log(`\n[INFO] 总交易=${state.total} 层数=${sortedLayers.length} 批量模式=false 并发=${concurrency}`);
    console.log(`[模式] 分层并发（层间顺序，层内并行）\n`);

    for (const [layerNum, layerItems] of sortedLayers) {
        const layerStart = Date.now();

        // 层内分片给多个 worker
        const chunkSize = Math.ceil(layerItems.length / concurrency);
        const chunks = [];
        for (let i = 0; i < layerItems.length; i += chunkSize) {
            chunks.push(layerItems.slice(i, i + chunkSize));
        }

        // 并发 workers
        const workers = chunks.map(chunk => {
            return (async () => {
                for (const item of chunk) {
                    if (stopRequested) break;
                    await sendBatchAdaptive([item]);
                    if (stopRequested) break;

                    // 更新进度
                    const progress = ((state.sent / state.total) * 100).toFixed(1);
                    const elapsedTotal = ((Date.now() - state.startTime) / 1000).toFixed(1);
                    const tps = (state.sent / (Date.now() - state.startTime) * 1000).toFixed(0);

                    process.stdout.write(
                        `\r[${elapsedTotal}s] ${progress}% | sent=${state.sent}/${state.total} | ok=${state.success} | fail=${state.failed} | TPS=${tps}`
                    );
                }
            })();
        });

        await Promise.all(workers);

        const layerElapsed = (Date.now() - layerStart) / 1000;
        if (layerItems.length > 1) {
            process.stdout.write(`\n[L${layerNum}] ${layerItems.length}tx ${layerElapsed.toFixed(2)}s `);
        }
    }

    console.log();
}

// ========================
// 失败诊断：取出"最后成功 → 首笔失败"的交易，单独 RPC 调用打印完整原因
// ========================
async function diagnoseFailures() {
    const allLines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    const allItems = allLines.map((hex, lineIdx) => ({
        hex,
        lineIdx,
        txid: rawTxToTxid(hex)
    }));
    const totalCount = allItems.length;
    const successCount = completedTxids.size;
    const failedItems = allItems.filter(item => !completedTxids.has(item.txid));

    console.log('\n' + '='.repeat(60));
    console.log('广播失败诊断');
    console.log('='.repeat(60));
    console.log(`总计: ${totalCount} 笔 | 已成功: ${successCount} 笔 | 待查: ${failedItems.length} 笔`);

    if (successCount > 0) {
        const successItems = allItems.filter(it => completedTxids.has(it.txid));
        const lastSuccessIdx = successItems.length ? Math.max(...successItems.map(s => s.lineIdx)) : -1;
        if (lastSuccessIdx >= 0) {
            console.log(`最后成功行号: ${lastSuccessIdx}  (文件第 ${lastSuccessIdx + 1} 行)`);
        }
        if (failedItems.length > 0) {
            console.log(`首笔失败行号: ${failedItems[0].lineIdx}  (文件第 ${failedItems[0].lineIdx + 1} 行)`);
        }
    } else {
        console.log('无任何成功记录，从第 1 笔开始诊断');
    }

    // 取前 3 笔失败交易逐一诊断
    const samples = failedItems.slice(0, 3);
    for (const item of samples) {
        console.log(`\n[诊断] 单独广播 lineIdx=${item.lineIdx} txid=${item.txid} ...`);
        console.log(`[诊断] hex 前缀: ${item.hex.substring(0, 80)}...`);
        try {
            const res = await axios.post(RPC_CONFIG.url, {
                jsonrpc: '1.0',
                id: 'diagnose',
                method: 'sendrawtransaction',
                params: [item.hex]
            }, {
                auth: { username: RPC_CONFIG.username, password: RPC_CONFIG.password },
                timeout: 30000
            });

            if (res.data.error) {
                const e = res.data.error;
                console.log(`[诊断] ✗ code=${e.code}  message=${e.message}`);
                console.log(`[诊断]   分类: ${classifyError(JSON.stringify(e))}`);
            } else {
                console.log(`[诊断] ✓ 意外成功! txid=${res.data.result}`);
                completedTxids.add(item.txid);
                saveProgress();
            }
        } catch (err) {
            const rpcErr = err.response?.data?.error;
            if (rpcErr) {
                console.log(`[诊断] ✗ code=${rpcErr.code}  message=${rpcErr.message}`);
                console.log(`[诊断]   分类: ${classifyError(JSON.stringify(rpcErr))}`);
            } else {
                console.log(`[诊断] ✗ 网络异常: ${err.message}`);
            }
        }

        // 本地脚本验证：定位哪个 input 失败、停在哪条指令
        try {
            const localResults = verifyInputsLocally(item, allItems);
            console.log(`[本地] 共 ${localResults.length} 个 input：`);
            for (const r of localResults) {
                const parentTag = `prev=${r.prevTxid ? r.prevTxid.substring(0, 16) + '..' : '?'}:v${r.prevVout}`;
                if (r.success === null) {
                    console.log(`  input[${r.idx}] ${parentTag}  [跳过] ${r.note}`);
                } else if (r.success) {
                    console.log(`  input[${r.idx}] ${parentTag}  ✓ 脚本通过`);
                } else {
                    const op = r.failedAt ? opcodeName(r.failedAt.opcode) : 'N/A';
                    const pc = r.failedAt && r.failedAt.pc !== undefined ? `pc=${r.failedAt.pc}` : '';
                    console.log(`  input[${r.idx}] ${parentTag}  ✗ ${r.error || 'failed'}  停在 ${op} ${pc}`);
                }
            }
        } catch (e) {
            console.log(`[本地] 验证流程抛异常: ${e.message}`);
        }
    }

    console.log('\n' + '='.repeat(60) + '\n');
}

// 主逻辑
async function broadcast() {
    loadProgress();
    let { txItems, layerInfo, allItems } = loadTxs();

    // 全部已完成，直接退出成功
    if (txItems.length === 0) {
        console.log('[进度] 所有交易已成功广播，无需重播');
        return;
    }

    // 可选：发送前本地脚本预校验，剔除脚本失败的 tx 及其下游（避免污染节点 mempool）
    if (prevalidate) {
        console.log(`\n[预校验] 对 ${txItems.length} 笔交易逐 input 跑本地 Interpreter（父查找池：全量 ${allItems.length} 笔）...`);
        const t0 = Date.now();
        const { goodItems, badItems, taintedItems } = prevalidateAll(txItems, allItems);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
        console.log(`[预校验] 完成 用时${elapsed}s: 通过 ${goodItems.length}, 脚本失败 ${badItems.length}, 被下游污染 ${taintedItems.length}`);

        if (badItems.length > 0) {
            console.log(`[预校验] —— 脚本失败的交易 ——`);
            for (const { item, failures } of badItems) {
                console.log(`  L${item.lineIdx} txid=${item.txid.substring(0, 16)}..`);
                for (const f of failures) {
                    const op = f.failedAt ? opcodeName(f.failedAt.opcode) : 'N/A';
                    const pc = f.failedAt && f.failedAt.pc !== undefined ? `pc=${f.failedAt.pc}` : '';
                    console.log(`    input[${f.idx}] prev=${f.prevTxid.substring(0, 16)}..:v${f.prevVout}  ✗ ${f.error || 'failed'}  停在 ${op} ${pc}`);
                }
            }
        }
        if (taintedItems.length > 0) {
            console.log(`[预校验] —— 因父交易脚本失败被跳过的下游 ——`);
            for (const { item, parentTxid, parentVout } of taintedItems) {
                console.log(`  L${item.lineIdx} txid=${item.txid.substring(0, 16)}..  父=${parentTxid.substring(0, 16)}..:v${parentVout}`);
            }
        }

        if (goodItems.length === 0) {
            console.log('[预校验] 没有可发送的交易，退出');
            process.exit(1);
        }

        txItems = goodItems;
    }

    if (useBatch) {
        await broadcastBatchMode(txItems, layerInfo, allItems);
    } else {
        await broadcastSingleMode(txItems, layerInfo);
    }

    if (stopRequested) {
        saveProgress();
        console.log(`[退出保存] signal=${stopSignal} completedTxids=${completedTxids.size}`);
        process.exitCode = 3;
        return;
    }

    // 最终结果
    const totalElapsed = (Date.now() - state.startTime) / 1000;
    const avgTps = (state.success / totalElapsed).toFixed(0);

    console.log(`\n=== RESULT ===`);
    console.log(`总时间: ${totalElapsed.toFixed(2)}s`);
    console.log(`成功: ${state.success}/${state.total}`);
    console.log(`失败: ${state.failed}`);
    console.log(`平均TPS: ${avgTps}`);
    if (useBatch) {
        console.log(`稳定批量大小: ${state.currentBatch} (峰值: ${state.maxReachedBatch})`);
    }
    if (Object.keys(state.errors).length > 0) {
        console.log(`错误分布:`, state.errors);
    }

    // 有失败时：诊断根因，判断是否永久拒绝
    if (state.failed > 0) {
        await diagnoseFailures();
        // 若全量失败且均为确定不可通过重播修复的拒绝类且无一成功
        // → 后代 tx 也无法上链，用 exit 2 通知上层不要重试
        // 节点明确拒绝且重播无效的错误类型（重签名才可能改变）
        // missing_inputs 可能是父交易随 mempool 重启而消失，必须保留为可恢复错误。
        const permanentTypes = new Set(['low_fee', 'script_invalid', 'tx_malformed']);
        const allPermanent = Object.keys(state.errors).length > 0 &&
                             Object.keys(state.errors).every(k => permanentTypes.has(k));
        if (allPermanent && state.success === 0) {
            console.log(`[永久拒绝] 所有 ${state.failed} 笔失败均为节点明确拒绝 (${JSON.stringify(state.errors)})，退出码 2`);
            process.exit(2);
        }
        console.log(`[错误] 存在 ${state.failed} 笔失败交易，退出码 1`);
        process.exit(1);
    }
}

// 启动
broadcast().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
});
