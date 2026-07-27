import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';

const PLANS = ['FREE', 'PRO', 'ENTERPRISE'];

export default function Billing() {
  const { activeOrg } = useAuth();
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!activeOrg) return;
    setLoading(true);
    try {
      const data = await api.billingHistory(activeOrg.id);
      setHistory(data.history || data);
    } catch (err) {
      setError(err.body?.error || 'Failed to load billing history');
    } finally {
      setLoading(false);
    }
  }, [activeOrg]);

  useEffect(() => { load(); }, [load]);

  async function handleUpgrade(plan) {
    setError(null);
    try {
      const result = await api.initiateBilling(activeOrg.id, plan);
      // Paystack returns a checkout URL — hand off to it directly rather
      // than trying to embed payment collection in this app.
      if (result.authorizationUrl) {
        window.location.href = result.authorizationUrl;
      }
    } catch (err) {
      setError(err.body?.error || 'Failed to start checkout');
    }
  }

  if (!activeOrg) return <div className="page">Select an organisation first.</div>;

  return (
    <div className="page">
      <h1>Billing</h1>
      <p className="muted">Current plan: {activeOrg.plan || 'FREE'}</p>

      {activeOrg.role === 'ADMIN' && (
        <div className="plan-buttons">
          {PLANS.map((plan) => (
            <button key={plan} onClick={() => handleUpgrade(plan)}>
              Switch to {plan}
            </button>
          ))}
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <h2>History</h2>
      {loading ? (
        <p>Loading…</p>
      ) : history.length === 0 ? (
        <p className="muted">No billing history yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Date</th><th>Plan</th><th>Status</th></tr>
          </thead>
          <tbody>
            {history.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.createdAt).toLocaleDateString()}</td>
                <td>{entry.plan}</td>
                <td>{entry.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
