const axios = require('axios');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

// ========================
// 事件上报（供 miner-monitor 订阅）
// ========================
const EVENTS_FILE = './miner-bridge-events.jsonl';
function appendEvent(obj) {
    try {
        fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ...obj, ts: Date.now() }) + '\n');
    } catch (_) {}
}

// ========================
// RPC 配置
// ========================
const RPC = {
    url: 'http://localhost:8332',
    auth: {
        username: 'username',
        password: 'randompasswd'
    }
};

// ========================
// CPUMiner 配置
// ========================
const CPUMINER = {
    path: process.env.CPUMINER_PATH || 'cpuminer',
    proxyPort: parseInt(process.env.CPUMINER_PROXY_PORT, 10) || 18333,
    extraArgs: process.env.CPUMINER_EXTRA_ARGS
        ? process.env.CPUMINER_EXTRA_ARGS.split(' ')
        : []
};

// ========================
// 桥接器配置
// ========================
const CONFIG = {
    addressPoolSize: 1,                 // 覆盖 generator 的地址池大小
    depthRange: { min: 10, max: 500 }, // 每轮随机深度 n 的范围
    feePerTx: 80,
    minSplitAmount: 1000000,
    maxTransactions: 100000,
    outputDirPrefix: './mesh-chain-output/miner-bridge',
    rpcTimeout: 30000,
    nodeHealthTimeout: 5000,
};

// ========================
// RPC 工具
// ========================
async function rpc(method, params = [], timeout = CONFIG.rpcTimeout) {
    const res = await axios.post(RPC.url, {
        jsonrpc: '1.0',
        id: 'miner-bridge',
        method,
        params
    }, {
        auth: RPC.auth,
        timeout
    });

    if (res.data.error) throw res.data.error;
    return res.data.result;
}

async function getHeight(timeout = CONFIG.rpcTimeout) {
    return await rpc('getblockcount', [], timeout);
}

async function getLatestBlock() {
    const hash = await rpc('getbestblockhash');
    return await rpc('getblock', [hash]);
}

async function checkNodeHealth(timeout = CONFIG.nodeHealthTimeout) {
    try {
        await Promise.race([
            rpc('getblockcount', [], timeout),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('timeout')), timeout)
            )
        ]);
        return true;
    } catch {
        return false;
    }
}

async function sendRawTransaction(hex) {
    const res = await axios.post(RPC.url, {
        jsonrpc: '1.0',
        id: 'sendrawtx',
        method: 'sendrawtransaction',
        params: [hex]
    }, {
        auth: RPC.auth,
        timeout: CONFIG.rpcTimeout
    });
    return res.data;
}

// ========================
// Coinbase UTXO 提取
// ========================
async function extractCoinbaseUTXO(block) {
    const coinbaseTxId = block.tx[0];
    const raw = await rpc('getrawtransaction', [coinbaseTxId]);
    const decoded = await rpc('decoderawtransaction', [raw]);
    const vout = decoded.vout[1];
    const satoshis = Math.floor(vout.value * 1e6);

    return {
        txId: coinbaseTxId,
        outputIndex: 1,
        satoshis
    };
}

// ========================
// 修改 generator 配置
// ========================
function updateGeneratorConfig(utxo, height, depth, addressPoolSize) {
    let content = fs.readFileSync('generator-mesh-tx.js', 'utf-8');

    // 替换 initialUtxos 中的 txId / satoshis
    content = content.replace(/^(\s+txId:\s*)".*?"/m, `$1"${utxo.txId}"`);
    content = content.replace(/^(\s+satoshis:\s*).*,/m, `$1${utxo.satoshis},`);
    // 替换 targetMaxDepth
    content = content.replace(/^(\s+targetMaxDepth:\s*)\d+/m, `$1${depth}`);
    // 替换 addressPoolSize
    content = content.replace(/^(\s+addressPoolSize:\s*)\d+/m, `$1${addressPoolSize}`);
    // 替换 outputDir
    const outputDir = `${CONFIG.outputDirPrefix}/${height}-${depth}`;
    content = content.replace(/outputDir:\s*['"].*?['"]/, `outputDir: '${outputDir}'`);
    // 随机种子设为 null（每轮不同），如需固定可在这里替换
    content = content.replace(/^(\s+randomSeed:\s*)[^,\n]+/m, `$1null`);

    fs.writeFileSync('generator-mesh-tx.js', content);
    console.log(`[更新配置] height=${height} depth=${depth} addressPoolSize=${addressPoolSize} outputDir=${outputDir}`);
}

// ========================
// 执行命令
// ========================
function run(cmd) {
    console.log(`\n[执行] ${cmd}`);
    execSync(cmd, { stdio: 'inherit' });
}

// ========================
// 交易图分析
// ========================
function buildGraph(graphJson) {
    const nodes = new Map();
    for (const n of graphJson.nodes) {
        nodes.set(n.txId, { ...n, children: [] });
    }
    for (const [id, node] of nodes) {
        for (const pid of node.parentIds) {
            if (nodes.has(pid)) {
                nodes.get(pid).children.push(id);
            }
        }
    }
    return nodes;
}

function computeMaxDescendantDepth(nodes) {
    const memo = new Map();
    function dfs(id) {
        if (memo.has(id)) return memo.get(id);
        const node = nodes.get(id);
        let max = node.depth;
        for (const cid of node.children) {
            max = Math.max(max, dfs(cid));
        }
        memo.set(id, max);
        return max;
    }
    for (const id of nodes.keys()) dfs(id);
    return memo;
}

// ========================
// 错误分类
// ========================
function classifyError(err) {
    const msg = typeof err === 'string' ? err : JSON.stringify(err);
    if (msg.includes('missing inputs')) return 'missing_inputs';
    if (msg.includes('txn-mempool-conflict')) return 'conflict';
    if (msg.includes('too-long-mempool-chain')) return 'chain_limit';
    if (msg.includes('mempool full')) return 'mempool_full';
    if (msg.includes('timeout')) return 'timeout';
    return 'other';
}

// ========================
// 分阶段广播
// ========================
async function broadcastTransactions(txFile, graphFile, h, m, height) {
    const txs = fs.readFileSync(txFile, 'utf-8').trim().split('\n').filter(Boolean);
    const graph = JSON.parse(fs.readFileSync(graphFile, 'utf-8'));
    const nodes = buildGraph(graph);
    const maxDesc = computeMaxDescendantDepth(nodes);

    // transactions.txt 的生成顺序天然为拓扑序（父先于子）
    const order = graph.nodes.map(n => n.txId);
    const txMap = new Map();
    for (let i = 0; i < order.length; i++) {
        txMap.set(order[i], txs[i]);
    }

    const broadcasted = new Set();
    let stopTxId = null;
    let sent = 0;
    let success = 0;
    let failed = 0;

    const startTime = Date.now();

    // 阶段 1：逐笔广播，按单链触发停止
    // 说明：mesh 中各分支实际深度不同，触发条件应为 "当前交易到最深叶子的剩余深度 == m"
    console.log(`\n[广播阶段1] 实际最大深度 h=${h} m=${m}，剩余深度触发值=${m}`);
    for (const txId of order) {
        const node = nodes.get(txId);
        try {
            const res = await sendRawTransaction(txMap.get(txId));
            if (res.error) {
                failed++;
                const type = classifyError(res.error);
                console.warn(`[广播警告] ${txId.substring(0, 16)}... error=${type}`);
            } else {
                success++;
            }
        } catch (err) {
            failed++;
            const type = classifyError(err.message || err);
            console.warn(`[广播异常] ${txId.substring(0, 16)}... error=${type}`);
        }
        broadcasted.add(txId);
        sent++;

        if (sent % 100 === 0 || sent === order.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            process.stdout.write(`\r  [阶段1] ${elapsed}s | sent=${sent}/${order.length} | ok=${success} | fail=${failed}`);
        }

        // 检查是否触发停止：当前交易到最深未广播后代的剩余深度 == m
        const remainingDepth = maxDesc.get(txId) - node.depth;
        if (remainingDepth === m) {
            const hasUnbroadcastChildToMax = node.children.some(
                cid => !broadcasted.has(cid) && maxDesc.get(cid) === maxDesc.get(txId)
            );
            if (hasUnbroadcastChildToMax) {
                stopTxId = txId;
                console.log(`\n[阶段1停止] tx=${txId.substring(0, 16)}... depth=${node.depth} maxDesc=${maxDesc.get(txId)} 链剩余=${m}层 已广播=${sent}`);
                appendEvent({ type: 'phase1_stop', height, n: order.length, h, m, sent, ok: success, fail: failed });
                break;
            }
        }
    }
    process.stdout.write('\n');

    // 获取 block template
    console.log('[getblocktemplate] 获取挖矿模板...');
    const template = await rpc('getblocktemplate', []);

    // 阶段 2：广播剩余交易
    console.log(`[广播阶段2] 剩余交易=${order.length - sent}`);
    let phase2Sent = 0;
    const phase2Start = Date.now();
    for (const txId of order) {
        if (!broadcasted.has(txId)) {
            try {
                const res = await sendRawTransaction(txMap.get(txId));
                if (res.error) {
                    failed++;
                } else {
                    success++;
                }
            } catch (err) {
                failed++;
            }
            broadcasted.add(txId);
            sent++;
            phase2Sent++;

            if (phase2Sent % 100 === 0) {
                const elapsed = ((Date.now() - phase2Start) / 1000).toFixed(1);
                process.stdout.write(`\r  [阶段2] ${elapsed}s | sent=${phase2Sent}/${order.length - broadcasted.size + phase2Sent} | total=${sent}/${order.length}`);
            }
        }
    }
    process.stdout.write('\n');
    appendEvent({ type: 'phase2_done', height, total_sent: sent, total_ok: success, total_fail: failed });

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[广播完成] 总时间=${totalTime}s 发送=${sent} 成功=${success} 失败=${failed}`);

    return template;
}

// ========================
// CPUMiner 代理
// ========================
function startProxy(savedTemplate, onSubmitBlock) {
    const server = http.createServer(async (req, res) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const payload = JSON.parse(body);
                let result;

                if (payload.method === 'getblocktemplate') {
                    result = savedTemplate;
                } else if (payload.method === 'submitblock') {
                    result = await rpc('submitblock', payload.params);
                    onSubmitBlock(result);
                } else {
                    result = await rpc(payload.method, payload.params);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '1.0', id: payload.id, result }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '1.0', id: 'miner-bridge', error: err.message }));
            }
        });
    });

    server.listen(CPUMINER.proxyPort);
    console.log(`[代理] 已启动于 http://127.0.0.1:${CPUMINER.proxyPort}`);
    return server;
}

// ========================
// 启动 cpuminer
// ========================
function spawnCpuminer() {
    const args = [
        '-a', 'sha256d',
        '-o', `http://127.0.0.1:${CPUMINER.proxyPort}`,
        '-O', `${RPC.auth.username}:${RPC.auth.password}`,
        '--no-stratum',
        ...CPUMINER.extraArgs
    ];
    console.log(`[cpuminer] 启动: ${CPUMINER.path} ${args.join(' ')}`);
    return spawn(CPUMINER.path, args, { stdio: 'inherit' });
}

// ========================
// 挖矿执行（复用：正常 / 流产空块）
// ========================
async function mineWithTemplate(template, label = '挖矿') {
    let submitResult = null;
    const proxy = startProxy(template, (r) => { submitResult = r; });
    const miner = spawnCpuminer();

    let minerExited = false;
    miner.on('exit', (code, signal) => {
        minerExited = true;
        console.log(`[cpuminer] 进程退出 code=${code} signal=${signal}`);
    });

    const preMineHeight = await getHeight();
    console.log(`[等待] ${label} 中，当前高度 ${preMineHeight}...`);
    let mined = false;
    while (!mined) {
        await sleep(3000);
        const newHeight = await getHeight();
        if (newHeight > preMineHeight) {
            console.log(`[出块确认] 新高度 ${newHeight}，submitblock 结果:`, submitResult);
            mined = true;
            appendEvent({ type: 'block_mined', height: preMineHeight + 1, new_height: newHeight });
        }
        if (minerExited) {
            console.log('[警告] cpuminer 已终止，中断等待');
            break;
        }
    }

    if (!minerExited) {
        miner.kill('SIGTERM');
    }
    proxy.close();
    return { mined, submitResult };
}

// ========================
// 工具函数
// ========================
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ========================
// 主循环
// ========================
async function main() {
    console.log('=== Miner Bridge 启动 ===');
    console.log(`[配置] 代理端口=${CPUMINER.proxyPort} cpuminer=${CPUMINER.path}`);
    console.log(`[配置] depth范围=[${CONFIG.depthRange.min}, ${CONFIG.depthRange.max}] addressPoolSize=${CONFIG.addressPoolSize}`);

    let lastHeight = await getHeight();
    console.log(`[初始化] 当前高度: ${lastHeight}`);

    while (true) {
        await sleep(2000);

        // 健康检查
        const healthy = await checkNodeHealth();
        if (!healthy) {
            console.log('[警告] 节点 RPC 不响应，等待...');
            continue;
        }

        let height;
        try {
            height = await getHeight(5000);
        } catch {
            console.log('[警告] 获取高度失败，跳过');
            continue;
        }

        if (height <= lastHeight) continue;

        console.log(`\n[新区块] ${lastHeight} -> ${height}`);
        lastHeight = height;
        appendEvent({ type: 'round_start', height });

        const block = await getLatestBlock();
        const utxo = await extractCoinbaseUTXO(block);

        const n = Math.floor(Math.random() * (CONFIG.depthRange.max - CONFIG.depthRange.min + 1)) + CONFIG.depthRange.min;
        console.log(`[本轮参数预设] n=${n} addressPoolSize=${CONFIG.addressPoolSize}`);

        // 1) 生成交易
        updateGeneratorConfig(utxo, height, n, CONFIG.addressPoolSize);
        const genStart = Date.now();
        try {
            run('node generator-mesh-tx.js');
        } catch (err) {
            console.error('[错误] 生成失败:', err.message);
            continue;
        }
        console.log(`[生成耗时] ${Date.now() - genStart}ms`);

        const outDir = `${CONFIG.outputDirPrefix}/${height}-${n}`;
        const txFile = path.join(outDir, 'transactions.txt');
        const graphFile = path.join(outDir, 'graph.json');

        if (!fs.existsSync(txFile) || !fs.existsSync(graphFile)) {
            console.error('[错误] 找不到生成结果文件，跳过本轮');
            continue;
        }

        // 2) 读取实际最大深度 h，并基于 h 计算 m
        const graphData = JSON.parse(fs.readFileSync(graphFile, 'utf-8'));
        const h = graphData.summary?.maxDepthReached || graphData.config?.targetMaxDepth || n;
        if (h <= 1) {
            console.warn(`[警告] 实际最大深度 h=${h} 过小，本轮流产，将挖空块推进链高度`);
            const fallbackTemplate = await rpc('getblocktemplate', []);
            await mineWithTemplate(fallbackTemplate, '空块挖矿（h过小流产）');
            console.log('[本轮结束] 空块已挖出，进入下一轮\n');
            continue;
        }
        const m = Math.floor(Math.random() * (h - 1)) + 1;
        console.log(`[本轮实际参数] h=${h} m=${m}`);

        // 3) 分阶段广播并截取模板
        const template = await broadcastTransactions(txFile, graphFile, h, m, height);
        const templatePath = path.join(outDir, 'template.json');
        fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));
        console.log(`[模板已保存] ${templatePath}`);

        // 4) 启动代理 + cpuminer 挖矿
        await mineWithTemplate(template, 'cpuminer 挖矿');
        console.log('[本轮结束] 清理完成，进入下一轮\n');
    }
}

main().catch(err => {
    console.error('[FATAL]', err);
    process.exit(1);
});
