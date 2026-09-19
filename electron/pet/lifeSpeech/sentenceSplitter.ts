// ============================================================
// pet/lifeSpeech/sentenceSplitter.ts — ✂️ 流式中英分句 (v0.2)
//
// 全双工语音要「边生成边播」：LLM/STT 是逐 token 增量到达的，需要在不破坏句子的
// 前提下尽快切出可朗读的完整短句。本类处理：
//   - 强终止：。！？!?；以及换行（中文引号/括号闭合符一并归入句尾）
//   - 弱终止：逗号/顿号在句子足够长时也切（降低首句延迟）
//   - 英文缩写与小数点保护（Mr. / e.g. / 3.14 不误切）
// 纯 TS、零依赖，可单测。
// ============================================================

export interface SplitOptions {
  /** 逗号/顿号是否也作为朗读分句点 */
  splitOnComma?: boolean
  /** 逗号切分所需的最小累积长度（字/字符） */
  commaMinLen?: number
}

const STRONG_END = new Set(['。', '！', '？', '!', '?', '；', ';', '.', '\n'])
const WEAK_END = new Set(['，', '、', ','])
const CLOSING_AFTER_END = new Set(['」', '』', '”', '’', '）', ')', '】', ']', '」'])
const ABBREV = new Set(['mr', 'ms', 'mrs', 'dr', 'prof', 'etc', 'e', 'g', 'i', 'vs', 'no', 'vol', 'fig', 'st', 'jr'])

export class SentenceSplitter {
  private buf = ''
  private splitOnComma: boolean
  private commaMinLen: number

  constructor(opts: SplitOptions = {}) {
    this.splitOnComma = opts.splitOnComma ?? true
    this.commaMinLen = opts.commaMinLen ?? 8
  }

  /** 推入增量文本，返回本次可取出的完整句子（可能 0~N 句） */
  push(text: string): string[] {
    if (!text) {return []}
    this.buf += text
    const out: string[] = []
    let start = 0

    const emit = (endExclusive: number) => {
      const s = this.buf.slice(start, endExclusive).trim()
      if (s) {out.push(s)}
      start = endExclusive
    }

    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i]
      if (STRONG_END.has(ch)) {
        // 英文句点：保护缩写与小数
        if (ch === '.' || ch === '!') {
          if (ch === '.' && this.isProtectedDot(i)) {continue}
        }
        let j = i + 1
        while (j < this.buf.length && CLOSING_AFTER_END.has(this.buf[j])) {j++}
        emit(j)
        i = j - 1
        continue
      }
      if (this.splitOnComma && WEAK_END.has(ch)) {
        if (i - start >= this.commaMinLen) {
          emit(i + 1)
          start = i + 1
        }
      }
    }
    this.buf = this.buf.slice(start)
    return out
  }

  /** 流结束时取出残余（可能为 null） */
  flush(): string | null {
    const s = this.buf.trim()
    this.buf = ''
    return s || null
  }

  private isProtectedDot(i: number): boolean {
    // 小数点：前后都是数字
    const prev = this.buf[i - 1] ?? ''
    const next = this.buf[i + 1] ?? ''
    if (/\d/.test(prev) && /\d/.test(next)) {return true}
    // 缩写：向前找最近的单词起点
    let k = i - 1
    let word = ''
    while (k >= 0 && /[a-zA-Z]/.test(this.buf[k])) { word = this.buf[k] + word; k-- }
    if (word && ABBREV.has(word.toLowerCase())) {return true}
    return false
  }
}
