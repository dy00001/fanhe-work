import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Flat config. ESLint 10 resolves plugins relative to this file, so every
// plugin is installed once at the workspace root instead of per package.
export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      // Prisma 生成的客户端。机器产物，改动它的格式没有任何意义，
      // 而且下次 generate 会整体覆盖。
      '**/src/generated/**',
      // Runtime data and database volumes never belong to the sources.
      'data/**',
      // Reference UI mockups are frozen artefacts that were reviewed and
      // approved as rendered pages. Reformatting them risks changing output.
      'docs/mockups/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // The base rule cannot see type annotations, so the TypeScript aware
      // variant is the one that must stay enabled.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Browser code: the web app and the React specific plugins.
  {
    ...reactHooks.configs.flat.recommended,
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      ...reactHooks.configs.flat.recommended.plugins,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Server and shared code, plus the tool configuration files.
  {
    files: ['apps/api/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}', '**/*.config.{js,mjs,ts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
]
