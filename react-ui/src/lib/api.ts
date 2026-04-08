import { getToken } from './storage'

export type ApiError = { message: string; status?: number }

export const apiRequest = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  const token = getToken()
  const headers = new Headers(options.headers || {})
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(path, { ...options, headers })
  const data = (await res.json().catch(() => ({}))) as any
  if (!res.ok) {
    const msg = String(data?.error || `Request gagal (${res.status})`)
    const err: ApiError = { message: msg, status: res.status }
    throw err
  }
  return data as T
}

export const apiGetBlob = async (path: string): Promise<Blob> => {
  const token = getToken()
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(path, { headers })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as any
    const msg = String(data?.error || `Request gagal (${res.status})`)
    const err: ApiError = { message: msg, status: res.status }
    throw err
  }
  return await res.blob()
}

export const apiGet = <T>(path: string) => apiRequest<T>(path)
export const apiPost = <T>(path: string, payload: unknown) =>
  apiRequest<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
export const apiPostForm = <T>(path: string, form: FormData) => apiRequest<T>(path, { method: 'POST', body: form })
export const apiPatch = <T>(path: string, payload: unknown) =>
  apiRequest<T>(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
export const apiDelete = <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' })
