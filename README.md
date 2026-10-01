# fir-flow

本地运行的有限冲激响应（FIR）滤波器设计与流式验证后端。仅提供 HTTP API、命令行（CLI）、
合成采样信号与自动化测试——没有网页、没有音频编辑器，也不依赖任何现成滤波设计库
（滤波器全部由窗化 sinc 手写实现；SQLite 使用 Node 内置的 `node:sqlite`）。

仅支持奇数长度、实系数、线性相位（Type I）的低通与高通 FIR。

## 依赖

- Node.js >= 22.5（开发与验证使用 Node 25；需要内置 `node:sqlite` 与 `--experimental-strip-types`）
- Windows / PowerShell（启动脚本）；核心代码跨平台
- 无任何第三方运行时依赖，仅开发依赖 `typescript` 与 `@types/node`

```powershell
npm install
```

所有数据与临时文件都在项目目录内：数据库 `data/*.sqlite`，导出 `exports/*.csv`，
服务日志/PID `data/srv.*`、`data/server.pid`。

## 滤波器设计约定

- **截止频率归一化**：`wc = 2π·fc/fs`（rad/样本），并强制 `0 < fc < fs/2`
  （严格小于奈奎斯特）。拒绝通过修改采样率来“绕过”约束：采样率不匹配直接报错。
- **中心点极限**：理想低通原型 `h[n] = (wc/π)·sinc(wc(n−M))·w[n]`，
  中心点 `n = M = (taps−1)/2` 取 `sinc(0)=1` 的极限。
- **增益归一**：窗化原型先按系数和归一，使低通在 DC 增益恰为 1；高通经频谱反演
  `h_hp[n] = −h_lp[n]`、`h_hp[M] += 1` 后，再按奈奎斯特频点显式归一，使
  `|H(π)| = 1`（DC 处为谱零点）。
- **窗函数**：矩形窗 `rect` 与 Hann 窗 `0.5−0.5cos(2πn/(N−1))`。
- **频响**：逐网格点计算复频响 `H(e^jω)=Σ h[n]e^{−jωn}`、幅度、相位（含解卷绕）
  与群延迟。幅度低于 `MAGNITUDE_NULL_THRESHOLD = 1e-8` 的谱零点附近，相位与群延迟
  数值不可靠，一律输出 `null`，绝不当作有效值。通带群延迟为常量 `M = (taps−1)/2` 样本。
- **纹波口径**：`compare`/导出的“最大纹波”是在**有限频率网格上的采样估计**，
  不是连续频域的严格上界（输出与 CSV 中均明确标注）。

## 因果流式卷积规则（固定）

- 启动零填充：延迟线初值全零，首个输出即 `h[0]·x[0]`；输入 k 个样本立即得到 k 个输出。
- 输出长度：整段 N 个样本 + `taps−1` 个零输入尾部，总长 `N + taps − 1`。
- `flush` 向延迟线补零并吐出剩余 `taps−1` 个尾部输出。
- 延迟线持久化到 SQLite；暂停、重启后续算与整段直接卷积逐样本一致（测试断言误差 < 1e-13）。
- 不使用任何预知未来样本的居中卷积；`Convolver.fullConvolve` 仅作为独立直接形式核对。

## 测试

```powershell
npm test                 # node --test，29 个用例
npm run typecheck        # tsc 严格类型检查
```

夹具覆盖：冲激、阶跃、通带/阻带正弦、空块（零长度）、极短输入（1 样本）、
不均匀分块、暂停/恢复边界与重启后状态。断言包括：

- 系数对称（线性相位）、低通 DC 增益 = 1、高通奈奎斯特增益 = 1 且 DC 为零
- 线性叠加、群延迟对齐下的通带/阻带幅度
- 分块流式 + 尾部冲洗 == 整段直接卷积（含序列化重建延迟线）
- 截止越界、偶数长度、非有限样本（NaN/Infinity）、采样率不匹配等失败路径
- 事务回滚、幂等重复提交、分页、重启持久化

## 启动与停止

```powershell
powershell -File scripts/start.ps1   # 仅绑定 127.0.0.1，端口由 OS 自动分配
                                     # 端口写入 data/server.port，PID 写入 data/server.pid
powershell -File scripts/stop.ps1    # 只停止 data/server.pid 记录的本项目进程
```

也可直接运行：`npm run dev`（前台运行，`Ctrl+C` 停止）。
迁移用 `CREATE TABLE IF NOT EXISTS`，对已存在的库可重复执行。

## API

基础地址为启动时打印的 `http://127.0.0.1:<port>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查 |
| POST | `/designs` | 设计滤波器（可带 `Idempotency-Key` 头） |
| GET | `/designs?limit=&offset=` | 分页列出设计 |
| GET | `/designs/:id` | 查看单个设计（含 JSON 系数） |
| GET | `/designs/:id/response?bins=` | 复频响/幅度/相位/群延迟 |
| POST | `/signals` | 合成信号或直接提交样本数组 |
| GET | `/signals?limit=&offset=` | 分页 |
| POST | `/runs` | 为某设计（可选信号）创建运行 |
| GET | `/runs?limit=&offset=` | 分页 |
| GET | `/runs/:id` | 运行状态与延迟线 |
| POST | `/runs/:id/blocks` | `{samples}` 处理一块；`{action:"pause"|"resume"|"flush"}` |

错误统一返回 `{ "error": { "code", "message", "details" } }`，状态码：
`VALIDATION_ERROR`、`EVEN_LENGTH`、`CUTOFF_OUT_OF_RANGE`、`INVALID_SAMPLE`、
`SAMPLE_RATE_MISMATCH`、`INVALID_STATE_TRANSITION`、`DUPLICATE_IDEMPOTENCY_KEY`、
`NOT_FOUND`、`BAD_JSON`、`INVALID_QUERY`、`METHOD_NOT_ALLOWED`。

示例：

```powershell
$port = Get-Content data/server.port
Invoke-RestMethod "http://127.0.0.1:$port/designs" -Method Post -ContentType application/json `
  -Body '{"sampleRate":8000,"cutoff":1000,"taps":31,"window":"hann","type":"lowpass"}'
```

## CLI

```powershell
npx tsx 不适用；请使用 npm run cli -- <命令>   # 等价于 node --experimental-strip-types src/cli/index.ts
```

```powershell
node --experimental-sqlite --experimental-strip-types src/cli/index.ts design --fs 8000 --fc 1000 --taps 31 --window hann
node ... show --id 1
node ... response --id 1 --bins 33
node ... filter --design 1 --signal 2 --chunks 3 --flush 1 --out exports/y.json
node ... filter --design 1 --file data/sample.json --chunks 4 --flush 1
node ... pause --run 1
node ... resume --run 1
node ... flush --run 1
node ... compare --fs 8000 --fc 1000 --taps 31 --type lowpass
node ... export --design 1 --out exports/response.csv
node ... demo        # 可重复端到端演示（固定参数 + 确定性随机种子）
```

CLI 在关键操作前后打印运行状态（`created/running/paused/flushed`、已处理样本数、
延迟线长度、尾部长度）。`compare` 对矩形窗与 Hann 窗逐项对比，并重申纹波为采样估计。

## 清理

删除 `data/` 下的 `*.sqlite*` 与 `exports/*.csv` 即可完全重置；停止服务只会结束
`data/server.pid` 记录的本项目 node 进程，不触碰系统其他进程。
