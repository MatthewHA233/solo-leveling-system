import type { CSSProperties, ReactNode } from 'react'

type SvgProps = {
  width?: number | string
  height?: number | string
  viewBox?: string
  children?: ReactNode
  style?: CSSProperties
}

type PathProps = {
  d?: string
  fill?: string
  stroke?: string
  strokeWidth?: number
  strokeLinecap?: 'butt' | 'round' | 'square'
  strokeLinejoin?: 'round' | 'miter' | 'bevel'
  opacity?: number
}

export function Path(props: PathProps) {
  return <path {...props} />
}

export function Circle(props: Record<string, unknown>) {
  return <circle {...props} />
}

export function Rect(props: Record<string, unknown>) {
  return <rect {...props} />
}

export function G({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) {
  return <g {...props}>{children}</g>
}

export default function Svg({ children, ...props }: SvgProps) {
  return <svg {...props}>{children}</svg>
}
