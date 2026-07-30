// ============================================================
// mission/prompts.ts — Mission 模式提示词模板 (v3.5)
//
// 借鉴 QwenPaw mission prompts:
//   Phase 1: 探索代码库 + 生成结构化 PRD (JSON)
//   Phase 2: 逐 story 实现 + 验证
// ============================================================

export const PHASE1_SYSTEM_PROMPT = `你正在执行 Mission Phase 1 — PRD 生成。

【任务】
探索代码库，分析用户需求，生成结构化的产品需求文档 (PRD)。

【工作流程】
1. 使用 file_list 浏览项目结构
2. 使用 file_read 阅读关键文件
3. 使用 ast_search 分析代码结构
4. 生成 prd.json 并保存到当前 mission 目录

【PRD 格式】
{
  "title": "需求标题",
  "summary": "一句话概述",
  "constraints": ["约束1", "约束2"],
  "stories": [
    {
      "id": "STORY-1",
      "title": "故事标题",
      "description": "详细描述",
      "acceptanceCriteria": ["验收标准1", "验收标准2"],
      "status": "pending",
      "files": ["相关文件路径"]
    }
  ],
  "verifyCommands": ["验证命令"],
  "maxIterations": 20,
  "currentIteration": 0
}

【规则】
- stories 中每个 story 应该是独立、可验证的任务
- acceptanceCriteria 必须具体可测试
- verifyCommands 是验证整体完成的命令（如 npm test）
- 生成后用 file_write 保存到 .missions/<mission_dir>/prd.json
- Phase 1 完成后说 "PRD 已生成，请确认后开始 Phase 2 实现。"

【输出】
生成 PRD 后输出摘要：标题、story 数量、关键约束。`

export const PHASE2_CONTINUATION_MESSAGE = `
当前 Mission 状态:
- 已完成 stories: {done}/{total}
- 当前迭代: {iteration}/{maxIterations}

请继续实现下一个 pending 或 in_progress 的 story。
完成后用 file_write 更新 prd.json 中的 status 为 "done"。
如果遇到不可解决的问题，将 status 设为 "blocked" 并在 implementation 字段说明原因。

【重要】
- 一次只实现 1 个 story
- 实现后必须验证（运行 verifyCommands 或手动检查）
- 修改文件前用 file_read 查看
- 修改文件后用 shell_exec 验证`

export const MISSION_COMPLETE_MESSAGE = `✅ **Mission 完成！**

所有 user stories 已实现和验证。
{passed}/{total} stories 通过。

你可以使用 /mission status 查看详情，
或启动新的 mission。`

export const MISSION_MAX_ITERATIONS_MESSAGE = `⚠️ **Mission 已达到最大迭代次数** ({maxIterations})。

已完成: {passed}/{total} stories
剩余: {remaining} stories

你可以：
1. /mission continue — 继续当前 mission
2. /mission new — 启动新 mission
3. 手动完成剩余工作`
