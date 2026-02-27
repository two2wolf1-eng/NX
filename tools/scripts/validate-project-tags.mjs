import { promises as fs } from 'node:fs';
import path from 'node:path';

const required = {
  type: new Set(['type:app', 'type:lib', 'type:infra']),
  layer: new Set([
    'layer:ui',
    'layer:data-access',
    'layer:domain',
    'layer:contract',
    'layer:shared',
  ]),
  data: new Set(['data:biz', 'data:secret']),
  scope: new Set([
    'scope:web',
    'scope:admin',
    'scope:marketing',
    'scope:worker',
    'scope:secret',
    'scope:shared',
  ]),
};

const projectFiles = await listProjectJsonFiles(process.cwd());
const projectEntries = [];
for (const filePath of projectFiles) {
  const raw = await fs.readFile(filePath, 'utf8');
  const config = JSON.parse(raw);
  if (!config.name) {
    continue;
  }
  projectEntries.push({
    name: config.name,
    path: toRelative(filePath),
    tags: Array.isArray(config.tags) ? config.tags : [],
  });
}

projectEntries.sort((a, b) => a.name.localeCompare(b.name));
if (projectEntries.length === 0) {
  console.error(
    'No projects found. Expected project.json files under apps/libs/tools.',
  );
  process.exit(1);
}

const errors = [];
for (const project of projectEntries) {
  const tags = project.tags;
  const tagSet = new Set(tags);
  const typeTags = tags.filter((tag) => required.type.has(tag));
  const layerTags = tags.filter((tag) => required.layer.has(tag));
  const dataTags = tags.filter((tag) => required.data.has(tag));
  const scopeTags = tags.filter((tag) => required.scope.has(tag));

  if (typeTags.length !== 1) {
    errors.push(
      `${project.name} (${project.path}): expected exactly one type:* tag, found [${typeTags.join(', ')}]`,
    );
    continue;
  }

  if (scopeTags.length !== 1) {
    errors.push(
      `${project.name} (${project.path}): expected exactly one scope:* tag, found [${scopeTags.join(', ')}]`,
    );
  }

  const projectType = typeTags[0];
  if (projectType === 'type:app') {
    if (layerTags.length > 0) {
      errors.push(
        `${project.name} (${project.path}): app projects must not use layer:* tags, found [${layerTags.join(', ')}]`,
      );
    }
    if (dataTags.length !== 1) {
      errors.push(
        `${project.name} (${project.path}): app projects must have exactly one data:* tag, found [${dataTags.join(', ')}]`,
      );
    }
  } else {
    if (layerTags.length !== 1) {
      errors.push(
        `${project.name} (${project.path}): expected exactly one layer:* tag, found [${layerTags.join(', ')}]`,
      );
    }
    if (dataTags.length !== 1) {
      errors.push(
        `${project.name} (${project.path}): expected exactly one data:* tag, found [${dataTags.join(', ')}]`,
      );
    }
  }

  if (tagSet.has('secret-access-lib')) {
    if (!tagSet.has('layer:data-access') || !tagSet.has('data:secret')) {
      errors.push(
        `${project.name} (${project.path}): secret-access-lib requires layer:data-access + data:secret`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error('Project tag validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Project tag validation passed for ${projectEntries.length} projects.`,
);

async function listProjectJsonFiles(root) {
  const searchRoots = ['apps', 'libs', 'tools'].map((dir) =>
    path.join(root, dir),
  );
  const files = [];
  for (const dir of searchRoots) {
    if (await exists(dir)) {
      files.push(...(await walk(dir)));
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.name === 'project.json') {
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

function toRelative(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, '/');
}
