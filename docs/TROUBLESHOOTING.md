# Lumina 常见错误排查手册

> 最后更新：2026-07-14 · 按报错信息（或现象）查找对应步骤

---

## 1. `Error: connect ECONNREFUSED 127.0.0.1:443`

**现象：** 启动时报网络连接被拒绝。

**根因：** LLM API 的 `baseUrl` 配错了，或者网络不通。

**排查步骤：**
1. 打开终端，`curl -I https://你的baseUrl` 看是否能连上
2. 检查 `config.json` 中 `baseUrl` 是否以 `/v1` 结尾（OpenAI 兼容接口标准格式）
3. 检查代理/VPN 是否拦截了 API 地址
4. 如果是本地模型（Ollama/LM Studio），确认服务已启动且端口正确

---

## 2. `401 Unauthorized` / `Authentication Fails`

**现象：** API 返回认证失败。

**排查步骤：**
1. 检查 `config.json` 中 `apiKey` 的值——复制粘贴时可能多了空格或换行
2. 确认 API Key 未过期（去对应平台的控制台查看）
3. 部分平台要求 `Authorization: Bearer` 前缀——确认 provider 是否自动处理
4. 试在终端用 curl 手动发一个请求验证：
   ```bash
   curl https://api.openai.com/v1/chat/completions \
     -H "Authorization: Bearer sk-xxxx" \
     -H "Content-Type: application/json" \
     -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
   ```

---

## 3. `429 Too Many Requests` / Rate Limit

**现象：** 请求被限流。

**排查步骤：**
1. 检查是否并发请求过多——群聊协作中 3 个 Agent 同时调用 API
2. 降低群聊迭代次数（`GroupChatView.tsx` 中的 `MAX_CODING_ITERATIONS`）
3. 在 `config.json` 中加限流配置：
   ```json
   { "llm": { "rateLimit": { "requestsPerMinute": 20 } } }
   ```
4. 如果是免费 API（如 DeepSeek/Grok），考虑升级到付费档

---

## 4. LLM 返回空内容 / 模型不输出

**现象：** Agent 回复了但没有内容（空字符串或仅换行）。

**排查步骤：**
1. 检查 provider 是否支持你选的 model——有些 provider 模型名变了但 API 不报错，只返回空
2. 如果是本地模型，在 Ollama/LM Studio 里直接对话测试是否正常
3. 如果是 function calling 模型，试试 `mode: "chat"`（不调工具）能否正常回复
4. 检查 `maxTokens` 是否设得太低（< 100）

---

## 5. 窗口白屏 / 前端不渲染

**现象：** 应用启动后窗口空白。

**排查步骤：**
1. 检查 `out/renderer/index.html` 是否存在——前端构建可能失败
2. 重新构建前端：`pnpm build:renderer`
3. 检查 Vite 开发服务器是否正常启动（`pnpm dev` 时看控制台输出）
4. 清空浏览器缓存/重启应用

---

## 6. 群聊中 Agent 回复 JSON 原始文本

**现象：** Agent 回复了 `{"role":"assistant","content":"你好"}` 这样的 JSON 而非自然语言。

**排查步骤：**
1. 这是 prompt 中要求输出 JSON 但后处理没剥离——群聊协作各阶段的任务提示要求 JSON 格式输出
2. 检查 `GroupChatView.tsx` 中对应阶段的 prompt 是否有 `只输出JSON` 字样
3. 临时修复：重置群聊会话（清除 `lumina_gc_sessions` localStorage）
4. 永久修复：确保每个阶段在输出 JSON 后用 `postProcess` 提取 `content` 字段

---

## 7. 协作编程循环不停止 / 无限重试

**现象：** 编码→审查→修复→测试 循环不断重复。

**排查步骤：**
1. 检查 `GroupChatView.tsx` 中 `MAX_CODING_ITERATIONS` 默认值是 3
2. 测试阶段的判断逻辑 `testFailed` 正则可能误判（把 "error" 当失败而实际是成功输出中的词）
3. 临时修复：关闭群聊窗口重开
4. 如果频繁出现，在 `testFailed` 判断里加额外否定条件排除误报

---

## 8. Agent 不调工具 / 只说话不行动

**现象：** 让 Agent 搜索/执行命令，它只回复文字描述而不是真的去做。

**排查步骤：**
1. 检查当前模式：`mode: "chat"` 不允许调工具，`mode: "agent"` 才允许
2. 在 `agentRunner.ts` 中 `isToolCapable = mode !== 'chat' && tools > 0`
3. 检查 `config.json` 中 `mode` 设置，或前端传到后端的 mode 参数
4. 如果用了本地模型，确认模型支持 function calling——不支持时用 XML 兜底解析

---

## 9. `<tool_call>` 标签泄漏到对话中

**现象：** 用户看到 `<tool_call><web_search(query="xxx")></tool_call>` 原始标签。

**排查步骤：**
1. 这是 LLM 输出工具调用但解析器没处理完的残留
2. 常见于：模型输出括号参数风格（`<web_search(query="...")`）而非闭合标签风格
3. 检查 `reactEngine.ts` 中 `cleanXmlToolCalls` 正则——如果只匹配闭合 `</tool_call>` 标签，不闭合的就不会被清理
4. 临时修复：换个支持标准 function calling 的模型
5. 永久修复：更新解析器兼容括号参数风格

---

## 10. 搜索 "今天天气怎么样" 但 Agent 编造答案

**现象：** Agent 没有搜索就直接凭记忆回答，而且可能不准确。

**排查步骤：**
1. `preExecuteSearch`（`agentRunner.ts`）会检测搜索意图——如果没触发，Agent 可能不搜索
2. 检查用户消息是否含"搜索词"（如"搜一下""查查"）
3. 群聊模式下 `socialMode: true` → 默认不做预搜索——v14.0+ 已修复为检测到搜索意图也执行
4. 确认 WebSearch 工具是否正常工作（终端试 `web_search`）

---

## 11. 内存泄漏 / 运行几小时后变慢

**现象：** 随着使用时间增长，应用越来越卡。

**排查步骤：**
1. 打开任务管理器看 Node.js 进程内存占用
2. 长期运行的 Agent 会话会累积上下文——超过 `COMPRESS_TRIGGER_RATIO`（0.65）会自动压缩
3. 检查 `agentRunner.ts` 中是否每轮对话都无限制 push 消息到 `this.messages`
4. 临时修复：重启应用
5. 长期修复：给对话上下文设置硬上限（如 500 条强制截断）

---

## 12. 配置文件不生效 / 改了等于没改

**现象：** 修改了 `config.json` 但应用行为没变化。

**排查步骤：**
1. **是否重启了应用？** Lumina 只在启动时读取配置，改后需重启
2. 检查配置文件路径：
   - Windows: `%APPDATA%\Lumina\config.json`
   - macOS: `~/Library/Application Support/Lumina/config.json`
   - Linux: `~/.config/Lumina/config.json`
3. 检查 JSON 格式——用 `node -e "JSON.parse(require('fs').readFileSync('path/to/config.json','utf8'))"` 验证
4. 如果用了环境变量覆盖（`LUMINA_LLM_MODEL` 等），环境变量优先级高于配置文件

---

## 13. 渠道消息发不出去（钉钉/微信/Slack/Telegram）

**现象：** 配置了外部渠道但消息无法发送或接收。

**排查步骤：**
1. 检查渠道配置是否正确（Webhook URL / Bot Token / Client ID）
2. 钉钉：Stream 模式需要确认 Stream URL 和 Client Secret
3. 微信：企业微信 Webhook 需要白名单 IP
4. Slack：需要 Events API 订阅和签名验证
5. Telegram：需要 Bot Token 和 Webhook URL（需公网可达）
6. 在终端直接测试：`curl -X POST "你的WebhookURL" -d '{"text":"test"}'`

---

## 14. 技能（Skill）无法加载 / 执行报错

**现象：** 注册了 Skill 但调用时报错或静默失败。

**排查步骤：**
1. 检查 `SKILL.md` 文件格式是否合规——YAML frontmatter 不可省略
2. 检查 Skill Scanner 是否拦截了该 Skill（`PASS/WARN/BLOCK`）
3. 查看日志中 `[SkillSystem]` 相关输出
4. 终端试运行：`qwenpaw skills run <skill-name>`
5. 如果 Skill 调用了未安装的工具，会静默失败——检查依赖的工具是否就绪

---

## 15. 启动时卡在 "正在初始化..."

**现象：** 应用一直停留在加载界面。

**排查步骤：**
1. LLM 模型初始化超时——首次加载模型可能需要较长时间（尤其本地模型）
2. 检查日志是否有 provider 初始化报错
3. 断开网络试试（如果是本地模型，网络问题可能导致 DNS 解析超时）
4. 删除 `~/.lumina/` 下的缓存文件再试
5. 如果用了自定义 provider，检查 URL 是否可达

---

## 日志怎么看？

所有排查的第一步：**看日志。**

```bash
# 终端日志（前台启动时输出）
pnpm dev

# 日志文件位置
Windows: %APPDATA%\Lumina\logs\
macOS/Linux: ~/.lumina/logs/

# 日志按天分割，用 grep 过滤关键词
grep "ERROR\|Error\|error\|❌\|failed" ~/.lumina/logs/latest.log
```

---

> **仍然解决不了？** 带上日志文件去 GitHub 提 Issue，附上操作系统、Node.js 版本和配置文件（记得隐去 API Key）。
