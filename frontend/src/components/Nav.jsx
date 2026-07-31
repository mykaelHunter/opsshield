import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Nav() {
  const { user, activeOrgId, setActiveOrgId, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return null;

  return (
    <nav className="nav">
      <div className="nav-left">
        <Link to="/" className="brand">
          <svg className="brand-mark" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M12 2.5 4 5.5v6c0 5.2 3.4 8.7 8 10 4.6-1.3 8-4.8 8-10v-6L12 2.5Z" fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M8.8 12.2l2.2 2.2 4.2-4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          OpsShield
        </Link>
        <Link to="/tasks">Tasks</Link>
        <Link to="/members">Members</Link>
        <Link to="/billing">Billing</Link>
      </div>
      <div className="nav-right">
        {user.organisations?.length > 1 && (
          <select
            value={activeOrgId ?? ''}
            onChange={(e) => setActiveOrgId(e.target.value)}
            aria-label="Active organisation"
          >
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
