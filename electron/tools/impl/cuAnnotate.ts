// ============================================================
// cuAnnotate.ts — Set-of-Mark 网格标注 / zoom 局部放大
//
// 用一个隐藏的 Chromium BrowserWindow + <canvas> 给截图叠加编号网格：
//   把“凭感觉估像素坐标”变成“读出目标所在格子的编号”，对本地小模型(9B)
//   的点击准度提升显著；zoom 则裁剪局部放大并叠更细网格，做二次精定位。
//
// 零原生依赖（纯 Chromium canvas，输出 JPEG 控制体积）。
// 任何环节失败都返回 null，由编排层回退到“原图 + 纯归一化坐标”，不阻断操控。
// 仅在主进程、app ready 之后、实际需要时才懒创建窗口。
// ============================================================

import { BrowserWindow } from 'electron'
import { getAppIconPath } from '../../appIcon'
import { pngDimensions, gridDims, type GridInfo, type NormRect } from './cuGeometry'

export interface AnnotatedImage {
  b64: string
  mime: string
  grid: GridInfo
  /** zoom 视图时返回其在全屏的归一化裁剪框 */
  crop?: NormRect
}

// 标注页面（自包含 data URL）。暴露两个全局异步函数，主进程用 executeJavaScript 调用。
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#000}</style></head><body>
<canvas id="c"></canvas>
<script>
function loadImg(b64){return new Promise(function(res,rej){var im=new Image();
  im.onload=function(){res(im)};im.onerror=function(e){rej(e)};
  im.src='data:image/png;base64,'+b64;});}
function drawGrid(ctx,x0,y0,w,h,cols,rows,fs){
  ctx.save();
  ctx.font='bold '+fs+'px ui-monospace,Consolas,Menlo,monospace';
  ctx.textBaseline='top';
  for(var r=0;r<rows;r++){for(var c=0;c<cols;c++){
    var cw=w/cols,rh=h/rows,x=x0+c*cw,y=y0+r*rh,id=r*cols+c,label=String(id);
    ctx.strokeStyle='rgba(255,255,255,0.55)';ctx.lineWidth=Math.max(1,Math.round(fs/16));
    ctx.strokeRect(x,y,cw,rh);
    var tw=ctx.measureText(label).width;
    ctx.fillStyle='rgba(0,0,0,0.5)';ctx.fillRect(x+2,y+2,tw+10,fs+8);
    ctx.fillStyle='rgba(255,226,89,1)';ctx.fillText(label,x+7,y+5);
  }}
  ctx.restore();
}
window.__cuGrid=function(b64,cols,rows){return loadImg(b64).then(function(im){
  var cv=document.getElementById('c');cv.width=im.naturalWidth;cv.height=im.naturalHeight;
  var ctx=cv.getContext('2d');ctx.drawImage(im,0,0);
  var fs=Math.max(15,Math.round(im.naturalWidth/cols/5));
  drawGrid(ctx,0,0,cv.width,cv.height,cols,rows,fs);
  return {b64:cv.toDataURL('image/jpeg',0.82).split(',')[1]};
});};
window.__cuZoom=function(b64,sx,sy,sw,sh,cols,rows){return loadImg(b64).then(function(im){
  var cv=document.getElementById('c');
  var outW=Math.min(1680,Math.max(640,Math.round(sw*3)));
  var scale=outW/sw,outH=Math.round(sh*scale);
  cv.width=outW;cv.height=outH;
  var ctx=cv.getContext('2d');
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
  ctx.drawImage(im,sx,sy,sw,sh,0,0,outW,outH);
  var fs=Math.max(16,Math.round(outW/cols/5));
  drawGrid(ctx,0,0,outW,outH,cols,rows,fs);
  return {b64:cv.toDataURL('image/jpeg',0.85).split(',')[1]};
});};
<\/script></body></html>`

let _win: BrowserWindow | null = null
let _creating: Promise<BrowserWindow | null> | null = null

async function annotator(): Promise<BrowserWindow | null> {
  if (_win && !_win.isDestroyed()) {return _win}
  if (_creating) {return _creating}
  _creating = (async () => {
    try {
      const w = new BrowserWindow({
        show: false,
        width: 256,
        height: 256,
        icon: getAppIconPath(256),
        webPreferences: { /* 默认即可：data URL 内联脚本无需 node */ },
      })
      await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE))
      _win = w
      return w
    } catch (e) {
      console.warn('[cuAnnotate] hidden window init failed:', e)
      _win = null
      return null
    } finally {
      _creating = null
    }
  })()
  return _creating
}

/** 全图叠加编号网格（Set-of-Mark） */
export async function annotateGrid(png: Buffer): Promise<AnnotatedImage | null> {
  try {
    const dims = pngDimensions(png)
    if (!dims) {return null}
    const w = await annotator()
    if (!w || w.isDestroyed()) {return null}
    const grid = gridDims(dims.w, dims.h, 10)
    const b64png = png.toString('base64')
    const out = await w.webContents.executeJavaScript(
      `window.__cuGrid(${JSON.stringify(b64png)},${grid.cols},${grid.rows})`, true,
    )
    if (!out || !out.b64) {return null}
    return { b64: out.b64, mime: 'image/jpeg', grid }
  } catch (e) {
    console.warn('[cuAnnotate] grid failed:', e)
    return null
  }
}

/** 裁剪归一化区域 crop 并放大、叠细网格（zoom 二次精定位） */
export async function annotateZoom(png: Buffer, crop: NormRect): Promise<AnnotatedImage | null> {
  try {
    const dims = pngDimensions(png)
    if (!dims) {return null}
    const w = await annotator()
    if (!w || w.isDestroyed()) {return null}
    const sx = Math.round((crop.nx0 / 100) * dims.w)
    const sy = Math.round((crop.ny0 / 100) * dims.h)
    const sw = Math.max(1, Math.round(((crop.nx1 - crop.nx0) / 100) * dims.w))
    const sh = Math.max(1, Math.round(((crop.ny1 - crop.ny0) / 100) * dims.h))
    const grid = gridDims(sw, sh, 10)
    const b64png = png.toString('base64')
    const out = await w.webContents.executeJavaScript(
      `window.__cuZoom(${JSON.stringify(b64png)},${sx},${sy},${sw},${sh},${grid.cols},${grid.rows})`, true,
    )
    if (!out || !out.b64) {return null}
    return { b64: out.b64, mime: 'image/jpeg', grid, crop }
  } catch (e) {
    console.warn('[cuAnnotate] zoom failed:', e)
    return null
  }
}
