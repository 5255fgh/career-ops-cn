# career-ops output fixtures

这些脱敏 fixture 描述当前 `openai-eval.mjs` 的 summary 边界及失败场景。测试只通过 fake CLI 使用它们，不调用真实模型，也不写入 `career-ops/reports`。

- `normal-zh.txt`、`normal-en.txt`：正常中英文报告。
- `ansi.json`：JSON 转义保存的 ANSI 彩色 stdout。
- `summary-missing.txt`、`score-corrupt.txt`、`score-out-of-range.txt`：解析失败。
- `api-auth-error.stderr.txt`、`non-zero-exit.stderr.txt`：stderr 与非零退出。
- `stdout-over-limit.txt`：输出上限。
- `timeout.json`、`cancel.json`：无 stdout 场景的预期错误码。
