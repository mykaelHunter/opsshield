import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';

export default function Members() {
  const { activeOrg } = useAuth();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('MEMBER');
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  async function handleInvite(e) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api.inviteMember(activeOrg.id, { email: inviteEmail, role: inviteRole });
      setMessage(`Invitation sent to ${inviteEmail}`);
      setInviteEmail('');
    } catch (err) {
      // 502 specifically means the invite row was rolled back because
      // email delivery failed — surface that distinction rather than a
      // generic failure message, since it's genuinely different from a
      // validation error (nothing was left in an inconsistent state).
      if (err.status === 502) {
        setError('Could not send the invitation email — nothing was saved, please try again');
      } else {
        setError(err.body?.error || 'Failed to send invitation');
      }
    }
  }

  if (!activeOrg) return <div className="page">Select an organisation first.</div>;

  return (
    <div className="page">
      <h1>Members</h1>
      {activeOrg.role !== 'ADMIN' && (
        <p className="muted">Only admins can invite or manage members.</p>
      )}
      {activeOrg.role === 'ADMIN' && (
        <form className="inline-form" onSubmit={handleInvite}>
          <input
            type="email"
            placeholder="teammate@example.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            required
          />
          <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
            <option value="MEMBER">Member</option>
            <option value="ADMIN">Admin</option>
          </select>
          <button type="submit">Send invite</button>
        </form>
      )}
      {message && <div className="success">{message}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
