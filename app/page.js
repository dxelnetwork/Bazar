'use client';
import {useEffect,useMemo,useState} from 'react';
import {supabase} from '../lib/supabase';
import {settlement} from '../lib/settlement';

const emptyForm={bazar_date:new Date().toISOString().slice(0,10),item:'',category:'',amount:'',notes:''};

export default function Home(){
 const [session,setSession]=useState(null); const [profile,setProfile]=useState(null); const [profiles,setProfiles]=useState([]);
 const [rows,setRows]=useState([]); const [form,setForm]=useState(emptyForm); const [editing,setEditing]=useState(null);
 const [email,setEmail]=useState(''); const [password,setPassword]=useState(''); const [authMode,setAuthMode]=useState('login');
 const [loading,setLoading]=useState(true); const [busy,setBusy]=useState(false); const [message,setMessage]=useState('');
 const isAdmin=profile?.role==='admin';

 useEffect(()=>{let active=true;(async()=>{const {data:{session}}=await supabase.auth.getSession();if(!active)return;setSession(session);if(session) await loadData(session.user.id);setLoading(false);})();
  const {data:{subscription}}=supabase.auth.onAuthStateChange(async(_e,s)=>{setSession(s);if(s) await loadData(s.user.id); else {setProfile(null);setProfiles([]);setRows([])}});return()=>{active=false;subscription.unsubscribe()};},[]);

 async function loadData(uid){
  const [{data:p},{data:ps},{data:es,error}] = await Promise.all([
   supabase.from('profiles').select('*').eq('id',uid).single(),
   supabase.from('profiles').select('id,name,role').order('name'),
   supabase.from('bazar_entries').select('*').order('bazar_date',{ascending:false}).order('created_at',{ascending:false})
  ]);
  if(p)setProfile(p); if(ps)setProfiles(ps); if(error)setMessage(error.message); else setRows(es||[]);
 }
 async function auth(){setBusy(true);setMessage('');const fn=authMode==='login'?supabase.auth.signInWithPassword({email,password}):supabase.auth.signUp({email,password});const {error}=await fn;if(error)setMessage(error.message);else if(authMode==='signup')setMessage('Account created. If email confirmation is enabled, check your email.');setBusy(false)}
 async function addEntry(e){e.preventDefault();if(!session)return;setBusy(true);setMessage('');const payload={...form,amount:Number(form.amount),user_id:session.user.id};const {error}=await supabase.from('bazar_entries').insert(payload);if(error)setMessage(error.message);else {setForm(emptyForm);setMessage('Entry submitted and locked. Only Admin can change it.');await loadData(session.user.id);await syncEntry({...payload,id:'new'});}setBusy(false)}
 async function syncEntry(row){try{await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'upsert',entry:row,person:profiles.find(p=>p.id===row.user_id)?.name||profile?.name||'Unknown'})})}catch(e){console.warn('Sheet sync unavailable',e)}}
 async function adminSave(e){e.preventDefault();if(!isAdmin||!editing)return;setBusy(true);const {error}=await supabase.from('bazar_entries').update({...editing,amount:Number(editing.amount)}).eq('id',editing.id);if(error)setMessage(error.message);else {setMessage('Entry updated by Admin.');setEditing(null);await loadData(session.user.id);await syncEntry(editing)}setBusy(false)}
 async function adminDelete(id){if(!isAdmin||!confirm('Delete this bazar entry?'))return;setBusy(true);const {error}=await supabase.from('bazar_entries').delete().eq('id',id);if(error)setMessage(error.message);else {setMessage('Entry deleted by Admin.');await loadData(session.user.id);try{await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',entry:{id}})})}catch(e){}}setBusy(false)}

 const nameById=useMemo(()=>Object.fromEntries(profiles.map(p=>[p.id,p.name])),[profiles]);
 const totals=useMemo(()=>rows.reduce((a,r)=>{const n=nameById[r.user_id]||'Unknown';a[n]=(a[n]||0)+Number(r.amount);return a},{Shuvo:0,Rabbi:0,Milon:0}),[rows,nameById]);
 const s=settlement(totals); const people=profiles.length?profiles: Object.keys(totals).map(name=>({id:name,name,role:'member'}));
 if(loading)return <main className="center">Loading…</main>;
 if(!session)return <main className="auth"><div className="brand"><small>BAZAR MANAGER</small><h1>Shared Bazar</h1><p>Mobile-friendly shared grocery tracker.</p></div><div className="panel authbox"><h2>{authMode==='login'?'Login':'Create account'}</h2><input type="email" placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)}/><input type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)}/><button onClick={auth} disabled={busy}>{busy?'Please wait…':authMode==='login'?'Login':'Create account'}</button><a href="https://milon.cc" target="_blank" rel="noopener noreferrer" style={{display:'flex', alignItems:'center', justifyContent:'center', gap:'10px', marginTop:'15px', textDecoration:'none', color:'inherit'}}><img src="/milon.jpg" alt="Mehedi Hasan Milon" style={{width:'30px', height:'30px', borderRadius:'50%', objectFit:'cover'}} /><span>Developed by Mehedi Hasan Milon</span></a>{message&&<p className="notice">{message}</p>}</div></main>;
 return <main><header><div><small>BAZAR MANAGER</small><h1>Shared Bazar</h1><p className="sub">Logged in as <b>{profile?.name||session.user.email}</b>{isAdmin?' · Admin':''}</p></div><button className="secondary" onClick={()=>supabase.auth.signOut()}>Logout</button></header>
 <section className="hero"><div><span>Monthly Total</span><strong>€{s.total.toFixed(2)}</strong></div><div><span>Per Person</span><strong>€{s.share.toFixed(2)}</strong></div></section>
 <section className="grid">{people.map(p=><article className="card" key={p.id}><h2>{p.name}</h2><p>Paid <b>€{(totals[p.name]||0).toFixed(2)}</b></p><p className={(s.balances[p.name]||0)>=0?'receive':'pay'}>{(s.balances[p.name]||0)>=0?'↑ Receive':'↓ Pay'} <b>€{Math.abs(s.balances[p.name]||0).toFixed(2)}</b></p></article>)}</section>
 <section className="panel"><div className="sectionhead"><div><h2>Add Bazar</h2><p className="muted">After submission, your entry is locked. Admin approval is required for corrections.</p></div></div><form className="form" onSubmit={addEntry}><input type="date" value={form.bazar_date} onChange={e=>setForm({...form,bazar_date:e.target.value})}/><input placeholder="Bazar item" value={form.item} onChange={e=>setForm({...form,item:e.target.value})} required/><input placeholder="Category" value={form.category} onChange={e=>setForm({...form,category:e.target.value})}/><input type="number" step="0.01" min="0" placeholder="Amount €" value={form.amount} onChange={e=>setForm({...form,amount:e.target.value})} required/><input placeholder="Notes (optional)" value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})}/><button disabled={busy}>{busy?'Saving…':'Submit Bazar'}</button></form>{message&&<p className="notice">{message}</p>}</section>
 <section className="panel"><h2>Who Pays Whom</h2>{s.transactions.length?s.transactions.map((t,i)=><div className="tx" key={i}><span>↓ {t.from}</span><b>€{t.amount.toFixed(2)}</b><span>↑ {t.to}</span></div>):<p className="muted">Everyone is settled.</p>}</section>
 <section className="panel"><div className="sectionhead"><div><h2>All Bazar Updates</h2><p className="muted">Everyone can view every submitted entry.</p></div></div><div className="table">{rows.map(r=><div className="row" key={r.id}><span>{r.bazar_date}</span><span><b>{nameById[r.user_id]||'Unknown'}</b><br/>{r.item}{r.category?` · ${r.category}`:''}</span><strong>€{Number(r.amount).toFixed(2)}</strong>{isAdmin&&<span className="actions"><button className="tiny" onClick={()=>setEditing({...r})}>Edit</button><button className="tiny danger" onClick={()=>adminDelete(r.id)}>Delete</button></span>}</div>)}{!rows.length&&<p className="muted">No entries yet.</p>}</div></section>
 {isAdmin&&editing&&<div className="modal"><form className="panel modalbox" onSubmit={adminSave}><div className="sectionhead"><h2>Edit Entry</h2><button type="button" className="secondary" onClick={()=>setEditing(null)}>Close</button></div><input type="date" value={editing.bazar_date} onChange={e=>setEditing({...editing,bazar_date:e.target.value})}/><input value={editing.item} onChange={e=>setEditing({...editing,item:e.target.value})}/><input value={editing.category||''} onChange={e=>setEditing({...editing,category:e.target.value})}/><input type="number" step="0.01" value={editing.amount} onChange={e=>setEditing({...editing,amount:e.target.value})}/><textarea value={editing.notes||''} onChange={e=>setEditing({...editing,notes:e.target.value})}/><button disabled={busy}>Save Admin Change</button></form></div>}
 </main>
}
