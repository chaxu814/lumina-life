// ESLint v9 Flat Config（替代旧 .eslintrc.json）
// 设计原则：历史代码以 warn 渐进收敛，error 只留会真出 bug 的几条，保证 CI 可跑通。
import js from '@eslint/js'
import tseslintParser from '@typescript-eslint/parser'
import tseslintPlugin from '@typescript-eslint/eslint-plugin'

export default [
  {
    ignores: [
      'node_modules/',
      'out/',
      'dist/',
      'coverage/',
      '.cowork-temp/',       // 临时工作区（评测/调试脚本），不属于产品代码
      'electron/pet/assets/',   // esbuild 构建产物
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslintParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslintPlugin,
    },
    rules: {
      // TS 编译器已负责未定义变量，避免对 Electron/浏览器全局误报
      'no-undef': 'off',
      // 未用变量交给 @typescript-eslint 版本（warn），关闭基础版避免重复 error
      'no-unused-vars': 'off',
      'no-console': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
      // 历史风格问题渐进收敛为 warn，不阻断 CI；新代码靠评审与规则可见性约束
      'eqeqeq': ['warn', 'always'],
      'no-useless-escape': 'warn',
      'no-case-declarations': 'warn',
      'no-control-regex': 'warn',
      'no-redeclare': 'warn',
      'no-async-promise-executor': 'warn',
      // 项目大量使用「catch { 不阻塞 }」防御式写法，空 catch 是有意为之，放行
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-misleading-character-class': 'off',
      'curly': 'warn',
      'no-throw-literal': 'warn',
      // 渐进收敛：未用变量/any/ts-comment 先 warn，不阻断 CI。
      // 总量靠 scripts/lint-ratchet.cjs 做棘轮管理（只允许变小），
      // 这样“历史债务”不会变成“随手新增也不报”的借口。
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-empty-object-type': 'off',
      // ⚠️ react-hooks 插件未接入。src/panels/TeamTopologyView.tsx 曾留过一条
      // `eslint-disable-next-line react-hooks/exhaustive-deps`，但本配置并未加载
      // 该插件，引用不存在的规则会直接报 error（v3.34 已把那条死注释移除）。
      // 接入 react-hooks（exhaustive-deps 对 47 个 React 面板能抓出真 bug）
      // 建议作为独立 PR，理由是需要新增 devDependency。
    },
  },
]
