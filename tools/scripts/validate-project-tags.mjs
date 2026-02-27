import { promises as fs } from 'node:fs';
import path from 'node:path';

const allowed = {
  type: new Set(['type:app', 'type:lib', 'type:e2e', 'type:tooling']),
  product: new Set([
    'product:web',
    'product:admin',
    'product:marketing',
    'product:worker',
    'product:secret-service',
    'product:ai-indexer',
    'product:supabase-biz',
    'product:supabase-secret',
    'product:code-search',
    'product:workspace',
  ]),
  scope: new Set([
    'scope:biz',
    'scope:secret',
    'scope:contracts',
    'scope:shared',
    'scope:platform',
    'scope:testing',
    'scope:tooling',
  ]),
  layer: new Set([
    'layer:ui',
    'layer:feature',
    'layer:domain',
    'layer:data-access',
    'layer:contracts',
    'layer:shared',
    'layer:platform',
    'layer:testing',
    'layer:tooling',
  ]),
  platform: new Set([
    'platform:browser',
    'platform:node',
    'platform:isomorphic',
  ]),
  data: new Set(['data:public', 'data:biz', 'data:secret']),
};

const allowedTagSet = new Set(
  Object.values(allowed).flatMap((set) => [...set]),
);

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
  const typeTags = tags.filter((tag) => allowed.type.has(tag));
  const productTags = tags.filter((tag) => allowed.product.has(tag));
  const scopeTags = tags.filter((tag) => allowed.scope.has(tag));
  const layerTags = tags.filter((tag) => allowed.layer.has(tag));
  const platformTags = tags.filter((tag) => allowed.platform.has(tag));
  const dataTags = tags.filter((tag) => allowed.data.has(tag));

  const unknownTags = tags.filter((tag) => !allowedTagSet.has(tag));
  if (unknownTags.length > 0) {
    errors.push(
      `${project.name} (${project.path}): contains unknown tags [${unknownTags.join(', ')}]`,
    );
  }

  if (typeTags.length !== 1) {
    errors.push(
      `${project.name} (${project.path}): expected exactly one type:* tag, found [${typeTags.join(', ')}]`,
    );
    continue;
  }

  if (platformTags.length !== 1) {
    errors.push(
      `${project.name} (${project.path}): expected exactly one platform:* tag, found [${platformTags.join(', ')}]`,
    );
  }

  const projectType = typeTags[0];

  if (projectType === 'type:app') {
    if (productTags.length !== 1) {
      errors.push(
        `${project.name} (${project.path}): app projects must have exactly one product:* tag, found [${productTags.join(', ')}]`,
      );
    }
    if (scopeTags.length > 0) {
      errors.push(
        `${project.name} (${project.path}): app projects must not use scope:* tags, found [${scopeTags.join(', ')}]`,
      );
    }
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
  }

  if (projectType === 'type:e2e') {
    if (productTags.length !== 1) {
      errors.push(
        `${project.name} (${project.path}): e2e projects must have exactly one product:* tag, found [${productTags.join(', ')}]`,
      );
    }
    if (scopeTags.length > 0 || layerTags.length > 0 || dataTags.length > 0) {
      errors.push(
        `${project.name} (${project.path}): e2e projects must not use scope/layer/data tags.`,
      );
    }
  }

  if (projectType === 'type:lib') {
    if (productTags.length > 0) {
      errors.push(
        `${project.name} (${project.path}): lib projects must not use product:* tags, found [${productTags.join(', ')}]`,
      );
    }
    if (scopeTags.length !== 1) {
      errors.push(
        `${project.name} (${project.path}): lib projects must have exactly one scope:* tag, found [${scopeTags.join(', ')}]`,
      );
    }
    if (layerTags.length !== 1) {
      errors.push(
        `${project.name} (${project.path}): lib projects must have exactly one layer:* tag, found [${layerTags.join(', ')}]`,
      );
    }
    if (dataTags.length !== 1) {
      errors.push(
        `${project.name} (${project.path}): lib projects must have exactly one data:* tag, found [${dataTags.join(', ')}]`,
      );
    }
  }

  if (projectType === 'type:tooling') {
    if (scopeTags.length !== 1) {
      errors.push(
        `${project.name} (${project.path}): tooling projects must have exactly one scope:* tag, found [${scopeTags.join(', ')}]`,
      );
    }
    if (layerTags.length !== 1) {
      errors.push(
        `${project.name} (${project.path}): tooling projects must have exactly one layer:* tag, found [${layerTags.join(', ')}]`,
      );
    }
    if (productTags.length > 1) {
      errors.push(
        `${project.name} (${project.path}): tooling projects can have at most one product:* tag, found [${productTags.join(', ')}]`,
      );
    }
    if (dataTags.length > 1) {
      errors.push(
        `${project.name} (${project.path}): tooling projects can have at most one data:* tag, found [${dataTags.join(', ')}]`,
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
