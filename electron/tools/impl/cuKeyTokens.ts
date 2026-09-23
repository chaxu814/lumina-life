// ============================================================
// electron/tools/impl/cuKeyTokens.ts — SendKeys 组合键编译（纯函数，可单测）
//
// 从 cuCore.ts 抽出，供 WindowsAdapter 与 cuCore 共用，避免主进程适配层与
// cuCore 之间循环依赖。行为与历史版本完全一致（见 tests/cuCoreTokens.test.ts）。
// ============================================================

/** 命名键 → SendKeys 记号 */
export const SENDKEY_NAMED: Record<string, string> = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
  backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}', space: ' ',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
  insert: '{INSERT}', capslock: '{CAPSLOCK}',
  f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
  f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
}

/**
 * 把任意修饰键组合（ctrl_shift_a / alt_s / ctrl_shift_esc / win_r）
 * 编译为 SendKeys 记号串。纯函数，可单测。
 * 约定：下划线/加号/空格分隔，最后一段是主键，其余为修饰键。
 */
export function buildSendKeysToken(key: string): string | null {
  const k = (key || '').toLowerCase().replace(/\s+/g, '').replace(/[+]/g, '_')
  if (!k) {return null}
  if (SENDKEY_NAMED[k]) {return SENDKEY_NAMED[k]}
  // 单字符直接按
  if (k.length === 1) {return k}
  const parts = k.split('_').filter(Boolean)
  const modMap: Record<string, string> = { ctrl: '^', control: '^', alt: '%', shift: '+' }
  let prefix = ''
  for (const p of parts.slice(0, -1)) {
    if (modMap[p]) {prefix += modMap[p]}
    else {
      // 不认识的修饰段，交给保守失败
      return null
    }
  }
  const main = parts[parts.length - 1]
  if (!main) {return null}
  const mainToken = SENDKEY_NAMED[main] || (main.length === 1 ? main : `{${main.toUpperCase()}}`)
  return prefix ? `${prefix}${mainToken}` : mainToken
}
