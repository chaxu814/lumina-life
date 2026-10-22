// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
/**
 * adm-zip 最小类型声明（项目未装 @types/adm-zip）。
 * 只声明 dataExport.ts 实际用到的 API，够用即可；
 * 若日后安装 @types/adm-zip，本文件可删除。
 */
declare module 'adm-zip' {
  class ZipEntry {
    entryName: string
    getData(): Buffer
    readAsText(encoding?: string): string
  }
  export default class AdmZip {
    constructor(path?: string)
    addFile(entryName: string, data: Buffer): void
    getEntries(): ZipEntry[]
    readAsText(entry: ZipEntry): string
    writeZip(target: string): void
  }
}
