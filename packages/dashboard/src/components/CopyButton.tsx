import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={copy}
      className={`transition-colors ${className}`}
      title="Copy to clipboard"
    >
      {copied
        ? <Check className="w-4 h-4 text-green-400" />
        : <Copy className="w-4 h-4 text-gray-400 hover:text-white" />
      }
    </button>
  )
}
