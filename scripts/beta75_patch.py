from pathlib import Path


def read(path):
    return Path(path).read_text()

def write(path, text):
    Path(path).write_text(text)

def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'missing anchor: {label}')
    return text.replace(old, new, 1)

# ---------------------------------------------------------------------------
# Database: moderation, blocking and listing moderation state.
# ---------------------------------------------------------------------------
db_path='server/db.js'
db=read(db_path)
if 'CREATE TABLE IF NOT EXISTS user_blocks' not in db:
    db += r'''

// Beta trust & moderation extensions.
try { db.exec("ALTER TABLE marketplace_listings ADD COLUMN moderation_state TEXT NOT NULL DEFAULT 'clear'"); } catch {}

db.exec(`
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(blocker_user_id, blocked_user_id),
  CHECK(blocker_user_id <> blocked_user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id TEXT REFERENCES marketplace_listings(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','under_review','resolved','dismissed')),
  action_taken TEXT NOT NULL DEFAULT '',
  admin_note TEXT NOT NULL DEFAULT '',
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketplace_reports_status ON marketplace_reports(status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_reports_reported ON marketplace_reports(reported_user_id,created_at DESC);
`);
'''
write(db_path,db)

# ---------------------------------------------------------------------------
# Backend helpers and APIs.
# ---------------------------------------------------------------------------
server_path='server/index.js'
s=read(server_path)
helper_anchor="function requireAdmin(req){ const user=requireUser(req); if(user.role!=='admin') throw Object.assign(new Error('Admin access required.'),{status:403}); return user; }"
helpers=r'''function requireAdmin(req){ const user=requireUser(req); if(user.role!=='admin') throw Object.assign(new Error('Admin access required.'),{status:403}); return user; }

function usersBlocked(firstUserId,secondUserId){
  if(!firstUserId||!secondUserId||firstUserId===secondUserId) return false;
  return Boolean(db.prepare(`SELECT 1 FROM user_blocks WHERE (blocker_user_id=? AND blocked_user_id=?) OR (blocker_user_id=? AND blocked_user_id=?) LIMIT 1`).get(firstUserId,secondUserId,secondUserId,firstUserId));
}
function assertContactAllowed(firstUserId,secondUserId){
  if(usersBlocked(firstUserId,secondUserId)) throw Object.assign(new Error('Contact is blocked between these accounts.'),{status:403});
}
'''
if 'function usersBlocked(' not in s:
    s=replace_once(s,helper_anchor,helpers,'requireAdmin helper')

market_marker='  // --- Person-to-person marketplace API -----------------------------------'
moderation_routes=r'''  // --- Marketplace trust, blocking & moderation ---------------------------
  const marketplaceUserProfile=url.pathname.match(/^\/marketplace\/users\/([^/]+)\/profile$/);
  if(req.method==='GET'&&marketplaceUserProfile){
    const viewer=getCurrentUser(req); const targetId=marketplaceUserProfile[1];
    const row=db.prepare(`SELECT u.id,u.display_name,u.city,u.created_at,u.email_verified_at,u.role,
      (SELECT status FROM identity_verifications iv WHERE iv.user_id=u.id AND iv.type='nin' LIMIT 1) identity_status,
      (SELECT COUNT(*) FROM marketplace_listings l WHERE l.seller_user_id=u.id AND l.status='active') active_listings,
      (SELECT COUNT(*) FROM meetups m WHERE m.status='completed' AND (m.buyer_user_id=u.id OR m.seller_user_id=u.id)) completed_meetups,
      (SELECT COUNT(*) FROM marketplace_reviews r WHERE r.reviewee_user_id=u.id) review_count,
      (SELECT COALESCE(AVG(r.rating),0) FROM marketplace_reviews r WHERE r.reviewee_user_id=u.id) rating
      FROM users u WHERE u.id=? AND u.status='active'`).get(targetId);
    if(!row) throw Object.assign(new Error('Marketplace profile not found.'),{status:404});
    const listings=db.prepare("SELECT id,title,description,category,condition,price,city,area,image_url,status,created_at FROM marketplace_listings WHERE seller_user_id=? AND status='active' ORDER BY created_at DESC LIMIT 12").all(targetId);
    return json(res,200,{profile:{id:row.id,displayName:row.display_name,city:row.city,joinedAt:row.created_at,emailVerified:Boolean(row.email_verified_at),identityStatus:row.identity_status||'unverified',activeListings:Number(row.active_listings||0),completedMeetups:Number(row.completed_meetups||0),reviewCount:Number(row.review_count||0),rating:Number(Number(row.rating||0).toFixed(1)),contactBlocked:viewer?usersBlocked(viewer.id,row.id):false,listings:listings.map(l=>({id:l.id,title:l.title,description:l.description,category:l.category,condition:l.condition,price:l.price,city:l.city,area:l.area,imageUrl:publicAssetUrl(req,l.image_url),status:l.status,createdAt:l.created_at,seller:{id:row.id,displayName:row.display_name,rating:Number(Number(row.rating||0).toFixed(1)),reviewCount:Number(row.review_count||0)}}))}},cors);
  }

  if(req.method==='GET'&&url.pathname==='/marketplace/blocks'){
    const user=requireUser(req); const rows=db.prepare(`SELECT b.blocked_user_id,u.display_name,u.city,b.created_at FROM user_blocks b JOIN users u ON u.id=b.blocked_user_id WHERE b.blocker_user_id=? ORDER BY b.created_at DESC`).all(user.id);
    return json(res,200,{blockedUsers:rows.map(r=>({id:r.blocked_user_id,displayName:r.display_name,city:r.city,blockedAt:r.created_at}))},cors);
  }
  if(req.method==='POST'&&url.pathname==='/marketplace/blocks'){
    const user=requireUser(req); const body=await readBody(req); const targetId=String(body.userId||'').trim();
    if(!targetId||targetId===user.id) throw Object.assign(new Error('Choose another marketplace user to block.'),{status:400});
    const target=db.prepare("SELECT id,display_name FROM users WHERE id=? AND status='active'").get(targetId); if(!target) throw Object.assign(new Error('User not found.'),{status:404});
    const now=nowIso(); db.prepare('INSERT OR IGNORE INTO user_blocks(blocker_user_id,blocked_user_id,created_at) VALUES(?,?,?)').run(user.id,targetId,now);
    db.prepare("UPDATE meetups SET status='cancelled',updated_at=? WHERE status IN ('pending','confirmed') AND ((buyer_user_id=? AND seller_user_id=?) OR (buyer_user_id=? AND seller_user_id=?))").run(now,user.id,targetId,targetId,user.id);
    audit(user.id,'marketplace.user.block','user',targetId); return json(res,200,{blocked:true,user:{id:target.id,displayName:target.display_name}},cors);
  }
  const marketplaceUnblock=url.pathname.match(/^\/marketplace\/blocks\/([^/]+)$/);
  if(req.method==='DELETE'&&marketplaceUnblock){
    const user=requireUser(req); db.prepare('DELETE FROM user_blocks WHERE blocker_user_id=? AND blocked_user_id=?').run(user.id,marketplaceUnblock[1]); audit(user.id,'marketplace.user.unblock','user',marketplaceUnblock[1]); return json(res,200,{blocked:false},cors);
  }

  if(req.method==='POST'&&url.pathname==='/marketplace/reports'){
    const user=requireUser(req); const body=await readBody(req); const reason=String(body.reason||'other').trim(); const details=String(body.details||'').trim();
    const allowedReasons=new Set(['suspected_scam','harassment','unsafe_behavior','misleading_listing','prohibited_item','other']);
    if(!allowedReasons.has(reason)) throw Object.assign(new Error('Choose a valid report reason.'),{status:400});
    if(details.length<8||details.length>1200) throw Object.assign(new Error('Report details must be between 8 and 1200 characters.'),{status:400});
    let reportedUserId=String(body.userId||'').trim(), listingId=body.listingId?String(body.listingId):null, conversationId=body.conversationId?String(body.conversationId):null;
    if(listingId){const listing=db.prepare('SELECT seller_user_id FROM marketplace_listings WHERE id=?').get(listingId); if(!listing) throw Object.assign(new Error('Listing not found.'),{status:404}); reportedUserId=listing.seller_user_id;}
    if(conversationId){const conversation=db.prepare('SELECT buyer_user_id,seller_user_id FROM conversations WHERE id=? AND (buyer_user_id=? OR seller_user_id=?)').get(conversationId,user.id,user.id); if(!conversation) throw Object.assign(new Error('Conversation not found.'),{status:404}); reportedUserId=user.id===conversation.buyer_user_id?conversation.seller_user_id:conversation.buyer_user_id;}
    if(!reportedUserId||reportedUserId===user.id) throw Object.assign(new Error('You cannot report your own account.'),{status:400});
    const target=db.prepare('SELECT id,display_name FROM users WHERE id=?').get(reportedUserId); if(!target) throw Object.assign(new Error('Reported user not found.'),{status:404});
    const duplicate=db.prepare("SELECT id FROM marketplace_reports WHERE reporter_user_id=? AND reported_user_id=? AND COALESCE(listing_id,'')=? AND COALESCE(conversation_id,'')=? AND status IN ('open','under_review') LIMIT 1").get(user.id,reportedUserId,listingId||'',conversationId||'');
    if(duplicate) throw Object.assign(new Error('You already have an active report for this issue.'),{status:409});
    const id=randomId('rpt_'), now=nowIso(); db.prepare('INSERT INTO marketplace_reports(id,reporter_user_id,reported_user_id,listing_id,conversation_id,reason,details,status,action_taken,admin_note,resolved_by_user_id,resolved_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,user.id,reportedUserId,listingId,conversationId,reason,details,'open','','',null,null,now,now);
    notifyAdmins({type:'marketplace_report',title:'New marketplace safety report',body:`${user.displayName} reported ${target.display_name}.`,href:'/admin',entityType:'marketplace_report',entityId:id});
    audit(user.id,'marketplace.report.create','marketplace_report',id,{reportedUserId,listingId,conversationId,reason});
    return json(res,201,{report:{id,status:'open',reason,createdAt:now}},cors);
  }

  if(req.method==='GET'&&url.pathname==='/admin/marketplace-reports'){
    requireAdmin(req); const rows=db.prepare(`SELECT r.*,reporter.display_name reporter_name,reported.display_name reported_name,l.title listing_title FROM marketplace_reports r JOIN users reporter ON reporter.id=r.reporter_user_id JOIN users reported ON reported.id=r.reported_user_id LEFT JOIN marketplace_listings l ON l.id=r.listing_id ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'under_review' THEN 1 ELSE 2 END,r.created_at DESC LIMIT 250`).all();
    return json(res,200,{reports:rows.map(r=>({id:r.id,reporter:{id:r.reporter_user_id,displayName:r.reporter_name},reportedUser:{id:r.reported_user_id,displayName:r.reported_name},listing:r.listing_id?{id:r.listing_id,title:r.listing_title}:null,conversationId:r.conversation_id,reason:r.reason,details:r.details,status:r.status,actionTaken:r.action_taken,adminNote:r.admin_note,createdAt:r.created_at,resolvedAt:r.resolved_at}))},cors);
  }
  const marketplaceReportReview=url.pathname.match(/^\/admin\/marketplace-reports\/([^/]+)$/);
  if(req.method==='PATCH'&&marketplaceReportReview){
    const admin=requireAdmin(req); const report=db.prepare('SELECT * FROM marketplace_reports WHERE id=?').get(marketplaceReportReview[1]); if(!report) throw Object.assign(new Error('Report not found.'),{status:404});
    if(!['open','under_review'].includes(report.status)) throw Object.assign(new Error('This report is already closed.'),{status:409});
    const body=await readBody(req); const decision=String(body.decision||'').trim(); const note=String(body.note||'').trim().slice(0,1200); const allowed=new Set(['resolve','dismiss','remove_listing','suspend_user']); if(!allowed.has(decision)) throw Object.assign(new Error('Invalid moderation decision.'),{status:400});
    if(decision==='remove_listing'){if(!report.listing_id) throw Object.assign(new Error('This report is not linked to a listing.'),{status:400});db.prepare("UPDATE marketplace_listings SET status='removed',moderation_state='removed',updated_at=? WHERE id=?").run(nowIso(),report.listing_id);}
    if(decision==='suspend_user'){db.prepare("UPDATE users SET status='suspended' WHERE id=?").run(report.reported_user_id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(report.reported_user_id);db.prepare("UPDATE marketplace_listings SET status='removed',moderation_state='removed',updated_at=? WHERE seller_user_id=?").run(nowIso(),report.reported_user_id);}
    const nextStatus=decision==='dismiss'?'dismissed':'resolved', now=nowIso(); db.prepare('UPDATE marketplace_reports SET status=?,action_taken=?,admin_note=?,resolved_by_user_id=?,resolved_at=?,updated_at=? WHERE id=?').run(nextStatus,decision,note,admin.id,now,now,report.id);
    audit(admin.id,'marketplace.report.review','marketplace_report',report.id,{decision,reportedUserId:report.reported_user_id,listingId:report.listing_id}); return json(res,200,{report:{id:report.id,status:nextStatus,actionTaken:decision,resolvedAt:now}},cors);
  }

  if(req.method==='GET'&&url.pathname==='/admin/meetup-locations'){
    requireAdmin(req); const city=String(url.searchParams.get('city')||'').trim(); const rows=city?db.prepare('SELECT * FROM meetup_locations WHERE city=? ORDER BY status,name').all(city):db.prepare('SELECT * FROM meetup_locations ORDER BY city,status,name').all();
    return json(res,200,{locations:rows.map(r=>({id:r.id,name:r.name,city:r.city,area:r.area,kind:r.kind,status:r.status,createdAt:r.created_at}))},cors);
  }
  if(req.method==='POST'&&url.pathname==='/admin/meetup-locations'){
    const admin=requireAdmin(req); const body=await readBody(req); const name=String(body.name||'').trim(), city=String(body.city||'').trim(), area=String(body.area||'').trim(), kind=String(body.kind||'Public place').trim();
    if(name.length<3||area.length<2||!MARKETPLACE_CITIES.has(city)) throw Object.assign(new Error('Name, supported city and area are required.'),{status:400});
    const duplicate=db.prepare("SELECT id FROM meetup_locations WHERE lower(name)=lower(?) AND city=? AND status='approved' LIMIT 1").get(name,city); if(duplicate) throw Object.assign(new Error('An approved meetup location with this name already exists in that city.'),{status:409});
    const id=randomId('loc_'), now=nowIso(); db.prepare('INSERT INTO meetup_locations(id,name,city,area,kind,status,created_at) VALUES(?,?,?,?,?,?,?)').run(id,name,city,area,kind,'approved',now); audit(admin.id,'meetup_location.approve','meetup_location',id,{city,area}); return json(res,201,{location:{id,name,city,area,kind,status:'approved',createdAt:now}},cors);
  }
  const adminMeetupLocation=url.pathname.match(/^\/admin\/meetup-locations\/([^/]+)$/);
  if(req.method==='PATCH'&&adminMeetupLocation){
    const admin=requireAdmin(req); const body=await readBody(req); const status=String(body.status||''); if(!['approved','disabled'].includes(status)) throw Object.assign(new Error('Status must be approved or disabled.'),{status:400}); const row=db.prepare('SELECT * FROM meetup_locations WHERE id=?').get(adminMeetupLocation[1]); if(!row) throw Object.assign(new Error('Meetup location not found.'),{status:404}); db.prepare('UPDATE meetup_locations SET status=? WHERE id=?').run(status,row.id); audit(admin.id,'meetup_location.status','meetup_location',row.id,{from:row.status,to:status}); return json(res,200,{location:{id:row.id,name:row.name,city:row.city,area:row.area,kind:row.kind,status}},cors);
  }

'''
if 'Marketplace trust, blocking & moderation' not in s:
    s=replace_once(s,market_marker,moderation_routes+market_marker,'marketplace marker')

# Contact gates.
s=s.replace("    if(listing.seller_user_id===user.id) throw Object.assign(new Error('You cannot start a buyer chat on your own listing.'),{status:400});", "    if(listing.seller_user_id===user.id) throw Object.assign(new Error('You cannot start a buyer chat on your own listing.'),{status:400});\n    assertContactAllowed(user.id,listing.seller_user_id);",1)
s=s.replace("    if(requestRow.requester_user_id===user.id) throw Object.assign(new Error('You cannot respond to your own wanted request.'),{status:400});", "    if(requestRow.requester_user_id===user.id) throw Object.assign(new Error('You cannot respond to your own wanted request.'),{status:400});\n    assertContactAllowed(user.id,requestRow.requester_user_id);",1)
s=s.replace("    const user=requireUser(req); const c=db.prepare('SELECT * FROM conversations WHERE id=? AND (buyer_user_id=? OR seller_user_id=?)').get(conversationMessages[1],user.id,user.id); if(!c) throw Object.assign(new Error('Conversation not found.'),{status:404});\n    const body=await readBody(req); const text=String(body.body||'').trim();", "    const user=requireUser(req); const c=db.prepare('SELECT * FROM conversations WHERE id=? AND (buyer_user_id=? OR seller_user_id=?)').get(conversationMessages[1],user.id,user.id); if(!c) throw Object.assign(new Error('Conversation not found.'),{status:404});\n    assertContactAllowed(user.id,user.id===c.buyer_user_id?c.seller_user_id:c.buyer_user_id);\n    const body=await readBody(req); const text=String(body.body||'').trim();",1)

# Moderation removal cannot be self-reactivated by the seller.
status_old="""    const body=await readBody(req); const nextStatus=body.status===undefined?existing.status:String(body.status);\n    if(!['draft','active','sold','removed'].includes(nextStatus)) throw Object.assign(new Error('Invalid listing status.'),{status:400});\n    db.prepare('UPDATE marketplace_listings SET status=?,updated_at=? WHERE id=?').run(nextStatus,nowIso(),existing.id);"""
status_new="""    const body=await readBody(req); const nextStatus=body.status===undefined?existing.status:String(body.status);\n    if(!['draft','active','sold','removed'].includes(nextStatus)) throw Object.assign(new Error('Invalid listing status.'),{status:400});\n    if(existing.moderation_state==='removed'&&nextStatus==='active') throw Object.assign(new Error('This listing was removed by MeetMart moderation and cannot be reactivated by the seller.'),{status:403});\n    db.prepare('UPDATE marketplace_listings SET status=?,updated_at=? WHERE id=?').run(nextStatus,nowIso(),existing.id);"""
if status_old in s:
    s=s.replace(status_old,status_new,1)

# Include moderation state in seller-owned listing payloads.
s=s.replace("status:r.status,createdAt:r.created_at,updatedAt:r.updated_at}))", "status:r.status,moderationState:r.moderation_state||'clear',createdAt:r.created_at,updatedAt:r.updated_at}))",1)
write(server_path,s)

# ---------------------------------------------------------------------------
# Frontend API client.
# ---------------------------------------------------------------------------
api_path='src/services/api.js'
a=read(api_path)
anchor="  getMarketplaceUserReviews: userId => request(`/marketplace/users/${encodeURIComponent(userId)}/reviews`),"
api_more=anchor+r'''
  getMarketplaceUserProfile: userId => request(`/marketplace/users/${encodeURIComponent(userId)}/profile`),
  getBlockedUsers: () => request('/marketplace/blocks'),
  blockMarketplaceUser: userId => request('/marketplace/blocks',{method:'POST',body:{userId}}),
  unblockMarketplaceUser: userId => request(`/marketplace/blocks/${encodeURIComponent(userId)}`,{method:'DELETE'}),
  reportMarketplace: data => request('/marketplace/reports',{method:'POST',body:data}),
  getAdminMarketplaceReports: () => request('/admin/marketplace-reports'),
  reviewAdminMarketplaceReport: (reportId,data) => request(`/admin/marketplace-reports/${encodeURIComponent(reportId)}`,{method:'PATCH',body:data}),
  getAdminMeetupLocations: (city='') => request(`/admin/meetup-locations${city?`?city=${encodeURIComponent(city)}`:''}`),
  createAdminMeetupLocation: data => request('/admin/meetup-locations',{method:'POST',body:data}),
  updateAdminMeetupLocation: (locationId,status) => request(`/admin/meetup-locations/${encodeURIComponent(locationId)}`,{method:'PATCH',body:{status}}),'''
if 'getMarketplaceUserProfile:' not in a:
    a=replace_once(a,anchor,api_more,'api marketplace reviews')
write(api_path,a)

# ---------------------------------------------------------------------------
# React UI.
# ---------------------------------------------------------------------------
app_path='src/App.jsx'
app=read(app_path)
app=app.replace("import {getSelectedCity} from './location.js';","import {getSelectedCity, MARKET_LOCATIONS} from './location.js';",1)

components=r'''
function MarketplaceSafetyActions({targetUserId,listingId=null,conversationId=null,onBlocked=null,compact=false}){
 const {user}=useAuth(); const navigate=useNavigate();
 const [open,setOpen]=useState(false); const [reason,setReason]=useState('suspected_scam'); const [details,setDetails]=useState(''); const [busy,setBusy]=useState(false); const [blocked,setBlocked]=useState(false); const [notice,setNotice]=useState('');
 if(!targetUserId||user?.id===targetUserId)return null;
 const requireLogin=()=>{if(user)return true;navigate('/auth');return false;};
 const blockUser=async()=>{if(!requireLogin()||busy)return;if(!window.confirm('Block this user? They will no longer be able to contact you through MeetMart. Pending meetups between you will be cancelled.'))return;setBusy(true);try{await api.blockMarketplaceUser(targetUserId);setBlocked(true);setOpen(false);setNotice('User blocked.');onBlocked?.();}catch(err){setNotice(err.message)}finally{setBusy(false)}};
 const report=async()=>{if(!requireLogin()||busy)return;if(details.trim().length<8){setNotice('Please add a little more detail to the report.');return;}setBusy(true);try{await api.reportMarketplace({userId:targetUserId,listingId,conversationId,reason,details:details.trim()});setOpen(false);setDetails('');setNotice('Report sent to MeetMart moderation.');}catch(err){setNotice(err.message)}finally{setBusy(false)}};
 return <div className={`marketplace-safety-actions ${compact?'compact':''}`}><div className="safety-action-row"><button className="btn ghost" disabled={busy||blocked} onClick={blockUser}><LockKeyhole size={15}/>{blocked?'Blocked':'Block user'}</button><button className="btn ghost" disabled={busy} onClick={()=>{if(requireLogin())setOpen(v=>!v)}}><Flag size={15}/>Report</button></div>{notice&&<small className="safety-action-notice">{notice}</small>}{open&&<div className="report-panel"><b>Report a safety issue</b><select value={reason} onChange={e=>setReason(e.target.value)}><option value="suspected_scam">Suspected scam</option><option value="harassment">Harassment</option><option value="unsafe_behavior">Unsafe behaviour</option><option value="misleading_listing">Misleading listing</option><option value="prohibited_item">Prohibited item</option><option value="other">Other</option></select><textarea value={details} onChange={e=>setDetails(e.target.value)} maxLength={1200} placeholder="Tell MeetMart what happened. Do not include passwords or sensitive identity numbers."/><button className="btn primary full" disabled={busy||details.trim().length<8} onClick={report}>Send report</button></div>}</div>;
}

function ManagedListingCard({item,onChanged}){
 const [busy,setBusy]=useState(false); const change=async status=>{setBusy(true);try{await api.updateMarketplaceListingStatus(item.id,status);await onChanged?.();}catch(err){alert(err.message)}finally{setBusy(false)}};
 return <div className="managed-listing"><ProductCard item={item}/><div className="managed-listing-actions"><span className={`listing-status ${item.status}`}>{item.moderationState==='removed'?'Removed by moderation':item.status}</span>{item.status==='active'&&<button className="btn ghost" disabled={busy} onClick={()=>change('sold')}>Mark sold</button>}{item.status==='sold'&&item.moderationState!=='removed'&&<button className="btn ghost" disabled={busy} onClick={()=>change('active')}>Reactivate</button>}{!['removed'].includes(item.status)&&<button className="btn ghost" disabled={busy} onClick={()=>window.confirm('Remove this listing from MeetMart?')&&change('removed')}>Remove</button>}</div></div>;
}

function MarketplaceUserProfile(){
 const {id}=useParams(); const {user}=useAuth(); const [profile,setProfile]=useState(null); const [reviews,setReviews]=useState({summary:{average:0,count:0},reviews:[]}); const [error,setError]=useState('');
 useEffect(()=>{let active=true;Promise.all([api.getMarketplaceUserProfile(id),api.getMarketplaceUserReviews(id)]).then(([p,r])=>{if(active){setProfile(p.profile);setReviews(r)}}).catch(err=>active&&setError(err.message));return()=>{active=false}},[id]);
 if(error)return <Shell><div className="page"><div className="checkout-error">{error}</div></div></Shell>; if(!profile)return <Shell><div className="page"><p>Loading marketplace profile…</p></div></Shell>;
 const initials=profile.displayName.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase(); const identityLabel=profile.identityStatus==='verified'?'Identity verified':profile.identityStatus==='demo_verified'?'Demo identity check':'Identity not verified';
 return <Shell><div className="page public-profile-page"><section className="profile-hero"><div className="avatar huge">{initials}</div><div><span className="eyebrow">MARKETPLACE TRUST PROFILE</span><h1>{profile.displayName}</h1><small><MapPin size={13}/>{profile.city}</small><div className="chips"><span>{profile.emailVerified?'Email verified':'Email not verified'}</span><span>{identityLabel}</span></div><p>Member since {new Date(profile.joinedAt).toLocaleDateString()}</p></div><div className="rating-box"><Star fill="currentColor"/><strong>{profile.rating||'New'}</strong><small>{profile.reviewCount} review{profile.reviewCount===1?'':'s'}</small></div></section><div className="stat-grid"><div><Package/><strong>{profile.activeListings}</strong><small>Active listings</small></div><div><ShieldCheck/><strong>{profile.completedMeetups}</strong><small>Completed meetups</small></div><div><Star/><strong>{profile.reviewCount}</strong><small>Reviews</small></div></div>{user?.id!==profile.id&&<section className="public-profile-safety"><h3>Safety controls</h3><p>If something feels wrong, block contact or send a private report to MeetMart moderation.</p><MarketplaceSafetyActions targetUserId={profile.id}/></section>}<section className="section"><div className="section-head"><h2>Active listings</h2></div>{profile.listings?.length?<div className="listing-grid">{profile.listings.map(x=><ProductCard key={x.id} item={x}/>)}</div>:<p>No active listings.</p>}</section><section className="reviews"><h2>Reviews</h2>{reviews.reviews?.length?reviews.reviews.map(r=><article key={r.id}><div className="avatar">{r.reviewerName?.[0]||'R'}</div><div><b>{r.reviewerName}</b><span>{'★'.repeat(r.rating)}</span><p>{r.body||'Completed a MeetMart meetup.'}</p></div></article>):<p>No reviews yet.</p>}</section></div></Shell>;
}

'''
if 'function MarketplaceSafetyActions(' not in app:
    app=replace_once(app,'function Product(){',components+'function Product(){','Product component marker')

# Product seller card: trust profile + safety controls.
app=app.replace("<h3>{item.seller.displayName}</h3><b><Star size={15} fill=\"currentColor\"/>","<h3><Link to={`/users/${item.seller.id}`}>{item.seller.displayName}</Link></h3><b><Star size={15} fill=\"currentColor\"/>",1)
app=app.replace("<small>Marketplace seller in {item.city}</small><div className=\"safety-box\">","<small>Marketplace seller in {item.city}</small>{user?.id!==item.seller.id&&<MarketplaceSafetyActions targetUserId={item.seller.id} listingId={item.id}/>}<div className=\"safety-box\">",1)

# Chat: load block state, wire report/block controls and disable composer after blocking.
app=app.replace(" const [conversations,setConversations]=useState([]); const [messages,setMessages]=useState([]); const [text,setText]=useState(''); const [error,setError]=useState('');"," const [conversations,setConversations]=useState([]); const [messages,setMessages]=useState([]); const [text,setText]=useState(''); const [error,setError]=useState(''); const [contactBlocked,setContactBlocked]=useState(false);",1)
chat_effect=" useEffect(()=>{if(!selected){setMessages([]);return;}api.getConversationMessages(selected.id).then(r=>setMessages(r.messages||[])).catch(err=>setError(err.message));},[selected?.id]);"
if chat_effect in app and 'setContactBlocked(Boolean(r.profile?.contactBlocked))' not in app:
    app=app.replace(chat_effect,chat_effect+"\n useEffect(()=>{if(!selected||!user){setContactBlocked(false);return;}api.getMarketplaceUserProfile(selected.otherUser.id).then(r=>setContactBlocked(Boolean(r.profile?.contactBlocked))).catch(()=>{});},[selected?.otherUser?.id,user?.id]);",1)
app=app.replace("<div className=\"quick-actions\"><Link to={`/meetup/${selected.id}`}><MapPin/>Meetup options</Link><button><Flag/>Report</button></div><div className=\"composer\"><input value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>e.key==='Enter'&&send()} placeholder=\"Type a message...\"/><button onClick={send}><Send/></button></div>","<div className=\"quick-actions\"><Link to={`/meetup/${selected.id}`}><MapPin/>Meetup options</Link><Link to={`/users/${selected.otherUser.id}`}>Trust profile</Link></div><MarketplaceSafetyActions compact targetUserId={selected.otherUser.id} conversationId={selected.id} listingId={selected.listing.id} onBlocked={()=>setContactBlocked(true)}/>{contactBlocked&&<div className=\"chat-blocked-note\"><ShieldCheck/> Contact is blocked. You can still read the conversation history.</div>}<div className=\"composer\"><input disabled={contactBlocked} value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>e.key==='Enter'&&send()} placeholder={contactBlocked?'Contact blocked':'Type a message...'}/><button disabled={contactBlocked} onClick={send}><Send/></button></div>",1)
app=app.replace("<p>{selected.listing.city}</p><Link className=\"btn primary full\" to={`/product/${selected.listing.id}`}>View Listing</Link>","<p>{selected.listing.city}</p><Link className=\"btn ghost full\" to={`/users/${selected.otherUser.id}`}>View trust profile</Link><Link className=\"btn primary full\" to={`/product/${selected.listing.id}`}>View Listing</Link>",1)

# Profile: listing lifecycle + blocked users management.
app=app.replace(" const [mine,setMine]=useState([]); const [saved,setSaved]=useState([]); const [meetups,setMeetups]=useState([]); const [reviews,setReviews]=useState({summary:{average:0,count:0},reviews:[]}); const [error,setError]=useState('');"," const [mine,setMine]=useState([]); const [saved,setSaved]=useState([]); const [meetups,setMeetups]=useState([]); const [reviews,setReviews]=useState({summary:{average:0,count:0},reviews:[]}); const [blockedUsers,setBlockedUsers]=useState([]); const [error,setError]=useState('');",1)
old_load=" const load=async()=>{if(!user)return;try{const [a,b,c,d]=await Promise.all([api.getMyMarketplaceListings(),api.getSavedMarketplaceListings(),api.getMyMeetups(),api.getMarketplaceUserReviews(user.id)]);setMine(a.listings||[]);setSaved(b.listings||[]);setMeetups(c.meetups||[]);setReviews(d);}catch(err){setError(err.message)}}; useEffect(()=>{load();},[user?.id]);"
new_load=" const load=async()=>{if(!user)return;try{const [a,b,c,d,e]=await Promise.all([api.getMyMarketplaceListings(),api.getSavedMarketplaceListings(),api.getMyMeetups(),api.getMarketplaceUserReviews(user.id),api.getBlockedUsers()]);setMine(a.listings||[]);setSaved(b.listings||[]);setMeetups(c.meetups||[]);setReviews(d);setBlockedUsers(e.blockedUsers||[]);}catch(err){setError(err.message)}}; useEffect(()=>{load();},[user?.id]);\n const unblock=async id=>{try{await api.unblockMarketplaceUser(id);await load();}catch(err){setError(err.message)}};"
if old_load in app:
    app=app.replace(old_load,new_load,1)
app=app.replace("{mine.length?<div className=\"listing-grid\">{mine.slice(0,6).map(x=><ProductCard key={x.id} item={x}/>)}</div>:<p>You have not posted any marketplace listings yet.</p>}","{mine.length?<div className=\"listing-grid\">{mine.slice(0,9).map(x=><ManagedListingCard key={x.id} item={x} onChanged={load}/>)}</div>:<p>You have not posted any marketplace listings yet.</p>}",1)
reviews_anchor='<section className="reviews"><h2>Reviews & Ratings</h2>'
blocked_section='<section className="section blocked-users-section"><div className="section-head"><h2>Blocked users</h2><small>{blockedUsers.length} blocked</small></div>{blockedUsers.length?blockedUsers.map(b=><article key={b.id}><div><b>{b.displayName}</b><small><MapPin size={13}/>{b.city}</small></div><button className="btn ghost" onClick={()=>unblock(b.id)}>Unblock</button></article>):<p>You have not blocked anyone.</p>}</section>'
if blocked_section not in app:
    app=app.replace(reviews_anchor,blocked_section+reviews_anchor,1)

# Admin beta moderation and nationwide venue operations components.
admin_components=r'''
function MarketplaceModerationAdmin(){
 const [reports,setReports]=useState([]); const [error,setError]=useState(''); const [notice,setNotice]=useState('');
 const load=async()=>{try{const r=await api.getAdminMarketplaceReports();setReports(r.reports||[])}catch(err){setError(err.message)}}; useEffect(()=>{load();},[]);
 const decide=async(report,decision)=>{const verb=decision.replaceAll('_',' ');if(!window.confirm(`Apply moderation action: ${verb}?`))return;try{await api.reviewAdminMarketplaceReport(report.id,{decision,note:`Reviewed from MeetMart admin console: ${verb}.`});setNotice(`Report ${decision==='dismiss'?'dismissed':'resolved'}.`);await load();}catch(err){setError(err.message)}};
 const open=reports.filter(r=>['open','under_review'].includes(r.status));
 return <section className="merchant-review-table marketplace-moderation-admin"><div className="section-head"><div><h2>Marketplace safety reports</h2><p>{open.length} open report{open.length===1?'':'s'}. Reports are private and visible only to MeetMart admins.</p></div><button className="btn ghost" onClick={load}>Refresh</button></div>{error&&<div className="checkout-error">{error}</div>}{notice&&<div className="success-notice"><CheckCircle2/>{notice}</div>}{reports.length?reports.map(r=><article key={r.id}><div><b>{r.reason.replaceAll('_',' ')}</b><small>Reporter: {r.reporter.displayName} • Reported: {r.reportedUser.displayName}{r.listing?` • ${r.listing.title}`:''}</small></div><span>{r.details}</span><em>{r.status}</em><div className="request-actions">{['open','under_review'].includes(r.status)&&<><button className="btn ghost" onClick={()=>decide(r,'resolve')}>Resolve</button><button className="btn ghost" onClick={()=>decide(r,'dismiss')}>Dismiss</button>{r.listing&&<button className="btn ghost" onClick={()=>decide(r,'remove_listing')}>Remove listing</button>}<button className="btn primary" onClick={()=>decide(r,'suspend_user')}>Suspend user</button></>}</div></article>):<p>No marketplace safety reports yet.</p>}</section>;
}

function MeetupLocationAdmin(){
 const [city,setCity]=useState('Kaduna'); const [locations,setLocations]=useState([]); const [form,setForm]=useState({name:'',area:'',kind:'Public place'}); const [error,setError]=useState(''); const [notice,setNotice]=useState('');
 const load=async()=>{try{const r=await api.getAdminMeetupLocations(city);setLocations(r.locations||[])}catch(err){setError(err.message)}}; useEffect(()=>{load();},[city]);
 const create=async()=>{setError('');if(form.name.trim().length<3||form.area.trim().length<2){setError('Venue name and area are required.');return;}if(!window.confirm(`Confirm that MeetMart staff have physically reviewed this ${city} venue before approving it.`))return;try{await api.createAdminMeetupLocation({...form,city});setForm({name:'',area:'',kind:'Public place'});setNotice('Approved meetup location added.');await load();}catch(err){setError(err.message)}};
 const toggle=async loc=>{try{await api.updateAdminMeetupLocation(loc.id,loc.status==='approved'?'disabled':'approved');await load()}catch(err){setError(err.message)}};
 return <section className="merchant-review-table meetup-location-admin"><div className="section-head"><div><h2>Approved public meetup locations</h2><p>Add locations only after physical review. This is how MeetMart expands safe meetup coverage beyond Kaduna.</p></div><select value={city} onChange={e=>setCity(e.target.value)}>{MARKET_LOCATIONS.map(x=><option key={x.city} value={x.city}>{x.state} — {x.city}</option>)}</select></div>{error&&<div className="checkout-error">{error}</div>}{notice&&<div className="success-notice"><CheckCircle2/>{notice}</div>}<div className="meetup-admin-form"><input value={form.name} onChange={e=>setForm(v=>({...v,name:e.target.value}))} placeholder="Verified public venue name"/><input value={form.area} onChange={e=>setForm(v=>({...v,area:e.target.value}))} placeholder={`Area in ${city}`}/><select value={form.kind} onChange={e=>setForm(v=>({...v,kind:e.target.value}))}><option>Public place</option><option>Mall</option><option>Market</option><option>Police-adjacent public area</option><option>Fuel station</option><option>Community centre</option></select><button className="btn primary" onClick={create}>Approve venue</button></div>{locations.length?locations.map(loc=><article key={loc.id}><div><b>{loc.name}</b><small>{loc.area}, {loc.city} • {loc.kind}</small></div><span>{loc.status}</span><em>{new Date(loc.createdAt).toLocaleDateString()}</em><button className="btn ghost" onClick={()=>toggle(loc)}>{loc.status==='approved'?'Disable':'Re-approve'}</button></article>):<p>No approved meetup locations in {city} yet.</p>}</section>;
}

'''
if 'function MarketplaceModerationAdmin(' not in app:
    app=replace_once(app,'function Admin(){',admin_components+'function Admin(){','Admin marker')
admin_section='<section className="merchant-review-table"><div className="section-head"><div><h2>Emergency merchant controls</h2>'
if '<MarketplaceModerationAdmin/><MeetupLocationAdmin/>' not in app:
    app=app.replace(admin_section,'<MarketplaceModerationAdmin/><MeetupLocationAdmin/>'+admin_section,1)

# Add public trust profile route.
route_anchor='<Route path="/profile" element={<Profile/>}/>'
if '<Route path="/users/:id"' not in app:
    app=app.replace(route_anchor,route_anchor+'<Route path="/users/:id" element={<MarketplaceUserProfile/>}/>',1)
write(app_path,app)

# ---------------------------------------------------------------------------
# CSS polish.
# ---------------------------------------------------------------------------
css_path='src/styles.css'
css=read(css_path)
if '.marketplace-safety-actions{' not in css:
    css += r'''

/* Beta trust, moderation and listing-management UI */
.marketplace-safety-actions{display:grid;gap:8px;margin-top:10px}.safety-action-row{display:flex;gap:8px;flex-wrap:wrap}.marketplace-safety-actions.compact{padding:10px 16px;border-top:1px solid var(--line);margin:0}.safety-action-notice{color:#57677d}.report-panel{display:grid;gap:9px;background:#fff7f0;border:1px solid #f2d3bc;border-radius:12px;padding:12px}.report-panel select,.report-panel textarea{width:100%;border:1px solid var(--line);border-radius:9px;background:#fff;padding:10px}.report-panel textarea{min-height:92px;resize:vertical}.managed-listing{display:grid;gap:8px}.managed-listing-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap;background:#fff;border:1px solid var(--line);border-radius:11px;padding:9px}.managed-listing-actions .btn{padding:8px 10px;font-size:12px}.listing-status{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:5px 8px;border-radius:999px;background:#eef3f6}.listing-status.active{background:#e3f7ef;color:#087354}.listing-status.sold{background:#fff2ca;color:#7f5a00}.listing-status.removed{background:#feeaea;color:#9a2d2d}.public-profile-page{max-width:1180px}.public-profile-safety{margin-top:18px;background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px}.chat-blocked-note{margin:0 16px 10px;display:flex;align-items:center;gap:8px;background:#fff2ca;border-radius:10px;padding:10px;color:#705600}.blocked-users-section article{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px;border:1px solid var(--line);border-radius:12px;background:#fff;margin:8px 0}.blocked-users-section article div{display:grid;gap:4px}.blocked-users-section small{display:flex;align-items:center;gap:4px;color:var(--muted)}.meetup-admin-form{display:grid;grid-template-columns:1.3fr 1fr 1fr auto;gap:8px;margin:12px 0}.meetup-admin-form input,.meetup-admin-form select,.meetup-location-admin>.section-head select{border:1px solid var(--line);background:#fff;border-radius:9px;padding:10px}.marketplace-moderation-admin article>span{max-width:420px;white-space:normal}
@media(max-width:760px){.meetup-admin-form{grid-template-columns:1fr}.marketplace-safety-actions .btn{flex:1}.public-profile-page .profile-hero{align-items:flex-start}.managed-listing-actions{justify-content:space-between}}
'''
write(css_path,css)

# ---------------------------------------------------------------------------
# Regression tests for trust/moderation flows.
# ---------------------------------------------------------------------------
test_path='server/tests/smoke.mjs'
t=read(test_path)
marker="  r=await call('/auth/logout',{method:'POST',body:'{}'}); assert.equal(r.res.status,200);"
moderation_test=r'''
  // Public trust profile exposes marketplace trust signals but never the seller email.
  cookie=buyerCookie;
  r=await call(`/marketplace/users/${userId}/profile`); assert.equal(r.res.status,200); assert.equal(r.body.profile.displayName,'Test User'); assert.equal(r.body.profile.reviewCount,1); assert.equal(r.body.profile.email,undefined); assert.equal(r.body.profile.listings.length,1);

  // Buyer can file a private report, block contact, and unblock later.
  r=await call('/marketplace/reports',{method:'POST',body:JSON.stringify({userId,listingId,conversationId,reason:'suspected_scam',details:'Seller asked me to move payment outside the safe marketplace flow.'})}); assert.equal(r.res.status,201); const marketplaceReportId=r.body.report.id;
  r=await call('/marketplace/blocks',{method:'POST',body:JSON.stringify({userId})}); assert.equal(r.res.status,200); assert.equal(r.body.blocked,true);
  r=await call(`/conversations/${conversationId}/messages`,{method:'POST',body:JSON.stringify({body:'This should be blocked.'})}); assert.equal(r.res.status,403);
  r=await call('/marketplace/blocks'); assert.equal(r.res.status,200); assert.ok(r.body.blockedUsers.some(x=>x.id===userId));
  r=await call(`/marketplace/blocks/${userId}`,{method:'DELETE'}); assert.equal(r.res.status,200);
  r=await call(`/conversations/${conversationId}/messages`,{method:'POST',body:JSON.stringify({body:'Contact restored after unblock.'})}); assert.equal(r.res.status,201);

  // A separate moderator reviews reports and manages physically reviewed meetup locations.
  cookie='';
  r=await call('/auth/signup',{method:'POST',body:JSON.stringify({email:'moderator@example.com',password:'StrongPass3',displayName:'MeetMart Moderator',city:'Kano'})}); assert.equal(r.res.status,201); const moderatorId=r.body.user.id; const moderatorCookie=cookie;
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(moderatorId);
  cookie=moderatorCookie;
  r=await call('/admin/marketplace-reports'); assert.equal(r.res.status,200); assert.ok(r.body.reports.some(x=>x.id===marketplaceReportId));
  r=await call(`/admin/marketplace-reports/${marketplaceReportId}`,{method:'PATCH',body:JSON.stringify({decision:'remove_listing',note:'Listing removed during isolated moderation test.'})}); assert.equal(r.res.status,200); assert.equal(r.body.report.status,'resolved');
  r=await call('/admin/meetup-locations?city=Kano'); assert.equal(r.res.status,200);
  r=await call('/admin/meetup-locations',{method:'POST',body:JSON.stringify({name:'Test Reviewed Public Venue',city:'Kano',area:'Kano Municipal',kind:'Public place'})}); assert.equal(r.res.status,201); const kanoLocationId=r.body.location.id;
  r=await call('/meetup-locations'); assert.equal(r.res.status,200); assert.ok(r.body.locations.some(x=>x.id===kanoLocationId));
  r=await call(`/admin/meetup-locations/${kanoLocationId}`,{method:'PATCH',body:JSON.stringify({status:'disabled'})}); assert.equal(r.res.status,200); assert.equal(r.body.location.status,'disabled');

  // A listing removed by moderation cannot be reactivated by its seller.
  cookie=sellerCookie;
  r=await call(`/marketplace/listings/${listingId}`,{method:'PATCH',body:JSON.stringify({status:'active'})}); assert.equal(r.res.status,403);

'''
if 'Public trust profile exposes marketplace trust signals' not in t:
    t=replace_once(t,marker,moderation_test+marker,'smoke logout marker')
write(test_path,t)

# ---------------------------------------------------------------------------
# 75% milestone record.
# ---------------------------------------------------------------------------
Path('MILESTONE_75.md').write_text('''# MeetMart NG — 75% Beta Milestone\n\n## Definition\nThis milestone means the product has a working beta core for marketplace trading, verified-store commerce scaffolding, identity/payment adapters, transaction safety, account security, moderation, and staging deployment. It does **not** mean production launch readiness.\n\n## Included by 75%\n- Same-city person-to-person marketplace with real backend listings, photos, saved items, Wanted Requests, chat, notifications, public meetup planning, reviews, and listing lifecycle controls.\n- Marketplace trust profiles with join date, ratings, completed meetups, listing count, email-verification signal and identity-check state without exposing private identity data.\n- User blocking that stops direct contact and cancels pending/confirmed meetups between blocked accounts.\n- Private marketplace safety reports and an admin moderation queue with listing removal and account suspension actions.\n- Admin management for physically reviewed public meetup venues as MeetMart expands city coverage.\n- Verified Stores merchant application/review, catalogs, ASD Pay adapter checkout, delivery orders, refunds/disputes, merchant suspension and settlement calculations.\n- Protected delivery address reveal, audit logging and proof-of-delivery PIN.\n- NIN/BVN provider boundaries with raw identifiers excluded from stored verification records.\n- Account sessions, password reset flow, email-verification groundwork, password changes and multi-session logout.\n- Mobile/desktop responsive staging app, health checks, rate limits, backup hooks and CI regression/build checks.\n\n## Final 25% before a real launch\n- Replace demo ASD Pay and identity adapters with contracted production providers and signed webhooks.\n- Replace staging demo email codes with real transactional email delivery.\n- Move database/uploads off ephemeral free-service storage to durable production infrastructure with tested restore procedures.\n- Production-grade merchant document storage/scanning, compliance review and retention policies.\n- Populate approved meetup venues city-by-city only after physical verification.\n- Broader device/browser accessibility QA, performance/code-splitting, observability, legal/privacy documentation and launch operations.\n- Final penetration/security review and real-money pilot testing with controlled merchants.\n\n## Safety note\nMeetMart verification and safety controls reduce risk; they do not guarantee that a person, listing, merchant or meetup is safe. Production copy must not claim government approval unless the relevant regulator granted that approval.\n''')

print('MeetMart 75% beta patch applied.')
