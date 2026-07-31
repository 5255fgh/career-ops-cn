# career-ops-cn

`career-ops-cn` 是一个只读、由用户主动触发的求职辅助工具基础仓库。当前阶段仅建立 BOSS 直聘浏览器扩展、回环地址 Bridge 和共享数据契约；不扫描真实职位、不调用 `career-ops`，也不会投递、打招呼或操作联系方式。

## 环境

- Node.js 24 LTS
- pnpm 11

```powershell
pnpm install
Copy-Item .env.example .env
pnpm check
```

## 常用命令

- `pnpm dev:extension`：启动 WXT 扩展开发环境。
- `pnpm dev:bridge`：在 `127.0.0.1` 启动本地 Bridge；必须设置 `CAREER_OPS_CN_TOKEN`。
- `pnpm typecheck`：检查全部 workspace 的 TypeScript 类型。
- `pnpm test`：运行全部 Vitest 测试。
- `pnpm build`：构建 workspace 和 Chromium MV3 扩展。
- `pnpm smoke`：验证契约 fixture、扩展产物和 Bridge health。
- `pnpm check`：依次运行完整检查。

## 目录边界

- `apps/extension`：WXT + React Side Panel、Background 与 Content Script 空壳。
- `apps/bridge`：只监听本机回环地址的 Fastify 服务。
- `packages/shared`：跨 Extension、HTTP 与 CLI 边界的 Zod 契约。
- `packages/boss-adapter`：后续唯一允许存放 BOSS Selector 和 Parser 的包。
- `packages/screening`：后续纯筛选逻辑边界。
- `packages/career-ops-adapter`：后续唯一允许启动 `career-ops` 子进程的包。
- `fixtures`：契约样例与后续解析证据。

详细边界见 [docs/architecture.md](docs/architecture.md)。
