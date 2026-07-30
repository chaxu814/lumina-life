/**
 * LM Studio 优化处理模块
 * 专门处理LM Studio的模型识别和连接测试
 */

import { ipcMain } from 'electron';

/** 增强的LM Studio模型获取 */
export function registerLMStudioIpc(): void {
  
  // ─── LM Studio 增强模型获取 ─────────────────
  ipcMain.handle('lmstudio:fetchModels', async (_event, params: {
    baseUrl: string; apiKey: string
  }) => {
    try {
      console.log('[lmstudio:fetchModels]', JSON.stringify({ 
        baseUrl: params.baseUrl, 
        hasApiKey: !!params.apiKey 
      }))
      
      const isLMStudio = params.baseUrl.includes('lmstudio') || 
                        params.baseUrl.includes('127.0.0.1:1234') || 
                        params.baseUrl.includes('localhost:1234')
      
      if (!isLMStudio) {
        // 如果不是LM Studio，使用标准处理方法
        return await fetchStandardModels(params)
      }
      
      console.log('[lmstudio:fetchModels] 检测到LM Studio，使用增强识别')
      return await handleLMStudioEnhanced(params)
      
    } catch (err: any) { 
      console.error('[lmstudio:fetchModels] 错误:', err.message)
      return { 
        models: [
          { id: 'LM Studio连接失败', multimodal: false, vision: false },
          { id: '错误: ' + err.message.slice(0, 100), multimodal: false, vision: false }
        ],
        error: `获取模型失败: ${err.message}` 
      } 
    }
  })
  
  // ─── LM Studio 增强连接测试 ─────────────────
  ipcMain.handle('lmstudio:testConnection', async (_event, params: {
    baseUrl: string; apiKey: string; model: string
  }) => {
    const startTime = Date.now()
    
    try {
      console.log('[lmstudio:testConnection]', JSON.stringify({ 
        baseUrl: params.baseUrl, 
        model: params.model,
        hasApiKey: !!params.apiKey 
      }))
      
      // 尝试简单的聊天完成请求
      const response = await fetch(params.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + (params.apiKey || ''),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: params.model,
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 10,
        }),
        signal: AbortSignal.timeout(8000),
      })
      
      const endTime = Date.now()
      const latency = endTime - startTime
      
      if (response.ok) {
        const data = await response.json()
        const usage = data.usage || {}
        return { 
          success: true, 
          latency,
          usage: {
            prompt_tokens: usage.prompt_tokens || 0,
            completion_tokens: usage.completion_tokens || 0,
            total_tokens: usage.total_tokens || 0,
          },
          model: data.model || params.model,
          message: 'LM Studio连接测试成功！服务运行正常。'
        }
      } else {
        const errorText = await response.text()
        return { 
          success: false, 
          error: 'LM Studio连接失败: HTTP ' + response.status + ': ' + errorText.slice(0, 200),
          latency,
          message: '请确保LM Studio已启动且模型已加载。'
        }
      }
    } catch (err: any) {
      console.error('[lmstudio:testConnection] 错误:', err.message)
      const latency = Date.now() - startTime
      return { 
        success: false, 
        error: '连接失败: ' + err.message,
        latency,
        message: '无法连接到LM Studio。请检查：1. LM Studio是否运行 2. 端口是否正确(1234) 3. 防火墙设置'
      }
    }
  })
}

/** 标准模型获取（兼容OpenAI格式） */
async function fetchStandardModels(params: { baseUrl: string; apiKey: string }): Promise<{ 
  models: Array<{ id: string; multimodal?: boolean; vision?: boolean }> 
}> {
  try {
    const response = await fetch(params.baseUrl + '/models', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + (params.apiKey || ''),
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    })
    
    if (response.ok) {
      const data = await response.json()
      let models: Array<{ id: string; multimodal?: boolean; vision?: boolean }> = []
      
      if (Array.isArray(data)) {
        models = data.map((m: any) => {
          const id = m.id || m.model || m.name || ''
          return extractModelCapabilities(id)
        })
      } else if (data.data && Array.isArray(data.data)) {
        models = data.data.map((m: any) => {
          const id = m.id || m.model || m.name || ''
          return extractModelCapabilities(id)
        })
      } else if (data.models && Array.isArray(data.models)) {
        models = data.models.map((m: any) => {
          const id = m.id || m.model || m.name || ''
          return extractModelCapabilities(id)
        })
      }
      
      const validModels = models
        .filter((m: any) => !!m.id && m.id.trim())
        .sort((a: any, b: any) => a.id.localeCompare(b.id))
      
      console.log('[fetchStandardModels] 找到 ' + validModels.length + ' 个模型')
      return { models: validModels }
    } else {
      return { 
        models: [
          { id: 'API连接失败', multimodal: false, vision: false },
          { id: '状态码: ' + response.status, multimodal: false, vision: false }
        ]
      }
    }
  } catch (error: any) {
    console.error('[fetchStandardModels] 错误:', error.message)
    return { 
      models: [
        { id: '连接异常', multimodal: false, vision: false },
        { id: '错误: ' + error.message.slice(0, 30) + '（不支持的端点或网络问题）', multimodal: false, vision: false }
      ]
    }
  }
}

/** LM Studio增强处理 */
async function handleLMStudioEnhanced(params: { baseUrl: string; apiKey: string }): Promise<{ 
  models: Array<{ id: string; multimodal?: boolean; vision?: boolean }> 
}> {
  console.log('[handleLMStudioEnhanced] 处理LM Studio连接')
  
  const endpointsToTry = [
    '/v1/models',
    '/models', 
    '/api/models',
    '/v1/chat/completions',
  ]
  
  for (const endpoint of endpointsToTry) {
    try {
      const response = await fetch(params.baseUrl + endpoint, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + (params.apiKey || ''),
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      })
      
      if (response.ok) {
        const data = await response.json()
        console.log('[handleLMStudioEnhanced] ' + endpoint + ' 响应:', JSON.stringify(data).slice(0, 200))
        
        let models: Array<{ id: string; multimodal?: boolean; vision?: boolean }> = []
        
        if (Array.isArray(data)) {
          models = data.map((m: any) => {
            const id = m.id || m.model || m.name || ''
            return extractModelCapabilities(id)
          })
        } else if (data.data && Array.isArray(data.data)) {
          models = data.data.map((m: any) => {
            const id = m.id || m.model || m.name || ''
            return extractModelCapabilities(id)
          })
        } else if (data.models && Array.isArray(data.models)) {
          models = data.models.map((m: any) => {
            const id = m.id || m.model || m.name || ''
            return extractModelCapabilities(id)
          })
        }
        
        const validModels = models.filter((m: any) => !!m.id && m.id.trim())
        if (validModels.length > 0) {
          console.log('[handleLMStudioEnhanced] 通过 ' + endpoint + ' 找到 ' + validModels.length + ' 个模型')
          return { models: validModels }
        }
      }
    } catch (error: any) {
      console.log('[handleLMStudioEnhanced] ' + endpoint + ' 失败:', error.message)
    }
  }
  
  // 所有端点都失败，尝试健康检查
  try {
    const healthResponse = await fetch(params.baseUrl + '/health', {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    })
    
    if (healthResponse.ok) {
      console.log('[handleLMStudioEnhanced] LM Studio健康检查通过')
      return {
        models: [
          { id: '⚠️ LM Studio正在运行', multimodal: false, vision: false },
          { id: '但未返回模型列表', multimodal: false, vision: false },
          { id: '请在LM Studio中加载模型', multimodal: false, vision: false },
          { id: '或手动输入模型名称', multimodal: false, vision: false }
        ]
      }
    }
  } catch (error) {
    console.log('[handleLMStudioEnhanced] 健康检查失败')
  }
  
  // 默认返回
  return {
    models: [
      { id: '🔧 LM Studio连接指南', multimodal: false, vision: false },
      { id: '1. 启动LM Studio', multimodal: false, vision: false },
      { id: '2. 加载一个模型', multimodal: false, vision: false },
      { id: '3. 确保API服务器运行', multimodal: false, vision: false },
      { id: '4. 端口: 1234', multimodal: false, vision: false }
    ]
  }
}

/** 从模型ID提取能力信息 */
function extractModelCapabilities(modelId: string): { 
  id: string; 
  multimodal: boolean; 
  vision: boolean 
} {
  const id = modelId.trim()
  
  // 常见本地模型的多模态能力映射
  const localModelCapabilities: Record<string, { multimodal: boolean; vision: boolean }> = {
    // Llama系列
    'llama-3.1-70b-instruct': { multimodal: false, vision: false },
    'llama-3.1-8b-instruct': { multimodal: false, vision: false },
    'llama-3.2': { multimodal: false, vision: false },
    
    // Qwen系列
    'qwen2.5-7b-instruct': { multimodal: false, vision: false },
    'qwen2.5-14b-instruct': { multimodal: false, vision: false },
    'qwen2.5-vl-7b-instruct': { multimodal: true, vision: true },
    
    // Mixtral系列
    'mixtral-8x7b-instruct': { multimodal: false, vision: false },
    'mixtral-8x22b-instruct': { multimodal: false, vision: false },
    
    // 通义千问VL系列
    'qwen-vl': { multimodal: true, vision: true },
    'qwen-vl-chat': { multimodal: true, vision: true },
    
    // 智谱GLM系列
    'glm-4': { multimodal: false, vision: false },
    'glm-4v': { multimodal: true, vision: true },
    
    // DeepSeek系列
    'deepseek-v2': { multimodal: false, vision: false },
    'deepseek-vl': { multimodal: true, vision: true },
    
    // LLaVA系列
    'llava': { multimodal: true, vision: true },
    'llava-1.5': { multimodal: true, vision: true },
    'llava-1.6': { multimodal: true, vision: true },
  }
  
  // 首先检查本地模型映射
  const lowerId = id.toLowerCase()
  for (const [key, capabilities] of Object.entries(localModelCapabilities)) {
    if (lowerId.includes(key.toLowerCase())) {
      console.log('[extractModelCapabilities] 识别到本地模型: ' + key)
      return { id, ...capabilities }
    }
  }
  
  // 多模态模型标识
  const multimodalPatterns = [
    /vision/i, /gpt-4o/i, /claude/i, /gemini/i, /glm-4v/i,
    /qwen-vl/i, /vl/i, /deepseek-vl/i, /llava/i,
    /phi.*vision/i, /video/i, /image/i, /visual/i, /multimodal/i
  ]
  
  // 视觉专用模型标识
  const visionPatterns = [
    /vision/i, /gpt-4o/i, /claude-3/i, /gemini.*vision/i, /glm-4v/i,
    /qwen-vl/i, /deepseek-vl/i, /llava/i,
    /phi.*vision/i, /video/i, /image/i, /visual/i
  ]
  
  const isMultimodal = multimodalPatterns.some(pattern => pattern.test(id))
  const isVision = visionPatterns.some(pattern => pattern.test(id))
  
  return {
    id,
    multimodal: isMultimodal || isVision,
    vision: isVision
  }
}