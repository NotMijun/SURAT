import { Navigate, Route, Routes } from 'react-router-dom'
import { ToastProvider } from './components/ToastHost'
import LoginPage from './pages/Login'
import Shell from './pages/Shell'

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/*" element={<Shell />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ToastProvider>
  )
}

