import {useEffect,useState,useRef} from 'react'
import {createRoot} from 'react-dom/client'
import {Circle, LoaderCircle, MessageCircleMore, PanelsTopLeft, SlidersHorizontal} from 'lucide-react'
import { bubblePadding, bubbleSizes, savedBubbleSize } from '../../../../packages/shared/bubble'
import type {BubbleChoice,BubbleLayout,BubbleState,BubbleSession} from '../../../../packages/shared/bubble'
import {uiText} from '../../../../packages/shared/language'
import './bubble.css'

function Ring({sessions}:{sessions:BubbleSession[]}) {
  const n=sessions.length, step=2*Math.PI/(n||1), gap=Math.min(.27,step*.25)
  const pt=(a:number)=>`${26+21*Math.cos(a)} ${26+21*Math.sin(a)}`
  return <svg viewBox="-2.5 -2.5 57 57" className="ring" aria-hidden="true"><defs><radialGradient id="satin"><stop stopColor="#d8e9ff"/><stop offset="1" stopColor="#a9caff" stopOpacity="0"/></radialGradient></defs><circle className="track" cx="26" cy="26" r="21"/>{sessions.map((s,i)=>{
    const path=`M ${pt(i*step+gap/2)} A 21 21 0 ${step-gap>Math.PI?1:0} 1 ${pt((i+1)*step-gap/2)}`
    const status=s.request?'waiting':s.status
    return <g key={s.handle}><path d={path} className={status}/>{status==='working'&&<><mask id={`lane${i}`} maskUnits="userSpaceOnUse" x="0" y="0" width="52" height="52"><path d={path} stroke="white" strokeWidth="3"/></mask><g mask={`url(#lane${i})`}><ellipse rx={Math.min(12,21*(step-gap)*.32)} ry="2.6" className="glint" style={{offsetPath:`path('${path}')`,animationDelay:`${-i*.71}s`,animationDuration:n===1?'4.8s':'3.6s'}}/></g></>}</g>
  })}</svg>
}
function Bubble(){
  const api=window.bubble, [data,setData]=useState<BubbleState>({language:'en',sessions:[]}),t=uiText(data.language)
  const [expanded,expand]=useState(false),[settings,configure]=useState(false),[error,fail]=useState(''),[sending,send]=useState(false)
  const [size,resize]=useState(()=>savedBubbleSize(localStorage.getItem('bubbleSizeTier'),localStorage.getItem('bubbleSizeV2'),localStorage.getItem('bubbleSize')))
  const [panelReady,setPanelReady]=useState(false)
  const [theme,setTheme]=useState(()=>['light','dark'].includes(localStorage.bubbleTheme)?String(localStorage.bubbleTheme):'auto')
  const [layout,position]=useState<BubbleLayout>({x:5,y:5,panelX:5,panelY:5,width:316,height:336})
  const drag=useRef<{x:number;y:number;moving:boolean}>(),skipClick=useRef(false)
  const close=()=>{expand(false);configure(false)}
  useEffect(()=>api.position(position),[])
  useEffect(()=>{
    let previous:boolean|undefined
    const hit=(interactive:boolean)=>{if(!drag.current && interactive!==previous){previous=interactive;void api.hit(interactive)}}
    const move=(e:MouseEvent)=>hit(!!document.elementFromPoint(e.clientX,e.clientY)?.closest('.orb,aside'))
    const leave=()=>hit(false)
    document.addEventListener('mousemove',move);document.documentElement.addEventListener('mouseleave',leave)
    return()=>{document.removeEventListener('mousemove',move);document.documentElement.removeEventListener('mouseleave',leave)}
  },[])
  useEffect(()=>{const outside=(e:PointerEvent)=>{if(e.target instanceof Element && !e.target.closest('.orb, aside'))close()};document.addEventListener('pointerdown',outside);const off=api.dismissed(close);return()=>{document.removeEventListener('pointerdown',outside);off()}},[])
  useEffect(()=>{let active=true,rev=0;const refresh=()=>{const r=++rev;void api.state().then(v=>{if(active&&r===rev)setData(v)}).catch(e=>fail(String(e)))};const off=api.changed(refresh);refresh();return()=>{active=false;off()}},[])
  useEffect(()=>{let live=true;void api.layout(size,expanded).then(v=>{if(live){position(v);setPanelReady(expanded)}});localStorage.bubbleSizeTier=Object.entries(bubbleSizes).find(([,v])=>v===size)![0];return()=>{live=false}},[size,expanded])
  useEffect(()=>{localStorage.bubbleTheme=theme;document.documentElement.dataset.mode=theme},[theme])
  useEffect(()=>{document.documentElement.lang=data.language},[data.language])
  const respond=async(s:BubbleSession,choice:BubbleChoice['choice'])=>{if(!s.request||sending)return;send(true);fail('');try{await api.answer({handle:s.handle,epoch:s.epoch,id:s.request.id,choice})}catch(e){fail(String(e))}finally{send(false)}}
  const group=(label:string,opts:readonly (readonly [string,string])[],value:string,change:(v:string)=>void)=><fieldset><legend>{t(label)}</legend>{opts.map(([v,name])=><button key={v} aria-pressed={v===value} onClick={()=>change(v)}>{t(name)}</button>)}</fieldset>
  return <main onKeyDown={e=>{if(e.key==='Escape')close()}}><button className="orb" aria-label={t('Session activity')} aria-expanded={expanded} style={{left:`min(${layout.x}px, calc(100vw - ${size+bubblePadding}px))`,top:`min(${layout.y}px, calc(100vh - ${size+bubblePadding}px))`,width:size,height:size,fontSize:size*.48}}
    onPointerDown={e=>{if(e.button!==0)return;skipClick.current=false;drag.current={x:e.screenX,y:e.screenY,moving:false};e.currentTarget.setPointerCapture(e.pointerId);void api.drag('start',{x:e.screenX,y:e.screenY})}}
    onPointerMove={e=>{const g=drag.current;if(!g || (!g.moving&&Math.hypot(g.x-e.screenX,g.y-e.screenY)<4))return;g.moving=true;skipClick.current=true;close();void api.drag('move',{x:e.screenX,y:e.screenY})}}
    onPointerUp={e=>{drag.current=undefined;void api.drag('end',{x:e.screenX,y:e.screenY})}} onPointerCancel={e=>{drag.current=undefined;void api.drag('end',{x:e.screenX,y:e.screenY})}} onClick={()=>{if(!skipClick.current){if(expanded)close();else expand(true)}skipClick.current=false}}><Ring sessions={data.sessions}/><b>π</b></button>
    {expanded&&panelReady&&<aside style={{left:layout.panelX,top:layout.panelY,width:layout.width,maxHeight:layout.height}}><header><strong>{t('Session activity')}</strong><button aria-label={t('Bubble settings')} title={t('Bubble settings')} aria-expanded={settings} onClick={()=>configure(!settings)}><SlidersHorizontal size={15}/></button></header>
    {settings&&<section className="settings">{group('Bubble appearance',[['light','Light'],['dark','Dark'],['auto','Automatic']],theme,setTheme)}{group('Bubble size',Object.entries(bubbleSizes).map(([k,v])=>[String(v),k] as const),String(size),v=>resize(Number(v)))}</section>}
    <div className="list">{!data.sessions.length&&<p>{t('No active sessions')}</p>}{data.sessions.map(s=>{const r=s.request,label=t(r?'Waiting for your response':s.status==='working'?'Working':'Ready');return <section key={s.handle} className="row"><div className="title"><span role="img" aria-label={label} title={label}>{r?<MessageCircleMore className="waiting" size={14}/>:s.status==='working'?<LoaderCircle className="spinner" size={12}/>:<Circle className="dot" size={9}/>}</span><span>{s.workspace} / {s.name||t('Untitled conversation')}</span></div>{r&&<div className="request" key={`${s.epoch}:${r.id}`}><b>{r.title}</b>{r.message&&<div>{r.message}</div>}<div className="choices">{r.method==='confirm'||r.method==='select'?<><button disabled={sending} onClick={()=>void respond(s,'cancel')}>{t('Cancel')}</button>{r.method==='confirm'?<button disabled={sending} onClick={()=>void respond(s,'confirm')}>{t('Confirm')}</button>:r.options.map((v,i)=><button key={i} disabled={sending} onClick={()=>void respond(s,i)}>{v}</button>)}</>:<button onClick={()=>void api.restore(s.handle)}>{t('Review in Studio')}</button>}</div></div>}</section>})}</div>{error&&<p role="alert">{error}</p>}<button className="restore" onClick={()=>void api.restore()}><PanelsTopLeft size={15}/>{t('Return to Studio')}<span>↗</span></button></aside>}</main>
}
createRoot(document.getElementById('root')!).render(<Bubble/>)
