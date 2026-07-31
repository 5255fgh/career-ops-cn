# career-ops-cn

`career-ops-cn` 是一个只读、由用户主动触发的求职辅助工具。当前阶段提供一条最薄 Mock 纵切：扩展从 fixture 读取 BOSS 职位，Bridge 将职位写入 SQLite，再由 Fake Evaluator 返回并保存 fixture 评估结果。

它仍不会扫描真实职位、调用真实 `career-ops`、投递、打招呼或操作联系方式。

## 环境

- Node.js 24 LTS
- pnpm 11

```powershell
pnpm install
Copy-Item .env.example .env
pnpm check
```

Bridge 默认把数据库写到 `apps/bridge/career-ops-cn.sqlite`，可用 `CAREER_OPS_CN_DATABASE_PATH` 指定其他路径。职位与评估接口要求 `Authorization: Bearer <CAREER_OPS_CN_TOKEN>`；`GET /health` 不要求 token。

## Mock 链路

1. 在 BOSS 直聘页面打开 Side Panel。
2. 输入与 Bridge 相同的 token，点击“保存”；token 只写入 `chrome.storage.local`。
3. 点击“测试链路”。
4. Content Script 返回 `fixtures/contracts/job-detail.json`。
5. Side Panel 调用 `POST /jobs`，再调用 `POST /jobs/:id/evaluate`。
6. Bridge 把 Job 和 Evaluation 分别写入 `jobs`、`evaluations`，Side Panel 展示职位与评估结果。

Bridge 离线时，Side Panel 会显示明确的本机 Bridge 连接错误。

## Bridge API

- `GET /health`
- `POST /jobs`
- `GET /jobs/:id`
- `POST /jobs/:id/evaluate`

`jobs` 保存 `id`、`source`、`source_job_id`、职位文本与链接；非空 `source_job_id` 在同一来源内幂等 upsert。`evaluations` 保存 `id`、`job_id`、`score`、`recommendation`、`raw_report`。

## 常用命令

- `pnpm dev:extension`：启动 WXT 扩展开发环境。
- `pnpm dev:bridge`：在 `127.0.0.1` 启动本地 Bridge；必须设置 `CAREER_OPS_CN_TOKEN`。
- `pnpm typecheck`：检查全部 workspace 的 TypeScript 类型。
- `pnpm test`：运行全部 Vitest 测试。
- `pnpm build`：构建 workspace 和 Chromium MV3 扩展。
- `pnpm smoke`：用临时数据库跑通 fixture Job → Bridge → Fake Evaluator → SQLite 的完整 Mock 流程，并验证扩展产物。
- `pnpm check`：依次运行完整检查。

## 目录边界

- `apps/extension`：WXT + React Side Panel、Background、fixture Content Script 与 Bridge client。
- `apps/bridge`：只监听本机回环地址的 Fastify + `node:sqlite` 服务。
- `packages/shared`：跨 Extension、HTTP 与 CLI 边界的 Zod 契约。
- `packages/boss-adapter`：后续唯一允许存放 BOSS Selector 和 Parser 的包。
- `packages/screening`：后续纯筛选逻辑边界。
- `packages/career-ops-adapter`：后续唯一允许启动 `career-ops` 子进程的包。
- `fixtures`：契约样例与后续解析证据。

后续 Worktree 接入时，真实 BOSS Selector/Parser 只在 `packages/boss-adapter` 实现，并替换 Content Script 的 fixture 来源；真实 `career-ops` 子进程只在 `packages/career-ops-adapter` 实现，并通过 Bridge 的 Evaluator 注入点替换 Fake Evaluator。两处都继续以 `packages/shared` 的 Zod 契约作为边界。
