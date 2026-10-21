import type { App, McpTool } from '../types/index.js'
import { toolForApp } from './toolSchema.js'

/**
 * Static checks for how well an app's tools will work with AI clients. Models choose tools by
 * name and description and fill arguments from parameter descriptions, so vague or missing text,
 * look-alike tools and very long tool lists are the usual reasons a model calls the wrong tool.
 */

export const MANY_TOOLS = 40
export const TOO_MANY_TOOLS = 100
const MIN_DESCRIPTION = 25
const LONG_DESCRIPTION = 1000

export type Severity = 'high' | 'medium' | 'low' | 'info'

export interface ReadinessIssue {
  id: 'no-tools' | 'weak-descriptions' | 'many-tools' | 'duplicate-descriptions' | 'undocumented-params' | 'long-descriptions' | 'writes-enabled'
  severity: Severity
  title: string
  detail: string
  tools: string[]
}

export interface Readiness {
  score: number
  grade: 'great' | 'good' | 'needs-work'
  exposed: number
  issues: ReadinessIssue[]
}

/** Every argument an AI client fills in: path/query/header parameters plus top-level body fields. */
export function argumentFields(tool: McpTool): { name: string; description: string }[] {
  const fields = tool.parameters.map(p => ({ name: p.name, description: p.description ?? '' }))
  const body = (tool.requestBodySchema as any)?.properties
  if (body && typeof body === 'object') {
    for (const [name, schema] of Object.entries<any>(body)) {
      if (!fields.some(f => f.name === name)) fields.push({ name, description: typeof schema?.description === 'string' ? schema.description : '' })
    }
  }
  return fields
}

// Fallback descriptions written by the importers when the source had none.
const GENERATED = [/^(GET|POST|PUT|PATCH|DELETE)\s+\//i, /\s—\s(GET|POST|PUT|PATCH|DELETE)\s+\//i]

export function isWeakDescription(tool: McpTool): boolean {
  const text = tool.description.trim()
  return text.length < MIN_DESCRIPTION || text.toLowerCase() === tool.name.toLowerCase() || GENERATED.some(re => re.test(text))
}

function isUndocumented(field: { name: string; description: string }): boolean {
  const text = field.description.trim()
  return !text || text.toLowerCase() === field.name.toLowerCase()
}

export function assessReadiness(app: App, allTools: McpTool[]): Readiness {
  // Judge exactly what AI clients receive.
  const tools = allTools
    .filter(t => t.enabled && (!app.readOnly || t.method === 'GET'))
    .map(t => toolForApp(app, t))
  if (!tools.length) {
    return {
      score: 0, grade: 'needs-work', exposed: 0,
      issues: [{
        id: 'no-tools', severity: 'high', title: 'No tools are available to AI clients',
        detail: app.readOnly ? 'Read-only mode hides every tool that is not a GET. Enable a GET tool or turn read-only mode off.' : 'Add or enable at least one tool.',
        tools: [],
      }],
    }
  }

  const issues: ReadinessIssue[] = []
  let penalty = 0
  const share = (n: number) => n / tools.length

  const weak = tools.filter(isWeakDescription).map(t => t.name)
  if (weak.length) {
    // Descriptions matter most: with none, the model has only names and paths to go on.
    penalty += 50 * share(weak.length)
    issues.push({
      id: 'weak-descriptions', severity: share(weak.length) > 0.5 ? 'high' : 'medium',
      title: `${weak.length} tool${weak.length === 1 ? ' has' : 's have'} no real description`,
      detail: 'AI clients pick tools by their description. Say what the tool does, when to use it and what it returns.',
      tools: weak,
    })
  }

  if (tools.length > MANY_TOOLS) {
    penalty += tools.length > TOO_MANY_TOOLS ? 20 : 10
    issues.push({
      id: 'many-tools', severity: tools.length > TOO_MANY_TOOLS ? 'high' : 'medium',
      title: `${tools.length} tools are exposed`,
      detail: `AI clients choose less reliably from long tool lists, and some only load a limited number. Keep it under ${MANY_TOOLS} by disabling tools you don't need.`,
      tools: [],
    })
  }

  const byText = new Map<string, string[]>()
  for (const t of tools) {
    const key = t.description.trim().toLowerCase().replace(/\s+/g, ' ')
    if (key.length >= MIN_DESCRIPTION) byText.set(key, [...(byText.get(key) ?? []), t.name])
  }
  const duplicated = [...byText.values()].filter(names => names.length > 1).flat()
  if (duplicated.length) {
    penalty += 15 * share(duplicated.length)
    issues.push({
      id: 'duplicate-descriptions', severity: 'medium',
      title: `${duplicated.length} tools share a description with another tool`,
      detail: 'When two tools read the same, the model has to guess. Describe what makes each one different.',
      tools: duplicated,
    })
  }

  const undocumented = tools.filter(t => argumentFields(t).some(isUndocumented)).map(t => t.name)
  if (undocumented.length) {
    penalty += 20 * share(undocumented.length)
    issues.push({
      id: 'undocumented-params', severity: 'low',
      title: `${undocumented.length} tool${undocumented.length === 1 ? ' has' : 's have'} parameters without a description`,
      detail: 'Describe the expected format and an example (e.g. "ISO date, 2026-01-31") so the model fills arguments correctly.',
      tools: undocumented,
    })
  }

  const long = tools.filter(t => t.description.length > LONG_DESCRIPTION).map(t => t.name)
  if (long.length) {
    penalty += 5 * share(long.length)
    issues.push({
      id: 'long-descriptions', severity: 'low',
      title: `${long.length} description${long.length === 1 ? ' is' : 's are'} over ${LONG_DESCRIPTION.toLocaleString('en-US')} characters`,
      detail: 'Some clients cut long descriptions. Put the essentials first.',
      tools: long,
    })
  }

  const writes = tools.filter(t => t.method !== 'GET').map(t => t.name)
  if (writes.length) {
    issues.push({
      id: 'writes-enabled', severity: 'info',
      title: `${writes.length} tool${writes.length === 1 ? ' can' : 's can'} change data`,
      detail: 'AI clients ask before calling these, but for demos against real data consider read-only mode (Settings).',
      tools: writes,
    })
  }

  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)))
  return { score, grade: score >= 85 ? 'great' : score >= 60 ? 'good' : 'needs-work', exposed: tools.length, issues }
}
