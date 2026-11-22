export type Theme = "light" | "dark"

/**
 * Shared with the blog and the other apps on raffinate.github.io (same origin, same localStorage),
 * so one choice applies everywhere. Only "light" and "dark" are ever stored; no key means "follow the OS".
 * index.html repeats this logic inline to set the theme before first paint.
 */
export const THEME_KEY = "theme"

export const resolveTheme = (stored: unknown, systemDark: boolean): Theme =>
  stored === "light" || stored === "dark" ? stored : systemDark ? "dark" : "light"

const darkQuery = () => matchMedia("(prefers-color-scheme: dark)")

function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_KEY)
  } catch {
    return null
  }
}

export const currentTheme = (): Theme => resolveTheme(readStored(), darkQuery().matches)

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
}

export function chooseTheme(theme: Theme) {
  applyTheme(theme)
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Storage can be blocked; the choice still applies to this page.
  }
}

/** Calls back with the theme whenever another tab changes the shared key, or the OS changes while nothing is saved. */
export function watchTheme(onChange: (theme: Theme) => void): () => void {
  const update = () => onChange(currentTheme())
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY || e.key === null) update()
  }
  const query = darkQuery()
  window.addEventListener("storage", onStorage)
  query.addEventListener("change", update)
  return () => {
    window.removeEventListener("storage", onStorage)
    query.removeEventListener("change", update)
  }
}
