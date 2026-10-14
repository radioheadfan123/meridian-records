import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { api, download as rawDownload } from './api';

// The access token lives only in memory and expires in 15 minutes. The session itself is
// an httpOnly refresh cookie the server sets at login, which page JavaScript can't read,
// so an XSS bug can't lift a long-lived token out of storage. A reload restores the
// session by trading that cookie for a new access token.
const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const tokenRef = useRef(null);

  const apply = useCallback((data) => {
    tokenRef.current = data?.token ?? null;
    setToken(tokenRef.current);
    setUser(data?.user ?? null);
  }, []);

  // One refresh in flight at a time, however many requests hit a 401 together.
  const refreshing = useRef(null);
  const refresh = useCallback(() => {
    refreshing.current ||= api('/auth/refresh', { method: 'POST' })
      .then((data) => (apply(data), data.token))
      .catch(() => (apply(null), null))
      .finally(() => (refreshing.current = null));
    return refreshing.current;
  }, [apply]);

  useEffect(() => {
    // Sessions from before cookies kept the JWT in localStorage; don't leave it behind.
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    refresh().finally(() => setReady(true));
  }, [refresh]);

  const login = useCallback(
    async (email, password) => apply(await api('/auth/login', { method: 'POST', body: { email, password } })),
    [apply]
  );

  // Wait for the server to clear the cookie before showing the login page: a reload or a
  // closed tab would otherwise cancel the request and leave the 8-hour session on this browser.
  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    apply(null);
  }, [apply]);

  // An expired access token is renewed once from the cookie and the request retried;
  // only if that fails too does the user land back on the login page.
  const withRetry = useCallback(
    async (call) => {
      try {
        return await call(tokenRef.current);
      } catch (e) {
        if (e.status !== 401) throw e;
        const fresh = await refresh();
        if (!fresh) throw e;
        return call(fresh);
      }
    },
    [refresh]
  );

  const authedApi = useCallback((path, opts = {}) => withRetry((t) => api(path, { ...opts, token: t })), [withRetry]);
  const download = useCallback((path, opts) => withRetry((t) => rawDownload(path, { ...opts, token: t })), [withRetry]);

  if (!ready) return null;
  return (
    <AuthCtx.Provider value={{ token, user, login, logout, api: authedApi, download }}>{children}</AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
