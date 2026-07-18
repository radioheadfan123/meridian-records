import { useState } from 'react';
import { useAuth } from '../AuthContext';

const DEMO_ACCOUNTS = [
  { role: 'Administrator', email: 'admin@demo.clinic', password: 'AdminDemo123!' },
  { role: 'Provider', email: 'provider@demo.clinic', password: 'ProviderDemo123!' },
  { role: 'Front desk', email: 'frontdesk@demo.clinic', password: 'FrontdeskDemo123!' },
];

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand login-brand">
          <span className="brand-mark" aria-hidden="true">▚</span>
          <span className="brand-name">Meridian Records</span>
        </div>
        <p className="login-sub">Demo patient record system. Every record is synthetic.</p>
        <form onSubmit={submit}>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <div className="demo-accounts">
          <p className="demo-accounts-title">Demo accounts</p>
          {DEMO_ACCOUNTS.map((a) => (
            <button
              key={a.email}
              type="button"
              className="demo-account"
              onClick={() => { setEmail(a.email); setPassword(a.password); }}
            >
              <span>{a.role}</span>
              <code>{a.email}</code>
            </button>
          ))}
          <p className="demo-accounts-note">Click one to fill the form. Accounts lock for 15 minutes after 5 failed attempts.</p>
        </div>
      </div>
    </div>
  );
}
