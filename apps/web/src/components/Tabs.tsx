import { useId, type ReactNode } from 'react'

/**
 * A tab strip, with the keyboard behaviour tabs are supposed to have.
 *
 * Written once because the alternative is what the admin had: panels stacked
 * down a page, where two blocks of settings that are alternatives to each other
 * read as a checklist to work through. Tabs say "one of these", stacking says
 * "all of these".
 *
 * Arrow keys move between tabs and Home/End jump to the ends, per the ARIA
 * pattern — a tab strip you can only reach with repeated Tab presses is a tab
 * strip that keyboard users route around.
 */
export interface TabDefinition {
  id: string
  label: string
  /** Optional count or state, shown after the label. */
  badge?: string
}

export function Tabs({
  tabs,
  active,
  onChange,
  label,
  children,
}: {
  tabs: TabDefinition[]
  active: string
  onChange: (id: string) => void
  /** Names the strip for anyone who cannot see it. */
  label: string
  children: ReactNode
}) {
  const base = useId()

  const move = (delta: number) => {
    const index = tabs.findIndex((tab) => tab.id === active)
    const next = tabs[(index + delta + tabs.length) % tabs.length]
    if (next) {
      onChange(next.id)
      document.getElementById(`${base}-tab-${next.id}`)?.focus()
    }
  }

  return (
    <div>
      <div role="tablist" aria-label={label} className="tabs">
        {tabs.map((tab) => {
          const selected = tab.id === active
          return (
            <button
              key={tab.id}
              id={`${base}-tab-${tab.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${base}-panel-${tab.id}`}
              // Only the selected tab is in the tab order; the arrows do the
              // rest. That is the pattern, and it keeps a ten-tab strip from
              // costing ten Tab presses to walk past.
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight') move(1)
                else if (event.key === 'ArrowLeft') move(-1)
                else if (event.key === 'Home') {
                  onChange(tabs[0]!.id)
                } else if (event.key === 'End') {
                  onChange(tabs[tabs.length - 1]!.id)
                } else return
                event.preventDefault()
              }}
              className={selected ? 'tab is-selected' : 'tab'}
            >
              {tab.label}
              {tab.badge && <span className="tab-badge">{tab.badge}</span>}
            </button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        id={`${base}-panel-${active}`}
        aria-labelledby={`${base}-tab-${active}`}
        tabIndex={0}
        style={{ paddingTop: 'var(--space-4)' }}
      >
        {children}
      </div>
    </div>
  )
}
