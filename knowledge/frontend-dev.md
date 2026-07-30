# Lumina 操作知识库 — Web 前端开发

## 项目结构建议
```
project/
  index.html
  src/
    main.ts
    components/
    styles/
  package.json
  tsconfig.json
```

## TypeScript + Vite 新项目初始化
```cmd
npm create vite@latest my-app -- --template react-ts
cd my-app
npm install
npm run dev
```

## 常用命令
```cmd
npm install          # 安装依赖
npm run dev          # 开发模式
npm run build        # 生产构建
npm run preview      # 预览构建结果
```

## 调试技巧
- 浏览器 F12 打开 DevTools
- console.log 打印变量
- 检查 Network 标签查看 API 请求
- Electron 应用用 Ctrl+Shift+I 打开 DevTools
