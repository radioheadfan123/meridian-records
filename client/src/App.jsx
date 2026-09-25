import { BrowserRouter, Routes, Route, Navigate, NavLink } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import Login from './pages/Login';
import PatientList from './pages/PatientList';
import PatientDetail from './pages/PatientDetail';
import PatientForm from './pages/PatientForm';
import AuditLog from './pages/AuditLog';
import Staff from './pages/Staff';

const ROLE_LABEL = { ADMIN: 'Administrator', PROVIDER: 'Provider', FRONT_DESK: 'Front desk' };

function Shell({ children }) {
  const { user, logout } = useAuth();
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">▚</span>
          <span className="brand-name">Meridian Records</span>
          <span className="brand-tag">demo EHR · synthetic data only</span>
        </div>
        <nav>
          <NavLink to="/patients">Patients</NavLink>
          {user.role === 'ADMIN' && <NavLink to="/audit">Audit log</NavLink>}
          {user.role === 'ADMIN' && <NavLink to="/staff">Staff</NavLink>}
        </nav>
        <div className="whoami">
          <div>
            <div className="whoami-name">{user.name}</div>
            <div className={`role-chip role-${user.role}`}>{ROLE_LABEL[user.role]}</div>
          </div>
          <button className="btn btn-ghost" onClick={logout}>Sign out</button>
        </div>
      </header>
      <main>{children}</main>
      <footer className="footnote">
        All patient data in this system is synthetic. This is a security-practices demo, not a medical record system.
      </footer>
    </div>
  );
}

function Protected({ children, adminOnly = false }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== 'ADMIN') return <Navigate to="/patients" replace />;
  return <Shell>{children}</Shell>;
}

function Router() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/patients" replace /> : <Login />} />
      <Route path="/patients" element={<Protected><PatientList /></Protected>} />
      <Route path="/patients/new" element={<Protected><PatientForm /></Protected>} />
      <Route path="/patients/:id" element={<Protected><PatientDetail /></Protected>} />
      <Route path="/audit" element={<Protected adminOnly><AuditLog /></Protected>} />
      <Route path="/staff" element={<Protected adminOnly><Staff /></Protected>} />
      <Route path="*" element={<Navigate to={user ? '/patients' : '/login'} replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Router />
      </BrowserRouter>
    </AuthProvider>
  );
}
