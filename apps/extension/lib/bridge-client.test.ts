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

  it('携带 token 顺序调用保存和评估接口，并校验响应', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(savedJob))
      .mockResolvedValueOnce(jsonResponse(evaluation));
    const client = createBridgeClient({
      token: 'test-token',
      baseUrl: 'http://127.0.0.1:9876/',
      fetchImpl: fetchMock,
    });

    const job = await client.saveJob(fixtureJob);
    const result = await client.evaluateJob(job.id);

    expect(job).toEqual(savedJob);
    expect(result).toEqual(evaluation);
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
        headers: { Authorization: 'Bearer test-token' },
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

  it('校验 health、screen、history 和 decision 的完整边界', async () => {
    const screening = [{ jobId: fixtureJob.jobId, matched: true, reasons: ['通过硬规则'] }];
    const decision = { jobId: savedJob.id, decision: 'review' as const };
    const history = [{ ...savedJob, latestEvaluation: evaluation, decision }];
    const fetchMock = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(jsonResponse(screening))
      .mockResolvedValueOnce(jsonResponse(history))
      .mockResolvedValueOnce(jsonResponse(decision));
    const client = createBridgeClient({ token: 'test-token', fetchImpl: fetchMock });

    await expect(client.health()).resolves.toBe(true);
    await expect(client.screenJobs([fixtureCard])).resolves.toEqual(screening);
    await expect(client.listJobs()).resolves.toEqual(history);
    await expect(client.saveDecision(savedJob.id, { decision: 'review' })).resolves.toEqual(
      decision,
    );

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:3847/health',
      'http://127.0.0.1:3847/screen',
      'http://127.0.0.1:3847/jobs',
      'http://127.0.0.1:3847/jobs/job-1/decision',
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
