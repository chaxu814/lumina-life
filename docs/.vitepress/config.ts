import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'LuminaLife',
  description: '基于 Electron + React 的 AI Agent 多模态桌宠',
  lang: 'zh-CN',
  base: '/LuminaLife/',
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
        link: 'https://github.com/lumina-life/lumina-life',
      },
    ],
    sidebar: [
      {
        text: '快速入门',
        items: [
          { text: '概述', link: '/' },
          { text: '架构设计', link: '/architecture' },
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
      { icon: 'github', link: 'https://github.com/lumina-life/lumina-life' },
    ],
    footer: {
      message: '基于 MIT 协议开源',
      copyright: `Copyright © ${new Date().getFullYear()} LuminaLife`,
    },
    lastUpdated: false,
    search: {
      provider: 'local',
    },
  },
  lastUpdated: false,
})
