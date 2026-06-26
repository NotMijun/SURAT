import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { ToastProvider } from './components/ToastHost'
import LoadingScreen from './components/LoadingScreen'

const LoginPage = lazy(() => import('./pages/Login'))
const Shell = lazy(() => import('./pages/Shell'))

export default function App() {
  return (
    <ToastProvider>
      <Suspense fallback={<LoadingScreen mode="overlay" label="Loading..." />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/*" element={<Shell />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ToastProvider>
  )
}
