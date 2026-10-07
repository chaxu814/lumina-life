# 第三方厂商标识（Lumina 设置页模型选择器用）

这些文件是各厂商的 **商标 / 品牌标识**，只用于「指明这是谁的模型」这一识别用途，
不表示任何厂商对本项目的背书或合作关系。

Lumina 不对第三方商标拥有权利，也不重新分发这些标识的版权。
**商标权利归各厂商所有。**

| 文件 | 归属 | 来源 | 授权 |
|---|---|---|---|
| `openai.svg` | OpenAI | [Simple Icons](https://simpleicons.org/?q=openai)（`simple-icons@11`） | [CC0-1.0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md) |
| `claude.svg` | Anthropic | Simple Icons `anthropic` | CC0-1.0 |
| `gemini.svg` | Google | Simple Icons `googlegemini` | CC0-1.0 |
| `deepseek.svg` | DeepSeek | Simple Icons `deepseek` | CC0-1.0 |
| `qwen.svg` | Alibaba Cloud | Simple Icons `alibabacloud` | CC0-1.0 |
| `ollama.svg` | Ollama | Simple Icons `ollama` | CC0-1.0 |
| `azure.svg` | Microsoft | Simple Icons `microsoftazure`（`simple-icons@11`） | CC0-1.0 |
| `lmstudio.ico` | LM Studio | <https://lmstudio.ai/favicon.ico> | 厂商自有商标 |
| `zhipu.ico` | 智谱 AI | <https://open.bigmodel.cn/favicon.ico> | 厂商自有商标 |
| `siliconflow.ico` | 硅基流动 | <https://siliconflow.cn/favicon.ico> | 厂商自有商标 |

单色 SVG 已按各品牌主色重新着色（`fill` 属性），仅改变显示颜色，不改变图形。

## 替换 / 移除

- 想换成官方素材：直接覆盖同名文件即可，代码只按路径引用。
- 想完全去掉图标：删掉本目录，并在 `src/panels/settings/SettingsLLM.tsx` 的
  `LLM_PROVIDERS` 里去掉 `logo` 字段——没有 `logo` 的厂商会自动退到字标（首字母色块），
  不会出现破图。
