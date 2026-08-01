import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
assert.ok(manifest.permissions?.includes("storage"), "扩展缺少 storage 权限");
assert.ok(manifest.side_panel?.default_path, "扩展缺少 Side Panel 入口");
assert.deepEqual(
  [...(manifest.host_permissions ?? [])].sort(),
  [
    "*://*.zhipin.com/*",
    "*://zhipin.com/*",
    "http://127.0.0.1/*",
  ].sort(),
  "扩展 host permission 必须只覆盖 zhipin.com 和本机 Bridge",
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
const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), "career-ops-cn-smoke-"),
);
const database = new DatabaseSync(
  path.join(temporaryDirectory, "bridge.sqlite"),
);
let bridge;

try {
  bridge = await startBridge({
    environment: {
      CAREER_OPS_CN_TOKEN: "smoke-token",
      CAREER_OPS_CN_CAREER_OPS_ROOT: repositoryRoot,
    },
    database,
    evaluator: async () =>
      shared.EvaluationResultSchema.parse(
        JSON.parse(
          await readFile(
            path.join(
              repositoryRoot,
              "fixtures/contracts/evaluation-result.json",
            ),
            "utf8",
          ),
        ),
      ),
    screenJob: () => ({ decision: "pass", rules: [] }),
    port: 0,
  });

  const address = bridge.server.address();
  assert.ok(address && typeof address !== "string", "Bridge 未监听 TCP 地址");
  assert.equal(address.address, BRIDGE_HOST);
  const bridgeBaseUrl = `http://${BRIDGE_HOST}:${address.port}`;

  const healthResponse = await fetch(`${bridgeBaseUrl}/health`);
  assert.equal(healthResponse.status, 200);
  shared.HealthResponseSchema.parse(await healthResponse.json());

  const jobDetail = shared.JobDetailSchema.parse(
    JSON.parse(
      await readFile(
        path.join(repositoryRoot, "fixtures/contracts/job-detail.json"),
        "utf8",
      ),
    ),
  );
  const createJobRequest = shared.CreateJobRequestSchema.parse({
    source: "boss",
    sourceJobId: jobDetail.jobId,
    title: jobDetail.title,
    company: jobDetail.companyName,
    salary: jobDetail.salaryText,
    location: jobDetail.location,
    experience: jobDetail.experienceText,
    education: jobDetail.educationText,
    description: jobDetail.description,
    url: jobDetail.detailUrl,
    identityVerified: jobDetail.identityVerified,
  });
  const authorization = { Authorization: "Bearer smoke-token" };

  const createJobResponse = await fetch(`${bridgeBaseUrl}/jobs`, {
    method: "POST",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createJobRequest),
  });
  assert.equal(createJobResponse.status, 200);
  const savedJob = shared.JobResponseSchema.parse(
    await createJobResponse.json(),
  );

  const getJobResponse = await fetch(
    `${bridgeBaseUrl}/jobs/${encodeURIComponent(savedJob.id)}`,
    { headers: authorization },
  );
  assert.equal(getJobResponse.status, 200);
  assert.deepEqual(
    shared.JobResponseSchema.parse(await getJobResponse.json()),
    savedJob,
  );

  const evaluateResponse = await fetch(
    `${bridgeBaseUrl}/jobs/${encodeURIComponent(savedJob.id)}/evaluate`,
    { method: "POST", headers: authorization },
  );
  assert.equal(evaluateResponse.status, 200);
  const evaluation = shared.EvaluationResultSchema.parse(
    await evaluateResponse.json(),
  );
  const evaluationFixture = shared.EvaluationResultSchema.parse(
    JSON.parse(
      await readFile(
        path.join(
          repositoryRoot,
          "fixtures/contracts/evaluation-result.json",
        ),
        "utf8",
      ),
    ),
  );
  assert.deepEqual(evaluation, evaluationFixture);

  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ["decisions", "diagnostics", "evaluations", "jobs"]);

  const jobCount = database.prepare("SELECT count(*) AS count FROM jobs").get();
  assert.equal(jobCount?.count, 1);

  const savedEvaluation = database
    .prepare(
      `SELECT job_id, score, recommendation, raw_report
       FROM evaluations`,
    )
    .get();
  assert.deepEqual({ ...savedEvaluation }, {
    job_id: savedJob.id,
    score: evaluationFixture.score,
    recommendation: evaluationFixture.recommendation,
    raw_report: evaluationFixture.rawReport,
  });
} finally {
  if (bridge !== undefined) {
    await bridge.close();
  }
  database.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(
  "smoke: ok (fixtures, extension manifest, Job -> Bridge -> Evaluation)",
);
