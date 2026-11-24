import type { SVGProps } from 'react'

export function PinMark({ size = 11, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
      role={props['aria-label'] ? 'img' : undefined} aria-hidden={props['aria-label'] ? undefined : true} {...props}>
      <path d="m9 2 5 5-1.8.2-2.7 2.6-.4 2L4.2 7l2-.4L9 3.8Z M6.5 9.5 2.4 13.6" />
    </svg>
  )
}
