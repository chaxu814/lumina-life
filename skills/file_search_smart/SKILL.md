# file_search_smart

智能文件搜索 Skill — 递归搜索 + 内容匹配 + 格式化输出。

## 触发词
找文件、搜索文件、查找代码、grep、文件中包含

## 工作流
1. file_list(directory, recursive=true) — 递归获取文件列表
2. 对候选文件批量 file_read → 内容匹配
3. 去重 → 按相关度排序
4. 返回「路径:行号: 内容」格式

## 优势
- 一次调用完成搜索+匹配+格式化
- 自动跳过 node_modules、.git 等无关目录
- 支持正则和模糊匹配

## 适用 Agent
热茶（主）, Yak, Lumina

## 依赖工具
file_list, file_read
