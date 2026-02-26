import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const eslintBin = path.join('node_modules', 'eslint', 'bin', 'eslint.js');

const fixtures = {
  webForbidden: path.join(
    'tools',
    'fixtures',
    'module-boundaries',
    'web-forbidden-import.ts',
  ),
  secretAllowed: path.join(
    'tools',
    'fixtures',
    'module-boundaries',
    'secret-service-allowed-import.ts',
  ),
  domainForbidden: path.join(
    'tools',
    'fixtures',
    'module-boundaries',
    'domain-forbidden-import.ts',
  ),
  contractForbidden: path.join(
    'tools',
    'fixtures',
    'module-boundaries',
    'contract-forbidden-import.ts',
  ),
};

const tempFiles = {
  web: path.join('apps', 'web', 'src', '__module_boundary_check__.ts'),
  secret: path.join(
    'apps',
    'secret-service',
    'src',
    '__module_boundary_check__.ts',
  ),
  domain: path.join(
    'libs',
    'domain',
    'tenant',
    'src',
    '__module_boundary_check__.ts',
  ),
  contract: path.join(
    'libs',
    'contracts',
    'db-types-biz',
    'src',
    '__module_boundary_check__.ts',
  ),
};

const packages = {
  secret: getPackageName('libs/data-access/supabase-secret/package.json'),
  ui: getPackageName('libs/shared/ui/package.json'),
  domain: getPackageName('libs/domain/tenant/package.json'),
  dataAccess: getPackageName('libs/data-access/supabase-biz/package.json'),
};

const sources = {
  webForbidden: readFixture(fixtures.webForbidden, {
    __SECRET_PACKAGE__: packages.secret,
  }),
  secretAllowed: readFixture(fixtures.secretAllowed, {
    __SECRET_PACKAGE__: packages.secret,
  }),
  domainForbidden: readFixture(fixtures.domainForbidden, {
    __UI_PACKAGE__: packages.ui,
  }),
  contractForbidden: readFixture(fixtures.contractForbidden, {
    __DOMAIN_PACKAGE__: packages.domain,
    __DATA_ACCESS_PACKAGE__: packages.dataAccess,
  }),
};

let failure = false;

await writeFileAtomic(tempFiles.web, sources.webForbidden);
await writeFileAtomic(tempFiles.secret, sources.secretAllowed);
await writeFileAtomic(tempFiles.domain, sources.domainForbidden);
await writeFileAtomic(tempFiles.contract, sources.contractForbidden);

try {
  failure =
    (await expectLintFailure(
      tempFiles.web,
      'Expected web forbidden import to fail lint.',
    )) || failure;
  failure =
    (await expectLintSuccess(
      tempFiles.secret,
      'Expected secret-service import to pass lint.',
    )) || failure;
  failure =
    (await expectLintFailure(
      tempFiles.domain,
      'Expected domain -> ui import to fail lint.',
    )) || failure;
  failure =
    (await expectLintFailure(
      tempFiles.contract,
      'Expected contract -> domain/data-access import to fail lint.',
    )) || failure;
} finally {
  await Promise.allSettled(
    Object.values(tempFiles).map((targetPath) =>
      fs.rm(targetPath, { force: true }),
    ),
  );
}

if (failure) {
  process.exit(1);
}

console.log('Module boundary fixture checks passed.');

async function expectLintFailure(targetFile, message) {
  const lint = runEslint([targetFile]);
  const output = `${lint.stdout}\n${lint.stderr}`;
  if (lint.status === 0) {
    console.error(message);
    console.error('eslint exited with code 0 but a failure was expected.');
    return true;
  }
  if (!output.includes('@nx/enforce-module-boundaries')) {
    console.error(message);
    console.error('Expected @nx/enforce-module-boundaries in lint output.');
    console.error(output.trim());
    return true;
  }
  return false;
}

async function expectLintSuccess(targetFile, message) {
  const lint = runEslint([targetFile]);
  if (lint.status !== 0) {
    console.error(message);
    console.error(`${lint.stdout}\n${lint.stderr}`.trim());
    return true;
  }
  return false;
}

function runEslint(args) {
  return spawnSync(process.execPath, [eslintBin, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function getPackageName(packageJsonPath) {
  const name = JSON.parse(readFileSync(packageJsonPath, 'utf8')).name;
  if (!name || typeof name !== 'string') {
    console.error(`Invalid package name in ${packageJsonPath}`);
    process.exit(1);
  }
  return name;
}

function readFixture(filePath, replacements) {
  let source = readFileSync(filePath, 'utf8');
  for (const [placeholder, value] of Object.entries(replacements)) {
    source = source.replaceAll(placeholder, value);
  }
  return source;
}

async function writeFileAtomic(targetPath, content) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${content.trimEnd()}\n`, 'utf8');
}
