# 第三方资源声明（Third-Party Notices）

Lumina Life 在仓库中包含以下第三方运行时资源。感谢这些项目的作者。
若你以官方仓库之外的形式再次分发（含打包安装包），请遵守下列许可。

## Live2D 桌宠资源

| 资源 | 路径 | 来源 / 许可 |
| --- | --- | --- |
| Live2D Cubism Core | `electron/pet/assets/libs/core.min.js` | (C) Live2D Inc.，受 **Live2D Cubism SDK 许可协议**约束。使用 Cubism SDK 通常免费，但需遵守其官方条款（含收入门槛、再分发时保留声明等）。详见 https://www.live2d.com/sdk/license/ |
| Cubism 2.x 框架 | `electron/pet/assets/libs/live2d.min.js` | Live2D Cubism 2.1 Framework（Live2D 开源软件许可） |
| pixi-live2d-display | `electron/pet/assets/libs/index.min.js` | MIT License（作者 guansss 等） |
| PixiJS | `electron/pet/assets/libs/pixi.min.js`（v7.4.3） | MIT License |
| 桌宠模型 Mao | `electron/pet/assets/Mao/`（`mao_pro.moc3`、贴图、动作等） | Live2D Cubism **官方示例模型「Mao」**，© Live2D Cubism，受其示例素材 / 免费素材许可条款约束。**商用分发前请到 Live2D 官网核对该模型的使用与再分发条款。** |

> ⚠️ 注意：Mao 是 Cubism 官方示例模型。若计划将其用于商业产品，建议替换为自有 / 已获授权的模型，或确认其授权范围。

## 字体

| 资源 | 路径 | 许可 |
| --- | --- | --- |
| 得意黑 Smiley Sans | `public/fonts/SmileySans-Oblique.ttf` | SIL Open Font License 1.1 |

## 其他依赖

npm 依赖的完整列表与许可见 `package.json` / `package-lock.json`，可在发布前用
`npx license-checker --summary` 生成完整许可清单。

---

以上声明用于合规提示；各资源的最终许可以其官方条款为准。如发现条目有误，请提交 Issue。
