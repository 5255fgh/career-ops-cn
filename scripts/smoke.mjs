import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
assert.equal(nodeMajor, 24, `smoke 需要 Node.js 24，当前为 ${process.versions.node}`);

const shared = await import(
  pathToFileURL(path.join(repositoryRoot, "packages/shared/dist/index.js")).href
);

const fixtureSchemas = [
  ["job-card.json", shared.JobCardSchema],
  ["job-detail.json", shared.JobDetailSchema],
  ["screening-result.json", shared.ScreeningResultSchema],
  ["evaluation-result.json", shared.EvaluationResultSchema],
];

for (const [filename, schema] of fixtureSchemas) {
  assert.ok(schema, `缺少 ${filename} 对应的 shared Schema`);
  const fixturePath = path.join(repositoryRoot, "fixtures/contracts", filename);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  schema.parse(fixture);
}

const manifestPath = path.join(
  repositoryRoot,
  "apps/extension/.output/chrome-mv3/manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.ok(manifest.permissions?.includes("sidePanel"), "扩展缺少 sidePanel 权限");
assert.ok(manifest.side_panel?.default_path, "扩展缺少 Side Panel 入口");
assert.deepEqual(
  [...(manifest.host_permissions ?? [])].sort(),
  ["*://*.zhipin.com/*", "*://zhipin.com/*"].sort(),
  "扩展 host permission 必须只覆盖 zhipin.com",
);
assert.ok(
  manifest.content_scripts?.some((script) =>
    script.matches?.some((match) => match.includes("zhipin.com")),
  ),
  "扩展缺少 zhipin.com Content Script",
);

const { BRIDGE_HOST, startBridge } = await import(
  pathToFileURL(path.join(repositoryRoot, "apps/bridge/dist/app.js")).href
);
const bridge = await startBridge({
  environment: { CAREER_OPS_CN_TOKEN: "smoke-token" },
  port: 0,
});

try {
  const address = bridge.server.address();
  assert.ok(address && typeof address !== "string", "Bridge 未监听 TCP 地址");
  assert.equal(address.address, BRIDGE_HOST);

  const response = await fetch(`http://${BRIDGE_HOST}:${address.port}/health`);
  assert.equal(response.status, 200);
  shared.HealthResponseSchema.parse(await response.json());
} finally {
  await bridge.close();
}

console.log("smoke: ok (4 fixtures, extension manifest, bridge health)");
