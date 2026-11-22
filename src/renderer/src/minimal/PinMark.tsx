import type { SVGProps } from 'react'

export function PinMark({ size = 11, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth={1.65} strokeLinecap="round" strokeLinejoin="round"
      role={props['aria-label'] ? 'img' : undefined} aria-hidden={props['aria-label'] ? undefined : true} {...props}>
      <circle cx={11.1} cy={4.9} r={3.1} fill="currentColor" />
      <path d="m9.2 7-6.3 6.4" />
    </svg>
  )
}
