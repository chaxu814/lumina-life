// ============================================================
// electron/gaming/mineflayer.d.ts — mineflayer 可选依赖的环境声明
//
// mineflayer 是 optionalDependency，测试/未安装时不随包发布。
// 这里提供最小类型声明，保证 TS 严格模式下 `await import('mineflayer')`
// 能通过类型检查；运行时未安装时由 botRoute 优雅降级。
// ============================================================

declare module 'mineflayer' {
  /** 最小 bot 接口（仅覆盖游戏集成用到的方法） */
  export interface MineflayerBot {
    chat(message: string): void
    look(yaw: number, pitch: number, force?: boolean): Promise<void>
    setControlState(state: string, active: boolean): void
    attack(entity: any): void
    activateItem(): void
    deactivateItem(): void
    quit(reason?: string): void
    on(event: string, cb: (...args: any[]) => void): void
    entity?: { yaw?: number; pitch?: number; position?: { x: number; y: number; z: number } }
    game?: { mode?: string; dimension?: string }
    player?: any
    inventory?: any
    [key: string]: any
  }

  export function createBot(options: {
    host: string
    port?: number
    username?: string
    version?: string
    auth?: string
  }): MineflayerBot

  const mineflayer: { createBot: typeof createBot }
  export default mineflayer
}
