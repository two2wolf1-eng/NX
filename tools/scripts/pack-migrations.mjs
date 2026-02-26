import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const [projectName, sourceDirArg] = process.argv.slice(2);

if (!projectName || !sourceDirArg) {
  console.error(
    'Usage: node tools/scripts/pack-migrations.mjs <project-name> <supabase-dir>',
  );
  process.exit(1);
}

const workspaceRoot = process.cwd();
const sourceDir = path.join(workspaceRoot, sourceDirArg);
const outputRoot = path.join(workspaceRoot, 'dist', 'migrations', projectName);
const outputSupabaseDir = path.join(outputRoot, 'supabase');
const fixedGeneratedAt = '1970-01-01T00:00:00.000Z';

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(outputSupabaseDir, { recursive: true });

if (await exists(sourceDir)) {
  await fs.cp(sourceDir, outputSupabaseDir, { recursive: true });
}

const files = await listFiles(outputRoot);
const manifestFiles = [];
for (const file of files) {
  const rel = path.relative(outputRoot, file).replace(/\\/g, '/');
  const content = await fs.readFile(file);
  const stats = await fs.stat(file);
  manifestFiles.push({
    path: rel,
    size: stats.size,
    sha256: createHash('sha256').update(content).digest('hex'),
  });
}
manifestFiles.sort((a, b) => a.path.localeCompare(b.path));

const manifest = {
  project: projectName,
  source: sourceDirArg.replace(/\\/g, '/'),
  generated_at: fixedGeneratedAt,
  files: manifestFiles,
};
await fs.writeFile(
  path.join(outputRoot, 'manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8',
);

const readme = [
  `# ${projectName} Migration Bundle`,
  '',
  'This bundle is produced by CI and intended for internal-network deployment pipelines.',
  'GitHub Actions does not execute production migration against private databases.',
  '',
  `Source directory: ${sourceDirArg.replace(/\\/g, '/')}`,
].join('\n');
await fs.writeFile(path.join(outputRoot, 'README.md'), `${readme}\n`, 'utf8');

console.log(`Packed migrations for ${projectName} -> ${outputRoot}`);

async function listFiles(dir) {
  if (!(await exists(dir))) {
    return [];
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
