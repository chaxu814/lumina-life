# Lumina 常见问题 FAQ

> 最后更新：2026-07-14

---

## 安装与启动

### Q1：安装后双击没反应 / 窗口闪一下就消失

**可能原因：** Node.js 版本过低或依赖未正确安装。

**解决方法：**
1. 确认 Node.js ≥ 18（终端运行 `node -v`）
2. 删除 `node_modules` 和 `pnpm-lock.yaml`，重新 `pnpm install`
3. 如果还是闪退，打开终端运行 `pnpm dev` 看报错信息

### Q2：`pnpm install` 报错说 Python / C++ 编译失败

Lumina 的部分依赖（如 `better-sqlite3`）需要编译原生模块。

**解决方法：**
```bash
# Windows: 安装 Visual Studio Build Tools
npm install --global windows-build-tools

# 或者切换到预编译版本
pnpm config set node-gyp rebuild false
pnpm install
```

### Q3：启动后浏览器/终端没任何反应

终端日志可能被重定向了。

**解决方法：**
```bash
# 强制前台模式启动
pnpm dev --no-daemon

# 查看日志文件
# Windows: %APPDATA%\Lumina\logs\
# macOS/Linux: ~/.lumina/logs/
```

---

## 配置 LLM

### Q4：怎么配置 AI 模型？我该用哪个？

修改 `config.json` 中 `llm` 段：

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-xxxxxxxxxxx"
  }
}
```

**推荐模型（按性价比排序）：**
1. **GPT-4o** — 最稳定，群聊编码体验最好
2. **Claude 3.5 Sonnet** — 编码能力强
3. **DeepSeek-V3** — 性价比高，中文好
4. **Qwen2.5-72B** — 免费可用

### Q5：配置了 API Key 但还是报 "401 Unauthorized"

**排查步骤：**
1. 检查 `config.json` 里 `apiKey` 字段名
2. 确认 API Key 没有过期
3. 检查 `baseUrl` 末尾是否有多余斜杠
4. 如果用了代理/转发，确认转发 URL 正确

### Q6：如何让不同 Agent 用不同模型？

`config.json` 支持按 agent 覆盖模型：

```json
{
  "llm": { "model": "gpt-4o", ... },
  "agents": {
    "yak": { "llm": { "model": "claude-sonnet-4-20250514", ... } },
    "recha": { "llm": { "model": "deepseek-chat", ... } }
  }
}
```

未配置的 agent 会自动继承主模型（不会报错）。

### Q7：配置了但界面还是显示 "模型未就绪"

**常见原因：**
1. 配置文件修改后没有重启应用
2. `config.json` JSON 格式错误
3. 配置路径不对——Windows 上配置文件在 `%APPDATA%/Lumina/config.json`

---

## 群聊与团队协作

### Q8：群聊里 Agent 不响应 / 没人说话

**排查清单：**
- ✅ 所有 Agent 的 LLM 都配好了吗？
- ✅ 群聊模式是否开启？
- ✅ 消息里是否 @ 了对应 Agent？
- ✅ 是否在"团队协作"模式下？

### Q9：Yak 写了代码但热茶不审查 / Lumina 不测试

如果一个 Agent 没配 LLM，协作链条会断。系统 v14.0+ 已支持自动降级到主模型。

**解决方法：**
- 要么给 Yak/热茶/Lumina 各配一个模型
- 要么让系统自动降级（已默认开启）

### Q10：Agent 总是说 "我去查一下" 但不真的搜索

**原因：** 群聊模式下 Agent 倾向少用工具。

**解决方法（v14.0+ 已修复）：**
- 用明确的搜索命令："帮我搜一下 XXX"、"查查 XXX"
- 不要用模糊说法："你知道 XXX 吗？"

### Q11：Agent 回复里出现 `<tool_call>` 原始标签

**原因：** LLM 输出了工具调用意图但解析器没匹配上（常见于括号参数风格）。

**临时解决：** 换个支持标准 function calling 的模型（GPT-4o/Claude）。

### Q12：协作编程测试失败后怎么重试？

协作编程会自动重试最多 3 轮。如果 3 轮后还失败：
1. 查看 Lumina 最后的测试输出
2. 手动修复代码后，重新发消息让 Yak 继续
3. 或在提示里说"修复刚才的错误"

---

## 工具与功能

### Q13：Lumina 能访问我的文件吗？

**默认权限：**
- ✅ 读取/写入工作区目录
- ✅ 读取/写入项目目录
- ❌ 不自动访问桌面/文档/系统目录

执行危险命令（删除/覆盖）前会弹出确认。

### Q14：浏览器工具打不开网页

**排查步骤：**
1. 确认安装了 Chrome/Chromium
2. 检查 `config.json` 中 `browser.headless` 设置
3. 部分网站（验证码/登录墙）可能无法正常渲染

### Q15：搜索返回 "未找到结果"

**原因：**
1. Bing 搜索频率限制
2. 搜索词太生僻
3. 网络问题

**建议：** 换精确关键词或用 `browser` 直接打开网页。

### Q16：记忆系统怎么用？

```
短期记忆：当前对话上下文（自动管理）
长期记忆：通过 memory_* 工具操作
  - memory_save: 保存重要信息
  - memory_search: 搜索历史记忆
  - memory_summarize: 总结近期活动
```

每个 Agent 有独立的记忆。

### Q17：如何添加更多工具？

三种选择：
1. **MCP**（推荐）：通过 MCP 协议接入任意第三方工具
2. **内置 Skill**：写 `SKILL.md` 文件注册工作流
3. **直接开发**：在 `electron/tools/impl/` 下添加新工具 + 注册

---

## 运行异常

### Q18：持续报 "Rate Limit" / 请求超时

**解决方法：**
1. 降低群聊协作迭代次数
2. 配置请求间隔：`{ "llm": { "rateLimit": { "requestsPerMinute": 30 } } }`
3. 切换到频率限制更宽松的模型

### Q19：内存占用越来越高，运行一天后卡顿

**原因：** 对话上下文累积过多。

**已优化（v14.0+）：**
- 上下文超过 65% 自动压缩
- 每条消息限制 24000 字符
- 如果还是卡，手动清理对话历史或重启

### Q20：如何完全重置？

```bash
# 备份数据
mv ~/.lumina ~/.lumina.backup   # macOS/Linux
rename %APPDATA%\Lumina Lumina.backup  # Windows

# 重启（自动生成新配置）
pnpm dev
```

**注意：** 会删除所有对话历史、记忆、配置，建议先备份。

---

## 联系与反馈

- GitHub Issues → 报告 bug / 提功能建议
- 项目 README → 其他联系方式
