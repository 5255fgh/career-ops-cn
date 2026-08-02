# 主体边界

当前实现由 Extension、Bridge、SQLite 和本机 `career-ops` 适配器组成。用户在 Side Panel 点击一次“开始扫描”后，Extension 在当前 BOSS 搜索条件内执行一个前台扫描轮次；不会定时启动，也不会在关闭页面后继续运行。

## Extension

- Side Panel 持有当前轮次的 `ScanState`，展示页数、新职位、详情、AI 进度、单职位错误和停止原因。
- Content Script 识别 BOSS 页面、解析当前页卡片、同源读取职位详情并点击下一页。BOSS Selector 全部位于 `packages/boss-adapter`。
- 普通扫描固定预算为最多 3 页、60 个本轮新职位、30 次 AI 调用和约 10 分钟；详情并发固定为 1。
- 相邻 BOSS 请求以 1800ms 为基础加入不超过 ±20% 抖动；单职位临时网络失败最多重试 1 次。
- `detailTimeoutMs` 直接控制详情 `fetch` 和正文读取。超时使用独立 `AbortController` 中止请求，并在结束时清理 timer 与外部 abort 监听器。用户取消、超时、普通网络错误和页面阻断在消息契约中是不同结果。
- Background 只负责扩展生命周期，不保存业务状态；模型 API Key 不进入 Extension。

## 扫描流程

1. 先识别页面阻断。登录失效、challenge、账号风险和搜索页整体无法识别会立即停止。
2. 读取当前页卡片，只要求职位 ID、标题、公司和详情 URL；薪资、地点、经验、学历可在详情阶段补充。
3. 用列表已有字段和本地历史去重信息执行列表预筛。JD 为空不会被当成“未命中技能”的确定性阻断。
4. 对预筛通过的职位串行读取详情。Job ID 完全一致或标准化详情 URL 一致可直接确认身份；没有强信号时组合宽松归一化后的标题、公司和活动卡片判断。
5. 详情完成后执行包含 JD 规则的完整筛选，保存职位；只有完整筛选通过或需要复核且详情完整的职位才进入 AI 评估。
6. 单职位超时、字段缺失、身份失败、详情布局异常、保存失败和 AI 失败写入该职位结果后继续。连续 3 个同类身份、字段或布局 Parser 错误才视为 Parser 整体失效。
7. 达到页数/新增职位预算、连续两页无新增、没有下一页、用户取消或 10 分钟轮次上限时结束。预算型停止为正常完成；安全阻断和 Parser 整体失效为失败停止。

## Bridge 与 SQLite

Bridge 只绑定 `127.0.0.1`，启动时读取 `CAREER_OPS_CN_TOKEN`。`GET /health` 无需 token；以下业务接口要求 Bearer token，并通过 `packages/shared` 的 Zod Schema 校验：

- `POST /screen`：按 `list` 或 `detail` 阶段执行硬规则筛选。
- `POST /jobs`、`GET /jobs`、`GET /jobs/:id`：职位 upsert、历史和详情读取。
- `POST /jobs/:id/evaluate`：再次执行详情硬规则防线，通过后调用本机 evaluator。
- `POST /jobs/:id/decision`：保存用户主动选择的 Apply、Review 或 Skip。
- `POST /diagnostics`、`GET /diagnostics`：写入和读取扫描诊断。

SQLite 初始化 `jobs`、`evaluations`、`decisions` 和 `diagnostics` 表。diagnostics 属于 best-effort 辅助路径：Extension 写入失败显示警告；Bridge 内部诊断写入失败也不会改变已经成功的筛选或评估结果。

`packages/career-ops-adapter` 是唯一允许启动 `career-ops` 子进程的位置，使用 `spawn`、`shell: false`、显式超时和取消信号。没有每日 AI 调用上限；Extension 只使用单轮 30 次防失控上限。

## 边界与非目标

Extension 消息、HTTP 和 CLI 边界全部使用 Zod 校验；已经通过边界校验的内部纯函数不重复解析。当前只支持 BOSS 直聘，不包含自动投递、自动打招呼、自动聊天、联系方式操作、验证码绕过、真人轨迹模拟、其他招聘平台、任务队列、插件系统或远程 Bridge。
