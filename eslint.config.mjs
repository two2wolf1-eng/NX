import nx from '@nx/eslint-plugin';

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
          depConstraints: [
            {
              sourceTag: 'scope:web',
              onlyDependOnLibsWithTags: ['*'],
              notDependOnLibsWithTags: ['data:secret', 'secret-access-lib'],
            },
            {
              sourceTag: 'scope:admin',
              onlyDependOnLibsWithTags: ['*'],
              notDependOnLibsWithTags: ['data:secret', 'secret-access-lib'],
            },
            {
              sourceTag: 'scope:marketing',
              onlyDependOnLibsWithTags: ['*'],
              notDependOnLibsWithTags: ['data:secret', 'secret-access-lib'],
            },
            {
              sourceTag: 'scope:worker',
              onlyDependOnLibsWithTags: ['*'],
              notDependOnLibsWithTags: ['data:secret', 'secret-access-lib'],
            },
            {
              sourceTag: 'layer:shared',
              onlyDependOnLibsWithTags: ['*'],
              notDependOnLibsWithTags: ['secret-access-lib'],
            },
            {
              sourceTag: 'type:lib',
              onlyDependOnLibsWithTags: ['*'],
              notDependOnLibsWithTags: ['type:app', 'secret-access-lib'],
            },
            {
              sourceTag: 'layer:domain',
              onlyDependOnLibsWithTags: ['*'],
              notDependOnLibsWithTags: ['layer:ui'],
            },
            {
              sourceTag: 'layer:contract',
              onlyDependOnLibsWithTags: ['layer:shared'],
            },
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*'],
            },
          ],
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
    // Override or add rules here
    rules: {},
  },
];
