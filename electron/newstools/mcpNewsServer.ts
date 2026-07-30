// ============================================================
// newstools/mcpNewsServer.ts — MCP 新闻服务 v1.0
//
// 借鉴 Horizon 的 MCP Server 架构：以轻量 MCP 协议提供新闻服务
// 每个工具独立可调，前端通过 MCP client 调用
// ============================================================

export interface MCPToolDef {
  name: string
  description: string
  inputSchema: Record<string, any>
  handler: (params: any) => Promise<any>
}

/** 注册新闻 MCP 工具列表 */
export function getNewsMCPTools(mainWindow?: any): MCPToolDef[] {
  return [
    {
      name: 'news_collect',
      description: '采集所有新闻源的最新内容',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const { collectAll } = await import('../tools/impl/newsCollector')
        const { deduplicate } = await import('../tools/impl/newsDigest')
        const allItems = await collectAll()
        const items = deduplicate(allItems)
        return {
          count: items.length,
          items: items.slice(0, 50).map(item => ({
            title: item.title, url: item.url, source: item.source,
            category: item.category, summary: item.summary,
            hotScore: item.hotScore, pubDate: item.pubDate,
          })),
        }
      },
    },
    {
      name: 'news_fetch_full',
      description: '用 Trafilatura 提取文章全文',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: '文章 URL' } }, required: ['url'] },
      handler: async (params: { url: string }) => {
        const { extractFullText } = await import('./trafilaturaExtractor')
        return extractFullText(params.url)
      },
    },
    {
      name: 'news_generate_digest',
      description: '生成中英双语日报摘要',
      inputSchema: { type: 'object', properties: { maxItems: { type: 'number', default: 20 }, includeEnglish: { type: 'boolean', default: true } } },
      handler: async (params: { maxItems?: number; includeEnglish?: boolean }) => {
        const { generateBilingualDigest } = await import('./bilingualDigest')
        return generateBilingualDigest(params.maxItems || 20, params.includeEnglish !== false)
      },
    },
    {
      name: 'news_manage_subscription',
      description: '管理邮件订阅（订阅/退订/列表）',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['subscribe','unsubscribe','list','status'] }, email: { type: 'string' } }, required: ['action'] },
      handler: async (params: { action: string; email?: string }) => {
        const { manageSubscription } = await import('./subscriptionManager')
        return manageSubscription(params.action, params.email)
      },
    },
    {
      name: 'news_publish_site',
      description: '发布日报到 GitHub Pages 站点',
      inputSchema: { type: 'object', properties: { source: { type: 'string', enum: ['latest','date'] }, date: { type: 'string' } }, required: ['source'] },
      handler: async (params: { source: string; date?: string }) => {
        const { publishToGitHubPages } = await import('./ghPagesPublisher')
        return publishToGitHubPages(params.source, params.date)
      },
    },
  ]
}
