import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  DecisionResponseSchema,
  DiagnosticEventRequestSchema,
  DiagnosticEventSchema,
  EvaluationResultSchema,
  JobHistoryEntrySchema,
  JobResponseSchema,
  ScanRunSchema,
  type DecisionRequest,
  type DecisionResponse,
  type DiagnosticEvent,
  type DiagnosticEventRequest,
  type EvaluationResult,
  type JobCard,
  type JobHistoryEntry,
  type JobResponse,
  type SaveJobRequest,
  type ScanRun,
  type UpdateScanRunRequest,
} from "@career-ops-cn/shared";

import type { EvaluationCacheMetadata } from "./evaluation-cache.js";
import {
  hashCanonical,
  normalizeJobDescription,
  sha256Text,
} from "./hashing.js";

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
  first_seen_at: string | null;
  last_seen_at: string | null;
  jd_hash: string | null;
  list_hash: string | null;
  last_scan_run_id: string | null;
  source_query: string | null;
}

interface ColumnRow {
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

interface ScanRunRow {
  id: string;
  status: string;
  phase: string;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  page_count: number;
  discovered_count: number;
  new_job_count: number;
  detail_success_count: number;
  detail_failure_count: number;
  ai_success_count: number;
  ai_failure_count: number;
  cache_hit_count: number;
  stop_reason: string | null;
  error_summary: string | null;
  cancel_requested_at: string | null;
}

const JOB_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["normalized_url", "TEXT"],
  ["experience", "TEXT"],
  ["education", "TEXT"],
  [
    "identity_verified",
    "INTEGER NOT NULL DEFAULT 0 CHECK (identity_verified IN (0, 1))",
  ],
  ["first_seen_at", "TEXT"],
  ["last_seen_at", "TEXT"],
  ["jd_hash", "TEXT"],
  ["list_hash", "TEXT"],
  ["last_scan_run_id", "TEXT"],
  ["source_query", "TEXT"],
];

const EVALUATION_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["company", "TEXT"],
  ["role", "TEXT"],
  ["archetype", "TEXT"],
  ["legitimacy", "TEXT"],
  ["jd_hash", "TEXT"],
  ["profile_hash", "TEXT"],
  ["rules_hash", "TEXT"],
  ["prompt_version", "TEXT"],
  ["model_id", "TEXT"],
  ["evaluation_schema_version", "TEXT"],
  ["input_hash", "TEXT"],
  ["cache_key", "TEXT"],
  ["created_at", "TEXT"],
  ["latency_ms", "INTEGER"],
];

const MAX_DIAGNOSTICS = 5_000;
const MAX_COMPLETED_SCAN_RUNS = 100;
const FAILED_SCAN_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_EVALUATIONS_PER_JOB = 3;

export interface JobUpsertResult {
  job: JobResponse;
  isNew: boolean;
  jdChanged: boolean;
  possibleDuplicateJobId?: string;
}

export type ObservedJob =
  | {
      sourceJobId: string;
      action: "read-detail";
      reason: "new" | "card-changed" | "missing-detail";
    }
  | {
      sourceJobId: string;
      action: "reuse";
      job: JobHistoryEntry;
    };

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

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set(
    (
      database.prepare(`PRAGMA table_info(${table})`).all() as unknown as
        ColumnRow[]
    ).map(({ name }) => name),
  );
}

function addMissingColumns(
  database: DatabaseSync,
  table: string,
  columns: ReadonlyArray<readonly [string, string]>,
): void {
  const existing = tableColumns(database, table);
  for (const [name, definition] of columns) {
    if (!existing.has(name)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

function jobListHash(input: {
  source: string;
  sourceJobId?: string | undefined;
  title: string;
  company: string;
  salary?: string | undefined;
  location?: string | undefined;
  experience?: string | undefined;
  education?: string | undefined;
  url?: string | undefined;
}): string {
  return hashCanonical({
    source: input.source,
    sourceJobId: input.sourceJobId,
    title: input.title,
    company: input.company,
    salary: input.salary,
    location: input.location,
    experience: input.experience,
    education: input.education,
    normalizedUrl: normalizeJobUrl(input.url),
  });
}

function backfillJobMetadata(database: DatabaseSync): void {
  const migratedAt = new Date().toISOString();
  database
    .prepare(
      `UPDATE jobs
       SET first_seen_at = COALESCE(first_seen_at, ?),
           last_seen_at = COALESCE(last_seen_at, first_seen_at, ?)`,
    )
    .run(migratedAt, migratedAt);

  const rows = database.prepare("SELECT * FROM jobs").all() as unknown as JobRow[];
  const update = database.prepare(
    "UPDATE jobs SET jd_hash = ?, list_hash = ?, normalized_url = ? WHERE id = ?",
  );
  for (const row of rows) {
    const normalizedUrl =
      row.normalized_url ?? normalizeJobUrl(row.url ?? undefined);
    const jdHash =
      row.jd_hash ??
      (row.description === null
        ? null
        : sha256Text(normalizeJobDescription(row.description)));
    const listHash =
      row.list_hash ??
      jobListHash({
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
        ...(row.url === null ? {} : { url: row.url }),
      });
    update.run(jdHash, listHash, normalizedUrl, row.id);
  }

  database
    .prepare("UPDATE evaluations SET created_at = COALESCE(created_at, ?)")
    .run(migratedAt);
}

export function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS scan_runs (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('running', 'completed', 'cancelled', 'interrupted', 'failed')),
      phase TEXT NOT NULL
        CHECK (phase IN ('starting', 'reading-list', 'screening', 'reading-details', 'evaluating', 'finished')),
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
      discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
      new_job_count INTEGER NOT NULL DEFAULT 0 CHECK (new_job_count >= 0),
      detail_success_count INTEGER NOT NULL DEFAULT 0 CHECK (detail_success_count >= 0),
      detail_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (detail_failure_count >= 0),
      ai_success_count INTEGER NOT NULL DEFAULT 0 CHECK (ai_success_count >= 0),
      ai_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (ai_failure_count >= 0),
      cache_hit_count INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit_count >= 0),
      stop_reason TEXT,
      error_summary TEXT,
      cancel_requested_at TEXT
    ) STRICT;

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
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      jd_hash TEXT,
      list_hash TEXT NOT NULL,
      last_scan_run_id TEXT REFERENCES scan_runs(id) ON DELETE SET NULL,
      source_query TEXT,
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
      legitimacy TEXT,
      jd_hash TEXT,
      profile_hash TEXT,
      rules_hash TEXT,
      prompt_version TEXT,
      model_id TEXT,
      evaluation_schema_version TEXT,
      input_hash TEXT,
      cache_key TEXT,
      created_at TEXT,
      latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0)
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
  `);

  addMissingColumns(database, "jobs", JOB_COLUMNS);
  addMissingColumns(database, "evaluations", EVALUATION_COLUMNS);
  backfillJobMetadata(database);

  database.exec(`
    CREATE INDEX IF NOT EXISTS jobs_normalized_url_idx
      ON jobs (source, normalized_url)
      WHERE normalized_url IS NOT NULL;

    CREATE INDEX IF NOT EXISTS jobs_last_scan_run_idx
      ON jobs (last_scan_run_id);

    CREATE UNIQUE INDEX IF NOT EXISTS evaluations_job_cache_key_idx
      ON evaluations (job_id, cache_key)
      WHERE cache_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS diagnostics_created_at_idx
      ON diagnostics (created_at DESC);

    CREATE INDEX IF NOT EXISTS scan_runs_updated_at_idx
      ON scan_runs (updated_at DESC);
  `);

  pruneStoredData(database);
}

function rowToJob(row: JobRow): JobResponse {
  if (row.first_seen_at === null || row.last_seen_at === null) {
    throw new Error("职位缺少 first_seen_at 或 last_seen_at。");
  }

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
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.url === null ? {} : { url: row.url }),
    identityVerified: row.identity_verified === 1,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    ...(row.jd_hash === null ? {} : { jdHash: row.jd_hash }),
    ...(row.last_scan_run_id === null
      ? {}
      : { lastScanRunId: row.last_scan_run_id }),
    ...(row.source_query === null ? {} : { sourceQuery: row.source_query }),
  });
}

function findJobRowForUpsert(
  database: DatabaseSync,
  input: Pick<
    SaveJobRequest,
    "source" | "sourceJobId" | "url"
  >,
  normalizedUrl: string | null,
): JobRow | undefined {
  if (input.sourceJobId !== undefined) {
    const sourceJobMatch = database
      .prepare("SELECT * FROM jobs WHERE source = ? AND source_job_id = ?")
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

export function saveJob(
  database: DatabaseSync,
  input: SaveJobRequest,
): JobUpsertResult {
  const normalizedUrl = normalizeJobUrl(input.url);
  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");

  try {
    const existing = findJobRowForUpsert(database, input, normalizedUrl);
    const id = existing?.id ?? randomUUID();
    const sourceJobId = input.sourceJobId ?? existing?.source_job_id ?? null;
    const jdHash =
      input.description === undefined
        ? existing?.jd_hash ?? null
        : sha256Text(normalizeJobDescription(input.description));
    const listHash = jobListHash(input);
    const firstSeenAt = existing?.first_seen_at ?? now;
    const lastScanRunId =
      input.scanRunId ?? existing?.last_scan_run_id ?? null;
    const sourceQuery = input.sourceQuery ?? existing?.source_query ?? null;

    const row = database
      .prepare(
        `
          INSERT INTO jobs (
            id, source, source_job_id, normalized_url, title, company,
            salary, location, experience, education, description, url,
            identity_verified, first_seen_at, last_seen_at, jd_hash,
            list_hash, last_scan_run_id, source_query
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            identity_verified = excluded.identity_verified,
            last_seen_at = excluded.last_seen_at,
            jd_hash = excluded.jd_hash,
            list_hash = excluded.list_hash,
            last_scan_run_id = excluded.last_scan_run_id,
            source_query = excluded.source_query
          RETURNING *
        `,
      )
      .get(
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
        firstSeenAt,
        now,
        jdHash,
        listHash,
        lastScanRunId,
        sourceQuery,
      ) as JobRow | undefined;

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
      isNew: existing === undefined,
      jdChanged:
        existing !== undefined &&
        existing.jd_hash !== null &&
        jdHash !== null &&
        existing.jd_hash !== jdHash,
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

function evaluationRowToResult(row: EvaluationRow): EvaluationResult {
  return EvaluationResultSchema.parse({
    score: row.score,
    recommendation: row.recommendation,
    rawReport: row.raw_report,
    ...(row.company === null ? {} : { company: row.company }),
    ...(row.role === null ? {} : { role: row.role }),
    ...(row.archetype === null ? {} : { archetype: row.archetype }),
    ...(row.legitimacy === null ? {} : { legitimacy: row.legitimacy }),
  });
}

function rowToJobHistory(
  database: DatabaseSync,
  row: JobRow,
): JobHistoryEntry {
  const evaluationRow = database
    .prepare(
      `SELECT score, recommendation, raw_report, company, role, archetype,
              legitimacy
       FROM evaluations
       WHERE job_id = ?
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(row.id) as EvaluationRow | undefined;
  const decisionRow = database
    .prepare("SELECT * FROM decisions WHERE job_id = ?")
    .get(row.id) as DecisionRow | undefined;

  return JobHistoryEntrySchema.parse({
    ...rowToJob(row),
    ...(evaluationRow === undefined
      ? {}
      : { latestEvaluation: evaluationRowToResult(evaluationRow) }),
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
}

export function findJobHistory(
  database: DatabaseSync,
  id: string,
): JobHistoryEntry | undefined {
  const row = database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
    | JobRow
    | undefined;
  return row === undefined ? undefined : rowToJobHistory(database, row);
}

export function listJobs(database: DatabaseSync): JobHistoryEntry[] {
  const jobs = database
    .prepare("SELECT * FROM jobs ORDER BY last_seen_at DESC, rowid DESC")
    .all() as unknown as JobRow[];
  return jobs.map((row) => rowToJobHistory(database, row));
}

export function listJobsForScanRun(
  database: DatabaseSync,
  scanRunId: string,
): JobHistoryEntry[] {
  const jobs = database
    .prepare(
      "SELECT * FROM jobs WHERE last_scan_run_id = ? ORDER BY last_seen_at DESC, rowid DESC",
    )
    .all(scanRunId) as unknown as JobRow[];
  return jobs.map((row) => rowToJobHistory(database, row));
}

export function observeJobs(
  database: DatabaseSync,
  scanRunId: string,
  sourceQuery: string,
  jobs: readonly JobCard[],
): ObservedJob[] {
  const now = new Date().toISOString();
  const updateSeen = database.prepare(
    `UPDATE jobs
     SET source_job_id = COALESCE(source_job_id, ?),
         last_seen_at = ?,
         last_scan_run_id = ?,
         source_query = ?
     WHERE id = ?`,
  );

  database.exec("BEGIN IMMEDIATE");
  try {
    const observations = jobs.map((job): ObservedJob => {
      const candidate: SaveJobRequest = {
        source: "boss",
        sourceJobId: job.jobId,
        title: job.title,
        company: job.companyName,
        ...(job.salaryText === undefined ? {} : { salary: job.salaryText }),
        ...(job.location === undefined ? {} : { location: job.location }),
        ...(job.experienceText === undefined
          ? {}
          : { experience: job.experienceText }),
        ...(job.educationText === undefined
          ? {}
          : { education: job.educationText }),
        url: job.detailUrl,
        identityVerified: false,
        scanRunId,
        sourceQuery,
      };
      const existing = findJobRowForUpsert(
        database,
        candidate,
        normalizeJobUrl(job.detailUrl),
      );
      if (existing === undefined) {
        return {
          sourceJobId: job.jobId,
          action: "read-detail",
          reason: "new",
        };
      }

      updateSeen.run(job.jobId, now, scanRunId, sourceQuery, existing.id);
      const refreshed = database
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(existing.id) as unknown as JobRow;

      if (
        existing.description === null ||
        existing.url === null ||
        existing.identity_verified !== 1
      ) {
        return {
          sourceJobId: job.jobId,
          action: "read-detail",
          reason: "missing-detail",
        };
      }
      if (existing.list_hash !== jobListHash(candidate)) {
        return {
          sourceJobId: job.jobId,
          action: "read-detail",
          reason: "card-changed",
        };
      }
      return {
        sourceJobId: job.jobId,
        action: "reuse",
        job: rowToJobHistory(database, refreshed),
      };
    });
    database.exec("COMMIT");
    return observations;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function findEvaluationByCacheKey(
  database: DatabaseSync,
  jobId: string,
  cacheKey: string,
): EvaluationResult | undefined {
  const row = database
    .prepare(
      `SELECT score, recommendation, raw_report, company, role, archetype,
              legitimacy
       FROM evaluations
       WHERE job_id = ? AND cache_key = ?
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(jobId, cacheKey) as EvaluationRow | undefined;
  return row === undefined ? undefined : evaluationRowToResult(row);
}

export function saveEvaluation(
  database: DatabaseSync,
  jobId: string,
  evaluation: EvaluationResult,
  metadata: EvaluationCacheMetadata,
  latencyMs: number | undefined,
): void {
  database
    .prepare(
      `
        INSERT OR IGNORE INTO evaluations (
          id, job_id, score, recommendation, raw_report, company, role,
          archetype, legitimacy, jd_hash, profile_hash, rules_hash,
          prompt_version, model_id, evaluation_schema_version, input_hash,
          cache_key, created_at, latency_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      metadata.jdHash,
      metadata.profileHash,
      metadata.rulesHash,
      metadata.promptVersion,
      metadata.modelId,
      metadata.evaluationSchemaVersion,
      metadata.inputHash,
      metadata.cacheKey,
      new Date().toISOString(),
      latencyMs ?? null,
    );

  database
    .prepare(
      `DELETE FROM evaluations
       WHERE job_id = ?
         AND id NOT IN (
           SELECT id FROM evaluations
           WHERE job_id = ?
           ORDER BY rowid DESC
           LIMIT ?
         )`,
    )
    .run(jobId, jobId, MAX_EVALUATIONS_PER_JOB);
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
    ) as DecisionRow | undefined;

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
      randomUUID(),
      new Date().toISOString(),
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
  database.exec(
    `DELETE FROM diagnostics
     WHERE rowid NOT IN (
       SELECT rowid FROM diagnostics ORDER BY rowid DESC LIMIT ${MAX_DIAGNOSTICS}
     )`,
  );
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

function scanRunRowToScanRun(row: ScanRunRow): ScanRun {
  return ScanRunSchema.parse({
    id: row.id,
    status: row.status,
    phase: row.phase,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    pageCount: row.page_count,
    discoveredCount: row.discovered_count,
    newJobCount: row.new_job_count,
    detailSuccessCount: row.detail_success_count,
    detailFailureCount: row.detail_failure_count,
    aiSuccessCount: row.ai_success_count,
    aiFailureCount: row.ai_failure_count,
    cacheHitCount: row.cache_hit_count,
    stopReason: row.stop_reason,
    errorSummary: row.error_summary,
    cancelRequested: row.cancel_requested_at !== null,
  });
}

export function createScanRun(database: DatabaseSync): ScanRun {
  interruptRunningScanRuns(
    database,
    "superseded-by-new-run",
    "新的扫描已开始，旧任务被标记为 interrupted。",
  );
  const id = randomUUID();
  const now = new Date().toISOString();
  const row = database
    .prepare(
      `INSERT INTO scan_runs (
         id, status, phase, started_at, updated_at
       ) VALUES (?, 'running', 'starting', ?, ?)
       RETURNING *`,
    )
    .get(id, now, now) as ScanRunRow | undefined;
  if (row === undefined) {
    throw new Error("创建 scan run 后未能读取记录。");
  }
  pruneStoredData(database);
  return scanRunRowToScanRun(row);
}

export function findScanRun(
  database: DatabaseSync,
  id: string,
): ScanRun | undefined {
  const row = database
    .prepare("SELECT * FROM scan_runs WHERE id = ?")
    .get(id) as ScanRunRow | undefined;
  return row === undefined ? undefined : scanRunRowToScanRun(row);
}

export function findLatestScanRun(database: DatabaseSync): ScanRun | undefined {
  const row = database
    .prepare(
      `SELECT * FROM scan_runs
       ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,
                updated_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get() as ScanRunRow | undefined;
  return row === undefined ? undefined : scanRunRowToScanRun(row);
}

export function updateScanRun(
  database: DatabaseSync,
  id: string,
  patch: UpdateScanRunRequest,
): ScanRun | undefined {
  const currentRow = database
    .prepare("SELECT * FROM scan_runs WHERE id = ?")
    .get(id) as ScanRunRow | undefined;
  if (currentRow === undefined) {
    return undefined;
  }
  const alreadyTerminal = currentRow.status !== "running";
  if (alreadyTerminal && patch.status !== currentRow.status) {
    return scanRunRowToScanRun(currentRow);
  }

  const now = new Date().toISOString();
  const status = alreadyTerminal
    ? currentRow.status
    : patch.status ?? "running";
  const terminal = status !== "running";
  const row = database
    .prepare(
      `UPDATE scan_runs SET
         status = ?,
         phase = ?,
         updated_at = ?,
         finished_at = ?,
         page_count = ?,
         discovered_count = ?,
         new_job_count = ?,
         detail_success_count = ?,
         detail_failure_count = ?,
         ai_success_count = ?,
         ai_failure_count = ?,
         cache_hit_count = ?,
         stop_reason = ?,
         error_summary = ?
       WHERE id = ?
       RETURNING *`,
    )
    .get(
      status,
      terminal ? "finished" : patch.phase ?? currentRow.phase,
      now,
      terminal ? currentRow.finished_at ?? now : null,
      Math.max(currentRow.page_count, patch.pageCount ?? 0),
      Math.max(currentRow.discovered_count, patch.discoveredCount ?? 0),
      Math.max(currentRow.new_job_count, patch.newJobCount ?? 0),
      Math.max(
        currentRow.detail_success_count,
        patch.detailSuccessCount ?? 0,
      ),
      Math.max(
        currentRow.detail_failure_count,
        patch.detailFailureCount ?? 0,
      ),
      Math.max(currentRow.ai_success_count, patch.aiSuccessCount ?? 0),
      Math.max(currentRow.ai_failure_count, patch.aiFailureCount ?? 0),
      Math.max(currentRow.cache_hit_count, patch.cacheHitCount ?? 0),
      alreadyTerminal
        ? patch.stopReason ?? currentRow.stop_reason
        : patch.stopReason === undefined
          ? currentRow.stop_reason
          : patch.stopReason,
      alreadyTerminal
        ? patch.errorSummary ?? currentRow.error_summary
        : patch.errorSummary === undefined
          ? currentRow.error_summary
          : patch.errorSummary,
      id,
    ) as ScanRunRow | undefined;

  if (row === undefined) {
    throw new Error("更新 scan run 后未能读取记录。");
  }
  if (terminal) {
    pruneStoredData(database);
  }
  return scanRunRowToScanRun(row);
}

export function requestScanRunCancel(
  database: DatabaseSync,
  id: string,
): ScanRun | undefined {
  const now = new Date().toISOString();
  const row = database
    .prepare(
      `UPDATE scan_runs
       SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
           updated_at = ?
       WHERE id = ? AND status = 'running'
       RETURNING *`,
    )
    .get(now, now, id) as ScanRunRow | undefined;
  return row === undefined ? findScanRun(database, id) : scanRunRowToScanRun(row);
}

export function interruptScanRun(
  database: DatabaseSync,
  id: string,
  reason: string,
  errorSummary?: string,
): ScanRun | undefined {
  return updateScanRun(database, id, {
    status: "interrupted",
    phase: "finished",
    stopReason: reason,
    ...(errorSummary === undefined ? {} : { errorSummary }),
  });
}

export function interruptRunningScanRuns(
  database: DatabaseSync,
  reason: string,
  errorSummary?: string,
): number {
  const now = new Date().toISOString();
  const result = database
    .prepare(
      `UPDATE scan_runs
       SET status = 'interrupted',
           phase = 'finished',
           updated_at = ?,
           finished_at = ?,
           stop_reason = ?,
           error_summary = COALESCE(?, error_summary)
       WHERE status = 'running'`,
    )
    .run(now, now, reason, errorSummary ?? null);
  if (result.changes > 0) {
    pruneStoredData(database);
  }
  return Number(result.changes);
}

export function pruneStoredData(database: DatabaseSync): void {
  const failedCutoff = new Date(
    Date.now() - FAILED_SCAN_RUN_RETENTION_MS,
  ).toISOString();
  database.exec(`
    DELETE FROM diagnostics
    WHERE rowid NOT IN (
      SELECT rowid FROM diagnostics ORDER BY rowid DESC LIMIT ${MAX_DIAGNOSTICS}
    );

    DELETE FROM scan_runs
    WHERE status = 'completed'
      AND id NOT IN (
        SELECT id FROM scan_runs
        WHERE status = 'completed'
        ORDER BY finished_at DESC, rowid DESC
        LIMIT ${MAX_COMPLETED_SCAN_RUNS}
      );

    DELETE FROM evaluations
    WHERE id IN (
      SELECT id
      FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY job_id
                 ORDER BY rowid DESC
               ) AS version_rank
        FROM evaluations
      )
      WHERE version_rank > ${MAX_EVALUATIONS_PER_JOB}
    );
  `);
  database
    .prepare(
      `DELETE FROM scan_runs
       WHERE status IN ('failed', 'interrupted', 'cancelled')
         AND finished_at IS NOT NULL
         AND finished_at < ?`,
    )
    .run(failedCutoff);
  database.exec(`
    UPDATE jobs
    SET last_scan_run_id = NULL
    WHERE last_scan_run_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM scan_runs WHERE scan_runs.id = jobs.last_scan_run_id
      );
  `);
}
