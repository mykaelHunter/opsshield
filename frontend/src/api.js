const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Access token lives in memory (a module-level variable), not localStorage —
// keeps it out of reach of any XSS payload that can read localStorage/DOM
// storage. It's lost on a hard refresh by design; refreshToken (below) is
// what recovers the session without asking the user to log in again.
let accessToken = null;

// Refresh token is more sensitive (7-day lifetime vs. the access token's
// short one) and ideally would live in an httpOnly cookie the backend sets
// directly — but the current API returns both tokens in the JSON body, so
// there's no cookie to rely on. localStorage is the pragmatic choice that
// matches what the backend actually does today; revisit if auth.js ever
// moves to httpOnly cookies for the refresh token specifically.
function getRefreshToken() {
  return localStorage.getItem('refreshToken');
}
function setRefreshToken(token) {
  if (token) localStorage.setItem('refreshToken', token);
  else localStorage.removeItem('refreshToken');
}

function setAccessToken(token) {
  accessToken = token;
}

async function request(path, { method = 'GET', body, skipAuth = false, _retried = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!skipAuth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Access token expired mid-session — try exactly once to refresh and
  // replay the original request, rather than bouncing the user to the
  // login screen for something that's recoverable.
  if (res.status === 401 && !skipAuth && !_retried && getRefreshToken()) {
    const refreshed = await tryRefresh();
    if (refreshed) return request(path, { method, body, skipAuth, _retried: true });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function tryRefresh() {
  try {
    const data = await request('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: getRefreshToken() },
      skipAuth: true,
    });
    setAccessToken(data.accessToken);
    setRefreshToken(data.refreshToken);
    return true;
  } catch {
    setAccessToken(null);
    setRefreshToken(null);
    return false;
  }
}

export const api = {
  async register({ email, password, firstName, lastName, orgName }) {
    const data = await request('/api/auth/register', {
      method: 'POST',
      body: { email, password, firstName, lastName, orgName },
      skipAuth: true,
    });
    setAccessToken(data.accessToken);
    setRefreshToken(data.refreshToken);
    return data;
  },

  async login({ email, password }) {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: { email, password },
      skipAuth: true,
    });
    setAccessToken(data.accessToken);
    setRefreshToken(data.refreshToken);
    return data;
  },

  async logout() {
    try {
      await request('/api/auth/logout', { method: 'POST', body: { refreshToken: getRefreshToken() } });
    } finally {
      setAccessToken(null);
      setRefreshToken(null);
    }
  },

  me: () => request('/api/auth/me'),

  forgotPassword: (email) => request('/api/auth/forgot-password', { method: 'POST', body: { email }, skipAuth: true }),
  resetPassword: (token, password) => request('/api/auth/reset-password', { method: 'POST', body: { token, password }, skipAuth: true }),

  // Tasks
  listTasks: (orgId) => request(`/api/tasks/org/${orgId}`),
  getTask: (orgId, taskId) => request(`/api/tasks/org/${orgId}/${taskId}`),
  createTask: (orgId, task) => request(`/api/tasks/org/${orgId}`, { method: 'POST', body: task }),
  updateTask: (orgId, taskId, patch) => request(`/api/tasks/org/${orgId}/${taskId}`, { method: 'PATCH', body: patch }),
  deleteTask: (orgId, taskId) => request(`/api/tasks/org/${orgId}/${taskId}`, { method: 'DELETE' }),
  approveTask: (orgId, taskId) => request(`/api/tasks/org/${orgId}/${taskId}/approve`, { method: 'POST' }),
  rejectTask: (orgId, taskId) => request(`/api/tasks/org/${orgId}/${taskId}/reject`, { method: 'POST' }),

  // Members
  inviteMember: (orgId, invite) => request(`/api/members/org/${orgId}/invite`, { method: 'POST', body: invite }),
  removeMember: (orgId, memberId) => request(`/api/members/org/${orgId}/${memberId}`, { method: 'DELETE' }),
  changeRole: (orgId, memberId, role) => request(`/api/members/org/${orgId}/${memberId}/role`, { method: 'PATCH', body: { role } }),
  acceptInvite: (payload) => request('/api/members/accept-invite', { method: 'POST', body: payload, skipAuth: true }),

  // Billing
  billingHistory: (orgId) => request(`/api/billing/org/${orgId}`),
  initiateBilling: (orgId, plan) => request(`/api/billing/org/${orgId}/initiate`, { method: 'POST', body: { plan } }),

  // Organisation
  getOrg: (orgId) => request(`/api/organisations/${orgId}`),
  deleteOrg: (orgId) => request(`/api/organisations/${orgId}`, { method: 'DELETE' }),

  hasSession: () => Boolean(getRefreshToken()),
  tryRefresh,
};
