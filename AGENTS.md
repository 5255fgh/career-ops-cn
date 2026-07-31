# career-ops-cn 协作规则

1. 项目只读运行，所有动作必须由用户主动触发。
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
