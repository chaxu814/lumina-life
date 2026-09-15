# Agent 配置模板（脱敏样例）

这里是 Lumina / 热茶(Recha) / Yak 三个内置角色的**配置样例**，已去除任何真实 API Key 与内网地址，可随开源仓库分发。

## 为什么真实 `agents/` 不在这里？

运行时真正生效的配置位于项目根的 `agents/<id>/agent.json`，其中包含你的 LLM endpoint、API Key 等敏感信息。该目录已被 `.gitignore` 忽略，**不会**进入公开仓库。

## 如何使用

1. 复制对应样例：`src/assets/agentTemplates/<id>.example.agent.json`
2. 粘贴到 `agents/<id>/agent.json`（目录不存在则手动创建）
3. 把 `model` / `endpoint` / `apiKey` 改成你自己的：
   - 本地 LM Studio / Ollama：`endpoint` 用 `http://127.0.0.1:xxxx/v1`，本地无密钥时 `apiKey` 可留空或任意填。
   - 云端供应商：填入控制台拿到的 Key，不要提交回仓库。
4. 角色人格文本（SOUL）在 `src/data/agentSouls.ts`，与这里的运行参数分离。

## 字段速查

| 字段 | 含义 |
| --- | --- |
| `role` | `boss`=唯一对用户接口（Lumina）；`worker`=后台隐身（热茶/Yak） |
| `llm.temperature` | Lumina 偏高(活泼)，热茶偏低(严谨)，Yak 居中偏稳 |
| `tools.whitelist` | 该角色允许使用的工具；空数组表示不限制 |
| `tools.approvalLevel` | `auto`=按沙箱策略审批；`none`=不额外审批（后台只读/审查角色） |
| `social` | TTS 音色与初始情绪基线（mood/energy/affinity） |
