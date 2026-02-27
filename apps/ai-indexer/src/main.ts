import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';

type ManifestKind = 'text' | 'binary';

type ManifestEntry = {
  path: string;
  size: number;
  sha256: string;
  kind: ManifestKind;
  ext: string;
  language: string;
};

type ChunkEntry = {
  path: string;
  start_line: number;
  end_line: number;
  chunk_hash: string;
  content?: string;
};

type MetaEntry = {
  git_sha: string;
  generated_at: string;
  nx_version: string;
  node_version: string;
  ruleset_version: string;
  source: 'git ls-files';
  include_content: boolean;
  coverage_excludes: string[];
  chunk_max_lines: number;
  chunk_max_chars: number;
  chunk_sensitive_excludes: readonly string[];
};

type TrackedFileEntry = {
  path: string;
  blobId: string;
};

const INDEX_DIR = 'docs/agent-index';
const INDEX_PREFIX = `${INDEX_DIR}/`;
const INDEX_DIR_FS = path.join('docs', 'agent-index');
const MANIFEST_PATH = path.join(INDEX_DIR_FS, 'manifest.jsonl');
const CHUNKS_PATH = path.join(INDEX_DIR_FS, 'chunks.jsonl');
const META_PATH = path.join(INDEX_DIR_FS, 'meta.json');

const CHUNK_MAX_LINES = 120;
const CHUNK_MAX_CHARS = 6000;
const RULESET_VERSION = '2.0.0';

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
  const includeContent = shouldIncludeContent();
  const trackedFiles = getTrackedFiles().filter(
    (entry) => !isIndexFile(entry.path),
  );
  const manifestEntries: ManifestEntry[] = [];
  const chunkEntries: ChunkEntry[] = [];
  const blobCache = new Map<string, Buffer>();

  for (const trackedFile of trackedFiles) {
    const relPath = trackedFile.path;
    const fileBuffer = getBlobBuffer(trackedFile.blobId, blobCache);
    const kind: ManifestKind = isBinary(fileBuffer) ? 'binary' : 'text';
    const ext = path.extname(relPath).replace('.', '').toLowerCase();
    const language = detectLanguage(relPath, ext);

    manifestEntries.push({
      path: relPath,
      size: fileBuffer.byteLength,
      sha256: sha256(fileBuffer),
      kind,
      ext,
      language,
    });

    if (kind === 'binary' || isSensitiveChunkPath(relPath)) {
      continue;
    }

    const normalized = normalizeFileContent(fileBuffer);
    chunkEntries.push(...splitIntoChunks(relPath, normalized, includeContent));
  }

  manifestEntries.sort(compareByPath);
  chunkEntries.sort(compareChunkEntries);

  const metadata = getMetaEntry(includeContent);

  await fs.mkdir(INDEX_DIR_FS, { recursive: true });
  await fs.writeFile(MANIFEST_PATH, toManifestJsonl(manifestEntries), 'utf8');
  await fs.writeFile(
    CHUNKS_PATH,
    toChunkJsonl(chunkEntries, includeContent),
    'utf8',
  );
  await fs.writeFile(
    META_PATH,
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );

  console.log(
    `Synced ${manifestEntries.length} manifest entries and ${chunkEntries.length} chunks.`,
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
  const meta = JSON.parse(metaRaw) as MetaEntry;

  validateMeta(meta);
  validateManifestShape(manifestEntries);
  validateChunkShape(chunkEntries, meta.include_content);

  const trackedFiles = getTrackedFiles().filter(
    (entry) => !isIndexFile(entry.path),
  );
  const trackedPaths = trackedFiles.map((entry) => entry.path);
  assertExactCoverage(trackedPaths, manifestEntries);

  const manifestByPath = new Map(
    manifestEntries.map((entry) => [entry.path, entry]),
  );
  const blobByPath = new Map(trackedFiles.map((entry) => [entry.path, entry]));
  const blobCache = new Map<string, Buffer>();

  for (const trackedFile of trackedFiles) {
    const relPath = trackedFile.path;
    const entry = manifestByPath.get(relPath);
    if (!entry) {
      throw new Error(`Missing tracked file in manifest: ${relPath}`);
    }

    const fileBuffer = getBlobBuffer(trackedFile.blobId, blobCache);
    const ext = path.extname(relPath).replace('.', '').toLowerCase();
    const language = detectLanguage(relPath, ext);
    const expectedKind: ManifestKind = isBinary(fileBuffer) ? 'binary' : 'text';
    const expectedHash = sha256(fileBuffer);

    if (entry.size !== fileBuffer.byteLength) {
      throw new Error(
        `Manifest size mismatch for ${relPath}: expected ${fileBuffer.byteLength}, got ${entry.size}`,
      );
    }
    if (entry.sha256 !== expectedHash) {
      throw new Error(`Manifest sha256 mismatch for ${relPath}`);
    }
    if (entry.kind !== expectedKind) {
      throw new Error(`Manifest kind mismatch for ${relPath}`);
    }
    if (entry.ext !== ext) {
      throw new Error(
        `Manifest ext mismatch for ${relPath}: expected ${ext}, got ${entry.ext}`,
      );
    }
    if (entry.language !== language) {
      throw new Error(
        `Manifest language mismatch for ${relPath}: expected ${language}, got ${entry.language}`,
      );
    }
  }

  const fileLineCache = new Map<string, string[]>();
  for (const chunk of chunkEntries) {
    const manifestEntry = manifestByPath.get(chunk.path);
    if (!manifestEntry) {
      throw new Error(`Chunk path missing from manifest: ${chunk.path}`);
    }
    if (manifestEntry.kind !== 'text') {
      throw new Error(`Chunk path must map to text file: ${chunk.path}`);
    }
    if (isSensitiveChunkPath(chunk.path)) {
      throw new Error(`Sensitive path leaked into chunks: ${chunk.path}`);
    }

    const fileLines = await getFileLines(
      chunk.path,
      blobByPath,
      fileLineCache,
      blobCache,
    );
    if (chunk.start_line < 1 || chunk.end_line < chunk.start_line) {
      throw new Error(`Invalid chunk line range for ${chunk.path}`);
    }
    if (chunk.end_line > fileLines.length) {
      throw new Error(
        `Chunk line range out of bounds for ${chunk.path}:${chunk.start_line}-${chunk.end_line}`,
      );
    }

    const actualChunk = fileLines
      .slice(chunk.start_line - 1, chunk.end_line)
      .join('\n');
    if (sha256(actualChunk) !== chunk.chunk_hash) {
      throw new Error(
        `Chunk hash mismatch for ${chunk.path}:${chunk.start_line}`,
      );
    }

    if (meta.include_content) {
      if (chunk.content !== actualChunk) {
        throw new Error(
          `Chunk content mismatch for ${chunk.path}:${chunk.start_line}`,
        );
      }
    } else if (Object.hasOwn(chunk, 'content')) {
      throw new Error(
        `chunks.jsonl contains content but include_content=false (${chunk.path})`,
      );
    }
  }

  console.log('Index validation passed.');
}

function getMetaEntry(includeContent: boolean): MetaEntry {
  return {
    git_sha: runGit(['rev-parse', 'HEAD']).trim(),
    generated_at: runGit(['show', '-s', '--format=%cI', 'HEAD']).trim(),
    nx_version: getNxVersion(),
    node_version: process.version,
    ruleset_version: RULESET_VERSION,
    source: 'git ls-files',
    include_content: includeContent,
    coverage_excludes: [INDEX_PREFIX],
    chunk_max_lines: CHUNK_MAX_LINES,
    chunk_max_chars: CHUNK_MAX_CHARS,
    chunk_sensitive_excludes: CHUNK_SENSITIVE_PATTERNS,
  };
}

function validateMeta(meta: MetaEntry) {
  const expected = getMetaEntry(meta.include_content);
  const requiredCoverageExcludes = [INDEX_PREFIX];

  if (meta.source !== 'git ls-files') {
    throw new Error('meta.source must be "git ls-files".');
  }
  if (meta.ruleset_version !== RULESET_VERSION) {
    throw new Error(`meta.ruleset_version must be ${RULESET_VERSION}.`);
  }
  if (meta.git_sha !== expected.git_sha) {
    throw new Error('meta.git_sha does not match current HEAD.');
  }
  if (meta.generated_at !== expected.generated_at) {
    throw new Error('meta.generated_at must match HEAD commit timestamp.');
  }
  if (meta.nx_version !== expected.nx_version) {
    throw new Error(`meta.nx_version must be ${expected.nx_version}.`);
  }
  if (meta.node_version !== expected.node_version) {
    throw new Error(`meta.node_version must be ${expected.node_version}.`);
  }
  if (!Array.isArray(meta.coverage_excludes)) {
    throw new Error('meta.coverage_excludes must be an array.');
  }
  for (const required of requiredCoverageExcludes) {
    if (!meta.coverage_excludes.includes(required)) {
      throw new Error(`meta.coverage_excludes must include "${required}".`);
    }
  }
  if (meta.chunk_max_lines !== CHUNK_MAX_LINES) {
    throw new Error(`meta.chunk_max_lines must be ${CHUNK_MAX_LINES}.`);
  }
  if (meta.chunk_max_chars !== CHUNK_MAX_CHARS) {
    throw new Error(`meta.chunk_max_chars must be ${CHUNK_MAX_CHARS}.`);
  }
  if (!Array.isArray(meta.chunk_sensitive_excludes)) {
    throw new Error('meta.chunk_sensitive_excludes must be an array.');
  }
}

function validateManifestShape(entries: ManifestEntry[]) {
  assertSortedAndUnique(
    entries.map((entry) => entry.path),
    'manifest',
  );
  for (const entry of entries) {
    if (!entry.path) {
      throw new Error(`Invalid manifest path: ${JSON.stringify(entry)}`);
    }
    if (isIndexFile(entry.path)) {
      throw new Error(`Manifest must exclude ${INDEX_PREFIX}: ${entry.path}`);
    }
    if (typeof entry.size !== 'number' || entry.size < 0) {
      throw new Error(`Invalid manifest size for ${entry.path}`);
    }
    if (typeof entry.sha256 !== 'string' || entry.sha256.length !== 64) {
      throw new Error(`Invalid manifest sha256 for ${entry.path}`);
    }
    if (entry.kind !== 'text' && entry.kind !== 'binary') {
      throw new Error(`Invalid manifest kind for ${entry.path}`);
    }
    if (typeof entry.ext !== 'string') {
      throw new Error(`Invalid manifest ext for ${entry.path}`);
    }
    if (typeof entry.language !== 'string' || entry.language.length === 0) {
      throw new Error(`Invalid manifest language for ${entry.path}`);
    }
  }
}

function validateChunkShape(entries: ChunkEntry[], includeContent: boolean) {
  assertChunkOrder(entries);
  for (const chunk of entries) {
    if (!chunk.path) {
      throw new Error(`Invalid chunk path: ${JSON.stringify(chunk)}`);
    }
    if (isIndexFile(chunk.path)) {
      throw new Error(`Chunks must exclude ${INDEX_PREFIX}: ${chunk.path}`);
    }
    if (chunk.start_line < 1 || chunk.end_line < chunk.start_line) {
      throw new Error(`Invalid chunk range for ${chunk.path}`);
    }
    if (
      typeof chunk.chunk_hash !== 'string' ||
      chunk.chunk_hash.length !== 64
    ) {
      throw new Error(
        `Invalid chunk hash for ${chunk.path}:${chunk.start_line}`,
      );
    }
    if (includeContent) {
      if (typeof chunk.content !== 'string') {
        throw new Error(
          `Chunk content must be present when include_content=true (${chunk.path})`,
        );
      }
    } else if (Object.hasOwn(chunk, 'content')) {
      throw new Error(
        `Chunk content must be omitted when include_content=false (${chunk.path})`,
      );
    }
  }
}

function assertExactCoverage(
  trackedFiles: string[],
  manifestEntries: ManifestEntry[],
) {
  const trackedSet = new Set(trackedFiles);
  const manifestPaths = manifestEntries.map((entry) => entry.path);
  const manifestSet = new Set(manifestPaths);

  for (const trackedPath of trackedSet) {
    if (!manifestSet.has(trackedPath)) {
      throw new Error(
        `Missing tracked file in manifest coverage: ${trackedPath}`,
      );
    }
  }
  for (const manifestPath of manifestSet) {
    if (!trackedSet.has(manifestPath)) {
      throw new Error(`Manifest contains non-tracked file: ${manifestPath}`);
    }
  }
}

function splitIntoChunks(
  relPath: string,
  content: string,
  includeContent: boolean,
): ChunkEntry[] {
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
    const chunkEntry: ChunkEntry = {
      path: relPath,
      start_line: startLine,
      end_line: endLine,
      chunk_hash: sha256(chunkContent),
    };
    if (includeContent) {
      chunkEntry.content = chunkContent;
    }
    chunks.push(chunkEntry);
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

function toManifestJsonl(entries: ManifestEntry[]): string {
  const lines = entries.map((entry) =>
    JSON.stringify({
      path: entry.path,
      size: entry.size,
      sha256: entry.sha256,
      kind: entry.kind,
      ext: entry.ext,
      language: entry.language,
    }),
  );
  return `${lines.join('\n')}\n`;
}

function toChunkJsonl(entries: ChunkEntry[], includeContent: boolean): string {
  const lines = entries.map((entry) => {
    if (includeContent) {
      return JSON.stringify({
        path: entry.path,
        start_line: entry.start_line,
        end_line: entry.end_line,
        chunk_hash: entry.chunk_hash,
        content: entry.content ?? '',
      });
    }

    return JSON.stringify({
      path: entry.path,
      start_line: entry.start_line,
      end_line: entry.end_line,
      chunk_hash: entry.chunk_hash,
    });
  });
  return `${lines.join('\n')}\n`;
}

function parseJsonLines<T>(raw: string): T[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function assertSortedAndUnique(paths: string[], label: string) {
  const seen = new Set<string>();
  let previous = '';
  for (const value of paths) {
    if (seen.has(value)) {
      throw new Error(`${label} contains duplicate key: ${value}`);
    }
    if (previous !== '' && previous.localeCompare(value) > 0) {
      throw new Error(`${label} is not sorted: ${previous} > ${value}`);
    }
    seen.add(value);
    previous = value;
  }
}

function assertChunkOrder(chunks: ChunkEntry[]) {
  let previousPath = '';
  let previousLine = 0;
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const key = `${chunk.path}:${chunk.start_line}:${chunk.end_line}`;
    if (seen.has(key)) {
      throw new Error(`chunks contains duplicate key: ${key}`);
    }
    seen.add(key);

    if (previousPath !== '' && previousPath.localeCompare(chunk.path) > 0) {
      throw new Error(`chunks is not sorted: ${previousPath} > ${chunk.path}`);
    }
    if (previousPath === chunk.path && previousLine > chunk.start_line) {
      throw new Error(
        `chunks is not sorted: ${chunk.path}:${previousLine} > ${chunk.path}:${chunk.start_line}`,
      );
    }

    previousPath = chunk.path;
    previousLine = chunk.start_line;
  }
}

function isSensitiveChunkPath(relPath: string): boolean {
  const normalized = relPath.toLowerCase();
  const base = path.posix.basename(normalized);

  if (isIndexFile(relPath)) {
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

function getTrackedFiles(): TrackedFileEntry[] {
  const output = runGit(['ls-files', '-s', '-z']);
  const entries = output
    .split('\u0000')
    .filter(Boolean)
    .map((record) => {
      const tabIndex = record.indexOf('\t');
      if (tabIndex === -1) {
        throw new Error(`Invalid git ls-files -s output: ${record}`);
      }

      const header = record.slice(0, tabIndex).trim().split(/\s+/);
      if (header.length < 3) {
        throw new Error(`Invalid git ls-files -s header: ${record}`);
      }

      const blobId = header[1];
      const stage = header[2];
      if (stage !== '0') {
        throw new Error(
          `Git index has non-stage-0 entry (${stage}) for ${record.slice(tabIndex + 1)}`,
        );
      }

      return {
        path: record.slice(tabIndex + 1).replace(/\\/g, '/'),
        blobId,
      };
    });

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function getNxVersion(): string {
  try {
    const nxPackagePath = path.join(
      process.cwd(),
      'node_modules',
      'nx',
      'package.json',
    );
    const nxPackage = JSON.parse(readFileSync(nxPackagePath, 'utf8')) as {
      version?: string;
    };
    if (typeof nxPackage.version === 'string') {
      return nxPackage.version;
    }
  } catch {
    // Fall through to workspace package.json.
  }

  const workspacePackage = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const version =
    workspacePackage.devDependencies?.nx ??
    workspacePackage.dependencies?.nx ??
    'unknown';
  return version.replace(/^[~^]/, '');
}

function runGit(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function shouldIncludeContent(): boolean {
  return (
    String(process.env.INDEX_INCLUDE_CONTENT ?? '').toLowerCase() === 'true'
  );
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

function normalizeFileContent(buffer: Buffer): string {
  return buffer.toString('utf8').replace(/\r\n/g, '\n');
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

function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function compareByPath(a: { path: string }, b: { path: string }): number {
  return a.path.localeCompare(b.path);
}

function compareChunkEntries(a: ChunkEntry, b: ChunkEntry): number {
  const pathCompare = a.path.localeCompare(b.path);
  if (pathCompare !== 0) {
    return pathCompare;
  }
  return a.start_line - b.start_line;
}

async function getFileLines(
  relPath: string,
  blobByPath: Map<string, TrackedFileEntry>,
  cache: Map<string, string[]>,
  blobCache: Map<string, Buffer>,
): Promise<string[]> {
  const cached = cache.get(relPath);
  if (cached) {
    return cached;
  }

  const trackedFile = blobByPath.get(relPath);
  if (!trackedFile) {
    throw new Error(`Missing git blob mapping for ${relPath}`);
  }

  const content = normalizeFileContent(
    getBlobBuffer(trackedFile.blobId, blobCache),
  );
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  cache.set(relPath, lines);
  return lines;
}

function getBlobBuffer(blobId: string, cache: Map<string, Buffer>): Buffer {
  const cached = cache.get(blobId);
  if (cached) {
    return cached;
  }

  const buffer = execFileSync('git', ['cat-file', '-p', blobId], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 64,
  });
  cache.set(blobId, buffer);
  return buffer;
}

function isIndexFile(relPath: string): boolean {
  return relPath.startsWith(INDEX_PREFIX);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
