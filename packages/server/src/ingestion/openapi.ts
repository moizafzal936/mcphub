import yaml from 'js-yaml'
import { nanoid } from 'nanoid'
import type { McpTool } from '../types/index.js'
import { safeRequest } from '../security/ssrf.js'
import { MAX_TOOLS_PER_APP, sanitizeParameters, sanitizeToolName, validateToolPath } from './toolSchema.js'

type HttpMethod = McpTool['method']
const SUPPORTED_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

const MAX_SPEC_BYTES = 10 * 1024 * 1024
const MAX_REF_DEPTH = 32
const MAX_RESOLVED_NODES = 200_000

export class SpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpecError'
  }
}

export async function parseOpenApiSpec(specUrl: string, appId: string, credentialHeader = 'Authorization'): Promise<McpTool[]> {
  const raw = await fetchSpec(specUrl)
  return parseSpecDocument(raw, appId, credentialHeader)
}

export function parseSpecDocument(raw: unknown, appId: string, credentialHeader = 'Authorization'): McpTool[] {
  if (!raw || typeof raw !== 'object') throw new SpecError('Spec is not a JSON/YAML object')
  const spec = resolveRefs(raw, raw)
  const paths: Record<string, any> = spec?.paths && typeof spec.paths === 'object' ? spec.paths : {}
  const tools: McpTool[] = []
  const usedNames = new Set<string>()

  for (const [routePath, pathItem] of Object.entries<any>(paths)) {
    if (!pathItem || typeof pathItem !== 'object' || validateToolPath(routePath)) continue
    for (const method of SUPPORTED_METHODS) {
      const operation = pathItem[method.toLowerCase()]
      if (!operation || typeof operation !== 'object') continue
      if (tools.length >= MAX_TOOLS_PER_APP) return tools

      let name = operationName(method, routePath, operation.operationId)
      if (usedNames.has(name)) {
        let i = 2
        while (usedNames.has(`${name.slice(0, 60)}_${i}`)) i++
        name = `${name.slice(0, 60)}_${i}`
      }
      usedNames.add(name)

      const description =
        [operation.summary, operation.description].filter(s => typeof s === 'string').join(' — ').slice(0, 2000) ||
        `${method} ${routePath}`

      const declared = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
      const { params } = sanitizeParameters(declared.filter((p: any) => ['query', 'path', 'header'].includes(p?.in)), credentialHeader)

      tools.push({
        id: nanoid(),
        appId,
        name,
        description,
        method,
        path: routePath,
        parameters: params,
        requestBodySchema: extractBodySchema(operation.requestBody),
        enabled: true,
      })
    }
  }
  return tools
}

/** Parses spec text (JSON or YAML) pasted or uploaded by the user. */
export function parseSpecText(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_SPEC_BYTES) throw new SpecError('Spec is larger than 10 MB')
  try {
    return JSON.parse(text)
  } catch {
    try {
      return yaml.load(text, { json: true })
    } catch {
      throw new SpecError('Spec is neither valid JSON nor YAML')
    }
  }
}

async function fetchSpec(url: string): Promise<unknown> {
  const res = await safeRequest({
    method: 'GET',
    url,
    headers: { Accept: 'application/json, application/yaml, text/yaml, */*' },
    timeout: 15_000,
    maxContentLength: MAX_SPEC_BYTES,
    redirects: 'any',
    maxRedirects: 5,
  })
  if (res.status < 200 || res.status >= 300) throw new SpecError(`Spec URL returned HTTP ${res.status}`)
  const text = String(res.data ?? '')
  try {
    return JSON.parse(text)
  } catch {
    try {
      return yaml.load(text, { json: true })
    } catch {
      throw new SpecError('Spec is neither valid JSON nor YAML')
    }
  }
}

// Inline local $refs with a depth limit, cycle detection and a total node budget so a hostile
// spec (self-referencing or exponentially aliased) cannot hang or exhaust the server.
function resolveRefs(root: any, node: any): any {
  let budget = MAX_RESOLVED_NODES
  const walk = (value: any, depth: number, stack: string[]): any => {
    if (--budget < 0) throw new SpecError('Spec is too large or too deeply nested to import')
    if (value === null || typeof value !== 'object') return value
    if (depth > MAX_REF_DEPTH) return {}
    if (Array.isArray(value)) return value.map(v => walk(v, depth + 1, stack))
    if (typeof value.$ref === 'string') {
      const ref: string = value.$ref
      if (!ref.startsWith('#/') || stack.includes(ref)) return {}
      let target: any = root
      for (const part of ref.slice(2).split('/').map(p => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'))) {
        target = target?.[part]
      }
      return walk(target, depth + 1, [...stack, ref])
    }
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, depth + 1, stack)
    return out
  }
  return walk(node, 0, [])
}

function operationName(method: string, path: string, operationId?: unknown): string {
  if (typeof operationId === 'string' && operationId.trim()) return sanitizeToolName(operationId).toLowerCase()
  const parts = path.split('/').filter(Boolean).map(p => (p.startsWith('{') ? p.slice(1, -1) : p))
  return sanitizeToolName(`${method.toLowerCase()}_${parts.join('_')}`)
}

function extractBodySchema(requestBody: any): Record<string, unknown> | undefined {
  if (!requestBody || typeof requestBody !== 'object') return undefined
  const content = requestBody.content ?? {}
  const schema = (content['application/json'] ?? content['*/*'])?.schema
  return schema && typeof schema === 'object' ? schema : undefined
}
