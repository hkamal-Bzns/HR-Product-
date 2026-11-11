import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

type Page = 'dashboard' | 'attendance' | 'roster' | 'exceptions' | 'leave' | 'payroll' | 'settings' | 'superadmin';

function App() {
  const [lang, setLang] = useState<'ar' | 'en'>('ar');
  const [health, setHealth] = useState<string>('…');
  const [page, setPage] = useState<Page>('dashboard');
  const [token, setToken] = useState<string>('');
  const [email, setEmail] = useState('owner@demo-cafe.eg');
  const [password, setPassword] = useState('DemoOwner123!');
  const [loginMsg, setLoginMsg] = useState('');
  const [branches, setBranches] = useState<{ id: string; nameEn: string; nameAr: string; geofenceLat: number; geofenceLng: number }[]>([]);
  const [employees, setEmployees] = useState<{ id: string; fullNameAr: string; jobTitle: string; branchId: string | null }[]>([]);
  const [out, setOut] = useState<string>('');
  const [qr, setQr] = useState<{ token: string; expiresAtMs: number; rotationSeconds: number } | null>(null);
  const [branchId, setBranchId] = useState('branch-zamalek');
  const [employeeId, setEmployeeId] = useState('emp-demo-1');
  const [lat, setLat] = useState('30.0626');
  const [lng, setLng] = useState('31.2197');
  const [passcode, setPasscode] = useState('1234');
  const [photoRef, setPhotoRef] = useState('kiosk-photo-demo-1');
  const [templates, setTemplates] = useState<{ id: string; nameAr: string; nameEn: string; startTime: string; endTime: string; overnight: boolean }[]>([]);
  const [rosters, setRosters] = useState<{ id: string; branchId: string | null; weekStart: string; status: string; assignments: { id: string; employeeId: string; date: string; shiftTemplateId: string | null; onLeave: boolean }[] }[]>([]);
  const [exceptions, setExceptions] = useState<{ id: string; kind: string; status: string; reason: string; employeeId: string }[]>([]);
  const [balances, setBalances] = useState<{ type: string; entitlementDays: number; takenDays: number; remainingDays: number }[]>([]);
  const [leaveReqs, setLeaveReqs] = useState<{ id: string; employeeId: string; type: string; startDate: string; endDate: string; days: number; status: string }[]>([]);
  const [holidays, setHolidays] = useState<{ date: string; nameAr: string; nameEn: string; provisional: boolean }[]>([]);
  const [leaveType, setLeaveType] = useState('annual');
  const [leaveStart, setLeaveStart] = useState('2026-12-01');
  const [leaveEnd, setLeaveEnd] = useState('2026-12-02');
  const [settingsArea, setSettingsArea] = useState<'attendance' | 'shifts' | 'leave' | 'payroll_structure' | 'statutory_rates' | 'notifications' | 'integrations_billing_data'>('attendance');
  const [settingsJson, setSettingsJson] = useState('');
  const [settingsReason, setSettingsReason] = useState('');
  const [confirmDangerous, setConfirmDangerous] = useState(false);
  // --- M3 payroll ------------------------------------------------------------
  const [payPeriod, setPayPeriod] = useState('2026-11');
  const [runs, setRuns] = useState<{ id: string; period: string; status: string; totalGrossPiasters: number; totalNetPiasters: number; totalEmployerNosiPiasters: number | null; employerCostStatus: string; anomalies: { kind: string; message: string; employeeId: string }[] }[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [payslips, setPayslips] = useState<{ id: string; employeeId: string; grossPiasters: number; employeeNosiPiasters: number; incomeTaxPiasters: number; netPiasters: number; employerNosiPiasters: number | null; belowMinimumWage: boolean }[]>([]);
  const [payBank, setPayBank] = useState('CIB');
  const [payslipHtml, setPayslipHtml] = useState('');
  const [reportOut, setReportOut] = useState('');
  const [weekStart, setWeekStart] = useState('2026-11-16');
  const [rosterDate, setRosterDate] = useState('2026-11-16');
  const [templateId, setTemplateId] = useState('tpl-morning');

  useEffect(() => { document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; }, [lang]);
  useEffect(() => {
    fetch(`${API}/health`).then((r) => r.json()).then((j) => setHealth(`${j.status} — ${j.scope}`)).catch(() => setHealth('API offline (start apps/api)'));
  }, []);

  const t = lang === 'ar'
    ? { title: 'الموارد البشرية والرواتب', sub: 'M3 — الرواتب: هيكل الرواتب، دورة التشغيل (تجهيز ← مراجعة ← حساب ← اعتماد ← صرف)، كشوف الرواتب، ملفات البنوك، التقارير. واتساب تجريبي (STUBBED).', dash: 'لوحة التحكم', att: 'الحضور', roster: 'الورديات', exc: 'الاستثناءات', leave: 'الإجازات', payroll: 'الرواتب', settings: 'الإعدادات', super: 'المشرف العام', login: 'تسجيل الدخول', demo: 'بيانات تجريبية: مقهى القاهرة — فرعان، 10 موظفين. لا رواتب حقيقية.', stub: 'واتساب تجريبي (STUBBED): الرسائل تُسجَّل في صندوق الصادر فقط ولا تُرسَل فعلياً. ملفات البنوك مولَّدة فقط وليست صرفاً فعلياً.' }
    : { title: 'HR & Payroll', sub: 'M3 — Payroll: salary structures, run workflow (prepare → review → calculate → approve → pay), payslips, bank files, reports. WhatsApp stubbed.', dash: 'Dashboard', att: 'Attendance', roster: 'Roster', exc: 'Exceptions', leave: 'Leave', payroll: 'Payroll', settings: 'Settings', super: 'Superadmin', login: 'Login', demo: 'Demo data: Cairo Café — 2 branches, 10 employees. No real salaries.', stub: 'WhatsApp is STUBBED: messages are queued in the outbox only, never actually sent. Bank files are generated files, not disbursements.' };

  const authHeaders: Record<string, string> = token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' };
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${API}${path}`, { method, headers: authHeaders, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    setOut(JSON.stringify({ status: res.status, ...json }, null, 2));
    return { res, json };
  };
  const login = async () => {
    const { res, json } = await api('/auth/login', 'POST', { tenantSlug: 'demo-cafe', email, password });
    if (res.status === 200) { setToken(json.token); setLoginMsg(lang === 'ar' ? 'تم تسجيل الدخول' : 'Logged in'); await loadLookups(json.token); }
    else setLoginMsg(json.error ?? 'login failed');
  };
  const loadLookups = async (tok = token) => {
    const h = { authorization: `Bearer ${tok}` };
    const b = await fetch(`${API}/api/branches`, { headers: h }).then((r) => r.json()).catch(() => ({}));
    setBranches(b.branches ?? []);
    const e = await fetch(`${API}/api/employees`, { headers: h }).then((r) => r.json()).catch(() => ({}));
    setEmployees(e.employees ?? []);
    const tpl = await fetch(`${API}/api/shifts/templates`, { headers: h }).then((r) => r.json()).catch(() => ({}));
    setTemplates(tpl.templates ?? []);
    await loadRosters(tok); await loadExceptions(tok); await loadLeave(tok);
  };
  const loadRosters = async (tok = token) => {
    const r = await fetch(`${API}/api/rosters`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json()).catch(() => ({}));
    setRosters(r.rosters ?? []);
  };
  const loadExceptions = async (tok = token) => {
    const r = await fetch(`${API}/api/exceptions?status=open`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json()).catch(() => ({}));
    setExceptions(r.exceptions ?? []);
  };
  const loadLeave = async (tok = token) => {
    const h = { authorization: `Bearer ${tok}` };
    const b = await fetch(`${API}/api/leave/balances?employeeId=${employeeId}&year=2026`, { headers: h }).then((x) => x.json()).catch(() => ({}));
    setBalances(b.balances ?? []);
    const l = await fetch(`${API}/api/leave/requests`, { headers: h }).then((x) => x.json()).catch(() => ({}));
    setLeaveReqs(l.requests ?? []);
    const hol = await fetch(`${API}/api/leave/holidays`, { headers: h }).then((x) => x.json()).catch(() => ({}));
    setHolidays(hol.holidays ?? []);
  };
  const loadSettings = async () => {
    const { json } = await api(`/api/settings/${settingsArea}`);
    setSettingsJson(JSON.stringify(json.latest?.value ?? {}, null, 2));
  };
  // --- M3 payroll helpers ----------------------------------------------------
  const loadRuns = async (tok = token) => {
    const r = await fetch(`${API}/api/payroll/runs`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json()).catch(() => ({}));
    setRuns(r.runs ?? []);
  };
  const loadPayslips = async (runId: string, tok = token) => {
    const r = await fetch(`${API}/api/payroll/runs/${runId}/payslips`, { headers: { authorization: `Bearer ${tok}` } }).then((x) => x.json()).catch(() => ({}));
    setPayslips(r.payslips ?? []);
  };
  const loadReport = async (kind: string) => {
    const r = await fetch(`${API}/api/payroll/reports/${kind}?period=${payPeriod}`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json()).catch(() => ({}));
    setReportOut(JSON.stringify(r, null, 2));
  };
  const viewPayslipHtml = async (payslipId: string) => {
    const r = await fetch(`${API}/api/payroll/payslips/${payslipId}/html`, { headers: { authorization: `Bearer ${token}` } });
    setPayslipHtml(await r.text());
  };
  const egp = (p: number) => (p / 100).toFixed(2);
  const saveSettings = async () => {
    let value: Record<string, unknown>;
    try { value = JSON.parse(settingsJson); } catch { setOut('Invalid JSON'); return; }
    await api(`/api/settings/${settingsArea}`, 'POST', { value, reason: settingsReason || 'web edit', effectiveFrom: '2026-12-01', confirmDangerous });
  };
  const getQr = async () => {
    const { json } = await api(`/api/attendance/qr-token?branchId=${branchId}`);
    if (json.token) setQr(json);
  };
  const qrClockIn = async () => {
    if (!qr) { setOut('Get a QR token first'); return; }
    await api('/api/attendance/clock-in', 'POST', { employeeId, branchId, token: qr.token, lat: Number(lat), lng: Number(lng) });
  };
  const kioskClockIn = async () => {
    await api('/api/attendance/kiosk/clock-in', 'POST', { employeeId, branchId, passcode, photoRef });
  };

  const branch = branches.find((b) => b.id === branchId);
  return (
    <div style={{ fontFamily: 'system-ui', maxWidth: 860, margin: '2rem auto', padding: '0 1rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}>
        <h1>{t.title}</h1>
        <button onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}>{lang === 'ar' ? 'English' : 'العربية'}</button>
      </header>
      <p>{t.sub}</p>
      <p>API: {health}</p>
      <p><em>{t.stub}</em></p>
      <section style={{ border: '1px solid #ccc', padding: 12, marginBottom: 12 }}>
        <h3>{t.login} — demo-cafe</h3>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email" style={{ marginInlineEnd: 6 }} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" style={{ marginInlineEnd: 6 }} />
        <button onClick={login}>{t.login}</button> <span>{loginMsg}</span>
        {token && <p>✓ {lang === 'ar' ? 'مسجَّل — تم تحميل الفروع والموظفين والقوالب' : 'Logged in — branches, employees and templates loaded'}</p>}
      </section>
      <nav style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {([['dashboard', t.dash], ['attendance', t.att], ['roster', t.roster], ['exceptions', t.exc], ['leave', t.leave], ['payroll', t.payroll], ['settings', t.settings], ['superadmin', t.super]] as [Page, string][]).map(([p, label]) => (
          <button key={p} onClick={() => setPage(p)} disabled={p === page}>{label}</button>
        ))}
      </nav>

      {page === 'dashboard' && <section><h2>{t.dash}</h2><p>{t.demo}</p><p>EGP / Africa/Cairo. Money in piasters. NOSI employer rate: UNRESOLVED — no default shipped; payroll approval is BLOCKED until a reviewer sets it via Settings → Statutory rates.</p><p>{lang === 'ar' ? 'M3 يشمل: هياكل الرواتب، دورة تشغيل الرواتب (تجهيز ← مراجعة الشذوذ ← حساب ← اعتماد وقفل ← صرف بملف بنك)، كشوف رواتب عربية قابلة للطباعة، تقارير (ملخص، تكلفة صاحب العمل، ضريبة وتأمينات، حضور، تكلفة العمل)، وتصدير CSV مسجَّل. قواعد الضريبة (قانون 7 لسنة 2024) والعمل الإضافي (قانون 14 لسنة 2025) — REVIEWER-UNCONFIRMED.' : 'M3 covers: salary structures, payroll run workflow (prepare → anomaly review → calculate → approve & lock → pay via bank file), Arabic printable payslips, reports (summary, employer cost, tax & NOSI, attendance, labour cost), and logged CSV export. Tax (Law 7/2024) and overtime (Law 14/2025) rules — REVIEWER-UNCONFIRMED.'}</p></section>}

      {page === 'attendance' && <section><h2>{t.att}</h2>
        <label>{lang === 'ar' ? 'الفرع' : 'Branch'} <select value={branchId} onChange={(e) => { setBranchId(e.target.value); const b = branches.find((x) => x.id === e.target.value); if (b) { setLat(String(b.geofenceLat)); setLng(String(b.geofenceLng)); } }}>{branches.map((b) => <option key={b.id} value={b.id}>{lang === 'ar' ? b.nameAr : b.nameEn}</option>)}</select></label>{' '}
        <label>{lang === 'ar' ? 'الموظف' : 'Employee'} <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>{employees.map((e) => <option key={e.id} value={e.id}>{e.fullNameAr} ({e.jobTitle})</option>)}</select></label>
        <h3>Mode A — QR + {lang === 'ar' ? 'تحديد الموقع' : 'geofence'}</h3>
        <button onClick={getQr} disabled={!token}>QR token</button>{' '}
        {qr && <span>token: <code>{qr.token}</code> — {lang === 'ar' ? 'ينتهي' : 'expires'} {new Date(qr.expiresAtMs).toLocaleTimeString()} ({qr.rotationSeconds}s)</span>}
        <div style={{ marginTop: 8 }}>
          <label>lat <input value={lat} onChange={(e) => setLat(e.target.value)} size={10} /></label>{' '}
          <label>lng <input value={lng} onChange={(e) => setLng(e.target.value)} size={10} /></label>{' '}
          <button onClick={qrClockIn} disabled={!token}>{lang === 'ar' ? 'تسجيل دخول (QR)' : 'Clock in (QR)'}</button>{' '}
          <button onClick={() => api('/api/attendance/clock-out', 'POST', { employeeId })} disabled={!token}>{lang === 'ar' ? 'تسجيل خروج' : 'Clock out'}</button>
          {branch && <p>{lang === 'ar' ? 'مركز الفرع' : 'Branch centre'}: {branch.geofenceLat}, {branch.geofenceLng} — {lang === 'ar' ? 'حاول تغيير الإحداثيات لرؤية استثناء off-location' : 'try changing the coordinates to see an off-location exception'}</p>}
        </div>
        <h3>Mode B — {lang === 'ar' ? 'كشك: رمز + صورة' : 'Kiosk: passcode + photo'}</h3>
        <label>{lang === 'ar' ? 'الرمز (4–6 أرقام)' : 'Passcode (4–6 digits)'} <input value={passcode} onChange={(e) => setPasscode(e.target.value)} size={8} /></label>{' '}
        <label>photoRef <input value={photoRef} onChange={(e) => setPhotoRef(e.target.value)} size={20} /></label>{' '}
        <button onClick={kioskClockIn} disabled={!token}>{lang === 'ar' ? 'تسجيل دخول (كشك)' : 'Clock in (kiosk)'}</button>
        <p>{lang === 'ar' ? 'الصورة تُحفظ كمرجع فقط (photoRef) وليس كملف — وتتطلب موافقة مسبقة، والاحتفاظ 90 يوماً.' : 'Photos are stored as a reference only (photoRef), never as image bytes — consent required first, 90-day retention.'}</p>
        <button onClick={() => api('/api/attendance', 'GET')} disabled={!token}>{lang === 'ar' ? 'عرض سجلات الحضور' : 'View attendance records'}</button>
      </section>}

      {page === 'roster' && <section><h2>{t.roster}</h2>
        <h3>{lang === 'ar' ? 'قوالب الورديات' : 'Shift templates'}</h3>
        <ul>{templates.map((tpl) => <li key={tpl.id}>{lang === 'ar' ? tpl.nameAr : tpl.nameEn} — {tpl.startTime}–{tpl.endTime}{tpl.overnight ? ' (overnight)' : ''}</li>)}</ul>
        <h3>{lang === 'ar' ? 'إنشاء مسودة أسبوع' : 'Create a week draft'}</h3>
        <label>weekStart <input value={weekStart} onChange={(e) => setWeekStart(e.target.value)} size={12} /></label>{' '}
        <label>date <input value={rosterDate} onChange={(e) => setRosterDate(e.target.value)} size={12} /></label>{' '}
        <label>template <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>{templates.map((x) => <option key={x.id} value={x.id}>{x.nameEn}</option>)}</select></label>{' '}
        <button onClick={async () => { await api('/api/rosters', 'POST', { branchId, weekStart, assignments: [{ employeeId, date: rosterDate, shiftTemplateId: templateId }] }); await loadRosters(); }} disabled={!token}>{lang === 'ar' ? 'إنشاء مسودة' : 'Create draft'}</button>
        <h3>{lang === 'ar' ? 'الجداول' : 'Rosters'}</h3>
        <ul>{rosters.map((r) => <li key={r.id}>{r.weekStart} — {r.branchId} — {r.status} — {r.assignments.length} {lang === 'ar' ? 'تعيين' : 'assignments'}{' '}
          {r.status === 'draft' && <button onClick={async () => { await api(`/api/rosters/${r.id}/publish`, 'POST', {}); await loadRosters(); }} disabled={!token}>{lang === 'ar' ? 'نشر + إشعار' : 'Publish + notify'}</button>}
        </li>)}</ul>
        <p>{lang === 'ar' ? 'النشر يرسل إشعار واتساب تجريبياً لكل موظف في الجدول (يُسجَّل في صندوق الصادر).' : 'Publishing queues a stubbed WhatsApp notice per rostered employee (recorded in the outbox).'}</p>
      </section>}

      {page === 'exceptions' && <section><h2>{t.exc}</h2>
        <button onClick={() => loadExceptions()} disabled={!token}>{lang === 'ar' ? 'تحديث' : 'Refresh'}</button>
        <ul>{exceptions.map((e) => <li key={e.id}><b>{e.kind}</b> — {e.employeeId} — {e.reason}{' '}
          <button onClick={async () => { await api(`/api/exceptions/${e.id}/resolve`, 'POST', { action: 'resolve', note: 'resolved from web demo' }); await loadExceptions(); }} disabled={!token}>{lang === 'ar' ? 'حلّ' : 'Resolve'}</button>
        </li>)}</ul>
        {exceptions.length === 0 && <p>{lang === 'ar' ? 'لا استثناءات مفتوحة.' : 'No open exceptions.'}</p>}
      </section>}

      {page === 'leave' && <section><h2>{t.leave}</h2>
        <button onClick={() => loadLeave()} disabled={!token}>{lang === 'ar' ? 'تحديث' : 'Refresh'}</button>
        <h3>{lang === 'ar' ? 'الأرصدة 2026' : 'Balances 2026'} ({employeeId})</h3>
        <ul>{balances.map((b) => <li key={b.type}>{b.type}: {b.remainingDays} / {b.entitlementDays} {lang === 'ar' ? 'متبقٍ' : 'remaining'} ({lang === 'ar' ? 'مستخدم' : 'taken'} {b.takenDays})</li>)}</ul>
        <h3>{lang === 'ar' ? 'طلب إجازة' : 'Request leave'}</h3>
        <select value={leaveType} onChange={(e) => setLeaveType(e.target.value)}><option value="annual">annual</option><option value="sick">sick</option><option value="casual">casual</option><option value="unpaid">unpaid</option></select>{' '}
        <input value={leaveStart} onChange={(e) => setLeaveStart(e.target.value)} size={12} />{' '}
        <input value={leaveEnd} onChange={(e) => setLeaveEnd(e.target.value)} size={12} />{' '}
        <button onClick={async () => { await api('/api/leave/requests', 'POST', { employeeId, type: leaveType, startDate: leaveStart, endDate: leaveEnd, reason: 'web demo' }); await loadLeave(); }} disabled={!token}>{lang === 'ar' ? 'إرسال الطلب' : 'Submit request'}</button>
        <ul>{leaveReqs.map((r) => <li key={r.id}>{r.employeeId} — {r.type} {r.startDate}→{r.endDate} ({r.days}d) — {r.status}{' '}
          {r.status === 'pending' && <button onClick={async () => { await api(`/api/leave/requests/${r.id}/approve`, 'POST', {}); await loadLeave(); }} disabled={!token}>{lang === 'ar' ? 'موافقة' : 'Approve'}</button>}
        </li>)}</ul>
        <h3>{lang === 'ar' ? 'العطلات الرسمية في مصر 2026' : 'Egypt public holidays 2026'}</h3>
        <ul>{holidays.map((h) => <li key={h.date}>{h.date} — {lang === 'ar' ? h.nameAr : h.nameEn}{h.provisional ? ' (provisional)' : ''}</li>)}</ul>
      </section>}

      {page === 'payroll' && <section><h2>{t.payroll} — {lang === 'ar' ? 'دورة التشغيل (5 خطوات)' : 'Run wizard (5 steps)'}</h2>
        <p>{lang === 'ar' ? 'معدل تأمينات صاحب العمل غير مؤكد — الاعتماد محظور (BLOCKED) حتى يحدده المراجع من الإعدادات ← المعدلات القانونية. كشوف الموظفين صحيحة حتى أثناء الانتظار.' : 'Employer NOSI rate is unresolved — approval is BLOCKED until a reviewer sets it in Settings → Statutory rates. Employee payslips are correct while it is pending.'}</p>
        <label>{lang === 'ar' ? 'الفترة' : 'Period'} <input value={payPeriod} onChange={(e) => setPayPeriod(e.target.value)} size={9} /></label>{' '}
        <button onClick={async () => { await api('/api/payroll/runs', 'POST', { period: payPeriod }); await loadRuns(); }} disabled={!token}>{lang === 'ar' ? '1 — تجهيز' : '1 — Prepare'}</button>{' '}
        <button onClick={() => loadRuns()} disabled={!token}>{lang === 'ar' ? 'تحديث القائمة' : 'Refresh runs'}</button>
        <h3>{lang === 'ar' ? 'التشغيلات' : 'Runs'}</h3>
        <ul>{runs.map((r) => <li key={r.id}>{r.period} — <b>{r.status}</b> — {lang === 'ar' ? 'إجمالي' : 'gross'} {egp(r.totalGrossPiasters)} / {lang === 'ar' ? 'صافي' : 'net'} {egp(r.totalNetPiasters)} — {lang === 'ar' ? 'تأمينات صاحب العمل' : 'employer NOSI'}: {r.totalEmployerNosiPiasters === null ? (lang === 'ar' ? 'قيد الانتظار' : 'PENDING') : egp(r.totalEmployerNosiPiasters)}{' '}
          <button onClick={async () => { setSelectedRunId(r.id); await loadPayslips(r.id); }} disabled={!token}>{lang === 'ar' ? 'كشوف الرواتب' : 'Payslips'}</button>{' '}
          {r.status === 'prepared' && <><button onClick={async () => { await api(`/api/payroll/runs/${r.id}/review`, 'POST', {}); await loadRuns(); }} disabled={!token}>{lang === 'ar' ? '2 — مراجعة الشذوذ' : '2 — Review anomalies'}</button>{' '}
          <button onClick={async () => { await api(`/api/payroll/runs/${r.id}/calculate`, 'POST', {}); await loadRuns(); }} disabled={!token}>{lang === 'ar' ? '3 — حساب' : '3 — Calculate'}</button></>}
          {r.status === 'calculated' && <><button onClick={async () => { await api(`/api/payroll/runs/${r.id}/approve`, 'POST', {}); await loadRuns(); }} disabled={!token}>{lang === 'ar' ? '4 — اعتماد (عرض التكلفة أولاً)' : '4 — Approve (show cost first)'}</button>{' '}
          <button onClick={async () => { await api(`/api/payroll/runs/${r.id}/approve`, 'POST', { confirmTotalCost: true }); await loadRuns(); }} disabled={!token}>{lang === 'ar' ? '4 — تأكيد الاعتماد والقفل' : '4 — Confirm approve & lock'}</button></>}
          {r.status === 'locked' && <><select value={payBank} onChange={(e) => setPayBank(e.target.value)}><option>CIB</option><option>QNB</option><option>NBE</option><option>Banque Misr</option></select>{' '}
          <button onClick={async () => { await api(`/api/payroll/runs/${r.id}/pay`, 'POST', { bank: payBank }); await loadRuns(); }} disabled={!token}>{lang === 'ar' ? '5 — صرف (ملف بنك + كشوف واتساب تجريبي)' : '5 — Pay (bank file + stubbed WhatsApp payslips)'}</button></>}
          {r.status === 'calculated' || r.status === 'locked' || r.status === 'paid' ? <button onClick={async () => { const res = await fetch(`${API}/api/payroll/runs/${r.id}/export?kind=register`, { headers: { authorization: `Bearer ${token}` } }); setOut(await res.text()); }} disabled={!token}>CSV {lang === 'ar' ? 'سجل الرواتب' : 'register'}</button> : null}
          {r.anomalies?.length > 0 && <ul>{r.anomalies.map((a, i) => <li key={i}><b>{a.kind}</b> — {a.employeeId}: {a.message}</li>)}</ul>}
        </li>)}</ul>
        {selectedRunId && <><h3>{lang === 'ar' ? 'كشوف الرواتب' : 'Payslips'} ({selectedRunId})</h3>
        <ul>{payslips.map((p) => <li key={p.id}>{p.employeeId} — {lang === 'ar' ? 'إجمالي' : 'gross'} {egp(p.grossPiasters)} — {lang === 'ar' ? 'ضريبة' : 'tax'} {egp(p.incomeTaxPiasters)} — <b>{lang === 'ar' ? 'صافي' : 'net'} {egp(p.netPiasters)}</b>{p.belowMinimumWage ? ` — ⚠ ${lang === 'ar' ? 'أقل من الحد الأدنى للأجور' : 'below minimum wage'}` : ''}{' '}
          <button onClick={() => viewPayslipHtml(p.id)} disabled={!token}>{lang === 'ar' ? 'عرض كشف قابل للطباعة' : 'View printable payslip'}</button>
        </li>)}</ul></>}
        {payslipHtml && <iframe title="payslip" srcDoc={payslipHtml} style={{ width: '100%', height: 420, border: '1px solid #ccc' }} />}
        <h3>{lang === 'ar' ? 'التقارير' : 'Reports'}</h3>
        {(['summary', 'employer-cost', 'tax-nosi', 'attendance', 'labour-cost'] as const).map((k) => <span key={k}><button onClick={() => loadReport(k)} disabled={!token}>{k}</button>{' '}</span>)}
        {reportOut && <pre style={{ background: '#f4f6f3', padding: 12, overflow: 'auto', maxHeight: 300, direction: 'ltr', textAlign: 'left' }}>{reportOut}</pre>}
        <p>{lang === 'ar' ? 'كل تصدير يُسجَّل في سجل التصدير. التشغيل المقفل لا يُعاد حسابه أبداً — التصحيح يكون بتسوية في تشغيل لاحق فقط.' : 'Every export is logged. A locked run is never recalculated — corrections go only to a later run as adjustments.'}</p>
      </section>}

      {page === 'settings' && <section><h2>{t.settings} — §10 Areas 2–4, 6–9</h2>
        <select value={settingsArea} onChange={(e) => setSettingsArea(e.target.value as 'attendance' | 'shifts' | 'leave' | 'payroll_structure' | 'statutory_rates' | 'notifications' | 'integrations_billing_data')}>
          <option value="attendance">2 — Attendance</option><option value="shifts">3 — Shifts</option><option value="leave">4 — Leave</option>
          <option value="payroll_structure">6 — Payroll structure</option><option value="statutory_rates">7 — Statutory rates (guarded)</option>
          <option value="notifications">8 — Notifications / WhatsApp</option><option value="integrations_billing_data">9 — Integrations, billing, data</option>
        </select>{' '}
        <button onClick={loadSettings} disabled={!token}>{lang === 'ar' ? 'تحميل' : 'Load'}</button>
        <div><textarea value={settingsJson} onChange={(e) => setSettingsJson(e.target.value)} rows={14} cols={80} /></div>
        <label>{lang === 'ar' ? 'سبب التغيير' : 'Reason'} <input value={settingsReason} onChange={(e) => setSettingsReason(e.target.value)} size={40} /></label>{' '}
        <label><input type="checkbox" checked={confirmDangerous} onChange={(e) => setConfirmDangerous(e.target.checked)} /> confirmDangerous</label>{' '}
        <button onClick={saveSettings} disabled={!token}>{lang === 'ar' ? 'حفظ (إصدار جديد)' : 'Save (new version)'}</button>
        <p>{lang === 'ar' ? 'التغييرات الخطرة (توسيع النطاق فوق 300م، إيقاف الصورة، رفع سقف العمل الإضافي) تتطلب تأكيداً + سبباً. التغيير المؤثر على جدول منشور يظهر معاينة الأثر أولاً.' : 'Dangerous changes (geofence beyond 300m, photo off, overtime cap up) need confirmation + reason. Changes affecting a published roster show an impact preview first.'}</p>
      </section>}

      {page === 'superadmin' && <section><h2>{t.super}</h2><p>Superadmin Lite (§11): tenant list, plan change, feature flags. MFA mandatory. No salaries, photos or payslips by default — break-glass only, disabled by default, audit-logged.</p></section>}

      {out && <section><h3>API {lang === 'ar' ? 'النتيجة' : 'response'}</h3><pre style={{ background: '#f4f6f3', padding: 12, overflow: 'auto', maxHeight: 400, direction: 'ltr', textAlign: 'left' }}>{out}</pre></section>}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
