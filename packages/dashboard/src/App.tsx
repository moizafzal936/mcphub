import { Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom'
import { Zap, LayoutDashboard, Plus, LogOut } from 'lucide-react'
import { ToastProvider } from './components/Toast.tsx'
import { AuthProvider, RequireAuth, useAuth } from './components/Auth.tsx'
import LandingPage from './pages/LandingPage.tsx'
import AppsPage from './pages/AppsPage.tsx'
import AppDetailPage from './pages/AppDetailPage.tsx'
import NewAppPage from './pages/NewAppPage.tsx'
import LoginPage from './pages/LoginPage.tsx'
import ConsentPage from './pages/ConsentPage.tsx'

function DashboardLayout({ children }: { children: React.ReactNode }) {
  const loc = useLocation()
  const navigate = useNavigate()
  const { user, logout } = useAuth()

  return (
    <RequireAuth>
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-gray-800/80 bg-gray-900/50 backdrop-blur sticky top-0 z-30">
          <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-4">
            <Link to="/" className="flex items-center gap-2 font-bold text-white">
              <Zap className="w-4.5 h-4.5 text-brand-400" />
              MCPHub
            </Link>
            <span className="w-px h-4 bg-gray-800" />
            <Link
              to="/dashboard"
              className={`flex items-center gap-1.5 text-sm transition-colors ${
                loc.pathname === '/dashboard' ? 'text-white' : 'text-gray-500 hover:text-white'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              Dashboard
            </Link>
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden sm:inline text-xs text-gray-500 truncate max-w-[180px]">{user?.email}</span>
              <button
                onClick={async () => { await logout(); navigate('/login') }}
                className="text-gray-500 hover:text-white transition-colors p-1"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
              <Link
                to="/apps/new"
                className="flex items-center gap-1.5 bg-brand-600 hover:bg-brand-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                New App
              </Link>
            </div>
          </div>
        </header>
        <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-8">
          {children}
        </main>
      </div>
    </RequireAuth>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/oauth/consent" element={<RequireAuth><ConsentPage /></RequireAuth>} />
          <Route path="/dashboard" element={<DashboardLayout><AppsPage /></DashboardLayout>} />
          <Route path="/apps/new" element={<DashboardLayout><NewAppPage /></DashboardLayout>} />
          <Route path="/apps/:id" element={<DashboardLayout><AppDetailPage /></DashboardLayout>} />
        </Routes>
      </AuthProvider>
    </ToastProvider>
  )
}
