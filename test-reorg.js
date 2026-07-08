'use strict';

/**
 * test-reorg.js — 重组 + 冲突 完整覆盖测试工具
 *
 * 覆盖场景：
 *   tx1 (5笔 → A)         : mempool 隔离，重组后在 B 侧通过链同步确认
 *   tx2 (5笔 → B)         : 孤块回收后因 conflict 已确认，整链被 evict
 *   tx3 (5笔，分阶段)     : 重叠广播 + 孤块 tx 回归 + 祖先链重建 + 延迟注入
 *   conflict (1笔 → A)    : 与 tx2[0] 双花 coinbase2，测试冲突解决
 *
 * 交易分布：
 *   Phase1 → A : tx1[0-4]  tx3[0,1]  conflict          (8笔)
 *   Phase1 → B : tx2[0-4]  tx3[0,1,2]                  (8笔)
 *   [手动] A出块到h3，B出块到h2（从同一起点h1离线）
 *   Phase2 → B : tx3[3,4]                               (2笔)
 *   [手动] A B接入P2P，B出块到h4
 *
 * 重组后预期：
 *   B mempool 应有   : tx3[2] tx3[3] tx3[4]     (c3 d3 e3)
 *   B mempool 不应有 : tx2[0-4]                 (冲突，整链被evict)
 *   B mempool 不应有 : tx3[0] tx3[1]            (已在A链上确认)
 *
 * 用法：
 *   node test-reorg.js gen \
 *     --txid1 <txid> --sat1 <sat> --key1 <wif> [--vout1 0] \
 *     --txid2 <txid> --sat2 <sat> --key2 <wif> [--vout2 0] \
 *     --txid3 <txid> --sat3 <sat> --key3 <wif> [--vout3 0] \
 *     --a-host <ip> --a-port <port> --a-user <u> --a-pass <p> \
 *     --b-host <ip> --b-port <port> --b-user <u> --b-pass <p> \
 *     [--fee 1000] [--network mainnet]
 *
 *   node test-reorg.js phase1
 *   node test-reorg.js phase2
 *   node test-reorg.js verify --check phase1   (广播后，出块前确认mempool)
 *   node test-reorg.js verify --check reorg    (B重组后，h4出块前)
 *   node test-reorg.js verify --check h4       (B出h4后)
 */

const Transaction = require('tbc-lib-js/lib/transaction/transaction');
const PrivateKey   = require('tbc-lib-js/lib/privatekey');
const Address      = require('tbc-lib-js/lib/address');
const Output       = require('tbc-lib-js/lib/transaction/output');
const Script       = require('tbc-lib-js/lib/script');
const axios        = require('axios');
const fs           = require('fs');
const minimist     = require('minimist');

const STATE_FILE = './reorg-test-state.json';

// ==================== CLI ====================

const argv = minimist(process.argv.slice(2), {
    string: [
        'check',
        'txid1', 'key1', 'txid2', 'key2', 'txid3', 'key3',
        'a-host', 'a-user', 'a-pass',
        'b-host', 'b-user', 'b-pass',
        'network',
    ],
    number: [
        'vout1', 'sat1', 'vout2', 'sat2', 'vout3', 'sat3',
        'a-port', 'b-port', 'fee',
    ],
    boolean: ['help'],
    default: {
        vout1: 0, vout2: 0, vout3: 0,
        fee: 1000,
        network: 'mainnet',
    },
});

const CMD = argv._[0];

if (!CMD || argv.help) { printHelp(); process.exit(0); }

function printHelp() {
    console.log(`
重组覆盖测试工具

命令:
  gen      生成所有交易并保存状态
  phase1   广播第一阶段（出块前）
  phase2   广播第二阶段（A出h3、B出h2后手动调用）
  verify   验证节点状态  --check phase1|reorg|h4

gen 参数:
  --txid1/2/3  coinbase txid（需要3个独立coinbase，txid2同时被conflict双花）
  --sat1/2/3   对应 satoshis 数量
  --key1/2/3   对应私钥 WIF
  --vout1/2/3  输出索引（默认0）
  --a-host/port/user/pass  节点A RPC
  --b-host/port/user/pass  节点B RPC
  --fee        每笔手续费 satoshis（默认1000）
  --network    mainnet | testnet（默认mainnet）

覆盖场景示意：
  Phase1→A: [a1 b1 c1 d1 e1]  [a3 b3]  [conflict]
  Phase1→B: [a2 b2 c2 d2 e2]  [a3 b3 c3]
  Phase2→B: [d3 e3]

  重组后B mempool应有: c3 d3 e3
             不应有:  a2~e2 (冲突evict)  a3 b3 (A链已确认)
`);
}

// ==================== RPC ====================

async function rpcCall(node, method, params = []) {
    const res = await axios.post(node.url, {
        jsonrpc: '1.0', id: 'reorg-test', method, params,
    }, {
        auth: { username: node.username, password: node.password },
        timeout: 30000,
    });
    if (res.data.error) throw new Error(`RPC[${method}] ${JSON.stringify(res.data.error)}`);
    return res.data.result;
}

async function sendRaw(node, hex) {
    try {
        const res = await axios.post(node.url, {
            jsonrpc: '1.0', id: 'send', method: 'sendrawtransaction', params: [hex],
        }, {
            auth: { username: node.username, password: node.password },
            timeout: 30000,
        });
        if (res.data.error) return { ok: false, error: res.data.error.message || JSON.stringify(res.data.error) };
        return { ok: true, txid: res.data.result };
    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;
        return { ok: false, error: msg };
    }
}

// ==================== 交易构建 ====================

const LABELS = ['a', 'b', 'c', 'd', 'e'];

/**
 * 构建线性链: coinbase → [a,b,c,d,e]（5笔单输入单输出）
 */
function buildLinearChain(coinbase, chainSuffix, feePerTx, network) {
    const chain = [];

    let curTxId = coinbase.txId;
    let curVout  = coinbase.outputIndex;
    let curSats  = coinbase.satoshis;
    let curKey   = PrivateKey.fromWIF(coinbase.privateKeyWif);
    let curAddr  = curKey.toAddress().toString();

    for (let i = 0; i < 5; i++) {
        if (curSats <= feePerTx) {
            throw new Error(`链${chainSuffix}[${i}] 资金不足: ${curSats} sat ≤ fee ${feePerTx} sat`);
        }

        const tx     = new Transaction();
        const script = Script.buildPublicKeyHashOut(Address.fromString(curAddr)).toHex();
        tx.from({ txId: curTxId, outputIndex: curVout, script, satoshis: curSats });

        const outSats  = curSats - feePerTx;
        const nextKey  = new PrivateKey(network);
        const nextAddr = nextKey.toAddress().toString();

        tx.addOutput(new Output({
            script: Script.buildPublicKeyHashOut(Address.fromString(nextAddr)).toHex(),
            satoshis: outSats,
        }));
        tx.sign(curKey);

        chain.push({
            name:      LABELS[i] + chainSuffix,
            txId:      tx.id,
            hex:       tx.serialize(),
            satoshis:  outSats,
            outputKey: nextKey.toWIF(),
        });

        curTxId = tx.id; curVout = 0; curSats = outSats;
        curKey  = nextKey; curAddr = nextAddr;
    }
    return chain;
}

/**
 * 构建冲突交易：花费与 tx2[0] 相同的 coinbase2 UTXO，但输出不同地址
 * 发给A，在A链上确认后，coinbase2 UTXO 被花掉，tx2[0] 永久无效
 */
function buildConflictTx(coinbase, feePerTx, network) {
    const curKey  = PrivateKey.fromWIF(coinbase.privateKeyWif);
    const curAddr = curKey.toAddress().toString();
    const script  = Script.buildPublicKeyHashOut(Address.fromString(curAddr)).toHex();

    const tx = new Transaction();
    tx.from({ txId: coinbase.txId, outputIndex: coinbase.outputIndex, script, satoshis: coinbase.satoshis });

    const outSats  = coinbase.satoshis - feePerTx;
    if (outSats <= 0) throw new Error(`conflict tx 资金不足: ${coinbase.satoshis} - ${feePerTx} <= 0`);

    const destKey  = new PrivateKey(network);
    const destAddr = destKey.toAddress().toString();

    tx.addOutput(new Output({
        script: Script.buildPublicKeyHashOut(Address.fromString(destAddr)).toHex(),
        satoshis: outSats,
    }));
    tx.sign(curKey);

    return {
        name:      'conflict',
        txId:      tx.id,
        hex:       tx.serialize(),
        satoshis:  outSats,
        outputKey: destKey.toWIF(),
        note:      `双花 coinbase2 (${coinbase.txId.substring(0, 16)}...) 与 a2 竞争同一 UTXO`,
    };
}

// ==================== 广播 ====================

async function broadcastList(txList, node, label) {
    const tag = label || node.label;
    console.log(`\n  → 节点 ${tag}  (${node.url})   共 ${txList.length} 笔`);
    let ok = 0, fail = 0;

    for (let i = 0; i < txList.length; i++) {
        const t = txList[i];
        const r = await sendRaw(node, t.hex);
        const shortId = t.txId.substring(0, 16) + '...';
        if (r.ok) {
            console.log(`    [✓] ${t.name.padEnd(12)} ${shortId}`);
            ok++;
        } else {
            console.error(`    [✗] ${t.name.padEnd(12)} ${shortId}  ${r.error}`);
            fail++;
        }
    }
    console.log(`  小计: 成功=${ok} 失败=${fail}`);
    return fail;
}

// ==================== 命令: gen ====================

async function cmdGen() {
    // 参数校验
    for (const k of ['txid1','sat1','key1','txid2','sat2','key2','txid3','sat3','key3']) {
        if (argv[k] === undefined || argv[k] === '') throw new Error(`缺少参数: --${k}`);
    }
    if (!argv['a-host'] || !argv['b-host']) throw new Error('需要 --a-host 和 --b-host');

    const fee = argv.fee;
    const net = argv.network;

    const coinbases = [
        { txId: argv.txid1, outputIndex: argv.vout1, satoshis: argv.sat1, privateKeyWif: argv.key1 },
        { txId: argv.txid2, outputIndex: argv.vout2, satoshis: argv.sat2, privateKeyWif: argv.key2 },
        { txId: argv.txid3, outputIndex: argv.vout3, satoshis: argv.sat3, privateKeyWif: argv.key3 },
    ];

    const nodeA = { url: `http://${argv['a-host']}:${argv['a-port']}`, username: argv['a-user'] || '', password: argv['a-pass'] || '', label: 'A' };
    const nodeB = { url: `http://${argv['b-host']}:${argv['b-port']}`, username: argv['b-user'] || '', password: argv['b-pass'] || '', label: 'B' };

    console.log('='.repeat(64));
    console.log('生成交易');
    console.log(`  fee=${fee} sat   network=${net}`);
    console.log('='.repeat(64));

    console.log('\n[tx1链]  coinbase1 → a1-b1-c1-d1-e1  (仅→A)');
    const tx1 = buildLinearChain(coinbases[0], '1', fee, net);
    tx1.forEach(t => console.log(`  ${t.name.padEnd(4)} ${t.txId}  (${t.satoshis} sat)`));

    console.log('\n[tx2链]  coinbase2 → a2-b2-c2-d2-e2  (仅→B)');
    const tx2 = buildLinearChain(coinbases[1], '2', fee, net);
    tx2.forEach(t => console.log(`  ${t.name.padEnd(4)} ${t.txId}  (${t.satoshis} sat)`));

    console.log('\n[tx3链]  coinbase3 → a3-b3-c3-d3-e3  (分阶段)');
    const tx3 = buildLinearChain(coinbases[2], '3', fee, net);
    tx3.forEach(t => console.log(`  ${t.name.padEnd(4)} ${t.txId}  (${t.satoshis} sat)`));

    console.log('\n[conflict]  coinbase2 → conflict_out  (双花a2，仅→A)');
    const conflict = buildConflictTx(coinbases[1], fee, net);
    console.log(`  conflict  ${conflict.txId}  (${conflict.satoshis} sat)`);
    console.log(`  注: ${conflict.note}`);

    // 构建状态
    const serialize = t => ({ name: t.name, txId: t.txId, hex: t.hex, satoshis: t.satoshis, outputKey: t.outputKey });

    const state = {
        generated: new Date().toISOString(),
        fee, network: net,
        nodes: { A: nodeA, B: nodeB },
        coinbaseTxIds: coinbases.map(c => c.txId),
        chains: {
            tx1: tx1.map(serialize),
            tx2: tx2.map(serialize),
            tx3: tx3.map(serialize),
        },
        conflict: serialize(conflict),
        // Phase1 → A: tx1[0..4] + tx3[0,1] + conflict
        phase1A: [...tx1.map(t=>t.txId), tx3[0].txId, tx3[1].txId, conflict.txId],
        // Phase1 → B: tx2[0..4] + tx3[0,1,2]
        phase1B: [...tx2.map(t=>t.txId), tx3[0].txId, tx3[1].txId, tx3[2].txId],
        // Phase2 → B: tx3[3,4]
        phase2B: [tx3[3].txId, tx3[4].txId],
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

    // 汇总
    const nameOf = ids => ids.map(id => txMap(state)[id]?.name || id.substring(0,8)).join('  ');
    console.log('\n' + '='.repeat(64));
    console.log('广播计划汇总');
    console.log('='.repeat(64));
    console.log(`Phase1 → A (${state.phase1A.length}笔): ${nameOf(state.phase1A)}`);
    console.log(`Phase1 → B (${state.phase1B.length}笔): ${nameOf(state.phase1B)}`);
    console.log(`Phase2 → B (${state.phase2B.length}笔): ${nameOf(state.phase2B)}`);
    console.log('\n重叠 (A和B都有): a3  b3');
    console.log('冲突 (仅A): conflict  双花了 coinbase2，会导致 tx2 整链在重组后被evict');
    console.log(`\n状态已保存: ${STATE_FILE}`);
    console.log('\n下一步: node test-reorg.js phase1');
}

// ==================== 命令: phase1 ====================

async function cmdPhase1() {
    const state = loadState();
    const { A, B } = state.nodes;
    const map = txMap(state);

    console.log('='.repeat(64));
    console.log('Phase1 广播');
    console.log('='.repeat(64));

    let fail = 0;
    fail += await broadcastList(state.phase1A.map(id => map[id]), A);
    fail += await broadcastList(state.phase1B.map(id => map[id]), B);

    console.log('\n' + '='.repeat(64));
    if (fail === 0) {
        console.log('[✓] Phase1 完成，所有交易已发送');
        console.log('\n现在请验证两个节点的mempool:');
        console.log('  node test-reorg.js verify --check phase1');
        console.log('\n然后手动让:');
        console.log('  节点A 出块到 h3（比起点h1多2个块）');
        console.log('  节点B 出块到 h2（比起点h1多1个块）');
        console.log('\n出块完成后: node test-reorg.js phase2');
    } else {
        console.error(`\n[✗] 有 ${fail} 笔失败，请检查`);
        process.exitCode = 1;
    }
}

// ==================== 命令: phase2 ====================

async function cmdPhase2() {
    const state = loadState();
    const { B } = state.nodes;
    const map = txMap(state);

    console.log('='.repeat(64));
    console.log('Phase2 广播  →  节点B');
    console.log('='.repeat(64));

    const fail = await broadcastList(state.phase2B.map(id => map[id]), B);

    console.log('\n' + '='.repeat(64));
    if (fail === 0) {
        console.log('[✓] Phase2 完成');
        console.log('\n现在:');
        console.log('  1. 将节点A、B接入P2P网络（B应触发重组，采纳A的更长链）');
        console.log('  2. 在B节点出块到h4');
        console.log('\n重组后验证: node test-reorg.js verify --check reorg');
        console.log('h4后验证:   node test-reorg.js verify --check h4');
    } else {
        process.exitCode = 1;
    }
}

// ==================== 命令: verify ====================

async function cmdVerify() {
    const state = loadState();
    const check = argv.check;
    if (!check) throw new Error('需要 --check phase1|reorg|h4');

    const { A, B } = state.nodes;

    console.log('='.repeat(64));
    console.log(`验证点: ${check}`);
    console.log('='.repeat(64));

    // 查询双节点mempool
    const mempoolA = await fetchMempool(A);
    const mempoolB = await fetchMempool(B);
    const heightA  = await fetchHeight(A);
    const heightB  = await fetchHeight(B);

    if (heightA !== null) console.log(`\n节点A 当前高度: ${heightA}`);
    if (heightB !== null) console.log(`节点B 当前高度: ${heightB}`);

    switch (check) {
        case 'phase1': await verifyPhase1(state, mempoolA, mempoolB); break;
        case 'reorg':  await verifyReorg(state, mempoolA, mempoolB, A, B); break;
        case 'h4':     await verifyH4(state, mempoolA, mempoolB, A, B); break;
        default: throw new Error(`未知 --check 值: ${check}，可选 phase1|reorg|h4`);
    }
}

// ---- verify phase1: 检查广播后、出块前mempool ----
async function verifyPhase1(state, mempoolA, mempoolB) {
    const { tx1, tx2, tx3 } = state.chains;
    const conflict = state.conflict;
    let pass = true;

    console.log('\n[节点A mempool] 应有: tx1全部 + tx3[0,1] + conflict');
    const expectA = [...tx1, tx3[0], tx3[1], conflict];
    pass &= checkPresent(mempoolA, expectA, 'A');
    checkAbsent(mempoolA, [...tx2, tx3[2], tx3[3], tx3[4]], 'A（不应有）');

    console.log('\n[节点B mempool] 应有: tx2全部 + tx3[0,1,2]');
    const expectB = [...tx2, tx3[0], tx3[1], tx3[2]];
    pass &= checkPresent(mempoolB, expectB, 'B');
    checkAbsent(mempoolB, [...tx1, tx3[3], tx3[4], conflict], 'B（不应有）');

    printResult(pass, 'phase1');
}

// ---- verify reorg: 重组后、B出h4前 ----
async function verifyReorg(state, mempoolA, mempoolB, nodeA, nodeB) {
    const { tx1, tx2, tx3 } = state.chains;
    const conflict = state.conflict;
    let pass = true;

    // B mempool：应有 tx3[2,3,4]
    console.log('\n[节点B mempool] 应有: c3 d3 e3 (tx3[2,3,4])');
    pass &= checkPresent(mempoolB, [tx3[2], tx3[3], tx3[4]], 'B');

    // B mempool：不应有 tx2（冲突被evict）
    console.log('\n[节点B mempool] 不应有: a2~e2 (conflict已确认，tx2整链被evict)');
    pass &= checkAbsent(mempoolB, tx2, 'B');

    // B mempool：不应有 tx3[0,1]（A链已确认）
    console.log('\n[节点B mempool] 不应有: a3 b3 (已在A链上确认)');
    pass &= checkAbsent(mempoolB, [tx3[0], tx3[1]], 'B');

    // P2P传播检查：B的 c3 d3 e3 是否已传播到A
    console.log('\n[P2P传播] 检查 c3 d3 e3 是否已传播到节点A');
    for (const t of [tx3[2], tx3[3], tx3[4]]) {
        const inA = mempoolA?.has(t.txId);
        console.log(`  ${inA ? '[✓]' : '[?]'} ${t.name} ${inA ? '已在A mempool中' : '暂未在A mempool（P2P可能延迟）'}`);
    }

    // A mempool不应有 tx2（不应从B接收被evict的tx）
    console.log('\n[节点A mempool] 不应有: a2~e2 (冲突交易)');
    pass &= checkAbsent(mempoolA, tx2, 'A');

    // conflict tx 确认状态
    console.log('\n[conflict tx] 应在A链上已确认');
    const confA = await queryTx(nodeA, conflict.txId);
    if (confA?.confirmations > 0) {
        console.log(`  [✓] conflict 已确认  confirmations=${confA.confirmations}`);
    } else {
        console.log(`  [✗] conflict 未确认（预期已被A打包）`);
        pass = false;
    }

    // a2 应已无效
    console.log('\n[a2 (tx2[0])] 应不可查或未确认（coinbase2已被conflict花掉）');
    const a2B = await queryTx(nodeB, tx2[0].txId);
    if (!a2B) {
        console.log('  [✓] a2 不可查（已从节点B彻底驱逐）');
    } else if (a2B.confirmations > 0) {
        console.log(`  [✗] a2 意外确认，confirmations=${a2B.confirmations}`);
        pass = false;
    } else {
        console.log('  [?] a2 存在但未确认（仍在B mempool中？）');
    }

    // tx1 应在B侧可见（B重组后从A链同步）
    console.log('\n[tx1链] 在B侧应已确认（B采纳A链后）');
    for (const t of tx1) {
        const info = await queryTx(nodeB, t.txId);
        const conf = info?.confirmations ?? 0;
        console.log(`  ${conf > 0 ? '[✓]' : '[?]'} ${t.name}  confirmations=${conf}`);
    }

    printResult(pass, 'reorg');
}

// ---- verify h4: B出块后 ----
async function verifyH4(state, mempoolA, mempoolB, nodeA, nodeB) {
    const { tx1, tx2, tx3 } = state.chains;
    const conflict = state.conflict;
    let pass = true;

    // 两节点mempool都应为空
    console.log('\n[mempool] 两节点应均为空');
    for (const [lbl, mp] of [['A', mempoolA], ['B', mempoolB]]) {
        if (mp === null) { console.log(`  [?] 节点${lbl} 无法查询`); continue; }
        if (mp.size === 0) {
            console.log(`  [✓] 节点${lbl} mempool 为空`);
        } else {
            console.log(`  [?] 节点${lbl} mempool 剩余 ${mp.size} 笔:`);
            for (const id of mp) console.log(`      ${id}`);
        }
    }

    // tx3[2,3,4] 在B侧应已确认
    console.log('\n[tx3[2,3,4]] 应在B的h4块中确认');
    for (const t of [tx3[2], tx3[3], tx3[4]]) {
        const info = await queryTx(nodeB, t.txId);
        const ok   = (info?.confirmations ?? 0) > 0;
        console.log(`  ${ok ? '[✓]' : '[✗]'} ${t.name}  confirmations=${info?.confirmations ?? 0}`);
        if (!ok) pass = false;
    }

    // tx2 整链不应确认
    console.log('\n[tx2链] 不应确认（被evict，coinbase2已被conflict花掉）');
    for (const t of tx2) {
        const info = await queryTx(nodeB, t.txId);
        if (!info) {
            console.log(`  [✓] ${t.name} 不可查（已evict）`);
        } else if ((info.confirmations ?? 0) > 0) {
            console.log(`  [✗] ${t.name} 意外确认  confirmations=${info.confirmations}`);
            pass = false;
        } else {
            console.log(`  [?] ${t.name} 存在但未确认`);
        }
    }

    // tx1 和 conflict 在两侧都应已确认
    console.log('\n[tx1 + conflict] 在B侧应已确认（从A链同步）');
    for (const t of [...tx1, conflict]) {
        const info = await queryTx(nodeB, t.txId);
        const ok   = (info?.confirmations ?? 0) > 0;
        console.log(`  ${ok ? '[✓]' : '[?]'} ${t.name}  confirmations=${info?.confirmations ?? 0}`);
    }

    // tx3[0,1] 在两侧已确认（A链打包）
    console.log('\n[tx3[0,1]] 在B侧应已确认（A链打包，重组后同步）');
    for (const t of [tx3[0], tx3[1]]) {
        const info = await queryTx(nodeB, t.txId);
        const ok   = (info?.confirmations ?? 0) > 0;
        console.log(`  ${ok ? '[✓]' : '[?]'} ${t.name}  confirmations=${info?.confirmations ?? 0}`);
    }

    printResult(pass, 'h4');
}

// ==================== 工具函数 ====================

function loadState() {
    if (!fs.existsSync(STATE_FILE)) {
        throw new Error(`状态文件不存在: ${STATE_FILE}，请先运行 gen`);
    }
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
}

function txMap(state) {
    const map = {};
    for (const t of [...state.chains.tx1, ...state.chains.tx2, ...state.chains.tx3]) {
        map[t.txId] = t;
    }
    map[state.conflict.txId] = state.conflict;
    return map;
}

async function fetchMempool(node) {
    try {
        const list = await rpcCall(node, 'getrawmempool');
        return new Set(list);
    } catch (e) {
        console.error(`  [?] 节点${node.label} getrawmempool 失败: ${e.message}`);
        return null;
    }
}

async function fetchHeight(node) {
    try { return await rpcCall(node, 'getblockcount'); }
    catch (_) { return null; }
}

async function queryTx(node, txid) {
    try { return await rpcCall(node, 'getrawtransaction', [txid, true]); }
    catch (_) { return null; }
}

function checkPresent(mempool, txList, nodeLabel) {
    let pass = true;
    if (!mempool) { console.log(`  [?] 节点${nodeLabel} mempool 不可用`); return false; }
    for (const t of txList) {
        const found = mempool.has(t.txId);
        console.log(`  ${found ? '[✓]' : '[✗]'} ${t.name.padEnd(12)} ${t.txId.substring(0,16)}...  ${found ? 'mempool中' : '❌ 不在mempool（应在）'}`);
        if (!found) pass = false;
    }
    return pass;
}

function checkAbsent(mempool, txList, nodeLabel) {
    let pass = true;
    if (!mempool) return true;
    for (const t of txList) {
        const found = mempool.has(t.txId);
        if (found) {
            console.log(`  [✗] ${t.name.padEnd(12)} ${t.txId.substring(0,16)}...  ❌ 仍在mempool（应已清除）`);
            pass = false;
        } else {
            console.log(`  [✓] ${t.name.padEnd(12)} ${t.txId.substring(0,16)}...  不在mempool（预期）`);
        }
    }
    return pass;
}

function printResult(pass, stage) {
    console.log('\n' + '='.repeat(64));
    console.log(pass
        ? `[✓] verify --check ${stage}  全部通过`
        : `[✗] verify --check ${stage}  存在不符合预期的项，请检查节点日志`);
    console.log('='.repeat(64));
}

// ==================== 入口 ====================

async function main() {
    switch (CMD) {
        case 'gen':    await cmdGen();    break;
        case 'phase1': await cmdPhase1(); break;
        case 'phase2': await cmdPhase2(); break;
        case 'verify': await cmdVerify(); break;
        default:
            console.error(`未知命令: ${CMD}`);
            printHelp();
            process.exit(1);
    }
}

main().catch(err => {
    console.error('\n[错误]', err.message);
    process.exit(1);
});
