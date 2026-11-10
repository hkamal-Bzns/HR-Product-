import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

function App() {
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const [health, setHealth] = useState<string>('…');
  const [page, setPage] = useState<'dashboard' | 'settings' | 'superadmin'>('dashboard');
  useEffect(() => { document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; }, [lang]);
  useEffect(() => {
    fetch(`${API}/health`).then((r) => r.json()).then((j) => setHealth(`${j.status} — ${j.scope}`)).catch(() => setHealth('API offline (start apps/api)'));
  }, []);
  const t = lang === 'ar'
    ? { title: 'الموارد البشرية والرواتب', sub: 'M1 — الأساس فقط: تعدد المستأجرين، المصادقة، الإعدادات، المشرف العام', dash: 'لوحة التحكم', settings: 'الإعدادات', super: 'المشرف العام', demo: 'بيانات تجريبية: مقهى القاهرة — فرعان، 10 موظفين. لا رواتب حقيقية.' }
    : { title: 'HR & Payroll', sub: 'M1 — Foundation only: multi-tenancy, auth, settings, Superadmin Lite', dash: 'Dashboard', settings: 'Settings', super: 'Superadmin', demo: 'Demo data: Cairo Café — 2 branches, 10 employees. No real salaries.' };
  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 720, margin: '2rem auto', padding: '0 1rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h1>{t.title}</h1>
        <button onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{lang === 'ar' ? 'English' : 'العربية'}</button>
      </header>
      <p>{t.sub}</p>
      <p>API: {health}</p>
      <nav style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => setPage('dashboard')}>{t.dash}</button>
        <button onClick={() => setPage('settings')}>{t.settings}</button>
        <button onClick={() => setPage('superadmin')}>{t.super}</button>
      </nav>
      {page === 'dashboard' && <section><h2>{t.dash}</h2><p>{t.demo}</p><p>EGP / Africa/Cairo. Money in piasters. NOSI employer rate: UNRESOLVED — no default shipped.</p></section>}
      {page === 'settings' && <section><h2>{t.settings}</h2><p>Settings framework (§10): versioned, effective-dated rule sets. Areas: Company &amp; Branches, Attendance, Shifts, Leave, People &amp; Roles, Payroll Structure, Statutory Rates, Notifications, Integrations &amp; Data. Full screens ship in M1–M3; this M1 shell wires the API (GET/POST /api/settings/:area).</p></section>}
      {page === 'superadmin' && <section><h2>{t.super}</h2><p>Superadmin Lite (§11): tenant list, plan change, feature flags. MFA mandatory. No salaries, photos or payslips by default — break-glass only, disabled by default, audit-logged.</p></section>}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
