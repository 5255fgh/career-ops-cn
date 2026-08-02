import { BridgeSettingsSchema, type DecisionRequest, type DiagnosticEvent, type JobHistoryEntry, type ScanConfig } from '@career-ops-cn/shared';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';

import { createBridgeClient } from '../../lib/bridge-client';
import { createContentClient } from '../../lib/content-client';
import {
  loadExtensionSettings,
  saveBridgeToken,
  type ExtensionStorageArea,
} from '../../lib/extension-settings';
import {
  DEFAULT_SCAN_CONFIG,
  ScanController,
  type ScanState,
} from '../../lib/scan-controller';
import {
  SidePanelView,
  type ConnectionState,
  type HistoryFilter,
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
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
  const [historyError, setHistoryError] = useState('');
  const [decisionMessage, setDecisionMessage] = useState('');
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
      setHistory(await bridge.listJobs());
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
    setDecisionMessage('');
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

  const saveDecision = async (decision: DecisionRequest['decision']) => {
    const selected = scanState.results.find(
      (result) => result.card.job.jobId === selectedJobId,
    );
    if (bridge === null || controller === null || selected?.savedJob === undefined) {
      setDecisionMessage('当前职位尚未保存，无法记录判断。');
      return;
    }

    setDecisionMessage('正在保存判断…');
    try {
      const response = await bridge.saveDecision(selected.savedJob.id, { decision });
      controller.recordDecision(response);
      setDecisionMessage(`已记录 ${decision}。`);
      await refreshHistory();
    } catch (error) {
      setDecisionMessage(messageFromError(error));
    }
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
      history={history}
      historyFilter={historyFilter}
      historyError={historyError}
      decisionMessage={decisionMessage}
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
      onSelectJob={setSelectedJobId}
      onHistoryFilterChange={setHistoryFilter}
      onRefreshHistory={() => void refreshHistory()}
      onRefreshDiagnostics={() => void refreshDiagnostics()}
      onDecision={(decision) => void saveDecision(decision)}
    />
  );
}
