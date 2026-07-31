import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import AuthBrand from '../components/AuthBrand';

export default function ForgotPassword() {
  const [params] = useSearchParams();
  const token = params.get('token');
  return token ? <ResetForm token={token} /> : <RequestForm />;
}

function RequestForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.forgotPassword(email);
      // Backend always returns the same generic response regardless of
      // whether the email exists — mirror that here rather than confirming
      // or denying account existence in the UI.
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="auth-page">
        <div className="auth-form">
          <AuthBrand />
          <p className="success">If an account exists for that email, a reset link has been sent.</p>
          <div className="auth-links">
            <Link to="/login">Back to login</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <AuthBrand />
        <h1>Reset your password</h1>
        <label>
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button type="submit" disabled={submitting}>{submitting ? 'Sending…' : 'Send reset link'}</button>
        <div className="auth-links">
          <Link to="/login">Back to login</Link>
        </div>
      </form>
    </div>
  );
}

function ResetForm({ token }) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err.body?.error || 'Invalid or expired reset link');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="auth-page">
        <div className="auth-form">
          <AuthBrand />
          <p className="success">Password updated. Please log in with your new password.</p>
          <div className="auth-links">
            <Link to="/login">Go to login</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <AuthBrand />
        <h1>Set a new password</h1>
        {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
        <label>
          New password
          <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit" disabled={submitting}>{submitting ? 'Updating…' : 'Update password'}</button>
      </form>
    </div>
  );
}
