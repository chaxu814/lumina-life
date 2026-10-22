// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'LuminaLife',
  description: '基于 Electron + React 的 AI Agent 多模态桌宠',
  lang: 'zh-CN',
  base: '/lumina-life/',
  // internal/ 下是历史自评/修复日志，archive/ 下是更早的历史报告，两者都不编入
  // VitePress 路由（archive/ 未随仓库分发，若纳入会导致本地构建出现死链而失败）。
  // docs 根下的项目方自评/竞品/交付报告（Lumina-*、competitor-research-*、发布修复交付报告-*）
  // 属于内部材料，虽已被 .gitignore 排除、不随仓库分发，但本地磁盘上仍在 srcDir 内，
  // 必须显式 srcExclude，否则本地 `vitepress build` 会把它们编成公开路由。
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
  themeConfig: {
    logo: '/icon.png',
    siteTitle: 'LuminaLife',
    nav: [
      { text: '首页', link: '/' },
      { text: 'API 文档', link: '/API' },
      { text: 'FAQ', link: '/FAQ' },
      { text: '故障排除', link: '/TROUBLESHOOTING' },
      {
        text: 'GitHub',
        link: 'https://github.com/chaxu814/lumina-life',
      },
    ],
    sidebar: [
      {
        text: '快速入门',
        items: [
          { text: '概述', link: '/' },
          { text: '架构设计', link: '/ARCHITECTURE' },
          { text: '实验功能说明', link: '/features' },
        ],
      },
      {
        text: '开发指引',
        items: [
          { text: '开发者指南', link: '/DEVELOPER' },
          { text: 'API 文档', link: '/API' },
        ],
      },
      {
        text: '文档',
        items: [
          { text: 'FAQ', link: '/FAQ' },
          { text: '故障排除', link: '/TROUBLESHOOTING' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/chaxu814/lumina-life' },
    ],
    footer: {
      message: '基于 AGPL-3.0 或 Apache-2.0 双许可开源',
      copyright: `Copyright © ${new Date().getFullYear()} LuminaLife`,
    },
    lastUpdated: false,
    search: {
      provider: 'local',
    },
  },
  lastUpdated: false,
})
