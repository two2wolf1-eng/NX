import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const [projectName, action] = process.argv.slice(2);

if (!projectName || !action) {
  console.error(
    'Usage: node tools/scripts/supabase-placeholder.mjs <supabase-biz|supabase-secret> <action>'
  );
  process.exit(1);
}

const workspaceRoot = process.cwd();
const supabaseRoot = path.join(workspaceRoot, 'apps', projectName, 'supabase');
const migrationsDir = path.join(supabaseRoot, 'migrations');
const contractsOut =
  projectName === 'supabase-biz'
    ? path.join(
        workspaceRoot,
        'libs',
        'contracts',
        'db-types-biz',
        'src',
        'lib',
        'generated.ts'
      )
    : path.join(
        workspaceRoot,
        'libs',
        'contracts',
        'db-types-secret',
        'src',
        'lib',
        'generated.ts'
      );

switch (action) {
  case 'start':
  case 'stop':
  case 'status':
  case 'migrate-prod': {
    console.log(
      `[${projectName}] ${action} placeholder. Run Supabase CLI in internal environment as needed.`
    );
    break;
  }
  case 'db-diff': {
    await fs.mkdir(migrationsDir, { recursive: true });
    const filePath = path.join(migrationsDir, '00000000000000_placeholder.sql');
    const content = [
      '-- placeholder migration file',
      '-- replace with `supabase db diff` output in internal workflows',
      '',
    ].join('\n');
    if (!(await exists(filePath))) {
      await fs.writeFile(filePath, content, 'utf8');
    }
    console.log(`[${projectName}] db-diff placeholder completed.`);
    break;
  }
  case 'gen-types': {
    await fs.mkdir(path.dirname(contractsOut), { recursive: true });
    const body = [
      '// Placeholder for generated Supabase DB types.',
      '// Replace with output from Supabase CLI in secure environments.',
      'export type Database = {',
      `  source: '${projectName}';`,
      '};',
      '',
    ].join('\n');
    await fs.writeFile(contractsOut, body, 'utf8');
    console.log(`[${projectName}] gen-types placeholder completed.`);
    break;
  }
  default: {
    console.error(`Unsupported action: ${action}`);
    process.exit(1);
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
