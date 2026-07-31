import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';

const PLANS = ['STARTER', 'PRO'];

const STATUS_PILL = {
  SUCCESS: 'pill--success',
  FAILED: 'pill--failed',
  PENDING: 'pill--pending',
};

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
      setHistory(Array.isArray(data.billing) ? data.billing : []);
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
      if (result.url) {
        window.location.href = result.url;
      }
    } catch (err) {
      setError(err.body?.error || 'Failed to start checkout');
    }
  }

  if (!activeOrg) return <div className="page">Select an organisation first.</div>;

  return (
    <div className="page">
      <h1>Billing</h1>
      <p className="muted">{activeOrg.name} · plan and payment history</p>
      <span className="plan-chip">{activeOrg.plan || 'FREE'} plan</span>

      {activeOrg.role === 'ADMIN' && (
        <div className="plan-buttons">
          {PLANS.map((plan) => (
            <button key={plan} onClick={() => handleUpgrade(plan)}>
              Switch to {plan}
            </button>
          ))}
        </div>
      )}

      {error && <div className="error" onClick={() => setError(null)}>{error}</div>}

      <h2>History</h2>
      {loading ? (
        <div className="loading-rows">
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      ) : history.length === 0 ? (
        <div className="empty-state">
          <p style={{ margin: 0, fontWeight: 600, color: 'var(--text)' }}>No billing history yet</p>
          <p style={{ margin: '0.35rem 0 0' }}>Charges and plan changes will show up here once you upgrade.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Plan</th><th>Status</th></tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.createdAt).toLocaleDateString()}</td>
                  <td>{entry.plan}</td>
                  <td>
                    <span className={`pill ${STATUS_PILL[entry.status] || 'pill--pending'}`}>
                      {entry.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
