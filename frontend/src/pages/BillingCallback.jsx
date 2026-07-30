import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

// Paystack redirects here after checkout completes. The actual plan
// upgrade happens asynchronously via the /api/webhooks/paystack webhook,
// so this page just gives that a moment to land before sending the user
// back to the billing page to see their updated history.
export default function BillingCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const reference = searchParams.get('reference') || searchParams.get('trxref');

  const [waited, setWaited] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (waited) {
      navigate('/billing', { replace: true });
    }
  }, [waited, navigate]);

  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <h2>Confirming your payment…</h2>
      <p>
        {reference
          ? `Reference: ${reference}`
          : 'Please wait while we confirm your payment.'}
      </p>
      <p>You'll be redirected to your billing page in a moment.</p>
    </div>
  );
}
