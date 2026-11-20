import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { app, BrowserWindow, ipcMain, screen, systemPreferences } from 'electron'
import { join } from 'node:path'
import type { DesktopService } from './service'
import { bubblePadding, bubbleSizes } from '../../../packages/shared/bubble'
import type { BubbleChoice, BubbleLayout } from '../../../packages/shared/bubble'

// The main renderer stays mounted. Only this small native window travels between Spaces.
export class BubbleWindow {
  private win?: BrowserWindow
  private anchor?: Electron.Point
  private grab?: Electron.Point
  private moved = false
  private resumeFullscreen = false
  private readonly positionFile = join(app.getPath('userData'), 'bubble-position.json')
  private size: number = bubbleSizes.Standard
  private expanded = false
  private transition = 0
  private returning = false
  private entering = false
  activate(){if(!this.entering && !this.returning)this.restore()}

  // Animate the two native surfaces, not the document: title bars and live
  // terminals fade together without resizing or temporarily reflowing Studio.
  private async crossfade(w: BrowserWindow, entering: boolean) {
    const revision = ++this.transition
    const hostStart = this.host.getOpacity(), bubbleStart = w.getOpacity()
    const duration = process.platform === 'linux' || systemPreferences.getAnimationSettings().prefersReducedMotion ? 0 : 180
    const start = performance.now()
    while (revision === this.transition && this.win === w && !w.isDestroyed() && !this.host.isDestroyed()) {
      const f = duration ? Math.min(1, (performance.now()-start)/duration) : 1
      const t = f*f*(3-2*f)
      this.host.setOpacity(hostStart + ((entering?0:1)-hostStart)*t)
      w.setOpacity(bubbleStart + ((entering?1:0)-bubbleStart)*t)
      if (f===1) return true
      await new Promise(resolve=>setTimeout(resolve, 15))
    }
    return false
  }
  constructor(private host: BrowserWindow, private service: DesktopService, private here: string, private pausePresentation: (paused:boolean)=>void) {
    ipcMain.handle('bubble:invoke', (event, method, arg, extra) => {
      const w = this.win
      if (!w || event.sender !== w.webContents || event.senderFrame !== w.webContents.mainFrame) throw new Error('Untrusted bubble sender')
      switch(method) {
        case 'state': return service.bubbleState()
        case 'hit': if(process.platform==='darwin' && !this.grab) w.setIgnoreMouseEvents(!arg,{forward:true});return
        case 'layout':
          if (!Object.values(bubbleSizes).includes(arg) || typeof extra !== 'boolean') throw new Error('Invalid bubble layout')
          if (extra !== this.expanded && process.platform==='darwin') w.setFocusable(extra)
          this.size = arg; this.expanded = extra
          const layout = this.layout()
          // A showInactive panel must acquire focus when opened so another app
          // taking focus produces the native blur used for dismissal.
          if (this.expanded) w.focus()
          return layout
        case 'drag': {
          // Use coordinates from the captured pointer event, not a later sample
          // of the system cursor after the native window has already moved.
          if (!Number.isFinite(extra?.x) || !Number.isFinite(extra?.y)) return
          if (arg === 'start' && this.anchor) {this.grab = {x:extra.x-this.anchor.x,y:extra.y-this.anchor.y};this.moved=false}
          if (this.grab && (arg==='move' || (arg==='end' && this.moved))) {
            this.moved=true; this.expanded=false
            this.anchor={x:extra.x-this.grab.x,y:extra.y-this.grab.y}
            const layout=this.layout(screen.getDisplayNearestPoint({x:Math.round(extra.x),y:Math.round(extra.y)}).workArea)
            w.webContents.send('bubble:position',layout)
          }
          if (arg === 'end') {
            this.grab=undefined
            if(this.moved){try{writeFileSync(this.positionFile+'.tmp',JSON.stringify(this.anchor));renameSync(this.positionFile+'.tmp',this.positionFile)}catch(e){console.warn('Could not save bubble position',e)}}
            this.moved=false
          }
          return
        }
        case 'restore': return this.returnAnimated(typeof arg==='string'?arg:undefined)
        case 'answer': return service.answerBubble(arg as BubbleChoice)
        default: throw new Error('Unknown bubble operation')
      }
    })
    host.on('show',()=>{if(!this.entering && !this.returning && this.win?.isVisible()) void this.returnAnimated()})
  }
  private layout(area?: Electron.Rectangle): BubbleLayout {
    const w=this.win!, a=this.anchor!, size=this.size, pad=bubblePadding
    const r=area ?? screen.getDisplayNearestPoint({x:a.x+size/2,y:a.y+size/2}).workArea
    const clamp=(v:number, lo:number, hi:number)=>Math.round(Math.max(lo,Math.min(hi,v)))
    a.x=clamp(a.x,r.x+pad,r.x+r.width-size-pad); a.y=clamp(a.y,r.y+pad,r.y+r.height-size-pad)
    const strip=process.platform==='darwin'
    if (!this.expanded) {
      // A collapsed orb always sits at the same local coordinates. Panel-side
      // selection must not move it when crossing the middle of a display.
      const side=size+2*pad, x=strip?r.x:a.x-pad,y=a.y-pad, width=strip?r.width:side
      const previous=w.getBounds()
      if(previous.width!==width || previous.height!==side) w.setBounds({x,y,width,height:side},false)
      else if(previous.x!==x || previous.y!==y) w.setPosition(x,y,false)
      return {x:a.x-x,y:pad,panelX:pad,panelY:pad,width:316,height:336}
    }
    const leftRoom=a.x-r.x-pad-5,rightRoom=r.x+r.width-pad-(a.x+size)-5
    const left=leftRoom>=316 || leftRoom>=rightRoom
    const panelWidth=Math.min(316,Math.max(leftRoom,rightRoom))
    // Both sets of coordinates are known even while collapsed. CSS anchors the
    // orb to the compact viewport until Chromium receives the native resize.
    const width=size+2*pad+panelWidth+5, height=Math.min(348,r.height)
    const x=clamp(a.x-pad-(left?panelWidth+5:0),r.x,r.x+r.width-width), y=clamp(a.y-pad,r.y,r.y+r.height-height)
        const origin=strip?r.x:x
    w.setBounds({x:origin,y,width:strip?r.width:width,height},false)
    return {x:a.x-origin,y:a.y-y,panelX:(left?pad:width-pad-panelWidth)+x-origin,panelY:pad,width:panelWidth,height:height-pad*2}
  }
  async enter() {
    if (this.win) return
    const area=screen.getDisplayMatching(this.host.getBounds()).workArea
    if(!this.anchor){try{const point=JSON.parse(readFileSync(this.positionFile,'utf8'));if(Number.isFinite(point?.x)&&Number.isFinite(point?.y))this.anchor={x:point.x,y:point.y}}catch{/* first launch or invalid position */}}
    this.anchor??={x:area.x+area.width-90,y:area.y+70}; this.expanded=false
    const w=this.win=new BrowserWindow({width:64,height:64,show:false,frame:false,transparent:true,backgroundColor:'#00000000',hasShadow:false,resizable:false,minimizable:false,maximizable:false,fullscreenable:false,skipTaskbar:true,alwaysOnTop:true,
      ...(process.platform==='darwin'?{type:'panel',acceptFirstMouse:true,focusable:false,hiddenInMissionControl:true,movable:false}:{}),webPreferences:{preload:join(this.here,'../preload/bubble.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}})
    this.entering=true
    if(process.platform==='darwin') w.setIgnoreMouseEvents(true,{forward:true})
    w.setAlwaysOnTop(true,'floating'); w.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true,skipTransformProcessType:true})
    w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',e=>e.preventDefault())
    w.on('closed',()=>{if(this.win===w){this.win=undefined;this.transition++;this.returning=false;this.pausePresentation(false);if(!this.host.isDestroyed()){this.host.setOpacity(1);this.host.show()}}})
    w.on('blur',()=>{if(this.win===w && this.expanded) w.webContents.send('bubble:dismiss')})
    w.webContents.on('render-process-gone',()=>this.restore()); this.layout()
    try {
      if(process.env.ELECTRON_RENDERER_URL) await w.loadURL(new URL('bubble.html',process.env.ELECTRON_RENDERER_URL).href)
      else await w.loadFile(join(this.here,'../renderer/bubble.html'))
      if(this.win!==w)return
      if(process.platform==='darwin' && this.host.isFullScreen()) {
        // Fading the sole window in its dedicated full-screen Space exposes a
        // black backing surface. Leave the Space while Studio is still opaque.
        this.resumeFullscreen=true
        await new Promise<void>((resolve,reject)=>{
          const done=()=>{clearTimeout(timer);this.host.off('leave-full-screen',done);resolve()}
          const timer=setTimeout(()=>{this.host.off('leave-full-screen',done);reject(new Error('Studio could not leave full screen'))},6000)
          this.host.once('leave-full-screen',done);this.host.setFullScreen(false)
        })
        if(this.win!==w)return
      }
      w.setOpacity(0); w.showInactive(); this.layout() // AppKit may reposition a panel when ordering it on screen
      if(await this.crossfade(w,true)){this.host.hide();this.layout();this.pausePresentation(true);this.host.setOpacity(1)}
    }catch(e){this.restore();throw e}finally{this.entering=false}
  }
  changed(){this.win?.webContents.send('bubble:changed')}
  private async returnAnimated(handle?:string){
    const w=this.win
    if(!w||this.returning)return
    this.returning=true
    this.pausePresentation(false)
    if(!this.host.isVisible())this.host.setOpacity(0)
    this.host.show(); this.host.focus()
    if(await this.crossfade(w,false))this.restore(handle)
  }
  restore(handle?:string){this.transition++;this.returning=false;const w=this.win;if(!w)return;this.win=undefined;this.grab=undefined;this.pausePresentation(false);w.destroy();if(!this.host.isDestroyed()){this.host.setOpacity(1);this.host.show();this.host.focus();if(this.resumeFullscreen){this.resumeFullscreen=false;this.host.setFullScreen(true)}if(handle)this.host.webContents.send('pi:event',{type:'desktop_bubble_session',desktopSession:handle})}}
}
