import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspaceRoot = process.cwd();
const nxCli = path.join(workspaceRoot, 'node_modules', 'nx', 'bin', 'nx.js');
const cleanNodeModules =
  String(process.env.ACCEPTANCE_CLEAN_NODE_MODULES ?? '').toLowerCase() ===
  'true';
const cleanDist =
  String(process.env.ACCEPTANCE_CLEAN_DIST ?? 'true').toLowerCase() !== 'false';

async function main() {
  log('Starting clean-environment acceptance run');
  const gitSha = runCapture('git', ['rev-parse', 'HEAD']).trim();
  const npmVersion = runCapture(getNpmCommand(), ['--version']).trim();
  const npxVersion = runCapture(getNpxCommand(), ['--version']).trim();
  const nxVersion = runCapture(process.execPath, [nxCli, '--version']).trim();

  log(`Git SHA: ${gitSha || 'unknown'}`);
  log(`Node: ${process.version}`);
  log(`npm: ${npmVersion || 'unknown'}`);
  log(`npx: ${npxVersion || 'unknown'}`);
  log(`Nx: ${nxVersion || 'unknown'}`);
  log(`OS: ${os.platform()} ${os.release()} (${os.arch()})`);

  await cleanPath(
    path.join(workspaceRoot, '.nx', 'cache'),
    'Cleared .nx/cache',
  );
  if (cleanDist) {
    await cleanPath(path.join(workspaceRoot, 'dist'), 'Cleared dist');
  }
  if (cleanNodeModules) {
    await cleanPath(
      path.join(workspaceRoot, 'node_modules'),
      'Cleared node_modules',
    );
  }

  runOrThrow(getNpmCommand(), ['ci'], 'npm ci');
  runOrThrow(
    process.execPath,
    [nxCli, 'run', 'workspace-policy:acceptance'],
    'npx nx run workspace-policy:acceptance',
  );

  log('Acceptance run completed successfully.');
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function getNpxCommand() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function runCapture(command, args) {
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

function runOrThrow(command, args, displayCommand) {
  log(`$ ${displayCommand}`);
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
  if (result.status !== 0) {
    throw new Error(`Command failed: ${displayCommand}`);
  }
}

async function cleanPath(targetPath, message) {
  await fs.rm(targetPath, { recursive: true, force: true });
  log(message);
}

function log(message) {
  process.stdout.write(`[acceptance-run] ${message}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[acceptance-run] FAILED: ${message}\n`);
  process.exit(1);
});
