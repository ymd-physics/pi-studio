import {it,expect,vi} from 'vitest'
import {HiddenStream} from './hidden-stream'
import {ActivityTracker} from '../../renderer/src/minimal/activity'
import type {PiRecord} from '../../../packages/shared/desktop'

it.each([true,false])('preserves first-token and stall timings when returning mid-turn: %s', mid=>{
  let now=10000
  const clock=vi.spyOn(Date,'now').mockImplementation(()=>now)
  try {
    const tracker=new ActivityTracker(()=>now), received:PiRecord[]=[]
    const gate=new HiddenStream(e=>{received.push(e);tracker.handle(e,false)},()=>now)
    const push=(type:string,fields={})=>gate.push({type,desktopSession:'s',...fields})
    gate.pause();push('agent_start');push('turn_start');push('message_start',{message:{role:'assistant',timestamp:1,content:[]}})
    for(const at of [10400,10410,11800,11810]) {now=at;push('message_update',{assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'x'}})}
    if(mid)gate.resume()
    now=12000;push('message_end',{message:{role:'assistant',timestamp:1,content:[{type:'text',text:'xxxx'}]}});push('turn_end');push('agent_settled');gate.resume()
    expect(received.filter(e=>e.type==='message_update').map(e=>e.assistantMessageEvent.delta)).toEqual(['xx','xx'])
    expect(tracker.view().completed['assistant:1']).toMatchObject({ttftMs:400,stallCount:1,stallMs:1390})
  }finally{clock.mockRestore()}
})
