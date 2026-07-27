import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Nav() {
  const { user, activeOrgId, setActiveOrgId, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;

  return (
    <nav className="nav">
      <div className="nav-left">
        <Link to="/" className="brand">OpsShield</Link>
        <Link to="/tasks">Tasks</Link>
        <Link to="/members">Members</Link>
        <Link to="/billing">Billing</Link>
      </div>
      <div className="nav-right">
        {user.organisations?.length > 1 && (
          <select value={activeOrgId ?? ''} onChange={(e) => setActiveOrgId(e.target.value)}>
            {user.organisations.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        )}
        <span className="user-email">{user.email}</span>
        <button
          onClick={async () => { await logout(); navigate('/login'); }}
        >
          Log out
        </button>
      </div>
    </nav>
  );
}
