# 主体边界

当前实现只有三条可执行路径：Extension Side Panel 展示页面状态，Bridge 提供 `/health`，测试通过 `packages/shared` 校验契约 fixture。

数据进入 Extension 消息、HTTP 或 CLI 边界时必须由 `packages/shared` 的 Zod Schema 校验。边界内的纯函数接收已校验值，不重复解析。Background 只负责扩展生命周期，不持有业务状态。

Bridge 只绑定 `127.0.0.1`，启动时读取 `CAREER_OPS_CN_TOKEN`。SQLite 当前仅用于无表的可用性探测，不创建业务表。

真实 BOSS Selector、Parser、`career-ops` 子进程、任务队列和投递能力均不在当前范围。
