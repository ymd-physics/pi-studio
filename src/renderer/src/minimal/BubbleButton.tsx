import { PictureInPicture2 } from 'lucide-react'
import { useUiText } from './language'
export function BubbleButton(){
  const t=useUiText(), label=t('Switch to desktop bubble')
  return <button className="icon-button" title={label} aria-label={label} onClick={()=>void window.desktop.enterBubble().catch(e=>window.alert(String(e)))}><PictureInPicture2 size={17}/></button>
}
