// SPDX-License-Identifier: AGPL-3.0-or-later OR Apache-2.0
/// <reference types="vite/client" />

// Vite raw 导入（?raw 后缀）类型声明
declare module '*?raw' {
  const content: string
  export default content
}
