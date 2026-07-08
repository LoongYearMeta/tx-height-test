# Mesh Chain Builder（网状交易链生成器）

用于生成 **可复现的网状交易链（Mesh Transaction Chain）**，主要用于测试：

* mempool 祖先深度限制
* 多输入合并交易（merge）
* 多输出分裂交易（split）
* 复杂交易图结构

程序会从一个初始 UTXO 开始构建交易网络，并输出可以直接广播到节点的 **原始交易（raw transaction）**。

---

# 功能特点

* 支持 **随机种子，可复现交易链**
* 自动生成 **合并交易（多输入）**
* 自动生成 **分裂交易（多输出）**
* 可控制 **祖先深度**
* **流式写入交易**，避免内存占用过高
* 输出 **mempool 风格的交易树结构**
* **自动化模式**：监听出块 → 生成 → 广播，自适应流控

---

# 安装

运行环境：

* Node.js 18 或更高版本
* npm

安装依赖：

```bash
npm install tbc-lib-js axios minimist
```

---

# 使用方法

## 模式一：自动化压测（推荐）

```bash
node automation.js
```

每出一个新区块，自动：
1. 提取 coinbase UTXO（vout 1）作为资金来源
2. 启动 `generator-mesh-tx.js` 生成交易链
3. 生成完成后启动 `broadcast.js` 广播

自适应流控会根据广播成功率动态调整 `depth`（初始 2000，范围 100~10000）。

账本状态保存在 `mesh-chain-ledger.json`，交易文件按 `区块高度-交易祖先深度` 命名，例如 `824399-2000`。

### RPC 配置（`automation.js` 顶部）

```js
const RPC = {
    url: 'http://localhost:8332',
    auth: {
        username: 'username',
        password: 'randompasswd'
    }
};
```

### 流控参数（`automation.js` 顶部）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `initialDepth` | `2000` | 初始交易祖先深度 |
| `minDepth` | `100` | 最小深度下限 |
| `maxDepth` | `10000` | 最大深度上限 |
| `blockInterval` | `60000` | 预期出块间隔（ms）|
| `rpcTimeout` | `5000` | 健康检查超时（ms）|

---

## 模式二：手动生成交易链

```bash
node generator-mesh-tx.js \
  --txid <TXID> \
  --vout <输出索引> \
  --satoshis <金额（聪）> \
  --depth <目标祖先深度> \
  --outputdir <输出目录> \
  --privkey <WIF私钥>
```

示例：

```bash
node generator-mesh-tx.js \
  --txid f069929384673f540f2fb425369ab0f18e4e5a2249b7cf830167c3c5e54598f1 \
  --vout 1 \
  --satoshis 414957762 \
  --depth 500 \
  --outputdir ./mesh-chain-output/test-500 \
  --privkey L1u2TmR7hMMMSV9Bx2Lyt3sujbboqEFqnKygnPRnQERhKB4qptuK
```

也可以通过 JSON 配置文件运行：

```bash
node generator-mesh-tx.js --config ./my-config.json
```

### 主要参数

| 参数 | 说明 |
|------|------|
| `--txid` | 初始 UTXO 的交易 ID |
| `--vout` | 初始 UTXO 的输出索引 |
| `--satoshis` | 初始 UTXO 的金额（聪） |
| `--depth` | 目标最大祖先深度（默认 2000）|
| `--outputdir` | 输出目录 |
| `--privkey` | 初始 UTXO 对应的 WIF 私钥 |
| `--seed` | 随机种子（设置后可复现交易链）|

### BASE_CONFIG（代码内）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxTransactions` | `100000` | 最大交易数量安全限制 |
| `addressPoolSize` | `100` | 地址池大小 |
| `feePerTx` | `80` | 每个输入的手续费（聪）|
| `minSplitAmount` | `1000000` | 最小分裂金额（聪）|
| `batchSize` | `1000` | 流式写入批次大小 |

---

## 模式三：手动广播交易

```bash
# 批量自适应模式（推荐，自动优化吞吐量）
node broadcast.js --file ./mesh-chain-output/test-500/transactions.txt --batch

# 单发模式（分层并发，默认 4 并发）
node broadcast.js --file ./mesh-chain-output/test-500/transactions.txt

# 单发模式 + 8 并发
node broadcast.js --file ./mesh-chain-output/test-500/transactions.txt -c 8
```

### 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--file` | `./mesh-chain-output/transactions.txt` | 交易文件路径 |
| `--batch` | `false` | 启用批量自适应模式 |
| `-c` | `4` | 单发模式并发数 |

### 模式对比

| 模式 | RPC 方法 | 特点 |
|------|----------|------|
| 单发 | `sendrawtransaction` | 分层并发，保证父先于子 |
| 批量 | `sendrawtransactions` | 跨层批量，自适应流控找最优吞吐 |

批量模式自适应规则：
- 响应时间 > 1000ms 或失败：batch size 减半（退避）
- 响应时间 < 200ms：batch size 以 √n 步长增长（慢启动）

### RPC 配置（`broadcast.js` 顶部）

```js
const RPC_CONFIG = {
    url: 'http://localhost:8332',
    username: 'username',
    password: 'randompasswd',
};
```

---

# 输出文件说明

生成完成后输出目录结构：

```
mesh-chain-output/824399-2000/
├── transactions.txt   # 原始交易（每行一笔 hex）
├── graph.json         # 交易图数据（含每笔交易的深度，用于分层广播）
├── tree.txt           # 交易树形结构
├── summary.txt        # 统计信息
├── keys.txt           # 地址池私钥（请妥善保管）
├── generator.log      # 生成日志（自动化模式）
└── broadcast.log      # 广播日志（自动化模式）
```

---

## transactions.txt

每行一笔序列化后的原始交易（raw tx hex），可直接广播：

```
0200000001...
0200000002...
```

---

## graph.json

包含每笔交易的深度信息，供 `broadcast.js` 按层顺序广播（保证父交易先于子交易）。

---

## tree.txt

交易关系的树形结构，类似 mempool 的祖先关系：

```
txA d=1
    txB d=2 [MERGE:2]
        txC d=3 [SPLIT:3]
```

---

## summary.txt

生成统计信息：总交易数、最大祖先深度、merge/split 交易数量、剩余 UTXO 数量、随机种子。

---

# 可复现交易链

要生成完全相同的交易链，必须保持以下参数一致：

* `--seed`（随机种子）
* `--txid` / `--vout` / `--satoshis`（初始 UTXO）
* `addressPoolSize` / `feePerTx`（BASE_CONFIG）

---

# 账本状态说明（自动化模式）

`mesh-chain-ledger.json` 记录每个交易集的生命周期：

| 状态 | 说明 |
|------|------|
| `pending` | 已创建，等待处理 |
| `generating` | 正在生成交易链 |
| `generated` | 生成完成，等待广播 |
| `broadcasting` | 正在广播 |
| `completed` | 广播成功 |
| `failed` | 生成或广播失败 |

---

# 注意事项

* 该工具可能生成 **大量交易数据**，请在测试环境中使用。
* `depth` 过大时，可能占用较多磁盘空间，mempool 可能快速增长。
* `keys.txt` 包含私钥，请妥善保管。
* 自动化模式使用 coinbase UTXO 的 `vout 1`，确保节点挖矿地址对应的私钥已配置。
