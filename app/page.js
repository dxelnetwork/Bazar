'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { settlement } from '../lib/settlement';

const emptyForm = {
  bazar_date: new Date().toISOString().slice(0, 10),
  item: '',
  category: '',
  amount: '',
  notes: '',
};

const emptyMemberForm = {
  name: '',
  email: '',
  password: '',
  confirmPassword: '',
  whatsapp: '',
};

/* ── helpers ────────────────────────────────────────── */

function fmt(n) {
  return `€${Number(n).toFixed(2)}`;
}

function monthLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

async function authHeaders() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

/* ══════════════════════════════════════════════════════
   MAIN COMPONENT
   ══════════════════════════════════════════════════════ */

export default function Home() {
  /* auth / profile */
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profiles, setProfiles] = useState([]);

  /* bazar data */
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null);

  /* monthly */
  const [activeMonth, setActiveMonth] = useState(null);
  const [allMonths, setAllMonths] = useState([]);

  /* auth form */
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  /* ui */
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState('dashboard'); // dashboard | members | history | historyDetail
  const [historyMonth, setHistoryMonth] = useState(null);

  /* member form */
  const [memberForm, setMemberForm] = useState(emptyMemberForm);
  const [memberList, setMemberList] = useState([]);
  const [showMemberModal, setShowMemberModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showStartModal, setShowStartModal] = useState(false);

  const isAdmin = profile?.role === 'admin';

  /* ── data loading ─────────────────────────────────── */

  const loadData = useCallback(async (uid) => {
    const [{ data: p }, { data: ps }, { data: months }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', uid).single(),
      supabase.from('profiles').select('id,name,role,whatsapp,status,created_at').order('name'),
      supabase.from('bazar_months').select('*').order('start_date', { ascending: false }),
    ]);

    if (p) setProfile(p);
    if (ps) setProfiles(ps);

    const active = months?.find((m) => m.status === 'active') || null;
    setActiveMonth(active);
    setAllMonths(months || []);

    // Load entries for active month only
    if (active) {
      const { data: es, error } = await supabase
        .from('bazar_entries')
        .select('*')
        .eq('month_id', active.id)
        .order('bazar_date', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) setMessage(error.message);
      else setRows(es || []);
    } else {
      // No active month — load all entries (fallback)
      const { data: es } = await supabase
        .from('bazar_entries')
        .select('*')
        .order('bazar_date', { ascending: false })
        .order('created_at', { ascending: false });
      setRows(es || []);
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!active) return;
      setSession(session);
      if (session) await loadData(session.user.id);
      setLoading(false);
    })();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_e, s) => {
      setSession(s);
      if (s) await loadData(s.user.id);
      else {
        setProfile(null);
        setProfiles([]);
        setRows([]);
        setActiveMonth(null);
        setAllMonths([]);
      }
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [loadData]);

  /* ── auth ──────────────────────────────────────────── */

  async function login() {
    setBusy(true);
    setMessage('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setMessage(error.message);
    setBusy(false);
  }

  /* ── entries ───────────────────────────────────────── */

  async function addEntry(e) {
    e.preventDefault();
    if (!session || !activeMonth) {
      setMessage('No active month. Contact Admin.');
      return;
    }
    setBusy(true);
    setMessage('');
    const payload = {
      ...form,
      amount: Number(form.amount),
      user_id: session.user.id,
      month_id: activeMonth.id,
    };
    const { data, error } = await supabase
      .from('bazar_entries')
      .insert(payload)
      .select()
      .single();
    if (error) {
      setMessage(error.message);
    } else {
      setForm(emptyForm);
      setMessage('Entry submitted and locked. Only Admin can change it.');
      await loadData(session.user.id);
      if (data?.id) {
        await syncEntry(data);
      }
    }
    setBusy(false);
  }

  async function syncEntry(row, action = 'upsert') {
    try {
      const hdrs = await authHeaders();
      await fetch('/api/sync', {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({
          action,
          entry: { ...row, monthId: activeMonth?.id },
          person: profiles.find((p) => p.id === row.user_id)?.name || profile?.name || 'Unknown',
        }),
      });
    } catch (e) {
      console.warn('Sheet sync unavailable', e);
    }
  }

  async function adminSave(e) {
    e.preventDefault();
    if (!isAdmin || !editing) return;
    setBusy(true);
    const { data, error } = await supabase
      .from('bazar_entries')
      .update({ ...editing, amount: Number(editing.amount) })
      .eq('id', editing.id)
      .select()
      .single();
    if (error) setMessage(error.message);
    else {
      setMessage('Entry updated by Admin.');
      setEditing(null);
      await loadData(session.user.id);
      await syncEntry(data || editing, 'update');
    }
    setBusy(false);
  }

  async function adminDelete(id) {
    if (!isAdmin || !confirm('Delete this bazar entry?')) return;
    setBusy(true);
    const { error } = await supabase.from('bazar_entries').delete().eq('id', id);
    if (error) setMessage(error.message);
    else {
      setMessage('Entry deleted by Admin.');
      await loadData(session.user.id);
      try {
        const hdrs = await authHeaders();
        await fetch('/api/sync', {
          method: 'POST',
          headers: hdrs,
          body: JSON.stringify({ action: 'delete', entry: { id } }),
        });
      } catch (_) {}
    }
    setBusy(false);
  }

  /* ── member management (admin) ─────────────────────── */

  async function loadMembers() {
    try {
      const hdrs = await authHeaders();
      const res = await fetch('/api/admin/members', { headers: hdrs });
      if (res.ok) {
        const data = await res.json();
        setMemberList(data.members || []);
      }
    } catch (_) {}
  }

  async function createMember(e) {
    e.preventDefault();
    setMessage('');
    const { name, email: mEmail, password: mPass, confirmPassword, whatsapp } = memberForm;

    if (!name.trim()) return setMessage('Name is required.');
    if (!mEmail.trim() || !mEmail.includes('@')) return setMessage('Valid email is required.');
    if (!mPass || mPass.length < 6) return setMessage('Password must be at least 6 characters.');
    if (mPass !== confirmPassword) return setMessage('Passwords do not match.');

    setBusy(true);
    try {
      const hdrs = await authHeaders();
      const res = await fetch('/api/admin/members', {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({
          name: name.trim(),
          email: mEmail.trim(),
          password: mPass,
          confirmPassword,
          whatsapp: whatsapp.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || 'Failed to create member.');
      } else {
        setMessage(`Member "${name.trim()}" created successfully!`);
        setMemberForm(emptyMemberForm);
        setShowMemberModal(false);
        await loadMembers();
      }
    } catch (err) {
      setMessage('Network error creating member.');
    }
    setBusy(false);
  }

  /* ── month management (admin) ──────────────────────── */

  async function closeMonth() {
    if (!activeMonth) return;
    setBusy(true);
    setMessage('');

    // Build settlement snapshot
    const nameById = Object.fromEntries(profiles.map((p) => [p.id, p.name]));
    const totals = {};
    const activeProfiles = profiles.filter((p) => p.status !== 'inactive');
    activeProfiles.forEach((p) => { totals[p.name] = 0; });
    rows.forEach((r) => {
      const n = nameById[r.user_id] || 'Unknown';
      totals[n] = (totals[n] || 0) + Number(r.amount);
    });
    const s = settlement(totals);
    const snapshot = {
      totals,
      settlement: s,
      members: activeProfiles.map((p) => ({ id: p.id, name: p.name, role: p.role })),
      entries: rows.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        person: nameById[r.user_id],
        bazar_date: r.bazar_date,
        item: r.item,
        category: r.category,
        amount: Number(r.amount),
        notes: r.notes,
      })),
      closed_at: new Date().toISOString(),
      closed_by_name: profile?.name,
    };

    try {
      const hdrs = await authHeaders();
      const res = await fetch('/api/admin/months/close', {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({ monthId: activeMonth.id, settlementSnapshot: snapshot }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || 'Failed to close month.');
      } else {
        setMessage(`Month "${activeMonth.month_name}" closed successfully!`);
        setShowCloseModal(false);
        await loadData(session.user.id);

        // Sync monthly summary to sheets
        try {
          await fetch('/api/sync', {
            method: 'POST',
            headers: hdrs,
            body: JSON.stringify({
              action: 'monthlySummary',
              monthName: activeMonth.month_name,
              snapshot,
            }),
          });
        } catch (_) {}
      }
    } catch (_) {
      setMessage('Network error closing month.');
    }
    setBusy(false);
  }

  async function startNewMonth() {
    setBusy(true);
    setMessage('');

    // Calculate next month
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth(); // 0-based

    // If there's a closed month, start the month after it
    const lastClosed = allMonths.find((m) => m.status === 'closed');
    if (lastClosed) {
      const endDate = new Date(lastClosed.end_date + 'T00:00:00');
      year = endDate.getFullYear();
      month = endDate.getMonth() + 1;
      if (month > 11) {
        month = 0;
        year++;
      }
    }

    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 0); // last day of month
    const monthName = startDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    try {
      const hdrs = await authHeaders();
      const res = await fetch('/api/admin/months/start', {
        method: 'POST',
        headers: hdrs,
        body: JSON.stringify({
          monthName,
          startDate: startDate.toISOString().slice(0, 10),
          endDate: endDate.toISOString().slice(0, 10),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || 'Failed to start new month.');
      } else {
        setMessage(`Month "${monthName}" started successfully!`);
        setShowStartModal(false);
        await loadData(session.user.id);
      }
    } catch (_) {
      setMessage('Network error starting month.');
    }
    setBusy(false);
  }

  /* ── computed values ───────────────────────────────── */

  const nameById = useMemo(
    () => Object.fromEntries(profiles.map((p) => [p.id, p.name])),
    [profiles]
  );

  const totals = useMemo(() => {
    const t = {};
    profiles.filter((p) => p.status !== 'inactive').forEach((p) => { t[p.name] = 0; });
    rows.forEach((r) => {
      const n = nameById[r.user_id] || 'Unknown';
      t[n] = (t[n] || 0) + Number(r.amount);
    });
    return t;
  }, [rows, nameById, profiles]);

  const s = useMemo(() => settlement(totals), [totals]);

  const people = useMemo(
    () => (profiles.length ? profiles.filter((p) => p.status !== 'inactive') : Object.keys(totals).map((name) => ({ id: name, name, role: 'member' }))),
    [profiles, totals]
  );

  /* ── loading / auth screens ────────────────────────── */

  if (loading) return <main className="center">Loading…</main>;

  if (!session) {
    return (
      <main className="auth">
        <div className="brand">
          <small>BAZAR MANAGER</small>
          <h1>Shared Bazar</h1>
          <p>Mobile-friendly shared grocery tracker.</p>
        </div>
        <div className="panel authbox">
          <h2>Login</h2>
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button onClick={login} disabled={busy}>
            {busy ? 'Please wait…' : 'Login'}
          </button>
          <a
            href="https://milon.cc"
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', marginTop: '15px', textDecoration: 'none', color: 'inherit' }}
          >
            <img src="/milon.jpg" alt="Mehedi Hasan Milon" style={{ width: '30px', height: '30px', borderRadius: '50%', objectFit: 'cover' }} />
            <span>Developed by Mehedi Hasan Milon</span>
          </a>
          {message && <p className="notice">{message}</p>}
        </div>
      </main>
    );
  }

  /* ── main app ──────────────────────────────────────── */

  return (
    <main>
      {/* ── HEADER ── */}
      <header>
        <div>
          <small>BAZAR MANAGER</small>
          <h1>Shared Bazar</h1>
          <p className="sub">
            Logged in as <b>{profile?.name || session.user.email}</b>
            {isAdmin ? ' · Admin' : ''}
          </p>
        </div>
        <button className="secondary" onClick={() => supabase.auth.signOut()}>
          Logout
        </button>
      </header>

      {/* ── NAV TABS ── */}
      <nav className="tabs">
        <button className={tab === 'dashboard' ? 'tab active' : 'tab'} onClick={() => setTab('dashboard')}>
          Dashboard
        </button>
        {isAdmin && (
          <button
            className={tab === 'members' ? 'tab active' : 'tab'}
            onClick={() => {
              setTab('members');
              loadMembers();
            }}
          >
            Members
          </button>
        )}
        <button
          className={tab === 'history' ? 'tab active' : 'tab'}
          onClick={() => setTab('history')}
        >
          History
        </button>
      </nav>

      {message && <p className="notice">{message}</p>}

      {/* ══════════════ DASHBOARD TAB ══════════════ */}
      {tab === 'dashboard' && (
        <>
          {/* Active month banner */}
          <section className="month-banner">
            <div className="month-info">
              <span className="month-label">Active Month</span>
              <strong className="month-name">
                {activeMonth ? activeMonth.month_name : 'No active month'}
              </strong>
              {activeMonth && (
                <span className="month-dates">
                  {activeMonth.start_date} — {activeMonth.end_date}
                </span>
              )}
            </div>
            {isAdmin && (
              <div className="month-actions">
                {activeMonth && (
                  <button className="danger-btn" onClick={() => setShowCloseModal(true)}>
                    Close Month
                  </button>
                )}
                {!activeMonth && (
                  <button onClick={() => setShowStartModal(true)}>Start New Month</button>
                )}
              </div>
            )}
          </section>

          {/* Hero totals */}
          <section className="hero">
            <div>
              <span>Monthly Total</span>
              <strong>{fmt(s.total)}</strong>
            </div>
            <div>
              <span>Per Person ({people.length} members)</span>
              <strong>{fmt(s.share)}</strong>
            </div>
          </section>

          {/* Member cards */}
          <section className="grid">
            {people.map((p) => (
              <article className="card" key={p.id}>
                <h2>{p.name}</h2>
                <p>
                  Paid <b>{fmt(totals[p.name] || 0)}</b>
                </p>
                <p className={(s.balances[p.name] || 0) >= 0 ? 'receive' : 'pay'}>
                  {(s.balances[p.name] || 0) >= 0 ? '↑ Receive' : '↓ Pay'}{' '}
                  <b>{fmt(Math.abs(s.balances[p.name] || 0))}</b>
                </p>
              </article>
            ))}
          </section>

          {/* Add entry form */}
          {activeMonth && (
            <section className="panel">
              <div className="sectionhead">
                <div>
                  <h2>Add Bazar</h2>
                  <p className="muted">
                    After submission, your entry is locked. Admin approval is required for corrections.
                  </p>
                </div>
              </div>
              <form className="form" onSubmit={addEntry}>
                <input type="date" value={form.bazar_date} onChange={(e) => setForm({ ...form, bazar_date: e.target.value })} />
                <input placeholder="Bazar item" value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} required />
                <input placeholder="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                <input type="number" step="0.01" min="0" placeholder="Amount €" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
                <input placeholder="Notes (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                <button disabled={busy}>{busy ? 'Saving…' : 'Submit Bazar'}</button>
              </form>
            </section>
          )}

          {!activeMonth && (
            <section className="panel">
              <p className="muted">No active month. {isAdmin ? 'Start a new month to enable entries.' : 'Contact Admin to start a new month.'}</p>
            </section>
          )}

          {/* Who pays whom */}
          <section className="panel">
            <h2>Who Pays Whom</h2>
            {s.transactions.length ? (
              s.transactions.map((t, i) => (
                <div className="tx" key={i}>
                  <span>↓ {t.from}</span>
                  <b>{fmt(t.amount)}</b>
                  <span>↑ {t.to}</span>
                </div>
              ))
            ) : (
              <p className="muted">Everyone is settled.</p>
            )}
          </section>

          {/* All entries */}
          <section className="panel">
            <div className="sectionhead">
              <div>
                <h2>All Bazar Updates</h2>
                <p className="muted">Everyone can view every submitted entry.</p>
              </div>
            </div>
            <div className="table">
              {rows.map((r) => (
                <div className="row" key={r.id}>
                  <span>{r.bazar_date}</span>
                  <span>
                    <b>{nameById[r.user_id] || 'Unknown'}</b>
                    <br />
                    {r.item}
                    {r.category ? ` · ${r.category}` : ''}
                  </span>
                  <strong>{fmt(r.amount)}</strong>
                  {isAdmin && (
                    <span className="actions">
                      <button className="tiny" onClick={() => setEditing({ ...r })}>
                        Edit
                      </button>
                      <button className="tiny danger" onClick={() => adminDelete(r.id)}>
                        Delete
                      </button>
                    </span>
                  )}
                </div>
              ))}
              {!rows.length && <p className="muted">No entries yet.</p>}
            </div>
          </section>
        </>
      )}

      {/* ══════════════ MEMBERS TAB (Admin) ══════════════ */}
      {tab === 'members' && isAdmin && (
        <MembersTab
          memberList={memberList}
          profiles={profiles}
          rows={rows}
          nameById={nameById}
          showMemberModal={showMemberModal}
          setShowMemberModal={setShowMemberModal}
          memberForm={memberForm}
          setMemberForm={setMemberForm}
          createMember={createMember}
          busy={busy}
        />
      )}

      {/* ══════════════ HISTORY TAB ══════════════ */}
      {tab === 'history' && !historyMonth && (
        <HistoryList
          allMonths={allMonths}
          onSelect={(m) => {
            setHistoryMonth(m);
            setTab('historyDetail');
          }}
        />
      )}

      {tab === 'historyDetail' && historyMonth && (
        <HistoryDetail
          month={historyMonth}
          onBack={() => {
            setHistoryMonth(null);
            setTab('history');
          }}
        />
      )}

      {/* ── EDIT ENTRY MODAL ── */}
      {isAdmin && editing && (
        <div className="modal">
          <form className="panel modalbox" onSubmit={adminSave}>
            <div className="sectionhead">
              <h2>Edit Entry</h2>
              <button type="button" className="secondary" onClick={() => setEditing(null)}>
                Close
              </button>
            </div>
            <input type="date" value={editing.bazar_date} onChange={(e) => setEditing({ ...editing, bazar_date: e.target.value })} />
            <input value={editing.item} onChange={(e) => setEditing({ ...editing, item: e.target.value })} />
            <input value={editing.category || ''} onChange={(e) => setEditing({ ...editing, category: e.target.value })} />
            <input type="number" step="0.01" value={editing.amount} onChange={(e) => setEditing({ ...editing, amount: e.target.value })} />
            <textarea value={editing.notes || ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            <button disabled={busy}>Save Admin Change</button>
          </form>
        </div>
      )}

      {/* ── CLOSE MONTH MODAL ── */}
      {showCloseModal && (
        <div className="modal">
          <div className="panel modalbox">
            <div className="sectionhead">
              <h2>Close Month</h2>
              <button type="button" className="secondary" onClick={() => setShowCloseModal(false)}>
                Cancel
              </button>
            </div>
            <div className="confirm-content">
              <p>
                Are you sure you want to close <b>{activeMonth?.month_name}</b>?
              </p>
              <p className="muted">This action cannot be undone. All entries will be locked and a final settlement will be calculated.</p>
              <div className="confirm-summary">
                <div>
                  <span>Total:</span> <b>{fmt(s.total)}</b>
                </div>
                <div>
                  <span>Members:</span> <b>{people.length}</b>
                </div>
                <div>
                  <span>Per Person:</span> <b>{fmt(s.share)}</b>
                </div>
              </div>
            </div>
            <button className="danger-btn" onClick={closeMonth} disabled={busy}>
              {busy ? 'Closing…' : 'Confirm Close Month'}
            </button>
          </div>
        </div>
      )}

      {/* ── START MONTH MODAL ── */}
      {showStartModal && (
        <div className="modal">
          <div className="panel modalbox">
            <div className="sectionhead">
              <h2>Start New Month</h2>
              <button type="button" className="secondary" onClick={() => setShowStartModal(false)}>
                Cancel
              </button>
            </div>
            <p>Start a fresh bazar accounting period. All totals will begin at zero.</p>
            <p className="muted">The month dates will be calculated automatically based on the calendar.</p>
            <button onClick={startNewMonth} disabled={busy}>
              {busy ? 'Starting…' : 'Start New Month'}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

/* ══════════════════════════════════════════════════════
   MEMBERS TAB COMPONENT
   ══════════════════════════════════════════════════════ */

function MembersTab({ memberList, profiles, rows, nameById, showMemberModal, setShowMemberModal, memberForm, setMemberForm, createMember, busy }) {
  // Calculate per-member totals from current rows
  const memberTotals = useMemo(() => {
    const t = {};
    rows.forEach((r) => {
      t[r.user_id] = (t[r.user_id] || 0) + Number(r.amount);
    });
    return t;
  }, [rows]);

  const displayList = memberList.length ? memberList : profiles;

  return (
    <>
      <section className="panel">
        <div className="sectionhead">
          <h2>Member Management</h2>
          <button onClick={() => setShowMemberModal(true)}>+ Add Member</button>
        </div>

        <div className="member-table">
          <div className="member-header">
            <span>Name</span>
            <span>Email</span>
            <span className="hide-mobile">WhatsApp</span>
            <span>Role</span>
            <span className="hide-mobile">Created</span>
            <span>Month Total</span>
          </div>
          {displayList.map((m) => (
            <div className="member-row" key={m.id}>
              <span><b>{m.name}</b></span>
              <span className="truncate">{m.email || '—'}</span>
              <span className="hide-mobile">{m.whatsapp || '—'}</span>
              <span>
                <span className={`badge ${m.role === 'admin' ? 'badge-admin' : 'badge-member'}`}>
                  {m.role}
                </span>
              </span>
              <span className="hide-mobile muted">
                {m.created_at ? new Date(m.created_at).toLocaleDateString() : '—'}
              </span>
              <span><b>{fmt(memberTotals[m.id] || 0)}</b></span>
            </div>
          ))}
          {!displayList.length && <p className="muted">No members found.</p>}
        </div>
      </section>

      {/* CREATE MEMBER MODAL */}
      {showMemberModal && (
        <div className="modal">
          <form className="panel modalbox" onSubmit={createMember}>
            <div className="sectionhead">
              <h2>Create New Member</h2>
              <button type="button" className="secondary" onClick={() => setShowMemberModal(false)}>
                Close
              </button>
            </div>
            <input placeholder="Full Name" value={memberForm.name} onChange={(e) => setMemberForm({ ...memberForm, name: e.target.value })} required />
            <input type="email" placeholder="Email Address" value={memberForm.email} onChange={(e) => setMemberForm({ ...memberForm, email: e.target.value })} required />
            <input type="password" placeholder="Password (min 6 chars)" value={memberForm.password} onChange={(e) => setMemberForm({ ...memberForm, password: e.target.value })} required />
            <input type="password" placeholder="Confirm Password" value={memberForm.confirmPassword} onChange={(e) => setMemberForm({ ...memberForm, confirmPassword: e.target.value })} required />
            <input placeholder="WhatsApp Number (optional)" value={memberForm.whatsapp} onChange={(e) => setMemberForm({ ...memberForm, whatsapp: e.target.value })} />
            <button disabled={busy}>{busy ? 'Creating…' : 'Create Member'}</button>
          </form>
        </div>
      )}
    </>
  );
}

/* ══════════════════════════════════════════════════════
   HISTORY LIST COMPONENT
   ══════════════════════════════════════════════════════ */

function HistoryList({ allMonths, onSelect }) {
  const closedMonths = allMonths.filter((m) => m.status === 'closed');

  return (
    <section className="panel">
      <h2>Monthly History</h2>
      {closedMonths.length ? (
        <div className="history-list">
          {closedMonths.map((m) => (
            <div className="history-item" key={m.id} onClick={() => onSelect(m)}>
              <div className="history-main">
                <strong>{m.month_name}</strong>
                <span className="badge badge-closed">Closed</span>
              </div>
              <div className="history-details">
                <span>Total: <b>{fmt(m.total_amount)}</b></span>
                <span>Members: <b>{m.total_members}</b></span>
                <span>Share: <b>{fmt(m.per_person_share)}</b></span>
              </div>
              <div className="history-date muted">
                Closed: {m.closed_at ? new Date(m.closed_at).toLocaleDateString() : '—'}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No closed months yet.</p>
      )}
    </section>
  );
}

/* ══════════════════════════════════════════════════════
   HISTORY DETAIL COMPONENT
   ══════════════════════════════════════════════════════ */

function HistoryDetail({ month, onBack }) {
  const snap = month.settlement_snapshot || {};
  const snapTotals = snap.totals || {};
  const snapSettlement = snap.settlement || { total: 0, share: 0, balances: {}, transactions: [] };
  const snapMembers = snap.members || [];
  const snapEntries = snap.entries || [];

  return (
    <section>
      <button className="secondary" onClick={onBack} style={{ marginBottom: 14 }}>
        ← Back to History
      </button>

      <div className="panel">
        <h2>{month.month_name}</h2>
        <div className="history-meta">
          <span className="badge badge-closed">Closed</span>
          {month.closed_at && (
            <span className="muted">Closed on {new Date(month.closed_at).toLocaleString()}</span>
          )}
          {snap.closed_by_name && (
            <span className="muted">by {snap.closed_by_name}</span>
          )}
        </div>
      </div>

      {/* Totals */}
      <section className="hero" style={{ marginTop: 14 }}>
        <div>
          <span>Monthly Total</span>
          <strong>{fmt(snapSettlement.total)}</strong>
        </div>
        <div>
          <span>Per Person ({month.total_members} members)</span>
          <strong>{fmt(snapSettlement.share)}</strong>
        </div>
      </section>

      {/* Member breakdown */}
      <section className="grid" style={{ marginTop: 14 }}>
        {snapMembers.map((m) => (
          <article className="card" key={m.id}>
            <h2>{m.name}</h2>
            <p>
              Paid <b>{fmt(snapTotals[m.name] || 0)}</b>
            </p>
            <p className={(snapSettlement.balances[m.name] || 0) >= 0 ? 'receive' : 'pay'}>
              {(snapSettlement.balances[m.name] || 0) >= 0 ? '↑ Receive' : '↓ Pay'}{' '}
              <b>{fmt(Math.abs(snapSettlement.balances[m.name] || 0))}</b>
            </p>
          </article>
        ))}
      </section>

      {/* Who pays whom */}
      <section className="panel" style={{ marginTop: 14 }}>
        <h2>Settlement</h2>
        {snapSettlement.transactions?.length ? (
          snapSettlement.transactions.map((t, i) => (
            <div className="tx" key={i}>
              <span>↓ {t.from}</span>
              <b>{fmt(t.amount)}</b>
              <span>↑ {t.to}</span>
            </div>
          ))
        ) : (
          <p className="muted">Everyone was settled.</p>
        )}
      </section>

      {/* Individual entries */}
      <section className="panel" style={{ marginTop: 14 }}>
        <h2>All Entries</h2>
        <div className="table">
          {snapEntries.map((r) => (
            <div className="row" key={r.id}>
              <span>{r.bazar_date}</span>
              <span>
                <b>{r.person || 'Unknown'}</b>
                <br />
                {r.item}
                {r.category ? ` · ${r.category}` : ''}
              </span>
              <strong>{fmt(r.amount)}</strong>
            </div>
          ))}
          {!snapEntries.length && <p className="muted">No entries recorded.</p>}
        </div>
      </section>
    </section>
  );
}
