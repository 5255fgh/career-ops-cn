# career-ops-cn 协作规则

1. 项目只读运行；每轮扫描必须由用户主动点击触发，启动后允许在当前 BOSS 搜索条件内按固定预算自动翻页和连续处理，禁止定时或后台无人值守启动。
2. 禁止自动投递、自动打招呼、自动聊天以及任何联系方式操作。
3. 第一阶段只支持 BOSS 直聘。
4. BOSS Selector 只允许放在 `packages/boss-adapter`。
5. `career-ops` 子进程代码只允许放在 `packages/career-ops-adapter`。
6. Extension 不保存模型 API Key。
7. Background 不保存业务状态。
8. 跨 Extension、HTTP、CLI 边界的数据必须使用 Zod 校验。
9. 内部纯函数不重复校验已经通过边界校验的数据。
10. 外部进程必须使用 `spawn` 或 `execFile`，并明确设置 `shell: false`。
11. Parser 变更必须同时提交对应 fixture。
12. 每个任务只实现当前范围。
13. 不顺手重构。
14. 不为未来功能添加占位框架。
15. `packages/shared` 可以根据真实证据调整，但不能在多个并行分支同时随意修改。
16. 单职位错误默认隔离并继续；只有登录失效、challenge、账号风险、搜索页整体解析失败或连续同类 Parser 错误可以停止整轮。
17. diagnostics 必须 best-effort，写入失败不得改变职位保存、筛选、评估或整轮扫描的业务结果。
18. scan run、职位增量字段、评估缓存和取消标志的权威状态必须保存在 Bridge/SQLite；Side Panel 与 ScanController 的内存状态只是当前执行投影，Background 仍不得持有长任务业务状态。
19. Content Script 只负责 BOSS DOM 读取、详情抓取和翻页；ScanController 负责浏览器侧顺序；Bridge 不得直接操作浏览器 DOM，并负责职位增量判断和基于完整输入版本的评估缓存。
20. 相同评估 cache key 不得重复调用 evaluator；JD、规则、profile、Prompt、模型或评估结构版本变化时必须允许重新评估，且只保留单轮 AI 防失控上限，不增加每日上限。
21. 数据清理保持固定简单规则：diagnostics 约 5000 条、成功 run 约 100 次、失败/取消/中断 run 约 30 天、每职位少量评估版本，不引入通用清理框架或保存整页原始 HTML。
