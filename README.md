# career-ops-cn

## 项目定位

`career-ops-cn` 是一个本机运行、只读、由用户主动触发的 BOSS 直聘职位筛选与评估工具。浏览器扩展负责读取当前页面和展示结果，本地 Bridge 负责鉴权、规则筛选、SQLite 持久化，并通过仓库内置的 OpenAI-compatible evaluator 生成评估。

每轮扫描必须由用户主动点击触发；启动后会在当前 BOSS 搜索条件下按固定预算自动处理后续页。项目不会代表用户投递职位、发送消息或操作联系方式；用户判断、备注和投递状态都由用户手动记录。

## 功能

- 检测 BOSS 搜索列表、搜索详情组合页、单职位详情页、登录页、挑战页和不支持的布局。
- 点击一次后自动处理当前搜索条件下最多 3 页、最多 60 个本轮新职位；连续两页没有新职位也会结束。
- 列表阶段只根据标题、公司、已有地点/薪资和去重信息预筛；读取完整 JD 后再做详情硬规则筛选。
- BOSS 详情读取固定并发为 1；先同源 `fetch(detailUrl)`，若响应是动态壳、布局不可识别、缺少详情容器或职位描述，则按 Job ID、标准化详情 URL、标题与公司的顺序定位卡片并从当前右侧实时面板兜底读取。请求间隔以 1800ms 为基础加入不超过 ±20% 抖动，临时网络失败最多重试 1 次。
- 单轮最长约 10 分钟；单轮 AI 调用防失控上限为 30，没有每日 AI 调用上限。
- 在单职位详情页完成 JobDetail 提取、职位身份校验、Bridge 保存和 AI 评估。
- 在保存或评估前校验职位身份，避免把职位 B 的详情保存或分析为职位 A。
- Bridge 只监听 `127.0.0.1`，业务接口要求 Bearer token。
- 用 SQLite 分开保存权威 scan run、职位、完整硬规则结果、AI 评估原文和用户主动记录的候选池信息；关闭后重开 Side Panel 仍可读取本轮阶段、计数和已保存结果。
- 已处理且职位卡片输入未变化的职位复用已保存详情；相同 JD、用户资料版本、规则、Prompt、模型和输出结构生成相同 cache key，不重复调用 evaluator。
- 职位再次出现会更新 `last_seen_at`、本轮 run 和搜索来源；JD 变化后生成新的 `jd_hash` 并重新执行详情筛选和 AI 评估，不因暂时未出现而删除职位。
- 候选池分开展示硬规则结果与 AI score、recommendation、结构化摘要字段和完整 raw report。
- 候选池支持用户判断、备注、投递状态、筛选和排序；当前筛选结果可导出为带 UTF-8 BOM 的 CSV 或完整 JSON。
- 支持用户取消当前扫描，并在登录失效、challenge、账号风险或不支持布局时停止。
- 扫描过程、翻页、职位/JD 映射、取消和错误会尽力写入 SQLite diagnostics；diagnostics 失败只显示警告，不会反转已完成的扫描结果。
- 单职位超时、字段缺失、身份校验、布局、保存或 AI 失败只影响该职位；详情进度仍继续，所有成功保存且通过完整硬规则的职位仍进入 AI。登录失效、challenge、账号风险和搜索页整体无法识别会立即停止；详情 Parser 只有在至少尝试 8 个职位且同一种错误达到 75% 时才视为整体失效。

## 非目标

当前版本明确不提供：

- 自动投递、自动打招呼、自动聊天或任何联系方式操作
- 定时、后台无人值守扫描或通用持久任务队列
- Tracker、快照、简历定制或用户可编辑评分 Prompt
- BOSS 以外的招聘平台
- Plugin、公开 API 版本或远程 Bridge

## 安装

要求：

- Node.js 24
- pnpm 11
- Chromium 浏览器（Chrome 或 Edge）

```powershell
git clone https://github.com/5255fgh/career-ops-cn.git
Set-Location career-ops-cn
pnpm install
Copy-Item .env.example .env
pnpm check
```

`.env` 只用于本机运行，不应提交到 Git。至少修改：

```dotenv
CAREER_OPS_CN_TOKEN=使用一个仅本机保存的随机长 token
OPENAI_API_KEY=使用你的 provider key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

`OPENAI_BASE_URL` 必须是包含版本路径的 OpenAI-compatible base URL，内置 evaluator 会请求其 `/chat/completions`；远程地址必须使用 HTTPS，本机回环 HTTP endpoint 可以不配置 Key。可选配置还包括 Bridge 端口、SQLite 路径、评估超时、JSON 格式的规则偏好，以及写入评估缓存键的 profile/Prompt/model/schema 版本；模型标识优先读取 `CAREER_OPS_CN_MODEL_ID`，未设置时沿用 `OPENAI_MODEL`，可用变量见 [.env.example](./.env.example)。配置完成后运行：

```powershell
pnpm doctor
```

`doctor` 会检查 Node/pnpm、Bridge token、OpenAI-compatible endpoint、凭据、SQLite 目录、扩展构建和当前 Bridge 连接；Bridge 尚未启动只会显示警告。

## AI evaluator 配置

AI 评估实现位于 `packages/career-ops-adapter`，随本仓库安装和构建，不需要同级 `career-ops` 目录、第二套依赖或外部脚本。它把经过 shared Schema 校验的 JobDetail 直接发送给配置的 OpenAI-compatible endpoint，不写外部报告文件。

内置 Prompt 只依据 BOSS JobDetail，明确不臆造候选人简历或外部公司研究，并生成 A–G 中文评估以及固定的 `SCORE_SUMMARY`。适配器保留 `score`、`recommendation`、`rawReport`、`company`、`role`、`archetype` 和 `legitimacy` 字段；score 仍由 0–5 转为 0–100，recommendation 阈值仍为 apply ≥ 4、review ≥ 3.2、其余 skip。

真实模型评估需要在启动 Bridge 的环境中提供 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL`；后两项未设置时分别默认 `https://api.openai.com/v1` 和 `gpt-4o-mini`。模型密钥只留在本机 Bridge 进程环境中，不要输入扩展，也不会进入 Extension bundle。

## Bridge 启动

开发模式：

```powershell
pnpm dev:bridge
```

日常使用先构建，再从仓库根目录启动 Bridge：

```powershell
pnpm build
pnpm start
```

默认地址是 `http://127.0.0.1:3847`。Bridge 提供 `/health`、`/scan-runs`、`/scan-runs/latest`、scan run 进度/取消/中断接口、`/screen`、`/jobs/observe`、`/jobs`、`/jobs/:id/evaluate`、`/jobs/:id/candidate` 和 `/diagnostics`；除 `GET /health` 外都要求与 `CAREER_OPS_CN_TOKEN` 一致的 Bearer token。Bridge 不支持绑定 `0.0.0.0`。

## Extension 加载

```powershell
pnpm build
```

然后在浏览器中：

1. 打开 `edge://extensions` 或 `chrome://extensions`。
2. 开启“开发人员模式”。
3. 选择“加载解压缩的扩展”，加载 `apps/extension/.output/chrome-mv3`。
4. 打开或刷新 BOSS 直聘页面，再点击扩展图标打开 Side Panel。

每次重新构建后，在扩展管理页点击“重新加载”，并刷新 BOSS 标签页，确保 Content Script 使用最新构建。

## 使用流程

1. 启动 Bridge，并确认终端没有配置错误。
2. 在 BOSS 直聘中完成登录。
3. 打开一个职位详情页，或打开包含当前可见职位的搜索结果页。
4. 打开 Career Ops CN Side Panel，输入与 Bridge 一致的 token，点击“保存并检查”。
5. 点击“刷新”确认页面类型和阻断状态。
6. 点击“开始扫描”。单职位详情页会校验并评估当前职位；搜索页会在当前搜索条件下自动翻页，达到 3 页、60 个新职位、连续两页无新增、页面末尾或 10 分钟任一条件即停止。过程中可随时点击“取消”。
7. 在“候选池”中分开查看完整硬规则结果和 AI 原始结果；可按用户判断与投递状态筛选，并按最近发现、AI 分数或职位名称排序。
8. 选择职位后记录 Apply、Review 或 Skip、备注和投递状态，再点击“保存候选池记录”。这些操作只写本机 SQLite，不会在 BOSS 上投递或联系任何人。
9. 点击“导出 CSV”或“导出 JSON”导出当前筛选结果。CSV 带 UTF-8 BOM，Excel 直接打开时中文正常；两种格式都包含职位、硬规则、AI 原文、备注和投递状态。
10. 随时点击“取消”停止当前扫描。

关闭 Side Panel 会停止浏览器侧执行并把未完成 run 标记为 `interrupted`，不会把长任务移入 MV3 Background。重新打开后会主动读取最近 run，展示已完成页数、职位数、失败摘要和已保存结果；点击“重新开始”会新建一轮，并由 Bridge 增量复用已有详情和评估。

## 数据位置

- SQLite 默认路径：`apps/bridge/career-ops-cn.sqlite`
- 可用 `CAREER_OPS_CN_DATABASE_PATH` 指定其他本机路径
- 表：`scan_runs`、`jobs`、`screenings`、`evaluations`、`candidate_records`、`diagnostics`
- Bridge token：扩展的 `chrome.storage.local`
- 扫描配置：扩展的 `chrome.storage.local`
- AI 请求：由 Bridge 内置 evaluator 直接发往配置的 OpenAI-compatible endpoint，不落地临时 JobDetail 文件

SQLite 中会保存职位描述和完整 raw report。不要把真实数据库、`.env` 或任何模型凭据提交到仓库。

固定清理规则：diagnostics 只保留最近 5000 条；成功 run 只保留最近 100 次；失败、取消或中断 run 约 30 天后清理；同一职位只保留最近 3 个评估版本。系统不保存整页原始 HTML。

## 故障排查

先运行 `pnpm doctor`。它不会显示 token 或模型密钥的值；按 `FAIL` 项修复配置，Bridge 未启动产生的 `WARN` 可在启动后再次检查。

- **Bridge 离线**：确认 `pnpm dev:bridge` 正在运行，并检查端口是否被占用。
- **Token 无效**：确保 Side Panel 中保存的 token 与 `CAREER_OPS_CN_TOKEN` 完全一致。
- **真实 evaluator 无法认证**：在启动 Bridge 的同一环境提供有效 `OPENAI_API_KEY`，然后重启 Bridge。不要把 Key 填入扩展。
- **provider HTTP 502/503/504**：适配器会进行 2 次有限重试（共 3 次尝试）。持续失败不会生成伪造 score/raw report；脱敏后的状态、尝试次数和响应摘要会写入 diagnostics，并在 Bridge 错误中返回诊断 ID。
- **evaluator timeout**：检查 provider 连通性，并按需要调整 `CAREER_OPS_CN_EVALUATION_TIMEOUT_MS`。
- **用户取消**：Side Panel 显示“已取消”是预期结果，当前 HTTP 请求会被中止。
- **无效模型输出**：模型必须返回完整 `SCORE_SUMMARY` 和 0–5 的有限数值 score；缺失、损坏或越界结果会按单职位 AI 失败隔离，不会写入伪造结果。
- **任务 interrupted**：标签页刷新、Content Script/Side Panel 断开或 Bridge 重启会保留已完成计数并把未完成 run 标记为 `interrupted`；刷新 BOSS 页面后可重新开始。
- **登录失效**：在 BOSS 页面重新登录，刷新页面后再次检测。
- **challenge 或账号风险**：立即停止扫描，在浏览器中由用户自行完成站点要求；工具不会绕过验证。
- **unsupported layout**：单个详情 `fetch` 返回动态壳或缺字段时会自动尝试当前搜索页实时详情面板；只有列表整体无法解析，或详情至少 8 个样本中同类 Parser 错误达到 75%，才停止整轮。仍失败时需要用脱敏的真实页面证据更新 `packages/boss-adapter` 的 fixture、Selector 和测试。
- **身份校验失败**：Job ID 或标准化详情 URL 一致即可直接确认；缺少强信号时会组合标题和公司判断。实时面板兜底后仍不一致的详情会拒绝保存，单条失败只记录后继续。
- **diagnostics 写入失败**：Side Panel 会显示警告；职位保存、筛选和已完成评估的状态保持不变。

## 当前限制

- 当前版本只支持 BOSS 直聘网页版。
- 自动翻页依赖 BOSS 当前页面仍能识别出“下一页”控件；站点改版后可能需要更新 Selector fixture。
- 扫描执行仍只存在于用户主动打开的前台 Extension 上下文；Bridge/SQLite 持久化状态和结果，但关闭 Side Panel 不会在后台继续操纵 BOSS 页面。
- BOSS 列表不提供完整 JD。卡片字段未变化时会按要求跳过重复详情读取；远端仅修改 JD、但列表字段完全不变的情况，要等后续显式读取到新详情后才能发现并生成新 `jd_hash`。
- BOSS 页面结构变化可能导致 Selector 暂时失效。
- 真实评估依赖可用的 OpenAI-compatible provider 配置和模型额度。
- Side Panel 必须在受支持的 BOSS 页面打开，重新加载扩展后需要刷新已有标签页。

## 常用命令

- `pnpm doctor`：检查本机配置、OpenAI-compatible endpoint、扩展构建和 Bridge 连接。
- `pnpm start`：启动已经构建的本机 Bridge。
- `pnpm typecheck`：检查全部 workspace 的 TypeScript 类型。
- `pnpm test`：运行全部 Vitest 测试。
- `pnpm build`：构建 workspace 和 Chromium MV3 扩展。
- `pnpm smoke`：用临时数据库和回环 OpenAI-compatible endpoint 跑通 Scan Run → Job → 内置 Evaluation → SQLite，并校验扩展产物。
- `pnpm check`：依次运行 typecheck、test、build 和 smoke。

## 许可证

当前仓库未提供开源许可证。除非版权持有人另行书面授权，不授予复制、修改或分发本项目的许可。内置 evaluator 参考的 MIT 许可来源与完整声明见 [packages/career-ops-adapter/THIRD_PARTY_NOTICES.md](./packages/career-ops-adapter/THIRD_PARTY_NOTICES.md)。
