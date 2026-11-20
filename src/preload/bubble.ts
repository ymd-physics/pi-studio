import {contextBridge,ipcRenderer} from 'electron'
import type {BubbleAPI} from '../../packages/shared/bubble'
const invoke=(method:string,...args:unknown[])=>ipcRenderer.invoke('bubble:invoke',method,...args)
const api:BubbleAPI={position:fn=>{const cb=(_e:Electron.IpcRendererEvent,v:Parameters<typeof fn>[0])=>fn(v);ipcRenderer.on('bubble:position',cb);return ()=>ipcRenderer.removeListener('bubble:position',cb)},hit:v=>invoke('hit',v),state:()=>invoke('state'),layout:(s,e)=>invoke('layout',s,e),drag:(p,point)=>invoke('drag',p,point),restore:h=>invoke('restore',h),answer:c=>invoke('answer',c),changed:fn=>{const cb=()=>fn();ipcRenderer.on('bubble:changed',cb);return ()=>ipcRenderer.removeListener('bubble:changed',cb)},dismissed:fn=>{const cb=()=>fn();ipcRenderer.on('bubble:dismiss',cb);return ()=>ipcRenderer.removeListener('bubble:dismiss',cb)}}
contextBridge.exposeInMainWorld('bubble',api)
