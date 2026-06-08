import React from 'react'

type SvgProps = Record<string, any> & {
  children?: React.ReactNode
  style?: any
}

function normalizeStyle(style: any): React.CSSProperties | undefined {
  if (!style) return undefined
  if (Array.isArray(style)) {
    return Object.assign({}, ...style.filter(Boolean))
  }
  return style
}

function omitReactNativeProps(props: SvgProps): SvgProps {
  const { accessibilityLabel, accessible, testID, onPress, ...rest } = props
  if (testID && !rest['data-testid']) rest['data-testid'] = testID
  if (accessibilityLabel && !rest['aria-label']) rest['aria-label'] = accessibilityLabel
  if (onPress) rest.onClick = onPress
  return rest
}

export default function Svg({ children, style, ...props }: SvgProps) {
  return (
    <svg style={normalizeStyle(style)} {...omitReactNativeProps(props)}>
      {children}
    </svg>
  )
}

export function Circle({ children, ...props }: SvgProps) {
  return <circle {...omitReactNativeProps(props)}>{children}</circle>
}

export function G({ children, ...props }: SvgProps) {
  return <g {...omitReactNativeProps(props)}>{children}</g>
}

export function Path({ children, ...props }: SvgProps) {
  return <path {...omitReactNativeProps(props)}>{children}</path>
}

export function Rect({ children, ...props }: SvgProps) {
  return <rect {...omitReactNativeProps(props)}>{children}</rect>
}
