// tests/agentRunner.test.ts — AgentRunner 单元测试
import { describe, it, expect, vi, beforeAll } from 'vitest'

// ═══════════════════════════════════════════════════════════
// Mock Electron 'app' 模块 — agentRunner 导入链依赖 app.getPath
// ═══════════════════════════════════════════════════════════

beforeAll(() => {
  vi.mock('electron', () => ({
    app: {
      getPath: (name: string) => {
        if (name === 'userData') {return process.cwd()}
        return process.cwd()
      },
    },
  }))
})

// ═══════════════════════════════════════════════════════════
// 现在可以安全导入
// ═══════════════════════════════════════════════════════════

import { parseXmlToolCalls } from '../electron/agentRunner'

describe('parseXmlToolCalls', () => {
  it('returns null for empty text', () => {
    expect(parseXmlToolCalls('')).toBeNull()
    expect(parseXmlToolCalls('' as unknown as string)).toBeNull()
  })

  it('parses a single tool call', () => {
    const xml = `<tool_call>
<function=browser>
<parameter=action>snapshot</parameter>
</function>
</tool_call>`
    const calls = parseXmlToolCalls(xml)
    expect(calls).not.toBeNull()
    expect(calls!.length).toBe(1)
    expect(calls![0].function.name).toBe('browser')
    const args = JSON.parse(calls![0].function.arguments)
    expect(args.action).toBe('snapshot')
  })

  it('parses multiple tool calls', () => {
    const xml = `<tool_call>
<function=browser>
<parameter=action>snapshot</parameter>
</function>
</tool_call>
<tool_call>
<function=shell_exec>
<parameter=command>echo hello</parameter>
</function>
</tool_call>`
    const calls = parseXmlToolCalls(xml)
    expect(calls).not.toBeNull()
    expect(calls!.length).toBe(2)
  })

  it('parses multi-parameter tool calls', () => {
    const xml = `<tool_call>
<function=file_write>
<parameter=file_path>/tmp/test.txt</parameter>
<parameter=content>hello world</parameter>
</function>
</tool_call>`
    const calls = parseXmlToolCalls(xml)
    expect(calls).not.toBeNull()
    const args = JSON.parse(calls![0].function.arguments)
    expect(args.file_path).toBe('/tmp/test.txt')
    expect(args.content).toBe('hello world')
  })

  it('returns null for non-tool-call text', () => {
    expect(parseXmlToolCalls('Hello, world!')).toBeNull()
    expect(parseXmlToolCalls('<div>not a tool call</div>')).toBeNull()
  })

  it('handles whitespace in XML', () => {
    const xml = `  <tool_call>
  <function=browser>
  <parameter=action>  snapshot  </parameter>
  </function>
  </tool_call>  `
    const calls = parseXmlToolCalls(xml)
    expect(calls).not.toBeNull()
    const args = JSON.parse(calls![0].function.arguments)
    expect(args.action).toBe('snapshot')
  })
})
