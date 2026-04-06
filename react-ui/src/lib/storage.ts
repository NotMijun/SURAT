export const tokenKey = 'logbook-token'
export const themeKey = 'logbook-theme'
export const compactKey = 'logbook-compact'
export const accentKey = 'logbook-accent'

export const getToken = () => localStorage.getItem(tokenKey) || ''
export const setToken = (t: string) => localStorage.setItem(tokenKey, t)
export const clearToken = () => localStorage.removeItem(tokenKey)
