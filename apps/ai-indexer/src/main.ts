import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

type ManifestEntry = {
  path: string;
  size: number;
  sha256: string;
  kind: 'text' | 'binary';
  ext: string;
  language: string;
};

type ChunkEntry = {
  path: string;
  start_line: number;
  end_line: number;
  chunk_hash: string;
  content: string;
};

const INDEX_DIR = path.join('docs', 'agent-index');
const MANIFEST_PATH = path.join(INDEX_DIR, 'manifest.jsonl');
const CHUNKS_PATH = path.join(INDEX_DIR, 'chunks.jsonl');
const META_PATH = path.join(INDEX_DIR, 'meta.json');

const CHUNK_MAX_LINES = 120;
const CHUNK_MAX_CHARS = 6000;
const FIXED_GENERATED_AT = '1970-01-01T00:00:00.000Z';

const LANGUAGE_BY_EXT: Record<string, string> = {
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  go: 'go',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shell',
  sql: 'sql',
  swift: 'swift',
  ts: 'typescript',
  tsx: 'typescript',
  txt: 'text',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
};

const CHUNK_SENSITIVE_PATTERNS = [
  '.env*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ed25519*',
  '*.crt',
  '*.cer',
  '*.jks',
  '*kubeconfig*',
  '*.sqlite',
  '*.db',
  '.npmrc',
  '.yarnrc',
  'docs/agent-index/**',
] as const;

async function main() {
  const command = process.argv[2];
  if (command === 'sync') {
    await syncIndex();
    return;
  }
  if (command === 'validate') {
    await validateIndex();
    return;
  }

  throw new Error('Usage: node dist/apps/ai-indexer/main.js <sync|validate>');
}

async function syncIndex() {
  const trackedFiles = getTrackedFiles();
  const manifestEntries: ManifestEntry[] = [];
  const chunkEntries: ChunkEntry[] = [];

  for (const relPath of trackedFiles) {
    if (relPath.startsWith(`${INDEX_DIR}/`)) {
      continue;
    }

    const absPath = path.join(process.cwd(), relPath);
    const buffer = await fs.readFile(absPath);
    const kind: ManifestEntry['kind'] = isBinary(buffer) ? 'binary' : 'text';
    const ext = path.extname(relPath).replace('.', '').toLowerCase();
    const language = detectLanguage(relPath, ext);
    const entry: ManifestEntry = {
      path: relPath,
      size: buffer.byteLength,
      sha256: sha256(buffer),
      kind,
      ext,
      language,
    };
    manifestEntries.push(entry);

    if (kind === 'binary' || isSensitiveChunkPath(relPath)) {
      continue;
    }

    const content = buffer.toString('utf8').replace(/\r\n/g, '\n');
    const chunks = splitIntoChunks(relPath, content);
    chunkEntries.push(...chunks);
  }

  await fs.mkdir(INDEX_DIR, { recursive: true });
  await fs.writeFile(
    MANIFEST_PATH,
    toJsonLines(manifestEntries, true),
    'utf8'
  );
  await fs.writeFile(CHUNKS_PATH, toJsonLines(chunkEntries, true), 'utf8');

  const meta = {
    version: 1,
    generated_at: FIXED_GENERATED_AT,
    source: 'git ls-files',
    ruleset: {
      chunk_max_lines: CHUNK_MAX_LINES,
      chunk_max_chars: CHUNK_MAX_CHARS,
      chunk_sensitive_excludes: CHUNK_SENSITIVE_PATTERNS,
      excluded_prefixes: [INDEX_DIR],
    },
  };
  await fs.writeFile(META_PATH, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  console.log(
    `Synced ${manifestEntries.length} manifest entries and ${chunkEntries.length} chunks.`
  );
}

async function validateIndex() {
  const [manifestRaw, chunksRaw, metaRaw] = await Promise.all([
    fs.readFile(MANIFEST_PATH, 'utf8'),
    fs.readFile(CHUNKS_PATH, 'utf8'),
    fs.readFile(META_PATH, 'utf8'),
  ]);

  const manifestEntries = parseJsonLines<ManifestEntry>(manifestRaw);
  const chunkEntries = parseJsonLines<ChunkEntry>(chunksRaw);
  const meta = JSON.parse(metaRaw) as {
    version?: number;
    generated_at?: string;
    source?: string;
  };

  if (meta.version !== 1 || meta.source !== 'git ls-files') {
    throw new Error('meta.json has an unexpected version/source value.');
  }

  assertSortedAndUnique(manifestEntries.map((entry) => entry.path), 'manifest');
  assertSortedAndUnique(
    chunkEntries.map((entry) => `${entry.path}:${entry.start_line}`),
    'chunks'
  );

  for (const entry of manifestEntries) {
    if (!entry.path || typeof entry.size !== 'number' || !entry.sha256) {
      throw new Error(`Invalid manifest entry: ${JSON.stringify(entry)}`);
    }
    if (entry.path.startsWith(`${INDEX_DIR}/`)) {
      throw new Error(`manifest must not include ${INDEX_DIR}: ${entry.path}`);
    }
  }

  for (const chunk of chunkEntries) {
    if (isSensitiveChunkPath(chunk.path)) {
      throw new Error(`Sensitive path leaked into chunks: ${chunk.path}`);
    }
    if (chunk.path.startsWith(`${INDEX_DIR}/`)) {
      throw new Error(`chunks must not include ${INDEX_DIR}: ${chunk.path}`);
    }
    if (chunk.start_line < 1 || chunk.end_line < chunk.start_line) {
      throw new Error(`Invalid line range in chunk: ${JSON.stringify(chunk)}`);
    }
    if (sha256(chunk.content) !== chunk.chunk_hash) {
      throw new Error(`Chunk hash mismatch for ${chunk.path}:${chunk.start_line}`);
    }
  }

  const trackedSet = new Set(
    getTrackedFiles().filter((relPath) => !relPath.startsWith(`${INDEX_DIR}/`))
  );
  const manifestSet = new Set(manifestEntries.map((entry) => entry.path));

  for (const relPath of trackedSet) {
    if (!manifestSet.has(relPath)) {
      throw new Error(`Missing tracked file in manifest: ${relPath}`);
    }
  }

  console.log('Index validation passed.');
}

function getTrackedFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output
    .split('\u0000')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((relPath) => relPath.replace(/\\/g, '/'))
    .sort((a, b) => a.localeCompare(b));
}

function splitIntoChunks(relPath: string, content: string): ChunkEntry[] {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length === 0) {
    return [];
  }

  const chunks: ChunkEntry[] = [];
  let startLine = 1;
  let endLine = 0;
  let currentLines: string[] = [];
  let currentChars = 0;

  const flush = () => {
    if (currentLines.length === 0) {
      return;
    }
    const chunkContent = currentLines.join('\n');
    chunks.push({
      path: relPath,
      start_line: startLine,
      end_line: endLine,
      chunk_hash: sha256(chunkContent),
      content: chunkContent,
    });
    currentLines = [];
    currentChars = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const nextChars = currentChars + line.length + 1;
    const shouldFlush =
      currentLines.length > 0 &&
      (currentLines.length >= CHUNK_MAX_LINES || nextChars > CHUNK_MAX_CHARS);
    if (shouldFlush) {
      flush();
      startLine = lineNumber;
    }
    currentLines.push(line);
    currentChars += line.length + 1;
    endLine = lineNumber;
  }
  flush();
  return chunks;
}

function isSensitiveChunkPath(relPath: string): boolean {
  const normalized = relPath.toLowerCase();
  const base = path.posix.basename(normalized);

  if (normalized.startsWith(`${INDEX_DIR}/`)) {
    return true;
  }
  if (base.startsWith('.env')) {
    return true;
  }
  if (base === '.npmrc' || base === '.yarnrc') {
    return true;
  }
  if (base.startsWith('id_rsa') || base.startsWith('id_ed25519')) {
    return true;
  }
  if (normalized.includes('kubeconfig')) {
    return true;
  }

  const sensitiveExts = [
    '.pem',
    '.key',
    '.p12',
    '.pfx',
    '.crt',
    '.cer',
    '.jks',
    '.sqlite',
    '.db',
  ];
  return sensitiveExts.some((ext) => normalized.endsWith(ext));
}

function toJsonLines(entries: Array<Record<string, unknown>>, withFinalLf: boolean) {
  if (entries.length === 0) {
    return withFinalLf ? '\n' : '';
  }
  const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
  return withFinalLf ? `${body}\n` : body;
}

function parseJsonLines<T>(raw: string): T[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function assertSortedAndUnique(items: string[], label: string) {
  const seen = new Set<string>();
  let previous = '';
  for (const item of items) {
    if (seen.has(item)) {
      throw new Error(`${label} contains duplicate key: ${item}`);
    }
    if (previous && previous.localeCompare(item) > 0) {
      throw new Error(`${label} is not sorted: ${previous} > ${item}`);
    }
    seen.add(item);
    previous = item;
  }
}

function detectLanguage(relPath: string, ext: string): string {
  const base = path.posix.basename(relPath).toLowerCase();
  if (base === 'dockerfile') {
    return 'dockerfile';
  }
  if (base === 'makefile') {
    return 'makefile';
  }
  return LANGUAGE_BY_EXT[ext] ?? 'unknown';
}

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function isBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  const sampleSize = Math.min(buffer.length, 8192);
  let suspiciousBytes = 0;
  for (let index = 0; index < sampleSize; index += 1) {
    const value = buffer[index];
    if (value === 0) {
      return true;
    }
    const isPrintable =
      value === 9 ||
      value === 10 ||
      value === 13 ||
      (value >= 32 && value <= 126) ||
      value >= 128;
    if (!isPrintable) {
      suspiciousBytes += 1;
    }
  }
  return suspiciousBytes / sampleSize > 0.3;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
