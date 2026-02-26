# Nx Monorepo Baseline

This workspace contains:

- Product apps: `web`, `admin`, `marketing`, `worker`, `secret-service`, `ai-indexer`
- E2E apps: `web-e2e`, `admin-e2e`
- Infra apps: `supabase-biz`, `supabase-secret`, `code-search`
- Libraries: `libs/shared/*`, `libs/data-access/*`, `libs/domain/*`, `libs/contracts/*`, `libs/testing/*`
- Agent index artifacts: `docs/agent-index/*`

## Core commands

```bash
npx nx show projects
npx nx affected -t lint test build
npx nx run ai-indexer:sync
npx nx run ai-indexer:validate
npx nx run supabase-biz:pack-migrations
npx nx run supabase-secret:pack-migrations
```

## Local toolchain

- Recommended Node.js: `22.x` (CI uses Node 22).
- Use `.nvmrc`:

```bash
nvm use
```

## Security model

- `data-access-supabase-secret` is restricted to `secret-service`.
- `web` and `admin` cannot depend on `data:secret` libraries.
- Module-boundary checks are enforced through `@nx/enforce-module-boundaries`.

## Lint configuration

- ESLint uses flat config only: `eslint.config.mjs`.

## Strict release sign-off

Run in this exact order on a clean worktree:

1. Ensure clean workspace: `git status --porcelain` must be empty
2. `npx nx format:write --all`
3. `npm ci`
4. `npx nx run workspace-policy:release-audit`
## CI workflows

- `ci.yml`: `nx-set-shas` + affected lint/test/build + main-branch e2e + `nx-cloud start-ci-run` + `nx fix-ci` (always)
- `index.yml`: `ai-indexer:sync` + index diff gate + `ai-indexer:validate`
- `migrations.yml`: package migration bundles only (no production DB migration)
- `release.yml`: manual Nx release workflow
