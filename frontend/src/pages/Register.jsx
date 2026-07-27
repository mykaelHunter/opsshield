import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '', firstName: '', lastName: '', orgName: '' });
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
      await register(form);
      navigate('/');
    } catch (err) {
      setError(err.body?.error || 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>Create your organisation</h1>
        {error && <div className="error">{error}</div>}
        <label>
          First name
          <input required value={form.firstName} onChange={update('firstName')} />
        </label>
        <label>
          Last name
          <input required value={form.lastName} onChange={update('lastName')} />
        </label>
        <label>
          Organisation name
          <input required value={form.orgName} onChange={update('orgName')} />
        </label>
        <label>
          Email
          <input type="email" required value={form.email} onChange={update('email')} />
        </label>
        <label>
          Password
          <input type="password" required minLength={8} value={form.password} onChange={update('password')} />
        </label>
        <button type="submit" disabled={submitting}>{submitting ? 'Creating…' : 'Create account'}</button>
        <div className="auth-links">
          <Link to="/login">Already have an account? Log in</Link>
        </div>
      </form>
    </div>
  );
}
