import {
  BridgeSettingsSchema,
  MockJobDetailRequestSchema,
  MockJobDetailResponseSchema,
  type EvaluationResult,
  type JobDetail,
} from '@career-ops-cn/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';

import { BridgeClientError, createBridgeClient } from '../../lib/bridge-client';

const BRIDGE_TOKEN_STORAGE_KEY = 'bridgeToken';

interface FlowResult {
  job: JobDetail;
  evaluation: EvaluationResult;
}

async function requestMockJobDetail(): Promise<JobDetail> {
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (activeTab?.id === undefined) {
    throw new Error('找不到当前浏览器标签页。');
  }

  const request = MockJobDetailRequestSchema.parse({ type: 'mock-job-detail/request' });

  let response: unknown;
  try {
    response = await browser.tabs.sendMessage(activeTab.id, request);
  } catch (error) {
    throw new Error('无法读取 Mock JobDetail。请打开 zhipin.com 页面并刷新后再试。', {
      cause: error,
    });
  }

  const parsed = MockJobDetailResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error('Content Script 返回的 Mock JobDetail 不符合 shared 契约。', {
      cause: parsed.error,
    });
  }

  return parsed.data.job;
}

function describeError(error: unknown): string {
  if (error instanceof BridgeClientError || error instanceof Error) {
    return error.message;
  }

  return '测试链路失败，请检查当前页面与 Bridge 状态。';
}

export function App() {
  const [token, setToken] = useState('');
  const [settingsMessage, setSettingsMessage] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [flowError, setFlowError] = useState('');
  const [result, setResult] = useState<FlowResult | null>(null);

  useEffect(() => {
    let disposed = false;

    void browser.storage.local
      .get(BRIDGE_TOKEN_STORAGE_KEY)
      .then((storedValue) => {
        const parsed = BridgeSettingsSchema.safeParse(storedValue);

        if (!disposed && parsed.success) {
          setToken(parsed.data.bridgeToken);
        }
      })
      .catch(() => {
        if (!disposed) {
          setSettingsMessage('无法读取已保存的 Bridge token。');
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  const saveToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = BridgeSettingsSchema.safeParse({ bridgeToken: token });

    if (!parsed.success) {
      setSettingsMessage('请输入 Bridge token。');
      return;
    }

    try {
      await browser.storage.local.set(parsed.data);
      setToken(parsed.data.bridgeToken);
      setSettingsMessage('Bridge token 已保存到本机扩展存储。');
    } catch {
      setSettingsMessage('Bridge token 保存失败。');
    }
  };

  const runTestFlow = async () => {
    const settings = BridgeSettingsSchema.safeParse({ bridgeToken: token });

    if (!settings.success) {
      setFlowError('请先输入并保存 Bridge token。');
      return;
    }

    setIsRunning(true);
    setFlowError('');
    setResult(null);

    try {
      const job = await requestMockJobDetail();
      const bridge = createBridgeClient({ token: settings.data.bridgeToken });
      const savedJob = await bridge.saveJob(job);
      const evaluation = await bridge.evaluateJob(savedJob.id);
      setResult({ job, evaluation });
    } catch (error) {
      setFlowError(describeError(error));
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <main className="panel">
      <p className="eyebrow">Career Ops CN</p>
      <h1>Mock 端到端链路</h1>

      <form className="token-form" onSubmit={(event) => void saveToken(event)}>
        <label htmlFor="bridge-token">Bridge token</label>
        <div className="token-row">
          <input
            id="bridge-token"
            type="password"
            value={token}
            autoComplete="off"
            placeholder="输入本机 Bridge token"
            onChange={(event) => {
              setToken(event.target.value);
              setSettingsMessage('');
            }}
          />
          <button className="secondary-button" type="submit">
            保存
          </button>
        </div>
        {settingsMessage === '' ? null : (
          <p className="form-message" role="status">
            {settingsMessage}
          </p>
        )}
      </form>

      <button
        className="primary-button"
        type="button"
        disabled={isRunning}
        onClick={() => void runTestFlow()}
      >
        {isRunning ? '测试中…' : '测试链路'}
      </button>

      {flowError === '' ? null : (
        <p className="error-message" role="alert">
          {flowError}
        </p>
      )}

      {result === null ? null : (
        <section className="result-card" aria-label="评估结果">
          <p className="result-label">Job</p>
          <h2>{result.job.title}</h2>
          <p className="company">{result.job.companyName}</p>

          <dl className="evaluation-summary">
            <div>
              <dt>Score</dt>
              <dd>{result.evaluation.score}</dd>
            </div>
            <div>
              <dt>Recommendation</dt>
              <dd>{result.evaluation.recommendation}</dd>
            </div>
          </dl>

          <div className="raw-report">
            <h3>Raw report</h3>
            <p>{result.evaluation.rawReport}</p>
          </div>
        </section>
      )}
    </main>
  );
}
