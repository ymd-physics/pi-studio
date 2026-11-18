import { useUiText } from './language'
import { useEffect, useRef, useState } from 'react'

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
function saved(key: string) {
  try {
    const n = Number(localStorage.getItem(key))
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}
export function usePanelWidths(sidebar: boolean, files: boolean) {
  const [viewport, setViewport] = useState(window.innerWidth)
  const [leftWanted, setLeftWanted] = useState(() => saved('pi.desktop.sidebarWidth'))
  const [rightWanted, setRightWanted] = useState(() => saved('pi.desktop.filesWidth'))
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const leftMin = viewport <= 760 ? 190 : viewport <= 1000 ? 215 : 250
  const rightMin = viewport <= 1000 ? 390 : 360
  const leftMax = Math.max(leftMin, viewport - (files ? rightMin : 48))
  const left = clamp(leftWanted || leftMin, leftMin, leftMax)
  const rightMax = Math.max(rightMin, viewport - (sidebar ? left : 0))
  const right = clamp(rightWanted || rightMin, rightMin, rightMax)
  const setLeft = (value: number) => {
    const n = clamp(value, leftMin, leftMax)
    setLeftWanted(n)
    try {
      localStorage.setItem('pi.desktop.sidebarWidth', String(n))
    } catch {
      /* optional preference */
    }
  }
  const setRight = (value: number) => {
    const n = clamp(value, rightMin, rightMax)
    setRightWanted(n)
    try {
      localStorage.setItem('pi.desktop.filesWidth', String(n))
    } catch {
      /* optional preference */
    }
  }
  return { left, right, leftMin, rightMin, leftMax, rightMax, setLeft, setRight }
}

export function ResizeEdge({
  side,
  value,
  min,
  max,
  change,
}: {
  side: 'left' | 'right'
  value: number
  min: number
  max: number
  change: (width: number) => void
}) {
  const t = useUiText()
  const drag = useRef<{ x: number; value: number }>()
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (!dragging) return
    document.body.classList.add('resizing-panels')
    return () => document.body.classList.remove('resizing-panels')
  }, [dragging])
  return (
    <div
      className={`resize-edge resize-${side}`}
      role="separator"
      aria-label={side === 'left' ? t('Resize workspace sidebar') : t('Resize file panel')}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        drag.current = { x: e.clientX, value }
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (drag.current)
          change(
            clamp(drag.current.value + (e.clientX - drag.current.x) * (side === 'left' ? 1 : -1), min, max),
          )
      }}
      onPointerUp={(e) => {
        drag.current = undefined
        setDragging(false)
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
      }}
      onPointerCancel={() => {
        drag.current = undefined
        setDragging(false)
      }}
      onLostPointerCapture={() => {
        drag.current = undefined
        setDragging(false)
      }}
      onDoubleClick={() => change(min)}
      onKeyDown={(e) => {
        if (e.key === 'Home') {
          e.preventDefault()
          change(min)
        } else if (e.key === 'End') {
          e.preventDefault()
          change(max)
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          change(clamp(value + (e.key === 'ArrowRight' ? 20 : -20) * (side === 'left' ? 1 : -1), min, max))
        }
      }}
    />
  )
}
