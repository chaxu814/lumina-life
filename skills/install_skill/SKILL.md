# install_skill

一键安装 Skill 包 — 下载 + 解压 + 注册。

## 触发词
安装skill、安装技能、下载skill、添加能力

## 工作流
1. 接收 skill 包路径或 URL
2. 验证 SKILL.md 格式
3. 解压到 skills/ 目录
4. 注册到 skillSystem.ts
5. 返回安装结果

## 适用 Agent
Lumina, 热茶

## 依赖工具
file_write, file_read, shell_exec
