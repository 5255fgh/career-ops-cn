# career-ops output fixtures

这些脱敏 fixture 描述内置 OpenAI-compatible evaluator 的 summary 边界及失败场景。单元测试通过 mock HTTP 响应使用它们；`pnpm smoke` 还会启动回环 HTTP endpoint，跑通 Bridge 到内置 evaluator 的真实网络调用路径。

- `normal-zh.txt`、`normal-en.txt`：正常中英文报告。
- `ansi.json`：JSON 转义保存的 ANSI 彩色 stdout。
- `summary-missing.txt`、`score-corrupt.txt`、`score-out-of-range.txt`：无效模型输出的解析失败。
