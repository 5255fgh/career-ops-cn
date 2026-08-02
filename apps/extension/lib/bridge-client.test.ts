import { JobCardSchema, JobDetailSchema } from '@career-ops-cn/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  BridgeClientError,
  BridgeUnavailableError,
  createBridgeClient,
  type FetchLike,
  toCreateJobRequest,
} from './bridge-client';

const fixtureJob = JobDetailSchema.parse({
  jobId: '123456789',
  title: '前端开发工程师',
  companyName: '示例科技',
  salaryText: '20-30K·14薪',
  location: '上海·浦东新区',
  experienceText: '3-5年',
  educationText: '本科',
  detailUrl: 'https://www.zhipin.com/job_detail/123456789.html',
  description: '负责招聘产品的前端功能开发与维护，要求熟悉 TypeScript 和 React。',
  identityVerified: true,
});

const fixtureCard = JobCardSchema.parse({
  jobId: fixtureJob.jobId,
  title: fixtureJob.title,
  companyName: fixtureJob.companyName,
  salaryText: fixtureJob.salaryText,
  location: fixtureJob.location,
  experienceText: fixtureJob.experienceText,
  educationText: fixtureJob.educationText,
  detailUrl: fixtureJob.detailUrl,
});

const savedJob = {
  id: 'job-1',
  source: 'boss',
  sourceJobId: fixtureJob.jobId,
  title: fixtureJob.title,
  company: fixtureJob.companyName,
  salary: fixtureJob.salaryText,
  location: fixtureJob.location,
  experience: fixtureJob.experienceText,
  education: fixtureJob.educationText,
  description: fixtureJob.description,
  url: fixtureJob.detailUrl,
  identityVerified: fixtureJob.identityVerified,
  firstSeenAt: '2026-08-01T10:00:00.000Z',
  lastSeenAt: '2026-08-01T10:00:00.000Z',
};

const evaluation = {
  score: 86,
  recommendation: 'apply',
  rawReport: '岗位技术方向与求职偏好较匹配。',
  archetype: 'Builder',
  legitimacy: 'high',
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Bridge client', () => {
  it('把 fixture JobDetail 映射成最小 CreateJob 请求', () => {
    expect(toCreateJobRequest(fixtureJob)).toEqual({
      source: 'boss',
      sourceJobId: '123456789',
      title: '前端开发工程师',
      company: '示例科技',
      salary: '20-30K·14薪',
      location: '上海·浦东新区',
      experience: '3-5年',
      education: '本科',
      description: '负责招聘产品的前端功能开发与维护，要求熟悉 TypeScript 和 React。',
      url: 'https://www.zhipin.com/job_detail/123456789.html',
      identityVerified: true,
    });
  });

  it('保留未经身份验证的 JobDetail 状态', () => {
    const unverifiedJob = JobDetailSchema.parse({
      ...fixtureJob,
      identityVerified: false,
    });

    expect(toCreateJobRequest(unverifiedJob).identityVerified).toBe(false);
  });

  it('通过 shared 契约创建、更新并恢复最近 scan run', async () => {
    const run = {
      id: 'scan-1',
      status: 'running' as const,
      phase: 'reading-list' as const,
      startedAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:01.000Z',
      finishedAt: null,
      pageCount: 1,
      discoveredCount: 10,
      newJobCount: 3,
      detailSuccessCount: 1,
      detailFailureCount: 0,
      aiSuccessCount: 0,
      aiFailureCount: 0,
      cacheHitCount: 0,
      stopReason: null,
      errorSummary: null,
      cancelRequested: false,
    };
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({ ...run, phase: 'starting' }))
      .mockResolvedValueOnce(jsonResponse(run))
      .mockResolvedValueOnce(jsonResponse({ run, jobs: [] }));
    const client = createBridgeClient({ token: 'test-token', fetchImpl: fetchMock });

    await expect(client.createScanRun()).resolves.toMatchObject({ id: 'scan-1' });
    await expect(
      client.updateScanRun('scan-1', {
        phase: 'reading-list',
        pageCount: 1,
        discoveredCount: 10,
      }),
    ).resolves.toEqual(run);
    await expect(client.latestScanRun()).resolves.toEqual({ run, jobs: [] });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:3847/scan-runs',
      'http://127.0.0.1:3847/scan-runs/scan-1/progress',
      'http://127.0.0.1:3847/scan-runs/latest',
    ]);
  });

  it('携带 token 顺序调用保存和评估接口，并校验响应', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(savedJob))
      .mockResolvedValueOnce(jsonResponse({ evaluation, cacheHit: false }));
    const client = createBridgeClient({
      token: 'test-token',
      baseUrl: 'http://127.0.0.1:9876/',
      fetchImpl: fetchMock,
    });

    const job = await client.saveJob(fixtureJob);
    const result = await client.evaluateJob(job.id);

    expect(job).toEqual(savedJob);
    expect(result).toEqual({ evaluation, cacheHit: false });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:9876/jobs',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(toCreateJobRequest(fixtureJob)),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:9876/jobs/job-1/evaluate',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    );
  });

  it('把连接失败报告为明确的 Bridge 离线错误', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const client = createBridgeClient({ token: 'test-token', fetchImpl });

    await expect(client.saveJob(fixtureJob)).rejects.toMatchObject({
      name: 'BridgeUnavailableError',
      message: expect.stringContaining('请确认 Bridge 已启动'),
    });
    await expect(client.saveJob(fixtureJob)).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  it('校验 health、screen、候选池和 diagnostics 的完整边界', async () => {
    const screening = [{ jobId: fixtureJob.jobId, matched: true, reasons: ['通过硬规则'] }];
    const candidate = {
      jobId: savedJob.id,
      decision: 'review' as const,
      note: '重点关注',
      applicationStatus: 'not_applied' as const,
      updatedAt: '2026-08-01T10:00:00.000Z',
    };
    const history = [{
      ...savedJob,
      latestScreening: screening[0],
      latestEvaluation: evaluation,
      candidate,
    }];
    const diagnosticRequest = {
      source: 'extension' as const,
      level: 'info' as const,
      event: 'detail_mapping',
      scanId: 'scan-1',
      expectedJobId: fixtureJob.jobId,
      actualJobId: fixtureJob.jobId,
    };
    const diagnostic = {
      ...diagnosticRequest,
      id: 'diag-1',
      createdAt: '2026-08-01T10:00:00.000Z',
    };
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(jsonResponse(screening))
      .mockResolvedValueOnce(jsonResponse(history))
      .mockResolvedValueOnce(jsonResponse(candidate))
      .mockResolvedValueOnce(jsonResponse(diagnostic))
      .mockResolvedValueOnce(jsonResponse([diagnostic]));
    const client = createBridgeClient({ token: 'test-token', fetchImpl: fetchMock });

    await expect(client.health()).resolves.toBe(true);
    await expect(client.screenJobs([fixtureCard])).resolves.toEqual(screening);
    await expect(client.listJobs()).resolves.toEqual(history);
    await expect(
      client.saveCandidate(savedJob.id, {
        decision: 'review',
        note: '重点关注',
        applicationStatus: 'not_applied',
      }),
    ).resolves.toEqual(candidate);
    await expect(client.recordDiagnostic(diagnosticRequest)).resolves.toEqual(diagnostic);
    await expect(client.listDiagnostics(20)).resolves.toEqual([diagnostic]);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:3847/health',
      'http://127.0.0.1:3847/screen',
      'http://127.0.0.1:3847/jobs',
      'http://127.0.0.1:3847/jobs/job-1/candidate',
      'http://127.0.0.1:3847/diagnostics',
      'http://127.0.0.1:3847/diagnostics?limit=20',
    ]);
  });

  it('保留 AbortError，让扫描控制器识别用户取消', async () => {
    const fetchImpl: FetchLike = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        );
      });
    const controller = new AbortController();
    const client = createBridgeClient({ token: 'test-token', fetchImpl });
    const request = client.listJobs(controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('拒绝 HTTP 错误和不符合 shared Schema 的响应', async () => {
    const httpErrorClient = createBridgeClient({
      token: 'test-token',
      fetchImpl: async () => jsonResponse({ error: 'unauthorized' }, 401),
    });
    const invalidResponseClient = createBridgeClient({
      token: 'test-token',
      fetchImpl: async () => jsonResponse({ id: 'job-1' }),
    });

    await expect(httpErrorClient.saveJob(fixtureJob)).rejects.toThrow('HTTP 401');
    await expect(invalidResponseClient.saveJob(fixtureJob)).rejects.toBeInstanceOf(
      BridgeClientError,
    );
  });
});
