# web_search_multi

多引擎智能搜索 Skill — 三引擎并行 + 智能查询分解 + 去重聚合。

## 触发词
搜索、查一下、帮我搜、网上有没有、最新信息、找资料、research

## ⚠️ 核心原则

**永远不要在最终回复中描述你用了什么工具或搜索了哪些引擎。**
这些信息由系统自动展示在"🧠思考过程"面板中。你的回复应该直接给出答案，就像你本来就
知道一样。

❌ 错误：「我用 Bing 搜索了一下，找到了...」
✅ 正确：「根据最新资料，...」

## 工作流

### Phase 1: 智能查询分解
将用户问题拆解为多个搜索方向（最多 4 个维度）：
- **中文精准匹配**：用中文关键词 → engine=baidu
- **英文技术资料**：翻译为英文关键词 → engine=google 或 engine=bing
- **最新资讯**：加时间限定词如「2025」「最新」→ engine=bing
- **权威来源**：site: 限定词（如 site:github.com 或 site:zhihu.com）→ engine=google

### Phase 2: 三引擎并行搜索
对每个查询方向，使用 `web_search` 工具并行搜索（每次用不同引擎）：
```
web_search(query="中文关键词", engine="baidu", count=5)
web_search(query="English keywords", engine="google", count=5)
web_search(query="English keywords", engine="bing", count=5)
web_search(query="site:权威来源 关键词", engine="google", count=3)
```

总计 3-4 次并行搜索，覆盖百度中文、Google英文、Bing 综合。

### Phase 3: 去重与排序
对搜索结果按以下规则排序：
1. **优先权威来源**：官方文档 > Wikipedia > 知名媒体 > 个人博客
2. **优先时效性**：1 周内 > 1 月内 > 1 年内 > 更早
3. **优先语言匹配**：用户问中文 → 中文结果优先
4. **去重**：相同 URL 或多个结果指向同一内容 → 只保留最优的 1 条
5. **过滤**：跳过纯广告页、404页面、不相关内容

### Phase 4: 提取与回答
- 从 Top 5 结果中提取关键信息
- 如果搜索结果不充分，用不同关键词再搜一轮（最多 2 轮）
- 最终回复中**禁止**出现「搜索结果显示」「根据Bing搜索」等元描述

## 搜索质量规则

### 不同场景的引擎选择
| 场景 | 主引擎 | 辅助引擎 | 说明 |
|------|--------|----------|------|
| 中文资讯 | baidu | bing | 百度对中文内容索引更全 |
| 技术文档 | google | bing | Google 对英文技术内容更好 |
| 最新新闻 | bing | baidu | Bing 新闻时效性较好 |
| 学术资料 | google | bing | 用 site:scholar 限定 |
| 代码/GitHub | google | - | site:github.com |
| 国内热点 | baidu | - | 仅百度即可 |

### 结果数量控制
- 简单查询：count=3（减少噪音）
- 一般查询：count=5（默认）
- 深度研究：count=8（需要更多信息时）

### 失败处理
- 某个引擎超时/失败 → 自动切换到备用引擎
- 所有引擎无结果 → 告知用户「未找到相关信息」+ 建议调整关键词

## 适用 Agent
Yak（主）, 热茶（技术搜索）

## 依赖工具
web_search（支持 engine 参数: bing/google/baidu）
