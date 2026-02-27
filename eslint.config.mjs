import nx from '@nx/eslint-plugin';

const depConstraints = [
  {
    sourceTag: 'type:app',
    notDependOnLibsWithTags: ['type:e2e'],
  },
  {
    sourceTag: 'type:lib',
    notDependOnLibsWithTags: ['type:app', 'type:e2e'],
  },
  {
    sourceTag: 'type:e2e',
    onlyDependOnLibsWithTags: [
      'type:app',
      'scope:testing',
      'scope:shared',
      'scope:contracts',
      'layer:testing',
      'layer:shared',
      'layer:contracts',
    ],
  },
  {
    sourceTag: 'type:tooling',
    onlyDependOnLibsWithTags: [
      'scope:tooling',
      'scope:shared',
      'scope:platform',
      'layer:tooling',
      'layer:shared',
      'layer:platform',
    ],
  },

  {
    sourceTag: 'layer:contracts',
    onlyDependOnLibsWithTags: [
      'layer:contracts',
      'layer:shared',
      'scope:shared',
      'scope:contracts',
      'platform:isomorphic',
    ],
  },
  {
    sourceTag: 'layer:domain',
    onlyDependOnLibsWithTags: [
      'layer:domain',
      'layer:contracts',
      'layer:shared',
      'scope:contracts',
      'scope:shared',
      'platform:isomorphic',
    ],
    notDependOnLibsWithTags: ['layer:data-access', 'layer:ui'],
  },
  {
    sourceTag: 'layer:data-access',
    onlyDependOnLibsWithTags: [
      'layer:data-access',
      'layer:domain',
      'layer:contracts',
      'layer:shared',
      'layer:platform',
      'scope:shared',
      'scope:contracts',
      'scope:platform',
    ],
    notDependOnLibsWithTags: ['layer:ui', 'layer:feature'],
  },
  {
    sourceTag: 'layer:feature',
    onlyDependOnLibsWithTags: [
      'layer:feature',
      'layer:domain',
      'layer:data-access',
      'layer:contracts',
      'layer:ui',
      'layer:shared',
      'scope:shared',
      'scope:contracts',
    ],
  },
  {
    sourceTag: 'layer:ui',
    onlyDependOnLibsWithTags: [
      'layer:ui',
      'layer:contracts',
      'layer:shared',
      'scope:shared',
      'scope:contracts',
      'platform:browser',
      'platform:isomorphic',
    ],
    notDependOnLibsWithTags: ['layer:data-access'],
  },
  {
    sourceTag: 'layer:platform',
    onlyDependOnLibsWithTags: [
      'layer:platform',
      'layer:shared',
      'layer:contracts',
      'scope:shared',
      'scope:contracts',
    ],
    notDependOnLibsWithTags: ['layer:ui', 'layer:feature'],
  },
  {
    sourceTag: 'layer:testing',
    onlyDependOnLibsWithTags: [
      'layer:testing',
      'layer:shared',
      'layer:contracts',
      'scope:shared',
      'scope:contracts',
      'scope:testing',
    ],
  },

  {
    sourceTag: 'platform:browser',
    notDependOnLibsWithTags: ['platform:node'],
  },

  {
    sourceTag: 'product:web',
    onlyDependOnLibsWithTags: [
      'scope:biz',
      'scope:shared',
      'scope:contracts',
      'scope:platform',
      'platform:isomorphic',
      'platform:browser',
    ],
    notDependOnLibsWithTags: ['data:secret', 'scope:secret'],
  },
  {
    sourceTag: 'product:admin',
    onlyDependOnLibsWithTags: [
      'scope:biz',
      'scope:shared',
      'scope:contracts',
      'scope:platform',
      'platform:isomorphic',
      'platform:browser',
    ],
    notDependOnLibsWithTags: ['data:secret', 'scope:secret'],
  },
  {
    sourceTag: 'product:marketing',
    onlyDependOnLibsWithTags: [
      'scope:shared',
      'scope:contracts',
      'scope:platform',
      'platform:isomorphic',
      'platform:browser',
    ],
    notDependOnLibsWithTags: ['data:secret', 'scope:secret', 'scope:biz'],
  },
  {
    sourceTag: 'product:secret-service',
    onlyDependOnLibsWithTags: [
      'scope:secret',
      'scope:shared',
      'scope:contracts',
      'scope:platform',
      'platform:node',
      'platform:isomorphic',
    ],
  },
  {
    sourceTag: 'product:worker',
    onlyDependOnLibsWithTags: [
      'scope:biz',
      'scope:secret',
      'scope:shared',
      'scope:contracts',
      'scope:platform',
      'platform:node',
      'platform:isomorphic',
    ],
  },
  {
    sourceTag: 'product:ai-indexer',
    onlyDependOnLibsWithTags: [
      'scope:shared',
      'scope:contracts',
      'scope:platform',
      'scope:tooling',
      'platform:node',
    ],
    notDependOnLibsWithTags: ['data:secret'],
  },
  {
    sourceTag: 'product:code-search',
    onlyDependOnLibsWithTags: [
      'scope:shared',
      'scope:tooling',
      'scope:platform',
      'platform:node',
    ],
    notDependOnLibsWithTags: ['data:secret'],
  },
  {
    sourceTag: 'product:workspace',
    onlyDependOnLibsWithTags: [
      'scope:tooling',
      'scope:shared',
      'scope:platform',
      'platform:node',
    ],
  },
  {
    sourceTag: 'product:supabase-biz',
    onlyDependOnLibsWithTags: [
      'scope:biz',
      'scope:shared',
      'scope:contracts',
      'scope:platform',
      'platform:node',
      'platform:isomorphic',
    ],
    notDependOnLibsWithTags: ['data:secret', 'scope:secret'],
  },
  {
    sourceTag: 'product:supabase-secret',
    onlyDependOnLibsWithTags: [
      'scope:secret',
      'scope:shared',
      'scope:contracts',
      'scope:platform',
      'platform:node',
      'platform:isomorphic',
    ],
  },

  {
    sourceTag: 'scope:biz',
    notDependOnLibsWithTags: ['scope:secret', 'data:secret'],
  },
  {
    sourceTag: 'scope:secret',
    notDependOnLibsWithTags: ['scope:biz'],
  },
  {
    sourceTag: 'scope:contracts',
    onlyDependOnLibsWithTags: [
      'scope:contracts',
      'scope:shared',
      'layer:shared',
      'platform:isomorphic',
    ],
  },
  {
    sourceTag: 'scope:shared',
    onlyDependOnLibsWithTags: [
      'scope:shared',
      'scope:contracts',
      'layer:shared',
      'layer:contracts',
      'platform:isomorphic',
      'platform:browser',
      'platform:node',
    ],
  },
];

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc', '**/test-output'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints,
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    rules: {},
  },
];
