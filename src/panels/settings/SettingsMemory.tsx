/**
 * SettingsMemory.tsx — 「记忆与进化」设置页
 *
 * 仿参考设计：
 *   · 对话记忆        —— 记住对话中的重要信息，让后续回答更贴合你
 *   · 本地记忆与技能   —— 自动记录工作过程并优化技能，数据仅保存在你的设备上
 *   · 管理记忆 [导入]  —— 每晚自动整理更新，可随时查看和编辑
 *   · 页脚隐私声明
 *
 * 前两个开关是**真实生效**的 feature flag（memory.conversation / memory.localSkills），
 * 通过 featureFlagsClient 写回主进程，不是装饰。
 */
import React, { useEffect, useState } from 'react'
import { useStore } from '../../stores/appStore'
import {
  loadFlags, setFlagRemote, snapshotFlags, type RendererFlagKey,
} from '../../services/featureFlagsClient'

const card: React.CSSProperties = {
  borderRadius: 12, border: '1px solid var(--border-light)', padding: 20,
  marginBottom: 16, background: 'var(--surface-0)',
  fontFamily: '"Microsoft YaHei", "微软雅黑", sans-serif',
}
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
  padding: '12px 0',
}
const rowTitle: React.CSSProperties = {
  fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4,
}
const rowDesc: React.CSSProperties = {
  fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6,
}

interface Props { onClose?: () => void }

/** preload 暴露的桥接接口（仅本页用到的部分），避免 `(window as any)` */
interface LuminaBridgeApi {
  dataImportZip?: () => Promise<{
    ok?: boolean
    imported?: Record<string, number>
    error?: string
  }>
}

export default function SettingsMemory({ onClose }: Props) {
  const [flags, setFlags] = useState<Record<RendererFlagKey, boolean>>(snapshotFlags())
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [showNotStored, setShowNotStored] = useState(false)

  useEffect(() => { loadFlags().then(setFlags) }, [])

  // 当前对话是否「已开始」——用于把「使用记忆」标成会话级锁定
  const conversations = useStore(s => s.conversations)
  const activeId = useStore(s => s.activeConversationId)
  const activeMsgs = conversations.find(c => c.id === activeId)?.messages?.length ?? 0
  const sessionInProgress = activeMsgs > 1  // 有一条欢迎语时不算

  const toggle = async (key: RendererFlagKey, value: boolean) => {
    await setFlagRemote(key, value)
    setFlags(await loadFlags())
  }

  const openMemoryPanel = () => {
    onClose?.()
    useStore.getState().setActivePanel('memory')
  }

  const doImport = async () => {
    setBusy(true); setMsg(null)
    const api = (window as unknown as { luminaAPI?: LuminaBridgeApi }).luminaAPI
    try {
      if (!api?.dataImportZip) { setMsg({ ok: false, text: '导入接口尚未接线（集成方接入后可用）' }); return }
      const r = await api.dataImportZip()
      if (r?.ok) {
        const total = Object.values(r.imported || {}).reduce((a: number, b: number) => a + (b || 0), 0)
        setMsg({ ok: true, text: `导入完成：新增 ${total} 条记录（已存在的自动跳过，不覆盖）` })
      } else { setMsg({ ok: false, text: '导入失败：' + (r?.error || '未知') }) }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setMsg({ ok: false, text: '导入失败：' + msg })
    } finally { setBusy(false) }
  }

  return (
    <div>
      {/* 两个记忆开关 */}
      <div style={card}>
        <div style={{ ...rowStyle, borderBottom: '1px solid var(--border-light)' }}>
          <div>
            <div style={rowTitle}>对话记忆</div>
            <div style={rowDesc}>记住对话中的重要信息，让后续回答更贴合你。</div>
          </div>
          <Switch checked={!!flags['memory.conversation']} onChange={v => toggle('memory.conversation', v)} />
        </div>

        <div style={rowStyle}>
          <div>
            <div style={rowTitle}>本地记忆与技能</div>
            <div style={rowDesc}>自动记录工作过程并优化技能，数据仅保存在你的设备上。</div>
          </div>
          <Switch checked={!!flags['memory.localSkills']} onChange={v => toggle('memory.localSkills', v)} />
        </div>
      </div>

      {/* 🆕 会话级双开关（对标 MiniMax Code） */}
      <div style={card}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary, #888)', marginBottom: 6 }}>
          会话级记忆控制 · 把「读」和「写」分开管
        </div>

        <div style={{ ...rowStyle, borderBottom: '1px solid var(--border-light)' }}>
          <div>
            <div style={rowTitle}>
              使用记忆
              {sessionInProgress && (
                <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: '#b45309',
                  background: '#fef3c7', padding: '1px 8px', borderRadius: 999 }}>本对话进行中</span>
              )}
            </div>
            <div style={rowDesc}>
              允许 Lumina 在回答前检索并参考长期记忆。
              {sessionInProgress
                ? '本对话已开始，改动将在下一个新对话生效（避免同一对话里记忆前后不一致）。'
                : '建议在开始新对话前设定好。'}
            </div>
          </div>
          <Switch checked={!!flags['memory.recall']} onChange={v => toggle('memory.recall', v)} />
        </div>

        <div style={rowStyle}>
          <div>
            <div style={rowTitle}>生成记忆</div>
            <div style={rowDesc}>允许把本轮对话沉淀为新记忆。可随时开关，会话中改也立即生效。</div>
          </div>
          <Switch checked={!!flags['memory.write']} onChange={v => toggle('memory.write', v)} />
        </div>
      </div>

      {/* 🆕 明确「不记什么」清单 —— 信任设计 */}
      <div style={card}>
        <div style={{ ...rowStyle, padding: 0 }}>
          <div>
            <div style={rowTitle}>Lumina 绝不会记录什么</div>
            <div style={rowDesc}>这是一份明确的边界清单，而不是模糊的承诺。</div>
          </div>
          <button onClick={() => setShowNotStored(v => !v)} style={btnGhost}>
            {showNotStored ? '收起' : '展开'}
          </button>
        </div>
        {showNotStored && (
          <ul style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.9 }}>
            <li><b>一次性状态</b>：你此刻的心情、正在开的窗口、临时的屏幕内容</li>
            <li><b>临时日志与过程噪音</b>：工具调用日志、中间步骤、报错堆栈</li>
            <li><b>敏感密钥</b>：API Key、Token、密码 —— 检测到会自动拦截，永不写入</li>
            <li><b>过期细节</b>：明确的「今天/这次」类信息，过了时效自动沉底</li>
            <li><b>未经证实的推断</b>：模型自己猜的内容权威性 ≤60%，可被你的纠正覆盖</li>
          </ul>
        )}
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary, #888)', marginTop: 10 }}>
          记忆的权威性由「来源」决定，模型无权把推测标记为「确定」。你随时可在「查看记忆」里修改或删除。
        </div>
      </div>

      {/* 管理记忆 */}
      <div style={card}>
        <div style={{ ...rowStyle, padding: 0 }}>
          <div>
            <div style={rowTitle}>管理记忆</div>
            <div style={rowDesc}>每晚自动整理更新，可随时查看和编辑。</div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button onClick={openMemoryPanel} style={btnGhost}>查看记忆</button>
            <button onClick={doImport} disabled={busy} style={btn}>{busy ? '导入中…' : '导入'}</button>
          </div>
        </div>
        {msg && (
          <div style={{
            marginTop: 12, fontSize: 12, padding: '8px 12px', borderRadius: 8,
            background: msg.ok ? 'var(--green-100, #dcfce7)' : 'var(--red-100, #fee2e2)',
            color: msg.ok ? '#166534' : '#991b1b',
          }}>{msg.text}</div>
        )}
      </div>

      <div style={{
        textAlign: 'center', fontSize: 11.5, color: 'var(--text-tertiary, #888)', marginTop: 4,
      }}>
        记忆内容遵循 Lumina 隐私政策，仅你本人可见
      </div>
    </div>
  )
}

const btn: React.CSSProperties = {
  padding: '7px 16px', borderRadius: 8, border: '1px solid var(--border-light)',
  background: 'var(--surface-1)', cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)',
}
const btnGhost: React.CSSProperties = {
  ...btn, background: 'transparent',
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!checked)} aria-pressed={checked}
      style={{
        width: 40, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer',
        background: checked ? '#22c55e' : '#cbd5e1', position: 'relative', transition: 'background .15s',
        flexShrink: 0,
      }}>
      <span style={{
        position: 'absolute', top: 2, left: checked ? 20 : 2, width: 18, height: 18,
        borderRadius: '50%', background: '#fff', transition: 'left .15s',
        boxShadow: '0 1px 3px rgba(0,0,0,.2)',
      }} />
    </button>
  )
}
