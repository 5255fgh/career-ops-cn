# 主体边界

当前实现由 Extension、Bridge、SQLite 和仓库内置的 OpenAI-compatible evaluator 组成。用户在 Side Panel 点击一次“开始扫描”后，Extension 在当前 BOSS 搜索条件内执行一个前台扫描轮次；不会定时启动，也不会在关闭 Side Panel 后继续操作浏览器。轮次的权威状态和已保存结果位于 Bridge/SQLite，Side Panel 只是可重建的展示与执行投影。

## Extension

### Side Panel 与 ScanController

- Side Panel 启动时查询 `GET /scan-runs/latest`，用 Bridge 返回的 run 和本轮职位重建阶段、页数、详情/AI 成败、缓存命中、停止原因、硬规则、评估和候选池记录。
- `ScanController` 负责浏览器侧执行顺序：创建 scan run、读取页面、请求 Bridge 增量判断、串行抓取需要更新的详情、触发筛选/评估，并把绝对计数持续回写 Bridge。
- 用户取消先在 Bridge 写入取消标志，再中止 Content Script 与 evaluator；控制器在后续进度回写中也会读取取消标志。
- 标签页或 Content Script 断开会把 run 标记为 `interrupted`。Side Panel 关闭时使用 keepalive 请求中断 run；重新开始只新建一轮，不精确恢复到某个 DOM 元素。
- 普通扫描固定预算为最多 3 页、60 个本轮新职位、30 次实际评估尝试和约 10 分钟；详情并发固定为 1。没有每日 AI 调用上限。
- 候选池读取 `GET /jobs`，在本地执行用户判断/投递状态筛选与最近发现/AI 分数/职位名称排序；CSV/JSON 导出只序列化当前筛选结果，不触发 BOSS 或 evaluator 操作。
- Background 只负责扩展生命周期，不保存业务状态，也不承载长任务；模型 API Key 不进入 Extension。

### Content Script

- 只识别 BOSS 页面、解析当前页卡片、读取当前或目标职位详情、滚动/点击下一页，并返回经过 shared Zod 契约校验的结果。目标详情先同源 fetch；动态壳、缺详情容器或缺 description 时，按 Job ID、标准化 URL、标题与公司定位完整卡片，由 Extension 专用安全激活函数等待右侧面板身份或内容变化并再次校验。
- 安全激活不会使用 boss-adapter 的通用 anchor 激活：优先派发到完整卡片或无 `href` 的交互区域；必须经过链接处理器时临时在捕获阶段 `preventDefault()`，不停止冒泡，随后立即移除监听器。激活前后校验搜索 pathname、列表签名、详情身份和 Content Script 连接；同 pathname 的查询参数变化允许继续，独立详情/首页/安全页跳转或生命周期卸载返回 `navigation_changed`。单职位结果可返回时只隔离该职位；真实导航销毁消息端口时由 Side Panel 将 run 标为 `interrupted` 并保留完成结果，不刷新、回退或重载页面。
- BOSS Selector 全部位于 `packages/boss-adapter`；Bridge 不读取或操作 DOM。
- 相邻 BOSS 请求以 1800ms 为基础加入不超过 ±20% 抖动；单职位临时网络失败最多重试 1 次。
- `detailTimeoutMs` 分别控制详情 `fetch` 和实时面板等待。每次尝试只回传脱敏 URL、HTTP 状态、页面类型、详情容器、缺失字段、读取来源和有限身份信号；不保存整页 HTML。用户取消、超时、普通网络错误、身份失败和页面阻断是不同契约结果。

## 扫描流程

1. ScanController 在 Bridge 创建 `running` scan run，再识别当前页面和搜索来源摘要。
2. 登录失效、challenge、账号风险和搜索页整体无法识别会立即停止；其他单职位错误隔离后继续。详情 Parser 至少尝试 8 个样本且同类错误比例达到 75% 才判定整体失效；停止前已成功保存且通过完整硬规则的职位仍执行 AI 评估。
3. Content Script 读取卡片，ScanController 仅做本轮页内去重；Bridge 的 `/jobs/observe` 根据 SQLite 判断职位是新职位、卡片变化/详情缺失需要重读，还是输入未变化可直接复用。
4. Bridge 对已存在职位更新 `last_seen_at`、`last_scan_run_id` 和 `source_query`。可复用职位不重复读取详情；当前完整硬规则记录与 cache key 命中时直接返回已保存结果。
5. 新职位或需要更新的职位先做列表预筛，再由 Content Script 串行读取详情并校验身份。Bridge 保存详情时维护 `first_seen_at`、`last_seen_at` 和 `jd_hash`。
6. 完整硬规则结果独立写入 `screenings`。详情输入变化后重新筛选和评估；未变化但规则变化时先用已保存详情重建硬规则，阻断后不调用 AI；profile、Prompt、模型或评估结构版本变化时允许重新评估，不要求再次读取 DOM。
7. 达到页数/新增职位预算、连续两页无新增、没有下一页、用户取消或 10 分钟轮次上限时结束。预算型停止为 `completed`；用户取消为 `cancelled`；上下文断开为 `interrupted`；安全阻断、Parser 整体失效或不可恢复错误为 `failed`。

## Bridge 与 SQLite

Bridge 只绑定 `127.0.0.1`，启动时读取 `CAREER_OPS_CN_TOKEN`。`GET /health` 无需 token；业务接口要求 Bearer token，Extension、HTTP 和 CLI 边界都通过 `packages/shared` 的 Zod Schema 校验。

### 最小 API

- `POST /scan-runs`：创建一轮，创建新轮时把遗留的 running 轮次标记为 interrupted。
- `POST /scan-runs/:id/progress`：更新阶段、绝对计数和终态。
- `GET /scan-runs/latest`：返回当前或最近 run，以及 `last_scan_run_id` 属于该轮的职位、当前硬规则、当前评估和候选池记录。
- `POST /scan-runs/:id/cancel`、`POST /scan-runs/:id/interrupted`：写入取消标志或中断终态。
- `POST /jobs/observe`：更新职位再次出现的信息，并由 Bridge 决定读取详情还是复用。
- `POST /screen`：按 `list` 或 `detail` 阶段执行硬规则筛选；使用 Bridge 当前规则的详情结果会独立持久化。
- `POST /jobs`、`GET /jobs`、`GET /jobs/:id`：职位 upsert、历史和详情读取。
- `POST /jobs/:id/evaluate`：先确保当前 JD/规则的完整硬规则结果存在并通过，再按完整缓存键复用或调用本机 evaluator。
- `POST /jobs/:id/candidate`：保存用户主动选择的 Apply、Review 或 Skip、备注和投递状态。
- `POST /diagnostics`、`GET /diagnostics`：best-effort 写入和读取扫描诊断。

### 数据结构与恢复

- `scan_runs` 只保存 `running/completed/cancelled/interrupted/failed` 五种状态、当前 phase、时间、页/职位/详情/AI/缓存计数、停止原因、失败摘要和取消时间。
- Bridge 创建或重启时会把数据库内遗留的 `running` run 标记为 `interrupted`；正常停止 Bridge 也执行同样收尾。
- `jobs` 维护首次/最近出现时间、`jd_hash`、本轮 run 和搜索来源，不因某轮未出现而删除。
- `screenings` 每职位保存当前 JD/规则对应的完整硬规则是否通过、原因、`jd_hash` 和 `rules_hash`，与 AI 结果分离。
- `evaluations` 保存结果以及 `jd_hash`、`profile_hash`、`rules_hash`、`prompt_version`、`model_id`、`evaluation_schema_version`、`input_hash/cache_key`、创建时间和可靠测得的延迟。
- `candidate_records` 每职位保存可为空的用户判断、备注、投递状态和更新时间；旧 `decisions` 表在启动迁移后删除。
- cache key 来自实际 JobDetail 与全部版本元数据；相同 key 直接复用。JD、规则、profile、Prompt、模型或输出结构任一变化都会形成新 key。
- diagnostics 写入失败不得改变职位保存、筛选、评估或 run 业务结果。

### 固定清理规则

- diagnostics 最多保留最近 5000 条。
- `completed` run 最多保留最近 100 次。
- `failed`、`cancelled`、`interrupted` run 约 30 天后清理。
- 每个职位最多保留最近 3 个评估版本。
- 不保存整页原始 HTML，也不引入清理框架、Redis、队列、Cron 或通用调度器。

`packages/career-ops-adapter` 内置唯一的 OpenAI-compatible Chat Completions evaluator 实现。它在 Bridge 进程内使用 `fetch`；有 `DEEPSEEK_API_KEY` 时读取 `DEEPSEEK_BASE_URL`/`DEEPSEEK_MODEL`（默认 `https://api.deepseek.com` 和 `deepseek-v4-flash`），请求 `/chat/completions`。否则兼容读取 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL`。它不启动子进程、不读取外部仓库，也不落地临时 JobDetail。远程 endpoint 强制 HTTPS，回环地址允许 HTTP；认证失败直接返回，502/503/504 最多共尝试 3 次，超时和用户取消都会中止当前请求，无效 JSON、空内容、缺失 summary 或越界 score 不会写入评估。

Prompt 只使用已经通过 shared Schema 的 BOSS JobDetail，要求模型生成 A–G 中文分析和固定 `SCORE_SUMMARY`。模型没有候选人简历或浏览器研究能力，因此 Prompt 明确禁止臆造候选人/公司事实，也不生成简历、求职信或投递内容。summary 经本地解析后保持 `score`、`recommendation`、`rawReport`、`company`、`role`、`archetype`、`legitimacy` 对外字段不变。

## 边界与非目标

当前只支持 BOSS 直聘，不包含自动投递、自动打招呼、自动聊天、联系方式操作、验证码绕过、真人轨迹模拟、其他招聘平台、跨设备同步、用户系统、简历生成、任务队列、插件系统或远程 Bridge。

BOSS 列表不暴露完整 JD，因此卡片输入完全不变时会优先满足“不重复读取”；若站点只修改远端 JD 而不改变任何列表字段，只能在后续显式获得新详情时识别 `jd_hash` 变化。
