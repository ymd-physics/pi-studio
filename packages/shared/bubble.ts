export const bubblePadding = 16 // transparent gutter for the edge and soft cast shadow
export const bubbleSizes = { Small: 68, Standard: 84, Large: 100 } as const
export function savedBubbleSize(tier: string | null, previous: string | null, legacy: string | null): number {
  if (tier === 'Small' || tier === 'Standard' || tier === 'Large') return bubbleSizes[tier]
  // Former Large is now Standard; users who chose Small keep the compact tier.
  return (previous === '54' || (!previous && legacy === '42')) ? bubbleSizes.Small : bubbleSizes.Standard
}
export interface BubbleSession {
  handle: string
  epoch: number
  workspace: string
  name: string
  status: 'active' | 'working'
  request?: { id: string; method: string; title: string; message: string; options: string[] }
}
export interface BubbleState { language: 'en' | 'zh-CN'; sessions: BubbleSession[] }
export interface BubbleLayout { x: number; y: number; panelX: number; panelY: number; width: number; height: number }
export type BubbleChoice = {handle: string; epoch: number; id: string; choice: 'cancel' | 'confirm' | number}
export interface BubbleAPI {
  position(fn:(layout:BubbleLayout)=>void):()=>void
  hit(interactive:boolean):Promise<void>
  state(): Promise<BubbleState>
  layout(size: number, expanded: boolean): Promise<BubbleLayout>
  drag(phase: 'start'|'move'|'end', point: {x:number;y:number}): Promise<void>
  restore(handle?: string): Promise<void>
  answer(choice: BubbleChoice): Promise<void>
  changed(fn: () => void): () => void
  dismissed(fn: () => void): () => void
}
declare global { interface Window { bubble: BubbleAPI } }
