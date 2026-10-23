// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import { defineConfig } from 'vitepress'

const repo = 'https://github.com/chaxu814/lumina-life'

// ── English (root locale) ──────────────────────────────
const enNav = [
  { text: 'Home', link: '/' },
  { text: 'Features', link: '/features' },
  { text: 'Install', link: '/INSTALL' },
  { text: 'FAQ', link: '/FAQ' },
  { text: 'GitHub', link: repo },
]

const enSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Overview', link: '/' },
      { text: 'Architecture', link: '/ARCHITECTURE' },
      { text: 'Features', link: '/features' },
      { text: 'Installation', link: '/INSTALL' },
    ],
  },
  {
    text: 'Development',
    items: [
      { text: "Developer Guide", link: '/DEVELOPER' },
      { text: 'API Reference', link: '/API' },
      { text: 'Roadmap', link: '/ROADMAP' },
    ],
  },
  {
    text: 'Support',
    items: [
      { text: 'FAQ', link: '/FAQ' },
      { text: 'Troubleshooting', link: '/TROUBLESHOOTING' },
    ],
  },
]

// ── 简体中文 (zh-CN locale) ────────────────────────────
const zhNav = [
  { text: '首页', link: '/zh-CN/' },
  { text: '功能', link: '/zh-CN/features' },
  { text: '安装', link: '/zh-CN/INSTALL' },
  { text: 'FAQ', link: '/zh-CN/FAQ' },
  { text: 'GitHub', link: repo },
]

const zhSidebar = [
  {
    text: '快速入门',
    items: [
      { text: '概述', link: '/zh-CN/' },
      { text: '架构设计', link: '/zh-CN/ARCHITECTURE' },
      { text: '实验功能说明', link: '/zh-CN/features' },
      { text: '安装指南', link: '/zh-CN/INSTALL' },
    ],
  },
  {
    text: '开发指引',
    items: [
      { text: '开发者指南', link: '/zh-CN/DEVELOPER' },
      { text: 'API 文档', link: '/zh-CN/API' },
      { text: '路线图', link: '/zh-CN/ROADMAP' },
    ],
  },
  {
    text: '文档',
    items: [
      { text: 'FAQ', link: '/zh-CN/FAQ' },
      { text: '故障排除', link: '/zh-CN/TROUBLESHOOTING' },
    ],
  },
  {
    text: '游戏陪伴',
    items: [
      { text: '游戏陪伴总览', link: '/zh-CN/gaming-overview' },
      { text: 'Minecraft 指南', link: '/zh-CN/gaming-minecraft' },
      { text: '游戏安全', link: '/zh-CN/game-safety' },
      { text: '游戏配置说明', link: '/zh-CN/game-profiles-guide' },
    ],
  },
  {
    text: '自定义与扩展',
    items: [
      { text: '自定义 Agent 指南', link: '/zh-CN/custom-agent-guide' },
      { text: '技能教程', link: '/zh-CN/skill-tutorial' },
      { text: '形象指南', link: '/zh-CN/avatar-guide' },
      { text: '联邦与端到端加密设计', link: '/zh-CN/federation-e2ee-design' },
    ],
  },
  {
    text: '工程与发布',
    items: [
      { text: '性能说明', link: '/zh-CN/performance' },
      { text: '基准测试', link: '/zh-CN/BENCHMARKS' },
      { text: '代码签名', link: '/zh-CN/code-signing' },
      { text: '跨平台状态', link: '/zh-CN/cross-platform-status' },
      { text: '发布清单', link: '/zh-CN/RELEASE_CHECKLIST' },
      { text: '死代码清理记录', link: '/zh-CN/DEAD_CODE_CLEANUP-20261016' },
    ],
  },
]

export default defineConfig({
  title: 'LuminaLife',
  description: 'AI Agent multimodal desktop companion built with Electron + React',
  base: '/lumina-life/',
  srcExclude: [
    'internal/**',
    'archive/**',
    '**/_*.md',
    'Lumina-*.md',
    'Lumina-*.html',
    'Lumina-*.docx',
    'competitor-research-*.md',
    'competitor-research-*.html',
    '发布修复交付报告-*.md',
    '发布修复交付报告-*.html',
    '发布修复交付报告-*.docx',
  ],
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: enNav,
        sidebar: enSidebar,
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh-CN/',
      themeConfig: {
        nav: zhNav,
        sidebar: zhSidebar,
      },
    },
  },
  themeConfig: {
    logo: '/icon.png',
    siteTitle: 'LuminaLife',
    socialLinks: [{ icon: 'github', link: repo }],
    footer: {
      message: 'Open source under dual license AGPL-3.0 OR Apache-2.0',
      copyright: `Copyright © ${new Date().getFullYear()} LuminaLife`,
    },
    lastUpdated: false,
    search: {
      provider: 'local',
    },
  },
  lastUpdated: false,
})
