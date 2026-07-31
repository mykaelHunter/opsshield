import { useAuth } from '../context/AuthContext';

function CardIcon({ d }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ color: 'var(--ink-800)' }}>
      <path d={d} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Dashboard() {
  const { user, activeOrg } = useAuth();

  if (!activeOrg) {
    return (
      <div className="page">
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600, color: 'var(--text)' }}>No organisation yet</p>
          <p style={{ margin: '0.35rem 0 0' }}>You're not a member of any organisation yet — accept an invite or create one to get started.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>{activeOrg.name}</h1>
      <p className="muted">Signed in as {user.email} · role: {activeOrg.role}</p>
      <div className="card-grid">
        <a className="card" href="/tasks">
          <h3><CardIcon d="M4 6.5h9.5M4 11h9.5M4 15.5h6M17 5l1.8 1.8L22 3.5" />Tasks</h3>
          <p>View and manage tasks, approvals, and assignments</p>
        </a>
        <a className="card" href="/members">
          <h3><CardIcon d="M8 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm7 0a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 18c0-2.8 2.2-5 5-5s5 2.2 5 5M12.5 13c2.8 0 5 2.2 5 5" />Members</h3>
          <p>Invite teammates and manage roles</p>
        </a>
        <a className="card" href="/billing">
          <h3><CardIcon d="M3 8.5h18M5 6h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />Billing</h3>
          <p>View plan and billing history</p>
        </a>
      </div>
    </div>
  );
}
