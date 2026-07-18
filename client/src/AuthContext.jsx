import { createContext, useContext, useState, useCallback } from 'react';
import { api } from './api';

// Token in localStorage keeps the demo simple. Documented tradeoff in the README:
// production systems should prefer httpOnly cookies to reduce XSS token theft risk.
const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('user'));
    } catch {
      return null;
    }
  });

  const login = useCallback(async (email, password) => {
    const data = await api('/auth/login', { method: 'POST', body: { email, password } });
    setToken(data.token);
    setUser(data.user);
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  }, []);

  // Wraps api() so an expired JWT logs the user out instead of erroring silently.
  const authedApi = useCallback(
    async (path, opts = {}) => {
      try {
        return await api(path, { ...opts, token });
      } catch (e) {
        if (e.status === 401) logout();
        throw e;
      }
    },
    [token, logout]
  );

  return <AuthCtx.Provider value={{ token, user, login, logout, api: authedApi }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
