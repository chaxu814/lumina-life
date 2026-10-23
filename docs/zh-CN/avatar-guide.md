# Lumina 模型生态指南

本指南介绍如何把自定义形象（Avatar）装进 Lumina 桌宠，以及每种格式的目录结构、导入方式和 manifest 规范。

## 支持格式总览

| 格式 | 状态 | 入口文件 | 渲染页 | 说明 |
|---|---|---|---|---|
| Live2D Cubism 3/4/5 | ✅ 已支持 | `.model3.json` | pet-live2d.html | 2D 立绘，完整口型/表情/动作 |
| VRM 1.0/2.0 | ✅ 已支持 | `.vrm` | pet-vrm.html | 3D 模型（three.js + three-vrm） |
| PNGTuber | ✅ 已支持 | `idle.png` | pet-pngtuber.html | 静态立绘 + 口型切换（4 帧） |
| MMD (.pmx) | 🟡 Beta | `.pmx` | pet-mmd.html | 3D 模型（three.js MMDLoader） |
| 程序化小猫 | ✅ 内置 | `__cat__` | pet-cat.html | Canvas 2D 绘制，无外部素材 |

> **版权声明**：Lumina 不内置任何第三方版权模型。用户自备模型并自行承担授权责任。

---

## 一、Live2D 模型

### 目录结构

```
MyModel/
├── MyModel.model3.json      ← 入口文件
├── MyModel.moc3
├── textures/
│   ├── texture_00.png
│   └── texture_01.png
├── physics/physics3.json
├── expressions/
│   └── exp_01.exp3.json
└── motions/
    └── idle.motion3.json
```

### 导入方式
1. 设置面板 → 模型管理 → 导入 Live2D 模型
2. 选择 `.model3.json` 入口文件（或整个文件夹自动扫描）
3. 模型自动复制到 `userData/pet-models/` 并注册

### 不支持
- Cubism 2 旧格式（`.model.json` + `.moc`）
- VTube Studio 工程文件（需导出标准 Cubism）

---

## 二、VRM 模型

### 目录结构
单个 `.vrm` 文件即可，无需额外目录结构。

### 导入方式
1. 设置面板 → 模型管理 → 导入 VRM 模型
2. 选择 `.vrm` 文件
3. 自动复制并注册

---

## 三、PNGTuber 立绘组

### 目录结构（4 帧）
```
MyPNGTuber/
├── idle.png              ← 必选：待机
├── talking.png           ← 必选：说话
├── blink.png             ← 可选：眨眼
├── blink-talking.png     ← 可选：眨眼+说话
└── pngtuber.json         ← 可选：自定义配置
```

### 导入方式
设置面板 → 导入 PNGTuber 立绘组（选择文件夹）。

---

## 四、MMD 模型（Beta）

### 目录结构
```
MyMMD/
├── model.pmx             ← 必选：模型文件
├── motion.vmd            ← 可选：动作数据
└── manifest.json         ← 可选：模型元数据
```

### 导入方式
1. 设置面板 → 模型管理 → 导入 MMD 模型
2. 选择 `.pmx` 文件
3. 自动复制并注册

### 已知限制（Beta）
- ❌ 物理运算
- ❌ 表情 morph
- ❌ 多模型同屏
- ❌ 音频对口型
- ❌ .pmd 老格式
- ⚠️ 模型 >50MB 时会提示可能卡顿

---

## 五、程序化小猫

无需导入。在模型列表中选择「小猫」即可。
Canvas 2D 程序化绘制，支持：
- 待机呼吸 + 随机眨眼
- 视线跟随鼠标
- 点击互动（跳一下 + 喵~）
- 随机小动作（舔毛/伸懒腰/打哈欠）
- 自动走动 + 贴边转身
- 睡觉模式（Zzz 气泡）

---

## 六、Manifest 规范

每个模型目录下可选 `manifest.json`，用于补充元数据：

```json
{
  "name": "模型显示名",
  "kind": "live2d",
  "entry": "relative/path/to/model3.json",
  "thumbnail": "thumbnail.png",
  "motions": {
    "idle": "motions/idle.vmd",
    "tap": "motions/tap.vmd"
  },
  "author": "作者名",
  "license": "MIT / CC0 / 自定义",
  "source": "https://来源URL",
  "version": "1.0"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| name | string | 模型显示名（覆盖目录名） |
| kind | string | live2d / vrm / mmd / pngtuber |
| entry | string | 入口文件相对路径 |
| thumbnail | string | 缩略图相对路径 |
| motions | object | 动作映射（idle/tap/...） |
| author | string | 作者 |
| license | string | 许可说明 |
| source | string | 来源 URL |
| version | string | 版本号 |

无 manifest 时，系统自动从入口文件后缀推断 kind 和名称。

---

## 七、模型切换

### 程序化切换（IPC）
```javascript
// 切换到任意模型（自动处理同 kind 热切换 / 跨 kind 重载窗口）
ipcRenderer.invoke('pet:set-model', '模型ID')

// 查询所有已安装模型
ipcRenderer.invoke('pet:get-models').then(({ models, current }) => { ... })

// 复位窗口位置
ipcRenderer.invoke('pet:reset-position')
```

### 快捷键
- `Ctrl+Shift+R`：复位桌宠到屏幕中央

### 边缘吸附
拖拽桌宠到屏幕边缘（<24px）会自动吸附并窥视（只露出 40px）。鼠标靠近时滑出，离开时缩回。

---

## 八、常见问题

**Q: 导入模型后黑屏 / 不显示？**
A: 检查模型文件完整性（.moc3 / 贴图是否齐全）。主进程会自动回退到内置 Mao 并记录错误。

**Q: 切换模型后还是显示旧模型？**
A: 同 kind 模型切换是热切换（不重载窗口）。如果渲染页未响应，尝试通过设置面板切换或重启应用。

**Q: MMD 模型加载失败？**
A: 确认是 `.pmx` 格式（不是 `.pmd`）。模型体积过大时可能超时。Beta 阶段已知限制较多。

**Q: 如何自制模型？**
A: Live2D 请使用 Cubism Editor 4.2+ 导出 `.model3.json`；VRM 请使用 UniVRM 导出；PNGTuber 按上述 4 帧结构准备图片即可。

---

## 九、开发者接入说明

- 模型注册表：`electron/pet/modelLibrary.ts`（ModelLibrary 类 + 磁盘层函数）
- 渲染器抽象：`electron/pet/avatarRenderer.ts`（纯函数，无 Electron 依赖）
- 边缘吸附：`electron/pet/edgeSnap.ts`（纯几何函数，可单测）
- 导入管线：`electron/pet/modelImporter.ts`（Live2D/PNGTuber/VRM/MMD）
- 主进程接线：`electron/pet/lifeServices.ts`（IPC 注册）
- 窗口管理：`electron/pet/petWindow.ts`（窗口创建/模型切换/边缘吸附集成）
