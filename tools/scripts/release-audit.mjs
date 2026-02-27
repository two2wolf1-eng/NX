import { spawnSync } from 'node:child_process';
import { accessSync, constants, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspaceRoot = process.cwd();
const nxCli = path.join(workspaceRoot, 'node_modules', 'nx', 'bin', 'nx.js');
const reportPath = path.join(
  workspaceRoot,
  'dist',
  'reports',
  'release-audit-report.md',
);
const skipSecretScan = isEnabled('RELEASE_AUDIT_SKIP_SECRET_SCAN');
const skipNpmAudit = isEnabled('RELEASE_AUDIT_SKIP_NPM_AUDIT');
const repositoryExcludes = [
  ':(exclude)docs/agent-index/meta.json',
  ':(exclude,glob)**/next-env.d.ts',
];
const startedAt = new Date();
const steps = [];

let failed = false;
let failureMessage = '';

const environment = {
  node: process.version,
  os: `${os.platform()} ${os.release()} (${os.arch()})`,
  gitSha: safeRunCapture('git', ['rev-parse', 'HEAD']).trim() || 'unknown',
  nxVersion: getNxVersion(),
};

async function main() {
  try {
    await runPreflightStep();
    await runNxStep('Strict Acceptance Gate', [
      'run',
      'workspace-policy:acceptance',
    ]);
    await runFormatCheckStep();
    await runSecretScanStep();
    await runNpmAuditStep();
    await runRepositoryConsistencyStep();
  } catch (error) {
    failed = true;
    failureMessage = error instanceof Error ? error.message : String(error);
    console.error(`[release-audit] FAILED: ${failureMessage}`);
  } finally {
    ensureConfiguredSkipsAreRecorded();
    await writeReport();
  }

  if (failed) {
    process.exit(1);
  }
}

async function runPreflightStep() {
  runRequiredCommandCheck(
    'Preflight Node Command',
    'node -v',
    'node',
    ['-v'],
    'Preflight failed: missing command `node`. Add the Node 22 installation directory to PATH and retry.',
  );
  runRequiredCommandCheck(
    'Preflight Git Command',
    'git --version',
    'git',
    ['--version'],
    'Preflight failed: missing command `git`. Add Git to PATH and retry.',
  );
  runGitRootPreflight(
    'Preflight Git Root',
    'git rev-parse --show-toplevel',
  );
}

function runRequiredCommandCheck(name, display, command, args, errorMessage) {
  const raw = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const result = normalizePreflightResult(raw);
  recordStep(name, display, result);
  if (result.status !== 0) {
    throw new Error(errorMessage);
  }
}

function runGitRootPreflight(name, display) {
  const raw = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const result = normalizePreflightResult(raw);

  if (result.status !== 0) {
    recordStep(name, display, result);
    throw new Error(
      'Preflight failed: `git rev-parse --show-toplevel` failed. Run from the repository root and verify Git is available.',
    );
  }

  const gitRoot = result.stdout.trim();
  if (!gitRoot) {
    const failure = { status: 1, stdout: '', stderr: 'git root is empty' };
    recordStep(name, display, failure);
    throw new Error(
      'Preflight failed: unable to resolve git root. Run from the repository root and verify the Git repository is intact.',
    );
  }

  if (toComparablePath(gitRoot) !== toComparablePath(workspaceRoot)) {
    const failure = {
      status: 1,
      stdout: `cwd=${workspaceRoot}\ngitRoot=${gitRoot}`,
      stderr: '',
    };
    recordStep(name, display, failure);
    throw new Error(
      `Preflight failed: current directory is not the git root. Switch to ${gitRoot} and retry.`,
    );
  }

  recordStep(name, display, result);
}

function normalizePreflightResult(raw) {
  return {
    status: raw.error ? 1 : (raw.status ?? 1),
    stdout: raw.stdout ?? '',
    stderr: [raw.stderr ?? '', raw.error?.message ?? '']
      .filter((item) => item.length > 0)
      .join('\n'),
  };
}

async function runNxStep(name, nxArgs) {
  const display = `npx nx ${nxArgs.join(' ')}`;
  const result = runCommand(process.execPath, [nxCli, ...nxArgs], display);
  recordStep(name, display, result);
  if (result.status !== 0) {
    throw new Error(`${name} failed.`);
  }
}

async function runFormatCheckStep() {
  const command = 'npx nx format:check --all --libs-and-apps';
  if (!isFormatConfigured()) {
    process.stdout.write(
      '\n[release-audit] Skipped Format Check (format not configured)\n',
    );
    recordSkippedStep('Format Check', command, 'format not configured');
    return;
  }

  const result = runCommand(
    process.execPath,
    [nxCli, 'format:check', '--all', '--libs-and-apps'],
    command,
  );
  recordStep('Format Check', command, result);
  if (result.status !== 0) {
    throw new Error(
      'Format check failed. Run `npx nx format:write --all --libs-and-apps` and retry.',
    );
  }
}

async function runSecretScanStep() {
  const command = 'node release secret scan (git ls-files)';
  if (skipSecretScan) {
    process.stdout.write(
      '\n[release-audit] Skipped Secret Scan (RELEASE_AUDIT_SKIP_SECRET_SCAN=true)\n',
    );
    recordSkippedStep(
      'Secret Scan',
      command,
      'RELEASE_AUDIT_SKIP_SECRET_SCAN=true',
    );
    return;
  }

  const tracked = getTrackedFiles();
  const hits = [];
  let scannedTextFiles = 0;

  for (const relativePath of tracked) {
    if (shouldSkipByPath(relativePath)) {
      continue;
    }

    const basename = path.basename(relativePath);
    if (basename.startsWith('.env')) {
      hits.push({ file: relativePath, rule: 'tracked .env file' });
      continue;
    }

    const absolutePath = path.join(workspaceRoot, relativePath);
    let stat;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      continue;
    }

    if (!stat.isFile() || stat.size > 1024 * 1024) {
      continue;
    }

    const buffer = await fs.readFile(absolutePath);
    if (isBinary(buffer)) {
      continue;
    }

    scannedTextFiles += 1;
    const content = buffer.toString('utf8');
    collectSecretHits(relativePath, content, hits);
  }

  if (hits.length > 0) {
    const preview = hits.slice(0, 50);
    const summary = preview
      .map((hit) => `- ${hit.rule}: ${hit.file}`)
      .join('\n');
    const suffix =
      hits.length > preview.length
        ? `\n... and ${hits.length - preview.length} more`
        : '';
    const stdout = `Secret scan matches (${hits.length}):\n${summary}${suffix}`;
    recordStep('Secret Scan', command, { status: 1, stdout, stderr: '' });
    process.stderr.write(`${stdout}\n`);
    throw new Error(
      'Secret scan failed. Remove secrets from tracked files, rotate compromised credentials, and purge history if needed.',
    );
  }

  const stdout = `Secret scan passed: ${scannedTextFiles} tracked text files scanned.`;
  recordStep('Secret Scan', command, { status: 0, stdout, stderr: '' });
  process.stdout.write(`${stdout}\n`);
}

async function runNpmAuditStep() {
  const command = 'npm audit --omit=dev --audit-level=high';
  if (skipNpmAudit) {
    process.stdout.write(
      '\n[release-audit] Skipped npm audit (RELEASE_AUDIT_SKIP_NPM_AUDIT=true)\n',
    );
    recordSkippedStep(
      'NPM Audit',
      command,
      'RELEASE_AUDIT_SKIP_NPM_AUDIT=true',
    );
    return;
  }

  const result = runCommand(
    process.execPath,
    getNpmCliArgs(['audit', '--omit=dev', '--audit-level=high']),
    command,
  );
  recordStep('NPM Audit', command, result);
  if (result.status !== 0) {
    throw new Error(
      'npm audit failed (high-severity findings in production deps or network issue). Resolve findings or set RELEASE_AUDIT_SKIP_NPM_AUDIT=true for local debugging.',
    );
  }
}

async function runRepositoryConsistencyStep() {
  const name = 'Repository Consistency';
  const command = 'git diff --exit-code -- . ' + repositoryExcludes.join(' ');
  const diff = runCommand(
    'git',
    ['diff', '--exit-code', '--', '.', ...repositoryExcludes],
    command,
  );
  recordStep(name, command, diff);
  if (diff.status === 0) {
    return;
  }

  const statusCommand =
    'git status --porcelain -- . ' + repositoryExcludes.join(' ');
  const status = runCommand(
    'git',
    ['status', '--porcelain', '--', '.', ...repositoryExcludes],
    statusCommand,
  );
  recordStep('Repository Porcelain Status', statusCommand, status);
  throw new Error(
    `Repository has tracked diff after release audit. git status output:\n${
      (status.stdout || '').trim() || '(empty)'
    }`,
  );
}

function isFormatConfigured() {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8'),
    );
    const dependencies = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };
    if (!Object.prototype.hasOwnProperty.call(dependencies, 'prettier')) {
      return false;
    }

    if (pkg.prettier) {
      return true;
    }

    const configCandidates = [
      '.prettierrc',
      '.prettierrc.json',
      '.prettierrc.js',
      '.prettierrc.cjs',
      '.prettierrc.mjs',
      '.prettierrc.yaml',
      '.prettierrc.yml',
      'prettier.config.js',
      'prettier.config.cjs',
      'prettier.config.mjs',
    ];
    return configCandidates.some((candidate) =>
      pathExistsSync(path.join(workspaceRoot, candidate)),
    );
  } catch {
    return false;
  }
}

function collectSecretHits(relativePath, content, hits) {
  const checks = [
    { rule: 'private key marker', regex: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
    {
      rule: 'supabase service role key marker',
      regex: /\bSUPABASE_SERVICE_ROLE_KEY\b\s*[:=]\s*["'']?[A-Za-z0-9._-]{20,}/,
    },
    {
      rule: 'jwt-like token',
      regex:
        /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    },
    { rule: 'aws access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
    { rule: 'slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]+\b/ },
  ];

  for (const check of checks) {
    if (check.regex.test(content)) {
      hits.push({ file: relativePath, rule: check.rule });
    }
  }
}

function shouldSkipByPath(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  return (
    normalized.startsWith('docs/agent-index/') ||
    normalized.startsWith('dist/') ||
    normalized.startsWith('node_modules/') ||
    normalized.includes('/node_modules/')
  );
}

function isBinary(buffer) {
  return buffer.includes(0);
}

function getTrackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `Failed to list tracked files: ${(result.stderr ?? '').trim() || 'unknown error'}`,
    );
  }
  return (result.stdout || '').split('\0').filter(Boolean);
}

function getNpmCliArgs(args) {
  const npmCliPath = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );

  if (!pathExistsSync(npmCliPath)) {
    throw new Error(
      `npm CLI not found at expected path: ${npmCliPath}. Ensure Node 22.x with npm is installed.`,
    );
  }

  return [npmCliPath, ...args];
}

function runCommand(command, args, display) {
  process.stdout.write(`\n[release-audit] $ ${display}\n`);
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function safeRunCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if ((result.status ?? 1) !== 0) {
    return '';
  }
  return result.stdout ?? '';
}

function getNxVersion() {
  try {
    const nxPackagePath = path.join(
      workspaceRoot,
      'node_modules',
      'nx',
      'package.json',
    );
    const nxPackage = JSON.parse(readFileSync(nxPackagePath, 'utf8'));
    return nxPackage.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function toComparablePath(targetPath) {
  const normalized = path.resolve(targetPath).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function recordStep(name, command, result) {
  steps.push({
    name,
    command,
    status: result.status === 0 ? 'success' : 'failure',
    exitCode: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  });
}

function recordSkippedStep(name, command, reason) {
  steps.push({
    name,
    command: `${command} # skipped: ${reason}`,
    status: 'skipped',
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
}

function ensureConfiguredSkipsAreRecorded() {
  if (skipSecretScan && !steps.some((step) => step.name === 'Secret Scan')) {
    recordSkippedStep(
      'Secret Scan',
      'node release secret scan (git ls-files)',
      'RELEASE_AUDIT_SKIP_SECRET_SCAN=true (configured, step not reached)',
    );
  }

  if (skipNpmAudit && !steps.some((step) => step.name === 'NPM Audit')) {
    recordSkippedStep(
      'NPM Audit',
      'npm audit --omit=dev --audit-level=high',
      'RELEASE_AUDIT_SKIP_NPM_AUDIT=true (configured, step not reached)',
    );
  }
}

async function writeReport() {
  const finishedAt = new Date();
  const durationSeconds = Math.round(
    (finishedAt.getTime() - startedAt.getTime()) / 1000,
  );
  const lines = [
    '# Release Audit Report',
    '',
    `- Started: ${startedAt.toISOString()}`,
    `- Finished: ${finishedAt.toISOString()}`,
    `- Duration: ${durationSeconds}s`,
    `- Result: ${failed ? 'FAILED' : 'PASSED'}`,
    '',
    '## Environment',
    '',
    `- Git SHA: ${environment.gitSha}`,
    `- Node: ${environment.node}`,
    `- Nx: ${environment.nxVersion}`,
    `- OS: ${environment.os}`,
    `- Flags: RELEASE_AUDIT_SKIP_SECRET_SCAN=${skipSecretScan}, RELEASE_AUDIT_SKIP_NPM_AUDIT=${skipNpmAudit}`,
    '',
    '## Steps',
    '',
    '| Step | Status | Exit | Command |',
    '| --- | --- | --- | --- |',
    ...steps.map(
      (step) =>
        `| ${step.name} | ${step.status} | ${step.exitCode} | \`${escapePipes(step.command)}\` |`,
    ),
    '',
    '## Key Artifacts',
    '',
    '- dist/reports/release-audit-report.md',
    '- dist/reports/acceptance-report.md',
    '- dist/migrations/supabase-biz',
    '- dist/migrations/supabase-secret',
    '',
    '## Strict Runbook',
    '',
    '1. Ensure clean workspace: `git status --porcelain` must be empty.',
    '2. Normalize formatting: `npx nx format:write --all --libs-and-apps`.',
    '3. Install dependencies: `npm ci`.',
    '4. Run strict release audit: `npx nx run workspace-policy:release-audit`.',
  ];

  if (failed) {
    const failedStep = steps.find((step) => step.status === 'failure');
    const failureOutput = failedStep
      ? failedStep.stderr || failedStep.stdout
      : '';
    lines.push('', '## Failure Summary', '', `- ${failureMessage}`);
    if (failureOutput) {
      lines.push('', '```text', truncate(failureOutput, 4000), '```');
    }
  }

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`\n[release-audit] Report written to ${reportPath}\n`);
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n... (truncated)`;
}

function pathExistsSync(targetPath) {
  try {
    accessSync(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function escapePipes(text) {
  return text.replaceAll('|', '\\|');
}

function isEnabled(name) {
  return (
    String(process.env[name] ?? '')
      .trim()
      .toLowerCase() === 'true'
  );
}

await main();
