# fir-lab

本地可运行的有限冲激响应（FIR）滤波器设计与流式验证后端。TypeScript + Node.js +
内置 SQLite（`node:sqlite`），**只提供 HTTP API、CLI、合成采样信号与自动化测试**，
不含网页、音频编辑器，也不调用任何现成滤波器设计库（窗函数、sinc、频响、卷积全部自行实现）。

支持范围刻意收窄为：**奇数长度、实系数、线性相位的低通 / 高通 FIR**。

## 依赖

- Node.js >= 22.5（开发与验证使用 Node 25；用到内置 `node:sqlite` 与全局 `fetch`）
- 仅开发依赖：`typescript`、`tsx`、`@types/node`

```powershell
npm install
```

## 算法约定（固定，不可悄悄改动）

- **归一化截止频率**：`omega_c = 2*pi*fc/fs`，理想低通冲激响应
  `h_lp[n] = sin(omega_c*(n-m)) / (pi*(n-m))`，中心点用极限值
  `h_lp[m] = omega_c/pi`，其中 `m = (N-1)/2`。
- **窗**：矩形窗与 Hann 窗。Hann 采用对称形式
  `w[n]=0.5-0.5*cos(2*pi*n/(N-1))`，奇数长度下关于整数中心严格对称。
- **高通**：频谱反演 `h_hp[n]=-h_lp[n]`（`n!=m`），`h_hp[m]=1-h_lp[m]`。
- **增益归一**：低通按 `H(0)=sum h` 归一到直流增益 1；高通按
  `H(pi)=sum (-1)^n h` 归一到奈奎斯特增益 1（奇数长度中心为整数，延迟冲激落在 +1）。
- **频响**：逐频率点计算复频响 `H(e^{jw})=sum h[n]e^{-jwn}`、幅度、解卷绕相位与群延迟。
  幅度低于门限（默认峰值的 `1e-3`，并叠加 `1e-12` 绝对地板）时，相位与群延迟返回
  `null`——阻带零点附近这些量由舍入误差主导，**不会**被当作有效数值。群延迟在通带
  应为常数 `m` 个样本，用局部小步长相位增量计算，避免粗网格的 `2*pi` 卷绕歧义。
- **纹波**：`/ripple` 返回的是有限频率网格上的采样估计，**不是**连续频域的严格上界；
  响应字段 `sampledEstimate:true` 和 `note` 明确标注这一点。

## 因果流式卷积规则

- 延迟线初始化为 `N-1` 个零（启动零填充）；首个输出 `y[0]=h[0]*x[0]`，不使用未来样本，
  不是居中卷积。
- `process(block)` 输出长度恒等于输入块长度；`flush()` 再输出恰好 `N-1` 个尾部样本并结束。
  长度 `M` 的输入总输出长度为 `M+N-1`，与独立的整段直接卷积
  （`fullConvolution`，另一份实现）逐样本一致。
- 唯一流状态是持久化的延迟线；关闭进程、重开数据库后续算，结果与整段处理一致（测试覆盖）。
- 已 `flushed` 的运行拒绝再喂数据；`paused` 状态拒绝处理，必须先 `resume`。

## 拒绝的输入（明确错误码）

`INVALID_LENGTH`（偶数长度 / 非正 / 高通 N<3）、`CUTOFF_OUT_OF_RANGE`
（要求严格 `0 < fc < fs/2`）、`INVALID_SAMPLE_RATE`、`UNSUPPORTED_WINDOW`、
`UNSUPPORTED_FILTER_TYPE`、`NON_FINITE_SAMPLE`（`NaN`/`Infinity`）、
`SAMPLE_RATE_MISMATCH`（信号与滤波器采样率不同即拒绝，**不会**通过改采样率偷偷满足约束）、
`RUN_NOT_RUNNING`/`RUN_FINISHED`、`NOT_FOUND`、`DUPLICATE_IDEMPOTENCY_KEY`、
`INVALID_PAGINATION`、`VALIDATION_ERROR`。

## 测试

```powershell
npm test
```

32 个用例覆盖：

- 系数对称性、直流 / 奈奎斯特增益、归一化截止与中心点；
- 通 / 阻带正弦、冲激响应即系数、阶跃、线性叠加、`m` 样本延迟、频响误差；
- 独立直接卷积与分块流式结果、空块、极短输入、暂停 / 恢复、冲洗尾部、
  重启后的恢复边界；
- 近零幅度处相位 / 群延迟为 `null`；
- 参数失败路径、采样率不匹配、事务回滚、幂等重复提交、分页、迁移可重复执行、
  重启后的持久化状态、HTTP 端到端。

时间通过可注入时钟、随机性通过带种子 PRNG 隔离，演示与测试可重复。

## 可重复端到端演示

```powershell
npm run demo
```

该脚本比较矩形 / Hann 窗，生成通带 + 阻带合成信号，分块处理并在中途暂停、模拟进程重启
后续算，冲洗后与整段直接卷积核对（最大误差约 `1e-15`），再启动临时本机 HTTP 服务验证
API，导出 JSON 到 `tmp/demo/`，最后自行停止。

## 启动 / 停止服务

```powershell
npm run build
npm start
```

服务**只绑定 `127.0.0.1`**，默认监听端口 `0`（由操作系统分配空闲端口），端口打印在
启动行并写入 `tmp/server.pid`（以及设置了 `FIRLAB_PORT_FILE` 时写入该文件）。
需要固定端口时：`$env:FIRLAB_PORT="8080"; npm start`（仍只绑本机）。

停止：在该终端按 `Ctrl+C`（会关闭数据库并删除 pid 文件）；或

```powershell
npm run clean
```

`clean` 只向 `tmp/server.pid` 记录的本项目 pid 发 `SIGTERM`，并删除本项目的
`data/` 与 `tmp/`，不触碰其它进程或目录。

## HTTP API（节选）

- `POST /filters`：设计滤波器。body：`type,sampleRate,cutoffHz,length,window`，
  可选 `idempotencyKey`（重复提交返回同一条记录，`replayed:true`）。
- `GET /filters?limit=&offset=`、`GET /filters/{id}`、
  `GET /filters/{id}/versions?limit=&offset=`。
- `GET /filters/{id}/response?bins=`：复频响 / 幅度 / dB / 相位 / 群延迟。
- `GET /filters/{id}/ripple?f0=&f1=&bins=`：频带采样纹波（明确标注为采样估计）。
- `POST /signals`（可选 `idempotencyKey`）、`GET /signals`、`GET /signals/{id}`。
- `POST /runs`（`filterId`，可选 `signalId`，采样率不匹配返回 409）、
  `POST /runs/{id}/process`（body `{block:number[]}`，空数组合法）、
  `POST /runs/{id}/pause`、`/resume`、`/flush`、
  `GET /runs/{id}/outputs`、`GET /runs/{id}/events`、`GET /runs`。

所有列表接口分页（`limit` 1..500，`offset>=0`，非法返回 `INVALID_PAGINATION`）。
错误统一为 `{ "error": { "code", "message", "details?" } }`。

## CLI

```powershell
npm run cli -- design --type lowpass --sample-rate 8000 --cutoff 1200 --length 31 --window hann
npm run cli -- show --id 1
npm run cli -- response --id 1 --bins 64
npm run cli -- compare-windows --type highpass --sample-rate 8000 --cutoff 2000 --length 31
npm run cli -- filter-signal --filter-id 1 --kind multitone --length 300 `
  --pass-frequency 500 --stop-frequency 3000 --chunk 37
npm run cli -- pause-demo --filter-id 1 --length 25 --chunk 7
npm run cli -- export --run-id 1 --out result.json
npm run cli -- list filters --limit 20 --offset 0
```

`filter-signal` 与 `pause-demo` 会打印每个操作前后的运行状态，并把流式结果与整段
直接卷积核对；导出文件写入项目的 `tmp/`。

## 数据存放

所有数据库、导出、临时文件均位于本项目 `data/`（默认 `data/firlab.sqlite`）与
`tmp/`。可用环境变量 `FIRLAB_ROOT`、`FIRLAB_DATA_DIR`、`FIRLAB_TMP_DIR`、
`FIRLAB_DB`、`FIRLAB_JOURNAL_MODE` 覆盖（测试使用系统临时目录）。

## 代码布局

- `src/fir/`：`design.ts`（窗化 sinc / 频谱反演 / 增益归一）、`windows.ts`、
  `response.ts`（复频响、相位、群延迟、采样纹波）、`convolution.ts`
  （流式状态机、冲洗、独立直接卷积）、`signals.ts`（合成信号）、`errors.ts`。
- `src/db/`：`schema.ts`（可重复迁移）、`database.ts`（事务 / 分页）、
  `repository.ts`（过滤器、系数版本、信号、运行、事件）。
- `src/services/`：`filterService.ts`、`runService.ts`（暂停 / 恢复 / 重启续算）。
- `src/api/server.ts`、`src/server.ts`、`src/cli/index.ts`。
- `tests/`：`dsp`、`convolution`、`persistence`、`api` 四组。
