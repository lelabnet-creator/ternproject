import { useEffect, useRef, useState } from 'react'

/**
 * Measures an element so charts can size themselves to their container.
 *
 * Charts size from a measured width rather than a viewport breakpoint, because
 * the same component sits in a full-width card on the public page and in a
 * narrow preview pane in the indicator editor. A breakpoint would be right in
 * one of those places and wrong in the other.
 */
export function useResizeObserver<T extends Element>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      // Rounded to whole pixels and compared before setting: sub-pixel churn
      // from a flex container would otherwise re-render the chart every frame
      // during a resize.
      setSize((current) => {
        const next = { width: Math.round(width), height: Math.round(height) }
        return current.width === next.width && current.height === next.height ? current : next
      })
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return { ref, width: size.width, height: size.height }
}
