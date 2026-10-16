import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'LuminaLife',
  description: '基于 Electron + React 的 AI Agent 多模态桌宠',
  lang: 'zh-CN',
  base: '/lumina-life/',
  // internal/ 下是历史自评/修复日志，archive/ 下是更早的历史报告，两者都不编入
  // VitePress 路由（archive/ 未随仓库分发，若纳入会导致本地构建出现死链而失败）。
  srcExclude: ['internal/**', 'archive/**', '**/_*.md'],
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
