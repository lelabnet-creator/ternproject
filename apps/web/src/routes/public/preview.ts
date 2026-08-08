import type { PageLayout } from '../app/LayoutScreen'

/**
 * A draft arrangement passed in by the layout editor's preview frame.
 *
 * Read from the URL rather than posted to the server because a preview that
 * saved would not be a preview. Presentation only: it cannot reveal a component
 * the reader could not already see, reorder anything server-side, or persist.
 *
 * `order` is a list of control ids; anything not in it keeps its stored
 * position, so a partial list degrades to "these first".
 *
 * Its own module so the accepted set can be pinned by a test. It was written
 * inline with `custom` missing from the check while the return type named it —
 * a preview of the custom density silently showed the *saved* layout instead,
 * which is the one failure a preview must not have.
 */
export function previewOverrides(search: string): { layout?: PageLayout; order?: string[] } {
  const params = new URLSearchParams(search)
  if (params.get('preview') !== '1') return {}

  const layout = params.get('layout')
  const order = params.get('order')

  return {
    layout: isLayout(layout) ? layout : undefined,
    order: order ? order.split(',').filter(Boolean) : undefined,
  }
}

/**
 * The four densities, checked against the value rather than assumed.
 *
 * A narrowing guard and not a cast: the string arrives from a query parameter,
 * which anyone can type. An unknown value has to fall back to the saved layout,
 * not be handed on as though it were one of these.
 */
function isLayout(value: string | null): value is PageLayout {
  return value === 'list' || value === 'grid' || value === 'compact' || value === 'custom'
}
