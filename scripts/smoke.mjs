import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
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
const evaluatorOutput = (
  await readFile(
    path.join(repositoryRoot, "fixtures/career-ops-output/normal-zh.txt"),
    "utf8",
  )
).trim();
let evaluatorRequest;
const evaluatorServer = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    evaluatorRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-smoke",
        choices: [
          { message: { role: "assistant", content: evaluatorOutput } },
        ],
      }),
    );
  } catch (error) {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise((resolve, reject) => {
  evaluatorServer.once("error", reject);
  evaluatorServer.listen(0, "127.0.0.1", resolve);
});
const evaluatorAddress = evaluatorServer.address();
assert.ok(
  evaluatorAddress && typeof evaluatorAddress !== "string",
  "测试 evaluator 未监听 TCP 地址",
);
const previousOpenAIEnvironment = {
  baseUrl: process.env.OPENAI_BASE_URL,
  model: process.env.OPENAI_MODEL,
  apiKey: process.env.OPENAI_API_KEY,
};
const previousDeepSeekEnvironment = {
  baseUrl: process.env.DEEPSEEK_BASE_URL,
  model: process.env.DEEPSEEK_MODEL,
  apiKey: process.env.DEEPSEEK_API_KEY,
};
delete process.env.DEEPSEEK_BASE_URL;
delete process.env.DEEPSEEK_MODEL;
delete process.env.DEEPSEEK_API_KEY;
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${evaluatorAddress.port}/v1`;
process.env.OPENAI_MODEL = "smoke-model";
delete process.env.OPENAI_API_KEY;
let bridge;

try {
  bridge = await startBridge({
    environment: {
      CAREER_OPS_CN_TOKEN: "smoke-token",
      OPENAI_MODEL: "smoke-model",
    },
    database,
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

  const createRunResponse = await fetch(`${bridgeBaseUrl}/scan-runs`, {
    method: "POST",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(createRunResponse.status, 200);
  const scanRun = shared.ScanRunSchema.parse(await createRunResponse.json());

  const createJobResponse = await fetch(`${bridgeBaseUrl}/jobs`, {
    method: "POST",
    headers: {
      ...authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...createJobRequest,
      scanRunId: scanRun.id,
      sourceQuery: "boss:/web/geek/job?query=TypeScript",
    }),
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
    {
      method: "POST",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scanRunId: scanRun.id }),
    },
  );
  assert.equal(evaluateResponse.status, 200);
  const evaluationResponse = shared.EvaluationResponseSchema.parse(
    await evaluateResponse.json(),
  );
  const evaluation = evaluationResponse.evaluation;
  const evaluationFixture = shared.EvaluationResultSchema.parse(
    {
      score: 84,
      recommendation: "apply",
      rawReport: evaluatorOutput,
      company: "星河科技",
      role: "高级前端工程师",
      archetype: "Builder",
      legitimacy: "high",
    },
  );
  assert.deepEqual(evaluation, evaluationFixture);
  assert.equal(evaluatorRequest?.method, "POST");
  assert.equal(evaluatorRequest?.url, "/v1/chat/completions");
  assert.equal(evaluatorRequest?.headers.authorization, undefined);
  assert.equal(evaluatorRequest?.body.model, "smoke-model");
  assert.equal(evaluatorRequest?.body.stream, false);
  assert.match(
    evaluatorRequest?.body.messages?.[1]?.content ?? "",
    /123456789/u,
  );

  const candidateResponse = await fetch(
    `${bridgeBaseUrl}/jobs/${encodeURIComponent(savedJob.id)}/candidate`,
    {
      method: "POST",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        decision: "apply",
        note: "smoke 备注",
        applicationStatus: "not_applied",
      }),
    },
  );
  assert.equal(candidateResponse.status, 200);
  const candidate = shared.CandidateRecordSchema.parse(
    await candidateResponse.json(),
  );
  assert.equal(candidate.note, "smoke 备注");

  const finishRunResponse = await fetch(
    `${bridgeBaseUrl}/scan-runs/${encodeURIComponent(scanRun.id)}/progress`,
    {
      method: "POST",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        status: "completed",
        pageCount: 1,
        discoveredCount: 1,
        newJobCount: 1,
        detailSuccessCount: 1,
        aiSuccessCount: 1,
      }),
    },
  );
  assert.equal(finishRunResponse.status, 200);
  assert.equal(
    shared.ScanRunSchema.parse(await finishRunResponse.json()).status,
    "completed",
  );

  const latestRunResponse = await fetch(`${bridgeBaseUrl}/scan-runs/latest`, {
    headers: authorization,
  });
  const latestRun = shared.LatestScanRunResponseSchema.parse(
    await latestRunResponse.json(),
  );
  assert.equal(latestRun?.run.id, scanRun.id);
  assert.equal(latestRun?.jobs.length, 1);
  assert.equal(latestRun?.jobs[0]?.latestScreening?.matched, true);
  assert.equal(latestRun?.jobs[0]?.latestEvaluation?.score, evaluation.score);
  assert.equal(latestRun?.jobs[0]?.candidate?.note, "smoke 备注");

  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, [
    "candidate_records",
    "diagnostics",
    "evaluations",
    "jobs",
    "scan_runs",
    "screenings",
  ]);

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
  const savedScreening = database
    .prepare("SELECT matched, reasons_json FROM screenings WHERE job_id = ?")
    .get(savedJob.id);
  assert.deepEqual({ ...savedScreening }, { matched: 1, reasons_json: "[]" });
} finally {
  if (bridge !== undefined) {
    await bridge.close();
  }
  evaluatorServer.closeAllConnections();
  await new Promise((resolve, reject) => {
    evaluatorServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  for (const [name, value] of [
    ["OPENAI_BASE_URL", previousOpenAIEnvironment.baseUrl],
    ["OPENAI_MODEL", previousOpenAIEnvironment.model],
    ["OPENAI_API_KEY", previousOpenAIEnvironment.apiKey],
    ["DEEPSEEK_BASE_URL", previousDeepSeekEnvironment.baseUrl],
    ["DEEPSEEK_MODEL", previousDeepSeekEnvironment.model],
    ["DEEPSEEK_API_KEY", previousDeepSeekEnvironment.apiKey],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  database.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log(
  "smoke: ok (fixtures, extension manifest, Bridge -> built-in OpenAI-compatible evaluator -> SQLite)",
);
