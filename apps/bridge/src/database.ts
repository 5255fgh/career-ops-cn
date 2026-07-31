import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  JobResponseSchema,
  type CreateJobRequest,
  type EvaluationResult,
  type JobResponse,
} from "@career-ops-cn/shared";

interface JobRow {
  id: string;
  source: string;
  source_job_id: string | null;
  title: string;
  company: string;
  salary: string | null;
  location: string | null;
  description: string | null;
  url: string | null;
}

export function initializeDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS jobs (
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

    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
      recommendation TEXT NOT NULL,
      raw_report TEXT NOT NULL
    ) STRICT;
  `);
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
    ...(row.description === null
      ? {}
      : { description: row.description }),
    ...(row.url === null ? {} : { url: row.url }),
  });
}

export function saveJob(
  database: DatabaseSync,
  input: CreateJobRequest,
): JobResponse {
  const values = [
    randomUUID(),
    input.source,
    input.sourceJobId ?? null,
    input.title,
    input.company,
    input.salary ?? null,
    input.location ?? null,
    input.description ?? null,
    input.url ?? null,
  ] as const;

  const sql = input.sourceJobId
    ? `
        INSERT INTO jobs (
          id, source, source_job_id, title, company,
          salary, location, description, url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source, source_job_id) DO UPDATE SET
          title = excluded.title,
          company = excluded.company,
          salary = excluded.salary,
          location = excluded.location,
          description = excluded.description,
          url = excluded.url
        RETURNING *
      `
    : `
        INSERT INTO jobs (
          id, source, source_job_id, title, company,
          salary, location, description, url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *
      `;

  const row = database.prepare(sql).get(...values) as JobRow | undefined;

  if (row === undefined) {
    throw new Error("保存职位后未能读取记录。");
  }

  return rowToJob(row);
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

export function saveEvaluation(
  database: DatabaseSync,
  jobId: string,
  evaluation: EvaluationResult,
): void {
  database
    .prepare(
      `
        INSERT INTO evaluations (
          id, job_id, score, recommendation, raw_report
        ) VALUES (?, ?, ?, ?, ?)
      `,
    )
    .run(
      randomUUID(),
      jobId,
      evaluation.score,
      evaluation.recommendation,
      evaluation.rawReport,
    );
}
