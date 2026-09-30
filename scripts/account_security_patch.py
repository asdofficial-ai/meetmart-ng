from pathlib import Path

def must_replace(text, old, new, label):
    if old not in text:
        raise SystemExit(f'Missing anchor: {label}')
    return text.replace(old, new, 1)

# config
p=Path('server/config.js'); s=p.read_text()
s=must_replace(s,"  identityMode: process.env.IDENTITY_PROVIDER_MODE || 'demo',\n  asdPayMode: process.env.ASD_PAY_MODE || 'demo',","  identityMode: process.env.IDENTITY_PROVIDER_MODE || 'demo',\n  emailMode: process.env.EMAIL_PROVIDER_MODE || 'demo',\n  asdPayMode: process.env.ASD_PAY_MODE || 'demo',",'config email mode')
s=must_replace(s,"  if (config.identityMode === 'demo') warnings.push('Identity verification is in demo mode.');\n  if (config.asdPayMode === 'demo') warnings.push('ASD Pay is in demo mode; no real money moves.');","  if (config.identityMode === 'demo') warnings.push('Identity verification is in demo mode.');\n  if (config.emailMode === 'demo') warnings.push('Email verification/password recovery is in demo mode; staging shows codes instead of emailing them.');\n  if (config.asdPayMode === 'demo') warnings.push('ASD Pay is in demo mode; no real money moves.');",'config warning')
p.write_text(s)

# db
p=Path('server/db.js'); s=p.read_text()
anchor="try { db.exec('ALTER TABLE merchants ADD COLUMN delivery_fee INTEGER NOT NULL DEFAULT 0'); } catch {}\n"
addition="""try { db.exec('ALTER TABLE merchants ADD COLUMN delivery_fee INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN profile_updated_at TEXT'); } catch {}

db.exec(`
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_codes(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS password_reset_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_codes(user_id,created_at DESC);
`);
"""
s=must_replace(s,anchor,addition,'db account tables')
p.write_text(s)

# backend
p=Path('server/index.js'); s=p.read_text()
s=must_replace(s,"  const row=db.prepare(`SELECT u.id,u.email,u.display_name,u.city,u.role,u.status,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hashToken(token));","  const row=db.prepare(`SELECT u.id,u.email,u.display_name,u.city,u.role,u.status,u.email_verified_at,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hashToken(token));",'session query')
s=must_replace(s,"  return {id:row.id,email:row.email,displayName:row.display_name,city:row.city,role:row.role};","  return {id:row.id,email:row.email,displayName:row.display_name,city:row.city,role:row.role,emailVerified:Boolean(row.email_verified_at)};",'current user')
helper="function requireUser(req){ const user=getCurrentUser(req); if(!user) throw Object.assign(new Error('Authentication required.'),{status:401}); return user; }"
helper_new="""function requireUser(req){ const user=getCurrentUser(req); if(!user) throw Object.assign(new Error('Authentication required.'),{status:401}); return user; }
function sixDigitCode(){ return String(crypto.randomInt(0,1_000_000)).padStart(6,'0'); }
function codeExpires(minutes=15){ return new Date(Date.now()+minutes*60_000).toISOString(); }
function validCode(value){ return /^\\d{6}$/.test(String(value||'')); }
function accountUserById(id){ return db.prepare('SELECT id,email,display_name,city,role,status,email_verified_at,created_at FROM users WHERE id=?').get(id); }
function publicAccountUser(row){ return row?{id:row.id,email:row.email,displayName:row.display_name,city:row.city,role:row.role,emailVerified:Boolean(row.email_verified_at),createdAt:row.created_at}:null; }
"""
s=must_replace(s,helper,helper_new,'account helpers')

signup="  if(req.method==='POST'&&url.pathname==='/auth/signup'){"
routes=r'''  if(req.method==='POST'&&url.pathname==='/auth/email-verification/request'){
    const user=requireUser(req); const row=accountUserById(user.id);
    if(row?.email_verified_at) return json(res,200,{ok:true,alreadyVerified:true},cors);
    const code=sixDigitCode(), now=nowIso(), expiresAt=codeExpires(15);
    db.prepare('DELETE FROM email_verification_codes WHERE user_id=? AND used_at IS NULL').run(user.id);
    db.prepare('INSERT INTO email_verification_codes(id,user_id,code_hash,expires_at,used_at,created_at) VALUES(?,?,?,?,?,?)').run(randomId('evc_'),user.id,hashToken(code),expiresAt,null,now);
    audit(user.id,'auth.email_verification.request','user',user.id,{mode:config.emailMode});
    return json(res,200,{ok:true,expiresInMinutes:15,delivery:config.emailMode,demoCode:config.emailMode==='demo'?code:undefined},cors);
  }
  if(req.method==='POST'&&url.pathname==='/auth/email-verification/confirm'){
    const user=requireUser(req); const body=await readBody(req); const code=String(body.code||'').trim();
    if(!validCode(code)) throw Object.assign(new Error('Enter the 6-digit verification code.'),{status:400});
    const row=db.prepare('SELECT * FROM email_verification_codes WHERE user_id=? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1').get(user.id);
    if(!row||new Date(row.expires_at).getTime()<=Date.now()||hashToken(code)!==row.code_hash) throw Object.assign(new Error('Verification code is invalid or expired.'),{status:400});
    const now=nowIso(); db.prepare('UPDATE users SET email_verified_at=?,profile_updated_at=? WHERE id=?').run(now,now,user.id); db.prepare('UPDATE email_verification_codes SET used_at=? WHERE id=?').run(now,row.id);
    audit(user.id,'auth.email_verification.confirm','user',user.id); return json(res,200,{ok:true,user:publicAccountUser(accountUserById(user.id))},cors);
  }
  if(req.method==='POST'&&url.pathname==='/auth/password/forgot'){
    const body=await readBody(req); const email=sanitizeEmail(body.email); const row=db.prepare("SELECT * FROM users WHERE email=? AND status='active'").get(email); let demoCode;
    if(row){const code=sixDigitCode(),now=nowIso(),expiresAt=codeExpires(15);db.prepare('DELETE FROM password_reset_codes WHERE user_id=? AND used_at IS NULL').run(row.id);db.prepare('INSERT INTO password_reset_codes(id,user_id,code_hash,expires_at,used_at,created_at) VALUES(?,?,?,?,?,?)').run(randomId('prc_'),row.id,hashToken(code),expiresAt,null,now);audit(row.id,'auth.password_reset.request','user',row.id,{mode:config.emailMode});if(config.emailMode==='demo')demoCode=code;}
    return json(res,200,{ok:true,message:'If an active MeetMart account uses that email, a reset code has been created.',delivery:config.emailMode,demoCode},cors);
  }
  if(req.method==='POST'&&url.pathname==='/auth/password/reset'){
    const body=await readBody(req); const email=sanitizeEmail(body.email); const code=String(body.code||'').trim(); const newPassword=String(body.newPassword||'');
    if(!validCode(code)) throw Object.assign(new Error('Enter the 6-digit reset code.'),{status:400}); const userRow=db.prepare("SELECT * FROM users WHERE email=? AND status='active'").get(email); if(!userRow) throw Object.assign(new Error('Reset code is invalid or expired.'),{status:400});
    const reset=db.prepare('SELECT * FROM password_reset_codes WHERE user_id=? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1').get(userRow.id); if(!reset||new Date(reset.expires_at).getTime()<=Date.now()||hashToken(code)!==reset.code_hash) throw Object.assign(new Error('Reset code is invalid or expired.'),{status:400});
    const passwordHash=await hashPassword(newPassword),now=nowIso(); db.prepare('UPDATE users SET password_hash=?,profile_updated_at=? WHERE id=?').run(passwordHash,now,userRow.id);db.prepare('UPDATE password_reset_codes SET used_at=? WHERE id=?').run(now,reset.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(userRow.id);audit(userRow.id,'auth.password_reset.complete','user',userRow.id);return json(res,200,{ok:true,message:'Password reset. Sign in with your new password.'},{...cors,'set-cookie':sessionCookie('',0)});
  }
  if(req.method==='GET'&&url.pathname==='/account/security'){
    const user=requireUser(req); const row=accountUserById(user.id); const activeSessions=Number(db.prepare('SELECT COUNT(*) count FROM sessions WHERE user_id=? AND expires_at>?').get(user.id,nowIso())?.count||0); return json(res,200,{user:publicAccountUser(row),security:{emailVerified:Boolean(row.email_verified_at),activeSessions,cityLocked:true}},cors);
  }
  if(req.method==='PATCH'&&url.pathname==='/account/profile'){
    const user=requireUser(req); const body=await readBody(req); const displayName=String(body.displayName||'').trim(); if(displayName.length<2||displayName.length>60) throw Object.assign(new Error('Display name must be between 2 and 60 characters.'),{status:400}); db.prepare('UPDATE users SET display_name=?,profile_updated_at=? WHERE id=?').run(displayName,nowIso(),user.id);audit(user.id,'account.profile.update','user',user.id);return json(res,200,{user:publicAccountUser(accountUserById(user.id))},cors);
  }
  if(req.method==='POST'&&url.pathname==='/account/password'){
    const user=requireUser(req); const body=await readBody(req); const currentPassword=String(body.currentPassword||''); const newPassword=String(body.newPassword||''); const row=db.prepare('SELECT * FROM users WHERE id=?').get(user.id); if(!row||!(await verifyPassword(currentPassword,row.password_hash))) throw Object.assign(new Error('Current password is incorrect.'),{status:401}); if(currentPassword===newPassword) throw Object.assign(new Error('Choose a different new password.'),{status:400}); const passwordHash=await hashPassword(newPassword),now=nowIso();db.prepare('UPDATE users SET password_hash=?,profile_updated_at=? WHERE id=?').run(passwordHash,now,user.id);const currentToken=parseCookies(req)[config.cookieName];if(currentToken)db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(user.id,hashToken(currentToken));audit(user.id,'account.password.change','user',user.id);return json(res,200,{ok:true,message:'Password changed. Other signed-in devices were logged out.'},cors);
  }
  if(req.method==='POST'&&url.pathname==='/auth/logout-all'){
    const user=requireUser(req); db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);audit(user.id,'auth.logout_all','user',user.id);return json(res,200,{ok:true},{...cors,'set-cookie':sessionCookie('',0)});
  }

'''
s=must_replace(s,signup,routes+signup,'security routes')
s=must_replace(s,"return json(res,201,{user:{id,email,displayName,city,role:'marketplace_user'}},{...cors,'set-cookie':sessionCookie(token,Math.floor(config.sessionTtlMs/1000))});","return json(res,201,{user:{id,email,displayName,city,role:'marketplace_user',emailVerified:false}},{...cors,'set-cookie':sessionCookie(token,Math.floor(config.sessionTtlMs/1000))});",'signup response')
s=must_replace(s,"return json(res,200,{user:{id:row.id,email:row.email,displayName:row.display_name,city:row.city,role:row.role}},{...cors,'set-cookie':sessionCookie(token,Math.floor(config.sessionTtlMs/1000))});","return json(res,200,{user:{id:row.id,email:row.email,displayName:row.display_name,city:row.city,role:row.role,emailVerified:Boolean(row.email_verified_at)}},{...cors,'set-cookie':sessionCookie(token,Math.floor(config.sessionTtlMs/1000))});",'login response')
p.write_text(s)

# api
p=Path('src/services/api.js'); s=p.read_text()
anchor="  logout: () => request('/auth/logout',{method:'POST',body:{}}),\n"
add="""  logout: () => request('/auth/logout',{method:'POST',body:{}}),
  logoutAll: () => request('/auth/logout-all',{method:'POST',body:{}}),
  requestEmailVerification: () => request('/auth/email-verification/request',{method:'POST',body:{}}),
  confirmEmailVerification: code => request('/auth/email-verification/confirm',{method:'POST',body:{code}}),
  forgotPassword: email => request('/auth/password/forgot',{method:'POST',body:{email}}),
  resetPassword: data => request('/auth/password/reset',{method:'POST',body:data}),
  getAccountSecurity: () => request('/account/security'),
  updateProfile: data => request('/account/profile',{method:'PATCH',body:data}),
  changePassword: data => request('/account/password',{method:'POST',body:data}),
"""
s=must_replace(s,anchor,add,'api methods');p.write_text(s)

# app: replace Auth, add AccountSecurity, route, profile link
p=Path('src/App.jsx'); s=p.read_text()
a=s.index('function Auth(){'); b=s.index('\nfunction SearchPage(){',a)
new_auth=r'''function Auth(){
 const [mode,setMode]=useState('signup'); const [displayName,setDisplayName]=useState(''); const [email,setEmail]=useState(''); const [password,setPassword]=useState(''); const [resetCode,setResetCode]=useState(''); const [newPassword,setNewPassword]=useState(''); const [demoCode,setDemoCode]=useState(''); const [notice,setNotice]=useState(''); const [error,setError]=useState(''); const [busy,setBusy]=useState(false); const {user,signup,login,logout}=useAuth(); const navigate=useNavigate();
 const submit=async()=>{setError('');setNotice('');setBusy(true);try{if(mode==='signup')await signup({displayName,email,password,city:getSelectedCity()});else await login({email,password});navigate('/profile');}catch(err){setError(err.message||'Authentication failed.')}finally{setBusy(false)}};
 const requestReset=async()=>{setError('');setNotice('');setDemoCode('');setBusy(true);try{const r=await api.forgotPassword(email);setNotice(r.message||'Reset request created.');if(r.demoCode)setDemoCode(r.demoCode);setMode('reset');}catch(err){setError(err.message)}finally{setBusy(false)}};
 const completeReset=async()=>{setError('');setNotice('');setBusy(true);try{const r=await api.resetPassword({email,code:resetCode,newPassword});setNotice(r.message||'Password reset.');setPassword('');setNewPassword('');setResetCode('');setDemoCode('');setMode('login');}catch(err){setError(err.message)}finally{setBusy(false)}};
 if(user)return <Shell><div className="page auth-page"><section className="auth-card"><h1>You’re signed in</h1><p><b>{user.displayName}</b><br/>{user.email}<br/>{user.city} • {user.role}</p><div className="request-actions"><Link className="btn primary" to="/profile">Open profile</Link><Link className="btn ghost" to="/account/security">Account security</Link><button className="btn ghost" onClick={async()=>{await logout();}}>Log out</button></div></section><section className="auth-brand"><span className="eyebrow">MEETMART ACCOUNT</span><h1>One account.<br/><em>Marketplace + Stores.</em></h1><p>Your server-side session protects identity checks, merchant applications and future ASD Pay actions.</p></section></div></Shell>;
 return <Shell><div className="auth-page page"><section className="auth-card">{!['forgot','reset'].includes(mode)&&<div className="tabs"><button onClick={()=>{setMode('login');setError('');setNotice('')}} className={mode==='login'?'active':''}>Log In</button><button onClick={()=>{setMode('signup');setError('');setNotice('')}} className={mode==='signup'?'active':''}>Sign Up</button></div>}<h1>{mode==='signup'?'Create your account':mode==='login'?'Welcome back':mode==='forgot'?'Reset your password':'Enter reset code'}</h1><p>{mode==='signup'?'Create a MeetMart account stored by the backend.':mode==='login'?'Log in to continue to MeetMart NG.':mode==='forgot'?'Enter your account email. We will create a short-lived reset code.':'Enter the 6-digit reset code and choose a new password.'}</p>{mode==='signup'&&<div className="signup-city-warning"><span className="signup-city-icon"><MapPin size={20}/></span><div><b>Please choose the correct city before signing up</b><p>Your marketplace account will be locked to <strong>{getSelectedCity()}</strong> for same-city safety. Use the city button at the top of this page if you need to change it.</p></div></div>}{mode==='signup'&&<div className="field"><span>👤</span><input value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="Your full/display name" autoComplete="name"/></div>}<div className="field"><span>✉</span><input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Enter your email address" type="email" autoComplete="email"/></div>}{['signup','login'].includes(mode)&&<div className="field"><span>🔒</span><input value={password} onChange={e=>setPassword(e.target.value)} placeholder={mode==='signup'?'Create a password (8+ characters)':'Enter your password'} type="password" autoComplete={mode==='signup'?'new-password':'current-password'}/></div>}{mode==='reset'&&<><div className="field"><span>🔢</span><input value={resetCode} onChange={e=>setResetCode(e.target.value.replace(/\D/g,'').slice(0,6))} placeholder="6-digit reset code" inputMode="numeric"/></div><div className="field"><span>🔒</span><input value={newPassword} onChange={e=>setNewPassword(e.target.value)} placeholder="New password (8+ characters)" type="password" autoComplete="new-password"/></div></>}{demoCode&&<div className="demo-code-box"><b>Staging demo code</b><strong>{demoCode}</strong><small>Real deployment will email this code instead of displaying it.</small></div>}{error&&<div className="checkout-error">{error}</div>}{notice&&<div className="success-notice"><CheckCircle2/>{notice}</div>}{['signup','login'].includes(mode)?<button className="btn primary full" disabled={busy} onClick={submit}>{busy?'Please wait…':mode==='signup'?'Create account':'Log in'} <ArrowRight size={16}/></button>:mode==='forgot'?<button className="btn primary full" disabled={busy||!email} onClick={requestReset}>{busy?'Creating code…':'Send reset code'}</button>:<button className="btn primary full" disabled={busy||resetCode.length!==6||newPassword.length<8} onClick={completeReset}>{busy?'Resetting…':'Reset password'}</button>}{mode==='login'&&<button className="auth-text-action" onClick={()=>{setMode('forgot');setError('');setNotice('')}}>Forgot your password?</button>}{['forgot','reset'].includes(mode)&&<button className="auth-text-action" onClick={()=>{setMode('login');setError('');setNotice('');setDemoCode('')}}>Back to login</button>}<div className="or">SERVER SESSION</div><p className="privacy-note"><LockKeyhole size={14}/>Passwords are hashed on the backend. Reset and verification codes are stored only as hashes and expire after 15 minutes.</p></section><section className="auth-brand"><span className="eyebrow">WELCOME TO MEETMART NG</span><h1>Great Deals.<br/><em>Near You.</em></h1><p>Trusted buying and selling within your city. Real people. Real items. Safer meetups.</p><div className="onboarding"><b>Account protection</b><div className="onboarding-grid">{[['1','Choose city'],['2','Verify email'],['3','Identity'],['4','Profile'],['5','Safety tips']].map(x=><div key={x[0]}><span>{x[0]}</span><b>{x[1]}</b></div>)}</div></div></section></div></Shell>
}
'''
s=s[:a]+new_auth+s[b:]
profile='function Profile(){'
account=r'''function AccountSecurity(){
 const {user,refresh,logout}=useAuth(); const [security,setSecurity]=useState(null); const [displayName,setDisplayName]=useState(user?.displayName||''); const [code,setCode]=useState(''); const [demoCode,setDemoCode]=useState(''); const [currentPassword,setCurrentPassword]=useState(''); const [newPassword,setNewPassword]=useState(''); const [notice,setNotice]=useState(''); const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
 const load=async()=>{if(!user)return;try{const r=await api.getAccountSecurity();setSecurity(r);setDisplayName(r.user?.displayName||user.displayName||'')}catch(err){setError(err.message)}}; useEffect(()=>{load()},[user?.id]);
 if(!user)return <Shell><div className="page empty-orders"><LockKeyhole/><h2>Sign in to manage account security</h2><Link className="btn primary" to="/auth">Log in</Link></div></Shell>;
 const sendVerification=async()=>{setBusy(true);setError('');setNotice('');setDemoCode('');try{const r=await api.requestEmailVerification();if(r.alreadyVerified){setNotice('Your email is already verified.');await load();return}if(r.demoCode)setDemoCode(r.demoCode);setNotice('Verification code created. It expires in 15 minutes.')}catch(err){setError(err.message)}finally{setBusy(false)}};
 const confirmVerification=async()=>{setBusy(true);setError('');setNotice('');try{await api.confirmEmailVerification(code);setCode('');setDemoCode('');setNotice('Email verified successfully.');await refresh();await load()}catch(err){setError(err.message)}finally{setBusy(false)}};
 const saveProfile=async()=>{setBusy(true);setError('');setNotice('');try{await api.updateProfile({displayName});setNotice('Profile name updated.');await refresh();await load()}catch(err){setError(err.message)}finally{setBusy(false)}};
 const changePassword=async()=>{setBusy(true);setError('');setNotice('');try{const r=await api.changePassword({currentPassword,newPassword});setCurrentPassword('');setNewPassword('');setNotice(r.message||'Password changed.');await load()}catch(err){setError(err.message)}finally{setBusy(false)}};
 const logoutEverywhere=async()=>{if(!window.confirm('Log out this account on every device, including this one?'))return;setBusy(true);try{await api.logoutAll();await logout();window.location.href='/auth'}catch(err){setError(err.message)}finally{setBusy(false)}};
 const verified=Boolean(security?.security?.emailVerified||user.emailVerified);
 return <Shell><div className="page account-security-page"><section className="seller-tools-hero"><div><span className="eyebrow">ACCOUNT & SECURITY</span><h1>Protect your MeetMart account</h1><p>Manage your profile name, email verification, password and sessions. Your marketplace city stays locked for same-city safety.</p></div><div className="current-plan-card"><LockKeyhole/><small>Security status</small><strong>{verified?'Email verified':'Email verification pending'}</strong><span>{security?.security?.activeSessions||1} active session{Number(security?.security?.activeSessions||1)===1?'':'s'}</span></div></section>{error&&<div className="checkout-error">{error}</div>}{notice&&<div className="success-notice"><CheckCircle2/>{notice}</div>}<div className="account-security-grid"><section className="checkout-card"><h2>Profile</h2><label>Display name<input value={displayName} maxLength={60} onChange={e=>setDisplayName(e.target.value)}/></label><label>Email<input value={user.email} disabled/></label><label>Marketplace city<input value={user.city} disabled/></label><div className="city-lock-note"><LockKeyhole size={16}/><span><b>{user.city} is your account city.</b><small>City changes are disabled to prevent location-switching abuse.</small></span></div><button className="btn primary full" disabled={busy||displayName.trim().length<2} onClick={saveProfile}>Save profile</button></section><section className="checkout-card"><h2>Email verification</h2><p>{verified?'Your account email has been verified.':'Verify your email so recovery and future security alerts can be trusted.'}</p>{!verified&&<><button className="btn ghost full" disabled={busy} onClick={sendVerification}>Create verification code</button>{demoCode&&<div className="demo-code-box"><b>Staging demo code</b><strong>{demoCode}</strong><small>In production this will be emailed instead.</small></div>}<label>Verification code<input value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,6))} inputMode="numeric" placeholder="6 digits"/></label><button className="btn primary full" disabled={busy||code.length!==6} onClick={confirmVerification}>Verify email</button></>}{verified&&<div className="security-ok"><CheckCircle2/>Verified email: {user.email}</div>}</section><section className="checkout-card"><h2>Change password</h2><label>Current password<input type="password" value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)} autoComplete="current-password"/></label><label>New password<input type="password" value={newPassword} onChange={e=>setNewPassword(e.target.value)} autoComplete="new-password" placeholder="8+ characters"/></label><button className="btn primary full" disabled={busy||!currentPassword||newPassword.length<8} onClick={changePassword}>Change password</button><small className="privacy-note"><LockKeyhole size={14}/>Changing your password signs out other devices while keeping this session active.</small></section><section className="checkout-card danger-zone"><h2>Sessions</h2><p>Use this if you think someone else has access to your account.</p><button className="btn ghost full" disabled={busy} onClick={logoutEverywhere}>Log out all devices</button></section></div></div></Shell>
}

'''
if profile not in s:raise SystemExit('Missing Profile anchor')
s=s.replace(profile,account+profile,1)
old='<Link className="btn ghost" to="/verification"><ShieldCheck size={16}/>{ninVerified?\'Manage identity checks\':\'Verify identity\'}</Link>'
if old in s:s=s.replace(old,old+'<Link className="btn ghost" to="/account/security"><LockKeyhole size={16}/>Account security</Link>',1)
route='<Route path="/profile" element={<Profile/>}/>'
if route not in s:raise SystemExit('Missing profile route')
s=s.replace(route,route+'<Route path="/account/security" element={<AccountSecurity/>}/>',1)
p.write_text(s)

# css
p=Path('src/styles.css');s=p.read_text();s+=r'''
/* Account security */
.auth-text-action{display:block;margin:12px auto 0;border:0;background:transparent;color:var(--green);font-weight:800;padding:8px}.demo-code-box{margin:14px 0;padding:14px;border:1px dashed #7ac9b0;border-radius:14px;background:linear-gradient(135deg,#ecfff8,#f5fffb);display:grid;gap:5px;text-align:center}.demo-code-box strong{font-size:28px;letter-spacing:.18em;color:var(--green)}.demo-code-box small{color:var(--muted)}.account-security-page{max-width:1200px}.account-security-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:18px}.account-security-grid .checkout-card{display:grid;gap:12px}.account-security-grid label{display:grid;gap:6px;font-weight:800}.account-security-grid input{padding:12px;border:1px solid var(--line);border-radius:10px;background:#fff}.account-security-grid input:disabled{background:#f4f7f8;color:#697586}.city-lock-note{display:flex;align-items:flex-start;gap:9px;padding:12px;border-radius:12px;background:#f7faf9;border:1px solid #dce9e4}.city-lock-note svg{color:var(--green);flex:none}.city-lock-note span{display:grid;gap:3px}.city-lock-note small{color:var(--muted);line-height:1.4}.security-ok{display:flex;gap:8px;align-items:center;padding:12px;border-radius:12px;background:#e9f8f2;color:#17634e;font-weight:800}.danger-zone{border-color:#f0caca!important;background:linear-gradient(180deg,#fff,#fff8f8)!important}@media(max-width:760px){.account-security-grid{grid-template-columns:1fr}.account-security-page .seller-tools-hero{grid-template-columns:1fr}.demo-code-box strong{font-size:24px}}
''';p.write_text(s)
print('Account security patch applied.')
