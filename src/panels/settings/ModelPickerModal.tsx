import React from 'react'

interface ModelInfo {
  id: string
  multimodal?: boolean
  vision?: boolean
}

interface Props {
  show: boolean
  models: ModelInfo[] | null
  currentModel: string
  onSelect: (model: string) => void
  onClose: () => void
  isFetching: boolean
  baseUrl?: string
  apiKey?: string
  /** 获取失败/空列表时的具体原因 */
  error?: string | null
  onTestConnection?: (modelId: string) => void
  onTestMultimodal?: (modelId: string) => void
}

/** 🧠 模型选择弹窗 */
export default function ModelPickerModal({
  show, models, currentModel, onSelect, onClose, isFetching,
  baseUrl, apiKey: _apiKey, error,
  onTestConnection, onTestMultimodal,
}: Props) {
  if (!show) {return null}

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        backgroundColor: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: 'fadeIn 0.15s ease-out',
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: 'var(--surface-0)',
          borderRadius: 16,
          boxShadow: '0 16px 48px rgba(0,0,0,0.2)',
          width: 460,
          maxHeight: '80vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          animation: 'fadeInDown 0.2s ease-out',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div style={{
          padding: '18px 22px',
          borderBottom: '1px solid var(--border-light)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
              🧠 选择模型
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.4 }}>
              {baseUrl && (
                <span style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: 10 }}>
                  {baseUrl}
                </span>
              )}
              {models && models.length > 0 && (
                <span> · 共 {models.length} 个</span>
              )}
            </div>
          </div>
          <button onClick={onClose}
            style={{
              border: 'none', background: 'transparent', cursor: 'pointer',
              fontSize: 16, color: 'var(--text-secondary)', width: 30, height: 30,
              borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--surface-100)'; e.currentTarget.style.color = 'var(--text-primary)' }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)' }}>
            ✕
          </button>
        </div>

        {/* 主体 */}
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 140, padding: 0 }}>
          {/* 加载中 */}
          {isFetching && (
            <div style={{ padding: '36px 22px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
              <div style={{
                width: 36, height: 36,
                border: '3px solid var(--border-light)',
                borderTopColor: '#3b82f6', borderRadius: '50%',
                animation: 'spin 0.7s linear infinite',
              }} />
              <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>正在获取模型列表…</div>
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
                {[1, 2, 3, 4].map(i => (
                  <div key={i} style={{
                    height: 48, borderRadius: 8,
                    background: 'linear-gradient(90deg, var(--surface-100) 25%, var(--surface-200) 50%, var(--surface-100) 75%)',
                    backgroundSize: '200% 100%',
                    animation: 'shimmer 1.5s infinite',
                    opacity: 1 - i * 0.15,
                  }} />
                ))}
              </div>
            </div>
          )}

          {/* 获取失败 */}
          {!isFetching && !models && (
            <div style={{ padding: '48px 22px', textAlign: 'center' }}>
              <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.5 }}>⚠️</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>获取模型列表失败</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.8, maxWidth: 280, margin: '0 auto' }}>
                <div>请检查 API 地址和密钥是否正确</div>
                {error && (
                  <div style={{
                    marginTop: 8, fontSize: 11, lineHeight: 1.6,
                    color: '#b91c1c', wordBreak: 'break-all',
                  }}>❗ {error}</div>
                )}
                <div style={{
                  marginTop: 4, fontSize: 11, fontFamily: 'monospace',
                  background: 'var(--surface-100)', padding: '6px 10px', borderRadius: 6,
                  color: 'var(--text-secondary)', wordBreak: 'break-all',
                }}>
                  {baseUrl || '未设置地址'}
                </div>
              </div>
            </div>
          )}

          {/* 空列表 */}
          {!isFetching && models && models.length === 0 && (
            <div style={{ padding: '48px 22px', textAlign: 'center' }}>
              <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.5 }}>📭</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>没有可用模型</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>请先在服务端加载模型</div>
              {error && (
                <div style={{
                  marginTop: 8, fontSize: 11, lineHeight: 1.6, maxWidth: 320, margin: '8px auto 0',
                  color: '#b91c1c', wordBreak: 'break-all',
                }}>❗ {error}</div>
              )}
            </div>
          )}

          {/* 模型列表 */}
          {!isFetching && models && models.length > 0 && (
            <div style={{ padding: '6px 0' }}>
              {models.map((model, index) => {
                const isActive = model.id === currentModel
                const isMultimodal = model.multimodal || model.vision
                return (
                  <div key={model.id}
                    onClick={() => { onSelect(model.id); onClose() }}
                    style={{
                      padding: '12px 22px', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 12,
                      borderLeft: '3px solid transparent',
                      borderLeftColor: isActive ? '#3b82f6' : 'transparent',
                      backgroundColor: isActive ? '#f0f7ff' : 'transparent',
                      transition: 'all 0.12s',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) { e.currentTarget.style.backgroundColor = '#f8fafc'; e.currentTarget.style.borderLeftColor = '#e2e8f0' }
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.borderLeftColor = 'transparent' }
                    }}
                  >
                    {/* 选中圆圈 */}
                    <div style={{
                      width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                      border: '2px solid',
                      borderColor: isActive ? '#3b82f6' : '#d1d5db',
                      backgroundColor: isActive ? '#3b82f6' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, color: '#fff', fontWeight: 700,
                      transition: 'all 0.15s',
                    }}>
                      {isActive ? '✓' : ''}
                    </div>

                    {/* 模型信息 */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 13, fontWeight: isActive ? 600 : 500,
                        color: isActive ? '#1e40af' : 'var(--text-primary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {model.id}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
                        {isMultimodal ? (
                          <span style={{ fontSize: 10, background: '#dbeafe', color: '#1d4ed8', padding: '2px 7px', borderRadius: 4, fontWeight: 600 }}>
                            🖼️ 多模态
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, background: '#f1f5f9', color: 'var(--text-secondary)', padding: '2px 7px', borderRadius: 4 }}>
                            📝 文本
                          </span>
                        )}
                      </div>
                      {/* 测试按钮 */}
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <button onClick={(e) => { e.stopPropagation(); onTestConnection?.(model.id) }}
                          style={{
                            padding: '3px 10px', borderRadius: 4, fontSize: 10,
                            border: '1px solid var(--border-light)', background: '#fafafa',
                            color: 'var(--text-secondary)', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 3,
                            transition: 'all 0.12s',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#3b82f6'; e.currentTarget.style.color = '#3b82f6'; e.currentTarget.style.background = '#eff6ff' }}
                          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-light)'; e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.background = '#fafafa' }}>
                          🔌 连接测试
                        </button>
                        {isMultimodal && (
                          <button onClick={(e) => { e.stopPropagation(); onTestMultimodal?.(model.id) }}
                            style={{
                              padding: '3px 10px', borderRadius: 4, fontSize: 10,
                              border: '1px solid var(--border-light)', background: '#fafafa',
                              color: 'var(--text-secondary)', cursor: 'pointer',
                              display: 'flex', alignItems: 'center', gap: 3,
                              transition: 'all 0.12s',
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#16a34a'; e.currentTarget.style.color = '#16a34a'; e.currentTarget.style.background = '#f0fdf4' }}
                            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-light)'; e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.background = '#fafafa' }}>
                            🖼️ 多模态测试
                          </button>
                        )}
                      </div>
                    </div>

                    {/* 右侧标签 */}
                    {isMultimodal && (
                      <span style={{ fontSize: 9, background: '#f0fdf4', color: '#16a34a', padding: '2px 8px', borderRadius: 10, fontWeight: 600, border: '1px solid #bbf7d0', flexShrink: 0 }}>
                        Vision
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
