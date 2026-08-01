import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  DecisionResponseSchema,
  DiagnosticEventRequestSchema,
  DiagnosticEventSchema,
  EvaluationResultSchema,
  JobHistoryEntrySchema,
  JobResponseSchema,
  type CreateJobRequest,
  type DecisionRequest,
  type DecisionResponse,
  type DiagnosticEvent,
  type DiagnosticEventRequest,
  type EvaluationResult,
  type JobHistoryEntry,
  type JobResponse,
} from "@career-ops-cn/shared";

interface JobRow {
  id: string;
  source: string;
  source_job_id: string | null;
  normalized_url: string | null;
  title: string;
  company: string;
  salary: string | null;
  location: string | null;
  experience: string | null;
  education: string | null;
  description: string | null;
  url: string | null;
  identity_verified: number;
}

interface JobColumnRow {
  name: string;
}

interface EvaluationRow {
  score: number;
  recommendation: string;
  raw_report: string;
  company: string | null;
  role: string | null;
  archetype: string | null;
  legitimacy: string | null;
}

interface DecisionRow {
  job_id: string;
  decision: string;
  reason: string | null;
  outcome: string | null;
}

interface DiagnosticRow {
  id: string;
  created_at: string;
  source: string;
  level: string;
  event: string;
  scan_id: string | null;
  job_id: string | null;
  expected_job_id: string | null;
  actual_job_id: string | null;
  expected_title: string | null;
  actual_title: string | null;
  outcome: string | null;
  message: string | null;
  details_json: string | null;
}

const JOB_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["normalized_url", "TEXT"],
  ["experience", "TEXT"],
  ["education", "TEXT"],
  [
    "identity_verified",
    "INTEGER NOT NULL DEFAULT 0 CHECK (identity_verified IN (0, 1))",
  ],
];

const EVALUATION_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["company", "TEXT"],
  ["role", "TEXT"],
  ["archetype", "TEXT"],
  ["legitimacy", "TEXT"],
];

export interface JobUpsertResult {
  job: JobResponse;
  possibleDuplicateJobId?: string;
}

export function normalizeJobUrl(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.hostname = url.hostname.toLowerCase();

  if (url.port === "443") {
    url.port = "";
  }

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/u, "");
  }

  return url.toString();
}

export function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL,
      source_job_id TEXT,
      normalized_url TEXT,
      title TEXT NOT NULL,
      company TEXT NOT NULL,
      salary TEXT,
      location TEXT,
      experience TEXT,
      education TEXT,
      description TEXT,
      url TEXT,
      identity_verified INTEGER NOT NULL DEFAULT 0
        CHECK (identity_verified IN (0, 1)),
      UNIQUE (source, source_job_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
      recommendation TEXT NOT NULL,
      raw_report TEXT NOT NULL,
      company TEXT,
      role TEXT,
      archetype TEXT,
      legitimacy TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS decisions (
      job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      decision TEXT NOT NULL CHECK (decision IN ('apply', 'review', 'skip')),
      reason TEXT,
      outcome TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS diagnostics (
      id TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('extension', 'bridge')),
      level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
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

    CREATE INDEX IF NOT EXISTS jobs_normalized_url_idx
      ON jobs (source, normalized_url)
      WHERE normalized_url IS NOT NULL;

    CREATE INDEX IF NOT EXISTS diagnostics_created_at_idx
      ON diagnostics (created_at DESC);
  `);

  const existingColumns = new Set(
    (
      database.prepare("PRAGMA table_info(jobs)").all() as unknown as
        JobColumnRow[]
    ).map(({ name }) => name),
  );

  for (const [name, definition] of JOB_COLUMNS) {
    if (!existingColumns.has(name)) {
      database.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
  }

  const existingEvaluationColumns = new Set(
    (
      database.prepare("PRAGMA table_info(evaluations)").all() as unknown as
        JobColumnRow[]
    ).map(({ name }) => name),
  );

  for (const [name, definition] of EVALUATION_COLUMNS) {
    if (!existingEvaluationColumns.has(name)) {
      database.exec(`ALTER TABLE evaluations ADD COLUMN ${name} ${definition}`);
    }
  }

  const legacyRows = database
    .prepare(
      "SELECT id, url FROM jobs WHERE url IS NOT NULL AND normalized_url IS NULL",
    )
    .all() as Array<{ id: string; url: string }>;
  const updateNormalizedUrl = database.prepare(
    "UPDATE jobs SET normalized_url = ? WHERE id = ?",
  );
  for (const row of legacyRows) {
    updateNormalizedUrl.run(normalizeJobUrl(row.url), row.id);
  }
}

function rowToJob(row: JobRow): JobResponse {
  return JobResponseSchema.parse({
    id: row.id,
    source: row.source,
    ...(row.source_job_id === null
      ? {}
      : { sourceJobId: row.source_job_id }),
    title: row.title,
    company: row.company,
    ...(row.salary === null ? {} : { salary: row.salary }),
    ...(row.location === null ? {} : { location: row.location }),
    ...(row.experience === null ? {} : { experience: row.experience }),
    ...(row.education === null ? {} : { education: row.education }),
    ...(row.description === null
      ? {}
      : { description: row.description }),
    ...(row.url === null ? {} : { url: row.url }),
    identityVerified: row.identity_verified === 1,
  });
}

function findJobRowForUpsert(
  database: DatabaseSync,
  input: CreateJobRequest,
  normalizedUrl: string | null,
): JobRow | undefined {
  if (input.sourceJobId !== undefined) {
    const sourceJobMatch = database
      .prepare(
        "SELECT * FROM jobs WHERE source = ? AND source_job_id = ?",
      )
      .get(input.source, input.sourceJobId) as JobRow | undefined;

    if (sourceJobMatch !== undefined) {
      return sourceJobMatch;
    }
  }

  if (normalizedUrl === null) {
    return undefined;
  }

  return database
    .prepare(
      "SELECT * FROM jobs WHERE source = ? AND normalized_url = ? ORDER BY rowid LIMIT 1",
    )
    .get(input.source, normalizedUrl) as JobRow | undefined;
}

function jobValues(
  id: string,
  sourceJobId: string | null,
  normalizedUrl: string | null,
  input: CreateJobRequest,
): readonly (string | number | null)[] {
  return [
    id,
    input.source,
    sourceJobId,
    normalizedUrl,
    input.title,
    input.company,
    input.salary ?? null,
    input.location ?? null,
    input.experience ?? null,
    input.education ?? null,
    input.description ?? null,
    input.url ?? null,
    input.identityVerified ? 1 : 0,
  ];
}

export function saveJob(
  database: DatabaseSync,
  input: CreateJobRequest,
): JobUpsertResult {
  const normalizedUrl = normalizeJobUrl(input.url);
  database.exec("BEGIN IMMEDIATE");

  try {
    const existing = findJobRowForUpsert(database, input, normalizedUrl);
    const id = existing?.id ?? randomUUID();
    const sourceJobId = input.sourceJobId ?? existing?.source_job_id ?? null;
    const values = jobValues(id, sourceJobId, normalizedUrl, input);

    const row = database
      .prepare(
        `
          INSERT INTO jobs (
            id, source, source_job_id, normalized_url, title, company,
            salary, location, experience, education, description, url,
            identity_verified
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (id) DO UPDATE SET
            source = excluded.source,
            source_job_id = excluded.source_job_id,
            normalized_url = excluded.normalized_url,
            title = excluded.title,
            company = excluded.company,
            salary = excluded.salary,
            location = excluded.location,
            experience = excluded.experience,
            education = excluded.education,
            description = excluded.description,
            url = excluded.url,
            identity_verified = excluded.identity_verified
          RETURNING *
        `,
      )
      .get(...values) as JobRow | undefined;

    if (row === undefined) {
      throw new Error("保存职位后未能读取记录。");
    }

    const possibleDuplicate = database
      .prepare(
        `
          SELECT id
          FROM jobs
          WHERE id <> ?
            AND title = ? COLLATE NOCASE
            AND company = ? COLLATE NOCASE
          ORDER BY rowid
          LIMIT 1
        `,
      )
      .get(id, input.title, input.company) as { id: string } | undefined;

    database.exec("COMMIT");
    return {
      job: rowToJob(row),
      ...(possibleDuplicate === undefined
        ? {}
        : { possibleDuplicateJobId: possibleDuplicate.id }),
    };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function findJob(
  database: DatabaseSync,
  id: string,
): JobResponse | undefined {
  const row = database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
    | JobRow
    | undefined;

  return row === undefined ? undefined : rowToJob(row);
}

export function listJobs(database: DatabaseSync): JobHistoryEntry[] {
  const jobs = database
    .prepare("SELECT * FROM jobs ORDER BY rowid DESC")
    .all() as unknown as JobRow[];
  const latestEvaluation = database.prepare(
    `
      SELECT score, recommendation, raw_report, company, role, archetype,
             legitimacy
      FROM evaluations
      WHERE job_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `,
  );
  const decision = database.prepare(
    "SELECT * FROM decisions WHERE job_id = ?",
  );

  return jobs.map((row) => {
    const job = rowToJob(row);
    const evaluationRow = latestEvaluation.get(row.id) as
      | EvaluationRow
      | undefined;
    const decisionRow = decision.get(row.id) as DecisionRow | undefined;

    return JobHistoryEntrySchema.parse({
      ...job,
      ...(evaluationRow === undefined
        ? {}
        : {
            latestEvaluation: EvaluationResultSchema.parse({
              score: evaluationRow.score,
              recommendation: evaluationRow.recommendation,
              rawReport: evaluationRow.raw_report,
              company: evaluationRow.company,
              role: evaluationRow.role,
              archetype: evaluationRow.archetype,
              legitimacy: evaluationRow.legitimacy,
            }),
          }),
      ...(decisionRow === undefined
        ? {}
        : {
            decision: DecisionResponseSchema.parse({
              jobId: decisionRow.job_id,
              decision: decisionRow.decision,
              ...(decisionRow.reason === null
                ? {}
                : { reason: decisionRow.reason }),
              ...(decisionRow.outcome === null
                ? {}
                : { outcome: decisionRow.outcome }),
            }),
          }),
    });
  });
}

export function saveEvaluation(
  database: DatabaseSync,
  jobId: string,
  evaluation: EvaluationResult,
): void {
  database
    .prepare(
      `
        INSERT INTO evaluations (
          id, job_id, score, recommendation, raw_report, company, role,
          archetype, legitimacy
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      randomUUID(),
      jobId,
      evaluation.score,
      evaluation.recommendation,
      evaluation.rawReport,
      evaluation.company ?? null,
      evaluation.role ?? null,
      evaluation.archetype ?? null,
      evaluation.legitimacy ?? null,
    );
}

export function saveDecision(
  database: DatabaseSync,
  jobId: string,
  decision: DecisionRequest,
): DecisionResponse {
  const row = database
    .prepare(
      `
        INSERT INTO decisions (job_id, decision, reason, outcome)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (job_id) DO UPDATE SET
          decision = excluded.decision,
          reason = excluded.reason,
          outcome = excluded.outcome
        RETURNING *
      `,
    )
    .get(
      jobId,
      decision.decision,
      decision.reason ?? null,
      decision.outcome ?? null,
    ) as
    | {
        job_id: string;
        decision: string;
        reason: string | null;
        outcome: string | null;
      }
    | undefined;

  if (row === undefined) {
    throw new Error("保存决策后未能读取记录。");
  }

  return DecisionResponseSchema.parse({
    jobId: row.job_id,
    decision: row.decision,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
  });
}

function diagnosticRowToEvent(row: DiagnosticRow): DiagnosticEvent {
  return DiagnosticEventSchema.parse({
    id: row.id,
    createdAt: row.created_at,
    source: row.source,
    level: row.level,
    event: row.event,
    ...(row.scan_id === null ? {} : { scanId: row.scan_id }),
    ...(row.job_id === null ? {} : { jobId: row.job_id }),
    ...(row.expected_job_id === null
      ? {}
      : { expectedJobId: row.expected_job_id }),
    ...(row.actual_job_id === null
      ? {}
      : { actualJobId: row.actual_job_id }),
    ...(row.expected_title === null
      ? {}
      : { expectedTitle: row.expected_title }),
    ...(row.actual_title === null
      ? {}
      : { actualTitle: row.actual_title }),
    ...(row.outcome === null ? {} : { outcome: row.outcome }),
    ...(row.message === null ? {} : { message: row.message }),
    ...(row.details_json === null
      ? {}
      : { details: JSON.parse(row.details_json) as unknown }),
  });
}

export function saveDiagnostic(
  database: DatabaseSync,
  input: DiagnosticEventRequest,
): DiagnosticEvent {
  const diagnostic = DiagnosticEventRequestSchema.parse(input);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const row = database
    .prepare(
      `
        INSERT INTO diagnostics (
          id, created_at, source, level, event, scan_id, job_id,
          expected_job_id, actual_job_id, expected_title, actual_title,
          outcome, message, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `,
    )
    .get(
      id,
      createdAt,
      diagnostic.source,
      diagnostic.level,
      diagnostic.event,
      diagnostic.scanId ?? null,
      diagnostic.jobId ?? null,
      diagnostic.expectedJobId ?? null,
      diagnostic.actualJobId ?? null,
      diagnostic.expectedTitle ?? null,
      diagnostic.actualTitle ?? null,
      diagnostic.outcome ?? null,
      diagnostic.message ?? null,
      diagnostic.details === undefined
        ? null
        : JSON.stringify(diagnostic.details),
    ) as DiagnosticRow | undefined;

  if (row === undefined) {
    throw new Error("保存诊断记录后未能读取记录。");
  }
  return diagnosticRowToEvent(row);
}

export function listDiagnostics(
  database: DatabaseSync,
  limit: number,
): DiagnosticEvent[] {
  const rows = database
    .prepare("SELECT * FROM diagnostics ORDER BY rowid DESC LIMIT ?")
    .all(limit) as unknown as DiagnosticRow[];
  return rows.map(diagnosticRowToEvent);
}
