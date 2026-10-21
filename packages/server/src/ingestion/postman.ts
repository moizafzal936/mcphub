import { nanoid } from 'nanoid'
import type { McpTool, ToolParameter } from '../types/index.js'
import { MAX_TOOLS_PER_APP, isValidParamName, sanitizeToolName, validateToolPath } from './toolSchema.js'
import { isSensitiveKey } from '../security/redact.js'
import { addHeaderParams, bodySchemaFromJson } from './curl.js'

export function isPostmanCollection(doc: unknown): boolean {
  const info = (doc as any)?.info
  return !!info && Array.isArray((doc as any).item) && (typeof info._postman_id === 'string' || /postman/i.test(String(info.schema ?? '')))
}

const VAR = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/

/** Converts a Postman v2.x collection into tools. Hosts are ignored: calls always go to the app's base URL. */
export function toolsFromPostman(doc: any, app: { id: string; baseUrl: string; apiKeyHeader: string; apiKeyIn?: 'header' | 'query' }): { tools: McpTool[]; skipped: string[] } {
  const basePath = new URL(app.baseUrl).pathname.replace(/\/+$/, '').split('/').filter(Boolean)
  const tools: McpTool[] = []
  const skipped: string[] = []
  const names = new Set<string>()

  const visit = (items: any[], depth: number) => {
    for (const item of items ?? []) {
      if (tools.length >= MAX_TOOLS_PER_APP || depth > 10) return
      if (Array.isArray(item?.item)) {
        visit(item.item, depth + 1)
        continue
      }
      const req = item?.request
      if (!req) continue
      const label = String(item.name ?? 'request').slice(0, 100)
      const method = String(typeof req === 'string' ? 'GET' : req.method ?? 'GET').toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        skipped.push(`${label} (${method})`)
        continue
      }
      const url = typeof req === 'string' ? req : req.url
      let segments: string[] = Array.isArray(url?.path) ? url.path.map(String) : String(url?.raw ?? url ?? '').replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/^\{\{[^}]+\}\}/, '').split('?')[0].split('/')
      segments = segments.filter(Boolean)
      if (basePath.length && basePath.every((b, i) => segments[i] === b)) segments = segments.slice(basePath.length)

      const params: ToolParameter[] = []
      const used = new Set<string>()
      const templated = segments.map(seg => {
        const name = seg.startsWith(':') ? seg.slice(1) : seg.match(VAR)?.[1]
        if (!name) return seg
        const clean = name.replace(/[^A-Za-z0-9_]/g, '_')
        used.add(clean)
        params.push({ name: clean, in: 'path', description: clean, required: true, schema: { type: 'string' } })
        return `{${clean}}`
      })
      const path = '/' + templated.join('/')
      if (validateToolPath(path)) {
        skipped.push(`${label} (unsupported path)`)
        continue
      }

      for (const q of Array.isArray(url?.query) ? url.query : []) {
        const key = typeof q?.key === 'string' ? q.key : ''
        if (!key || q.disabled || used.has(key)) continue
        if (!isValidParamName(key) || (app.apiKeyIn === 'query' && key.toLowerCase() === app.apiKeyHeader.toLowerCase())) continue
        used.add(key)
        const example = String(q.value ?? '')
        // Tool descriptions are shown to AI clients: never copy a key-like value into one.
        const fallback = isSensitiveKey(key) || /key|appid/i.test(key) ? key : `e.g. ${example}`
        params.push({ name: key, in: 'query', description: String(q.description ?? fallback).slice(0, 200), required: false, schema: { type: /^-?\d+$/.test(example) ? 'integer' : 'string' } })
      }
      const headers: [string, string][] = (Array.isArray(req.header) ? req.header : []).filter((h: any) => h?.key && !h.disabled).map((h: any) => [String(h.key), String(h.value ?? '')])
      addHeaderParams(headers, app.apiKeyHeader, params, used)

      let requestBodySchema: Record<string, unknown> | undefined
      if (req.body?.mode === 'raw' && method !== 'GET' && String(req.body.raw ?? '').trim()) {
        // Unquoted {{vars}} are not valid JSON; treat them as nulls for type inference.
        const raw = String(req.body.raw).replace(/(?<!")\{\{[^}]+\}\}(?!")/g, 'null')
        try {
          requestBodySchema = bodySchemaFromJson(raw, used)
        } catch {
          skipped.push(`${label} (non-JSON body)`)
          continue
        }
      } else if (req.body?.mode && req.body.mode !== 'raw' && method !== 'GET') {
        skipped.push(`${label} (${req.body.mode} body)`)
        continue
      }

      let name = sanitizeToolName(label.replace(/\s+/g, '_')).toLowerCase()
      for (let i = 2; names.has(name); i++) name = `${sanitizeToolName(label).toLowerCase().slice(0, 60)}_${i}`
      names.add(name)
      const description = typeof req.description === 'string' ? req.description : req.description?.content
      tools.push({
        id: nanoid(), appId: app.id, name, method: method as McpTool['method'], path, parameters: params,
        description: String(description || `${label} — ${method} ${path}`).slice(0, 2000),
        ...(requestBodySchema ? { requestBodySchema } : {}), enabled: true,
      })
    }
  }
  visit(doc.item, 0)
  return { tools, skipped }
}
