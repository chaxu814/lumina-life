# code_review_smart

智能代码审查 Skill — 文件扫描 → 分析 → 报告生成。

## 触发词
代码审查、review、检查代码、代码质量、有没有bug

## 工作流
1. file_list(directory) → 获取所有代码文件
2. 对每个文件 file_read → 分析：
   - 语法错误/类型错误
   - 安全漏洞（注入、路径穿越）
   - 性能问题（N+1 查询、内存泄漏）
   - 代码风格/最佳实践
3. 生成结构化审查报告：
   - 🔴 Critical / 🟡 Warning / 🔵 Suggestion
   - 每个问题附文件路径+行号+修复建议

## 优势
- 全项目扫描 → 单次调用
- 结构化报告，按严重度分级

## 适用 Agent
热茶（主）, Yak

## 依赖工具
file_list, file_read
