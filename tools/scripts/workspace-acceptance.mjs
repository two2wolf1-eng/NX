import { spawnSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspaceRoot = process.cwd();
const nxCli = path.join(workspaceRoot, 'node_modules', 'nx', 'bin', 'nx.js');
const reportPath = path.join(
  workspaceRoot,
  'dist',
  'reports',
  'acceptance-report.md',
);
const allowDirty = isEnabled('ACCEPTANCE_ALLOW_DIRTY');
const skipBuildAll = isEnabled('ACCEPTANCE_SKIP_BUILD_ALL');
const skipE2E = isEnabled('ACCEPTANCE_SKIP_E2E');
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
    await runGitIndexIntegrityStep();
    await runWorkspaceCleanlinessStep();
    await runNxStep('Workspace Policy Lint', ['run', 'workspace-policy:lint']);
    await runNxStep('Workspace Module Boundary Check', [
      'run',
      'workspace-policy:module-boundary-check',
    ]);
    await runNxStep('Sync Agent Index (1/2)', [
      'run',
      'ai-indexer:sync',
      '--skip-nx-cache',
    ]);
    await runNxStep('Sync Agent Index (2/2)', [
      'run',
      'ai-indexer:sync',
      '--skip-nx-cache',
    ]);
    await runGitDiffStep();
    await runNxStep('Validate Agent Index', [
      'run',
      'ai-indexer:validate',
      '--skip-nx-cache',
    ]);
    await runOptionalNxStep(
      'Run All Lint Test Build',
      ['run-many', '--targets=lint,test,build', '--all'],
      skipBuildAll,
      'ACCEPTANCE_SKIP_BUILD_ALL=true',
    );
    await runOptionalNxStep(
      'Run Web E2E',
      ['run', 'web-e2e:e2e'],
      skipE2E,
      'ACCEPTANCE_SKIP_E2E=true',
    );
    await runOptionalNxStep(
      'Run Admin E2E',
      ['run', 'admin-e2e:e2e'],
      skipE2E,
      'ACCEPTANCE_SKIP_E2E=true',
    );
    await runNxStep('Pack Biz Migrations', [
      'run',
      'supabase-biz:pack-migrations',
    ]);
    await runNxStep('Pack Secret Migrations', [
      'run',
      'supabase-secret:pack-migrations',
    ]);
    await runMigrationValidationStep();
    await runRepositoryConsistencyStep();
  } catch (error) {
    failed = true;
    failureMessage = error instanceof Error ? error.message : String(error);
    console.error(`[acceptance] FAILED: ${failureMessage}`);
  } finally {
    await writeReport();
  }

  if (failed) {
    process.exit(1);
  }
}

async function runPreflightStep() {
  runNodeVersionPreflight();
  runRequiredCommandCheck(
    'Preflight Git Command',
    'git --version',
    'git',
    ['--version'],
    'Preflight failed: missing command `git`. Add Git to PATH and retry.',
  );
  runGitRootPreflight('Preflight Git Root', 'git rev-parse --show-toplevel');
}

function runNodeVersionPreflight() {
  const display = 'node -p "process.versions.node"';
  const raw = spawnSync('node', ['-p', 'process.versions.node'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const result = normalizePreflightResult(raw);

  if (result.status !== 0) {
    recordStep('Preflight Node Version', display, result);
    throw new Error(
      'Preflight failed: missing command `node`. Please switch to Node 22 (nvm use 22 / or put the Node 22 installation directory first in PATH).',
    );
  }

  const detectedVersion = result.stdout.trim();
  const major = Number.parseInt(detectedVersion.split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major !== 22) {
    recordStep('Preflight Node Version', display, {
      status: 1,
      stdout: `got ${detectedVersion || 'unknown'}, expected 22.x`,
      stderr: '',
    });
    throw new Error(
      `Preflight failed: Node version mismatch (got ${detectedVersion || 'unknown'}, expected 22.x). Please switch to Node 22 (nvm use 22 / or put the Node 22 installation directory first in PATH).`,
    );
  }

  recordStep('Preflight Node Version', display, result);
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

async function runOptionalNxStep(name, nxArgs, skip, reason) {
  const display = `npx nx ${nxArgs.join(' ')}`;
  if (skip) {
    process.stdout.write(`\n[acceptance] Skipped ${name} (${reason})\n`);
    recordSkippedStep(name, display, reason);
    return;
  }
  await runNxStep(name, nxArgs);
}

async function runGitIndexIntegrityStep() {
  const name = 'Preflight Git Index Integrity';
  const display = 'git ls-files -z';
  const listResult = spawnSync('git', ['ls-files', '-z'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if ((listResult.status ?? 1) !== 0) {
    const failure = {
      status: listResult.status ?? 1,
      stdout: listResult.stdout ?? '',
      stderr: (listResult.stderr ?? '').trim(),
    };
    recordStep(name, display, failure);
    throw new Error(
      `Failed to read git index: ${failure.stderr || 'unknown error'}`,
    );
  }

  const trackedFiles = (listResult.stdout ?? '').split('\0').filter(Boolean);
  const missingFiles = [];
  for (const relativePath of trackedFiles) {
    const absolutePath = path.join(workspaceRoot, relativePath);
    if (!(await pathExists(absolutePath))) {
      missingFiles.push(relativePath);
    }
  }

  if (missingFiles.length > 0) {
    const preview = missingFiles.slice(0, 50);
    const suffix =
      missingFiles.length > preview.length
        ? `\n... and ${missingFiles.length - preview.length} more`
        : '';
    const stdout = `Missing tracked files (${missingFiles.length}):\n${preview.join('\n')}${suffix}`;
    recordStep(name, display, { status: 1, stdout, stderr: '' });
    process.stderr.write(`${stdout}\n`);
    throw new Error(
      'Git index references missing files. Run `git add -u` (or restore/clean the index) and retry.',
    );
  }

  const stdout = `Checked ${trackedFiles.length} tracked files; all exist on disk.`;
  recordStep(name, display, { status: 0, stdout, stderr: '' });
  process.stdout.write(`${stdout}\n`);
}

async function runWorkspaceCleanlinessStep() {
  const name = 'Preflight Clean Workspace';
  const display = 'git status --porcelain -- . ' + repositoryExcludes.join(' ');
  if (allowDirty) {
    process.stdout.write(
      `\n[acceptance] Skipped ${name} (ACCEPTANCE_ALLOW_DIRTY=true)\n`,
    );
    recordSkippedStep(name, display, 'ACCEPTANCE_ALLOW_DIRTY=true');
    return;
  }

  const statusResult = spawnSync(
    'git',
    ['status', '--porcelain', '--', '.', ...repositoryExcludes],
    {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );
  const porcelain = (statusResult.stdout ?? '').trim();
  const isDirty = porcelain.length > 0;
  const result = {
    status: (statusResult.status ?? 1) === 0 && !isDirty ? 0 : 1,
    stdout: porcelain,
    stderr: (statusResult.stderr ?? '').trim(),
  };
  recordStep(name, display, result);

  if ((statusResult.status ?? 1) !== 0) {
    throw new Error(
      `Failed to inspect workspace status: ${result.stderr || 'unknown error'}`,
    );
  }
  if (isDirty) {
    process.stderr.write(`${porcelain}\n`);
    throw new Error(
      'Workspace is dirty. Commit/stage/clean changes or set ACCEPTANCE_ALLOW_DIRTY=true for local debugging.',
    );
  }
}

async function runGitDiffStep() {
  const name = 'Verify Agent Index Is Committed';
  const indexContentFiles = [
    'docs/agent-index/manifest.jsonl',
    'docs/agent-index/chunks.jsonl',
  ];
  const display = `git diff --exit-code ${indexContentFiles.join(' ')}`;
  const diff = runCommand(
    'git',
    ['diff', '--exit-code', ...indexContentFiles],
    display,
  );
  recordStep(name, display, diff);
  if (diff.status === 0) {
    return;
  }

  const statusDisplay = `git status --porcelain ${indexContentFiles.join(' ')}`;
  const status = runCommand(
    'git',
    ['status', '--porcelain', ...indexContentFiles],
    statusDisplay,
  );
  recordStep('Agent Index Porcelain Status', statusDisplay, status);
  throw new Error(
    `Agent index content diff detected for manifest/chunks. Follow this fixed order:\n1) npm ci\n2) npx nx run ai-indexer:sync\n3) git diff --exit-code docs/agent-index/manifest.jsonl docs/agent-index/chunks.jsonl\n4) if diff: git add docs/agent-index/manifest.jsonl docs/agent-index/chunks.jsonl && git commit -m "chore(index): refresh deterministic agent index"\nThen rerun release-audit.\n\ngit status output:\n${(status.stdout || '').trim() || '(empty)'}`,
  );
}

async function runRepositoryConsistencyStep() {
  const name = 'Verify Repository Consistency';
  const display = 'git diff --exit-code -- . ' + repositoryExcludes.join(' ');
  if (allowDirty) {
    process.stdout.write(
      `\n[acceptance] Skipped ${name} (ACCEPTANCE_ALLOW_DIRTY=true)\n`,
    );
    recordSkippedStep(name, display, 'ACCEPTANCE_ALLOW_DIRTY=true');
    return;
  }

  const diff = runCommand(
    'git',
    ['diff', '--exit-code', '--', '.', ...repositoryExcludes],
    display,
  );
  recordStep(name, display, diff);
  if (diff.status === 0) {
    return;
  }

  const statusDisplay =
    'git status --porcelain -- . ' + repositoryExcludes.join(' ');
  const status = runCommand(
    'git',
    ['status', '--porcelain', '--', '.', ...repositoryExcludes],
    statusDisplay,
  );
  recordStep('Repository Porcelain Status', statusDisplay, status);
  throw new Error(
    `Repository has tracked diffs after acceptance run. git status output:\n${
      (status.stdout || '').trim() || '(empty)'
    }`,
  );
}

async function runMigrationValidationStep() {
  const name = 'Validate Migration Bundle Outputs';
  const bizDir = path.join(workspaceRoot, 'dist', 'migrations', 'supabase-biz');
  const secretDir = path.join(
    workspaceRoot,
    'dist',
    'migrations',
    'supabase-secret',
  );

  const details = [];
  await validateBundleDir(bizDir, 'supabase-biz', details);
  await validateBundleDir(secretDir, 'supabase-secret', details);
  const summary = details.join('\n');
  const result = {
    status: 0,
    stdout: summary,
    stderr: '',
  };
  recordStep(name, 'node validate migration outputs', result);
  if (result.stdout) {
    process.stdout.write(`${result.stdout}\n`);
  }
}

async function validateBundleDir(dirPath, label, details) {
  const exists = await pathExists(dirPath);
  if (!exists) {
    throw new Error(`Migration output missing for ${label}: ${dirPath}`);
  }

  const files = await listFiles(dirPath);
  if (files.length === 0) {
    throw new Error(`Migration output empty for ${label}: ${dirPath}`);
  }

  const basenames = files.map((filePath) => path.basename(filePath));
  const hasDescriptor =
    basenames.includes('README.md') ||
    basenames.includes('manifest.json') ||
    basenames.includes('.gitkeep');
  if (!hasDescriptor) {
    throw new Error(
      `Migration output for ${label} must include README.md, manifest.json, or .gitkeep.`,
    );
  }

  details.push(
    `- ${label}: ${files.length} files (${basenames
      .filter((name) =>
        ['README.md', 'manifest.json', '.gitkeep'].includes(name),
      )
      .join(', ')})`,
  );
}

function runCommand(command, args, display) {
  process.stdout.write(`\n[acceptance] $ ${display}\n`);
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
  if (result.status !== 0) {
    return '';
  }
  return result.stdout ?? '';
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

async function writeReport() {
  const finishedAt = new Date();
  const durationSeconds = Math.round(
    (finishedAt.getTime() - startedAt.getTime()) / 1000,
  );
  const lines = [
    '# Release Acceptance Report',
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
    `- Flags: ACCEPTANCE_ALLOW_DIRTY=${allowDirty}, ACCEPTANCE_SKIP_BUILD_ALL=${skipBuildAll}, ACCEPTANCE_SKIP_E2E=${skipE2E}`,
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
    '- docs/agent-index',
    '- dist/migrations/supabase-biz',
    '- dist/migrations/supabase-secret',
  ];

  if (failed) {
    const failedStep = steps.find((step) => step.status === 'failure');
    lines.push('', '## Failure Summary', '', `- ${failureMessage}`);
    const failureOutput = failedStep
      ? failedStep.stderr || failedStep.stdout
      : '';
    if (failureOutput) {
      lines.push('', '```text', truncate(failureOutput, 4000), '```');
    }
  }

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
  process.stdout.write(`\n[acceptance] Report written to ${reportPath}\n`);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function toComparablePath(targetPath) {
  const normalized = path.resolve(targetPath).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function escapePipes(text) {
  return text.replaceAll('|', '\\|');
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n... (truncated)`;
}

function isEnabled(name) {
  return (
    String(process.env[name] ?? '')
      .trim()
      .toLowerCase() === 'true'
  );
}

await main();
