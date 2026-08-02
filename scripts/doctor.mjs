import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const checks = [];

function record(level, label, detail) {
  checks.push({ level, label, detail });
}

async function canAccess(path, mode = constants.F_OK) {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
record(
  nodeMajor === 24 ? 'ok' : 'fail',
  'Node.js',
  nodeMajor === 24 ? process.versions.node : `需要 24.x，当前为 ${process.versions.node}`,
);

const packageManager = process.env.npm_config_user_agent ?? '';
const pnpmMatch = /pnpm\/(\d+\.\d+\.\d+)/u.exec(packageManager);
record(
  pnpmMatch?.[1]?.startsWith('11.') ? 'ok' : 'fail',
  'pnpm',
  pnpmMatch?.[1] ?? '请通过 pnpm 11 运行 pnpm doctor',
);

const token = process.env.CAREER_OPS_CN_TOKEN?.trim() ?? '';
record(
  token.length > 0 ? 'ok' : 'fail',
  'Bridge token',
  token.length > 0 ? '已配置（值未显示）' : '缺少 CAREER_OPS_CN_TOKEN',
);

const careerOpsRoot = process.env.CAREER_OPS_CN_CAREER_OPS_ROOT?.trim() ?? '';
const evaluatorPath =
  careerOpsRoot === '' ? '' : join(careerOpsRoot, 'openai-eval.mjs');
record(
  evaluatorPath !== '' && (await canAccess(evaluatorPath)) ? 'ok' : 'fail',
  'career-ops evaluator',
  evaluatorPath === ''
    ? '缺少 CAREER_OPS_CN_CAREER_OPS_ROOT'
    : await canAccess(evaluatorPath)
      ? evaluatorPath
      : `${evaluatorPath} 不存在或不可读`,
);

const configuredDatabasePath =
  process.env.CAREER_OPS_CN_DATABASE_PATH?.trim() ??
  join(repositoryRoot, 'apps', 'bridge', 'career-ops-cn.sqlite');
const databasePath = isAbsolute(configuredDatabasePath)
  ? configuredDatabasePath
  : resolve(repositoryRoot, configuredDatabasePath);
record(
  await canAccess(dirname(databasePath), constants.W_OK) ? 'ok' : 'fail',
  'SQLite 目录',
  await canAccess(dirname(databasePath), constants.W_OK)
    ? dirname(databasePath)
    : `${dirname(databasePath)} 不存在或不可写`,
);

const extensionManifest = join(
  repositoryRoot,
  'apps',
  'extension',
  '.output',
  'chrome-mv3',
  'manifest.json',
);
record(
  (await canAccess(extensionManifest)) ? 'ok' : 'warn',
  'Extension 构建',
  (await canAccess(extensionManifest))
    ? extensionManifest
    : '尚未构建；运行 pnpm build 后再加载扩展',
);

if ((process.env.OPENAI_API_KEY?.trim() ?? '') === '') {
  record(
    'warn',
    'Evaluator 凭据',
    '当前环境未发现 OPENAI_API_KEY；若 career-ops 使用其他认证方式可忽略',
  );
} else {
  record('ok', 'Evaluator 凭据', '已配置（值未显示）');
}

const port = Number(process.env.CAREER_OPS_CN_BRIDGE_PORT ?? '3847');
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  record('fail', 'Bridge 端口', 'CAREER_OPS_CN_BRIDGE_PORT 必须是 1-65535');
} else {
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    if (!health.ok) {
      record('fail', 'Bridge 连接', `健康检查返回 HTTP ${health.status}`);
    } else if (token === '') {
      record('warn', 'Bridge 连接', 'Bridge 在线，但缺少 token，未检查业务接口');
    } else {
      const authorized = await fetch(`http://127.0.0.1:${port}/jobs`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_500),
      });
      record(
        authorized.ok ? 'ok' : 'fail',
        'Bridge 连接',
        authorized.ok
          ? `127.0.0.1:${port} 在线且 token 有效`
          : `业务接口返回 HTTP ${authorized.status}`,
      );
    }
  } catch {
    record(
      'warn',
      'Bridge 连接',
      `127.0.0.1:${port} 当前未启动；配置检查仍已完成`,
    );
  }
}

for (const check of checks) {
  const marker = check.level === 'ok' ? 'OK' : check.level === 'warn' ? 'WARN' : 'FAIL';
  console.log(`[${marker}] ${check.label}: ${check.detail}`);
}

const failures = checks.filter(({ level }) => level === 'fail').length;
const warnings = checks.filter(({ level }) => level === 'warn').length;
if (failures > 0) {
  console.error(`doctor: failed (${failures} failure(s), ${warnings} warning(s))`);
  process.exitCode = 1;
} else {
  console.log(`doctor: ok (${warnings} warning(s))`);
}
