// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
// ============================================================
// electron/core/platform/macAccessibility.ts — macOS AX 元素树（UIA 的 macOS 等价物）
//
// ============================================================
// 为什么需要：Windows 的 Computer Use 有一条「元素树」通道（cuUia.ts，
//   UIA FindAll → 名字/控件类型/矩形），模型可以按 index 点元素而不是猜坐标。
//   macOS 没有 UIA，对应技术是 Accessibility（AX）API。
//
// 两条实现路线（评估结论）：
//   A) Swift + ApplicationServices（AXUIElementCopyAttributeValue / AXUIElementPerformAction）
//      —— 性能与能力最强（能取 AXValue、AXRole、AXChildren 深遍历），
//         但要引入一个随包分发的原生 helper 二进制 + Xcode 工具链构建，
//         还要单独给它签名/公证。打包链路与本次「不加 helper」的约束冲突。
//   B) AppleScript / System Events 逐层取 role/name/position/size
//      —— 零新增二进制、零构建依赖、与既有键鼠通道同一套授权模型
//         （辅助功能），代价是深遍历较慢（每层一次 Apple event）。
//
//   本模块选 **B**，理由：
//     1. 复用已授权的 osascript 通道，权限模型与键鼠完全一致，不新增授权面；
//     2. 不引入需要签名/公证的 helper，避免「macOS 包根本装不上」的风险；
//     3. 深度默认限 3、元素数限 200，实测够用且可接受延迟（未经实机验证）。
//   代价是：无法可靠取 AXValue（输入框直接赋值走 cuCore 的「点击+全选+输入」回退），
//   超深/超大窗口遍历偏慢。这些是**已知限制**，不是遗漏。
//
// ⚠️ 未经实机验证：AppleScript 的 System Events 元素属性名与返回结构
//   在不同 macOS 版本上偶有差异（尤其 AXFocused / AXEnabled 的可读性）。
//   解析层（parseAxOutput）已做全字段容错，解析不出就少几个字段而非整棵树失败。
// ============================================================
//
// 纯逻辑（buildAxScanScript / parseAxOutput / axRoleToUiType）零依赖可单测；
// 真正执行 osascript 由 MacAdapter 调用。
// ============================================================

/** 字段分隔符（制表符）——比 `|` 更不易出现在控件名里 */
export const AX_FIELD_SEP = '\t'
/** 记录分隔符（换行） */
export const AX_RECORD_SEP = '\n'

/** 默认扫描上限（与 Windows UIA 的 cap 200 对齐） */
export const AX_DEFAULT_CAP = 200
/** 默认最大递归深度（System Events 深遍历很慢，浅层优先） */
export const AX_DEFAULT_DEPTH = 3

/** 原始 AX 元素（单位=point，与注入坐标系一致） */
export interface AxElement {
  index: number
  /** AXRole，如 AXButton / AXTextField */
  role: string
  /** 元素名字（可见文本），无则空串 */
  name: string
  /** 逻辑点坐标与尺寸 */
  rect: { x: number; y: number; w: number; h: number }
  enabled: boolean
  focused: boolean
}

/** AXRole → 友好控件类型名（对齐 Windows UIA ControlType 命名，便于模型理解） */
export function axRoleToUiType(role: string): string {
  const r = String(role || '').replace(/^AX/, '').trim()
  if (!r) {return 'Unknown'}
  const MAP: Record<string, string> = {
    Button: 'Button',
    StaticText: 'Text',
    TextField: 'Edit',
    TextArea: 'Edit',
    SecureTextField: 'Edit',
    ComboBox: 'ComboBox',
    CheckBox: 'CheckBox',
    RadioButton: 'RadioButton',
    PopUpButton: 'ComboBox',
    MenuButton: 'MenuItem',
    MenuItem: 'MenuItem',
    Menu: 'Menu',
    List: 'List',
    ListItem: 'ListItem',
    Outline: 'Tree',
    Table: 'Table',
    Row: 'DataItem',
    Cell: 'Text',
    StaticAX: 'Unknown',
    Group: 'Group',
    ScrollArea: 'Pane',
    Window: 'Window',
    Sheet: 'Window',
    Dialog: 'Window',
    TabGroup: 'Tab',
    RadioGroup: 'Group',
    Slider: 'Slider',
    ProgressIndicator: 'ProgressBar',
    Toolbar: 'ToolBar',
    ToolBar: 'ToolBar',
    Image: 'Image',
    Link: 'Hyperlink',
    GrowlArea: 'Pane',
    WebArea: 'Document',
    ScrollBar: 'ScrollBar',
    TextFieldSecure: 'Edit',
    Application: 'Pane',
  }
  return MAP[r] || r
}

/** 清洗 AppleScript 字段：去掉分隔符与换行，限长 */
function cleanField(s: string, max = 120): string {
  return String(s || '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * 生成 AX 扫描的 AppleScript 源码（纯函数，便于单测断言命令构造）。
 *
 * 输出为「每行一个元素」的 TSV：role \t name \t x \t y \t w \t h \t enabled \t focused
 * 解析器对每行独立容错，任何一格异常只影响该元素。
 */
export function buildAxScanScript(depth: number = AX_DEFAULT_DEPTH, cap: number = AX_DEFAULT_CAP): string {
  const d = Math.max(0, Math.min(6, Math.floor(depth) || 0))
  const c = Math.max(1, Math.floor(cap) || AX_DEFAULT_CAP)
  return `on run argv
	set maxDepth to ${d}
	set maxElems to ${c}
	set outLines to {}
	try
		tell application "System Events"
			set frontProc to first application process whose frontmost is true
			tell frontProc
				if (count of windows) is 0 then return ""
				set outLines to my walkUI(window 1, 0, maxDepth, maxElems)
			end tell
		end tell
	on error errMsg
		return "AXERR:" & errMsg
	end try
	set AppleScript's text item delimiters to linefeed
	return outLines as text
end run

on sanitize(s)
	-- 控件名可能含制表符/换行（多行按钮、表格单元格），会破坏 TSV 分隔，必须先换掉
	set AppleScript's text item delimiters to {return, linefeed, tab}
	set parts to text items of s
	set AppleScript's text item delimiters to " "
	set out to parts as text
	set AppleScript's text item delimiters to ""
	return out
end sanitize

on walkUI(el, depth, maxDepth, maxElems)
	set acc to {}
	if depth > maxDepth then return acc
	try
		set n to (count of UI elements of el)
	on error
		return acc
	end try
	repeat with i from 1 to n
		if (count of acc) >= maxElems then exit repeat
		set e to UI element i of el
		set aRole to ""
		set aName to ""
		set aPos to {0, 0}
		set aSize to {0, 0}
		set aEnabled to true
		set aFocused to false
		try
			set aRole to (role of e) as text
		end try
		try
			set aName to my sanitize((name of e) as text)
		end try
		try
			set aPos to position of e
		end try
		try
			set aSize to size of e
		end try
		try
			set aEnabled to (enabled of e) as text
		end try
		try
			set aFocused to (focused of e) as text
		end try
		set w to 0
		set h to 0
		try
			set w to (item 1 of aSize) as integer
			set h to (item 2 of aSize) as integer
		end try
		set px to 0
		set py to 0
		try
			set px to (item 1 of aPos) as integer
			set py to (item 2 of aPos) as integer
		end try
		if w > 1 and h > 1 then
			set end of acc to (aRole & tab & aName & tab & px & tab & py & tab & w & tab & h & tab & aEnabled & tab & aFocused)
		end if
		if (count of acc) < maxElems then
			set sub to my walkUI(e, depth + 1, maxDepth, maxElems - (count of acc))
			set acc to acc & sub
		end if
		if (count of acc) >= maxElems then exit repeat
	end repeat
	return acc
end walkUI`
}

/** AppleScript 扫描失败哨兵前缀 */
export const AX_ERROR_PREFIX = 'AXERR:'

/** 解析结果：元素数组 + 是否命中「无窗口/扫描失败」哨兵 */
export interface AxParseResult {
  elements: AxElement[]
  /** AppleScript 侧返回的原始错误（若有），供上层转成权限诊断 */
  scriptError?: string
  /** 扫到了 0 个元素（可能未授权 / 前台无可访问窗口） */
  empty: boolean
}

/**
 * 解析 AppleScript 输出为 AxElement[]（纯函数，全字段容错）。
 * 与 Windows 的 parseUiaJson 行为对齐：过滤零尺寸/过小元素、重编 index。
 */
export function parseAxOutput(raw: string, cap: number = AX_DEFAULT_CAP): AxParseResult {
  const s = String(raw || '')
  if (!s.trim()) {return { elements: [], empty: true }}
  if (s.includes(AX_ERROR_PREFIX)) {
    const i = s.indexOf(AX_ERROR_PREFIX)
    return { elements: [], empty: true, scriptError: s.slice(i + AX_ERROR_PREFIX.length).trim() }
  }

  const elements: AxElement[] = []
  for (const line of s.split(AX_RECORD_SEP)) {
    if (!line.trim()) {continue}
    if (elements.length >= cap) {break}
    const f = line.split(AX_FIELD_SEP)
    if (f.length < 6) {continue}
    const role = cleanField(f[0], 40)
    if (!role) {continue}
    const name = cleanField(f[1])
    const x = Number(f[2])
    const y = Number(f[3])
    const w = Number(f[4])
    const h = Number(f[5])
    // 零尺寸/不可见元素没有点击价值（与 parseUiaJson 的过滤阈值一致）
    if (!Number.isFinite(x) || !Number.isFinite(y)) {continue}
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) {continue}
    elements.push({
      index: elements.length,
      role,
      name,
      rect: { x, y, w, h },
      enabled: f.length < 7 || f[6] !== 'false',
      focused: f.length >= 8 && f[7] === 'true',
    })
  }
  return { elements, empty: elements.length === 0 }
}

/** AxElement 列表 → 渲染成给模型看的紧凑文本（与 cuUia.renderElementsText 对齐） */
export function renderAxElementsText(
  els: AxElement[],
  toNorm: (e: AxElement) => { nx: number; ny: number },
): string {
  if (!els.length) {return '（前台窗口未识别到可交互元素）'}
  const lines = els.map(e => {
    const label = [e.name, axRoleToUiType(e.role)].filter(Boolean).join(' / ') || '(无名称)'
    const n = toNorm(e)
    return `[${e.index}] ${axRoleToUiType(e.role)} ${label} @(${n.nx.toFixed(1)},${n.ny.toFixed(1)})${e.focused ? ' *焦点*' : ''}${e.enabled ? '' : ' 禁用'}`
  })
  return ['前台窗口可交互元素（用 index 调用 desktop_element_act 的 click）：', ...lines].join('\n')
}
