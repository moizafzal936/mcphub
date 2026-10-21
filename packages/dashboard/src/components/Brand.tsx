import { useEffect, useState } from 'react'
import { Moon, Plug, Sun } from 'lucide-react'

type Theme = 'light' | 'dark'
const KEY = 'mcphub-theme'

function storedTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** Applies the saved theme before the first render, so there is no flash of the wrong one. */
export function applyStoredTheme(): void {
  document.documentElement.dataset.theme = storedTheme()
}

/** The plug mark: MCPHub plugs your API into AI clients. */
export function LogoMark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const box = { sm: 'w-6 h-6 rounded-md', md: 'w-7 h-7 rounded-lg', lg: 'w-9 h-9 rounded-xl' }[size]
  const icon = { sm: 'w-3.5 h-3.5', md: 'w-4 h-4', lg: 'w-5 h-5' }[size]
  return (
    <span className={`${box} bg-brand-600 text-onaccent inline-flex items-center justify-center flex-shrink-0`} aria-hidden="true">
      <Plug className={`${icon} rotate-45`} strokeWidth={2.25} />
    </span>
  )
}

export function Logo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const text = { sm: 'text-sm', md: 'text-base', lg: 'text-lg' }[size]
  return (
    <span className={`inline-flex items-center gap-2 font-bold tracking-tight text-white ${text}`}>
      <LogoMark size={size} />
      MCPHub
    </span>
  )
}

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(storedTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(KEY, theme)
    } catch {}
  }, [theme])
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button" onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}
      className={`text-gray-500 hover:text-white transition-colors p-1 ${className}`}
    >
      {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  )
}
