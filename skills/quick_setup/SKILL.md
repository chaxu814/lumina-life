# quick_setup

快速配置 Skill — 环境检测 → 依赖安装 → 配置生成。

## 触发词
初始化项目、搭环境、安装依赖、配置环境

## 工作流
1. shell_exec('node --version' / 'python --version') → 检测环境
2. 根据项目类型自动生成配置文件
3. shell_exec('npm install' / 'pip install -r requirements.txt')
4. 验证安装结果

## 支持的项目类型
- Node.js / TypeScript (package.json + tsconfig.json)
- Python (requirements.txt + .venv)
- Vite / React / Vue

## 适用 Agent
热茶, Lumina

## 依赖工具
shell_exec, file_write, file_read
