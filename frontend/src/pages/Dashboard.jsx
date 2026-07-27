import { useAuth } from '../context/AuthContext';

export default function Dashboard() {
  const { user, activeOrg } = useAuth();

  if (!activeOrg) {
    return (
      <div className="page">
        <p>You're not a member of any organisation yet.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>{activeOrg.name}</h1>
      <p className="muted">Signed in as {user.email} · role: {activeOrg.role}</p>
      <div className="card-grid">
        <a className="card" href="/tasks">
          <h3>Tasks</h3>
          <p>View and manage tasks, approvals, and assignments</p>
        </a>
        <a className="card" href="/members">
          <h3>Members</h3>
          <p>Invite teammates and manage roles</p>
        </a>
        <a className="card" href="/billing">
          <h3>Billing</h3>
          <p>View plan and billing history</p>
        </a>
      </div>
    </div>
  );
}
