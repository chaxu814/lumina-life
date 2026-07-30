# browser_click_smart

智能点击 Skill — 将多步浏览器操作封装为单次工具调用。

## 触发词
点击、打开、跳转、进入页面、浏览器操作

## 工作流
1. browser(action='snapshot') — 获取页面元素列表
2. 扫描页面文字 → 定位目标元素 ref
3. browser(action='click', ref=target) — 精确点击
4. browser(action='snapshot') — 验证点击结果

## 优势
- 减少 3-4 轮 LLM 调用为 1 轮
- 自动处理元素定位失败 → 降级为 selector 模式
- 点击后自动验证页面变化

## 适用 Agent
Lumina, 热茶, Yak

## 依赖工具
browser, ocr
