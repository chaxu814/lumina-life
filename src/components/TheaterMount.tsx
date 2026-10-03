// ============================================================
// components/TheaterMount.tsx — 剧场容器（订阅主进程事件 + 控制可见性）
//
// TheaterFeed 是纯展示组件，不认识 Electron。
// 这个容器负责三件事：
//   1. 订阅主进程的 theater:beat / theater:state
//   2. 按 features.theater 开关决定是否挂载
//   3. 提供「结束本场」的出口
//
// 【为什么关开关时直接返回 null 而不是隐藏】
// 隐藏（display:none）仍然会接收 IPC 事件、持有 React state，
// 在聊天区这种高频重渲染区域是白白浪费。
// 关闭 = 不订阅 = 零开销。
// ============================================================

import React, { useCallback, useEffect, useState } from 'react'
import TheaterFeed from './TheaterFeed'
import type { TheaterBeat, TheaterState } from '../../electron/orchestration/theater'

export default function TheaterMount() {
  const [play, setPlay] = useState<TheaterState | null>(null)
  const [lastBeat, setLastBeat] = useState<TheaterBeat | null>(null)
  const [enabled, setEnabled] = useState(true)

  // 读开关。只在挂载时读一次——用户在设置里改开关后重新进入聊天区即可生效，
  // 不需要为了一次开关监听而把订阅逻辑搞复杂。
  useEffect(() => {
    let alive = true
    window.luminaAPI.getConfig()
      .then((cfg: any) => { if (alive) {setEnabled(cfg?.features?.theater !== false)} })
      .catch(() => { /* 读不到就默认开着 */ })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!enabled) {return}
    const api: any = window.luminaAPI
    // 防御：不同构建下 preload 暴露的通道名可能带前缀
    const onBeat = (b: TheaterBeat) => setLastBeat(b)
    const onState = (s: TheaterState) => setPlay(s)
    api.onTheaterBeat?.(onBeat)
    api.onTheaterState?.(onState)
    return () => {
      api.offTheaterBeat?.(onBeat)
      api.offTheaterState?.(onState)
    }
  }, [enabled])

  const close = useCallback(() => {
    setPlay(null)
    setLastBeat(null)
  }, [])

  if (!enabled) {return null}
  return <TheaterFeed play={play} lastBeat={lastBeat} onClose={close} />
}
