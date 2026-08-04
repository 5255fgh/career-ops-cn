import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  findJob,
  findJobHistory,
  initializeDatabase,
  saveDiagnostic,
  saveJob,
} from "../src/database.js";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("SQLite migration", () => {
  it("从旧 jobs/evaluations 结构补齐 scan run、增量和缓存字段", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY NOT NULL,
        source TEXT NOT NULL,
        source_job_id TEXT,
        title TEXT NOT NULL,
        company TEXT NOT NULL,
        salary TEXT,
        location TEXT,
        description TEXT,
        url TEXT,
        UNIQUE (source, source_job_id)
      ) STRICT;

      CREATE TABLE evaluations (
        id TEXT PRIMARY KEY NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        score INTEGER NOT NULL,
        recommendation TEXT NOT NULL,
        raw_report TEXT NOT NULL
      ) STRICT;

      CREATE TABLE decisions (
        job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        decision TEXT NOT NULL,
        reason TEXT,
        outcome TEXT
      ) STRICT;

      CREATE TABLE diagnostics (
        id TEXT PRIMARY KEY NOT NULL,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL,
        level TEXT NOT NULL,
        event TEXT NOT NULL,
        scan_id TEXT,
        job_id TEXT,
        expected_job_id TEXT,
        actual_job_id TEXT,
        expected_title TEXT,
        actual_title TEXT,
        outcome TEXT,
        message TEXT,
        details_json TEXT
      ) STRICT;

      INSERT INTO jobs (
        id, source, source_job_id, title, company, salary, location,
        description, url
      ) VALUES (
        'legacy-job', 'boss', 'legacy-1', '前端工程师', '示例科技',
        '20-30K', '上海', '负责 TypeScript 与 React 开发。',
        'https://www.zhipin.com/job_detail/legacy-1.html?ka=legacy'
      );

      INSERT INTO evaluations (
        id, job_id, score, recommendation, raw_report
      ) VALUES ('legacy-evaluation', 'legacy-job', 80, 'review', '旧评估');

      INSERT INTO evaluations (
        id, job_id, score, recommendation, raw_report
      ) VALUES
        ('legacy-evaluation-2', 'legacy-job', 81, 'review', '旧评估 2'),
        ('legacy-evaluation-3', 'legacy-job', 82, 'review', '旧评估 3'),
        ('legacy-evaluation-4', 'legacy-job', 83, 'review', '旧评估 4'),
        ('legacy-evaluation-5', 'legacy-job', 84, 'apply', '旧评估 5');

      INSERT INTO decisions (job_id, decision, reason, outcome)
      VALUES ('legacy-job', 'apply', '旧备注', 'applied');
    `);

    expect(() => initializeDatabase(database)).not.toThrow();

    const tables = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toContain("scan_runs");
    expect(tables.map(({ name }) => name)).toContain("candidate_records");
    expect(tables.map(({ name }) => name)).toContain("screenings");
    expect(tables.map(({ name }) => name)).not.toContain("decisions");

    const jobColumns = database
      .prepare("PRAGMA table_info(jobs)")
      .all() as Array<{ name: string }>;
    expect(jobColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "first_seen_at",
        "last_seen_at",
        "jd_hash",
        "list_hash",
        "last_scan_run_id",
        "source_query",
      ]),
    );

    const evaluationColumns = database
      .prepare("PRAGMA table_info(evaluations)")
      .all() as Array<{ name: string }>;
    expect(evaluationColumns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "profile_hash",
        "rules_hash",
        "prompt_version",
        "model_id",
        "evaluation_schema_version",
        "input_hash",
        "cache_key",
        "created_at",
        "latency_ms",
      ]),
    );

    expect(findJob(database, "legacy-job")).toMatchObject({
      id: "legacy-job",
      firstSeenAt: expect.any(String),
      lastSeenAt: expect.any(String),
      jdHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      identityVerified: false,
    });
    expect(findJobHistory(database, "legacy-job")?.candidate).toMatchObject({
      jobId: "legacy-job",
      decision: "apply",
      note: "旧备注",
      applicationStatus: "applied",
    });
    expect(
      database
        .prepare("SELECT created_at FROM evaluations WHERE id = ?")
        .get("legacy-evaluation-5"),
    ).toEqual({ created_at: expect.any(String) });
    expect(
      database
        .prepare("SELECT count(*) AS count FROM evaluations WHERE job_id = ?")
        .get("legacy-job"),
    ).toEqual({ count: 3 });
  });
});

describe("SQLite 隐私边界", () => {
  it("职位 URL 与 diagnostics 在落库前移除 volatile locator 和敏感内容", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    initializeDatabase(database);
    const canonicalUrl =
      "https://www.zhipin.com/job_detail/boss-safe-1.html";
    const rawUrl = `${canonicalUrl}?securityId=volatile#detail`;

    saveJob(database, {
      source: "boss",
      sourceJobId: "boss-safe-1",
      title: "前端工程师",
      company: "示例科技",
      description: "负责 TypeScript 与 React 产品开发。",
      url: rawUrl,
      identityVerified: true,
    });
    saveDiagnostic(database, {
      source: "extension",
      level: "warning",
      event: "detail_mapping",
      message: `Cookie: sid=secret; ${rawUrl}`,
      details: {
        originalDetailUrl: rawUrl,
        responseBody: "<html>secret response</html>",
        accessToken: "token-secret",
      },
    });

    expect(
      database
        .prepare("SELECT url, normalized_url FROM jobs")
        .get(),
    ).toEqual({ url: canonicalUrl, normalized_url: canonicalUrl });
    const diagnostic = database
      .prepare("SELECT message, details_json FROM diagnostics")
      .get() as { message: string; details_json: string };
    expect(JSON.stringify(diagnostic)).toContain(canonicalUrl);
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /securityId|sid=secret|secret response|token-secret/iu,
    );
  });
});
