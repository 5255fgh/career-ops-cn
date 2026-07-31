import { startBridge } from "./app.js";

void startBridge().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "未知错误";
  console.error(`Bridge 启动失败：${message}`);
  process.exitCode = 1;
});
