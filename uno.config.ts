// ============================================================
// uno.config.ts — UnoCSS 配置
//
// 使用 preset-uno（Tailwind / Windi CSS 兼容规则集）
// 搭配 transformer-directives（支持 @apply @screen 等）
// ============================================================

import { defineConfig, presetUno } from 'unocss'
import transformerDirectives from '@unocss/transformer-directives'

export default defineConfig({
  presets: [
    presetUno({
      // 不使用 Tailwind 默认的 preflight（保留 Lumina 自己的 reset）
      preflight: false,
    }),
  ],
  transformers: [transformerDirectives()],
  // 自定义主题 → 映射到 global.css 的 CSS 变量
  theme: {
    colors: {
      surface: {
        DEFAULT: 'var(--surface-0)',
        0: 'var(--surface-0)',
        50: 'var(--surface-50)',
        100: 'var(--surface-100)',
        200: 'var(--surface-200)',
        300: 'var(--surface-300)',
      },
      text: {
        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        tertiary: 'var(--text-tertiary)',
        disabled: 'var(--text-disabled)',
        inverse: 'var(--text-inverse)',
      },
      accent: {
        50: 'var(--accent-50)',
        100: 'var(--accent-100)',
        400: 'var(--accent-400)',
        500: 'var(--accent-500)',
        600: 'var(--accent-600)',
        700: 'var(--accent-700)',
      },
      green: {
        100: 'var(--green-100)',
        500: 'var(--green-500)',
      },
      yellow: {
        100: 'var(--yellow-100)',
        500: 'var(--yellow-500)',
      },
      red: {
        100: 'var(--red-100)',
        500: 'var(--red-500)',
      },
      border: {
        light: 'var(--border-light)',
        medium: 'var(--border-medium)',
        heavy: 'var(--border-heavy)',
      },
    },
    borderRadius: {
      sm: 'var(--radius-sm)',
      md: 'var(--radius-md)',
      lg: 'var(--radius-lg)',
      xl: 'var(--radius-xl)',
      full: 'var(--radius-full)',
    },
    fontFamily: {
      sans: 'var(--font-sans)',
      display: 'var(--font-display)',
      mono: 'var(--font-mono)',
    },
    fontSize: {
      '2xs': 'var(--font-size-2xs)',
      xs: 'var(--font-size-xs)',
      sm: 'var(--font-size-sm)',
      base: 'var(--font-size-base)',
      md: 'var(--font-size-md)',
      lg: 'var(--font-size-lg)',
      xl: 'var(--font-size-xl)',
      '2xl': 'var(--font-size-2xl)',
    },
    spacing: {
      1: 'var(--space-1)',
      2: 'var(--space-2)',
      3: 'var(--space-3)',
      4: 'var(--space-4)',
      5: 'var(--space-5)',
      6: 'var(--space-6)',
      8: 'var(--space-8)',
      10: 'var(--space-10)',
      12: 'var(--space-12)',
    },
    boxShadow: {
      xs: 'var(--shadow-xs)',
      sm: 'var(--shadow-sm)',
      md: 'var(--shadow-md)',
      lg: 'var(--shadow-lg)',
    },
  },
  rules: [
    // 兼容旧有 var() 引用：让 Tailwind 类名如 `bg-surface-0` 生效
  ],
  shortcuts: {
    // ── 常用组件组合 ──
    'btn': 'inline-flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium cursor-pointer border-none transition-all duration-200',
    'btn-primary': 'btn bg-accent-500 text-white hover:bg-accent-600 active:bg-accent-700',
    'btn-sm': 'btn px-2 py-1 text-xs',
    'btn-active': 'bg-accent-50 text-accent-600',
    'card': 'bg-surface-0 border border-light rounded-lg p-4 shadow-sm',
    'card-hover': 'card hover:shadow-md transition-shadow duration-200',
    'chip': 'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-surface-100 text-text-secondary cursor-pointer transition-all',
    'chip-active': 'bg-accent-50 text-accent-600',
    'tag': 'inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs font-medium',
  },
})
