import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Zap, ArrowRight, Terminal, Globe, Shield, Layers, CheckCircle } from 'lucide-react'
import { api } from '../lib/api.ts'
import { useAuth } from '../components/Auth.tsx'

const TYPED_STRINGS = [
  'Stripe API',
  'GitHub API',
  'Notion API',
  'Shopify API',
  'your REST API',
]

const STEPS = [
  {
    num: '01',
    title: 'Paste your API URL',
    desc: 'Drop in your OpenAPI spec URL or any REST API base URL. We handle the rest.',
    code: 'https://api.example.com/openapi.json',
  },
  {
    num: '02',
    title: 'Get your MCP server',
    desc: 'We auto-generate tools from every endpoint and host your MCP server instantly.',
    code: 'https://mcphub.io/mcp/abc123/sse',
  },
  {
    num: '03',
    title: 'Connect to Claude',
    desc: 'Add one line to your Claude config. Done — Claude can now use your entire API.',
    code: '{ "url": "…/mcp/abc123/sse" }',
  },
]

const FEATURES = [
  { icon: Zap, title: 'Zero infrastructure', desc: 'No servers to run. Your MCP endpoint is hosted and always online.' },
  { icon: Globe, title: 'Any REST API', desc: 'OpenAPI, Swagger, or raw base URL — we discover and generate automatically.' },
  { icon: Layers, title: 'Live tool manager', desc: 'Enable/disable individual endpoints. Test tools directly in the dashboard.' },
  { icon: Shield, title: 'Secure by default', desc: 'API keys stored encrypted. Auth forwarded securely to your API.' },
  { icon: Terminal, title: 'Built-in playground', desc: 'Test every MCP tool without Claude. See real API responses instantly.' },
  { icon: CheckCircle, title: 'Real-time logs', desc: 'Watch Claude call your tools live. Debug and monitor every request.' },
]

export default function LandingPage() {
  const [stats, setStats] = useState<{ apps: number; tools: number } | null>(null)
  const [typeIdx, setTypeIdx] = useState(0)
  const [typeChar, setTypeChar] = useState(0)
  const [deleting, setDeleting] = useState(false)

  const { user } = useAuth()

  // Stats are per-account; fetching them signed-out would 401 and bounce visitors to the login page.
  useEffect(() => {
    if (user) api.stats.get().then(setStats).catch(() => {})
  }, [user])

  useEffect(() => {
    const target = TYPED_STRINGS[typeIdx]
    if (!deleting && typeChar < target.length) {
      const t = setTimeout(() => setTypeChar(c => c + 1), 55)
      return () => clearTimeout(t)
    }
    if (!deleting && typeChar === target.length) {
      const t = setTimeout(() => setDeleting(true), 1800)
      return () => clearTimeout(t)
    }
    if (deleting && typeChar > 0) {
      const t = setTimeout(() => setTypeChar(c => c - 1), 30)
      return () => clearTimeout(t)
    }
    if (deleting && typeChar === 0) {
      setDeleting(false)
      setTypeIdx(i => (i + 1) % TYPED_STRINGS.length)
    }
  }, [typeChar, deleting, typeIdx])

  const currentText = TYPED_STRINGS[typeIdx].slice(0, typeChar)

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Nav */}
      <nav className="border-b border-gray-900 sticky top-0 z-40 bg-gray-950/80 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-6">
          <Link to="/" className="flex items-center gap-2 font-bold text-lg">
            <Zap className="w-5 h-5 text-brand-400" />
            MCPHub
          </Link>
          <span className="text-xs bg-brand-900 text-brand-300 border border-brand-800 px-2 py-0.5 rounded-full font-medium">
            Beta
          </span>
          <div className="ml-auto flex items-center gap-3">
            <Link to="/dashboard" className="text-sm text-gray-400 hover:text-white transition-colors">
              Dashboard
            </Link>
            <Link
              to="/apps/new"
              className="flex items-center gap-1.5 bg-brand-600 hover:bg-brand-500 text-white px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
            >
              Get started <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-brand-950/50 via-gray-950 to-purple-950/30 pointer-events-none" />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-brand-600/10 blur-[120px] rounded-full pointer-events-none" />

        <div className="relative max-w-4xl mx-auto px-4 pt-24 pb-20 text-center">
          <div className="inline-flex items-center gap-2 bg-brand-950 border border-brand-800 text-brand-300 text-xs px-3 py-1.5 rounded-full mb-6 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse" />
            Model Context Protocol · Open Standard by Anthropic
          </div>

          <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight mb-6 leading-tight">
            Make{' '}
            <span className="relative inline-block">
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-400 to-purple-400">
                {currentText}
                <span className="animate-blink text-brand-400">|</span>
              </span>
            </span>
            <br />
            AI-ready in 60 seconds
          </h1>

          <p className="text-lg text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            MCPHub turns any REST API into a hosted MCP server — instantly.
            No code. No infrastructure. Just paste your API URL and start talking to it with Claude.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              to="/apps/new"
              className="flex items-center gap-2 bg-brand-600 hover:bg-brand-500 text-white px-7 py-3 rounded-xl font-semibold text-base transition-all hover:scale-105 shadow-lg shadow-brand-900/50"
            >
              <Zap className="w-5 h-5" />
              Connect your first API
            </Link>
            <Link
              to="/dashboard"
              className="flex items-center gap-2 text-gray-300 hover:text-white px-5 py-3 rounded-xl border border-gray-800 hover:border-gray-700 text-base transition-colors"
            >
              View dashboard <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          {stats && (
            <div className="flex items-center justify-center gap-8 mt-12 text-sm text-gray-500">
              <div className="text-center">
                <p className="text-2xl font-bold text-white">{stats.apps}</p>
                <p>APIs connected</p>
              </div>
              <div className="w-px h-8 bg-gray-800" />
              <div className="text-center">
                <p className="text-2xl font-bold text-white">{stats.tools}</p>
                <p>MCP tools generated</p>
              </div>
              <div className="w-px h-8 bg-gray-800" />
              <div className="text-center">
                <p className="text-2xl font-bold text-white">{stats.apps}</p>
                <p>MCP endpoints hosted</p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Config preview */}
      <section className="max-w-2xl mx-auto px-4 pb-16">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden shadow-2xl">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800 bg-gray-950">
            <div className="w-3 h-3 rounded-full bg-red-500/70" />
            <div className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <div className="w-3 h-3 rounded-full bg-green-500/70" />
            <span className="text-xs text-gray-600 ml-2 font-mono">claude_desktop_config.json</span>
          </div>
          <pre className="p-6 text-sm font-mono text-gray-300 leading-relaxed overflow-x-auto">
{`{
  `}<span className="text-gray-500">"mcpServers"</span>{`: {
    `}<span className="text-green-400">"my-stripe-api"</span>{`: {
      `}<span className="text-gray-500">"url"</span>{`: `}<span className="text-brand-300">"https://mcphub.io/mcp/abc123/sse"</span>{`,
      `}<span className="text-gray-500">"transport"</span>{`: `}<span className="text-yellow-300">"sse"</span>{`
    }
  }
}`}
          </pre>
        </div>
      </section>

      {/* Steps */}
      <section className="max-w-6xl mx-auto px-4 pb-24">
        <h2 className="text-3xl font-bold text-center mb-4">From API to MCP in 3 steps</h2>
        <p className="text-gray-400 text-center mb-12">No code, no servers, no configuration headaches.</p>

        <div className="grid md:grid-cols-3 gap-6">
          {STEPS.map(step => (
            <div key={step.num} className="bg-gray-900 border border-gray-800 rounded-2xl p-6 relative overflow-hidden group hover:border-gray-700 transition-colors">
              <div className="absolute -top-4 -right-4 text-8xl font-black text-gray-800/50 select-none group-hover:text-gray-700/50 transition-colors">
                {step.num}
              </div>
              <p className="text-xs font-mono text-brand-400 mb-3">{step.num}</p>
              <h3 className="text-lg font-bold text-white mb-2">{step.title}</h3>
              <p className="text-sm text-gray-400 mb-4 leading-relaxed">{step.desc}</p>
              <div className="bg-gray-950 border border-gray-800 rounded-lg px-3 py-2">
                <code className="text-xs text-brand-300 font-mono break-all">{step.code}</code>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-4 pb-24">
        <h2 className="text-3xl font-bold text-center mb-4">Everything you need</h2>
        <p className="text-gray-400 text-center mb-12">Built for developers who want to ship fast, not maintain infrastructure.</p>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map(f => (
            <div key={f.title} className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition-colors">
              <div className="w-9 h-9 bg-brand-950 rounded-lg flex items-center justify-center mb-3">
                <f.icon className="w-4.5 h-4.5 text-brand-400" />
              </div>
              <h3 className="font-semibold text-white mb-1.5">{f.title}</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-3xl mx-auto px-4 pb-24 text-center">
        <div className="bg-gradient-to-br from-brand-950 to-purple-950/50 border border-brand-800/50 rounded-3xl p-12">
          <h2 className="text-3xl font-bold mb-4">Ready to make your API AI-native?</h2>
          <p className="text-gray-400 mb-8">
            Join developers who are building the future of AI-powered apps with MCPHub.
          </p>
          <Link
            to="/apps/new"
            className="inline-flex items-center gap-2 bg-brand-600 hover:bg-brand-500 text-white px-8 py-3.5 rounded-xl font-semibold text-base transition-all hover:scale-105 shadow-lg shadow-brand-900/50"
          >
            <Zap className="w-5 h-5" />
            Start for free — no signup needed
          </Link>
        </div>
      </section>

      <footer className="border-t border-gray-900 py-8">
        <div className="max-w-6xl mx-auto px-4 flex items-center justify-between text-sm text-gray-600">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-brand-600" />
            MCPHub
          </div>
          <p>Built on the Model Context Protocol by Anthropic</p>
        </div>
      </footer>
    </div>
  )
}
