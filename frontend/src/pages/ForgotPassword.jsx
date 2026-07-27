import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';

export default function ForgotPassword() {
  const [params] = useSearchParams();
  const token = params.get('token');
  return token ? <ResetForm token={token} /> : <RequestForm />;
}

function RequestForm() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    await api.forgotPassword(email);
    // Backend always returns the same generic response regardless of
    // whether the email exists — mirror that here rather than confirming
    // or denying account existence in the UI.
    setSent(true);
  }

  if (sent) {
    return (
      <div className="auth-page">
        <div className="auth-form">
          <p>If an account exists for that email, a reset link has been sent.</p>
          <Link to="/login">Back to login</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>Reset your password</h1>
        <label>
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button type="submit">Send reset link</button>
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

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(err.body?.error || 'Invalid or expired reset link');
    }
  }

  if (done) {
    return (
      <div className="auth-page">
        <div className="auth-form">
          <p>Password updated. Please log in with your new password.</p>
          <Link to="/login">Go to login</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>Set a new password</h1>
        {error && <div className="error">{error}</div>}
        <label>
          New password
          <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit">Update password</button>
      </form>
    </div>
  );
}
