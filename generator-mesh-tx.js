(function checkDependencies() {
    const required = ['tbc-lib-js', 'minimist'];
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

const Transaction = require('tbc-lib-js/lib/transaction/transaction');
const PrivateKey = require('tbc-lib-js/lib/privatekey');
const Address = require('tbc-lib-js/lib/address');
const Output = require('tbc-lib-js/lib/transaction/output');
const Script = require('tbc-lib-js/lib/script');
const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

// ==================== 配置区域 ====================
//
// 【可复现性说明】
// 要生成完全相同的交易链，必须同时满足以下条件：
//   1. randomSeed 必须相同（控制随机序列）
//   2. targetMaxDepth 必须相同（或 >= 之前的高度）
//   3. initialUtxos 必须完全相同（链的根节点）
//   4. addressPoolSize/feePerTx 等配置必须相同
//
// 【参数关系】
// - randomSeed: 设为 null 则每次随机；设为数字（如 12345）则可复现
// - targetMaxDepth: 与 randomSeed 独立，可同时修改
// - initialUtxos: 如果改变，即使 randomSeed 相同，整个链也会完全不同
//
// 【示例场景】
//   randomSeed: 12345, targetMaxDepth: 100  →  可复现的100深度链
//   randomSeed: 12345, targetMaxDepth: 200  →  前100笔相同，继续生成到200
//   randomSeed: null,  targetMaxDepth: 100  →  每次运行都不同
//
// 【并发模式】
// 支持通过命令行参数传入配置，避免文件竞争：
//   node generator-mesh-tx.js --txid <txid> --vout <n> --satoshis <n> --depth <n> --outputdir <path>
//
// ============================================================

// 从命令行参数解析配置（用于并发模式）
const argv = minimist(process.argv.slice(2), {
    string: ['config', 'txid', 'outputdir', 'privkey'],
    number: ['vout', 'satoshis', 'depth', 'seed'],
    boolean: ['reuse-keys'],
    default: {}
});

// 基础配置模板
const BASE_CONFIG = {
    maxTransactions: 100000,
    addressPoolSize: 1000,
    maxP2pkhInputs: 10,
    feePerTx: 1000,
    minSplitAmount: 1000000,
    batchSize: 1000,
    randomSeed: null,
};

// 构建最终配置
let CONFIG;

if (argv.config) {
    // 从配置文件加载
    const configPath = argv.config;
    if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        CONFIG = { ...BASE_CONFIG, ...fileConfig };
        console.log(`[配置] 从文件加载: ${configPath}`);
    } else {
        throw new Error(`配置文件不存在: ${configPath}`);
    }
} else if (argv.txid && argv.vout !== undefined && argv.satoshis !== undefined) {
    // 从命令行参数构建配置（并发模式）
    CONFIG = {
        ...BASE_CONFIG,
        initialUtxos: [{
            txId: argv.txid,
            outputIndex: argv.vout,
            satoshis: argv.satoshis,
            privateKeyWif: argv.privkey || 'L1u2TmR7hMMMSV9Bx2Lyt3sujbboqEFqnKygnPRnQERhKB4qptuK'
        }],
        targetMaxDepth: argv.depth || 2000,
        outputDir: argv.outputdir || './mesh-chain-output/default',
        randomSeed: argv.seed || null,
    };
    console.log(`[配置] 从命令行参数构建: txid=${argv.txid}, vout=${argv.vout}, depth=${CONFIG.targetMaxDepth}`);
} else {
    // 默认配置（向后兼容）
    CONFIG = {
        ...BASE_CONFIG,
        initialUtxos: [
            {
                txId: "f069929384673f540f2fb425369ab0f18e4e5a2249b7cf830167c3c5e54598f1",
                outputIndex: 1,
                satoshis: 414957762,
                privateKeyWif: "L1u2TmR7hMMMSV9Bx2Lyt3sujbboqEFqnKygnPRnQERhKB4qptuK"
            },
        ],
        targetMaxDepth: 6878,
        outputDir: './mesh-chain-output/824521-6878',
        randomSeed: null,
    };
}

CONFIG.reuseKeys = Boolean(argv['reuse-keys']);

// ==================== 随机数生成器 ====================

class SeededRandom {
    constructor(seed) {
        this.seed = seed || Date.now();
        this.initialSeed = this.seed;
    }

    next() {
        this.seed = (this.seed * 9301 + 49297) % 233280;
        return this.seed / 233280;
    }

    nextInt(min, max) {
        return Math.floor(this.next() * (max - min + 1)) + min;
    }

    pick(array) {
        return array[this.nextInt(0, array.length - 1)];
    }

    shuffle(array) {
        const result = [...array];
        for (let i = result.length - 1; i > 0; i--) {
            const j = this.nextInt(0, i);
            [result[i], result[j]] = [result[j], result[i]];
        }
        return result;
    }
}

// ==================== 全局交易图（共享数据结构） ====================

class TransactionGraph {
    constructor() {
        // 交易节点: txId -> { inputs: [...], outputs: [...], depth, parentIds: Set }
        this.nodes = new Map();

        // UTXO池: "txId:index" -> { ownerAddress, satoshis, depth, parentTxId }
        this.utxos = new Map();

        // 已花费UTXO
        this.spent = new Set();

        // 增量未花费索引：addUtxo/spendUtxo 时同步维护，避免 getUnspentUtxos 扫描全量 UTXO（O(N²)→O(N)）
        this.unspentIndex = new Map();   // key -> utxo record

        // 统计
        this.stats = {
            totalTx: 0,
            maxDepth: 0,
            mergeCount: 0,
            splitCount: 0,
        };
    }

    // 添加初始UTXO
    addInitialUtxos(utxos, addressPool) {
        for (const utxo of utxos) {
            const ownerAddress = utxo.ownerAddress;
            if (!ownerAddress) {
                throw new Error(`UTXO ${utxo.txId}:${utxo.outputIndex} 没有设置ownerAddress`);
            }
            const key = this.makeUtxoKey(utxo.txId, utxo.outputIndex);
            const rec = {
                txId: utxo.txId,
                outputIndex: utxo.outputIndex,
                ownerAddress,
                satoshis: utxo.satoshis,
                depth: 0,
                parentTxId: null,
                isExternal: true,
            };
            this.utxos.set(key, rec);
            this.unspentIndex.set(key, rec);  // 入增量索引
        }
    }

    // 添加交易节点（不重复存储祖先，只记录父关系）
    addTransaction(txId, inputs, outputs, depth, fee = 0) {
        const parentIds = new Set();
        for (const inp of inputs) {
            parentIds.add(inp.txId);
        }

        this.nodes.set(txId, {
            txId,
            inputs: inputs.map(i => ({ txId: i.txId, outputIndex: i.outputIndex, address: i.ownerAddress })),
            outputs: outputs.map((o, i) => ({ index: i, address: o.address })),
            depth,
            fee,
            parentIds,
            inputCount: inputs.length,
            outputCount: outputs.length,
        });

        // 更新统计
        this.stats.totalTx++;
        this.stats.maxDepth = Math.max(this.stats.maxDepth, depth);
        if (inputs.length > 1) this.stats.mergeCount++;
        if (outputs.length > 1) this.stats.splitCount++;
    }

    // 添加新UTXO（只记录父交易ID）
    addUtxo(txId, outputIndex, satoshis, ownerAddress, depth, parentTxId) {
        const key = this.makeUtxoKey(txId, outputIndex);
        const rec = { txId, outputIndex, ownerAddress, satoshis, depth, parentTxId };
        this.utxos.set(key, rec);
        // 同步入增量索引（若已被 spend 则不入，recordResult 中先 spend 再 add 的顺序安全）
        if (!this.spent.has(key)) {
            this.unspentIndex.set(key, rec);
        }
    }

    // 标记已花费
    spendUtxo(txId, outputIndex) {
        const key = this.makeUtxoKey(txId, outputIndex);
        this.spent.add(key);
        this.unspentIndex.delete(key);  // O(1) 从增量索引删除
    }

    // 获取未花费UTXO — O(unspent_count)，不扫描已花费
    getUnspentUtxos(minAmount = 0) {
        if (minAmount <= 0) return Array.from(this.unspentIndex.values());
        const result = [];
        for (const utxo of this.unspentIndex.values()) {
            if (utxo.satoshis >= minAmount) result.push(utxo);
        }
        return result;
    }

    // 计算交易的祖先高度（动态计算，不存储）
    calculateDepth(inputUtxos) {
        let maxParentDepth = 0;
        for (const utxo of inputUtxos) {
            maxParentDepth = Math.max(maxParentDepth, utxo.depth);
        }
        return maxParentDepth + 1;
    }

    // 获取可用的UTXO组合（1~maxInputs个）
    // 策略：只从当前池中深度最浅的一层选取，确保 BFS 层序推进
    getUtxosForNewTx(rng, maxInputs, maxDepth, minAmount) {
        const unspent = this.getUnspentUtxos(minAmount);

        // 过滤深度超限，同时用循环求最小深度（避免 Math.min(...arr) 在大数组时栈溢出）
        let minDepth = Infinity;
        const validUtxos = [];
        for (const u of unspent) {
            if (u.depth < maxDepth) {
                validUtxos.push(u);
                if (u.depth < minDepth) minDepth = u.depth;
            }
        }

        if (validUtxos.length === 0) return [];

        // 只从最浅层选取
        const sameLayerUtxos = validUtxos.filter(u => u.depth === minDepth);

        const inputCount = rng.nextInt(1, Math.min(maxInputs, sameLayerUtxos.length));
        const shuffled = rng.shuffle(sameLayerUtxos);
        return shuffled.slice(0, inputCount);
    }

    // 查找根交易（父交易不在nodes中的，包括引用初始UTXO的）
    findRootTxIds() {
        const roots = new Set();
        for (const [txId, node] of this.nodes) {
            // 检查是否所有父交易都不在nodes中（即为初始UTXO或外部交易）
            let hasParentInMempool = false;
            for (const parentId of node.parentIds) {
                if (parentId && this.nodes.has(parentId)) {
                    hasParentInMempool = true;
                    break;
                }
            }
            if (!hasParentInMempool) {
                roots.add(txId);
            }
        }
        return Array.from(roots);
    }

    // 树形打印：借鉴 DebugPrintMempoolTreeNL
    printTree(maxDepth = 10) {
        // 用数组收集行，避免字符串传值导致递归写入丢失
        const lines = [];
        lines.push('\n' + '='.repeat(80));
        lines.push('交易树结构（借鉴 DebugPrintMempoolTreeNL）');
        lines.push('='.repeat(80));

        const roots = this.findRootTxIds();

        if (roots.length === 0) {
            lines.push('[No root transactions]');
            return lines.join('\n') + '\n';
        }

        lines.push(`根交易数: ${roots.length} | 总交易数: ${this.stats.totalTx} | 最大深度: ${this.stats.maxDepth}\n`);

        const visited = new Set();

        for (const rootId of roots) {
            this.printTreeRecursive(rootId, visited, 0, maxDepth, lines);
        }

        let unvisitedCount = 0;
        for (const [txId, node] of this.nodes) {
            if (!visited.has(txId)) {
                if (unvisitedCount === 0) {
                    lines.push('\n[Additional transactions not in main trees]:');
                }
                unvisitedCount++;
                if (unvisitedCount <= 5) {
                    lines.push(`  ${this.getTxLabel(txId)}`);
                }
            }
        }
        if (unvisitedCount > 5) {
            lines.push(`  ... and ${unvisitedCount - 5} more`);
        }

        lines.push('='.repeat(80));
        return lines.join('\n') + '\n';
    }

    // 递归打印树节点（向 lines 数组追加，而非字符串拼接）
    printTreeRecursive(txId, visited, depth, maxDepth, lines) {
        const indent = '    '.repeat(depth);

        if (visited.has(txId)) {
            lines.push(`${indent}└── [REF: ${txId.substring(0, 16)}...]`);
            return;
        }

        const node = this.nodes.get(txId);
        if (!node) {
            lines.push(`${indent}[INITIAL: ${txId.substring(0, 16)}...]`);
            return;
        }

        visited.add(txId);
        lines.push(`${indent}${this.getTxLabel(txId, node)}`);

        if (depth >= maxDepth) {
            const children = this.findChildren(txId);
            if (children.length > 0) {
                lines.push(`${'    '.repeat(depth + 1)}└── ... ${children.length} children (depth limit)`);
            }
            return;
        }

        const children = this.findChildren(txId);
        for (const childId of children) {
            this.printTreeRecursive(childId, visited, depth + 1, maxDepth, lines);
        }
    }

    // 查找子交易
    findChildren(parentTxId) {
        const children = [];
        for (const [txId, node] of this.nodes) {
            if (node.parentIds.has(parentTxId)) {
                children.push(txId);
            }
        }
        return children;
    }

    // 获取交易标签
    getTxLabel(txId, node = null) {
        if (!node) node = this.nodes.get(txId);
        if (!node) return `${txId.substring(0, 16)}... [unknown]`;

        const mergeMark = node.inputCount > 1 ? ` [MERGE:${node.inputCount}]` : '';
        const splitMark = node.outputCount > 1 ? ` [SPLIT:${node.outputCount}]` : '';

        // 显示父交易信息（只显示外部父交易，即不在nodes中的）
        let parentInfo = '';
        const externalParents = [];
        for (const parentId of node.parentIds) {
            if (parentId && !this.nodes.has(parentId)) {
                externalParents.push(parentId.substring(0, 8));
            }
        }
        if (externalParents.length > 0) {
            parentInfo = ` <-[${externalParents.join(',')}...]`;
        }

        return `${txId.substring(0, 16)}... d=${node.depth}${mergeMark}${splitMark}${parentInfo}`;
    }

    // 生成统计摘要
    getSummary() {
        return {
            totalTransactions: this.stats.totalTx,
            maxDepthReached: this.stats.maxDepth,
            mergeTransactions: this.stats.mergeCount,
            splitTransactions: this.stats.splitCount,
            unspentUtxos: this.getUnspentUtxos().length,
        };
    }

    makeUtxoKey(txId, outputIndex) {
        return `${txId}:${outputIndex}`;
    }
}

// ==================== 地址池管理 ====================

class AddressPool {
    constructor(size, network = 'mainnet', reuseFile = null) {
        this.keys = [];
        this.addresses = [];
        this.indexMap = new Map();
        this.network = network;

        this.externalKeys = new Map(); // address -> { key, label, wif }
        this.scriptCache  = new Map(); // address -> scriptHex（预计算，O(1) 查询）

        if (reuseFile && fs.existsSync(reuseFile)) this.loadKeys(reuseFile, size);
        else this.generateKeys(size);
    }

    importPrivateKey(wif, label = 'external') {
        const privateKey = PrivateKey.fromWIF(wif);
        const address = privateKey.toAddress().toString();

        this.externalKeys.set(address, { key: privateKey, label, wif });
        // 同步缓存 script
        this.scriptCache.set(address,
            Script.buildPublicKeyHashOut(Address.fromString(address)).toHex());

        console.log(`[AddressPool] 导入外部私钥: ${address} (${label})`);
        return address;
    }

    generateKeys(count) {
        console.log(`[AddressPool] 生成 ${count} 个新的私钥/地址对...`);

        for (let i = 0; i < count; i++) {
            const privateKey = new PrivateKey(this.network);
            const address = privateKey.toAddress();
            const addrStr = address.toString();

            this.keys.push(privateKey);
            this.addresses.push(addrStr);
            this.indexMap.set(addrStr, i);
            // 预计算并缓存 P2PKH locking script
            this.scriptCache.set(addrStr, Script.buildPublicKeyHashOut(address).toHex());
        }
    }

    loadKeys(file, count) {
        const wifs = fs.readFileSync(file, 'utf8').split('\n').map(line => {
            const match = line.match(/^\[\d+\]\s+\S+\s+\|\s+(\S+)\s*$/);
            return match?.[1];
        }).filter(Boolean);
        if (wifs.length < count) throw new Error(`地址池文件不完整: ${file} (${wifs.length}/${count})`);
        console.log(`[AddressPool] 复用 ${count} 个已保存私钥: ${file}`);
        for (const wif of wifs.slice(0, count)) {
            const privateKey = PrivateKey.fromWIF(wif);
            const address = privateKey.toAddress();
            const addrStr = address.toString();
            this.keys.push(privateKey);
            this.addresses.push(addrStr);
            this.indexMap.set(addrStr, this.keys.length - 1);
            this.scriptCache.set(addrStr, Script.buildPublicKeyHashOut(address).toHex());
        }
    }

    getPrivateKeyForAddress(address) {
        if (this.externalKeys.has(address)) {
            return this.externalKeys.get(address).key;
        }
        const index = this.indexMap.get(address);
        if (index === undefined) return null;
        return this.keys[index];
    }

    hasAddress(address) {
        return this.externalKeys.has(address) || this.indexMap.has(address);
    }

    getScriptForAddress(addressStr) {
        // O(1) 缓存命中；外部地址 fallback 到实时计算
        return this.scriptCache.get(addressStr)
            ?? Script.buildPublicKeyHashOut(Address.fromString(addressStr)).toHex();
    }

    saveKeysToFile(outputDir) {
        const outputPath = path.join(outputDir, 'keys.txt');
        let content = '# 生成的私钥/地址对 - 请妥善保管！\n';
        content += '='.repeat(80) + '\n';

        for (let i = 0; i < this.keys.length; i++) {
            content += `[${i}] ${this.addresses[i]} | ${this.keys[i].toWIF()}\n`;
        }

        const tmp = `${outputPath}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, content);
        fs.renameSync(tmp, outputPath);
        console.log(`[AddressPool] 私钥已保存到: ${outputPath}`);
    }
}

// ==================== 流式写入器 ====================

class StreamingWriter {
    constructor(outputDir, batchSize) {
        this.outputDir = outputDir;
        this.batchSize = batchSize;
        this.transactionsBuffer = [];
        this.totalWritten = 0;

        // 创建追加写入流
        this.txStream = fs.createWriteStream(path.join(outputDir, 'transactions.txt'), { flags: 'a' });
    }

    addTransaction(serialized) {
        this.transactionsBuffer.push(serialized);

        if (this.transactionsBuffer.length >= this.batchSize) {
            this.flush();
        }
    }

    flush() {
        if (this.transactionsBuffer.length === 0) return;

        const data = this.transactionsBuffer.join('\n') + '\n';
        this.txStream.write(data);
        this.totalWritten += this.transactionsBuffer.length;
        this.transactionsBuffer = [];
    }

    close() {
        this.flush();
        this.txStream.end();
    }
}

// ==================== 网状链构建器 ====================

class MeshChainBuilder {
    constructor(config) {
        this.config = config;
        this.rng = new SeededRandom(config.randomSeed);
        this.graph = new TransactionGraph();
        this.addressPool = null;
        this.writer = null;
    }

    async init() {
        console.log('='.repeat(80));
        console.log('网状交易链构建器 v2（内存优化版）');
        console.log('='.repeat(80));

        // 检查资金
        this.checkInitialFunds();

        // 创建输出目录
        if (!fs.existsSync(this.config.outputDir)) {
            fs.mkdirSync(this.config.outputDir, { recursive: true });
        }

        // 清空之前的交易文件
        fs.writeFileSync(path.join(this.config.outputDir, 'transactions.txt'), '');

        // 初始化地址池
        const keyFile = this.config.reuseKeys ? path.join(this.config.outputDir, 'keys.txt') : null;
        this.addressPool = new AddressPool(this.config.addressPoolSize, this.config.network, keyFile);

        // === 导入初始UTXO的私钥 ===
        console.log('\n[初始化] 导入初始UTXO私钥...');
        for (const utxo of this.config.initialUtxos) {
            if (utxo.privateKeyWif) {
                const address = this.addressPool.importPrivateKey(
                    utxo.privateKeyWif,
                    `initial-${utxo.txId.substring(0,8)}`
                );
                // 将地址关联到UTXO
                utxo.ownerAddress = address;
            } else {
                throw new Error(`初始UTXO ${utxo.txId}:${utxo.outputIndex} 缺少私钥`);
            }
        }

        this.addressPool.saveKeysToFile(this.config.outputDir);

        // 初始化流式写入器
        this.writer = new StreamingWriter(this.config.outputDir, this.config.batchSize);

        // 初始化交易图 - 使用正确的ownerAddress
        this.graph.addInitialUtxos(this.config.initialUtxos, this.addressPool);

        console.log(`\n[初始化] 随机种子: ${this.rng.initialSeed}`);
        console.log(`[初始化] 地址池大小: ${this.addressPool.addresses.length}`);
        console.log(`[初始化] 初始UTXO: ${this.config.initialUtxos.length}`);
        console.log(`[初始化] 流式写入批次: ${this.config.batchSize}\n`);
    }

    checkInitialFunds() {
        const totalInput = this.config.initialUtxos.reduce((sum, u) => sum + u.satoshis, 0);
        const minRequired = this.config.targetMaxDepth * this.config.feePerTx;

        console.log('\n[资金检查]');
        console.log(`  初始总金额: ${totalInput} 聪 (${(totalInput / 1e8).toFixed(4)} TBC)`);
        console.log(`  目标深度: ${this.config.targetMaxDepth}`);
        console.log(`  预计最少需要: ${minRequired} 聪`);

        if (totalInput < minRequired) {
            throw new Error(`资金不足！至少需要 ${minRequired} 聪`);
        }

        console.log('  [✓] 资金充足\n');
    }

    async buildMesh() {
        await this.init();

        console.log(`[构建] 目标最大深度: ${this.config.targetMaxDepth}`);
        console.log(`[构建] 最大交易数: ${this.config.maxTransactions}\n`);

        let iteration = 0;
        const startTime = Date.now();

        // 宽度诊断：按深度记录每层的交易数，用于分析 depth:txs 比值
        const depthTxCount = new Map();   // depth -> tx count
        let widthSamples = [];            // [{iter, depth, utxoPoolSize}]

        while (iteration < this.config.maxTransactions) {
            // 获取可用UTXO（1~maxP2pkhInputs个输入）
            const inputs = this.graph.getUtxosForNewTx(
                this.rng,
                this.config.maxP2pkhInputs,
                this.config.targetMaxDepth,
                this.config.minSplitAmount
            );

            if (inputs.length === 0) {
                console.log(`\n[停止] 没有可用UTXO`);
                break;
            }

            // 计算深度
            const newDepth = this.graph.calculateDepth(inputs);

            if (newDepth > this.config.targetMaxDepth) {
                console.log(`\n[停止] 达到目标深度: ${this.config.targetMaxDepth}`);
                break;
            }

            // 构建交易
            const result = await this.buildTransaction(inputs, newDepth);

            if (!result) {
                console.log(`\n[警告] 构建交易失败，跳过`);
                continue;
            }

            // 流式写入
            this.writer.addTransaction(result.serialized);

            // 宽度统计
            depthTxCount.set(newDepth, (depthTxCount.get(newDepth) || 0) + 1);

            iteration++;

            // 进度报告 + 宽度诊断采样
            if (iteration % 1000 === 0 || iteration === 1) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                const unspentList = this.graph.getUnspentUtxos();  // 只调用一次
                const unspent = unspentList.length;
                const totalUtxoSats = unspentList.reduce((s, u) => s + u.satoshis, 0);
                const maxSplittable = Math.floor(totalUtxoSats / this.config.minSplitAmount);

                widthSamples.push({ iter: iteration, depth: newDepth, utxoPoolSize: unspent });

                console.log(`  [${elapsed}s] 已构建: ${iteration} | 当前深度: ${newDepth} | 最大深度: ${this.graph.stats.maxDepth} | 可用UTXO: ${unspent} | UTXO总satoshis: ${totalUtxoSats} | 理论可分裂: ${maxSplittable}`);
            }
        }

        // 宽度诊断报告
        this._printWidthDiagnostics(depthTxCount, widthSamples, iteration);

        // 完成写入
        this.writer.close();

        console.log(`\n[✓] 构建完成！总交易数: ${iteration}`);

        // 保存结果
        this.saveResults();

        return this.graph;
    }

    async buildTransaction(inputs, depth) {
        const tx = new Transaction();

        // 添加输入
        let totalInput = 0;
        const parentTxId = inputs[0].txId;  // 主父交易（用于记录）

        for (const input of inputs) {
            // 获取完整的UTXO信息
            const utxoKey = `${input.txId}:${input.outputIndex}`;
            const fullUtxo = this.graph.utxos.get(utxoKey);

            tx.from({
                txId: input.txId,
                outputIndex: input.outputIndex,
                script: this.addressPool.getScriptForAddress(fullUtxo.ownerAddress),
                satoshis: fullUtxo.satoshis
            });
            totalInput += fullUtxo.satoshis;
        }

        // 计算输出
        const fee = this.config.feePerTx * inputs.length;
        const remaining = totalInput - fee;

        if (remaining < this.config.minSplitAmount) {
            // 单个输出
            const toAddress = this.rng.pick(this.addressPool.addresses);
            const output = new Output({
                script: this.addressPool.getScriptForAddress(toAddress),
                satoshis: remaining
            });
            tx.addOutput(output);

            return this.signAndRecord(tx, inputs, [{ address: toAddress }], remaining, fee, depth, parentTxId);
        }

        // 随机输出数量: 1~addressPoolSize
        const maxOutputs = Math.min(
            this.config.addressPoolSize,
            Math.floor(remaining / this.config.minSplitAmount)
        );
        const outputCount = maxOutputs >= 1 ? this.rng.nextInt(1, maxOutputs) : 1;
        const amountPerOutput = Math.floor(remaining / outputCount);

        const outputs = [];
        for (let i = 0; i < outputCount; i++) {
            const toAddress = this.rng.pick(this.addressPool.addresses);
            outputs.push({ address: toAddress });

            const output = new Output({
                script: this.addressPool.getScriptForAddress(toAddress),
                satoshis: amountPerOutput
            });
            tx.addOutput(output);
        }

        return this.signAndRecord(tx, inputs, outputs, remaining, fee, depth, parentTxId);
    }

    async signAndRecord(tx, inputs, outputs, totalOutput, fee, depth, parentTxId) {
        // 签名：每个唯一地址只调用一次 tx.sign()，避免重复 ECDSA 运算
        const signedAddresses = new Set();
        for (const input of inputs) {
            const utxoKey = `${input.txId}:${input.outputIndex}`;
            const fullUtxo = this.graph.utxos.get(utxoKey);
            if (signedAddresses.has(fullUtxo.ownerAddress)) continue;
            const privateKey = this.addressPool.getPrivateKeyForAddress(fullUtxo.ownerAddress);
            if (!privateKey) {
                throw new Error(`找不到私钥: ${fullUtxo.ownerAddress}`);
            }
            tx.sign(privateKey);
            signedAddresses.add(fullUtxo.ownerAddress);
        }

        const txId = tx.id;
        const serialized = tx.serialize();

        // 标记输入为已花费
        for (const input of inputs) {
            this.graph.spendUtxo(input.txId, input.outputIndex);
        }

        // 添加交易节点
        this.graph.addTransaction(txId, inputs, outputs, depth, fee);

        // 添加输出UTXO
        for (let i = 0; i < outputs.length; i++) {
            this.graph.addUtxo(
                txId,
                i,
                Math.floor(totalOutput / outputs.length),
                outputs[i].address,
                depth,
                parentTxId
            );
        }

        return { txId, serialized };
    }

    _printWidthDiagnostics(depthTxCount, widthSamples, totalTx) {
        if (depthTxCount.size === 0) return;

        const depths = Array.from(depthTxCount.keys()).sort((a, b) => a - b);
        const txCounts = depths.map(d => depthTxCount.get(d));
        const maxWidth = Math.max(...txCounts);
        const avgWidth = (txCounts.reduce((s, v) => s + v, 0) / txCounts.length).toFixed(2);
        const maxDepth = Math.max(...depths);
        const ratio = (totalTx / maxDepth).toFixed(2);

        console.log('\n' + '='.repeat(60));
        console.log('网状结构宽度诊断');
        console.log('='.repeat(60));
        console.log(`总交易数:     ${totalTx}`);
        console.log(`最大深度:     ${maxDepth}`);
        console.log(`txs/depth比:  ${ratio}  (目标应接近 addressPoolSize=${this.config.addressPoolSize})`);
        console.log(`每层平均宽度: ${avgWidth}`);
        console.log(`每层最大宽度: ${maxWidth}`);
        console.log(`minSplitAmount: ${this.config.minSplitAmount}`);

        // 宽度分布直方图（按每层tx数分桶）
        const buckets = { '1': 0, '2-5': 0, '6-20': 0, '21-100': 0, '>100': 0 };
        for (const c of txCounts) {
            if (c === 1) buckets['1']++;
            else if (c <= 5) buckets['2-5']++;
            else if (c <= 20) buckets['6-20']++;
            else if (c <= 100) buckets['21-100']++;
            else buckets['>100']++;
        }
        console.log('\n每层宽度分布:');
        for (const [range, count] of Object.entries(buckets)) {
            const pct = (count / depths.length * 100).toFixed(1);
            const bar = '█'.repeat(Math.round(count / depths.length * 30));
            console.log(`  ${range.padEnd(7)} ${bar.padEnd(30)} ${count} 层 (${pct}%)`);
        }

        // 关键诊断：如果比值接近1，给出原因分析
        if (parseFloat(ratio) < 5) {
            console.log('\n[诊断] ⚠ txs/depth 比值过低，网状结构退化为接近线性链');
            console.log(`[诊断] 可能原因：`);
            const lastSample = widthSamples[widthSamples.length - 1];
            if (lastSample) {
                const estMaxUtxos = Math.floor(
                    this.graph.getUnspentUtxos().reduce((s, u) => s + u.satoshis, 0) / this.config.minSplitAmount
                );
                console.log(`  - UTXO 池实际最大宽度受限于: totalSatoshis / minSplitAmount`);
                console.log(`  - 末尾可用UTXO数: ${lastSample.utxoPoolSize}`);
                console.log(`  - 末尾理论可分裂数: ${estMaxUtxos}`);
                if (lastSample.utxoPoolSize < 10) {
                    console.log(`  → UTXO 池过窄，建议降低 minSplitAmount 或增大初始资金`);
                }
            }
        } else {
            console.log('\n[诊断] ✓ 网状结构宽度正常');
        }
        console.log('='.repeat(60) + '\n');
    }

    saveResults() {
        console.log('\n' + '='.repeat(80));
        console.log('保存结果');
        console.log('='.repeat(80));

        const summary = this.graph.getSummary();

        // 1. 保存统计信息
        const summaryPath = path.join(this.config.outputDir, 'summary.txt');
        let summaryContent = '构建统计\n';
        summaryContent += '='.repeat(80) + '\n';
        summaryContent += `总交易数:        ${summary.totalTransactions}\n`;
        summaryContent += `最大祖先高度:    ${summary.maxDepthReached}\n`;
        summaryContent += `多输入交易:      ${summary.mergeTransactions}\n`;
        summaryContent += `多输出交易:      ${summary.splitTransactions}\n`;
        summaryContent += `未花费UTXO:      ${summary.unspentUtxos}\n`;
        summaryContent += `随机种子:        ${this.rng.initialSeed}\n`;
        summaryContent += '='.repeat(80) + '\n';

        fs.writeFileSync(summaryPath, summaryContent);
        console.log(`[保存] 统计: ${summaryPath}`);

        // 2. 保存树形结构（借鉴 DebugPrintMempoolTreeNL）
        const treePath = path.join(this.config.outputDir, 'tree.txt');
        const treeContent = this.graph.printTree(20);  // 最多打印20层深度
        fs.writeFileSync(treePath, treeContent);
        console.log(`[保存] 树形结构: ${treePath}`);

        // 3. 保存完整的节点层信息（用于分层广播）
        const jsonPath = path.join(this.config.outputDir, 'graph.json');

        // 所有节点信息（txId -> depth + parentIds），用于分层广播与 DAG 重建
        const allNodes = Array.from(this.graph.nodes.entries()).map(([id, node]) => ({
            txId: id,
            depth: node.depth,
            parentIds: Array.from(node.parentIds).filter(pid => pid !== null)
        }));

        const jsonData = {
            config: {
                targetMaxDepth: this.config.targetMaxDepth,
                addressPoolSize: this.config.addressPoolSize,
                randomSeed: this.rng.initialSeed,
            },
            summary,
            addresses: this.addressPool.addresses,
            // 完整的节点层信息，用于分层广播
            nodes: allNodes,
        };

        fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
        console.log(`[保存] JSON数据: ${jsonPath} (包含 ${allNodes.length} 个节点)`);

        // 打印统计
        console.log('\n' + '='.repeat(80));
        console.log('构建统计');
        console.log('='.repeat(80));
        console.log(`总交易数:     ${summary.totalTransactions}`);
        console.log(`最大深度:     ${summary.maxDepthReached}`);
        console.log(`合并交易:     ${summary.mergeTransactions} (${((summary.mergeTransactions / summary.totalTransactions) * 100).toFixed(1)}%)`);
        console.log(`分割交易:     ${summary.splitTransactions} (${((summary.splitTransactions / summary.totalTransactions) * 100).toFixed(1)}%)`);
        console.log(`未花费UTXO:   ${summary.unspentUtxos}`);
        console.log('='.repeat(80));
    }
}

// ==================== 主函数 ====================

async function main() {
    try {
        const builder = new MeshChainBuilder(CONFIG);
        await builder.buildMesh();

        console.log('\n[完成] 构建成功！');
        console.log(`输出目录: ${path.resolve(CONFIG.outputDir)}`);

    } catch (error) {
        console.error('\n[错误]', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('未捕获的错误:', err);
    process.exit(1);
});
