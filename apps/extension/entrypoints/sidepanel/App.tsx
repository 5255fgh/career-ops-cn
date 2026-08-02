import {
  BridgeSettingsSchema,
  type ApplicationStatus,
  type CandidateDecision,
  type DiagnosticEvent,
  type JobHistoryEntry,
  type ScanConfig,
} from '@career-ops-cn/shared';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';

import { createBridgeClient } from '../../lib/bridge-client';
import {
  filterAndSortCandidates,
  type ApplicationStatusFilter,
  type CandidateDecisionFilter,
  type CandidateSort,
} from '../../lib/candidate-pool';
import { createContentClient } from '../../lib/content-client';
import {
  loadExtensionSettings,
  saveBridgeToken,
  type ExtensionStorageArea,
} from '../../lib/extension-settings';
import {
  serializeJobsAsCsv,
  serializeJobsAsJson,
} from '../../lib/job-export';
import {
  DEFAULT_SCAN_CONFIG,
  ScanController,
  type ScanState,
} from '../../lib/scan-controller';
import {
  SidePanelView,
  type ConnectionState,
  type PageSnapshot,
} from './SidePanelView';

const extensionStorage: ExtensionStorageArea = {
  async get(keys) {
    return browser.storage.local.get(keys);
  },
  async set(items) {
    await browser.storage.local.set(items);
  },
};

const IDLE_SCAN_STATE: ScanState = {
  runId: null,
  status: 'idle',
  progress: {
    pagesVisited: 0,
    listJobs: 0,
    newJobs: 0,
    screenedJobs: 0,
    detailCompleted: 0,
    detailTarget: 0,
    detailSuccess: 0,
    detailFailure: 0,
    aiCompleted: 0,
    aiTarget: 0,
    aiSuccess: 0,
    aiFailure: 0,
    cacheHits: 0,
  },
  results: [],
  stopReason: null,
  error: null,
  warnings: [],
};

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败。';
}

function downloadTextFile(
  contents: string,
  filename: string,
  mediaType: string,
): void {
  const url = URL.createObjectURL(
    new Blob([contents], { type: `${mediaType};charset=utf-8` }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function App() {
  const content = useMemo(() => createContentClient(), []);
  const [tokenDraft, setTokenDraft] = useState('');
  const [savedToken, setSavedToken] = useState('');
  const [scanConfig, setScanConfig] = useState<ScanConfig>(DEFAULT_SCAN_CONFIG);
  const [connectionState, setConnectionState] = useState<ConnectionState>('unknown');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [pageSnapshot, setPageSnapshot] = useState<PageSnapshot | null>(null);
  const [pageError, setPageError] = useState('');
  const [scanState, setScanState] = useState<ScanState>(IDLE_SCAN_STATE);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [history, setHistory] = useState<JobHistoryEntry[]>([]);
  const [candidateDecisionFilter, setCandidateDecisionFilter] =
    useState<CandidateDecisionFilter>('all');
  const [applicationStatusFilter, setApplicationStatusFilter] =
    useState<ApplicationStatusFilter>('all');
  const [candidateSort, setCandidateSort] =
    useState<CandidateSort>('last-seen-desc');
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    null,
  );
  const [candidateDecision, setCandidateDecision] =
    useState<CandidateDecision>('review');
  const [candidateNote, setCandidateNote] = useState('');
  const [applicationStatus, setApplicationStatus] =
    useState<ApplicationStatus>('not_applied');
  const [historyError, setHistoryError] = useState('');
  const [candidateMessage, setCandidateMessage] = useState('');
  const [exportMessage, setExportMessage] = useState('');
  const [diagnostics, setDiagnostics] = useState<DiagnosticEvent[]>([]);
  const [diagnosticsError, setDiagnosticsError] = useState('');

  const bridge = useMemo(
    () => (savedToken === '' ? null : createBridgeClient({ token: savedToken })),
    [savedToken],
  );
  const controller = useMemo(
    () =>
      bridge === null
        ? null
        : new ScanController({ content, bridge, config: scanConfig }),
    [bridge, content, scanConfig],
  );
  const visibleCandidates = useMemo(
    () =>
      filterAndSortCandidates(history, {
        decision: candidateDecisionFilter,
        applicationStatus: applicationStatusFilter,
        sort: candidateSort,
      }),
    [
      applicationStatusFilter,
      candidateDecisionFilter,
      candidateSort,
      history,
    ],
  );
  const selectedCandidate = history.find(
    ({ id }) => id === selectedCandidateId,
  );

  const refreshPage = useCallback(async () => {
    setPageError('');
    try {
      const [page, visible] = await Promise.all([
        content.detectPage(),
        content.extractVisibleCards(),
      ]);
      setPageSnapshot({
        pageType: page.pageType,
        block: page.block,
        jobCount: visible.totalVisible,
        invalidCount: visible.invalidCount,
      });
    } catch (error) {
      setPageError(messageFromError(error));
    }
  }, [content]);

  const refreshHistory = useCallback(async () => {
    if (bridge === null) {
      setHistory([]);
      return;
    }
    setHistoryError('');
    try {
      const jobs = await bridge.listJobs();
      setHistory(jobs);
      setSelectedCandidateId((current) =>
        current !== null && jobs.some(({ id }) => id === current)
          ? current
          : jobs[0]?.id ?? null,
      );
    } catch (error) {
      setHistoryError(messageFromError(error));
    }
  }, [bridge]);

  const refreshDiagnostics = useCallback(async () => {
    if (bridge === null) {
      setDiagnostics([]);
      return;
    }
    try {
      setDiagnostics(await bridge.listDiagnostics(100));
      setDiagnosticsError('');
    } catch (error) {
      setDiagnosticsError(messageFromError(error));
    }
  }, [bridge]);

  const refreshLatestScanRun = useCallback(async () => {
    if (bridge === null || controller === null) {
      return;
    }
    try {
      const snapshot = await bridge.latestScanRun();
      if (snapshot !== null) {
        controller.restore(snapshot);
      }
    } catch (error) {
      setConnectionMessage(`最近扫描状态读取失败：${messageFromError(error)}`);
    }
  }, [bridge, controller]);

  useEffect(() => {
    let disposed = false;
    void loadExtensionSettings(extensionStorage)
      .then((settings) => {
        if (!disposed) {
          setScanConfig(settings.scanConfig);
          if (settings.bridgeToken !== null) {
            setTokenDraft(settings.bridgeToken);
            setSavedToken(settings.bridgeToken);
          }
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setConnectionMessage(`无法读取本地设置：${messageFromError(error)}`);
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (controller === null) {
      setScanState(IDLE_SCAN_STATE);
      return;
    }
    const unsubscribe = controller.subscribe(setScanState);
    const interruptOnPageHide = () => {
      void controller.interrupt('side-panel-closed');
    };
    window.addEventListener('pagehide', interruptOnPageHide);
    return () => {
      window.removeEventListener('pagehide', interruptOnPageHide);
      unsubscribe();
      void controller.interrupt('side-panel-closed');
    };
  }, [controller]);

  useEffect(() => {
    void refreshPage();
  }, [refreshPage]);

  useEffect(() => {
    if (bridge === null) {
      return;
    }
    let disposed = false;
    setConnectionState('checking');
    void bridge
      .health()
      .then((online) => {
        if (!disposed) {
          setConnectionState(online ? 'online' : 'offline');
          setConnectionMessage(online ? 'Token 已保存，Bridge 连接正常。' : 'Bridge 健康检查失败。');
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setConnectionState('offline');
          setConnectionMessage(messageFromError(error));
        }
      });
    void Promise.all([
      refreshHistory(),
      refreshDiagnostics(),
      refreshLatestScanRun(),
    ]);
    return () => {
      disposed = true;
    };
  }, [bridge, refreshDiagnostics, refreshHistory, refreshLatestScanRun]);

  useEffect(() => {
    if (
      scanState.results.length > 0 &&
      !scanState.results.some((result) => result.card.job.jobId === selectedJobId)
    ) {
      setSelectedJobId(scanState.results[0]?.card.job.jobId ?? null);
    }
  }, [scanState.results, selectedJobId]);

  useEffect(() => {
    if (selectedCandidate === undefined) {
      return;
    }
    setCandidateDecision(selectedCandidate.candidate?.decision ?? 'review');
    setCandidateNote(selectedCandidate.candidate?.note ?? '');
    setApplicationStatus(
      selectedCandidate.candidate?.applicationStatus ?? 'not_applied',
    );
    setCandidateMessage('');
  }, [selectedCandidateId, selectedCandidate?.candidate?.updatedAt]);

  useEffect(() => {
    if (
      selectedCandidateId !== null &&
      visibleCandidates.some(({ id }) => id === selectedCandidateId)
    ) {
      return;
    }
    setSelectedCandidateId(visibleCandidates[0]?.id ?? null);
  }, [selectedCandidateId, visibleCandidates]);

  const saveConnection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const settings = BridgeSettingsSchema.safeParse({ bridgeToken: tokenDraft });
    if (!settings.success) {
      setConnectionState('offline');
      setConnectionMessage('请输入 Bridge token。');
      return;
    }

    setConnectionState('checking');
    setConnectionMessage('正在保存并检查 Bridge…');
    let tokenSaved = false;
    try {
      await saveBridgeToken(extensionStorage, settings.data.bridgeToken);
      tokenSaved = true;
      setSavedToken(settings.data.bridgeToken);
      const online = await createBridgeClient({
        token: settings.data.bridgeToken,
      }).health();
      setConnectionState(online ? 'online' : 'offline');
      setConnectionMessage(online ? 'Token 已保存，Bridge 连接正常。' : 'Token 已保存，但 Bridge 未通过健康检查。');
    } catch (error) {
      setConnectionState('offline');
      setConnectionMessage(
        tokenSaved
          ? `Token 已保存，但连接失败：${messageFromError(error)}`
          : `Token 保存失败：${messageFromError(error)}`,
      );
    }
  };

  const startScan = async () => {
    if (controller === null) {
      setConnectionMessage('请先保存有效的 Bridge token。');
      return;
    }
    setCandidateMessage('');
    await controller.run();
    await Promise.all([
      refreshPage(),
      refreshHistory(),
      refreshDiagnostics(),
    ]);
  };

  const cancelScan = async () => {
    await controller?.cancel();
  };

  const saveCandidate = async () => {
    if (bridge === null || selectedCandidate === undefined) {
      setCandidateMessage('请选择一个已保存的职位。');
      return;
    }

    setCandidateMessage('正在保存候选池记录…');
    try {
      const candidate = await bridge.saveCandidate(selectedCandidate.id, {
        decision: candidateDecision,
        note: candidateNote.trim() === '' ? null : candidateNote,
        applicationStatus,
      });
      setHistory((jobs) =>
        jobs.map((job) =>
          job.id === selectedCandidate.id ? { ...job, candidate } : job,
        ),
      );
      controller?.recordCandidate(candidate);
      setCandidateMessage('候选池记录已保存。');
    } catch (error) {
      setCandidateMessage(messageFromError(error));
    }
  };

  const exportCandidates = (format: 'csv' | 'json') => {
    if (visibleCandidates.length === 0) {
      setExportMessage('当前筛选结果为空，未生成导出文件。');
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      downloadTextFile(
        serializeJobsAsCsv(visibleCandidates),
        `career-ops-cn-${date}.csv`,
        'text/csv',
      );
    } else {
      downloadTextFile(
        serializeJobsAsJson(visibleCandidates),
        `career-ops-cn-${date}.json`,
        'application/json',
      );
    }
    setExportMessage(`已导出 ${visibleCandidates.length} 个职位。`);
  };

  return (
    <SidePanelView
      tokenDraft={tokenDraft}
      connectionState={connectionState}
      connectionMessage={connectionMessage}
      pageSnapshot={pageSnapshot}
      pageError={pageError}
      scanState={scanState}
      selectedJobId={selectedJobId}
      candidates={visibleCandidates}
      candidateTotal={history.length}
      candidateDecisionFilter={candidateDecisionFilter}
      applicationStatusFilter={applicationStatusFilter}
      candidateSort={candidateSort}
      selectedCandidateId={selectedCandidateId}
      candidateDecision={candidateDecision}
      candidateNote={candidateNote}
      applicationStatus={applicationStatus}
      historyError={historyError}
      candidateMessage={candidateMessage}
      exportMessage={exportMessage}
      diagnostics={diagnostics}
      diagnosticsError={diagnosticsError}
      onTokenChange={(value) => {
        setTokenDraft(value);
        setConnectionMessage('');
      }}
      onSaveConnection={(event) => void saveConnection(event)}
      onRefreshPage={() => void refreshPage()}
      onStartScan={() => void startScan()}
      onCancelScan={() => void cancelScan()}
      onSelectJob={(jobId) => {
        setSelectedJobId(jobId);
        const savedJobId = scanState.results.find(
          (result) => result.card.job.jobId === jobId,
        )?.savedJob?.id;
        if (savedJobId !== undefined) {
          setSelectedCandidateId(savedJobId);
        }
      }}
      onCandidateDecisionFilterChange={setCandidateDecisionFilter}
      onApplicationStatusFilterChange={setApplicationStatusFilter}
      onCandidateSortChange={setCandidateSort}
      onSelectCandidate={setSelectedCandidateId}
      onCandidateDecisionChange={setCandidateDecision}
      onCandidateNoteChange={setCandidateNote}
      onApplicationStatusChange={setApplicationStatus}
      onRefreshHistory={() => void refreshHistory()}
      onSaveCandidate={() => void saveCandidate()}
      onExport={exportCandidates}
      onRefreshDiagnostics={() => void refreshDiagnostics()}
    />
  );
}
