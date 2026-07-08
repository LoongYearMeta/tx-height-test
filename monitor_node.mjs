#!/usr/bin/env node
/**
 * TBCNODE ZMQ 节点行为观测程序 (Node.js)
 *
 * 依赖: npm install zeromq
 *
 * 用法:
 *   node monitor_node.mjs
 *   node monitor_node.mjs --host 127.0.0.1 --port 28332
 *   node monitor_node.mjs --mode compact
 *   node monitor_node.mjs --mode verbose --log node.log
 *   node monitor_node.mjs --config config.json
 *   node monitor_node.mjs --all
 *
 * 配置文件示例 (config.json):
 * {
 *   "host": "127.0.0.1",
 *   "port": 28332,
 *   "topics": ["hashblock","hashtx","rawblock","rawtx"],
 *   "mode": "normal",
 *   "logFile": "node.log",
 *   "statsInterval": 60
 * }
 */

import { readFileSync, createWriteStream } from 'fs';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);
try { _require.resolve('zeromq'); } catch {
    console.error('\n缺少依赖包:\n\n  - zeromq\n\n请运行: npm install\n');
    process.exit(1);
}

const { Subscriber } = await import('zeromq');

// ─── 常量 ────────────────────────────────────────────────────────────────────

const ALL_TOPICS = [
  'hashblock', 'hashtx', 'rawblock', 'rawtx',
  'discardedfrommempool', 'removedfrommempoolblock',
  'hashblockincr', 'hashtxincr', 'rawblockincr', 'rawtxincr',
];

const HASH_TOPICS      = new Set(['hashblock', 'hashtx', 'hashblockincr', 'hashtxincr']);
const RAW_BLOCK_TOPICS = new Set(['rawblock', 'rawblockincr']);
const RAW_TX_TOPICS    = new Set(['rawtx', 'rawtxincr']);
const MEMPOOL_TOPICS   = new Set(['discardedfrommempool', 'removedfrommempoolblock']);

// ─── 颜色 ────────────────────────────────────────────────────────────────────

const C = {
  GREEN:   '\x1b[92m', YELLOW:  '\x1b[93m', RED:     '\x1b[91m',
  CYAN:    '\x1b[96m', MAGENTA: '\x1b[95m', BLUE:    '\x1b[94m',
  WHITE:   '\x1b[97m', DIM:     '\x1b[2m',  BOLD:    '\x1b[1m',
  RESET:   '\x1b[0m',
};

const TOPIC_COLOR = {
  hashblock: C.GREEN,   hashblockincr: C.GREEN,
  hashtx:    C.CYAN,    hashtxincr:    C.CYAN,
  rawblock:  C.YELLOW,  rawblockincr:  C.YELLOW,
  rawtx:     C.MAGENTA, rawtxincr:     C.MAGENTA,
  discardedfrommempool:    C.RED,
  removedfrommempoolblock: C.RED,
};

const TOPIC_ABBR = {
  hashblock:  'BLOCK ', hashblockincr: 'HBINCR',
  hashtx:     'TX    ', hashtxincr:    'HTINCR',
  rawblock:   'RBLOCK', rawblockincr:  'RBINCR',
  rawtx:      'RTX   ', rawtxincr:     'RTINCR',
  discardedfrommempool:    'MEMDSC',
  removedfrommempoolblock: 'MEMBLK',
};

const colored = (text, color) => `${color}${text}${C.RESET}`;

const tag = (topic) => {
  const abbr  = TOPIC_ABBR[topic] ?? topic.slice(0, 6).toUpperCase().padEnd(6);
  const color = TOPIC_COLOR[topic] ?? C.WHITE;
  return colored(`[${abbr}]`, C.BOLD + color);
};

// ─── 二进制解析工具 ──────────────────────────────────────────────────────────

function readVarint(buf, offset) {
  const b = buf[offset];
  if (b < 0xfd) return [b, 1];
  if (b === 0xfd) return [buf.readUInt16LE(offset + 1), 3];
  if (b === 0xfe) return [buf.readUInt32LE(offset + 1), 5];
  const lo = buf.readUInt32LE(offset + 1);
  const hi = buf.readUInt32LE(offset + 5);
  return [hi * 0x100000000 + lo, 9];
}

function parseBlockHeader(buf) {
  if (buf.length < 80) return null;
  const version  = buf.readInt32LE(0);
  const prevHash = Buffer.from(buf.slice(4, 36)).reverse().toString('hex');
  const merkle   = Buffer.from(buf.slice(36, 68)).reverse().toString('hex');
  const timestamp = buf.readUInt32LE(68);
  const bits     = buf.readUInt32LE(72);
  const nonce    = buf.readUInt32LE(76);
  const timeStr  = new Date(timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return { version, prevHash, merkle, timestamp, bits, nonce, timeStr };
}

function extractBlockHeight(buf) {
  try {
    let offset = 80;
    const [, n0] = readVarint(buf, offset);
    offset += n0;
    offset += 4;                          // tx version
    if (buf[offset] === 0x00) offset += 2; // segwit marker+flag
    const [, n1] = readVarint(buf, offset);
    offset += n1;
    offset += 36;                         // prevout
    const [, n2] = readVarint(buf, offset);
    offset += n2;
    const pushLen = buf[offset];
    if (pushLen >= 1 && pushLen <= 4) {
      let height = 0;
      for (let i = 0; i < pushLen; i++) height += buf[offset + 1 + i] * (256 ** i);
      return height;
    }
  } catch {}
  return null;
}

function countBlockTxs(buf) {
  try { return readVarint(buf, 80)[0]; } catch { return null; }
}

function parseTxBrief(buf) {
  try {
    let offset = 0;
    offset += 4; // version
    if (buf[offset] === 0x00) offset += 2; // segwit
    const [inCount, n0] = readVarint(buf, offset);
    offset += n0;
    for (let i = 0; i < inCount; i++) {
      offset += 36;
      const [slen, n] = readVarint(buf, offset);
      offset += n + slen + 4;
    }
    const [outCount, n1] = readVarint(buf, offset);
    offset += n1;
    let total = BigInt(0);
    for (let i = 0; i < outCount; i++) {
      const lo = buf.readUInt32LE(offset);
      const hi = buf.readInt32LE(offset + 4);
      total += BigInt(hi) * BigInt(0x100000000) + BigInt(lo);
      offset += 8;
      const [slen, n] = readVarint(buf, offset);
      offset += n + slen;
    }
    return [inCount, outCount, total];
  } catch {
    return [null, null, null];
  }
}

// ─── 格式化工具 ──────────────────────────────────────────────────────────────

const fmtBytes = (n) =>
  n < 1024 ? `${n}B`
  : n < 1048576 ? `${(n / 1024).toFixed(1)}KB`
  : `${(n / 1048576).toFixed(2)}MB`;

const fmtSats = (sats) => {
  if (sats === null) return '?';
  const btc = Number(sats) / 1e8;
  return btc >= 1 ? `${btc.toFixed(4)} BTC` : `${Number(sats).toLocaleString()} sat`;
};

const fmtDuration = (s) => {
  if (s < 60)   return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

const nowStr = () => {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
};

// ─── 统计跟踪 ────────────────────────────────────────────────────────────────

class Stats {
  constructor(txWindow = 300) {
    this.startTime       = Date.now();
    this.counts          = {};
    this.seqLast         = {};
    this.seqGaps         = {};
    this.blockTimes      = [];
    this.txTimes         = [];
    this.txWindow        = txWindow;
    this.lastBlockHeight = null;
    this.lastBlockTime   = null;
  }

  record(topic, seq) {
    this.counts[topic] = (this.counts[topic] ?? 0) + 1;
    if (seq >= 0) {
      const last = this.seqLast[topic];
      if (last !== undefined && seq !== last + 1 && seq > last + 1) {
        this.seqGaps[topic] = (this.seqGaps[topic] ?? 0) + (seq - last - 1);
      }
      this.seqLast[topic] = seq;
    }
  }

  recordBlock(height) {
    const now = Date.now();
    this.blockTimes.push(now);
    if (this.blockTimes.length > 20) this.blockTimes.shift();
    if (height !== null) this.lastBlockHeight = height;
    this.lastBlockTime = now;
  }

  recordTx() {
    this.txTimes.push(Date.now());
    if (this.txTimes.length > 2000) this.txTimes.shift();
  }

  txRate() {
    const now    = Date.now();
    const cutoff = now - this.txWindow * 1000;
    const recent = this.txTimes.filter(t => t > cutoff).length;
    const elapsed = Math.min((now - this.startTime) / 1000, this.txWindow);
    return elapsed < 1 ? 0 : recent / elapsed;
  }

  avgBlockInterval() {
    if (this.blockTimes.length < 2) return null;
    let sum = 0;
    for (let i = 1; i < this.blockTimes.length; i++)
      sum += (this.blockTimes[i] - this.blockTimes[i - 1]) / 1000;
    return sum / (this.blockTimes.length - 1);
  }

  summaryLine() {
    const uptime   = fmtDuration((Date.now() - this.startTime) / 1000);
    const bCount   = Math.max(this.counts['hashblock'] ?? 0, this.counts['rawblock'] ?? 0);
    const tCount   = Math.max(this.counts['hashtx']    ?? 0, this.counts['rawtx']    ?? 0);
    const avgIv    = this.avgBlockInterval();
    const ivStr    = avgIv !== null ? fmtDuration(avgIv) : '-';
    const rateStr  = `${this.txRate().toFixed(1)}/s`;
    const agoRaw   = this.lastBlockTime ? (Date.now() - this.lastBlockTime) / 1000 : null;
    const agoStr   = agoRaw !== null ? fmtDuration(agoRaw) + ' ago' : '-';
    const heightStr = this.lastBlockHeight !== null
      ? `  高度:${colored(String(this.lastBlockHeight), C.BOLD + C.GREEN)}`
      : '';
    const totalGaps = Object.values(this.seqGaps).reduce((a, b) => a + b, 0);
    const gapStr   = totalGaps ? colored(`  ⚠ 序列缺口:${totalGaps}`, C.RED) : '';
    const total    = Object.values(this.counts).reduce((a, b) => a + b, 0);
    return (
      `${colored('───', C.DIM)} 统计 运行:${colored(uptime, C.BOLD)} ` +
      `区块:${colored(String(bCount), C.BOLD + C.GREEN)}(间隔~${ivStr}, 最近${agoStr})${heightStr}  ` +
      `交易:${colored(String(tCount), C.BOLD + C.CYAN)}(${rateStr})${gapStr}  ` +
      `总计:${total} ${colored('───', C.DIM)}`
    );
  }
}

// ─── 消息解析与格式化 ────────────────────────────────────────────────────────

function parseAndFormat(topic, body, seq, mode, stats) {
  const now    = nowStr();
  const seqStr = seq >= 0 ? colored(`#${String(seq).padStart(6)}`, C.DIM) : '';
  const tg     = tag(topic);
  const lines  = [];
  const log    = [];

  if (HASH_TOPICS.has(topic)) {
    const h     = body.toString('hex');
    const short = h.slice(0, 16) + '…' + h.slice(-8);
    lines.push(`${colored(now, C.DIM)} ${tg} ${seqStr}  ${colored(mode === 'verbose' ? h : short, C.WHITE)}`);
    log.push(`${now} [${topic}] seq=${seq} hash=${h}`);

  } else if (RAW_BLOCK_TOPICS.has(topic)) {
    const hdr     = parseBlockHeader(body);
    const height  = extractBlockHeight(body);
    const txCount = countBlockTxs(body);
    stats.recordBlock(height);

    let ivStr = '-';
    if (stats.blockTimes.length >= 2) {
      const iv = (stats.blockTimes.at(-1) - stats.blockTimes.at(-2)) / 1000;
      ivStr = fmtDuration(iv);
    }

    const sep = colored('━'.repeat(72), C.BOLD + C.YELLOW);
    lines.push(sep);
    lines.push(
      `${colored(now, C.DIM)} ${tg} ${seqStr}  ` +
      (height !== null ? colored(`高度:${height}`, C.BOLD + C.GREEN) + '  ' : '') +
      (txCount !== null ? `txs:${txCount}  ` : '') +
      `大小:${fmtBytes(body.length)}  ${colored('间隔:' + ivStr, C.YELLOW)}`
    );
    if ((mode === 'normal' || mode === 'verbose') && hdr) {
      lines.push(
        `  ${colored('版本:', C.DIM)}${hdr.version}  ` +
        `${colored('时间:', C.DIM)}${hdr.timeStr}  ` +
        `${colored('难度:', C.DIM)}${hdr.bits.toString(16).padStart(8, '0')}`
      );
    }
    if (mode === 'verbose' && hdr) {
      lines.push(`  ${colored('前块:', C.DIM)}${hdr.prevHash}`);
      lines.push(`  ${colored('Merkle:', C.DIM)}${hdr.merkle}`);
    }
    lines.push(sep);
    log.push(
      `${now} [${topic}] seq=${seq} height=${height} txs=${txCount} ` +
      `size=${body.length} interval=${ivStr} bits=${hdr?.bits?.toString(16) ?? '?'}`
    );

  } else if (RAW_TX_TOPICS.has(topic)) {
    stats.recordTx();
    const [inC, outC, sats] = parseTxBrief(body);
    const sizeStr  = fmtBytes(body.length);
    const valueStr = sats !== null ? fmtSats(sats) : '';
    const ioStr    = inC !== null ? `${inC}→${outC}` : '';

    if (mode === 'compact') {
      lines.push(
        `${colored(now, C.DIM)} ${tg} ${seqStr}  ` +
        `${colored(ioStr, C.WHITE)}  ${sizeStr}  ${colored(valueStr, C.DIM)}`
      );
    } else if (mode === 'normal') {
      lines.push(
        `${colored(now, C.DIM)} ${tg} ${seqStr}  in:${inC} out:${outC}  ${sizeStr}  ${valueStr}`
      );
    } else {
      lines.push(
        `${colored(now, C.DIM)} ${tg} ${seqStr}  in:${inC} out:${outC}  ${sizeStr}  ${valueStr}`
      );
      lines.push(`  ${colored('hex:', C.DIM)}${body.toString('hex').slice(0, 120)}…`);
    }
    log.push(`${now} [${topic}] seq=${seq} in=${inC} out=${outC} sats=${sats} size=${body.length}`);

  } else if (MEMPOOL_TOPICS.has(topic)) {
    try {
      const obj    = JSON.parse(body.toString('utf8'));
      const txid   = obj.txid ?? '?';
      const reason = obj.reason ?? '';
      const fee    = obj.fee ?? '';
      const shortId = txid.length > 16 ? txid.slice(0, 16) + '…' : txid;
      let detail = `txid:${shortId}  reason:${colored(reason, C.BOLD + C.RED)}`;
      if (fee) detail += `  fee:${fee}`;
      lines.push(`${colored(now, C.DIM)} ${tg} ${seqStr}  ${detail}`);
      if (mode === 'verbose') lines.push(`  ${JSON.stringify(obj, null, 2)}`);
      log.push(`${now} [${topic}] seq=${seq} ${JSON.stringify(obj)}`);
    } catch {
      const rawHex = body.toString('hex').slice(0, 80);
      lines.push(`${colored(now, C.DIM)} ${tg} ${seqStr}  ${rawHex}…`);
      log.push(`${now} [${topic}] seq=${seq} raw=${body.toString('hex')}`);
    }

  } else {
    lines.push(`${colored(now, C.DIM)} ${tg} ${seqStr}  ${colored(fmtBytes(body.length), C.DIM)}`);
    log.push(`${now} [${topic}] seq=${seq} size=${body.length}`);
  }

  return [lines, log];
}

// ─── CLI 参数解析 ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const out  = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') { out.all = true; continue; }
    const v = args[i + 1];
    if      (a === '--host')           { out.host           = v;              i++; }
    else if (a === '--port')           { out.port           = parseInt(v, 10); i++; }
    else if (a === '--mode')           { out.mode           = v;              i++; }
    else if (a === '--log')            { out.logFile        = v;              i++; }
    else if (a === '--timeout')        { out.timeout        = parseInt(v, 10); i++; }
    else if (a === '--stats-interval') { out.statsInterval  = parseInt(v, 10); i++; }
    else if (a === '--topics')         { out.topics         = v.split(',').map(t => t.trim()); i++; }
    else if (a === '--config')         { out.config         = v;              i++; }
  }
  return out;
}

// ─── 主函数 ──────────────────────────────────────────────────────────────────

async function main() {
  const cli = parseArgs();
  const cfg = {
    host:          '127.0.0.1',
    port:          28332,
    topics:        ['hashblock', 'hashtx', 'rawblock', 'rawtx'],
    mode:          'normal',
    logFile:       null,
    statsInterval: 60,
    timeout:       null,
  };

  if (cli.config) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(cli.config, 'utf8')));
    } catch (e) {
      console.error(colored(`配置文件错误: ${e.message}`, C.RED));
      process.exit(1);
    }
  }

  if (cli.host)                       cfg.host           = cli.host;
  if (cli.port)                       cfg.port           = cli.port;
  if (cli.mode)                       cfg.mode           = cli.mode;
  if (cli.logFile)                    cfg.logFile        = cli.logFile;
  if (cli.timeout > 0)               cfg.timeout        = cli.timeout;
  if (cli.statsInterval !== undefined)
    cfg.statsInterval = cli.statsInterval > 0 ? cli.statsInterval : null;
  if (cli.all)                        cfg.topics         = ALL_TOPICS;
  else if (cli.topics)                cfg.topics         = cli.topics;

  for (const t of cfg.topics)
    if (!ALL_TOPICS.includes(t))
      console.log(colored(`警告: '${t}' 不是已知主题，仍会尝试订阅`, C.YELLOW));

  const address   = `tcp://${cfg.host}:${cfg.port}`;
  const logStream = cfg.logFile ? createWriteStream(cfg.logFile, { flags: 'a' }) : null;
  const stats     = new Stats();

  const W = 72;
  console.log(`\n${colored('━'.repeat(W), C.BOLD + C.BLUE)}`);
  console.log(`  ${colored('TBCNODE ZMQ 节点观测 (Node.js)', C.BOLD + C.WHITE)}`);
  console.log(`${colored('━'.repeat(W), C.BOLD + C.BLUE)}`);
  console.log(`  地址    : ${colored(address, C.CYAN)}`);
  console.log(`  主题    : ${colored(cfg.topics.join(', '), C.WHITE)}`);
  console.log(`  模式    : ${colored(cfg.mode, C.YELLOW)}`);
  if (cfg.logFile)        console.log(`  日志    : ${colored(cfg.logFile, C.DIM)}`);
  if (cfg.timeout)        console.log(`  超时    : ${colored(cfg.timeout + 's', C.YELLOW)}`);
  if (cfg.statsInterval)  console.log(`  统计间隔 : ${colored(cfg.statsInterval + 's', C.DIM)}`);
  console.log(`${colored('━'.repeat(W), C.BOLD + C.BLUE)}\n`);

  const sock = new Subscriber();
  console.log(`连接中 ${colored(address, C.CYAN)} ...`);
  sock.connect(address);
  for (const t of cfg.topics) sock.subscribe(t);
  console.log(colored('已连接，等待消息  (Ctrl+C 退出)\n', C.GREEN));

  const printStats = () => console.log(`\n${stats.summaryLine()}\n`);

  const statsTimer = cfg.statsInterval
    ? setInterval(printStats, cfg.statsInterval * 1000)
    : null;

  let timeoutTimer = null;
  const resetTimeout = () => {
    if (!cfg.timeout) return;
    clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => {
      console.log(
        `\n${colored('⚠  超时', C.RED + C.BOLD)}: ${cfg.timeout}s 内未收到消息\n` +
        `   请确认节点已启动并已启用 ZMQ 发布 (${address})\n`
      );
      printStats();
      process.exit(1);
    }, cfg.timeout * 1000);
  };
  resetTimeout();

  const shutdown = () => {
    if (statsTimer)   clearInterval(statsTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    printStats();
    logStream?.end();
    sock.close();
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  try {
    for await (const frames of sock) {
      resetTimeout();
      const [topicBuf, bodyBuf, seqBuf] = frames;
      const topic = Buffer.from(topicBuf).toString('ascii');
      const body  = Buffer.from(bodyBuf);
      const seq   = seqBuf?.length === 4 ? Buffer.from(seqBuf).readUInt32LE(0) : -1;

      stats.record(topic, seq);
      const [lines, logLines] = parseAndFormat(topic, body, seq, cfg.mode, stats);
      for (const line of lines) console.log(line);
      if (logStream) for (const ll of logLines) logStream.write(ll + '\n');
    }
  } catch (e) {
    if (!e.message?.includes('Socket is closed')) {
      console.error(colored(`错误: ${e.message}`, C.RED));
      process.exit(1);
    }
  }
}

main();
