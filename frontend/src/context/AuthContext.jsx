import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [activeOrgId, setActiveOrgId] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (!api.hasSession()) {
        setLoading(false);
        return;
      }
      // We only have a refresh token after a hard refresh (access token
      // lives in memory and is gone) — exchange it for a fresh session
      // before deciding whether the user is actually logged in.
      const refreshed = await api.tryRefresh();
      if (refreshed) {
        try {
          const me = await api.me();
          setUser(me);
          setActiveOrgId(me.organisations?.[0]?.id ?? null);
        } catch {
          // refresh token itself was invalid/expired
        }
      }
      setLoading(false);
    })();
  }, []);

  async function login(credentials) {
    await api.login(credentials);
    const me = await api.me();
    setUser(me);
    setActiveOrgId(me.organisations?.[0]?.id ?? null);
  }

  async function register(payload) {
    await api.register(payload);
    const me = await api.me();
    setUser(me);
    setActiveOrgId(me.organisations?.[0]?.id ?? null);
  }

  async function logout() {
    await api.logout();
    setUser(null);
    setActiveOrgId(null);
  }

  const activeOrg = user?.organisations?.find((o) => o.id === activeOrgId) ?? null;

  return (
    <AuthContext.Provider
      value={{ user, loading, login, register, logout, activeOrgId, setActiveOrgId, activeOrg }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
