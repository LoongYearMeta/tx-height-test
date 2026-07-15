#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, fork } = require('child_process');
const readline = require('readline');
const minimist = require('minimist');
const axios = require('axios');
const tbc = require('tbc-lib-js');
const Transaction = require('tbc-lib-js/lib/transaction/transaction');
const Script = require('tbc-lib-js/lib/script');
const { FT, buildUTXO, buildFtPrePreTxData } = require('tbc-contract');

const argv = minimist(process.argv.slice(2), {
  string: [
    'privkey', 'txid', 'vout', 'satoshis', 'script', 'to', 'name', 'symbol',
    'outputdir', 'cli', 'conf', 'target-bytes', 'target-mb', 'target-gb',
    'random-min-mb', 'random-max-mb', 'seed', 'rpc-url', 'rpc-user', 'rpc-pass',
    'worker-suffix',
  ],
  boolean: ['broadcast', 'latest-coinbase', 'write-local-txs', 'random-target', 'bundle-worker', 'help'],
  alias: {
    g: 'groups',
    x: 'per-group',
    k: 'privkey',
    o: 'outputdir',
  },
  default: {
    groups: 4,
    'per-group': 10,
    'ft-amount': 1,
    decimal: 6,
    name: 'FTONLY',
    symbol: 'FTO',
    outputdir: path.join(__dirname, 'ftonly_output'),
    cli: '/home/nemo/TBCNODE/bin/bitcoin-cli',
    conf: '/home/nemo/TBCNODE/node.main.conf',
    to: '1Nykpv2CofTzpE1knswfVtLgrHFnHavsK7',
    'max-ft-count': 0,
    'fee-per-kb': 150,
    'construction-workers': 1,
    'broadcast-batch-size': 1,
    'broadcast-delay-ms': 250,
    'random-target': true,
    'random-min-mb': 100,
    'random-max-mb': 10000,
  },
});

if (argv.help) {
  console.log(`Usage:
  node genGroupsFtChains-ftonly.js --privkey <WIF> --txid <TXID> --vout <N> --satoshis <SAT> [options]

Options:
  --groups, -g <N>          group count, default 4
  --per-group, -x <N>       transfer count per group, default 10
  --ft-amount <N>           FT amount per transfer, default 1
  --decimal <N>             FT decimal for newly created token, default 6
  --to <ADDRESS>            FT receiver for group transfers
  --broadcast               broadcast generated txs with local RPC CLI
  --broadcast-batch-size N  use sendrawtransactions batches when N > 1
  --broadcast-delay-ms N    delay between broadcast RPC calls, default 250
  --latest-coinbase         use latest block coinbase vout 1 as initial UTXO
  --target-mb <N>           auto-create enough FT bundles to approach N MB
  --target-gb <N>           auto-create enough FT bundles to approach N GB
  --random-target           randomly choose target size, default on
  --no-random-target        disable random target; generate one FT bundle unless fixed target is set
  --random-min-mb <N>       random target lower bound, default 100
  --random-max-mb <N>       random target upper bound, default 10000
  --seed <TEXT>             deterministic random target seed
  --max-ft-count <N>        optional hard cap for auto-created FT bundles
  --fee-per-kb <SAT>        construction fee rate in sat/KB, default 150
  --construction-workers N  persistent bounded bundle workers, default 1
  --write-local-txs         write local txid/raw JSONL index; off by default
  --rpc-url <URL>           RPC HTTP URL, preferred over bitcoin-cli when provided
  --rpc-user <USER>         RPC username for --rpc-url
  --rpc-pass <PASS>         RPC password for --rpc-url
  --cli <PATH>              bitcoin-cli path, default /home/nemo/TBCNODE/bin/bitcoin-cli
  --conf <PATH>             node conf path, default /home/nemo/TBCNODE/node.main.conf
`);
  process.exit(0);
}

const privateKey = tbc.PrivateKey.fromString(required('privkey'));
const addressA = tbc.Address.fromPrivateKey(privateKey).toString();
const addressB = argv.to;
const N_GROUPS = positiveInt(argv.groups, 'groups');
const X_PER_GROUP = positiveInt(argv['per-group'], 'per-group');
const FT_AMOUNT = positiveNumber(argv['ft-amount'], 'ft-amount');
const DECIMAL = decimalInt(argv.decimal, 'decimal');
const OUTPUT_DIR = path.resolve(argv.outputdir);
const PREPARE_FILE = path.join(OUTPUT_DIR, 'ft_prepare.txt');
const GROUP_FILE = (i) => path.join(OUTPUT_DIR, `ft_group_${i}.txt`);
const TX_MAP_FILE = path.join(OUTPUT_DIR, 'local_txs.json');
const TX_MAP_JSONL_FILE = path.join(OUTPUT_DIR, 'local_txs.jsonl');
const META_FILE = path.join(OUTPUT_DIR, 'metadata.json');
const WORKER_SUFFIX = argv['worker-suffix'] ? `.${argv['worker-suffix']}` : '';
const ACTIVE_PREPARE_FILE = WORKER_SUFFIX ? `${PREPARE_FILE}${WORKER_SUFFIX}` : PREPARE_FILE;
const ACTIVE_GROUP_FILE = (i) => WORKER_SUFFIX ? `${GROUP_FILE(i)}${WORKER_SUFFIX}` : GROUP_FILE(i);
const ACTIVE_TX_MAP_FILE = WORKER_SUFFIX ? `${TX_MAP_JSONL_FILE}${WORKER_SUFFIX}` : TX_MAP_JSONL_FILE;

const EST_TX_BYTES = 5500;
const FEE_PER_KB = positiveNumber(argv['fee-per-kb'], 'fee-per-kb');
const FEE_SAFETY = 1.3;
const DUST_PER_TX = 500;
const PREPARE_FT_AMOUNT = X_PER_GROUP * FT_AMOUNT + 1;
const MINT_FT_AMOUNT = N_GROUPS * PREPARE_FT_AMOUNT;
const FEE_PER_GROUP_SAT = Math.ceil(
  ((X_PER_GROUP * EST_TX_BYTES * FEE_PER_KB) / 1000 + X_PER_GROUP * DUST_PER_TX) * FEE_SAFETY
);
const PREPARE_CHAIN_RESERVE_SAT = Math.ceil(
  ((N_GROUPS * EST_TX_BYTES * FEE_PER_KB) / 1000 + N_GROUPS * DUST_PER_TX) * FEE_SAFETY
);
const MIN_INITIAL_SAT = 50000 + N_GROUPS * FEE_PER_GROUP_SAT + PREPARE_CHAIN_RESERVE_SAT;
const BUNDLE_EST_TX_COUNT = 2 + N_GROUPS + N_GROUPS * X_PER_GROUP;
const BUNDLE_EST_BYTES = 12000 + (N_GROUPS + N_GROUPS * X_PER_GROUP) * EST_TX_BYTES;
const TARGET_BYTES = parseTargetBytes();
const MAX_FT_COUNT = Number(argv['max-ft-count']) || 0;
const BROADCAST_BATCH_SIZE = positiveInt(argv['broadcast-batch-size'], 'broadcast-batch-size');
const BROADCAST_DELAY_MS = nonNegativeNumber(argv['broadcast-delay-ms'], 'broadcast-delay-ms');
const MAX_FANOUT_OUTPUTS = 500;
const CONSTRUCTION_WORKERS = positiveInt(argv['construction-workers'], 'construction-workers');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const entrypoint = argv['bundle-worker'] ? workerMain() : main();
entrypoint.catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});

async function main() {
  resetOutputFiles();

  const initialUtxo = await getInitialUtxo();
  const requestedFtCount = getRequestedFtCount();
  const cappedByUser = MAX_FT_COUNT > 0 ? Math.min(requestedFtCount, MAX_FT_COUNT) : requestedFtCount;
  const fundedFtCount = maxFundedFtCount(initialUtxo.satoshis, cappedByUser);
  if (fundedFtCount < 1) throw new Error(`初始 UTXO 余额不足: ${initialUtxo.satoshis} sat, 单个 FT bundle 建议至少 ${MIN_INITIAL_SAT} sat`);

  const ftCount = fundedFtCount;
  const roots = ftCount === 1 ? { utxos: [initialUtxo], splitRaws: [] } : createFundingFanout(initialUtxo, ftCount);
  const counters = { prepare: 0, group: 0, bytes: 0 };

  console.log(`地址:         ${addressA}`);
  console.log(`接收地址:     ${addressB}`);
  console.log(`FT 个数:      ${ftCount}${ftCount < requestedFtCount ? ` (资金/上限限制，目标 ${requestedFtCount})` : ''}`);
  console.log(`组数 N:       ${N_GROUPS}`);
  console.log(`每组笔数 X:   ${X_PER_GROUP}`);
  console.log(`单 FT 总量:   ${MINT_FT_AMOUNT} (decimal=${DECIMAL})`);
  console.log(`每组 fee:     ${FEE_PER_GROUP_SAT} sat`);
  console.log(`单 FT 估算:   ${BUNDLE_EST_TX_COUNT} tx, ${(BUNDLE_EST_BYTES / 1024 / 1024).toFixed(2)} MB, ${MIN_INITIAL_SAT} sat`);
  if (TARGET_BYTES) console.log(`目标体积:     ${(TARGET_BYTES / 1024 / 1024).toFixed(2)} MB`);
  console.log(`输出目录:     ${OUTPUT_DIR}\n`);

  for (const raw of roots.splitRaws) writeRaw(PREPARE_FILE, raw, counters, 'prepare');

  const contracts = await generateBundles(roots.utxos, counters);

  fs.writeFileSync(META_FILE, JSON.stringify({
    addressA,
    addressB,
    ftCount,
    requestedFtCount,
    targetBytes: TARGET_BYTES || null,
    randomTarget: !argv['target-bytes'] && !argv['target-mb'] && !argv['target-gb'] && !!argv['random-target'],
    randomRangeMb: argv['random-target'] ? {
      min: Number(argv['random-min-mb']),
      max: Number(argv['random-max-mb']),
    } : null,
    seed: argv.seed || null,
    estimatedBundleBytes: BUNDLE_EST_BYTES,
    estimatedTotalBytes: BUNDLE_EST_BYTES * ftCount + fanoutBytes(ftCount),
    actualRawBytes: counters.bytes,
    contracts,
    groups: N_GROUPS,
    perGroup: X_PER_GROUP,
    ftAmount: FT_AMOUNT,
    prepareFtAmount: PREPARE_FT_AMOUNT,
    feePerGroupSat: FEE_PER_GROUP_SAT,
    feePerKbSat: FEE_PER_KB,
    files: {
      prepare: PREPARE_FILE,
      groups: Array.from({ length: N_GROUPS }, (_, i) => GROUP_FILE(i)),
      localTxs: argv['write-local-txs'] ? TX_MAP_JSONL_FILE : null,
    },
  }, null, 2));

  console.log(`prepare txs:  ${counters.prepare} -> ${PREPARE_FILE}`);
  console.log(`group txs:    ${counters.group}`);
  console.log(`raw size:     ${(counters.bytes / 1024 / 1024).toFixed(2)} MB`);

  if (argv.broadcast) {
    console.log('\n开始广播 prepare...');
    await broadcastFile(PREPARE_FILE);
    for (let i = 0; i < N_GROUPS; i++) {
      console.log(`开始广播 group ${i}...`);
      await broadcastFile(GROUP_FILE(i));
    }
    console.log('广播完成');
  }
}

async function workerMain() {
  resetWorkerFiles();
  // 父生成器退出或被 watchdog 终止时，worker 必须立即退出，不能成为孤儿进程。
  process.once('disconnect', () => process.exit(1));
  process.on('message', (message) => {
    if (message?.type === 'stop') process.exit(0);
    if (message?.type !== 'bundle') return;
    try {
      const counters = { prepare: 0, group: 0, bytes: 0 };
      const result = generateFtBundle(message.index, message.utxo, counters);
      process.send({ type: 'done', index: message.index, result, counters });
    } catch (error) {
      process.send({ type: 'error', index: message.index, error: error.stack || error.message });
    }
  });
  await new Promise(() => {});
}

async function generateBundles(utxos, counters) {
  const workerCount = Math.min(CONSTRUCTION_WORKERS, utxos.length);
  if (workerCount <= 1) {
    const contracts = [];
    for (let i = 0; i < utxos.length; i++) {
      contracts.push(generateFtBundle(i, utxos[i], counters));
      printGenerationProgress(i + 1, utxos.length, counters.bytes);
    }
    return contracts;
  }

  const contracts = new Array(utxos.length);
  let nextIndex = 0;
  let completed = 0;
  const workers = Array.from({ length: workerCount }, (_, slot) => createBundleWorker(slot));
  try {
    await Promise.all(workers.map(async (worker) => {
      while (nextIndex < utxos.length) {
        const index = nextIndex++;
        const message = await runWorkerBundle(worker.child, index, utxos[index]);
        contracts[index] = message.result;
        counters.prepare += message.counters.prepare;
        counters.group += message.counters.group;
        counters.bytes += message.counters.bytes;
        completed++;
        printGenerationProgress(completed, utxos.length, counters.bytes);
      }
    }));
  } finally {
    for (const worker of workers) {
      if (worker.child.connected) worker.child.send({ type: 'stop' });
    }
    await Promise.all(workers.map((worker) => waitForExit(worker.child)));
  }

  for (const worker of workers) {
    await appendFile(ACTIVE_PREPARE_FILE, worker.prepareFile);
    for (let group = 0; group < N_GROUPS; group++) {
      await appendFile(ACTIVE_GROUP_FILE(group), worker.groupFiles[group]);
    }
    if (argv['write-local-txs']) await appendFile(ACTIVE_TX_MAP_FILE, worker.txMapFile);
    removeWorkerFiles(worker);
  }
  return contracts;
}

function createBundleWorker(slot) {
  const suffix = `worker-${process.pid}-${slot}`;
  const args = [...process.argv.slice(2), '--bundle-worker', '--worker-suffix', suffix];
  const child = fork(__filename, args, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  return {
    child,
    prepareFile: `${PREPARE_FILE}.${suffix}`,
    groupFiles: Array.from({ length: N_GROUPS }, (_, i) => `${GROUP_FILE(i)}.${suffix}`),
    txMapFile: `${TX_MAP_JSONL_FILE}.${suffix}`,
  };
}

function runWorkerBundle(child, index, utxo) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.index !== index) return;
      cleanup();
      if (message.type === 'done') resolve(message);
      else reject(new Error(`bundle worker ${index}: ${message.error || 'unknown error'}`));
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`bundle worker exited index=${index} code=${code} signal=${signal || ''}`));
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.send({ type: 'bundle', index, utxo });
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

function printGenerationProgress(done, total, bytes) {
  if (done % 25 === 0 || done === total) {
    console.log(`生成进度: ${done}/${total} FT bundles, raw ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  }
}

function appendFile(target, source) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(source);
    const output = fs.createWriteStream(target, { flags: 'a' });
    input.once('error', reject);
    output.once('error', reject);
    output.once('finish', resolve);
    input.pipe(output);
  });
}

function resetWorkerFiles() {
  fs.writeFileSync(ACTIVE_PREPARE_FILE, '');
  for (let i = 0; i < N_GROUPS; i++) fs.writeFileSync(ACTIVE_GROUP_FILE(i), '');
  if (argv['write-local-txs']) fs.writeFileSync(ACTIVE_TX_MAP_FILE, '');
}

function removeWorkerFiles(worker) {
  for (const file of [worker.prepareFile, ...worker.groupFiles, ...(argv['write-local-txs'] ? [worker.txMapFile] : [])]) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

function generateFtBundle(index, initialUtxo, counters) {
  const localTxMap = new Map();
  const suffix = index === 0 ? '' : String(index);
  const ft = new FT({
    name: `${argv.name}${suffix}`,
    symbol: `${argv.symbol}${suffix}`,
    amount: MINT_FT_AMOUNT,
    decimal: DECIMAL,
  });

  const mintRaws = ft.MintFT(privateKey, addressA, initialUtxo);
  const txSource = rememberRaw(mintRaws[0], localTxMap);
  const txMint = rememberRaw(mintRaws[1], localTxMap);
  writeRaw(ACTIVE_PREPARE_FILE, mintRaws[0], counters, 'prepare', txSource.hash);
  writeRaw(ACTIVE_PREPARE_FILE, mintRaws[1], counters, 'prepare', txMint.hash);

  let currentFt = {
    utxo: buildUTXO(txMint, 0, true),
    preTX: txMint,
    preTxVout: 0,
    prePreTX: txSource,
  };
  let prepareFeeUtxo = p2pkhUtxo(txSource, 2);
  const groupStates = [];

  for (let i = 0; i < N_GROUPS; i++) {
    const prepre = buildFtPrePreTxData(currentFt.preTX, currentFt.preTxVout, [currentFt.prePreTX]);
    const raw = ft.transfer(
      privateKey,
      addressA,
      PREPARE_FT_AMOUNT,
      [currentFt.utxo],
      prepareFeeUtxo,
      [currentFt.preTX],
      [prepre],
      satToTbc(FEE_PER_GROUP_SAT)
    );
    const tx = rememberRaw(raw, localTxMap);
    writeRaw(ACTIVE_PREPARE_FILE, raw, counters, 'prepare', tx.hash);

    groupStates.push({
      ft: {
        utxo: buildUTXO(tx, 0, true),
        preTX: tx,
        preTxVout: 0,
        prePreTX: currentFt.preTX,
      },
      feeUtxo: p2pkhUtxo(tx, 2),
    });

    if (i < N_GROUPS - 1) {
      currentFt = {
        utxo: buildUTXO(tx, 3, true),
        preTX: tx,
        preTxVout: 3,
        prePreTX: currentFt.preTX,
      };
      prepareFeeUtxo = lastP2pkhUtxo(tx);
    }
  }

  for (let g = 0; g < N_GROUPS; g++) {
    let state = groupStates[g].ft;
    let feeUtxo = groupStates[g].feeUtxo;

    for (let j = 0; j < X_PER_GROUP; j++) {
      const prepre = buildFtPrePreTxData(state.preTX, state.preTxVout, [state.prePreTX]);
      const raw = ft.transfer(
        privateKey,
        addressB,
        FT_AMOUNT,
        [state.utxo],
        feeUtxo,
        [state.preTX],
        [prepre]
      );
      const tx = rememberRaw(raw, localTxMap);
      writeRaw(ACTIVE_GROUP_FILE(g), raw, counters, 'group', tx.hash);

      state = {
        utxo: buildUTXO(tx, 2, true),
        preTX: tx,
        preTxVout: 2,
        prePreTX: state.preTX,
      };
      feeUtxo = lastP2pkhUtxo(tx);
    }
  }

  return {
    index,
    contractTxid: ft.contractTxid,
    name: ft.name,
    symbol: ft.symbol,
    decimal: ft.decimal,
    totalSupply: ft.totalSupply.toString(),
  };
}

async function getInitialUtxo() {
  let txid = argv.txid;
  let vout = argv.vout !== undefined ? Number(argv.vout) : undefined;
  let satoshis = argv.satoshis !== undefined ? Number(argv.satoshis) : undefined;
  let script = argv.script;

  if (argv['latest-coinbase']) {
    const blockHash = await rpcCall('getbestblockhash', []);
    const block = await rpcCall('getblock', [blockHash]);
    txid = block.tx[0];
    vout = 1;
  }

  if (!txid || vout === undefined || Number.isNaN(vout)) {
    throw new Error('需要 --txid 和 --vout，或使用 --latest-coinbase');
  }

  if (satoshis === undefined || Number.isNaN(satoshis)) {
    const raw = await rpcCall('getrawtransaction', [txid]);
    const decoded = await rpcCall('decoderawtransaction', [raw]);
    const out = decoded.vout[vout];
    if (!out) throw new Error(`RPC rawtx 中找不到 vout=${vout}`);
    satoshis = Math.round(Number(out.value) * 1e6);
    script = script || out.scriptPubKey.hex;
  }

  return {
    txId: txid,
    outputIndex: vout,
    script: script || Script.buildPublicKeyHashOut(addressA).toHex(),
    satoshis,
  };
}

function createFundingFanout(initialUtxo, count) {
  const fee = splitFeeSat(count);
  const needed = count * MIN_INITIAL_SAT + fee;
  if (initialUtxo.satoshis < needed) {
    throw new Error(`fanout 资金不足: need=${needed}, got=${initialUtxo.satoshis}`);
  }

  if (count <= MAX_FANOUT_OUTPUTS) {
    const tx = splitUtxo(initialUtxo, Array.from({ length: count }, () => MIN_INITIAL_SAT));
    return {
      splitRaws: [tx.uncheckedSerialize()],
      utxos: Array.from({ length: count }, (_, i) => p2pkhUtxo(tx, i)),
    };
  }

  const chunkSizes = [];
  for (let left = count; left > 0; left -= MAX_FANOUT_OUTPUTS) {
    chunkSizes.push(Math.min(MAX_FANOUT_OUTPUTS, left));
  }

  const chunkAmounts = chunkSizes.map((size) => size * MIN_INITIAL_SAT + splitFeeSat(size));
  const topTx = splitUtxo(initialUtxo, chunkAmounts);
  const splitRaws = [topTx.uncheckedSerialize()];
  const utxos = [];

  for (let i = 0; i < chunkSizes.length; i++) {
    const chunkInput = p2pkhUtxo(topTx, i);
    const chunkTx = splitUtxo(chunkInput, Array.from({ length: chunkSizes[i] }, () => MIN_INITIAL_SAT));
    splitRaws.push(chunkTx.uncheckedSerialize());
    for (let j = 0; j < chunkSizes[i]; j++) utxos.push(p2pkhUtxo(chunkTx, j));
  }

  return { splitRaws, utxos };
}

function splitUtxo(input, amounts) {
  const tx = new tbc.Transaction().from(input);
  const script = Script.buildPublicKeyHashOut(addressA);
  for (const satoshis of amounts) {
    tx.addOutput(new tbc.Transaction.Output({ script, satoshis }));
  }
  tx.fee(splitFeeForOutputs(amounts.length)).change(addressA).sign(privateKey).seal();
  return tx;
}

function getRequestedFtCount() {
  if (!TARGET_BYTES) return 1;
  return Math.max(1, Math.ceil(TARGET_BYTES / BUNDLE_EST_BYTES));
}

function maxFundedFtCount(satoshis, requested) {
  let lo = 0;
  let hi = requested;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    const need = mid * MIN_INITIAL_SAT + splitFeeSat(mid);
    if (need <= satoshis) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function splitFeeSat(count) {
  if (count <= 1) return 0;
  if (count <= MAX_FANOUT_OUTPUTS) return splitFeeForOutputs(count);
  let fee = splitFeeForOutputs(Math.ceil(count / MAX_FANOUT_OUTPUTS));
  for (let left = count; left > 0; left -= MAX_FANOUT_OUTPUTS) {
    fee += splitFeeForOutputs(Math.min(MAX_FANOUT_OUTPUTS, left));
  }
  return fee;
}

function splitFeeForOutputs(outputCount) {
  return Math.ceil(splitTxBytes(outputCount) * FEE_PER_KB / 1000);
}

function splitTxBytes(outputCount) {
  if (outputCount <= 0) return 0;
  return 180 + outputCount * 34 + 100;
}

function fanoutBytes(count) {
  if (count <= 1) return 0;
  if (count <= MAX_FANOUT_OUTPUTS) return splitTxBytes(count);
  let bytes = splitTxBytes(Math.ceil(count / MAX_FANOUT_OUTPUTS));
  for (let left = count; left > 0; left -= MAX_FANOUT_OUTPUTS) {
    bytes += splitTxBytes(Math.min(MAX_FANOUT_OUTPUTS, left));
  }
  return bytes;
}

function parseTargetBytes() {
  const provided = ['target-bytes', 'target-mb', 'target-gb'].filter((k) => argv[k] !== undefined);
  if (provided.length > 1) throw new Error('只能同时指定一个 target: --target-bytes / --target-mb / --target-gb');
  if (argv['target-bytes'] !== undefined) return positiveNumber(argv['target-bytes'], 'target-bytes');
  if (argv['target-mb'] !== undefined) return Math.ceil(positiveNumber(argv['target-mb'], 'target-mb') * 1024 * 1024);
  if (argv['target-gb'] !== undefined) return Math.ceil(positiveNumber(argv['target-gb'], 'target-gb') * 1024 * 1024 * 1024);
  if (argv['random-target']) {
    const minMb = positiveNumber(argv['random-min-mb'], 'random-min-mb');
    const maxMb = positiveNumber(argv['random-max-mb'], 'random-max-mb');
    if (maxMb < minMb) throw new Error('--random-max-mb 必须大于等于 --random-min-mb');
    const rng = createRng(argv.seed || `${Date.now()}-${process.pid}`);
    const targetMb = minMb + rng() * (maxMb - minMb);
    return Math.ceil(targetMb * 1024 * 1024);
  }
  return 0;
}

function createRng(seedText) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(seedText).length; i++) {
    h ^= String(seedText).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resetOutputFiles() {
  try {
    for (const name of fs.readdirSync(OUTPUT_DIR)) {
      if (/^(ft_prepare|ft_group_\d+|local_txs\.jsonl)\.txt\.worker-/.test(name) ||
          /^local_txs\.jsonl\.worker-/.test(name)) {
        fs.unlinkSync(path.join(OUTPUT_DIR, name));
      }
    }
  } catch (_) {}
  fs.writeFileSync(PREPARE_FILE, '');
  for (let i = 0; i < N_GROUPS; i++) fs.writeFileSync(GROUP_FILE(i), '');
  if (argv['write-local-txs']) fs.writeFileSync(TX_MAP_JSONL_FILE, '');
}

function writeRaw(file, raw, counters, kind, txId) {
  fs.appendFileSync(file, raw + '\n');
  counters.bytes += raw.length / 2;
  if (kind === 'prepare') counters.prepare++;
  if (kind === 'group') counters.group++;
  if (argv['write-local-txs']) {
    fs.appendFileSync(ACTIVE_TX_MAP_FILE, JSON.stringify({ txId: txId || new Transaction(raw).hash, raw }) + '\n');
  }
}

async function broadcastFile(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });

  let batch = [];
  let sent = 0;
  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;
    if (BROADCAST_BATCH_SIZE > 1) {
      batch.push(raw);
      if (batch.length >= BROADCAST_BATCH_SIZE) {
        await broadcastBatch(batch);
        sent += batch.length;
        batch = [];
        await delay(BROADCAST_DELAY_MS);
      }
    } else {
      await rpcCall('sendrawtransaction', [raw]);
      sent++;
      await delay(BROADCAST_DELAY_MS);
    }
    if (sent > 0 && sent % 1000 === 0) console.log(`  broadcasted ${sent} tx from ${path.basename(file)}`);
  }
  if (batch.length > 0) {
    await broadcastBatch(batch);
    sent += batch.length;
    await delay(BROADCAST_DELAY_MS);
  }
  console.log(`  ${path.basename(file)} done: ${sent} tx`);
}

async function broadcastBatch(batch) {
  if (batch.length === 1) await rpcCall('sendrawtransaction', [batch[0]]);
  else await rpcCall('sendrawtransactions', [
    batch.map((hex) => ({
      hex,
      allowhighfees: false,
      dontcheckfee: false,
    })),
  ]);
}

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rememberRaw(raw, localTxMap) {
  const tx = new Transaction(raw);
  localTxMap.set(tx.hash, tx);
  return tx;
}

function p2pkhUtxo(tx, outputIndex) {
  const out = tx.outputs[outputIndex];
  if (!out) throw new Error(`交易 ${tx.hash} 缺少 vout=${outputIndex}`);
  return {
    txId: tx.hash,
    outputIndex,
    script: out.script.toHex(),
    satoshis: out.satoshis,
  };
}

function lastP2pkhUtxo(tx) {
  for (let i = tx.outputs.length - 1; i >= 0; i--) {
    const out = tx.outputs[i];
    if (out.satoshis > 0 && out.script.isPublicKeyHashOut()) return p2pkhUtxo(tx, i);
  }
  throw new Error(`交易 ${tx.hash} 中找不到 P2PKH 找零输出`);
}

function rpcCli(method, params) {
  const args = [`-conf=${argv.conf}`, method, ...params.map((p) => (
    typeof p === 'string' ? p : JSON.stringify(p)
  ))];
  let out;
  try {
    out = execFileSync(argv.cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    const stdout = e.stdout ? e.stdout.toString().trim() : '';
    throw new Error(`RPC ${method} failed: ${stderr || stdout || e.message}`);
  }
  if (out === '') return null;
  try {
    return JSON.parse(out);
  } catch (_) {
    return out;
  }
}

async function rpcHttp(method, params) {
  try {
    const res = await axios.post(argv['rpc-url'], {
      jsonrpc: '1.0',
      id: 'ftonly-generator',
      method,
      params,
    }, {
      auth: {
        username: argv['rpc-user'] || '',
        password: argv['rpc-pass'] || '',
      },
      timeout: Math.min(300000, Math.max(30000, params.length * 100)),
    });
    if (res.data.error) throw new Error(JSON.stringify(res.data.error));
    return res.data.result;
  } catch (e) {
    if (e.response?.data?.error) {
      throw new Error(`RPC ${method} failed: ${JSON.stringify(e.response.data.error)}`);
    }
    throw new Error(`RPC ${method} failed: ${e.message}`);
  }
}

async function rpcCall(method, params) {
  if (argv['rpc-url']) return rpcHttp(method, params);
  return rpcCli(method, params);
}

function satToTbc(sats) {
  return (sats / 1e6).toFixed(6);
}

function required(name) {
  if (!argv[name]) throw new Error(`缺少 --${name}`);
  return argv[name];
}

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} 必须是正整数`);
  return n;
}

function decimalInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 18) throw new Error(`--${name} 必须是 1 到 18 的整数`);
  return n;
}

function positiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} 必须是正数`);
  return n;
}

function nonNegativeNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} 必须是非负数`);
  return n;
}
