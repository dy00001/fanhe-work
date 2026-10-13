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
      // 依赖重建遗留的备份目录。它只含第三方包，名字却不匹配 node_modules，
      // 于是被 lint 与 format 扫到，产生大量与源码无关的报错。
      '**/node_modules.old/**',
      // 临时目录。`ws-env.sh` 会把 TMP/TEMP 指到这里，所以调试脚本、隔离出来的
      // 坏依赖、各种一次性的取证产物都往这儿丢。它已在 .gitignore 与
      // .prettierignore 里，唯独漏了这一处 —— 2026-10-13 往 .tmp 放了一份
      // node_modules 隔离副本，直接让 lint 报出 11064 条错，全部与源码无关。
      // 这三处忽略规则必须一起维护（见工作区 MEMORY.md「门禁 / 忽略」）。
      '.tmp/**',
      // electron-builder 的输出目录（`apps/desktop/release/`，配置见
      // `apps/desktop/electron-builder.yml`）。装的是整份 Electron 运行时与
      // 前端构建产物，全是机器产物。`dist/` 被忽略而它不是 —— 因为默认输出目录
      // 本来是 `dist`，为了不与 tsc 撞车才改名成 `release`，于是错过了那条规则。
      // 2026-10-13 实测：漏了它，仅 `resources/web/assets/index-*.js` 一项就报 2238 条。
      '**/release/**',
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

  // shadcn/ui 的组件源码按官方版本原样搬入，不随项目风格改写。其中 button 与 badge
  // 既导出组件、又导出 cva 生成的变体常量，触发了 fast refresh 的「只导出组件」
  // 规则。这条规则约束的是 HMR 边界，代价仅限于这两个文件在编辑时可能整页刷新
  // 一次，而保持源码能逐行对照官方版本的收益更大，所以在这一层关掉而不是拆文件。
  {
    files: ['apps/web/src/components/ui/**/*.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },

  // Server, desktop shell and shared code, plus the tool configuration files.
  // The desktop shell is Node-side code (Electron main and preload processes),
  // so it needs the Node globals for the same reason apps/api does.
  {
    files: [
      'apps/api/**/*.{ts,tsx}',
      'apps/desktop/**/*.{ts,tsx}',
      'apps/desktop/scripts/**/*.mjs',
      'apps/desktop/test/**/*.mjs',
      'packages/**/*.{ts,tsx}',
      '**/*.config.{js,mjs,ts}',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // 浏览器级端到端验证脚本。跑在 Node 里，但操作对象是浏览器，所以两边全局都要
  // 认。WebSocket 与 fetch 在这里用的是 Node 22 自带的实现，不引第三方包。
  {
    files: ['apps/web/test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // 诊断与校验脚本（tools/）。跑在 Node 里，直接碰文件系统与子进程，所以只给 Node
  // 全局。不给这一层的话，js.configs.recommended 的 no-undef 会把 process 与
  // console 报成未定义。
  {
    files: ['tools/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
]
