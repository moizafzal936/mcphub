import { useState } from 'react'
import { ChevronDown, ChevronUp, Info } from 'lucide-react'
import type { Readiness, ReadinessIssue } from '../lib/api.ts'

const GRADE = {
  great: { label: 'Great', ring: 'border-green-500 text-green-300', text: 'text-green-400' },
  good: { label: 'Good', ring: 'border-amber-500 text-amber-300', text: 'text-amber-400' },
  'needs-work': { label: 'Needs work', ring: 'border-red-500 text-red-300', text: 'text-red-400' },
}

const DOT = { high: 'bg-red-400', medium: 'bg-amber-400', low: 'bg-gray-400', info: 'bg-brand-400' }

/** How well AI clients will understand this app's tools, with the tools behind each suggestion. */
export function ReadinessCard({ readiness, onFocus }: { readiness: Readiness; onFocus: (issue: ReadinessIssue) => void }) {
  const fixes = readiness.issues.filter(i => i.severity !== 'info')
  const [open, setOpen] = useState(readiness.grade !== 'great')
  const grade = GRADE[readiness.grade]

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl mb-4">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 px-4 py-3 text-left" aria-expanded={open}>
        <span className={`w-11 h-11 flex-shrink-0 rounded-full border-2 flex items-center justify-center text-sm font-bold ${grade.ring}`}>
          {readiness.score}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-semibold text-white">
            AI readiness · <span className={grade.text}>{grade.label}</span>
          </span>
          <span className="block text-xs text-gray-500">
            {fixes.length
              ? `${fixes.length} suggestion${fixes.length === 1 ? '' : 's'} to help AI clients pick and call the right tool`
              : `AI clients get ${readiness.exposed} clearly described tool${readiness.exposed === 1 ? '' : 's'}`}
          </span>
        </span>
        {readiness.issues.length > 0 && (open ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />)}
      </button>
      {open && readiness.issues.length > 0 && (
        <ul className="border-t border-gray-800 divide-y divide-gray-800">
          {readiness.issues.map(issue => (
            <li key={issue.id} className="px-4 py-3 flex gap-3">
              {issue.severity === 'info'
                ? <Info className="w-3.5 h-3.5 text-brand-400 flex-shrink-0 mt-0.5" />
                : <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${DOT[issue.severity]}`} aria-label={`${issue.severity} priority`} />}
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-200">{issue.title}</p>
                <p className="text-xs text-gray-500 mt-0.5">{issue.detail}</p>
              </div>
              {issue.tools.length > 0 && (
                <button onClick={() => onFocus(issue)} className="self-start text-xs text-brand-400 hover:text-brand-300 whitespace-nowrap">
                  Show {issue.tools.length === 1 ? 'tool' : `${issue.tools.length} tools`}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
