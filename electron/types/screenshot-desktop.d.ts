// Type declarations for screenshot-desktop (native C++ binding)
// Used by proactiveEngine.ts, computerUse.ts, nativeScreenshot.ts

declare module 'screenshot-desktop' {
  interface ScreenshotOptions {
    filename?: string
    format?: 'png' | 'jpg'
    screen?: string
  }
  function screenshot(options?: ScreenshotOptions): Promise<Buffer>
  namespace screenshot {
    function listDisplays(): Promise<string[]>
    function all(): Promise<Buffer[]>
  }
  export = screenshot
}
