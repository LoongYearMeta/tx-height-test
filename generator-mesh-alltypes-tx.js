(function checkDependencies() {
    const required = ['tbc-lib-js', 'tbc-contract', 'minimist'];
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
// 运行时补丁：确保所有SDK构建的小额交易最低80聪手续费
// 镜像ft.js中对txSize<1000的fee(80)保护，nft.js缺少此保护导致insufficient priority
;(function() {
    const _orig = Transaction.prototype.getFee;
    Transaction.prototype.getFee = function() {
        return Math.max(_orig.call(this), 80);
    };
})();
const PrivateKey = require('tbc-lib-js/lib/privatekey');
const Address = require('tbc-lib-js/lib/address');
const Output = require('tbc-lib-js/lib/transaction/output');
const Script = require('tbc-lib-js/lib/script');
const tbc = require('tbc-lib-js');
const { FT, NFT, piggyBank, HTLC, MultiSig, buildFtPrePreTxData, buildUTXO, API: TBCAPI, poolNFT2: PoolNFT2 } = require('tbc-contract');
// 直接拿 SDK 的 getPrePreTxdata，绕过其 selectTXfromLocal(O(N) 数组扫描)
// 参考 durian-swap/src/service/node-rpc.ts:7 用法
const { getPrePreTxdata } = require('tbc-contract/lib/util/ftunlock');

// 基于 Map 的 fetchFtPrePreTxData —— 替代 SDK 内置版本（其 selectTXfromLocal 是 Array.find O(N)）
// 池子在 mesh 累积到几百次 swap 后，每次 swap 触发 ~30 次 O(N) 扫描，单笔耗时随 N 线性增长。
// 用 Map.get O(1) 后该开销消失。逻辑与 SDK util.js:buildFtPrePreTxData 完全等价。
function buildFtPrePreTxDataFromMap(preTX, preTxVout, txMap) {
	const tapeBuf = preTX.outputs[preTxVout + 1].script.toBuffer().subarray(3, 51);
	const preTXtape = Buffer.from(tapeBuf).toString('hex');
	let prepretxdata = '';
	for (let i = preTXtape.length - 16; i >= 0; i -= 16) {
		const chunk = preTXtape.substring(i, i + 16);
		if (chunk === '0000000000000000') continue;
		const inputIndex = i / 16;
		const prevTxId = preTX.inputs[inputIndex].prevTxId.toString('hex');
		const prepreTX = txMap.get(prevTxId);
		if (!prepreTX) throw new Error(`buildFtPrePreTxDataFromMap: tx 未找到 ${prevTxId}`);
		prepretxdata += getPrePreTxdata(prepreTX, preTX.inputs[inputIndex].outputIndex);
	}
	return '57' + prepretxdata;
}
const fs = require('fs');
const path = require('path');
const minimist = require('minimist');

// 解析交易输出，识别可消费的 P2PKH change UTXO
// 返回 [{ vout, satoshis, address|null, type, consumable }]
function parseTxOutputs(parsedTx, network = 'mainnet') {
	const outputs = [];
	for (let i = 0; i < parsedTx.outputs.length; i++) {
		const out = parsedTx.outputs[i];
		const script = out.script;
		let address = null;
		let type = 'unknown';
		let consumable = false;

		if (script.isPublicKeyHashOut()) {
			const pubkeyHash = script.chunks[2].buf;
			address = Address.fromPublicKeyHash(pubkeyHash, network).toString();
			type = 'p2pkh';
			consumable = out.satoshis > 0;
		} else {
			const asm = script.toASM();
			if (asm.startsWith('0 OP_RETURN') || asm.startsWith('OP_FALSE OP_RETURN')) {
				type = 'tape';
			} else if (asm.includes('OP_DUP OP_HASH160') && asm.includes('OP_RETURN')) {
				type = 'p2pkh_with_flag'; // 非标准但功能等同 P2PKH
			} else {
				type = 'contract';
			}
		}

		outputs.push({ vout: i, satoshis: out.satoshis, address, type, consumable });
	}
	return outputs;
}

// ==================== CLI 参数解析 ====================

const argv = minimist(process.argv.slice(2), {
	string: ['config', 'txid', 'outputdir', 'privkey', 'contracts'],
	number: ['vout', 'satoshis', 'depth', 'seed', 'showcasedepth'],
	boolean: ['showcase'],
	default: {},
});

// ==================== 配置区域 ====================

const BASE_CONFIG = {
	maxTransactions: 100000,
	addressPoolSize: 1000,
	// 单笔 P2PKH 合并交易的最大 input 数。原本与 addressPoolSize 共用 → 平均 ~100 input/tx，
	// 每个 input 一次 ECDSA 签名（bn.js 大数运算热点），单笔 ~90ms，占总耗时 79%。
	// 从 20 进一步降到 10：单笔 P2PKH 从 ~20ms → ~10ms。仍保留 mesh 合并语义，只是 fan-in 更窄。
	maxP2pkhInputs: 10,
	feePerTx: 1000,
	minSplitAmount: 1000000,
	batchSize: 1000,
	randomSeed: null,

	// 交易类型权重（决定每笔交易随机选择的概率）
	// 原 p2pkh=0.35 时 P2PKH 占总 tx 数 ~79%、总耗时 91%。
	// p2pkh 现在是单笔最贵的（10ms），pool_nft swap 反而最便宜（9ms），所以减 p2pkh、加 pool_nft/other：
	typeWeights: {
		p2pkh: 0.15,
		tbc20: 0.25,
		tbc20_contract: 0.20,
		pool_nft: 0.20,
		other: 0.20,
	},

	// 预部署合约地址配置（由 init-contracts.js 生成后注入）
	contracts: {
		ft: null, // FT 合约 txId
		nftCollection: null, // NFT 合集 txId
		poolNft: null, // POOLNFT 合约 txId
		stableCoin: null, // 稳定币合约 txId
		htlc: null, // HTLC 模板地址
		multiSig: null, // 多签钱包地址
	},

	// other 类型的子类型权重
	otherSubTypes: {
		piggybank_freeze: 0.5,
		htlc_deploy: 0.3,
		multisig_create: 0.2,
	},
};

let CONFIG;

if (argv.config) {
	const configPath = argv.config;
	if (fs.existsSync(configPath)) {
		const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
		CONFIG = { ...BASE_CONFIG, ...fileConfig };
		console.log(`[配置] 从文件加载: ${configPath}`);
	} else {
		throw new Error(`配置文件不存在: ${configPath}`);
	}
} else if (argv.txid && argv.vout !== undefined && argv.satoshis !== undefined) {
	CONFIG = {
		...BASE_CONFIG,
		initialUtxos: [
			{
				txId: argv.txid,
				outputIndex: argv.vout,
				satoshis: argv.satoshis,
				privateKeyWif: argv.privkey || 'L1u2TmR7hMMMSV9Bx2Lyt3sujbboqEFqnKygnPRnQERhKB4qptuK',
			},
		],
		targetMaxDepth: argv.depth || 2000,
		outputDir: argv.outputdir || './mesh-chain-output/alltypes-default',
		randomSeed: argv.seed || null,
	};
	// 加载合约配置（如果提供）
	if (argv.contracts) {
		const contractsData = JSON.parse(fs.readFileSync(argv.contracts, 'utf-8'));
		CONFIG.contracts = { ...CONFIG.contracts, ...contractsData };
	}
	console.log(
		`[配置] 从命令行参数构建: txid=${argv.txid}, vout=${argv.vout}, depth=${CONFIG.targetMaxDepth}`
	);
} else {
	CONFIG = {
		...BASE_CONFIG,
		initialUtxos: [
			{
				txId: 'f069929384673f540f2fb425369ab0f18e4e5a2249b7cf830167c3c5e54598f1',
				outputIndex: 1,
				satoshis: 414957762,
				privateKeyWif: 'L1u2TmR7hMMMSV9Bx2Lyt3sujbboqEFqnKygnPRnQERhKB4qptuK',
			},
		],
		targetMaxDepth: 2000,
		outputDir: './mesh-chain-output/alltypes-default',
		randomSeed: null,
	};
}

// 即使走默认/--config 路径，也允许 --depth / --outputdir / --seed / --showcasedepth 覆盖
if (argv.depth !== undefined) CONFIG.targetMaxDepth = argv.depth;
if (argv.outputdir) CONFIG.outputDir = argv.outputdir;
if (argv.seed !== undefined) CONFIG.randomSeed = argv.seed;
if (argv.showcasedepth !== undefined) CONFIG.showcaseDepth = argv.showcasedepth;

// ==================== 交易类型定义 ====================

const SCRIPT_SIG_TYPES = ['p2pkh', 'tbc20', 'tbc20_contract', 'other'];

const TYPE_METADATA = {
	p2pkh: {
		label: 'P2PKH',
		description: '标准 P2PKH 转账',
		needsContract: false,
	},
	tbc20: {
		label: 'TBC20',
		description: 'FT 代币转账',
		needsContract: true,
		contractKey: 'ft',
	},
	tbc20_contract: {
		label: 'TBC20_CONTRACT',
		description: '合约调用（FT MINT / NFT CREATE / POOLNFT SWAP 等）',
		needsContract: true,
		contractKey: null, // 动态选择
	},
	other: {
		label: 'OTHER',
		description: '自定义脚本（HTLC / PiggyBank / MultiSig）',
		needsContract: false,
	},
};

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

	// 按权重随机选择
	pickWeighted(weights) {
		const entries = Object.entries(weights);
		const total = entries.reduce((s, [, w]) => s + w, 0);
		let r = this.next() * total;
		for (const [key, weight] of entries) {
			r -= weight;
			if (r <= 0) return key;
		}
		return entries[entries.length - 1][0];
	}
}

// ==================== 全局交易图 ====================

class TransactionGraph {
	constructor() {
		this.nodes = new Map();
		this.utxos = new Map();
		this.spent = new Set();
		// 未花费 P2PKH UTXO 的增量索引。addUtxo/spendUtxo 时同步维护。
		// 原 getUnspentUtxos 每次 O(N) 扫描所有 UTXO（包括所有已花费、所有 FT/NFT 等），
		// 在 N>3000 时占总耗时 5% 且呈 O(N²) 增长。改后 O(unspent_count)。
		this.unspentP2pkh = new Map();

		// 统计信息
		this.stats = {
			totalTx: 0,
			maxDepth: 0,
			mergeCount: 0,
			splitCount: 0,
			// 按类型统计
			byType: {
				p2pkh: 0,
				tbc20: 0,
				tbc20_contract: 0,
				other: 0,
			},
			// 按层统计
			byLayer: new Map(), // depth -> { total, p2pkh, tbc20, tbc20_contract, other }
			// 输入输出统计
			inputCounts: new Map(), // inputCount -> count
			outputCounts: new Map(), // outputCount -> count
		};
	}

	addInitialUtxos(utxos) {
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
				utxoType: 'p2pkh',
			};
			this.utxos.set(key, rec);
			// 初始 UTXO 默认是 P2PKH 且未花费 → 入索引
			this.unspentP2pkh.set(key, rec);
		}
	}

	addTransaction(txId, inputs, outputs, depth, fee, txType) {
		const parentIds = new Set();
		for (const inp of inputs) {
			parentIds.add(inp.txId);
		}

		this.nodes.set(txId, {
			txId,
			inputs: inputs.map((i) => ({
				txId: i.txId,
				outputIndex: i.outputIndex,
				address: i.ownerAddress,
			})),
			outputs: outputs.map((o, i) => ({ index: i, address: o.address, type: o.type })),
			depth,
			fee,
			parentIds,
			inputCount: inputs.length,
			outputCount: outputs.length,
			txType, // 交易类型
		});

		// 更新统计
		this.stats.totalTx++;
		this.stats.maxDepth = Math.max(this.stats.maxDepth, depth);
		this.stats.byType[txType] = (this.stats.byType[txType] || 0) + 1;
		if (inputs.length > 1) this.stats.mergeCount++;
		if (outputs.length > 1) this.stats.splitCount++;

		// 按层统计
		if (!this.stats.byLayer.has(depth)) {
			this.stats.byLayer.set(depth, {
				total: 0,
				p2pkh: 0,
				tbc20: 0,
				tbc20_contract: 0,
				other: 0,
			});
		}
		const layerStat = this.stats.byLayer.get(depth);
		layerStat.total++;
		layerStat[txType]++;

		// 输入输出分布
		this.stats.inputCounts.set(
			inputs.length,
			(this.stats.inputCounts.get(inputs.length) || 0) + 1
		);
		this.stats.outputCounts.set(
			outputs.length,
			(this.stats.outputCounts.get(outputs.length) || 0) + 1
		);
	}

	addUtxo(txId, outputIndex, satoshis, ownerAddress, depth, parentTxId, utxoType = 'p2pkh') {
		const key = this.makeUtxoKey(txId, outputIndex);
		const rec = {
			txId,
			outputIndex,
			ownerAddress,
			satoshis,
			depth,
			parentTxId,
			utxoType,
		};
		this.utxos.set(key, rec);
		// 同步更新增量索引：只索引 P2PKH 类型，且 spend 已发生过则不重新入索引
		// （recordResult 中存在"先 spend 后 add"的中间 UTXO 顺序，必须先看 spent 再决定）
		if (utxoType === 'p2pkh' && !this.spent.has(key)) {
			this.unspentP2pkh.set(key, rec);
		}
	}

	spendUtxo(txId, outputIndex) {
		const key = this.makeUtxoKey(txId, outputIndex);
		this.spent.add(key);
		this.unspentP2pkh.delete(key);
	}

	getUnspentUtxos(minAmount = 0) {
		// O(unspent_count) — 已经只在未花费 P2PKH 集合上迭代
		if (minAmount <= 0) return Array.from(this.unspentP2pkh.values());
		const result = [];
		for (const utxo of this.unspentP2pkh.values()) {
			if (utxo.satoshis >= minAmount) result.push(utxo);
		}
		return result;
	}

	calculateDepth(inputUtxos) {
		let maxParentDepth = 0;
		for (const utxo of inputUtxos) {
			maxParentDepth = Math.max(maxParentDepth, utxo.depth);
		}
		return maxParentDepth + 1;
	}

	getUtxosForNewTx(rng, maxInputs, maxDepth, minAmount) {
		const unspent = this.getUnspentUtxos(minAmount);
		const validUtxos = unspent.filter((u) => u.depth < maxDepth);

		if (validUtxos.length === 0) return [];

		const minDepth = Math.min(...validUtxos.map((u) => u.depth));
		const sameLayerUtxos = validUtxos.filter((u) => u.depth === minDepth);

		const inputCount = rng.nextInt(1, Math.min(maxInputs, sameLayerUtxos.length));
		const shuffled = rng.shuffle(sameLayerUtxos);

		return shuffled.slice(0, inputCount);
	}

	findRootTxIds() {
		const roots = new Set();
		for (const [txId, node] of this.nodes) {
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

	findChildren(parentTxId) {
		const children = [];
		for (const [txId, node] of this.nodes) {
			if (node.parentIds.has(parentTxId)) {
				children.push(txId);
			}
		}
		return children;
	}

	getTxLabel(txId, node = null) {
		if (!node) node = this.nodes.get(txId);
		if (!node) return `${txId.substring(0, 16)}... [unknown]`;

		const mergeMark = node.inputCount > 1 ? ` [M:${node.inputCount}]` : '';
		const splitMark = node.outputCount > 1 ? ` [S:${node.outputCount}]` : '';
		const typeMark = ` [${node.txType}]`;

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

		return `${txId.substring(0, 16)}... d=${node.depth}${typeMark}${mergeMark}${splitMark}${parentInfo}`;
	}

	printTree(maxDepth = 10) {
		const lines = [];
		lines.push('\n' + '='.repeat(80));
		lines.push('交易树结构（混合类型）');
		lines.push('='.repeat(80));

		const roots = this.findRootTxIds();

		if (roots.length === 0) {
			lines.push('[No root transactions]');
			return lines.join('\n') + '\n';
		}

		lines.push(
			`根交易数: ${roots.length} | 总交易数: ${this.stats.totalTx} | 最大深度: ${this.stats.maxDepth}\n`
		);

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
				lines.push(
					`${'    '.repeat(depth + 1)}└── ... ${children.length} children (depth limit)`
				);
			}
			return;
		}

		const children = this.findChildren(txId);
		for (const childId of children) {
			this.printTreeRecursive(childId, visited, depth + 1, maxDepth, lines);
		}
	}

	makeUtxoKey(txId, outputIndex) {
		return `${txId}:${outputIndex}`;
	}
}

// ==================== 地址池管理 ====================

class AddressPool {
	constructor(size, network = 'mainnet') {
		this.keys = [];
		this.addresses = [];
		this.indexMap = new Map();
		this.network = network;
		this.externalKeys = new Map();
		this.generateKeys(size);
	}

	importPrivateKey(wif, label = 'external') {
		const privateKey = PrivateKey.fromWIF(wif);
		const address = privateKey.toAddress().toString();
		this.externalKeys.set(address, {
			key: privateKey,
			label: label,
			wif: wif,
		});
		return address;
	}

	generateKeys(count) {
		for (let i = 0; i < count; i++) {
			const privateKey = new PrivateKey(this.network);
			const address = privateKey.toAddress();
			this.keys.push(privateKey);
			this.addresses.push(address.toString());
			this.indexMap.set(address.toString(), i);
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
		const address = Address.fromString(addressStr);
		return Script.buildPublicKeyHashOut(address).toHex();
	}

	saveKeysToFile(outputDir) {
		const outputPath = path.join(outputDir, 'keys.txt');
		let content = '# 生成的私钥/地址对 - 请妥善保管！\n';
		content += '='.repeat(80) + '\n';
		for (let i = 0; i < this.keys.length; i++) {
			content += `[${i}] ${this.addresses[i]} | ${this.keys[i].toWIF()}\n`;
		}
		fs.writeFileSync(outputPath, content);
	}
}

// ==================== 交易构建器（按类型）====================
//
// build() 统一返回:
//   {
//     txType,
//     consumedInputs: [...],          // 实际消耗的 enrichedInputs 子集
//     rawTxs: [{
//       raw, txId, fee,
//       outputs: [{ vout, address, satoshis, type, consumable }],
//       chainedFromIndex?: number     // 仅链式 SDK txs：标识该 tx 消耗前一个 rawTx 的哪个 vout
//     }, ...]
//   }

class TransactionBuilder {
	constructor(addressPool, rng, config, network = 'mainnet') {
		this.addressPool = addressPool;
		this.rng = rng;
		this.config = config;
		this.network = network;
		// 本地 FT 信息缓存，用于 PoolNFT 离线创建时替换 API.fetchFtInfo
		this.localFtInfoCache = new Map();
		// 全局单一 FT 状态：null → ftState（mint 一次后持续 transfer）
		this.ftSingle = null;
		// 全局单一 NFT 状态：null → nftState（create 一次，mint 直到 supply 耗尽，持续 transfer）
		this.nftSingle = null;
		// 全局单一 Pool 状态：null → created → ready
		// null: 还未建池；created: 已建未初始化；ready: 已初始化，可 swap
		this.poolNftSingle = null;
		// 操作细分计数（随机模式结束时打印）
		this._opStats = { ft_mint: 0, ft_transfer: 0, nft_create: 0, nft_mint: 0, nft_transfer: 0, pool_create: 0, pool_init: 0, pool_swap: 0 };
		// 各阶段累计耗时（纳秒 BigInt），用 _time 包装关键调用后会自动累加
		// 子段："p2pkh"|"tbc20.mint"|"tbc20.transfer"|"nft.create"|"nft.mint"|"nft.transfer"
		//       |"pool.create"|"pool.init"|"pool.swap_tbc_ft"|"pool.swap_ft_tbc"|"other"
		this._phaseNs = Object.create(null);
		this._phaseCount = Object.create(null);
	}

	async _time(name, fn) {
		const t0 = process.hrtime.bigint();
		try {
			return await fn();
		} finally {
			const dt = process.hrtime.bigint() - t0;
			this._phaseNs[name]    = (this._phaseNs[name]    ?? 0n) + dt;
			this._phaseCount[name] = (this._phaseCount[name] ?? 0)  + 1;
		}
	}

	pickTxType() {
		return this.rng.pickWeighted(this.config.typeWeights);
	}

	calculateFee(txType, inputCount, outputCount = 2) {
		return this.config.feePerTx;
	}

	// ---------- PoolNFT AMM 状态自管理 ----------
	// SDK swaptoToken_baseTBC / swaptoTBC_baseToken 会在 tx 构建过程中（在 buildTapeAmount 之前）
	// 直接修改 pool.tbc_amount / ft_a_amount。若 build 抛错，这些字段会留在脏状态，
	// 后续 swap 用此发散的 SDK 状态 + 旧 tape，要么再次抛错要么构造出非法 tx。
	// 参考 durian-swap pool-exchange.ts 的 saveAmmSnapshot/restoreAmmSnapshot 模式。
	_snapshotPoolAmm(pool) {
		return {
			tbc_amount:      pool.tbc_amount,
			ft_a_amount:     pool.ft_a_amount,
			ft_lp_amount:    pool.ft_lp_amount,
			tbc_amount_full: pool.tbc_amount_full,
			contractTxid:    pool.contractTxid,
		};
	}

	_restorePoolAmm(pool, snap) {
		pool.tbc_amount      = snap.tbc_amount;
		pool.ft_a_amount     = snap.ft_a_amount;
		pool.ft_lp_amount    = snap.ft_lp_amount;
		pool.tbc_amount_full = snap.tbc_amount_full;
		pool.contractTxid    = snap.contractTxid;
	}

	// 从 PoolNFT tape（outputs[1].script.chunks[3].buf，24 字节）重读 AMM 状态。
	// SDK 内部的 BigInt 除法存在舍入；长期依赖 SDK 自身计数会与 on-chain tape 缓慢发散。
	// 参考 durian-swap pool-exchange.ts:855-876 cachePoolNftFromSwap 的做法：每次 swap/init 成功后
	// 从刚签好的 tape 重新解析三个 LE-uint64，强制对齐 SDK 状态。
	_reloadAmmFromTape(pool, tx) {
		const tapeOut = tx.outputs[1];
		const amountBuf = tapeOut?.script?.chunks?.[3]?.buf;
		if (!amountBuf || amountBuf.length < 24) {
			throw new Error('[POOL] 无法从 tape 解析 AMM 状态：chunks[3].buf 缺失或过短');
		}
		pool.ft_lp_amount = amountBuf.readBigUInt64LE(0);
		pool.ft_a_amount  = amountBuf.readBigUInt64LE(8);
		pool.tbc_amount   = amountBuf.readBigUInt64LE(16);
		pool.tbc_amount_full = BigInt(tx.outputs[0].satoshis);
	}

	// 将 BigInt 原始单位精确格式化为 "整数.小数" 字符串（SDK parseDecimalToBigInt 可逆解析）。
	// 替代 Number(ftBalance) / Math.pow(10, decimal)：当 ftBalance > 2^53 时浮点会丢精度，
	// 回传给 parseDecimalToBigInt 后得到与原值不同的 BigInt，pool.ft_a_amount 与 poolFtUtxo.ftBalance
	// 由此发散，触发 buildTapeAmount 越界。
	_bigintToDecimalString(rawBigInt, decimal) {
		const s = rawBigInt.toString();
		if (decimal === 0) return s;
		if (s.length <= decimal) {
			return '0.' + s.padStart(decimal, '0');
		}
		return s.slice(0, s.length - decimal) + '.' + s.slice(s.length - decimal);
	}

	// 决定 P2PKH 输出数量
	decideOutputCount(remaining) {
		if (remaining < this.config.minSplitAmount) return 1;
		const maxOutputs = Math.min(
			this.config.addressPoolSize,
			Math.floor(remaining / this.config.minSplitAmount)
		);
		return maxOutputs >= 1 ? this.rng.nextInt(1, maxOutputs) : 1;
	}

	// ---------- P2PKH ----------
	// singleOutput=true: 展示模式用，强制只产生1个输出以保持链的清晰
	buildP2PKH(enrichedInputs, singleOutput = false) {
		const tx = new Transaction();
		let totalInput = 0;
		for (const input of enrichedInputs) {
			tx.from({
				txId: input.txId,
				outputIndex: input.outputIndex,
				script: input.script,
				satoshis: input.satoshis,
			});
			totalInput += input.satoshis;
		}

		const fee = this.calculateFee('p2pkh', enrichedInputs.length);
		const remaining = totalInput - fee;
		if (remaining <= 0) return null;

		const outputCount = singleOutput ? 1 : this.decideOutputCount(remaining);
		const outputDescriptors = [];
		if (outputCount === 1 || remaining < this.config.minSplitAmount) {
			const toAddress = this.rng.pick(this.addressPool.addresses);
			outputDescriptors.push({ address: toAddress, satoshis: remaining });
		} else {
			const amountPerOutput = Math.floor(remaining / outputCount);
			for (let i = 0; i < outputCount; i++) {
				const toAddress = this.rng.pick(this.addressPool.addresses);
				outputDescriptors.push({ address: toAddress, satoshis: amountPerOutput });
			}
		}

		for (const o of outputDescriptors) {
			tx.addOutput(new Output({
				script: this.addressPool.getScriptForAddress(o.address),
				satoshis: o.satoshis,
			}));
		}

		// 明确设置手续费，避免库抛出 "Change address is missing"
		tx.fee(fee);

		// 签名
		const signedKeys = new Set();
		for (const input of enrichedInputs) {
			if (signedKeys.has(input.ownerAddress)) continue;
			const pk = this.addressPool.getPrivateKeyForAddress(input.ownerAddress);
			if (!pk) throw new Error(`找不到私钥: ${input.ownerAddress}`);
			tx.sign(pk);
			signedKeys.add(input.ownerAddress);
		}

		const outputs = outputDescriptors.map((o, i) => ({
			vout: i,
			address: o.address,
			satoshis: o.satoshis,
			type: 'p2pkh',
			consumable: true,
		}));

		return {
			txType: 'p2pkh',
			consumedInputs: enrichedInputs,
			rawTxs: [{ raw: tx.uncheckedSerialize(), txId: tx.id, fee, outputs }],
		};
	}

	// ---------- TBC20: FT MINT (1 utxo → 2 chained txs) ----------
	// mintToSelf=true: 展示模式用，mint 给自己，便于后续 FT transfer 续接（无需跨 key 签名）
	buildTBC20(enrichedInputs, mintToSelf = false) {
		// FT.MintFT 只需要单个 utxo；多输入时仅取 inputs[0]，其余不消耗
		if (enrichedInputs.length === 0) return null;
		const input = enrichedInputs[0];
		const privateKey = this.addressPool.getPrivateKeyForAddress(input.ownerAddress);
		if (!privateKey) return null;

		// MintFT 输入需求：vout=0(9900) + vout=1(tape 0) + vout=2(change) + 中间 tx 费
		// 我们要求至少 50000 sat（远高于实际需要），避免 change 为负
		if (input.satoshis < 50000) return null;

		const sdkUtxo = {
			txId: input.txId,
			outputIndex: input.outputIndex,
			script: input.script,
			satoshis: input.satoshis,
		};

		// mintToSelf: mint 给自己，后续 transfer 用同一私钥签名，无需跨 key
		const recipient = mintToSelf ? input.ownerAddress : this.rng.pick(this.addressPool.addresses);
		const ftSeed = this.rng.nextInt(100000, 999999);
		const ft = new FT({
			name: `FT${ftSeed}`,
			symbol: `T${ftSeed}`,
			amount: 10000,
			decimal: 6,
		});

		let rawList;
		try {
			rawList = ft.MintFT(privateKey, recipient, sdkUtxo);
		} catch (e) {
			console.log(`[TBC20] FT.MintFT 失败: ${e.message}, fallback`);
			return null;
		}

		const parsedTxs = rawList.map((raw) => new Transaction(raw));
		const rawTxs = [];
		for (let i = 0; i < rawList.length; i++) {
			const raw = rawList[i];
			const parsed = parsedTxs[i];
			const outs = parseTxOutputs(parsed, this.network);
			// tx2 消耗 tx1 的 vout=0 (9900 sat)
			const inSum = i === 0 ? input.satoshis : 9900;
			let outSum = 0;
			for (const o of outs) outSum += o.satoshis;
			rawTxs.push({
				raw,
				txId: parsed.id,
				fee: Math.max(0, inSum - outSum),
				outputs: outs,
				chainedFromIndex: i === 0 ? undefined : { srcRawIdx: i - 1, srcVout: 0 },
			});
		}

		return {
			txType: 'tbc20',
			consumedInputs: [input],
			rawTxs,
			// 仅 mintToSelf 时携带，供 buildShowcase 初始化 FT transfer 链
			ftMintData: mintToSelf ? {
				ft,
				recipient,
				txSourceParsed: parsedTxs[0],
				txMintParsed: parsedTxs[1],
			} : undefined,
		};
	}

	// ---------- TBC20: FT TRANSFER (续接 MintFT 或上一次 transfer) ----------
	// ftState 会被原地更新（preTX / prePrETX / ftUtxo），供下一次 transfer 使用
	buildFTTransfer(ftState, tbcEnrichedInput) {
		const { ft, ftOwner, ftUtxo, preTX, preTxVout, prePrETX } = ftState;

		const privateKey = this.addressPool.getPrivateKeyForAddress(ftOwner);
		if (!privateKey) return null;

		// 离线计算 prepreTxData（无需网络）
		let prepreTxData;
		try {
			prepreTxData = buildFtPrePreTxData(preTX, preTxVout, [prePrETX]);
		} catch (e) {
			console.log(`[FT_TRANSFER] buildFtPrePreTxData 失败: ${e.message}`);
			return null;
		}

		// TBC 手续费 UTXO（P2PKH）
		const tbcUtxo = {
			txId: tbcEnrichedInput.txId,
			outputIndex: tbcEnrichedInput.outputIndex,
			script: tbcEnrichedInput.script || this.addressPool.getScriptForAddress(tbcEnrichedInput.ownerAddress),
			satoshis: tbcEnrichedInput.satoshis,
		};

		// 将全部 FT balance 转给自己（owner 不变，transfer 链得以续接）
		const totalBalance = ftUtxo.ftBalance; // BigInt raw units
		const ft_amount = Number(totalBalance) / Math.pow(10, ft.decimal);

		let raw;
		try {
			raw = ft.transfer(
				privateKey,
				ftOwner,       // to self
				ft_amount,
				[ftUtxo],
				tbcUtxo,
				[preTX],
				[prepreTxData],
			);
		} catch (e) {
			console.log(`[FT_TRANSFER] ft.transfer 失败: ${e.message}`);
			return null;
		}

		const transferTx = new Transaction(raw);
		const outs = parseTxOutputs(transferTx, this.network);
		let outSum = 0;
		for (const o of outs) outSum += o.satoshis;
		const inSum = 500 + tbcEnrichedInput.satoshis; // FT UTXO(500) + TBC fee UTXO

		// 原地更新 ftState：prePrETX ← preTX ← transferTx，ftUtxo 指向新的 vout[0]
		ftState.prePrETX = preTX;
		ftState.preTX = transferTx;
		ftState.preTxVout = 0; // 转给自己且全额转移时，FT UTXO 始终在 vout[0]
		ftState.ftUtxo = buildUTXO(transferTx, 0, true);

		return {
			txType: 'tbc20',
			consumedInputs: [tbcEnrichedInput], // 仅 P2PKH TBC fee UTXO 在 graph 中被追踪
			rawTxs: [{
				raw,
				txId: transferTx.id,
				fee: Math.max(0, inSum - outSum),
				outputs: outs,
			}],
		};
	}

	// ---------- POOL_NFT: 先 Mint 一个 FT，再用 FT 创建 PoolNFT（4 chained txs）----------
	// 每次调用创建一个全新的池：ftSource + ftMint + poolSource + poolMint
	// API.fetchFtInfo 被临时 monkey-patch 为从 localFtInfoCache 读取，无需网络
	async buildPoolNFTCreate(enrichedInputs) {
		if (enrichedInputs.length === 0) return null;
		const input = enrichedInputs[0];
		const privateKey = this.addressPool.getPrivateKeyForAddress(input.ownerAddress);
		if (!privateKey) return null;
		// 至少需要：FT mint费 + pool 创建费 + 锁定押金（合计约 100000 sat 足够）
		if (input.satoshis < 100000) return null;

		// ---- Step A: Mint 一个专用 FT（mintToSelf，作为 pool 的 ft_a） ----
		const ftSeed = this.rng.nextInt(100000, 999999);
		const ft = new FT({ name: `FT${ftSeed}`, symbol: `T${ftSeed}`, amount: 10000, decimal: 6 });
		const sdkFtUtxo = {
			txId: input.txId,
			outputIndex: input.outputIndex,
			script: input.script,
			satoshis: input.satoshis,
		};

		let ftRawList;
		try {
			ftRawList = ft.MintFT(privateKey, input.ownerAddress, sdkFtUtxo);
		} catch (e) {
			console.log(`[POOL_NFT] FT.MintFT 失败: ${e.message}`);
			return null;
		}

		const txFTSource = new Transaction(ftRawList[0]);
		const txFTMint   = new Transaction(ftRawList[1]);

		// 检查 ftSource.vout[2] 是否有足够余额供 pool 创建
		const ftSourceChange = txFTSource.outputs[2];
		if (!ftSourceChange || ftSourceChange.satoshis < 50000) {
			console.log('[POOL_NFT] ftSource change 不足');
			return null;
		}

		// ---- Step B: 缓存 FT 信息，临时 monkey-patch API.fetchFtInfo ----
		this.localFtInfoCache.set(ft.contractTxid, {
			codeScript:  ft.codeScript,
			tapeScript:  ft.tapeScript,
			totalSupply: ft.totalSupply,
			decimal:     ft.decimal,
			name:        ft.name,
			symbol:      ft.symbol,
		});

		// pool 消耗 ftSource.vout[2]（大额 P2PKH change）作为创建费用
		const poolSdkUtxo = {
			txId:        txFTSource.hash,
			outputIndex: 2,
			script:      ftSourceChange.script.toHex(),
			satoshis:    ftSourceChange.satoshis,
		};

		// V2: 默认构造 + initCreate(ftContractTxid)。初始流动性参数在 initPoolNFT 才传。
		const pool = new PoolNFT2();
		pool.initCreate(ft.contractTxid);
		// V2 内部状态字段：未走 initfromContractId 时不会自动赋值，显式置默认
		pool.lp_plan = 1;
		pool.with_lock = false;
		pool.with_lock_time = false;

		const savedFetchFtInfo  = TBCAPI.fetchFtInfo;
		const savedFetchCoinInfo = TBCAPI.fetchCoinInfo;
		TBCAPI.fetchFtInfo = async (contractTxid) => {
			const cached = this.localFtInfoCache.get(contractTxid);
			if (cached) return cached;
			throw new Error(`POOL_NFT 离线模式：FtInfo 未缓存 contractTxid=${contractTxid}`);
		};
		// V2 在 fetchFtInfo 失败时会 fallback 到 fetchCoinInfo —— 离线场景下我们没有 coin，直接抛错让 fetchFtInfo 的结果生效
		TBCAPI.fetchCoinInfo = async () => { throw new Error('POOL_NFT 离线模式：fetchCoinInfo 不可用'); };

		// V2 createPoolNFT 需要 `tag`；用 ftSeed 保证每个池标签唯一
		const poolTag = `pool-${ftSeed}`;
		let poolRawList;
		try {
			poolRawList = await pool.createPoolNFT(privateKey, poolSdkUtxo, poolTag, undefined, 1, false);
		} catch (e) {
			console.log(`[POOL_NFT] createPoolNFT 失败: ${e.message}`);
			return null;
		} finally {
			TBCAPI.fetchFtInfo  = savedFetchFtInfo;
			TBCAPI.fetchCoinInfo = savedFetchCoinInfo;
		}

		const txPoolSource = new Transaction(poolRawList[0]);
		const txPoolMint   = new Transaction(poolRawList[1]);

		// V2 后续 Init/Swap 的 updatePoolNftTape() 会 fetchTXraw(this.contractTxid).outputs[1].script
		// 取最新 pool tape，因此必须把 contractTxid 指向 txPoolMint（即当前持有 PoolNFT UTXO 的 tx）
		pool.contractTxid = txPoolMint.hash;

		// ---- 构建 rawTxs（4 笔） ----
		const allRaws = [
			{ raw: ftRawList[0],  parsed: txFTSource,   inSum: input.satoshis },
			{ raw: ftRawList[1],  parsed: txFTMint,     inSum: 9900 },
			{ raw: poolRawList[0], parsed: txPoolSource, inSum: ftSourceChange.satoshis },
			{ raw: poolRawList[1], parsed: txPoolMint,   inSum: 9800 },
		];

		const rawTxs = allRaws.map(({ raw, parsed, inSum }, i) => {
			const outs = parseTxOutputs(parsed, this.network);
			const outSum = outs.reduce((s, o) => s + o.satoshis, 0);
			// 链式引用：说明每笔 tx 的逻辑父节点（供 recordResult 构建 graph）
			let chainedFromIndex;
			if (i === 1) chainedFromIndex = { srcRawIdx: 0, srcVout: 0 }; // ftMint ← ftSource.vout[0]
			if (i === 2) chainedFromIndex = { srcRawIdx: 0, srcVout: 2 }; // poolSource ← ftSource.vout[2]
			if (i === 3) chainedFromIndex = { srcRawIdx: 2, srcVout: 0 }; // poolMint ← poolSource.vout[0]
			return {
				raw,
				txId: parsed.id,
				fee: Math.max(0, inSum - outSum),
				outputs: outs,
				chainedFromIndex,
			};
		});

		// poolSource 的 P2PKH change（vout[1]）是本次调用链的正确续接 UTXO
		// （ftSource.vout[2] 已被 poolSource 消耗，不能再作为续接 UTXO）
		const poolSourceOuts = parseTxOutputs(txPoolSource, this.network);
		const poolNextOut = poolSourceOuts.find((o) => o.consumable && o.satoshis >= 10000);

		const poolnft_codehash160 = tbc.crypto.Hash.sha256ripemd160(
			tbc.crypto.Hash.sha256(Buffer.from(pool.poolnft_code, 'hex'))
		).toString('hex');

		return {
			txType: 'pool_nft',
			consumedInputs: [input],
			rawTxs,
			consumedIntermediateUtxos: [{ txId: txFTSource.hash, outputIndex: 2 }],
			_nextUtxo: poolNextOut
				? { txId: txPoolSource.id, outputIndex: poolNextOut.vout, satoshis: poolNextOut.satoshis, ownerAddress: poolNextOut.address }
				: null,
			// 供后续 init/swap 层使用的池创建数据
			poolData: {
				pool,
				ft,
				txFTSource,
				txFTMint,
				txPoolSource,
				txPoolMint,
				ownerAddress: input.ownerAddress,
				poolnft_codehash160,
			},
		};
	}

	// ---------- POOL_NFT: Layer 2 — 向池注入初始 FT + TBC 流动性 ----------
	// enrichedInput = buildPoolNFTCreate._nextUtxo（txPoolSource 的 P2PKH change）
	// 完成后 poolState 供后续 swap 层使用
	async buildPoolNFTInit(poolData, enrichedInput) {
		const { pool, ft, txFTSource, txFTMint, txPoolSource, txPoolMint, ownerAddress, poolnft_codehash160 } = poolData;
		const privateKey = this.addressPool.getPrivateKeyForAddress(ownerAddress);
		if (!privateKey) return null;
		if (enrichedInput.satoshis < 15000) return null;

		const sdkUtxo = {
			txId: enrichedInput.txId,
			outputIndex: enrichedInput.outputIndex,
			script: enrichedInput.script,
			satoshis: enrichedInput.satoshis,
		};

		// Pool NFT UTXO（来自 createPoolNFT 最后一笔 tx 的 output[0]）
		const poolNftUtxo = {
			txId: txPoolMint.hash,
			outputIndex: 0,
			script: txPoolMint.outputs[0].script.toHex(),
			satoshis: txPoolMint.outputs[0].satoshis,
		};

		// 用户 FT UTXO（来自 txFTMint.outputs[0] = FT code）
		const userFtUtxo = buildUTXO(txFTMint, 0, true);

		// 离线 tx 查找表：Map<txHash, tx>，O(1) 查找。原本 Array.find O(N)，
		// 在 N=500+ 次 swap 后单次 swap 耗时随 N 线性增长（每 swap 内部 ~30 次 fetchTXraw / selectTXfromLocal 扫描）
		const offlineTxMap = new Map([
			[txFTSource.hash, txFTSource],
			[txFTMint.hash,   txFTMint],
			[txPoolSource.hash, txPoolSource],
			[txPoolMint.hash,   txPoolMint],
		]);

		const savedFetchFtInfo        = TBCAPI.fetchFtInfo;
		const savedFetchCoinInfo      = TBCAPI.fetchCoinInfo;
		const savedFetchFtUTXO        = TBCAPI.fetchFtUTXO;
		const savedFetchTXraw         = TBCAPI.fetchTXraw;
		const savedFetchFtPrePreTxData = TBCAPI.fetchFtPrePreTxData;
		const savedFetchPoolNftUTXO   = pool.fetchPoolNftUTXO.bind(pool);

		TBCAPI.fetchFtInfo = async (contractTxid) => {
			const cached = this.localFtInfoCache.get(contractTxid);
			if (cached) return cached;
			throw new Error(`[POOL_INIT] 离线 FtInfo 缺失: ${contractTxid}`);
		};
		TBCAPI.fetchCoinInfo = async () => { throw new Error('[POOL_INIT] 离线模式：fetchCoinInfo 不可用'); };
		TBCAPI.fetchFtUTXO = async () => userFtUtxo;
		TBCAPI.fetchTXraw = async (txId) => {
			const tx = offlineTxMap.get(txId);
			if (!tx) throw new Error(`[POOL_INIT] 离线 tx 未找到: ${txId}`);
			return tx;
		};
		TBCAPI.fetchFtPrePreTxData = async (preTX, preTxVout) =>
			buildFtPrePreTxDataFromMap(preTX, preTxVout, offlineTxMap);
		pool.fetchPoolNftUTXO = async () => poolNftUtxo;

		// 用 mint 的全部 FT 作为初始流动性（避免 FT 找零输出 → 简化输出布局）
		const ftInfo = this.localFtInfoCache.get(pool.ft_a_contractTxid);
		const ftDecimal = ftInfo ? ftInfo.decimal : 6;
		// 用 BigInt → 字符串精确格式化，避免 Number(ftBalance)/Math.pow(10,decimal) 在 ftBalance > 2^53
		// 时丢精度，导致 SDK parseDecimalToBigInt 回传的 pool.ft_a_amount ≠ poolFtUtxo.ftBalance（tape 实写值）
		const ftInitAmount = this._bigintToDecimalString(BigInt(userFtUtxo.ftBalance), ftDecimal);

		// initPoolNFT 也会原地写 pool.tbc_amount / ft_a_amount / ft_lp_amount，失败时同样需要回滚
		const ammSnap = this._snapshotPoolAmm(pool);

		let initRaw;
		try {
			// V2: initPoolNFT(privateKey, address_to, utxo, tbc_amount, ft_a, lock_time?)
			initRaw = await pool.initPoolNFT(privateKey, ownerAddress, sdkUtxo, 0.01, ftInitAmount);
		} catch (e) {
			this._restorePoolAmm(pool, ammSnap);
			console.log(`[POOL_INIT] initPoolNFT 失败: ${e.message}`);
			return null;
		} finally {
			TBCAPI.fetchFtInfo         = savedFetchFtInfo;
			TBCAPI.fetchCoinInfo       = savedFetchCoinInfo;
			TBCAPI.fetchFtUTXO         = savedFetchFtUTXO;
			TBCAPI.fetchTXraw          = savedFetchTXraw;
			TBCAPI.fetchFtPrePreTxData = savedFetchFtPrePreTxData;
			pool.fetchPoolNftUTXO      = savedFetchPoolNftUTXO;
		}

		const initTx = new Transaction(initRaw);
		offlineTxMap.set(initTx.hash, initTx);

		// V2 后续 swap 仍以 contractTxid 取最新 tape → 指向 initTx
		pool.contractTxid = initTx.hash;
		// 从刚签好的 init tape 重读权威 AMM 状态（防 SDK 字段类型/精度漂移）
		this._reloadAmmFromTape(pool, initTx);

		// V2 initPoolNFT 输出: [0]poolNFT(=dust+tbc_amount) [1]tape [2]poolFT(=fttxo_a.satoshis) [3]tape [4]FTLP(500) [5]tape [P2PKH_change]
		// 全量 FT 注入 → 无 FT 找零输出 → 与 V1 输出顺序兼容
		const newPoolNftUtxo = {
			txId: initTx.hash, outputIndex: 0,
			script: initTx.outputs[0].script.toHex(),
			satoshis: initTx.outputs[0].satoshis,
		};
		const newPoolFtUtxo = buildUTXO(initTx, 2, true); // FT code[2] + tape[3]

		const outs = parseTxOutputs(initTx, this.network);
		const outSum = outs.reduce((s, o) => s + o.satoshis, 0);
		const nextP2PKH = outs.find(o => o.consumable && o.satoshis >= 1000);

		const poolState = {
			pool,
			ft,
			poolnft_codehash160,
			poolNftUtxo: newPoolNftUtxo,
			// 池子的 FT UTXOs 是一组（不是单个）：FT→TBC swap 会**新增**一个池子 FT UTXO
			// 而不消耗旧的；TBC→FT swap 会消耗全部并新建一个找零 UTXO。
			// 用数组追踪并 mock fetchFtUTXOsforPool 返回全部，避免 SDK 用单 UTXO 算 decrement 越界。
			poolFtUtxos: [newPoolFtUtxo],
			userFtUtxo: null,          // 用户还未从 swap 中获得 FT
			offlineTxMap,
			ownerAddress,
		};

		return {
			txType: 'pool_nft',
			consumedInputs: [enrichedInput],
			rawTxs: [{ raw: initRaw, txId: initTx.id, fee: Math.max(0, enrichedInput.satoshis - outSum), outputs: outs }],
			poolState,
			_nextUtxo: nextP2PKH
				? { txId: initTx.id, outputIndex: nextP2PKH.vout, satoshis: nextP2PKH.satoshis, ownerAddress }
				: null,
		};
	}

	// ---------- POOL_NFT: Layer 3+ — TBC→FT swap（用户付 TBC，获得 FT）----------
	async buildPoolSwapTBCtoFT(poolState, enrichedInput) {
		const { pool, poolNftUtxo, poolFtUtxos, poolnft_codehash160, ownerAddress, offlineTxMap } = poolState;
		const privateKey = this.addressPool.getPrivateKeyForAddress(ownerAddress);
		if (!privateKey) return null;
		if (enrichedInput.satoshis < 2000) return null;
		if (!poolFtUtxos || poolFtUtxos.length === 0) return null;

		const sdkUtxo = {
			txId: enrichedInput.txId,
			outputIndex: enrichedInput.outputIndex,
			script: enrichedInput.script,
			satoshis: enrichedInput.satoshis,
		};

		const savedFetchFtInfo         = TBCAPI.fetchFtInfo;
		const savedFetchCoinInfo       = TBCAPI.fetchCoinInfo;
		const savedFetchFtUTXO         = TBCAPI.fetchFtUTXO;
		const savedFetchFtUTXOsforPool = TBCAPI.fetchFtUTXOsforPool;
		const savedFetchCoinUTXOs      = TBCAPI.fetchCoinUTXOs;
		const savedFetchTXraw          = TBCAPI.fetchTXraw;
		const savedFetchFtPrePreTxData = TBCAPI.fetchFtPrePreTxData;
		const savedFetchPoolNftUTXO    = pool.fetchPoolNftUTXO.bind(pool);

		TBCAPI.fetchFtInfo = async (contractTxid) => {
			const cached = this.localFtInfoCache.get(contractTxid);
			if (cached) return cached;
			throw new Error(`[POOL_SWAP_TBC_FT] 离线 FtInfo 缺失: ${contractTxid}`);
		};
		TBCAPI.fetchCoinInfo = async () => { throw new Error('[POOL_SWAP_TBC_FT] 离线模式：fetchCoinInfo 不可用'); };
		TBCAPI.fetchFtUTXO   = async () => poolFtUtxos[0];     // V1 兼容；V2 TBC→FT 不会走到这里
		// V2 swaptoToken_baseTBC 通过 fetchFtUTXOsforPool 取池子的全部 FT UTXOs。
		// SDK tape 有 6 个 slot，ftInputIndex=2 占用 2 个，剩 4 个；超过 4 个会被 buildTapeAmount 忽略
		// 但仍作为 tx input 加入 → 制造非法 tx。所以这里也截取最多 4 个。
		TBCAPI.fetchFtUTXOsforPool = async () => poolFtUtxos.slice(0, 4);
		TBCAPI.fetchCoinUTXOs = async () => poolFtUtxos.slice(0, 4);
		TBCAPI.fetchTXraw = async (txId) => {
			const tx = offlineTxMap.get(txId);
			if (!tx) throw new Error(`[POOL_SWAP_TBC_FT] 离线 tx 未找到: ${txId}`);
			return tx;
		};
		TBCAPI.fetchFtPrePreTxData = async (preTX, preTxVout) =>
			buildFtPrePreTxDataFromMap(preTX, preTxVout, offlineTxMap);
		pool.fetchPoolNftUTXO = async () => poolNftUtxo;

		// SDK 在 buildTapeAmount 之前已经原地修改 pool.tbc_amount / ft_a_amount，
		// 失败时必须回滚，否则下次 swap 会拿脏状态构造非法 tx 或越界 buildTapeAmount。
		const ammSnap = this._snapshotPoolAmm(pool);

		let swapRaw;
		try {
			// V2: swaptoToken_baseTBC(privateKey, address_to, utxo, amount_tbc, lpPlan?)
			swapRaw = await pool.swaptoToken_baseTBC(privateKey, ownerAddress, sdkUtxo, 0.001);
		} catch (e) {
			this._restorePoolAmm(pool, ammSnap);
			const ftSum = poolFtUtxos.reduce((s, u) => s + BigInt(u.ftBalance), 0n);
			console.log(`[POOL_SWAP_TBC_FT] 失败: ${e.message}`);
			console.log(`[POOL_SWAP_TBC_FT] 状态: pool.ft_a=${ammSnap.ft_a_amount} pool.tbc=${ammSnap.tbc_amount} poolFtUtxos.length=${poolFtUtxos.length} ftSum=${ftSum}`);
			return null;
		} finally {
			TBCAPI.fetchFtInfo         = savedFetchFtInfo;
			TBCAPI.fetchCoinInfo       = savedFetchCoinInfo;
			TBCAPI.fetchFtUTXO         = savedFetchFtUTXO;
			TBCAPI.fetchFtUTXOsforPool = savedFetchFtUTXOsforPool;
			TBCAPI.fetchCoinUTXOs      = savedFetchCoinUTXOs;
			TBCAPI.fetchTXraw          = savedFetchTXraw;
			TBCAPI.fetchFtPrePreTxData = savedFetchFtPrePreTxData;
			pool.fetchPoolNftUTXO      = savedFetchPoolNftUTXO;
		}

		const swapTx = new Transaction(swapRaw);
		offlineTxMap.set(swapTx.hash, swapTx);
		// V2 后续 swap 仍以 contractTxid 取最新 tape → 指向 swapTx
		pool.contractTxid = swapTx.hash;
		// 不信任 SDK 内部 BigInt 除法的舍入累积；从刚签好的 tape 重读权威 AMM 状态
		this._reloadAmmFromTape(pool, swapTx);

		// swaptoToken_baseTBC 输出布局（条件依赖 serviceFeeA 与 decrement<sum）:
		//   [0]poolNFT [1]NFT_tape [2]userFT [3]userFT_tape
		//   (if serviceFeeA>=10) [N]P2PKH_serviceFee
		//   (if decrement<tapeSum) [M]poolFT_change_code [M+1]poolFT_change_tape  ← 池子 FT 找零
		//   [...] P2PKH_change
		poolState.poolNftUtxo = {
			txId: swapTx.hash, outputIndex: 0,
			script: swapTx.outputs[0].script.toHex(),
			satoshis: swapTx.outputs[0].satoshis,
		};

		// 扫描所有 outputs，找到属于池子的 FT 找零 UTXO（codeScript 末位为 poolnft_codehash160，且 satoshis=500）。
		// 旧的池子 FT UTXOs 已在本 tx 全部被消耗，新数组 = [找零 UTXO]（或为空当 decrement==sum）。
		const newPoolFtUtxos = [];
		for (let i = 0; i < swapTx.outputs.length - 1; i++) {
			const o = swapTx.outputs[i];
			if (o.satoshis !== 500) continue;
			const codeHex = o.script.toHex();
			// FT transfer code 模板末尾 40 字符 = address/hash160 推送（hex 形式），匹配池子 hash
			if (!codeHex.includes(poolnft_codehash160)) continue;
			const next = swapTx.outputs[i + 1];
			if (!next || next.satoshis !== 0) continue;
			// vout=i 是池子 FT code, vout=i+1 是其 tape；用 buildUTXO 取出 ftBalance
			newPoolFtUtxos.push(buildUTXO(swapTx, i, true));
		}
		poolState.poolFtUtxos = newPoolFtUtxos;
		poolState.userFtUtxo = buildUTXO(swapTx, 2, true); // 用户获得的 FT

		const outs = parseTxOutputs(swapTx, this.network);
		const outSum = outs.reduce((s, o) => s + o.satoshis, 0);
		const nextP2PKH = outs.find(o => o.consumable && o.satoshis >= 1000);

		return {
			txType: 'pool_nft',
			consumedInputs: [enrichedInput],
			rawTxs: [{ raw: swapRaw, txId: swapTx.id, fee: Math.max(0, enrichedInput.satoshis - outSum), outputs: outs }],
			_nextUtxo: nextP2PKH
				? { txId: swapTx.id, outputIndex: nextP2PKH.vout, satoshis: nextP2PKH.satoshis, ownerAddress }
				: null,
		};
	}

	// ---------- POOL_NFT: Layer 3+ — FT→TBC swap（用户付 FT，获得 TBC）----------
	// 需要 poolState.userFtUtxo 非空（即先经历过一次 TBC→FT 才有 FT 可用）
	// 若无 userFt 则降级为 TBC→FT
	async buildPoolSwapFTtoTBC(poolState, enrichedInput) {
		const { userFtUtxo } = poolState;
		if (!userFtUtxo) {
			console.log('[POOL_SWAP_FT_TBC] 用户无FT，降级为TBC→FT');
			return this.buildPoolSwapTBCtoFT(poolState, enrichedInput);
		}

		const { pool, poolNftUtxo, poolFtUtxos, poolnft_codehash160, ownerAddress, offlineTxMap } = poolState;
		const privateKey = this.addressPool.getPrivateKeyForAddress(ownerAddress);
		if (!privateKey) return null;
		if (!poolFtUtxos || poolFtUtxos.length === 0) return null;

		const ftInfo = this.localFtInfoCache.get(pool.ft_a_contractTxid);
		const decimal = ftInfo?.decimal ?? 6;
		// 使用用户全部 FT 余额换回 TBC（避免 FT 找零复杂性）。
		// 用 BigInt 精确格式化，避免 ftBalance > 2^53 时 Number/Math.pow 丢精度
		const amount_token = this._bigintToDecimalString(BigInt(userFtUtxo.ftBalance), decimal);

		const sdkUtxo = {
			txId: enrichedInput.txId,
			outputIndex: enrichedInput.outputIndex,
			script: enrichedInput.script,
			satoshis: enrichedInput.satoshis,
		};

		const savedFetchFtInfo         = TBCAPI.fetchFtInfo;
		const savedFetchCoinInfo       = TBCAPI.fetchCoinInfo;
		const savedFetchFtUTXO         = TBCAPI.fetchFtUTXO;
		const savedFetchFtUTXOsforPool = TBCAPI.fetchFtUTXOsforPool;
		const savedFetchCoinUTXOs      = TBCAPI.fetchCoinUTXOs;
		const savedFetchTXraw          = TBCAPI.fetchTXraw;
		const savedFetchFtPrePreTxData = TBCAPI.fetchFtPrePreTxData;
		const savedFetchPoolNftUTXO    = pool.fetchPoolNftUTXO.bind(pool);

		const restoreMocks = () => {
			TBCAPI.fetchFtInfo         = savedFetchFtInfo;
			TBCAPI.fetchCoinInfo       = savedFetchCoinInfo;
			TBCAPI.fetchFtUTXO         = savedFetchFtUTXO;
			TBCAPI.fetchFtUTXOsforPool = savedFetchFtUTXOsforPool;
			TBCAPI.fetchCoinUTXOs      = savedFetchCoinUTXOs;
			TBCAPI.fetchTXraw          = savedFetchTXraw;
			TBCAPI.fetchFtPrePreTxData = savedFetchFtPrePreTxData;
			pool.fetchPoolNftUTXO      = savedFetchPoolNftUTXO;
		};

		TBCAPI.fetchFtInfo = async (contractTxid) => {
			const cached = this.localFtInfoCache.get(contractTxid);
			if (cached) return cached;
			throw new Error(`[POOL_SWAP_FT_TBC] 离线 FtInfo 缺失: ${contractTxid}`);
		};
		TBCAPI.fetchCoinInfo = async () => { throw new Error('[POOL_SWAP_FT_TBC] 离线模式：fetchCoinInfo 不可用'); };
		TBCAPI.fetchFtUTXO = async (contractTxid, ownerOrHash) => {
			// V2 swaptoTBC_baseToken: 第一次调用拿用户 FT（by ownerAddress），无第二次（池子 FT 走 fetchFtUTXOsforPool）
			return ownerOrHash === poolnft_codehash160 ? poolFtUtxos[0] : userFtUtxo;
		};
		TBCAPI.fetchFtUTXOsforPool = async () => poolFtUtxos.slice(0, 4);
		TBCAPI.fetchCoinUTXOs      = async () => poolFtUtxos.slice(0, 4);
		TBCAPI.fetchTXraw = async (txId) => {
			const tx = offlineTxMap.get(txId);
			if (!tx) throw new Error(`[POOL_SWAP_FT_TBC] 离线 tx 未找到: ${txId}`);
			return tx;
		};
		TBCAPI.fetchFtPrePreTxData = async (preTX, preTxVout) =>
			buildFtPrePreTxDataFromMap(preTX, preTxVout, offlineTxMap);
		pool.fetchPoolNftUTXO = async () => poolNftUtxo;

		// SDK swap 路径会原地修改 pool AMM 状态；build 抛错前不可恢复，由我们做 snapshot/restore
		const ammSnap = this._snapshotPoolAmm(pool);

		let swapRaw;
		try {
			// V2: swaptoTBC_baseToken(privateKey, address_to, utxo, amount_token, lpPlan?)
			swapRaw = await pool.swaptoTBC_baseToken(privateKey, ownerAddress, sdkUtxo, amount_token);
		} catch (e) {
			this._restorePoolAmm(pool, ammSnap);
			console.log(`[POOL_SWAP_FT_TBC] swaptoTBC_baseToken 失败: ${e.message}，降级为TBC→FT`);
			console.log(`[POOL_SWAP_FT_TBC] 状态: pool.ft_a=${ammSnap.ft_a_amount} pool.tbc=${ammSnap.tbc_amount} userFt.ftBalance=${userFtUtxo.ftBalance} amount_token=${amount_token}`);
			restoreMocks();
			return this.buildPoolSwapTBCtoFT(poolState, enrichedInput);
		} finally {
			restoreMocks();
		}

		const swapTx = new Transaction(swapRaw);
		offlineTxMap.set(swapTx.hash, swapTx);
		pool.contractTxid = swapTx.hash;
		// 从刚签好的 tape 重读权威 AMM 状态
		this._reloadAmmFromTape(pool, swapTx);

		// swaptoTBC_baseToken 输出: [0]poolNFT [1]tape [2]P2PKH_TBC_to_user [3]poolFT_NEW [4]tape [...]
		// 重点：本 swap **不消耗**池子原有 FT UTXOs（输入只是 poolNFT + 用户 FT + utxo），
		// 只是**新增**了一个池子 FT UTXO（用户付给池子的部分）。所以原 poolFtUtxos 保留，新的 push 进去。
		poolState.poolNftUtxo = {
			txId: swapTx.hash, outputIndex: 0,
			script: swapTx.outputs[0].script.toHex(),
			satoshis: swapTx.outputs[0].satoshis,
		};
		poolState.poolFtUtxos = [...poolFtUtxos, buildUTXO(swapTx, 3, true)];
		poolState.userFtUtxo = null; // 用户 FT 已全部用于换回 TBC

		const outs = parseTxOutputs(swapTx, this.network);
		const outSum = outs.reduce((s, o) => s + o.satoshis, 0);
		// swaptoTBC_baseToken 有两个 P2PKH 输出：output[2]=TBC付给用户（小额）、最后=手续费找零（大额）
		// 必须选手续费找零作为续接 UTXO，否则下一笔 TBC→FT 资金不足
		const p2pkhOuts = outs.filter(o => o.consumable && o.satoshis >= 1000);
		const nextP2PKH = p2pkhOuts.length > 1 ? p2pkhOuts[p2pkhOuts.length - 1] : p2pkhOuts[0];

		return {
			txType: 'pool_nft',
			consumedInputs: [enrichedInput],
			rawTxs: [{ raw: swapRaw, txId: swapTx.id, fee: Math.max(0, enrichedInput.satoshis - outSum), outputs: outs }],
			_nextUtxo: nextP2PKH
				? { txId: swapTx.id, outputIndex: nextP2PKH.vout, satoshis: nextP2PKH.satoshis, ownerAddress }
				: null,
		};
	}

	// ---------- TBC20_CONTRACT: NFT createCollection — showcase Layer 1 ----------
	// supply 固定为 1：集合只产生 1 个 mint slot，Layer 2 铸造，Layer 3+ 改为 transfer
	// 这样每次展示 create → mint → transfer... 的完整生命周期，且不会创建出超出集合限制的非法 NFT
	buildNFTCollection(enrichedInputs) {
		const input = enrichedInputs[0];
		const privateKey = this.addressPool.getPrivateKeyForAddress(input.ownerAddress);
		if (!privateKey) return null;
		if (input.satoshis < 10000) return null;

		const seed = this.rng.nextInt(100000, 999999);
		const collectionData = {
			collectionName: `COL${seed}`,
			description: `collection ${seed}`,
			supply: 1, // 仅 1 个 NFT slot，避免创建超出供应量的非法交易
			file: '0000000000000000000000000000000000000000000000000000000000000000',
		};

		let raw;
		try {
			raw = NFT.createCollection(input.ownerAddress, privateKey, collectionData, [{
				txId: input.txId,
				outputIndex: input.outputIndex,
				script: input.script,
				satoshis: input.satoshis,
			}]);
		} catch (e) {
			console.log(`[NFT_COLLECTION] createCollection 失败: ${e.message}`);
			return null;
		}

		const parsed = new Transaction(raw);
		const outs = parseTxOutputs(parsed, this.network);
		const outSum = outs.reduce((s, o) => s + o.satoshis, 0);

		// vout[1]: 唯一的 NFT mint slot（buildMintScript，100 sat）
		const mintOut = parsed.outputs[1];
		const mintSlots = mintOut ? [{
			txId: parsed.id,
			outputIndex: 1,
			script: mintOut.script.toHex(),
			satoshis: mintOut.satoshis,
		}] : [];

		return {
			txType: 'tbc20_contract',
			consumedInputs: [input],
			rawTxs: [{ raw, txId: parsed.id, fee: Math.max(0, input.satoshis - outSum), outputs: outs }],
			nftState: {
				collectionId: parsed.id,
				collectionTx: parsed,           // 保存解析后的集合 tx，用于首次 transfer 的 pre_pre_tx
				ownerAddress: input.ownerAddress,
				mintSlots,
				nftChain: null,                 // 铸造首个 NFT 后填充，供 transfer 链使用
			},
		};
	}

	// ---------- TBC20_CONTRACT: NFT createNFT — Layer 2（消耗唯一 mint slot）----------
	// 成功后填充 nftState.nftChain，为 Layer 3+ 的 transfer 链提供初始状态
	buildNFTMint(nftState, tbcEnrichedInput) {
		const { collectionId, ownerAddress, mintSlots, collectionTx } = nftState;
		if (mintSlots.length === 0) {
			console.log('[NFT_MINT] 无剩余 mint slot');
			return null;
		}

		const privateKey = this.addressPool.getPrivateKeyForAddress(ownerAddress);
		if (!privateKey) return null;

		const nfttxo = mintSlots[0]; // peek，成功后 shift
		const sdkUtxo = {
			txId: tbcEnrichedInput.txId,
			outputIndex: tbcEnrichedInput.outputIndex,
			script: tbcEnrichedInput.script || this.addressPool.getScriptForAddress(tbcEnrichedInput.ownerAddress),
			satoshis: tbcEnrichedInput.satoshis,
		};

		// nftData 传空对象，createNFT 内部会自动设置 file = collectionId + uint32LE(outputIndex)
		const nftData = {};
		let raw;
		try {
			raw = NFT.createNFT(collectionId, ownerAddress, privateKey, nftData, [sdkUtxo], nfttxo);
		} catch (e) {
			console.log(`[NFT_MINT] createNFT 失败: ${e.message}`);
			return null;
		}

		mintSlots.shift(); // 消耗 slot（此集合 mint slot 现已耗尽）

		const parsed = new Transaction(raw);
		const outs = parseTxOutputs(parsed, this.network);
		const outSum = outs.reduce((s, o) => s + o.satoshis, 0);
		const inSum = tbcEnrichedInput.satoshis + nfttxo.satoshis;

		// 构建 NFT 实例：直接设置字段，不走 initialize()，避免 file 字段被错误覆盖
		// nftData.file 已被 createNFT 填充为 collectionId + uint32LE(nfttxo.outputIndex)
		const nft = new NFT(parsed.id); // contract_id = 本次 createNFT tx 的 hash
		nft.collection_id = collectionId;
		nft.collection_index = nfttxo.outputIndex;
		nft.nftData = { ...nftData }; // 保存实际写入 tape 的数据，transfer 时必须与之一致

		// prePrETX = collectionTx（createNFT 消耗了 collection 的 mint slot，故 grandparent = collection）
		nftState.nftChain = {
			nft,
			preTX: parsed,       // 最新 NFT tx（下一次 transfer 的 pre_tx）
			prePrETX: collectionTx, // 下一次 transfer 的 pre_pre_tx
		};

		return {
			txType: 'tbc20_contract',
			// nfttxo 进入 consumedInputs，graph 才能建立 NFT mint → collection 的父子边
			consumedInputs: [
				tbcEnrichedInput,
				{ txId: nfttxo.txId, outputIndex: nfttxo.outputIndex, ownerAddress },
			],
			rawTxs: [{ raw, txId: parsed.id, fee: Math.max(0, inSum - outSum), outputs: outs }],
		};
	}

	// ---------- TBC20_CONTRACT: NFT transferNFT — Layer 3+（集合供应耗尽后的续接）----------
	// 与 FT transfer 相同的滑动窗口：prePrETX ← preTX ← transferTx
	// 集合 supply 已满后只能走此路径，尝试再次 createNFT 会产生非法交易
	buildNFTTransfer(nftState, tbcEnrichedInput) {
		const { ownerAddress, nftChain } = nftState;
		if (!nftChain) {
			console.log('[NFT_TRANSFER] nftChain 未初始化（需先 mint）');
			return null;
		}
		const { nft, preTX, prePrETX } = nftChain;

		const privateKey = this.addressPool.getPrivateKeyForAddress(ownerAddress);
		if (!privateKey) return null;

		const sdkUtxo = {
			txId: tbcEnrichedInput.txId,
			outputIndex: tbcEnrichedInput.outputIndex,
			script: tbcEnrichedInput.script || this.addressPool.getScriptForAddress(tbcEnrichedInput.ownerAddress),
			satoshis: tbcEnrichedInput.satoshis,
		};

		let raw;
		try {
			// 转给自己，owner 不变，链可持续续接
			raw = nft.transferNFT(ownerAddress, ownerAddress, privateKey, [sdkUtxo], preTX, prePrETX);
		} catch (e) {
			console.log(`[NFT_TRANSFER] transferNFT 失败: ${e.message}`);
			return null;
		}

		const transferTx = new Transaction(raw);
		const outs = parseTxOutputs(transferTx, this.network);
		const outSum = outs.reduce((s, o) => s + o.satoshis, 0);
		const inSum = tbcEnrichedInput.satoshis + 200 + 100; // fee UTXO + NFT code(vout[0]) + NFT hold(vout[1])

		// 滑动窗口推进：prePrETX ← preTX ← transferTx
		nftChain.prePrETX = preTX;
		nftChain.preTX = transferTx;

		return {
			txType: 'tbc20_contract',
			// preTX 的 vout[0]/vout[1] 被消耗，纳入 consumedInputs 建立 graph 父子边
			consumedInputs: [
				tbcEnrichedInput,
				{ txId: preTX.id, outputIndex: 0, ownerAddress },
				{ txId: preTX.id, outputIndex: 1, ownerAddress },
			],
			rawTxs: [{ raw, txId: transferTx.id, fee: Math.max(0, inSum - outSum), outputs: outs }],
		};
	}

	// ---------- TBC20_CONTRACT: NFT createCollection (N utxos same owner → 1 tx) ----------
	// 随机压测模式用；展示模式走 buildNFTCollection + buildNFTMint
	buildTBC20Contract(enrichedInputs) {
		// NFT.createCollection 用同一私钥签名所有输入，要求 utxos 同 owner
		const firstOwner = enrichedInputs[0].ownerAddress;
		const sameOwnerInputs = enrichedInputs.filter((u) => u.ownerAddress === firstOwner);
		if (sameOwnerInputs.length === 0) return null;

		const privateKey = this.addressPool.getPrivateKeyForAddress(firstOwner);
		if (!privateKey) return null;

		const totalInput = sameOwnerInputs.reduce((s, u) => s + u.satoshis, 0);
		if (totalInput < 10000) return null;

		const supply = 10;
		const sdkUtxos = sameOwnerInputs.map((u) => ({
			txId: u.txId,
			outputIndex: u.outputIndex,
			script: u.script,
			satoshis: u.satoshis,
		}));

		const seed = this.rng.nextInt(100000, 999999);
		const data = {
			collectionName: `COL${seed}`,
			description: `auto-generated collection ${seed}`,
			supply,
			file: '0000000000000000000000000000000000000000000000000000000000000000',
		};

		let raw;
		try {
			raw = NFT.createCollection(firstOwner, privateKey, data, sdkUtxos);
		} catch (e) {
			console.log(`[TBC20_CONTRACT] NFT.createCollection 失败: ${e.message}, fallback`);
			return null;
		}

		const parsed = new Transaction(raw);
		const outs = parseTxOutputs(parsed, this.network);
		let outSum = 0;
		for (const o of outs) outSum += o.satoshis;

		// 收集 mint slots（vout[1..supply]），供随机模式后续 buildNFTMint 使用
		const mintSlots = [];
		for (let i = 1; i <= supply; i++) {
			const mintOut = parsed.outputs[i];
			if (mintOut) {
				mintSlots.push({ txId: parsed.id, outputIndex: i, script: mintOut.script.toHex(), satoshis: mintOut.satoshis });
			}
		}

		return {
			txType: 'tbc20_contract',
			consumedInputs: sameOwnerInputs,
			rawTxs: [{
				raw,
				txId: parsed.id,
				fee: Math.max(0, totalInput - outSum),
				outputs: outs,
			}],
			// nftState 供随机压测模式存入 nftStatePool，后续可 buildNFTMint / buildNFTTransfer
			nftState: {
				collectionId: parsed.id,
				collectionTx: parsed,
				ownerAddress: firstOwner,
				mintSlots,
				nftChain: null,
			},
		};
	}

	// ---------- OTHER: HTLC / PiggyBank / MultiSig ----------
	// forcedSubType: 展示模式用，跳过随机选择
	buildOther(enrichedInputs, forcedSubType = null) {
		const subType = forcedSubType || this.rng.pickWeighted(this.config.otherSubTypes);

		// 三种子类型都用同一私钥签名，过滤同 owner
		const firstOwner = enrichedInputs[0].ownerAddress;
		const sameOwnerInputs = enrichedInputs.filter((u) => u.ownerAddress === firstOwner);
		const privateKey = this.addressPool.getPrivateKeyForAddress(firstOwner);
		if (!privateKey) return null;
		if (sameOwnerInputs.length === 0) return null;

		// 锁定金额 0.005 TBC = 5000 sat（远低于单 utxo 余额，保证 change > 0）
		const lockTbc = 0.005;
		// lock_time 必须 >= 500000000（Unix 时间戳模式）
		const lockTime = Math.floor(Date.now() / 1000) + 86400 + this.rng.nextInt(0, 86400);

		// htlc_deploy 只消耗第一个 utxo；其他子类型消耗全部同 owner utxos
		const consumedInputs =
			subType === 'htlc_deploy' ? [sameOwnerInputs[0]] : sameOwnerInputs;
		const totalInput = consumedInputs.reduce((s, u) => s + u.satoshis, 0);
		if (totalInput < 50000) return null; // 至少留出锁定金额 + fee

		const sdkUtxos = consumedInputs.map((u) => ({
			txId: u.txId,
			outputIndex: u.outputIndex,
			script: u.script,
			satoshis: u.satoshis,
		}));

		let raw;
		try {
			if (subType === 'piggybank_freeze') {
				raw = piggyBank._freezeTBC(privateKey, lockTbc, lockTime, sdkUtxos);
			} else if (subType === 'htlc_deploy') {
				const receiver = this.rng.pick(this.addressPool.addresses);
				// 32 字节 hex hashlock
				const hashBytes = this.rng.shuffle(
					'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'.split('')
				).join('');
				raw = HTLC.deployHTLCWithSign(
					firstOwner,
					receiver,
					hashBytes,
					lockTime,
					lockTbc,
					sdkUtxos[0],
					privateKey.toString(),
				);
			} else {
				// multisig_create: 选 3 个不同 pubkey，2-of-3
				const poolKeys = this.addressPool.keys;
				if (poolKeys.length < 3) return null;
				const idxs = this.rng.shuffle(Array.from({ length: poolKeys.length }, (_, i) => i)).slice(0, 3);
				const pubKeys = idxs.map((i) => poolKeys[i].toPublicKey().toString());
				raw = MultiSig.createMultiSigWallet(
					firstOwner,
					pubKeys,
					2,
					3,
					lockTbc,
					sdkUtxos,
					privateKey,
				);
			}
		} catch (e) {
			console.log(`[OTHER:${subType}] 构造失败: ${e.message}, fallback`);
			return null;
		}

		const parsed = new Transaction(raw);
		const outs = parseTxOutputs(parsed, this.network);
		let outSum = 0;
		for (const o of outs) outSum += o.satoshis;

		return {
			txType: 'other',
			subType,
			consumedInputs,
			rawTxs: [{
				raw,
				txId: parsed.id,
				fee: Math.max(0, totalInput - outSum),
				outputs: outs,
			}],
		};
	}

	// 随机压测主入口
	// tbc20 / tbc20_contract / pool_nft 优先续接已有状态池中的链，无可续接时才新建
	async build(enrichedInputs, depth) {
		const txType = this.pickTxType();
		let result = null;

		if (txType === 'tbc20') {
			if (this.ftSingle) {
				// FT 已建立：找该 owner 的 input 做 transfer
				const inp = enrichedInputs.find(i => i.ownerAddress === this.ftSingle.ftOwner);
				if (inp) {
					result = await this._time('tbc20.transfer', async () => this.buildFTTransfer(this.ftSingle, inp));
					if (result) this._opStats.ft_transfer++;
				}
			}
			// FT 未建立，或 owner 的 input 暂不在本轮 enrichedInputs 中：mint 一次
			if (!result && !this.ftSingle) {
				result = await this._time('tbc20.mint', async () => this.buildTBC20(enrichedInputs, true));
				if (result) this._opStats.ft_mint++;
				if (result?.ftMintData) {
					const { ft, recipient, txSourceParsed, txMintParsed } = result.ftMintData;
					this.ftSingle = {
						ft,
						ftOwner:   recipient,
						ftUtxo:    buildUTXO(txMintParsed, 0, true),
						preTX:     txMintParsed,
						preTxVout: 0,
						prePrETX:  txSourceParsed,
					};
				}
			}

		} else if (txType === 'tbc20_contract') {
			if (this.nftSingle) {
				// 集合已建立：找该 owner 的 input，mint（slot 有余）或 transfer（已有 nftChain）
				const inp = enrichedInputs.find(i => i.ownerAddress === this.nftSingle.ownerAddress);
				if (inp) {
					const canMint     = this.nftSingle.mintSlots.length > 0;
					const canTransfer = !!this.nftSingle.nftChain;
					if (canMint && canTransfer) {
						// 两者都可以：随机选择（体现"一边 mint 一边 transfer"）
						if (this.rng.next() < 0.5) {
							result = await this._time('nft.mint', async () => this.buildNFTMint(this.nftSingle, inp));
							if (result) this._opStats.nft_mint++;
						}
						if (!result) {
							result = await this._time('nft.transfer', async () => this.buildNFTTransfer(this.nftSingle, inp));
							if (result) this._opStats.nft_transfer++;
						}
					} else if (canMint) {
						result = await this._time('nft.mint', async () => this.buildNFTMint(this.nftSingle, inp));
						if (result) this._opStats.nft_mint++;
					} else if (canTransfer) {
						result = await this._time('nft.transfer', async () => this.buildNFTTransfer(this.nftSingle, inp));
						if (result) this._opStats.nft_transfer++;
					}
				}
			}
			// 集合未建立，或 owner input 暂不在本轮：create 一次
			if (!result && !this.nftSingle) {
				result = await this._time('nft.create', async () => this.buildTBC20Contract(enrichedInputs));
				if (result) this._opStats.nft_create++;
				if (result?.nftState) this.nftSingle = result.nftState;
			}

		} else if (txType === 'other') {
			result = await this._time('other', async () => this.buildOther(enrichedInputs));

		} else if (txType === 'pool_nft') {
			if (!this.poolNftSingle) {
				// Phase 1: 全局只建一次池，使用当前 enrichedInputs 选定 input
				result = await this._time('pool.create', async () => this.buildPoolNFTCreate(enrichedInputs));
				if (result?.poolData && result._nextUtxo) {
					this.poolNftSingle = { phase: 'created', poolData: result.poolData, nextUtxo: result._nextUtxo };
					this._opStats.pool_create++;
				}

			} else if (this.poolNftSingle.phase === 'created') {
				// Phase 2: 全局只 init 一次，直接使用上一步记录的 nextUtxo
				const nxt = this.poolNftSingle.nextUtxo;
				const poolInput = {
					txId: nxt.txId, outputIndex: nxt.outputIndex,
					satoshis: nxt.satoshis, ownerAddress: nxt.ownerAddress,
					script: this.addressPool.getScriptForAddress(nxt.ownerAddress),
				};
				result = await this._time('pool.init', async () => this.buildPoolNFTInit(this.poolNftSingle.poolData, poolInput));
				if (result?.poolState && result._nextUtxo) {
					this.poolNftSingle = { phase: 'ready', poolState: result.poolState, nextUtxo: result._nextUtxo };
					this._opStats.pool_init++;
				}

			} else {
				// Phase 3+: 每次 pool_nft 都做 swap，直接使用上一次记录的 nextUtxo
				const nxt = this.poolNftSingle.nextUtxo;
				const poolInput = {
					txId: nxt.txId, outputIndex: nxt.outputIndex,
					satoshis: nxt.satoshis, ownerAddress: nxt.ownerAddress,
					script: this.addressPool.getScriptForAddress(nxt.ownerAddress),
				};
				// 选向：FT→TBC 会**新增**一个池子 FT UTXO 而不消耗旧的，必须节制使用，
				// 否则累积 > 4 时 SDK buildTapeAmount（6 slot 减去 ftInputIndex=2）会越界。
				// 当 poolFtUtxos 已积累到 3 个时强制走 TBC→FT 把它们合并为 1 个找零。
				const ftUtxoCount = this.poolNftSingle.poolState.poolFtUtxos?.length ?? 0;
				const canDoFT = this.poolNftSingle.poolState.userFtUtxo && ftUtxoCount < 3;
				const doFT = canDoFT && this.rng.next() < 0.5;
				result = doFT
					? await this._time('pool.swap_ft_tbc', async () => this.buildPoolSwapFTtoTBC(this.poolNftSingle.poolState, poolInput))
					: await this._time('pool.swap_tbc_ft', async () => this.buildPoolSwapTBCtoFT(this.poolNftSingle.poolState, poolInput));
				if (result) {
					if (result.poolState) this.poolNftSingle.poolState = result.poolState;
					if (result._nextUtxo) this.poolNftSingle.nextUtxo = result._nextUtxo;
					this._opStats.pool_swap++;
				}
			}
		}

		// 所有 SDK 路径失败或类型为 P2PKH，fallback 到 P2PKH
		if (!result) {
			result = await this._time('p2pkh', async () => this.buildP2PKH(enrichedInputs));
			if (result) result.txType = 'p2pkh';
		}
		return result;
	}
}

// ==================== 流式写入器 ====================

class StreamingWriter {
	constructor(outputDir, batchSize) {
		this.outputDir = outputDir;
		this.batchSize = batchSize;
		this.transactionsBuffer = [];
		this.totalWritten = 0;
		this.txStream = fs.createWriteStream(path.join(outputDir, 'transactions.txt'), {
			flags: 'a',
		});
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

// ==================== 展示模式种类定义 ====================
// 每个 slot 对应一种需要被证明可持续生成的交易类型

const SHOWCASE_SLOTS = [
	{ txType: 'p2pkh',          subType: null,              label: 'P2PKH' },
	{ txType: 'tbc20',          subType: null,              label: 'TBC20/FT' },          // Layer1=Mint, Layer2+=Transfer
	{ txType: 'tbc20_contract', subType: null,              label: 'TBC20_CONTRACT/NFT' },
	{ txType: 'pool_nft',       subType: null,              label: 'POOL_NFT' },          // Layer1=Create, Layer2=Init, Layer3+=Swap(随机TBC↔FT)
	{ txType: 'other',          subType: 'multisig_create', label: 'OTHER/MultiSig' },
];

// ==================== 混合类型 Mesh 链构建器 ====================

class AllTypesMeshBuilder {
	constructor(config) {
		this.config = config;
		this.rng = new SeededRandom(config.randomSeed);
		this.graph = new TransactionGraph();
		this.addressPool = null;
		this.txBuilder = null;
		this.writer = null;
	}

	async init() {
		console.log('='.repeat(80));
		console.log('混合类型网状交易链构建器 (generator-mesh-alltypes-tx)');
		console.log('='.repeat(80));

		this.checkInitialFunds();

		if (!fs.existsSync(this.config.outputDir)) {
			fs.mkdirSync(this.config.outputDir, { recursive: true });
		}
		fs.writeFileSync(path.join(this.config.outputDir, 'transactions.txt'), '');

		this.addressPool = new AddressPool(this.config.addressPoolSize, this.config.network);

		console.log('\n[初始化] 导入初始UTXO私钥...');
		for (const utxo of this.config.initialUtxos) {
			if (utxo.privateKeyWif) {
				const address = this.addressPool.importPrivateKey(
					utxo.privateKeyWif,
					`initial-${utxo.txId.substring(0, 8)}`
				);
				utxo.ownerAddress = address;
			} else {
				throw new Error(`初始UTXO ${utxo.txId}:${utxo.outputIndex} 缺少私钥`);
			}
		}

		this.addressPool.saveKeysToFile(this.config.outputDir);
		this.txBuilder = new TransactionBuilder(
			this.addressPool,
			this.rng,
			this.config,
			this.config.network || 'mainnet',
		);
		this.writer = new StreamingWriter(this.config.outputDir, this.config.batchSize);
		this.graph.addInitialUtxos(this.config.initialUtxos);

		console.log(`\n[初始化] 随机种子: ${this.rng.initialSeed}`);
		console.log(`[初始化] 地址池大小: ${this.addressPool.addresses.length}`);
		console.log(`[初始化] 初始UTXO: ${this.config.initialUtxos.length}`);
		console.log(`[初始化] 类型权重:`, this.config.typeWeights);
		console.log(`[初始化] 流式写入批次: ${this.config.batchSize}\n`);
	}

	checkInitialFunds() {
		const totalInput = this.config.initialUtxos.reduce((sum, u) => sum + u.satoshis, 0);
		const minRequired = this.config.targetMaxDepth * this.config.feePerTx * 2; // 合约交易手续费更高

		console.log('\n[资金检查]');
		console.log(`  初始总金额: ${totalInput} 聪 (${(totalInput / 1e6).toFixed(4)} TBC)`);
		console.log(`  目标深度: ${this.config.targetMaxDepth}`);
		console.log(`  预计最少需要: ${minRequired} 聪`);

		if (totalInput < minRequired) {
			throw new Error(`资金不足！至少需要 ${minRequired} 聪`);
		}
		console.log('  [✓] 资金充足\n');
	}

	async buildMesh() {
		await this.init();

		// ---- 初始分裂：将单一 coinbase UTXO 拆成多份，防止 pool_nft 一次性耗尽所有 UTXO ----
		const INITIAL_SLOTS = 20;
		const initialUtxo = Array.from(this.graph.utxos.values())[0];
		const slotAmount = Math.floor((initialUtxo.satoshis - this.config.feePerTx) / INITIAL_SLOTS);
		if (slotAmount >= 200000) {
			const splitPk = this.addressPool.getPrivateKeyForAddress(initialUtxo.ownerAddress);
			const slotAddrs = Array.from({ length: INITIAL_SLOTS }, () =>
				this.addressPool.addresses[this.rng.nextInt(0, this.addressPool.addresses.length - 1)]
			);
			const splitTx = new Transaction();
			splitTx.from({
				txId: initialUtxo.txId, outputIndex: initialUtxo.outputIndex,
				script: this.addressPool.getScriptForAddress(initialUtxo.ownerAddress),
				satoshis: initialUtxo.satoshis,
			});
			for (const addr of slotAddrs) {
				splitTx.addOutput(new Output({ script: this.addressPool.getScriptForAddress(addr), satoshis: slotAmount }));
			}
			splitTx.fee(this.config.feePerTx);
			splitTx.sign(splitPk);

			this.graph.spendUtxo(initialUtxo.txId, initialUtxo.outputIndex);
			this.graph.addTransaction(
				splitTx.id,
				[{ txId: initialUtxo.txId, outputIndex: initialUtxo.outputIndex, ownerAddress: initialUtxo.ownerAddress }],
				slotAddrs.map(a => ({ address: a, type: 'p2pkh' })),
				1, this.config.feePerTx, 'p2pkh',
			);
			for (let i = 0; i < INITIAL_SLOTS; i++) {
				this.graph.addUtxo(splitTx.id, i, slotAmount, slotAddrs[i], 1, initialUtxo.txId, 'p2pkh');
			}
			this.writer.addTransaction(splitTx.uncheckedSerialize());
			console.log(`[初始分裂] ${INITIAL_SLOTS} slots × ${slotAmount} sat → tx ${splitTx.id.substring(0, 16)}...`);
		}
		// ---------------------------------------------------------------------------------

		console.log(`[构建] 目标最大深度: ${this.config.targetMaxDepth}`);
		console.log(`[构建] 最大交易数: ${this.config.maxTransactions}\n`);

		let iteration = 0;
		const startTime = Date.now();
		const depthTxCount = new Map();
		const widthSamples = [];

		this._graphNs = { pick: 0n, record: 0n, write: 0n };
		while (iteration < this.config.maxTransactions) {
			const t0 = process.hrtime.bigint();
			const inputs = this.graph.getUtxosForNewTx(
				this.rng,
				this.config.maxP2pkhInputs,  // ← 改自 addressPoolSize(1000)；ECDSA 签名按 input 数线性增长
				this.config.targetMaxDepth,
				this.config.minSplitAmount
			);
			this._graphNs.pick += process.hrtime.bigint() - t0;

			if (inputs.length === 0) {
				console.log(`\n[停止] 没有可用UTXO`);
				break;
			}

			const newDepth = this.graph.calculateDepth(inputs);
			if (newDepth > this.config.targetMaxDepth) {
				console.log(`\n[停止] 达到目标深度: ${this.config.targetMaxDepth}`);
				break;
			}

			const result = await this.buildTransaction(inputs, newDepth);
			if (!result) {
				console.log(`\n[警告] 构建交易失败，跳过`);
				continue;
			}

			// 注：recordResult 已写入所有 raw txs（链式 SDK txs 可能 >1）
			depthTxCount.set(newDepth, (depthTxCount.get(newDepth) || 0) + 1);
			iteration++;

			if (iteration % 1000 === 0 || iteration === 1) {
				const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
				const unspent = this.graph.getUnspentUtxos().length;
				const totalUtxoSats = this.graph
					.getUnspentUtxos()
					.reduce((s, u) => s + u.satoshis, 0);
				const typeStats = this.graph.stats.byType;
				console.log(
					`  [${elapsed}s] 已构建: ${iteration} | 深度: ${newDepth} | 最大: ${this.graph.stats.maxDepth} | ` +
						`可用UTXO: ${unspent} | ` +
						`P2PKH:${typeStats.p2pkh} TBC20:${typeStats.tbc20} CONTRACT:${typeStats.tbc20_contract} POOL:${typeStats.pool_nft||0} OTHER:${typeStats.other}`
				);
				// 阶段耗时分布：每阶段累计 ms + 调用次数 + 单次均值 ms（保留 0.01 精度）
				const phases = this.txBuilder._phaseNs;
				const counts = this.txBuilder._phaseCount;
				const rows = Object.keys(phases)
					.map(k => ({ name: k, totalMs: Number(phases[k]) / 1e6, n: counts[k] }))
					.sort((a, b) => b.totalMs - a.totalMs);
				console.log(`  [PHASE] ` + rows.map(r => `${r.name}=${r.totalMs.toFixed(0)}ms(${r.n}x,avg ${(r.totalMs / r.n).toFixed(1)})`).join(' | '));
				// graph 操作累计 + 写入 + GC
				const g = this._graphNs ?? { pick: 0n, record: 0n, write: 0n };
				console.log(`  [GRAPH] getUtxos=${(Number(g.pick) / 1e6).toFixed(0)}ms record=${(Number(g.record) / 1e6).toFixed(0)}ms write=${(Number(g.write) / 1e6).toFixed(0)}ms`);
				const mem = process.memoryUsage();
				console.log(`  [MEM]   heapUsed=${(mem.heapUsed/1048576).toFixed(0)}MB rss=${(mem.rss/1048576).toFixed(0)}MB external=${(mem.external/1048576).toFixed(0)}MB`);
			}
		}

		this._printWidthDiagnostics(depthTxCount, widthSamples, iteration);
		this.writer.close();

		console.log(`\n[✓] 构建完成！总交易数: ${iteration}`);
		const ops = this.txBuilder._opStats;
		console.log(`[操作明细] FT: mint=${ops.ft_mint} transfer=${ops.ft_transfer} | NFT: create=${ops.nft_create} mint=${ops.nft_mint} transfer=${ops.nft_transfer} | Pool: create=${ops.pool_create} init=${ops.pool_init} swap=${ops.pool_swap}`);
		this.saveResults();

		return this.graph;
	}

	// ==================== 展示模式 ====================
	// 证明所有种类可确定性、持续性生成（非依赖随机偶然）
	async buildShowcase() {
		await this.init();

		const showcaseDepth = this.config.showcaseDepth ?? 3;
		const amountPerSlot = 2000000; // 0.02 TBC per slot，足够多层续接

		console.log('\n' + '='.repeat(80));
		console.log(`[展示模式] 种类数: ${SHOWCASE_SLOTS.length} | 每种类链深: ${showcaseDepth} 层`);
		console.log('种类列表:');
		SHOWCASE_SLOTS.forEach((s, i) => console.log(`  [${i}] ${s.label}`));
		console.log('='.repeat(80));

		// ---- Step 0: 分裂初始 UTXO → 每种类型各一个 slot ----
		const initialUtxo = Array.from(this.graph.utxos.values())[0];
		const needed = SHOWCASE_SLOTS.length * amountPerSlot + 10000;
		if (initialUtxo.satoshis < needed) {
			throw new Error(`展示模式资金不足，需要 ${needed} 聪（当前: ${initialUtxo.satoshis}）`);
		}

		const slotAddresses = SHOWCASE_SLOTS.map(() => this.rng.pick(this.addressPool.addresses));
		const splitPk = this.addressPool.getPrivateKeyForAddress(initialUtxo.ownerAddress);

		const splitTx = new Transaction();
		splitTx.from({
			txId: initialUtxo.txId,
			outputIndex: initialUtxo.outputIndex,
			script: this.addressPool.getScriptForAddress(initialUtxo.ownerAddress),
			satoshis: initialUtxo.satoshis,
		});
		for (let i = 0; i < SHOWCASE_SLOTS.length; i++) {
			splitTx.addOutput(new Output({
				script: this.addressPool.getScriptForAddress(slotAddresses[i]),
				satoshis: amountPerSlot,
			}));
		}
		// 找零：将剩余资金（扣除合理手续费后）归还原地址，避免巨额手续费
		const splitFee = this.config.feePerTx;
		const splitChange = initialUtxo.satoshis - SHOWCASE_SLOTS.length * amountPerSlot - splitFee;
		if (splitChange > 0) {
			splitTx.addOutput(new Output({
				script: this.addressPool.getScriptForAddress(initialUtxo.ownerAddress),
				satoshis: splitChange,
			}));
		}
		splitTx.fee(splitFee);
		splitTx.sign(splitPk);

		// 注册分裂交易到 graph
		const splitOutputDescs = slotAddresses.map((addr) => ({ address: addr, type: 'p2pkh' }));
		if (splitChange > 0) splitOutputDescs.push({ address: initialUtxo.ownerAddress, type: 'p2pkh' });
		this.graph.spendUtxo(initialUtxo.txId, initialUtxo.outputIndex);
		this.graph.addTransaction(
			splitTx.id,
			[{ txId: initialUtxo.txId, outputIndex: initialUtxo.outputIndex, ownerAddress: initialUtxo.ownerAddress }],
			splitOutputDescs,
			1, splitFee, 'p2pkh',
		);
		for (let i = 0; i < SHOWCASE_SLOTS.length; i++) {
			this.graph.addUtxo(splitTx.id, i, amountPerSlot, slotAddresses[i], 1, initialUtxo.txId, 'p2pkh');
		}
		this.writer.addTransaction(splitTx.uncheckedSerialize());

		console.log(`\n[Step 0] 分裂交易 ${splitTx.id.substring(0, 16)}... → ${SHOWCASE_SLOTS.length} slots`);
		SHOWCASE_SLOTS.forEach((s, i) =>
			console.log(`  slot[${i}] ${s.label.padEnd(30)} addr=${slotAddresses[i].substring(0, 14)}...`)
		);

		// ---- Steps 1..showcaseDepth: 每种类型建确定性链 ----
		// currentSlots 追踪各类型链的当前末端 UTXO
		let currentSlots = SHOWCASE_SLOTS.map((slot, i) => ({
			...slot,
			txId: splitTx.id,
			outputIndex: i,
			satoshis: amountPerSlot,
			ownerAddress: slotAddresses[i],
		}));

		const perTypeCount = {}; // label → 实际生成笔数
		for (const s of SHOWCASE_SLOTS) perTypeCount[s.label] = 0;

		for (let layer = 1; layer <= showcaseDepth; layer++) {
			console.log(`\n[Step ${layer}] ---- 第 ${layer} 层 ----`);
			const nextSlots = [];

			for (const slot of currentSlots) {
				const enriched = [{
					txId: slot.txId,
					outputIndex: slot.outputIndex,
					satoshis: slot.satoshis,
					ownerAddress: slot.ownerAddress,
					script: this.addressPool.getScriptForAddress(slot.ownerAddress),
				}];

				let result = null;
				let slotFtState = slot.ftState;     // undefined → populated after layer 1 FT Mint
				let slotNftState = slot.nftState;   // undefined → populated after layer 1 NFT Collection
				let slotPoolData = slot.poolData;   // undefined → populated after layer 1 Pool Create
				let slotPoolState = slot.poolState; // undefined → populated after layer 2 Pool Init

				try {
					if (slot.txType === 'p2pkh') {
						result = this.txBuilder.buildP2PKH(enriched, true); // 强制单输出
					} else if (slot.txType === 'tbc20') {
						if (slotFtState) {
							// Layer 2+：用已有 FT 状态做 transfer（转给自己，链持续续接）
							result = this.txBuilder.buildFTTransfer(slotFtState, enriched[0]);
						} else {
							// Layer 1：Mint FT，mintToSelf=true 保证 owner 与 TBC 手续费 UTXO 一致
							result = this.txBuilder.buildTBC20(enriched, true);
							// 提取 FT 状态，供后续 transfer 层使用
							if (result?.ftMintData) {
								const { ft, recipient, txSourceParsed, txMintParsed } = result.ftMintData;
								slotFtState = {
									ft,
									ftOwner: recipient,
									ftUtxo: buildUTXO(txMintParsed, 0, true),
									preTX: txMintParsed,
									preTxVout: 0,
									prePrETX: txSourceParsed,
								};
							}
						}
					} else if (slot.txType === 'tbc20_contract') {
						if (!slotNftState) {
							// Layer 1：创建集合（supply=1，仅 1 个 mint slot）
							result = this.txBuilder.buildNFTCollection(enriched);
							if (result?.nftState) slotNftState = result.nftState;
						} else if (slotNftState.mintSlots.length > 0) {
							// Layer 2：铸造 NFT（消耗唯一 mint slot）
							result = this.txBuilder.buildNFTMint(slotNftState, enriched[0]);
						} else {
							// Layer 3+：supply 已耗尽，改为 transfer（再 createNFT 会产生非法交易）
							result = this.txBuilder.buildNFTTransfer(slotNftState, enriched[0]);
						}
					} else if (slot.txType === 'pool_nft') {
						if (!slotPoolData) {
							// Layer 1: 创建 Pool（mint FT + createPoolNFT，4 笔链式 tx）
							result = await this.txBuilder.buildPoolNFTCreate(enriched);
							if (result?.poolData) slotPoolData = result.poolData;
						} else if (!slotPoolState) {
							// Layer 2: 向池注入初始 FT + TBC 流动性
							result = await this.txBuilder.buildPoolNFTInit(slotPoolData, enriched[0]);
							if (result?.poolState) slotPoolState = result.poolState;
						} else {
							// Layer 3+: 随机 swap（TBC→FT 或 FT→TBC）
							const doFTtoTBC = slotPoolState.userFtUtxo && this.rng.next() < 0.5;
							if (doFTtoTBC) {
								result = await this.txBuilder.buildPoolSwapFTtoTBC(slotPoolState, enriched[0]);
							} else {
								result = await this.txBuilder.buildPoolSwapTBCtoFT(slotPoolState, enriched[0]);
							}
						}
					} else {
						result = this.txBuilder.buildOther(enriched, slot.subType);
					}
				} catch (e) {
					console.log(`  [${slot.label}] 异常: ${e.message}`);
					continue;
				}

				if (!result) {
					console.log(`  [${slot.label}] 构建返回 null`);
					continue;
				}

				const txDepth = layer + 1; // splitTx=1, layer1=2, layer2=3, ...
				this.recordResult(result, txDepth);
				perTypeCount[slot.label]++;

				// 寻找续接 UTXO：优先取最靠前 rawTx 中第一个可消费 P2PKH 输出
				// FT.MintFT: rawTxs[0]=txSource(含大额 change), rawTxs[1]=txMint(含小额 change)
				// FT.transfer: rawTxs[0]=transferTx(含 TBC change, FT UTXO 是合约脚本不可消费)
				let nextUtxo = result._nextUtxo ?? null;
				if (!nextUtxo) {
					for (const rt of result.rawTxs) {
						const out = rt.outputs.find((o) => o.consumable && o.address && o.satoshis >= 10000);
						if (out) {
							nextUtxo = {
								txId: rt.txId,
								outputIndex: out.vout,
								satoshis: out.satoshis,
								ownerAddress: out.address,
							};
							break;
						}
					}
				}

				const lastTxId = result.rawTxs[result.rawTxs.length - 1].txId;
				if (nextUtxo && layer < showcaseDepth) {
					nextSlots.push({ ...slot, ...nextUtxo, ftState: slotFtState, nftState: slotNftState, poolData: slotPoolData, poolState: slotPoolState });
					console.log(
						`  [✓] ${slot.label.padEnd(30)} tx=${lastTxId.substring(0, 14)}...  change=${nextUtxo.satoshis} 聪 → 续接`
					);
				} else {
					console.log(
						`  [✓] ${slot.label.padEnd(30)} tx=${lastTxId.substring(0, 14)}...  ${nextUtxo ? `change=${nextUtxo.satoshis}聪` : '无续接输出'}`
					);
				}
			}

			currentSlots = nextSlots;
			if (currentSlots.length === 0 && layer < showcaseDepth) {
				console.log(`\n[展示] 所有链在第${layer}层后结束`);
				break;
			}
		}

		this.writer.close();

		// ---- 展示验收报告 ----
		console.log('\n' + '='.repeat(80));
		console.log('展示验收报告');
		console.log('='.repeat(80));
		console.log(`要求每种类型持续出现 ${showcaseDepth} 次（即每层均可生成）\n`);

		let allPassed = true;
		for (const s of SHOWCASE_SLOTS) {
			const count = perTypeCount[s.label];
			const pass = count >= showcaseDepth;
			if (!pass) allPassed = false;
			const bar = '█'.repeat(count);
			console.log(`  [${pass ? '✓' : '✗'}] ${s.label.padEnd(30)} ${bar.padEnd(showcaseDepth)} ${count}/${showcaseDepth}`);
		}

		console.log('\n' + (allPassed
			? '✓ 全部种类通过持续性验证——交易集合覆盖完整，非偶然生成'
			: '✗ 部分种类未能持续生成，请检查 SDK 兼容性'
		));
		console.log('='.repeat(80));

		this.saveResults();
		return this.graph;
	}

	async buildTransaction(inputs, depth) {
		// 收集完整UTXO信息（enrichedInputs 含 owner 与 script，供 SDK 与 P2PKH 共用）
		const enrichedInputs = inputs.map((input) => {
			const fullUtxo = this.graph.utxos.get(`${input.txId}:${input.outputIndex}`);
			return {
				txId: input.txId,
				outputIndex: input.outputIndex,
				satoshis: fullUtxo.satoshis,
				ownerAddress: fullUtxo.ownerAddress,
				script: this.addressPool.getScriptForAddress(fullUtxo.ownerAddress),
			};
		});

		const result = await this.txBuilder.build(enrichedInputs, depth);
		if (!result || !result.rawTxs || result.rawTxs.length === 0) {
			return null;
		}

		const t0 = process.hrtime.bigint();
		const ret = this.recordResult(result, depth);
		if (this._graphNs) this._graphNs.record += process.hrtime.bigint() - t0;
		return ret;
	}

	// 将 build 结果（一个或多个 rawTx）写入 graph 与 transactions.txt
	// 链式 SDK txs 按实际依赖关系计算 depth；最后一条作为返回值
	recordResult(result, baseDepth) {
		// 标记本次实际消耗的输入
		for (const inp of result.consumedInputs) {
			this.graph.spendUtxo(inp.txId, inp.outputIndex);
		}
		// 批次内部中间 UTXO（如 ftSource.vout[2] 被同批 poolSource 消耗）
		if (result.consumedIntermediateUtxos) {
			for (const u of result.consumedIntermediateUtxos) {
				this.graph.spendUtxo(u.txId, u.outputIndex);
			}
		}

		const parentTxId = result.consumedInputs[0]?.txId || null;
		let lastInfo = null;

		// ===== 修正：根据实际依赖关系计算每个 rawTx 的 depth =====
		// 链式 SDK txs 的依赖关系不一定是线性的（如 poolSource 依赖 ftSource，不是 ftMint）
		// 必须从 graph.utxos 或同批已处理的 rawTx 中查找父 depth
		const rawTxDepths = [];
		for (let i = 0; i < result.rawTxs.length; i++) {
			const rt = result.rawTxs[i];
			let maxParentDepth = 0;

			if (i === 0) {
				// 第一个 rawTx：使用 consumedInputs 在 graph 中的 depth
				for (const inp of result.consumedInputs) {
					const utxoKey = `${inp.txId}:${inp.outputIndex}`;
					const utxo = this.graph.utxos.get(utxoKey);
					if (utxo) {
						maxParentDepth = Math.max(maxParentDepth, utxo.depth || 0);
					}
				}
			} else {
				// 链式 rawTx：使用 chainedFromIndex 引用的父 rawTx 的 depth
				const link = rt.chainedFromIndex || { srcRawIdx: i - 1, srcVout: 0 };
				const parentDepth = rawTxDepths[link.srcRawIdx];
				if (parentDepth !== undefined) {
					maxParentDepth = parentDepth;
				}
			}

			rawTxDepths.push(maxParentDepth + 1);
		}
		// =========================================================

		for (let i = 0; i < result.rawTxs.length; i++) {
			const rt = result.rawTxs[i];
			const txDepth = rawTxDepths[i]; // 使用实际依赖计算的 depth

			let inputsForGraph;
			if (i === 0) {
				inputsForGraph = result.consumedInputs.map((inp) => ({
					txId: inp.txId,
					outputIndex: inp.outputIndex,
					ownerAddress: inp.ownerAddress,
				}));
			} else {
				const link = rt.chainedFromIndex || { srcRawIdx: i - 1, srcVout: 0 };
				const srcTx = result.rawTxs[link.srcRawIdx];
				inputsForGraph = [{
					txId: srcTx.txId,
					outputIndex: link.srcVout,
					ownerAddress: result.consumedInputs[0]?.ownerAddress || null,
				}];
			}

			const outputDescriptors = rt.outputs.map((o) => ({
				address: o.address,
				type: o.type,
			}));
			this.graph.addTransaction(
				rt.txId,
				inputsForGraph,
				outputDescriptors,
				txDepth,
				rt.fee,
				result.txType,
			);

			// 仅可消费输出注册为 UTXO；非 P2PKH/含 OP_RETURN 的输出仍在 graph 节点的 outputs 列表中
			for (const o of rt.outputs) {
				if (o.consumable && o.address) {
					this.graph.addUtxo(
						rt.txId,
						o.vout,
						o.satoshis,
						o.address,
						txDepth,
						parentTxId,
						'p2pkh',
					);
				}
			}

			this.writer.addTransaction(rt.raw);
			lastInfo = { txId: rt.txId, serialized: rt.raw, txType: result.txType };
		}

		// 预留消费：builder 通过 _nextUtxo 显式告知"这条 P2PKH change 留给自己后续阶段消费"
		// 必须立即在 graph 中标 spent，否则跨迭代时 getUtxosForNewTx 会把它当成可用 UTXO 随机选给其它 tx，
		// 造成同一 UTXO 被两条路径同时引用（pool_nft Phase 2/3 与无关 tx 竞争同一个 nextUtxo）
		if (result._nextUtxo && result._nextUtxo.txId !== undefined && result._nextUtxo.outputIndex !== undefined) {
			this.graph.spendUtxo(result._nextUtxo.txId, result._nextUtxo.outputIndex);
		}

		return lastInfo;
	}

	_printWidthDiagnostics(depthTxCount, widthSamples, totalTx) {
		if (depthTxCount.size === 0) return;

		const depths = Array.from(depthTxCount.keys()).sort((a, b) => a - b);
		const txCounts = depths.map((d) => depthTxCount.get(d));
		const maxWidth = Math.max(...txCounts);
		const avgWidth = (txCounts.reduce((s, v) => s + v, 0) / txCounts.length).toFixed(2);
		const maxDepth = Math.max(...depths);
		const ratio = (totalTx / maxDepth).toFixed(2);

		console.log('\n' + '='.repeat(60));
		console.log('网状结构宽度诊断');
		console.log('='.repeat(60));
		console.log(`总交易数:     ${totalTx}`);
		console.log(`最大深度:     ${maxDepth}`);
		console.log(`txs/depth比:  ${ratio}`);
		console.log(`每层平均宽度: ${avgWidth}`);
		console.log(`每层最大宽度: ${maxWidth}`);

		// 宽度分布直方图
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
			const pct = ((count / depths.length) * 100).toFixed(1);
			const bar = '█'.repeat(Math.round((count / depths.length) * 30));
			console.log(`  ${range.padEnd(7)} ${bar.padEnd(30)} ${count} 层 (${pct}%)`);
		}

		// 类型分布诊断
		const typeStats = this.graph.stats.byType;
		console.log('\n交易类型分布:');
		for (const [type, count] of Object.entries(typeStats)) {
			const pct = totalTx > 0 ? ((count / totalTx) * 100).toFixed(1) : '0.0';
			const bar = '█'.repeat(Math.round((count / totalTx) * 30));
			console.log(`  ${type.padEnd(18)} ${bar.padEnd(30)} ${count} (${pct}%)`);
		}

		// 输入输出分布
		console.log('\n输入数量分布:');
		for (const [count, num] of this.graph.stats.inputCounts) {
			const pct = ((num / totalTx) * 100).toFixed(1);
			console.log(`  ${count}输入: ${num} (${pct}%)`);
		}
		console.log('\n输出数量分布:');
		for (const [count, num] of this.graph.stats.outputCounts) {
			const pct = ((num / totalTx) * 100).toFixed(1);
			console.log(`  ${count}输出: ${num} (${pct}%)`);
		}

		if (parseFloat(ratio) < 5) {
			console.log('\n[诊断] ⚠ txs/depth 比值过低');
		} else {
			console.log('\n[诊断] ✓ 网状结构宽度正常');
		}
		console.log('='.repeat(60) + '\n');
	}

	saveResults() {
		console.log('\n' + '='.repeat(80));
		console.log('保存结果');
		console.log('='.repeat(80));

		const summary = {
			totalTransactions: this.graph.stats.totalTx,
			maxDepthReached: this.graph.stats.maxDepth,
			mergeTransactions: this.graph.stats.mergeCount,
			splitTransactions: this.graph.stats.splitCount,
			unspentUtxos: this.graph.getUnspentUtxos().length,
			byType: { ...this.graph.stats.byType },
			txsPerDepthRatio:
				this.graph.stats.maxDepth > 0
					? (this.graph.stats.totalTx / this.graph.stats.maxDepth).toFixed(2)
					: '0.00',
		};

		// 1. 统计信息
		const summaryPath = path.join(this.config.outputDir, 'summary.txt');
		let content = '混合类型 Mesh 构建统计\n';
		content += '='.repeat(80) + '\n';
		content += `总交易数:        ${summary.totalTransactions}\n`;
		content += `最大祖先高度:    ${summary.maxDepthReached}\n`;
		content += `txs/depth 比值:  ${summary.txsPerDepthRatio}\n`;
		content += `多输入交易:      ${summary.mergeTransactions}\n`;
		content += `多输出交易:      ${summary.splitTransactions}\n`;
		content += `未花费UTXO:      ${summary.unspentUtxos}\n`;
		content += `随机种子:        ${this.rng.initialSeed}\n`;
		content += '\n交易类型分布:\n';
		for (const [type, count] of Object.entries(summary.byType)) {
			const pct =
				summary.totalTransactions > 0
					? ((count / summary.totalTransactions) * 100).toFixed(1)
					: '0.0';
			content += `  ${type.padEnd(18)} ${String(count).padStart(6)} (${pct}%)\n`;
		}
		content += '='.repeat(80) + '\n';
		fs.writeFileSync(summaryPath, content);
		console.log(`[保存] 统计: ${summaryPath}`);

		// 2. 树形结构
		const treePath = path.join(this.config.outputDir, 'tree.txt');
		fs.writeFileSync(treePath, this.graph.printTree(20));
		console.log(`[保存] 树形结构: ${treePath}`);

		// 3. 完整图数据（含类型信息）
		const jsonPath = path.join(this.config.outputDir, 'graph.json');
		const allNodes = Array.from(this.graph.nodes.entries()).map(([id, node]) => ({
			txId: id,
			depth: node.depth,
			txType: node.txType,
			inputCount: node.inputCount,
			outputCount: node.outputCount,
			parentIds: Array.from(node.parentIds).filter((pid) => pid !== null),
		}));

		// 按层统计
		const layerStats = [];
		for (const [depth, stat] of this.graph.stats.byLayer) {
			layerStats.push({ depth, ...stat });
		}
		layerStats.sort((a, b) => a.depth - b.depth);

		const jsonData = {
			config: {
				targetMaxDepth: this.config.targetMaxDepth,
				addressPoolSize: this.config.addressPoolSize,
				randomSeed: this.rng.initialSeed,
				typeWeights: this.config.typeWeights,
			},
			summary,
			addresses: this.addressPool.addresses,
			nodes: allNodes,
			layerStats,
			inputDistribution: Object.fromEntries(this.graph.stats.inputCounts),
			outputDistribution: Object.fromEntries(this.graph.stats.outputCounts),
		};

		fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
		console.log(`[保存] JSON数据: ${jsonPath} (包含 ${allNodes.length} 个节点)`);

		// 打印最终统计
		console.log('\n' + '='.repeat(80));
		console.log('构建统计');
		console.log('='.repeat(80));
		console.log(`总交易数:     ${summary.totalTransactions}`);
		console.log(`最大深度:     ${summary.maxDepthReached}`);
		console.log(`txs/depth:    ${summary.txsPerDepthRatio}`);
		console.log(`合并交易:     ${summary.mergeTransactions} (${((summary.mergeTransactions / summary.totalTransactions) * 100).toFixed(1)}%)`);
		console.log(`分割交易:     ${summary.splitTransactions} (${((summary.splitTransactions / summary.totalTransactions) * 100).toFixed(1)}%)`);
		console.log(`未花费UTXO:   ${summary.unspentUtxos}`);
		console.log('\n类型分布:');
		for (const [type, count] of Object.entries(summary.byType)) {
			const pct = summary.totalTransactions > 0 ? ((count / summary.totalTransactions) * 100).toFixed(1) : '0.0';
			console.log(`  ${type.padEnd(18)} ${String(count).padStart(6)} (${pct}%)`);
		}
		console.log('='.repeat(80));
	}
}

// ==================== 主函数 ====================

async function main() {
	try {
		const builder = new AllTypesMeshBuilder(CONFIG);

		if (argv.showcase) {
			await builder.buildShowcase();
			console.log('\n[完成] 展示模式完成！');
		} else {
			await builder.buildMesh();
			console.log('\n[完成] 构建成功！');
		}

		console.log(`输出目录: ${path.resolve(CONFIG.outputDir)}`);
	} catch (error) {
		console.error('\n[错误]', error.message);
		console.error(error.stack);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('未捕获的错误:', err);
	process.exit(1);
});
