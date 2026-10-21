import http from 'http'
import https from 'https'
import net from 'net'
import dns from 'dns'
import type { Duplex } from 'stream'
import ipaddr from 'ipaddr.js'
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { getConfig } from '../config.js'

export class SsrfBlockedError extends Error {
  readonly code = 'SSRF_BLOCKED'
  constructor(message: string) {
    super(message)
    this.name = 'SsrfBlockedError'
  }
}

type LookupAll = (hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void) => void

let resolveAll: LookupAll = (hostname, cb) => dns.lookup(hostname, { all: true, verbatim: true }, cb)

export function setResolverForTesting(fn: LookupAll | undefined): void {
  resolveAll = fn ?? ((hostname, cb) => dns.lookup(hostname, { all: true, verbatim: true }, cb))
}

function normalizeIp(ip: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (!ipaddr.isValid(bare)) return undefined
  let addr = ipaddr.parse(bare)
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address()
  }
  return addr
}

// Operator escape hatch for deliberately reaching internal hosts: exact "ip" or "ip:port" entries.
function isExplicitlyAllowed(addr: ipaddr.IPv4 | ipaddr.IPv6, port: number): boolean {
  const ip = addr.toString()
  return getConfig().ssrfAllow.some(entry => {
    const m = entry.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/)
    if (!m) return false
    const allowed = normalizeIp(m[1])
    if (!allowed || allowed.toString() !== ip) return false
    return m[2] === undefined || Number(m[2]) === port
  })
}

export function isAddressAllowed(ip: string, port: number): boolean {
  const addr = normalizeIp(ip)
  if (!addr) return false
  return addr.range() === 'unicast' || isExplicitlyAllowed(addr, port)
}

function blockedMessage(target: string): string {
  return `Destination ${target} resolves to a private, loopback, link-local or reserved address and is blocked`
}

function safeLookupFor(port: number): net.LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void) => {
    resolveAll(hostname, (err, addresses) => {
      if (err) return callback(err)
      if (!addresses?.length) return callback(new Error(`DNS lookup returned no addresses for ${hostname}`))
      const bad = addresses.find(a => !isAddressAllowed(a.address, port))
      if (bad) return callback(new SsrfBlockedError(blockedMessage(`${hostname} (${bad.address})`)))
      const family = options?.family
      const usable = family === 4 || family === 6 ? addresses.filter(a => a.family === family) : addresses
      if (!usable.length) return callback(new Error(`No IPv${family} address for ${hostname}`))
      if (options?.all) return callback(null, usable)
      return callback(null, usable[0].address, usable[0].family)
    })
  }) as net.LookupFunction
}

function guardConnection(options: any): Error | undefined {
  const host: string = String(options.host ?? options.hostname ?? '')
  const port = Number(options.port)
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) {
    if (!isAddressAllowed(host, port)) return new SsrfBlockedError(blockedMessage(host))
  } else {
    options.lookup = safeLookupFor(port)
  }
  return undefined
}

class SafeHttpAgent extends http.Agent {
  createConnection(options: any, cb?: (err: Error | null, socket: Duplex) => void): Duplex | null | undefined {
    const err = guardConnection(options)
    if (err) {
      process.nextTick(() => cb?.(err, undefined as any))
      return undefined
    }
    return super.createConnection(options, cb as any)
  }
}

class SafeHttpsAgent extends https.Agent {
  createConnection(options: any, cb?: (err: Error | null, socket: Duplex) => void): Duplex | null | undefined {
    const err = guardConnection(options)
    if (err) {
      process.nextTick(() => cb?.(err, undefined as any))
      return undefined
    }
    return super.createConnection(options, cb as any)
  }
}

const httpAgent = new SafeHttpAgent()
const httpsAgent = new SafeHttpsAgent()

export function parseOutboundUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SsrfBlockedError('Invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`Only http and https URLs are allowed (got ${url.protocol})`)
  }
  if (url.username || url.password) throw new SsrfBlockedError('URLs with embedded credentials are not allowed')
  if (!url.hostname) throw new SsrfBlockedError('URL has no host')
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && !isAddressAllowed(url.hostname, port)) {
    throw new SsrfBlockedError(blockedMessage(url.hostname))
  }
  return url
}

// Early, user-facing check (e.g. when an app is created). The connect-time guard in the agents
// is what actually enforces the policy, so a later DNS change cannot bypass it.
export async function assertResolvesPublic(raw: string): Promise<void> {
  const url = parseOutboundUrl(raw)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (net.isIP(host)) return
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  const addresses = await new Promise<dns.LookupAddress[]>((resolve, reject) =>
    resolveAll(host, (err, a) => (err ? reject(err) : resolve(a)))
  ).catch(err => {
    throw new SsrfBlockedError(`Could not resolve ${host}: ${err.code ?? err.message}`)
  })
  const bad = addresses.find(a => !isAddressAllowed(a.address, port))
  if (bad) throw new SsrfBlockedError(blockedMessage(`${host} (${bad.address})`))
}

export interface SafeRequestOptions extends Omit<AxiosRequestConfig, 'url' | 'httpAgent' | 'httpsAgent' | 'proxy' | 'maxRedirects'> {
  url: string
  /** 'same-origin' follows only redirects that stay on the original origin; 'any' follows to any allowed host. */
  redirects: 'none' | 'same-origin' | 'any'
  maxRedirects?: number
}

export async function safeRequest(opts: SafeRequestOptions): Promise<AxiosResponse<string>> {
  const { redirects, maxRedirects = 3, url: startUrl, ...rest } = opts
  let current = parseOutboundUrl(startUrl)
  const origin = current.origin
  let method = (rest.method ?? 'GET').toUpperCase()
  let data = rest.data
  let params = rest.params

  for (let hop = 0; ; hop++) {
    const res = await axios.request<string>({
      ...rest,
      method,
      data,
      params,
      url: current.toString(),
      httpAgent,
      httpsAgent,
      proxy: false,
      maxRedirects: 0,
      responseType: 'text',
      transformResponse: d => d,
      validateStatus: () => true,
    })

    const location = res.headers['location']
    const isRedirect = res.status >= 300 && res.status < 400 && typeof location === 'string'
    if (!isRedirect || redirects === 'none' || hop >= maxRedirects) return res

    let target: URL
    try {
      target = new URL(location, current)
    } catch {
      return res
    }
    if (redirects === 'same-origin' && target.origin !== origin) return res
    const next = parseOutboundUrl(target.toString())
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET'
      data = undefined
    }
    params = undefined
    current = next
  }
}
