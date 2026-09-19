import React, { useState } from 'react'
import { SettingSection, SettingRow, SettingRowLast, SettingBtn, SettingInput } from '../../components/SettingsUI'

const pushEventItems = [
  { key: 'notifyNewMail', label: '📧 新邮件通知' },
  { key: 'notifyDream', label: '🌙 新梦境通知' },
  { key: 'notifyLevelUp', label: '🎉 等级提升通知' },
  { key: 'notifyCapsule', label: '📮 时光胶囊到期' },
  { key: 'notifyTaskDone', label: '✅ 定时任务完成' },
]

interface PushConfig {
  serverChanKey: string
  dingTalkWebhook: string
  dingTalkSecret: string
  notifyNewMail: boolean
  notifyDream: boolean
  notifyLevelUp: boolean
  notifyCapsule: boolean
  notifyTaskDone: boolean
}

/** 📱 多渠道推送设置 */
export default function SettingsPush() {
  const [pushConfig, setPushConfigState] = useState<PushConfig>(() => ({
    serverChanKey: '', dingTalkWebhook: '', dingTalkSecret: '',
    notifyNewMail: true, notifyDream: true, notifyLevelUp: true, notifyCapsule: true, notifyTaskDone: true,
  }))
  const [testingChan, setTestingChan] = useState(false)
  const [testChanResult, setTestChanResult] = useState<boolean | null>(null)
  const [testingDing, setTestingDing] = useState(false)
  const [testDingResult, setTestDingResult] = useState<boolean | null>(null)

  const setPushConfig = (cfg: PushConfig) => {
    setPushConfigState(cfg)
    window.luminaAPI?.pushUpdateConfig?.(cfg)
  }

  const testServerChan = async () => {
    if (!pushConfig.serverChanKey) {return}
    setTestingChan(true)
    setTestChanResult(null)
    try {
      const res = await window.luminaAPI?.pushTestServerChan?.(pushConfig.serverChanKey)
      setTestChanResult(res?.ok ?? false)
    } catch { setTestChanResult(false) }
    setTestingChan(false)
  }

  const testDingTalk = async () => {
    if (!pushConfig.dingTalkWebhook) {return}
    setTestingDing(true)
    setTestDingResult(null)
    try {
      const res = await window.luminaAPI?.pushTestDingTalk?.(pushConfig.dingTalkWebhook, pushConfig.dingTalkSecret)
      setTestDingResult(res?.ok ?? false)
    } catch { setTestDingResult(false) }
    setTestingDing(false)
  }

  const configured = pushConfig.serverChanKey || pushConfig.dingTalkWebhook

  return (
    <SettingSection
      title="📱 多渠道推送"
      desc="通过微信（ServerChan）或钉钉机器人将重要通知推送到你的手机"
      badge={configured ? '已配置' : undefined}
    >
      {/* ── ServerChan ── */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
          🚀 ServerChan <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>（微信推送）</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={pushConfig.serverChanKey}
            onChange={e => setPushConfig({ ...pushConfig, serverChanKey: e.target.value })}
            placeholder="申请地址: https://sct.ftqq.com"
            style={{
              flex: 1, padding: '7px 10px', borderRadius: 6, fontSize: 12,
              border: '1.5px solid var(--border-light)', outline: 'none',
              background: 'var(--surface-0)', color: 'var(--text-primary)',
              fontFamily: 'monospace',
            }} />
          <SettingBtn onClick={testServerChan} disabled={testingChan}>
            {testingChan ? '测试中…' : '测试'}
          </SettingBtn>
        </div>
        {testChanResult !== null && (
          <div style={{ fontSize: 11, marginTop: 4, color: testChanResult ? '#065f46' : '#dc2626' }}>
            {testChanResult ? '✅ 推送成功！请检查微信' : '❌ 测试失败，请检查 Key'}
          </div>
        )}
      </div>

      {/* ── 钉钉 ── */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
          📮 钉钉机器人
        </div>
        <input value={pushConfig.dingTalkWebhook}
          onChange={e => setPushConfig({ ...pushConfig, dingTalkWebhook: e.target.value })}
          placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
          style={{
            width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 11,
            border: '1.5px solid var(--border-light)', outline: 'none',
            background: 'var(--surface-0)', color: 'var(--text-primary)',
            fontFamily: 'monospace', marginBottom: 6, boxSizing: 'border-box',
          }} />
        <input value={pushConfig.dingTalkSecret}
          onChange={e => setPushConfig({ ...pushConfig, dingTalkSecret: e.target.value })}
          placeholder="加签密钥 (SEC...，可选)"
          style={{
            width: '100%', padding: '7px 10px', borderRadius: 6, fontSize: 11,
            border: '1.5px solid var(--border-light)', outline: 'none',
            background: 'var(--surface-0)', color: 'var(--text-primary)',
            fontFamily: 'monospace', marginBottom: 6, boxSizing: 'border-box',
          }} />
        <div style={{ display: 'flex', gap: 6 }}>
          <SettingBtn onClick={testDingTalk} disabled={testingDing}>
            {testingDing ? '测试中…' : '测试'}
          </SettingBtn>
        </div>
        {testDingResult !== null && (
          <div style={{ fontSize: 11, marginTop: 4, color: testDingResult ? '#065f46' : '#dc2626' }}>
            {testDingResult ? '✅ 推送成功！请检查钉钉' : '❌ 测试失败，请检查 Webhook'}
          </div>
        )}
      </div>

      {/* ── 推送事件开关 ── */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          推送事件
          <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-secondary)' }}>
            选择推送到手机的事件
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {pushEventItems.map(item => (
            <label key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12 }}>
              <input type="checkbox" checked={(pushConfig as any)[item.key] ?? true}
                onChange={e => setPushConfig({ ...pushConfig, [item.key]: e.target.checked })}
                style={{ accentColor: '#8b5cf6' }} />
              {item.label}
            </label>
          ))}
        </div>
      </div>
    </SettingSection>
  )
}
