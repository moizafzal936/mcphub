// Mirrors the server's projectResponse (packages/server/src/ingestion/toolSchema.ts) for live previews.

const FIELD_SEGMENT = /^[A-Za-z0-9_$@-]{1,64}$/
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export function isValidFieldPath(path: string): boolean {
  const parts = path.split('.')
  return path.length <= 256 && parts.length <= 10 && parts.every(p => FIELD_SEGMENT.test(p) && !UNSAFE_KEYS.has(p))
}

interface Trie { leaf: boolean; children: Map<string, Trie> }

function pick(value: unknown, node: Trie): unknown {
  if (node.leaf) return value
  if (Array.isArray(value)) return value.map(v => pick(v, node))
  if (!value || typeof value !== 'object') return undefined
  const out: Record<string, unknown> = {}
  for (const [key, child] of node.children) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const picked = pick((value as Record<string, unknown>)[key], child)
    if (picked !== undefined) out[key] = picked
  }
  return out
}

function isEmptyShape(value: unknown): boolean {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.every(isEmptyShape)
  return !!value && typeof value === 'object' && Object.keys(value).length === 0
}

export function projectResponse(data: unknown, paths: string[]): unknown {
  const root: Trie = { leaf: false, children: new Map() }
  for (const path of paths) {
    if (!isValidFieldPath(path)) continue
    let node = root
    for (const seg of path.split('.')) {
      let next = node.children.get(seg)
      if (!next) node.children.set(seg, (next = { leaf: false, children: new Map() }))
      node = next
    }
    node.leaf = true
  }
  if (!root.children.size || !data || typeof data !== 'object') return data
  const shaped = pick(data, root)
  return isEmptyShape(shaped) ? data : shaped
}

export interface FieldInfo { path: string; key: string; depth: number; kind: string; sample?: string }

function describe(value: unknown): { kind: string; sample?: string } {
  if (Array.isArray(value)) return { kind: `list of ${value.length}` }
  if (value === null) return { kind: 'null' }
  if (typeof value === 'object') return { kind: 'object' }
  const text = String(value)
  return { kind: typeof value, sample: text.length > 40 ? `${text.slice(0, 40)}…` : text }
}

/** Every selectable field in a response, grouped under its parent; array items are merged. */
export function discoverFields(data: unknown, maxDepth = 4, maxFields = 300): FieldInfo[] {
  const nodes = new Map<string, { info: FieldInfo; children: string[] }>()
  const roots: string[] = []
  const walk = (value: unknown, prefix: string, depth: number) => {
    if (nodes.size >= maxFields || depth >= maxDepth) return
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) walk(item, prefix, depth)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (!isValidFieldPath(path)) continue
      if (!nodes.has(path)) {
        if (nodes.size >= maxFields) return
        nodes.set(path, { info: { path, key, depth, ...describe(child) }, children: [] })
        ;(prefix ? nodes.get(prefix)!.children : roots).push(path)
      }
      walk(child, path, depth + 1)
    }
  }
  walk(data, '', 0)
  const out: FieldInfo[] = []
  const flatten = (paths: string[]) => paths.forEach(p => { out.push(nodes.get(p)!.info); flatten(nodes.get(p)!.children) })
  flatten(roots)
  return out
}

/** Character count with a rough token estimate (about 4 characters per token for JSON). */
export function formatSize(chars: number): string {
  const n = (v: number) => (v < 1000 ? String(Math.round(v)) : `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`)
  return `${n(chars)} chars (~${n(chars / 4)} tokens)`
}
