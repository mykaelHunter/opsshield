import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import AuthBrand from '../components/AuthBrand';

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const { login } = useAuth();
  const [form, setForm] = useState({ email: '', password: '', firstName: '', lastName: '' });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function update(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { email, ...inviteFields } = form;
      await api.acceptInvite({ token, ...inviteFields });
      // acceptInvite doesn't return a session itself (nor the invite's
      // email) — log in right after with what was just entered, so the
      // user lands in the app instead of a login screen they'd find
      // confusing right after "accepting" something.
      await login({ email, password: form.password });
      navigate('/');
    } catch (err) {
      setError(err.body?.error || 'This invitation is invalid or has expired');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="auth-page">
        <div className="auth-form">
          <AuthBrand />
          <p className="error">Missing invitation token.</p>
          <div className="auth-links">
            <Link to="/login">Back to login</Link>
          </div>
        </div>
      </div>
    );
  }

  // Known simplification: this form always asks for name + password, but
  // the backend only actually requires them when the invited email doesn't
  // match an existing user. An existing user joining a second org via
  // invite will have these fields ignored server-side — harmless, but a
  // fuller version would branch the form on whether the account exists.

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <AuthBrand />
        <h1>Accept invitation</h1>
        {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
        <label>
          Email (the address this invite was sent to)
          <input type="email" required value={form.email} onChange={update('email')} />
        </label>
        <label>
          First name
          <input required value={form.firstName} onChange={update('firstName')} />
        </label>
        <label>
          Last name
          <input required value={form.lastName} onChange={update('lastName')} />
        </label>
        <label>
          Password
          <input type="password" required minLength={8} value={form.password} onChange={update('password')} />
        </label>
        <button type="submit" disabled={submitting}>{submitting ? 'Joining…' : 'Accept & join'}</button>
      </form>
    </div>
  );
}
