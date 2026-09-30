import React, {createContext, useContext, useEffect, useMemo, useState} from 'react';
import {Routes, Route, NavLink, Link, Navigate, useNavigate, useParams} from 'react-router-dom';
import {Search, MapPin, ShieldCheck, Heart, Plus, Home as HomeIcon, User, MessageCircle, Bell, SlidersHorizontal, Star, Store, Package, ArrowRight, ChevronDown, Camera, Send, Flag, CalendarDays, CheckCircle2, Rocket, Crown, BarChart3, Megaphone, Zap, BadgeCheck, Eye, TrendingUp, LockKeyhole, Utensils, Bike, Clock3, WalletCards, ReceiptText, ShoppingBag, CreditCard, CheckCheck} from 'lucide-react';
import {categories, listings, requests} from './data.js';
import {storeCategories, merchantVerificationSteps} from './storesData.js';
import {api} from './services/api.js';

const safeLocalGet = (key, fallback = null) => {
  try { return typeof window === 'undefined' ? fallback : (window.localStorage.getItem(key) ?? fallback); } catch { return fallback; }
};
const safeLocalSet = (key, value) => {
  try { if (typeof window !== 'undefined') window.localStorage.setItem(key, value); return true; } catch { return false; }
};
const safeSessionGet = (key, fallback = null) => {
  try { return typeof window === 'undefined' ? fallback : (window.sessionStorage.getItem(key) ?? fallback); } catch { return fallback; }
};
const safeSessionSet = (key, value) => {
  try { if (typeof window !== 'undefined') window.sessionStorage.setItem(key, value); return true; } catch { return false; }
};
const safeSessionRemove = (key) => {
  try { if (typeof window !== 'undefined') window.sessionStorage.removeItem(key); } catch {}
};

const SELLER_PLANS = {
  free: {
    name: 'Free',
    price: '₦0',
    cadence: 'forever',
    listingLimit: 5,
    features: ['Up to 5 active listings', 'Buyer chat', 'Wanted-request responses', 'Public meetup planner']
  },
  pro: {
    name: 'MeetMart Pro',
    price: '₦4,000',
    cadence: '/ month',
    listingLimit: 50,
    features: ['Up to 50 active listings', 'Seller analytics', 'Instant wanted-request alerts', 'Auto-renew listings', '20% off boosts']
  },
  business: {
    name: 'MeetMart Business',
    price: '₦12,000',
    cadence: '/ month',
    listingLimit: 250,
    features: ['Up to 250 active listings', 'Professional storefront', 'Advanced analytics', 'Priority lead alerts', 'Multiple staff seats', '35% off boosts']
  }
};

const BOOST_PACKAGES = [
  {id:'day', label:'24 hours', price:'₦500', days:1},
  {id:'3days', label:'3 days', price:'₦1,000', days:3, popular:true},
  {id:'7days', label:'7 days', price:'₦2,000', days:7}
];

const BusinessContext = createContext(null);
function BusinessProvider({children}){
  const [sellerPlan,setSellerPlan] = useState(()=>{
    const stored = safeLocalGet('meetmart-plan', 'free');
    return SELLER_PLANS[stored] ? stored : 'free';
  });
  const [boosts,setBoosts] = useState(()=>{
    try{return JSON.parse(safeLocalGet('meetmart-boosts', '{}')) || {}}catch{return {}}
  });
  useEffect(()=>{ safeLocalSet('meetmart-plan',sellerPlan); },[sellerPlan]);
  useEffect(()=>{ safeLocalSet('meetmart-boosts',JSON.stringify(boosts)); },[boosts]);
  const upgrade = (plan)=>{ if (SELLER_PLANS[plan]) setSellerPlan(plan); };
  const boostListing = (id,pkg)=>{
    const startedAt = Date.now();
    const expiresAt = startedAt + Number(pkg.days || 0) * 24 * 60 * 60 * 1000;
    setBoosts(prev=>({...prev,[id]:{...pkg,startedAt,expiresAt}}));
  };
  const isBoosted = (id)=>{
    const boost = boosts[id];
    return Boolean(boost && Number(boost.expiresAt) > Date.now());
  };
  const value = useMemo(()=>({sellerPlan,plan:SELLER_PLANS[sellerPlan],upgrade,boosts,boostListing,isBoosted}),[sellerPlan,boosts]);
  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>
}
function useBusiness(){ return useContext(BusinessContext); }

const AuthContext = createContext(null);
function AuthProvider({children}){
  const [user,setUser]=useState(null);
  const [loading,setLoading]=useState(true);
  const [authError,setAuthError]=useState('');
  const refresh=async()=>{
    setLoading(true);
    try{const result=await api.me();setUser(result.user||null);setAuthError('');}
    catch(error){setUser(null);setAuthError(error.message||'Unable to reach MeetMart backend.');}
    finally{setLoading(false);}
  };
  useEffect(()=>{refresh();},[]);
  const signup=async(data)=>{const result=await api.signup(data);setUser(result.user);setAuthError('');return result.user;};
  const login=async(data)=>{const result=await api.login(data);setUser(result.user);setAuthError('');return result.user;};
  const logout=async()=>{try{await api.logout();}finally{setUser(null);}};
  const value=useMemo(()=>({user,loading,authError,signup,login,logout,refresh}),[user,loading,authError]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
function useAuth(){return useContext(AuthContext);}

const IdentityContext = createContext(null);
function IdentityProvider({children}){
  const {user}=useAuth();
  const [identity,setIdentity]=useState({nin:null,bvn:null});
  const [loading,setLoading]=useState(false);
  const refreshIdentity=async()=>{
    if(!user){setIdentity({nin:null,bvn:null});return;}
    setLoading(true);
    try{
      const result=await api.getIdentityVerifications();
      const next={nin:null,bvn:null};
      for(const record of result.verifications||[]) if(record?.type==='nin'||record?.type==='bvn') next[record.type]=record;
      setIdentity(next);
    }catch{setIdentity({nin:null,bvn:null});}
    finally{setLoading(false);}
  };
  useEffect(()=>{refreshIdentity();},[user?.id]);
  const verify=async(input)=>{const result=await api.verifyIdentity(input);setIdentity(prev=>({...prev,[result.verification.type]:result.verification}));return result.verification;};
  const value=useMemo(()=>({identity,loading,verify,refreshIdentity}),[identity,loading]);
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}
function useIdentity(){ return useContext(IdentityContext); }

function NotificationBell(){
  const {user}=useAuth();
  const [open,setOpen]=useState(false);
  const [items,setItems]=useState([]);
  const [unread,setUnread]=useState(0);
  const load=async()=>{if(!user){setItems([]);setUnread(0);return;}try{const r=await api.getNotifications(25);setItems(r.notifications||[]);setUnread(Number(r.unreadCount||0));}catch{}};
  useEffect(()=>{load();if(!user)return;const unsubscribe=api.subscribeEvents((type,data)=>{if(type==='notification.created'){setItems(v=>[data,...v.filter(x=>x.id!==data.id)].slice(0,25));setUnread(v=>v+1);}});return unsubscribe;},[user?.id]);
  const read=async item=>{if(!item.readAt){try{await api.markNotificationRead(item.id);setItems(v=>v.map(x=>x.id===item.id?{...x,readAt:new Date().toISOString()}:x));setUnread(v=>Math.max(0,v-1));}catch{}}setOpen(false);};
  const readAll=async()=>{try{await api.markAllNotificationsRead();const at=new Date().toISOString();setItems(v=>v.map(x=>({...x,readAt:x.readAt||at})));setUnread(0);}catch{}};
  if(!user)return null;
  return <div className="notification-wrap"><button className="notification-bell" aria-label={`Notifications${unread?` (${unread} unread)`:''}`} onClick={()=>setOpen(v=>!v)}><Bell size={20}/>{unread>0&&<span>{unread>99?'99+':unread}</span>}</button>{open&&<div className="notification-panel"><div className="notification-head"><b>Notifications</b>{unread>0&&<button onClick={readAll}>Mark all read</button>}</div>{items.length?items.map(item=><Link key={item.id} to={item.href||'/profile'} onClick={()=>read(item)} className={`notification-item ${item.readAt?'':'unread'}`}><span className="notification-dot"/><div><b>{item.title}</b><p>{item.body}</p><small>{new Date(item.createdAt).toLocaleString()}</small></div></Link>):<div className="notification-empty">No notifications yet.</div>}</div>}</div>;
}

function Shell({children, mode='marketplace'}) {
  const storeMode = mode === 'stores';
  const {user,logout}=useAuth();
  return <div className={`app-shell ${storeMode?'stores-mode':''}`}>
    <header className="topbar">
      <Link className="brand" to="/"><span className="brand-pin"><MapPin size={19}/></span><span><b>MeetMart <em>NG</em></b><small>Buy. Sell. Meet Nearby.</small></span></Link>
      <div className="header-search"><Search size={18}/><input aria-label="Search" placeholder={storeMode?"Search verified stores or products...":"Search phones, shoes, electronics..."}/><button aria-label="Search"><Search size={18}/></button></div>
      <button className="city-chip"><MapPin size={16}/> Kaduna <ChevronDown size={15}/></button>
      <nav className="desktop-links"><Link to="/stores">Stores</Link><Link to="/search">Marketplace</Link><Link to="/meetup">Safety</Link><Link to="/seller-tools">Seller tools</Link><Link to="/verification">Verify ID</Link></nav>
      <div className="header-actions"><NotificationBell/>{user?<><Link className="btn ghost" to="/profile">{user.displayName||'Account'}</Link><button className="btn primary" onClick={logout}>Log out</button></>:<><Link className="btn ghost" to="/auth">Log in</Link><Link className="btn primary" to="/auth">Sign up</Link></>}</div>
    </header>
    <div className="safety-strip"><ShieldCheck size={17}/>{storeMode?<><b>MeetMart Verified Stores only</b><span>•</span><b>Pay with ASD Pay</b><span>•</span><b>Delivery supported</b><span className="push">Online checkout is limited to approved merchants →</span></>:<><b>Public meetup only</b><span>•</span><b>No online payment</b><span>•</span><b>Meet in approved public places in Kaduna</b><span className="push">Your safety comes first →</span></>}</div>
    <main>{children}</main>
    <nav className="bottom-nav">
      {storeMode ? <>
        <NavLink to="/stores"><Store/><span>Stores</span></NavLink>
        <NavLink to="/stores/orders"><ReceiptText/><span>Orders</span></NavLink>
        <NavLink className="sell-fab" to="/search"><ShoppingBag/><span>Market</span></NavLink>
        <NavLink to="/"><HomeIcon/><span>Home</span></NavLink>
        <NavLink to="/profile"><User/><span>Profile</span></NavLink>
      </> : <>
        <NavLink to="/"><HomeIcon/><span>Home</span></NavLink>
        <NavLink to="/search"><Search/><span>Search</span></NavLink>
        <NavLink className="sell-fab" to="/sell"><Plus/><span>Sell</span></NavLink>
        <NavLink to="/requests"><Package/><span>Requests</span></NavLink>
        <NavLink to="/profile"><User/><span>Profile</span></NavLink>
      </>}
    </nav>
  </div>
}
function ProductCard({item, compact=false}){
 const {user}=useAuth();
 const navigate=useNavigate();
 const [saved,setSaved]=useState(Boolean(item.saved));
 const [busy,setBusy]=useState(false);
 const {isBoosted}=useBusiness();
 const listingId = item.productId ?? item.id;
 const promoted = item.sponsored || isBoosted(listingId);
 const image = item.imageUrl || item.image || listings[0].image;
 const priceLabel = typeof item.price==='number' ? naira(item.price) : item.price;
 const rating = Number(item.seller?.rating ?? item.rating ?? 0);
 const reviewCount = Number(item.seller?.reviewCount ?? 0);
 const toggleSave=async()=>{
   if(!user){navigate('/auth');return;}
   if(busy)return;
   setBusy(true);
   try{ if(saved) await api.unsaveMarketplaceListing(listingId); else await api.saveMarketplaceListing(listingId); setSaved(!saved); }
   catch(error){alert(error.message||'Could not update saved item.');}
   finally{setBusy(false);}
 };
 return <article className={`product-card ${compact?'compact':''} ${promoted?'promoted':''}`}>
   <div className="product-media"><img src={image} alt={item.title}/>{promoted&&<span className="promo-badge"><Rocket size={13}/> Sponsored</span>}<button className="heart" disabled={busy} aria-label={saved?`Remove ${item.title} from saved items`:`Save ${item.title}`} onClick={toggleSave}><Heart size={18} fill={saved?'currentColor':'none'}/></button></div>
   <div className="product-copy"><Link to={`/product/${listingId}`}><b>{item.title}</b></Link><strong>{priceLabel}</strong><small><MapPin size={13}/>{item.area}, {item.city||'Kaduna'}</small><small className="rating"><Star size={13} fill="currentColor"/> {rating||'New'} {reviewCount>0&&<span>({reviewCount})</span>}</small></div>
 </article>
}

function Home(){
 const [marketListings,setMarketListings]=useState([]);
 const [wanted,setWanted]=useState([]);
 const [loading,setLoading]=useState(true);
 const [query,setQuery]=useState('');
 const navigate=useNavigate();
 useEffect(()=>{let active=true;Promise.all([api.getMarketplaceListings(),api.getWantedRequests()]).then(([a,b])=>{if(active){setMarketListings(a.listings||[]);setWanted(b.requests||[]);}}).catch(()=>{}).finally(()=>{if(active)setLoading(false)});return()=>{active=false};},[]);
 const search=()=>navigate(`/search${query.trim()?`?q=${encodeURIComponent(query.trim())}`:''}`);
 return <Shell><div className="page home-page">
  <section className="hero">
   <div className="hero-copy"><span className="eyebrow">Same city. Safer trade.</span><h1>Find what you need <em>nearby</em></h1><p>Trusted buying and selling within your city. Real people. Real items. Safe meetups.</p>
    <div className="hero-search"><button className="city-chip"><MapPin size={17}/>Kaduna<ChevronDown size={15}/></button><div><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==='Enter'&&search()} placeholder="Search phones, shoes, electronics..."/><button onClick={search}><Search/></button></div></div>
    <div className="hero-points"><span><CheckCircle2/>Same-city only</span><span><CheckCircle2/>No online payment</span><span><CheckCircle2/>Meet in public places</span></div>
   </div>
   <div className="hero-visual"><div className="skyline"></div><div className="hero-person">MM</div><div className="hero-badge"><MapPin/> <b>Kaduna</b><small>Our City. Our Marketplace.</small></div></div>
  </section>
  <section className="home-food-callout"><div><span className="eyebrow">MEETMART VERIFIED STORES</span><h2>Order deliverable goods from businesses we approve.</h2><p>Food, groceries, electronics, fashion, home goods and more can use ASD Pay checkout after the merchant passes MeetMart verification.</p></div><Link className="btn primary" to="/stores"><Store size={17}/>Explore Verified Stores</Link></section>
  <section className="section"><div className="section-head"><h2>Shop by Category</h2><Link to="/search">View all categories →</Link></div><div className="category-grid">{categories.map(([name,ico])=><button key={name} onClick={()=>navigate(`/search?category=${encodeURIComponent(name)}`)}><span>{ico}</span>{name}</button>)}</div></section>
  <section className="two-col"><div><div className="section-head"><h2>Latest Listings in Kaduna</h2><Link to="/search">View all listings →</Link></div>{loading?<p>Loading marketplace…</p>:marketListings.length?<div className="listing-grid">{marketListings.slice(0,6).map(x=><ProductCard key={x.id} item={x}/>)}</div>:<div className="empty-orders"><Package/><h3>No live listings yet</h3><p>Be the first person to post an item in Kaduna.</p><Link className="btn primary" to="/sell">Create listing</Link></div>}</div><aside className="wanted-panel"><div className="section-head"><h3>Wanted Requests</h3><Link to="/requests">View all →</Link></div>{wanted.length?wanted.slice(0,4).map(r=><div className="wanted-mini" key={r.id}><span>{r.title[0]}</span><div><b>{r.title}</b><small>Budget: {naira(r.budget)}</small><small><MapPin size={12}/> {r.area}, {r.city}</small></div></div>):<p>No wanted requests yet.</p>}</aside></section>
  <section className="how"><h2>How MeetMart NG Works</h2><div className="steps">{[['1','Search','Find items or post what you need.'],['2','Chat','Talk directly inside the app.'],['3','Meet in Public','Choose an approved public place.'],['4','Buy','Inspect first, then complete your deal.']].map(x=><div key={x[0]}><span>{x[0]}</span><b>{x[1]}</b><small>{x[2]}</small></div>)}</div></section>
 </div></Shell>
}

function Auth(){
 const [mode,setMode]=useState('signup');
 const [displayName,setDisplayName]=useState('');
 const [email,setEmail]=useState('');
 const [password,setPassword]=useState('');
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const {user,signup,login,logout}=useAuth();
 const navigate=useNavigate();
 const submit=async()=>{
   setError('');setBusy(true);
   try{
     if(mode==='signup') await signup({displayName,email,password});
     else await login({email,password});
     navigate('/profile');
   }catch(err){setError(err.message||'Authentication failed.');}
   finally{setBusy(false);}
 };
 if(user) return <Shell><div className="page auth-page"><section className="auth-card"><h1>You’re signed in</h1><p><b>{user.displayName}</b><br/>{user.email}<br/>{user.city} • {user.role}</p><div className="request-actions"><Link className="btn primary" to="/profile">Open profile</Link><button className="btn ghost" onClick={async()=>{await logout();}}>Log out</button></div></section><section className="auth-brand"><span className="eyebrow">MEETMART ACCOUNT</span><h1>One account.<br/><em>Marketplace + Stores.</em></h1><p>Your server-side session now protects identity checks, merchant applications and future ASD Pay actions.</p></section></div></Shell>;
 return <Shell><div className="auth-page page"><section className="auth-card"><div className="tabs"><button onClick={()=>setMode('login')} className={mode==='login'?'active':''}>Log In</button><button onClick={()=>setMode('signup')} className={mode==='signup'?'active':''}>Sign Up</button></div><h1>{mode==='signup'?'Create your account':'Welcome back'}</h1><p>{mode==='signup'?'Create a real MeetMart account stored by the backend.':'Log in to continue to MeetMart NG.'}</p>{mode==='signup'&&<div className="field"><span>👤</span><input value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="Your full/display name" autoComplete="name"/></div>}<div className="field"><span>✉</span><input value={email} onChange={e=>setEmail(e.target.value)} placeholder="Enter your email address" type="email" autoComplete="email"/></div><div className="field"><span>🔒</span><input value={password} onChange={e=>setPassword(e.target.value)} placeholder={mode==='signup'?'Create a password (8+ characters)':'Enter your password'} type="password" autoComplete={mode==='signup'?'new-password':'current-password'}/></div>{error&&<div className="checkout-error">{error}</div>}<button className="btn primary full" disabled={busy} onClick={submit}>{busy?'Please wait…':mode==='signup'?'Create account':'Log in'} <ArrowRight size={16}/></button><div className="or">SERVER SESSION</div><p className="privacy-note"><LockKeyhole size={14}/>Passwords are hashed on the backend. Authentication uses an HttpOnly session cookie rather than saving a password or session token in localStorage.</p></section><section className="auth-brand"><span className="eyebrow">WELCOME TO MEETMART NG</span><h1>Great Deals.<br/><em>Near You.</em></h1><p>Trusted buying and selling within your city. Real people. Real items. Safer meetups.</p><div className="onboarding"><b>Quick setup after sign up</b><div className="onboarding-grid">{[['1','Choose city'],['2','Your role'],['3','Identity'],['4','Profile'],['5','Safety tips']].map(x=><div key={x[0]}><span>{x[0]}</span><b>{x[1]}</b></div>)}</div></div></section></div></Shell>
}

function SearchPage(){
 const params = new URLSearchParams(typeof window==='undefined'?'':window.location.search);
 const [query,setQuery]=useState(params.get('q')||'');
 const [category,setCategory]=useState(params.get('category')||'All');
 const [area,setArea]=useState('');
 const [view,setView]=useState('grid');
 const [items,setItems]=useState([]);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');
 const load=async()=>{setLoading(true);setError('');try{const result=await api.getMarketplaceListings({search:query,category,area});setItems(result.listings||[]);}catch(err){setError(err.message||'Unable to load listings.');setItems([]);}finally{setLoading(false);}};
 useEffect(()=>{load();},[category,area]);
 return <Shell><div className="page search-page"><div className="results-head"><h1>Marketplace in Kaduna</h1><p>{items.length} live listing{items.length===1?'':'s'} <span className="pill"><MapPin size={13}/>Kaduna (locked)</span></p></div><div className="search-layout"><aside className="filters"><div className="section-head"><h3>Filters</h3><button onClick={()=>{setCategory('All');setArea('');setQuery('')}}>Clear all</button></div><label>Search<input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==='Enter'&&load()} placeholder="What are you looking for?"/></label><label>Category<select value={category} onChange={e=>setCategory(e.target.value)}><option>All</option>{categories.map(([name])=><option key={name}>{name}</option>)}</select></label><label>Area<select value={area} onChange={e=>setArea(e.target.value)}><option value="">All Kaduna</option><option>Kaduna North</option><option>Kaduna South</option><option>Barnawa</option><option>Kawo</option><option>Ungwan Rimi</option></select></label><button className="btn primary full" onClick={load}>Search</button></aside><section className="results"><div className="filter-row"><button><SlidersHorizontal size={15}/>Filters</button><span>{category!=='All'?category:'All categories'}</span><span>{area||'All areas'}</span><span className="push">{items.length} results</span><button onClick={()=>setView('grid')}>Grid</button><button onClick={()=>setView('list')}>List</button></div>{error&&<div className="checkout-error">{error}</div>}{loading?<p>Loading listings…</p>:items.length?<div className={view==='grid'?'listing-grid search-grid':'listing-list'}>{items.map(x=><ProductCard key={x.id} item={x}/>)}</div>:<div className="empty-orders"><Search/><h2>No matching listings</h2><p>Try another search or create a Wanted Request.</p><Link className="btn primary" to="/requests">Post a Wanted Request</Link></div>}</section></div></div></Shell>
}

function Product(){
 const {id}=useParams(); const {user}=useAuth(); const navigate=useNavigate();
 const [item,setItem]=useState(null); const [similar,setSimilar]=useState([]); const [reviews,setReviews]=useState(null); const [loading,setLoading]=useState(true); const [error,setError]=useState(''); const [busy,setBusy]=useState(false);
 useEffect(()=>{let active=true;setLoading(true);api.getMarketplaceListing(id).then(async r=>{if(!active)return;setItem(r.listing);try{const [s,rv]=await Promise.all([api.getMarketplaceListings({category:r.listing.category}),api.getMarketplaceUserReviews(r.listing.seller.id)]);if(active){setSimilar((s.listings||[]).filter(x=>x.id!==id).slice(0,6));setReviews(rv);}}catch{}}).catch(err=>active&&setError(err.message)).finally(()=>active&&setLoading(false));return()=>{active=false};},[id]);
 const startChat=async()=>{if(!user){navigate('/auth');return;}setBusy(true);try{const result=await api.startConversation(id);navigate(`/chat/${result.conversation.id}`);}catch(err){alert(err.message);}finally{setBusy(false);}};
 const toggleSave=async()=>{if(!user){navigate('/auth');return;}setBusy(true);try{if(item.saved)await api.unsaveMarketplaceListing(id);else await api.saveMarketplaceListing(id);setItem(v=>({...v,saved:!v.saved}));}catch(err){alert(err.message);}finally{setBusy(false);}};
 if(loading)return <Shell><div className="page"><p>Loading listing…</p></div></Shell>; if(error||!item)return <Shell><div className="page"><div className="checkout-error">{error||'Listing not found.'}</div></div></Shell>;
 const image=item.imageUrl||listings[0].image;
 return <Shell><div className="page product-page"><div className="product-detail"><div className="gallery"><img src={image} alt={item.title}/><div className="thumbs">{[1,2,3].map(i=><img key={i} src={image} alt={`${item.title} view ${i}`}/>)}</div></div><div className="details"><h1>{item.title}</h1><p>{item.description||'Seller has not added a detailed description yet.'}</p><strong className="big-price">{naira(item.price)}</strong><span className="pill">{item.condition}</span><div className="meta"><span>🏷 {item.category}</span><span><MapPin size={16}/> {item.area}, {item.city}</span><span>📅 {new Date(item.createdAt).toLocaleDateString()}</span></div><div className="actions">{user?.id!==item.seller.id&&<button className="btn primary" disabled={busy} onClick={startChat}><MessageCircle size={17}/> Chat with Seller</button>}<button className="btn ghost" disabled={busy} onClick={toggleSave}><Heart size={17} fill={item.saved?'currentColor':'none'}/> {item.saved?'Saved':'Save item'}</button></div><div className="specs"><h3>Marketplace rules</h3><div><span>Payment <b>In person only</b></span><span>Meetup <b>Approved public locations</b></span><span>City <b>{item.city}</b></span><span>Status <b>{item.status}</b></span></div></div></div><aside className="seller-card"><div className="avatar">{item.seller.displayName.split(' ').map(x=>x[0]).join('').slice(0,2)}</div><h3>{item.seller.displayName}</h3><b><Star size={15} fill="currentColor"/> {item.seller.rating||'New'} {item.seller.reviewCount?`(${item.seller.reviewCount})`:''}</b><small>Marketplace seller in {item.city}</small><div className="safety-box"><ShieldCheck/><h3>Buy safely</h3><p>Inspect item before paying.</p><p>Meet only in approved public locations.</p><p>Never send marketplace payment online.</p></div></aside></div>{reviews?.reviews?.length>0&&<section className="reviews"><h2>Seller Reviews</h2>{reviews.reviews.slice(0,3).map(r=><article key={r.id}><div className="avatar">{r.reviewerName?.[0]||'R'}</div><div><b>{r.reviewerName}</b><span>{'★'.repeat(r.rating)}</span><p>{r.body||'Completed a MeetMart meetup.'}</p></div></article>)}</section>}<div className="section-head"><h2>Similar Listings in Kaduna</h2></div>{similar.length?<div className="listing-grid">{similar.map(x=><ProductCard key={x.id} item={x}/>)}</div>:<p>No similar live listings yet.</p>}</div></Shell>
}

function Sell(){
 const {user}=useAuth(); const navigate=useNavigate();
 const [form,setForm]=useState({title:'',category:'Phones',price:'',condition:'Used - Like New',description:'',area:'Kaduna North'}); const [photoFile,setPhotoFile]=useState(null); const [photo,setPhoto]=useState(null); const [busy,setBusy]=useState(false); const [uploading,setUploading]=useState(false); const [error,setError]=useState('');
 useEffect(()=>()=>{if(photo)URL.revokeObjectURL(photo);},[photo]);
 if(!user)return <Shell><div className="page empty-orders"><LockKeyhole/><h2>Sign in to sell</h2><p>Marketplace listings are tied to a real MeetMart account.</p><Link className="btn primary" to="/auth">Log in or create account</Link></div></Shell>;
 const change=(key,value)=>setForm(v=>({...v,[key]:value}));
 const choosePhoto=file=>{if(photo)URL.revokeObjectURL(photo);setPhotoFile(file||null);setPhoto(file?URL.createObjectURL(file):null);};
 const publish=async()=>{setBusy(true);setError('');try{let imageUploadId='';if(photoFile){setUploading(true);const uploaded=await api.uploadMarketplaceImage(photoFile);imageUploadId=uploaded.upload.id;setUploading(false);}const result=await api.createMarketplaceListing({...form,imageUploadId,price:Number(String(form.price).replace(/,/g,''))});navigate(`/product/${result.listing.id}`);}catch(err){setError(err.message||'Could not publish listing.');setUploading(false);}finally{setBusy(false);}};
 const preview=photo||listings[0].image;
 return <Shell><div className="page sell-page"><div className="section-head"><div><h1>Create a Listing</h1><p>This listing will be stored in the MeetMart database and shown only in your city.</p></div><div className="stepper"><span className="active">1 Details</span><span>2 Photo</span><span>3 Preview</span><span>4 Publish</span></div></div>{error&&<div className="checkout-error">{error}</div>}<div className="sell-layout"><section className="form-card"><h2>Product Details</h2><label>Product Title *<input value={form.title} onChange={e=>change('title',e.target.value)} placeholder="e.g. iPhone 13 128GB"/></label><div className="form-row"><label>Category *<select value={form.category} onChange={e=>change('category',e.target.value)}>{categories.map(([x])=><option key={x}>{x}</option>)}</select></label><label>Price (₦) *<input value={form.price} onChange={e=>change('price',e.target.value)} inputMode="numeric" placeholder="420000"/></label><label>Condition *<select value={form.condition} onChange={e=>change('condition',e.target.value)}><option>Brand New</option><option>Used - Like New</option><option>Foreign Used</option><option>Nigerian Used</option></select></label></div><label>Description *<textarea value={form.description} onChange={e=>change('description',e.target.value)} placeholder="Be honest about condition, faults and what is included."/></label><div className="form-row"><label>City<input value={user.city||'Kaduna'} disabled/></label><label>Area in Kaduna<select value={form.area} onChange={e=>change('area',e.target.value)}><option>Kaduna North</option><option>Kaduna South</option><option>Barnawa</option><option>Kawo</option><option>Ungwan Rimi</option></select></label></div></section><section className="upload-card"><h2>Photo Preview</h2><label className="upload"><Camera/><b>Upload product photo</b><small>JPEG, PNG or WebP • maximum 5 MB. The backend validates and stores the image.</small><input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>choosePhoto(e.target.files?.[0]||null)}/>{photoFile&&<em>{photoFile.name}</em>}</label><div className="safety-box"><ShieldCheck/><h3>Safety Reminders</h3><p>Meet in public places only.</p><p>Do not request online payment.</p><p>Keep private home addresses out of marketplace chats.</p></div></section><aside className="preview-card"><h2>Listing Preview</h2><img src={preview} alt="Listing preview"/><h3>{form.title||'Your listing title'}</h3><strong>{form.price?naira(Number(String(form.price).replace(/,/g,''))):'₦0'}</strong><small><MapPin size={13}/>{form.area}, {user.city||'Kaduna'}</small></aside></div><div className="sticky-actions"><button className="btn primary" disabled={busy} onClick={publish}>{uploading?'Uploading photo…':busy?'Publishing…':'Publish Listing'} <Send size={16}/></button></div></div></Shell>
}

function Requests(){
 const {user}=useAuth();
 const [items,setItems]=useState([]);
 const [showForm,setShowForm]=useState(false);
 const [form,setForm]=useState({title:'',details:'',category:'Other',budget:'',area:'Kaduna North',urgency:'This week'});
 const [responding,setResponding]=useState(null);
 const [responseText,setResponseText]=useState('I may have this item.');
 const [responsesByRequest,setResponsesByRequest]=useState({});
 const [openResponses,setOpenResponses]=useState(null);
 const [error,setError]=useState('');
 const load=async()=>{try{const r=await api.getWantedRequests();setItems(r.requests||[]);}catch(err){setError(err.message)}};
 useEffect(()=>{load();},[]);
 const create=async()=>{if(!user){setError('Sign in before posting a Wanted Request.');return;}try{await api.createWantedRequest({...form,budget:Number(String(form.budget).replace(/,/g,''))});setShowForm(false);setForm({title:'',details:'',category:'Other',budget:'',area:'Kaduna North',urgency:'This week'});await load();}catch(err){setError(err.message)}};
 const respond=async(id)=>{if(!user){setError('Sign in before responding.');return;}try{await api.respondWantedRequest(id,{message:responseText});setResponding(null);setResponseText('I may have this item.');await load();}catch(err){setError(err.message)}};
 const toggleResponses=async(id)=>{
   if(openResponses===id){setOpenResponses(null);return;}
   setOpenResponses(id);setError('');
   if(responsesByRequest[id])return;
   try{const r=await api.getWantedResponses(id);setResponsesByRequest(v=>({...v,[id]:r.responses||[]}));}
   catch(err){setError(err.message);}
 };
 return <Shell><div className="page requests-page"><section className="request-hero"><div><h1>Can’t find it?<br/><em>Post a Wanted Request</em></h1><p>Tell local sellers what you need. Requests are locked to the same city.</p></div><button className="btn primary" onClick={()=>setShowForm(!showForm)}><Plus/>Post a Wanted Request</button></section>{error&&<div className="checkout-error">{error}</div>}{showForm&&<section className="form-card"><h2>What are you looking for?</h2><label>Item name<input value={form.title} onChange={e=>setForm(v=>({...v,title:e.target.value}))}/></label><div className="form-row"><label>Category<select value={form.category} onChange={e=>setForm(v=>({...v,category:e.target.value}))}><option>Other</option>{categories.map(([x])=><option key={x}>{x}</option>)}</select></label><label>Budget (₦)<input value={form.budget} onChange={e=>setForm(v=>({...v,budget:e.target.value}))}/></label><label>Area<select value={form.area} onChange={e=>setForm(v=>({...v,area:e.target.value}))}><option>Kaduna North</option><option>Kaduna South</option><option>Barnawa</option><option>Kawo</option></select></label></div><label>Details<textarea value={form.details} onChange={e=>setForm(v=>({...v,details:e.target.value}))}/></label><button className="btn primary" onClick={create}>Publish request</button></section>}<div className="section-head"><h2>Wanted Requests in Kaduna</h2><Link to="/seller-tools" className="btn ghost"><Zap size={16}/>Seller lead alerts</Link></div>{items.length?<div className="request-grid">{items.map(r=>{const mine=user?.id===r.requester.id;const responses=responsesByRequest[r.id]||[];return <article className="request-card" key={r.id}><span className={`urgency ${r.urgency==='Urgent'?'red':''}`}>{r.urgency}</span><h3>{r.title}</h3><small>{r.details||'Buyer is looking for this item locally.'}</small><strong>Budget: {naira(r.budget)}</strong><small><MapPin size={13}/>{r.area}, {r.city}</small><small>{r.responseCount} response{r.responseCount===1?'':'s'}</small>{mine?<><button className="btn ghost full" onClick={()=>toggleResponses(r.id)}><MessageCircle size={15}/>{openResponses===r.id?'Hide responses':`View responses (${r.responseCount})`}</button>{openResponses===r.id&&<div className="wanted-responses">{responses.length?responses.map(resp=><div className="wanted-response" key={resp.id}><b>{resp.responder.displayName}</b><p>{resp.message}</p>{resp.listing&&<Link to={`/product/${resp.listing.id}`}>View linked listing — {naira(resp.listing.price)}</Link>}</div>):<small>No seller responses yet.</small>}</div>}</>:responding===r.id?<div><textarea value={responseText} onChange={e=>setResponseText(e.target.value)}/><button className="btn primary full" onClick={()=>respond(r.id)}>Send response</button></div>:<button className="btn ghost full" onClick={()=>setResponding(r.id)}><MessageCircle size={15}/>Respond</button>}</article>})}</div>:<div className="empty-orders"><Package/><h2>No wanted requests yet</h2><p>Post the first request in Kaduna.</p></div>}</div></Shell>
}

function Chat(){
 const {conversationId}=useParams(); const {user}=useAuth(); const navigate=useNavigate();
 const [conversations,setConversations]=useState([]); const [messages,setMessages]=useState([]); const [text,setText]=useState(''); const [error,setError]=useState('');
 const selected=conversations.find(c=>c.id===conversationId)||conversations[0]||null;
 const loadConversations=async()=>{if(!user)return;try{const r=await api.getConversations();setConversations(r.conversations||[]);if(!conversationId&&r.conversations?.[0])navigate(`/chat/${r.conversations[0].id}`,{replace:true});}catch(err){setError(err.message)}};
 useEffect(()=>{loadConversations();},[user?.id]);
 useEffect(()=>{if(!selected){setMessages([]);return;}api.getConversationMessages(selected.id).then(r=>setMessages(r.messages||[])).catch(err=>setError(err.message));},[selected?.id]);
 useEffect(()=>{if(!user||!selected)return;const stop=api.subscribeEvents((type,data)=>{if(type==='message.created'&&data.conversationId===selected.id){setMessages(v=>v.some(m=>m.id===data.id)?v:[...v,data]);loadConversations();}});return stop;},[user?.id,selected?.id]);
 const send=async()=>{if(!selected||!text.trim())return;try{const r=await api.sendConversationMessage(selected.id,text.trim());setMessages(v=>[...v,{...r.message,senderName:user.displayName}]);setText('');await loadConversations();}catch(err){setError(err.message)}};
 if(!user)return <Shell><div className="page empty-orders"><LockKeyhole/><h2>Sign in to use chat</h2><Link className="btn primary" to="/auth">Log in</Link></div></Shell>;
 return <Shell><div className="page chat-page"><aside className="chat-list"><h2>Chats</h2>{conversations.length?conversations.map(c=><button key={c.id} onClick={()=>navigate(`/chat/${c.id}`)} className={selected?.id===c.id?'active':''}><div className="avatar">{c.otherUser.displayName.split(' ').map(x=>x[0]).join('').slice(0,2)}</div><div><b>{c.otherUser.displayName}</b><small>{c.lastMessage||c.listing.title}</small></div></button>):<p>No conversations yet.</p>}</aside><section className="chat-thread">{error&&<div className="checkout-error">{error}</div>}{selected?<><div className="chat-header"><div className="avatar">{selected.otherUser.displayName[0]}</div><div><b>{selected.otherUser.displayName}</b><small>{selected.listing.area}, Kaduna</small></div></div><div className="chat-product"><img src={selected.listing.imageUrl||listings[0].image} alt={selected.listing.title}/><div><b>{selected.listing.title}</b><strong>{naira(selected.listing.price)}</strong><small><MapPin size={12}/>{selected.listing.area}, Kaduna</small></div></div><div className="chat-safety"><ShieldCheck size={17}/> Never pay online • Meet in approved public places</div><div className="messages">{messages.map(m=><div className={`bubble ${m.senderUserId===user.id?'mine':''}`} key={m.id}>{m.body}</div>)}</div><div className="quick-actions"><Link to={`/meetup/${selected.id}`}><MapPin/>Meetup options</Link><button><Flag/>Report</button></div><div className="composer"><input value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>e.key==='Enter'&&send()} placeholder="Type a message..."/><button onClick={send}><Send/></button></div></>:<div className="empty-orders"><MessageCircle/><h2>No chat selected</h2><p>Open a listing and contact the seller.</p></div>}</section><aside className="chat-profile">{selected&&<><div className="avatar big">{selected.otherUser.displayName[0]}</div><h2>{selected.otherUser.displayName}</h2><p>Marketplace user</p><p>Kaduna</p><Link className="btn primary full" to={`/product/${selected.listing.id}`}>View Listing</Link></>}</aside></div></Shell>
}

function Meetup(){
 const {conversationId}=useParams(); const {user}=useAuth();
 const [conversations,setConversations]=useState([]); const [locations,setLocations]=useState([]); const [meetups,setMeetups]=useState([]); const [selectedConversation,setSelectedConversation]=useState(conversationId||''); const [selectedLocation,setSelectedLocation]=useState(''); const defaultTime=()=>{const d=new Date(Date.now()+24*60*60*1000);d.setHours(10,0,0,0);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)}; const [scheduledAt,setScheduledAt]=useState(defaultTime); const [error,setError]=useState('');
 const load=async()=>{if(!user)return;try{const [c,l,m]=await Promise.all([api.getConversations(),api.getMeetupLocations(user.city||'Kaduna'),api.getMyMeetups()]);setConversations(c.conversations||[]);setLocations(l.locations||[]);setMeetups(m.meetups||[]);if(!selectedConversation&&c.conversations?.[0])setSelectedConversation(c.conversations[0].id);if(!selectedLocation&&l.locations?.[0])setSelectedLocation(l.locations[0].id);}catch(err){setError(err.message)}}; useEffect(()=>{load();},[user?.id]);
 const create=async()=>{try{await api.createMeetup({conversationId:selectedConversation,locationId:selectedLocation,scheduledAt:new Date(scheduledAt).toISOString()});await load();}catch(err){setError(err.message)}};
 const changeStatus=async(id,status)=>{try{await api.updateMeetupStatus(id,status);await load();}catch(err){setError(err.message)}};
 if(!user)return <Shell><div className="page empty-orders"><LockKeyhole/><h2>Sign in to plan a meetup</h2><Link className="btn primary" to="/auth">Log in</Link></div></Shell>;
 return <Shell><div className="page meetup-page"><section className="meetup-hero"><h1>Safe <em>Meetup Planner</em></h1><p>Only approved public places in {user.city||'Kaduna'} can be selected.</p></section>{error&&<div className="checkout-error">{error}</div>}<div className="meetup-layout"><section><h2>1 Choose the conversation</h2><select value={selectedConversation} onChange={e=>setSelectedConversation(e.target.value)}>{conversations.map(c=><option value={c.id} key={c.id}>{c.listing.title} — {c.otherUser.displayName}</option>)}</select><h2>2 Choose approved location</h2>{locations.map(l=><button key={l.id} className={`location-card ${selectedLocation===l.id?'selected':''}`} onClick={()=>setSelectedLocation(l.id)}><MapPin/><div><b>{l.name}</b><small>{l.kind} • {l.area}</small></div><span>›</span></button>)}</section><section><h2>3 Pick date & time</h2><input type="datetime-local" value={scheduledAt} onChange={e=>setScheduledAt(e.target.value)}/><div className="confirm-card"><h3>4 Confirm Meetup</h3><b>{locations.find(l=>l.id===selectedLocation)?.name||'Choose a location'}</b><small><CalendarDays/> {scheduledAt?new Date(scheduledAt).toLocaleString():''}</small></div><button className="btn primary full" disabled={!selectedConversation||!selectedLocation} onClick={create}><CheckCircle2/>Create Meetup</button></section><aside className="map-card"><div className="fake-map"><MapPin className="pin p1"/><MapPin className="pin p2"/><MapPin className="pin p3"/><b>Kaduna</b></div><p>Private homes cannot be selected as marketplace meetup locations.</p></aside></div><section className="section"><div className="section-head"><h2>Your meetups</h2></div>{meetups.length?<div className="request-grid">{meetups.map(m=><article className="request-card" key={m.id}><span className="urgency">{m.status}</span><h3>{m.listing.title}</h3><small><MapPin size={13}/>{m.location.name}</small><small>{new Date(m.scheduledAt).toLocaleString()}</small><div className="request-actions">{m.status==='pending'&&<><button className="btn primary" onClick={()=>changeStatus(m.id,'confirmed')}>Confirm</button><button className="btn ghost" onClick={()=>changeStatus(m.id,'cancelled')}>Cancel</button></>}{m.status==='confirmed'&&<><button className="btn primary" onClick={()=>changeStatus(m.id,'completed')}>Mark completed</button><button className="btn ghost" onClick={()=>changeStatus(m.id,'cancelled')}>Cancel</button></>}</div></article>)}</div>:<p>No meetups scheduled yet.</p>}</section></div></Shell>
}

function ReviewComposer({meetup,onCreated}){
 const [rating,setRating]=useState(5); const [body,setBody]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
 const submit=async()=>{setBusy(true);setError('');try{await api.createMarketplaceReview({meetupId:meetup.id,rating,body});setBody('');onCreated?.();}catch(err){setError(err.message)}finally{setBusy(false)}};
 return <div className="review-composer"><b>Review: {meetup.listing.title}</b><div className="form-row"><select value={rating} onChange={e=>setRating(Number(e.target.value))}>{[5,4,3,2,1].map(x=><option value={x} key={x}>{x} star{x===1?'':'s'}</option>)}</select><input value={body} onChange={e=>setBody(e.target.value)} placeholder="How did the meetup go?"/><button className="btn primary" disabled={busy} onClick={submit}>Submit review</button></div>{error&&<small>{error}</small>}</div>
}

function Profile(){
 const {identity}=useIdentity(); const {user}=useAuth(); const ninVerified=identity.nin?.status==='demo_verified'||identity.nin?.status==='verified'; const bvnVerified=identity.bvn?.status==='demo_verified'||identity.bvn?.status==='verified';
 const [mine,setMine]=useState([]); const [saved,setSaved]=useState([]); const [meetups,setMeetups]=useState([]); const [reviews,setReviews]=useState({summary:{average:0,count:0},reviews:[]}); const [error,setError]=useState('');
 const load=async()=>{if(!user)return;try{const [a,b,c,d]=await Promise.all([api.getMyMarketplaceListings(),api.getSavedMarketplaceListings(),api.getMyMeetups(),api.getMarketplaceUserReviews(user.id)]);setMine(a.listings||[]);setSaved(b.listings||[]);setMeetups(c.meetups||[]);setReviews(d);}catch(err){setError(err.message)}}; useEffect(()=>{load();},[user?.id]);
 if(!user)return <Shell><div className="page empty-orders"><LockKeyhole/><h2>Sign in to view your profile</h2><Link className="btn primary" to="/auth">Log in</Link></div></Shell>;
 const initials=user.displayName.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase(); const completed=meetups.filter(x=>x.status==='completed').length;
 return <Shell><div className="page profile-page"><aside className="profile-side">{['Dashboard','My Listings','Saved Items','Reviews','Meetups','Settings'].map((x,i)=><button key={x} className={i===0?'active':''}>{x}</button>)}</aside><section className="profile-main">{error&&<div className="checkout-error">{error}</div>}<div className="profile-hero"><div className="avatar huge">{initials}</div><div><h1>{user.displayName}</h1><p>{user.email}</p><small><MapPin size={13}/>{user.city}</small><div className="chips"><span>{ninVerified?'Identity Verified':'Identity Not Verified'}</span>{bvnVerified&&<span>Financial ID Check</span>}</div><SellerPlanPill/><div className="profile-verify-action"><Link className="btn ghost" to="/verification"><ShieldCheck size={16}/>{ninVerified?'Manage identity checks':'Verify identity'}</Link></div></div><div className="rating-box"><Star fill="currentColor"/><strong>{reviews.summary?.average||'New'}</strong><small>{reviews.summary?.count||0} reviews</small></div></div><div className="stat-grid"><div><Package/><strong>{mine.filter(x=>x.status==='active').length}</strong><small>Active Listings</small></div><div><ShieldCheck/><strong>{completed}</strong><small>Completed Meetups</small></div><div><Heart/><strong>{saved.length}</strong><small>Saved Items</small></div><div><Star/><strong>{reviews.summary?.count||0}</strong><small>Total Reviews</small></div></div><SellerRevenuePanel/><section className="section"><div className="section-head"><h2>My Listings</h2><Link to="/sell">Create listing →</Link></div>{mine.length?<div className="listing-grid">{mine.slice(0,6).map(x=><ProductCard key={x.id} item={x}/>)}</div>:<p>You have not posted any marketplace listings yet.</p>}</section><section className="section"><div className="section-head"><h2>Saved Items</h2></div>{saved.length?<div className="listing-grid">{saved.slice(0,6).map(x=><ProductCard key={x.id} item={{...x,saved:true}}/>)}</div>:<p>No saved items yet.</p>}</section><section className="reviews"><h2>Reviews & Ratings</h2><div className="rating-summary"><strong>{reviews.summary?.average||'—'}</strong><span>★★★★★</span><small>Based on {reviews.summary?.count||0} reviews</small></div>{reviews.reviews?.length?reviews.reviews.map(r=><article key={r.id}><div className="avatar">{r.reviewerName?.[0]||'R'}</div><div><b>{r.reviewerName}</b><span>{'★'.repeat(r.rating)}</span><p>{r.body||'Completed a MeetMart meetup.'}</p></div></article>):<p>No reviews yet.</p>}</section>{meetups.filter(m=>m.status==='completed'&&!reviews.reviews?.some(r=>r.meetupId===m.id)).length>0&&<section className="section"><h2>Leave reviews after completed meetups</h2>{meetups.filter(m=>m.status==='completed'&&!reviews.reviews?.some(r=>r.meetupId===m.id)).map(m=><ReviewComposer key={m.id} meetup={m} onCreated={load}/>)}</section>}</section></div></Shell>
}

function SellerPlanPill(){
 const {plan}=useBusiness();
 return <Link className="seller-plan-pill" to="/seller-tools"><Crown size={14}/>{plan.name}<ArrowRight size={13}/></Link>
}

function SellerRevenuePanel(){
 const {plan}=useBusiness();
 return <section className="seller-revenue-panel">
   <div><span className="eyebrow">SELLER GROWTH</span><h2>Grow your local sales</h2><p>You are on <b>{plan.name}</b>. Promotions buy visibility only — verification and safety badges cannot be purchased.</p></div>
   <div className="seller-revenue-actions"><Link className="btn primary" to="/seller-tools"><Rocket size={16}/>Boost a listing</Link><Link className="btn ghost" to="/seller-tools"><Crown size={16}/>View plans</Link></div>
 </section>
}

function SellerTools(){
 const {sellerPlan,plan,upgrade,boostListing,isBoosted}=useBusiness();
 const [selectedListing,setSelectedListing]=useState(listings[0].id);
 const [notice,setNotice]=useState('');
 const [tab,setTab]=useState('overview');
 const activateBoost=(pkg)=>{boostListing(selectedListing,pkg);setNotice(`${listings.find(x=>x.id===selectedListing)?.title} is now boosted for ${pkg.label}. Demo mode: no payment was charged.`)};
 const activeCount=3;
 return <Shell><div className="page seller-tools-page">
   <section className="seller-tools-hero">
     <div><span className="eyebrow">MEETMART SELLER CENTER</span><h1>Sell more, without making buying expensive.</h1><p>Buyers stay free. Sellers can pay for better visibility and business tools. Trust badges remain verification-based and can never be purchased.</p></div>
     <div className="current-plan-card"><Crown/><small>Current plan</small><strong>{plan.name}</strong><span>{plan.price} {plan.cadence}</span><button className="btn primary" onClick={()=>setTab('plans')}>Manage plan</button></div>
   </section>

   <div className="seller-tabs"><button className={tab==='overview'?'active':''} onClick={()=>setTab('overview')}>Overview</button><button className={tab==='boost'?'active':''} onClick={()=>setTab('boost')}>Boost listings</button><button className={tab==='plans'?'active':''} onClick={()=>setTab('plans')}>Plans</button></div>

   {notice&&<div className="success-notice"><CheckCircle2/>{notice}<button onClick={()=>setNotice('')}>×</button></div>}

   {tab==='overview'&&<>
     <div className="seller-kpis">
       <div><Eye/><strong>1,248</strong><small>Listing views this month</small><span>+18%</span></div>
       <div><MessageCircle/><strong>86</strong><small>Buyer conversations</small><span>+12%</span></div>
       <div><TrendingUp/><strong>31</strong><small>Meetup intentions</small><span>+9%</span></div>
       <div><Package/><strong>{activeCount}/{plan.listingLimit}</strong><small>Active listing allowance</small><span>{sellerPlan==='free'?'Upgrade for more':'Included'}</span></div>
     </div>
     <div className="seller-tool-grid">
       <section className="tool-card"><div className="tool-icon"><Rocket/></div><h2>Boost a listing</h2><p>Place a product higher in search and featured sections. Every paid placement is clearly labelled Sponsored.</p><button className="btn primary" onClick={()=>setTab('boost')}>Choose a listing <ArrowRight size={16}/></button></section>
       <section className="tool-card"><div className="tool-icon"><Zap/></div><h2>Wanted Request leads</h2><p>{sellerPlan==='free'?'Free sellers can respond normally. Pro and Business sellers can receive instant matching alerts.':'Instant matching alerts are enabled for your plan.'}</p><button className="btn ghost" onClick={()=>setTab('plans')}>{sellerPlan==='free'?'Unlock instant alerts':'Manage alerts'}</button></section>
       <section className="tool-card"><div className="tool-icon"><Store/></div><h2>Professional storefront</h2><p>Business sellers can organize products under a branded shop profile without changing their trust status.</p><button className="btn ghost" onClick={()=>setTab('plans')}>See Business plan</button></section>
     </div>
   </>}

   {tab==='boost'&&<section className="boost-builder">
     <div><span className="eyebrow">STEP 1</span><h2>Choose a listing</h2><div className="boost-listings">{listings.slice(0,3).map(item=><button key={item.id} className={selectedListing===item.id?'selected':''} onClick={()=>setSelectedListing(item.id)}><img src={item.image} alt={item.title}/><span><b>{item.title}</b><small>{item.price}</small></span>{isBoosted(item.id)&&<em>Boosted</em>}</button>)}</div></div>
     <div><span className="eyebrow">STEP 2</span><h2>Choose visibility</h2><div className="boost-packages">{BOOST_PACKAGES.map(pkg=><article className={pkg.popular?'popular':''} key={pkg.id}>{pkg.popular&&<span>Most popular</span>}<Rocket/><h3>{pkg.label}</h3><strong>{pkg.price}</strong><p>Higher placement in Kaduna search and featured results.</p><button className="btn primary full" onClick={()=>activateBoost(pkg)}>Boost now</button></article>)}</div><p className="fine-print"><LockKeyhole size={14}/>Boosting changes ranking visibility only. It never adds verification, reviews, or a safety badge.</p></div>
   </section>}

   {tab==='plans'&&<section id="plans"><div className="section-head"><div><span className="eyebrow">SELLER PLANS</span><h2>Start free. Upgrade when MeetMart is bringing you customers.</h2></div></div><div className="pricing-grid">{Object.entries(SELLER_PLANS).map(([key,p])=><article className={`pricing-card ${sellerPlan===key?'current':''}`} key={key}>{sellerPlan===key&&<span className="current-badge">Current plan</span>}<h3>{p.name}</h3><div className="plan-price"><strong>{p.price}</strong><small>{p.cadence}</small></div><ul>{p.features.map(f=><li key={f}><CheckCircle2 size={15}/>{f}</li>)}</ul><button className={`btn full ${sellerPlan===key?'ghost':'primary'}`} disabled={sellerPlan===key} onClick={()=>{upgrade(key);setNotice(`Your demo seller plan is now ${p.name}. No payment was charged.`)}}>{sellerPlan===key?'Active plan':`Choose ${p.name}`}</button></article>)}</div></section>}

   <section className="trust-boundary"><BadgeCheck/><div><h3>Trust is not for sale</h3><p>Identity verification, phone verification, seller ratings, reviews, completed meetups and approved meetup locations are never granted because someone paid MeetMart.</p></div></section>
 </div></Shell>
}


const naira = (n)=>`₦${Number(n||0).toLocaleString('en-NG')}`;

const STORE_VISUALS = {
  Food:{icon:'🍲',copy:'Meals, baked goods and prepared food'},
  Groceries:{icon:'🛒',copy:'Groceries and household essentials'},
  Electronics:{icon:'📱',copy:'Phones, gadgets and consumer electronics'},
  Fashion:{icon:'👕',copy:'Clothing, shoes and accessories'},
  Home:{icon:'🛋️',copy:'Furniture and practical home items'},
  Beauty:{icon:'💄',copy:'Beauty, personal care and cosmetics'},
  Books:{icon:'📚',copy:'Books, school supplies and stationery'},
  Computers:{icon:'💻',copy:'Computers, peripherals and accessories'},
};
const storeVisual = category => STORE_VISUALS[category] || {icon:'🏪',copy:'Verified local retailer'};
const itemLabelForCategory = category => category === 'Food' ? 'Menu' : 'Products';
const orderStatusLabel = status => ({payment_pending:'Payment pending',paid:'Paid',preparing:'Preparing',out_for_delivery:'Out for delivery',delivered:'Delivered',cancelled:'Cancelled',refund_pending:'Refund review',refunded:'Refunded'}[status] || String(status||'Unknown').replaceAll('_',' '));
const orderStatusClass = status => ['delivered','paid','refunded'].includes(status) ? 'done' : ['cancelled','refund_pending'].includes(status) ? 'danger' : 'active';


function StoresHome(){
 const [category,setCategory]=useState('All');
 const [merchants,setMerchants]=useState([]);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');
 const [refreshKey,setRefreshKey]=useState(0);
 useEffect(()=>{
  let active=true;
  setLoading(true);setError('');
  api.getMerchants().then(result=>{if(active)setMerchants(result.merchants||[]);}).catch(err=>{if(active){setMerchants([]);setError(err.message||'Unable to load verified stores.');}}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[refreshKey]);
 const visible=category==='All'?merchants:merchants.filter(store=>store.category===category);
 return <Shell mode="stores"><div className="page food-page">
  <section className="food-hero"><div><span className="eyebrow">MEETMART VERIFIED STORES • KADUNA</span><h1>Delivery and online payment from merchants we <em>verify ourselves.</em></h1><p>Store cards on this page now come from the MeetMart backend database. Online checkout is exposed only for merchants that the server marks verified and checkout-enabled.</p><div className="food-search"><Search size={18}/><input placeholder="Search verified stores or products..."/><button className="btn primary">Search</button></div><div className="food-trust-row"><span><BadgeCheck/>Server-verified merchants</span><span><WalletCards/>ASD Pay checkout</span><span><Bike/>Delivery supported</span></div></div><div className="food-hero-card"><Store/><b>Two marketplace modes</b><small>Regular person-to-person listings still use public meetups with no online payment. Online checkout is reserved for verified stores returned by the backend.</small><Link className="btn ghost" to="/search">Go to Marketplace</Link></div></section>
  <div className="store-category-bar" aria-label="Store categories">{storeCategories.map(([name,icon])=><button key={name} className={category===name?'active':''} onClick={()=>setCategory(name)}><span>{icon}</span>{name}</button>)}</div>
  <div className="section-head"><div><h2>{category==='All'?'Verified stores in Kaduna':`${category} stores in Kaduna`}</h2><p>{loading?'Loading from the MeetMart API…':`${visible.length} checkout-enabled merchant${visible.length===1?'':'s'} found.`}</p></div><div className="request-actions"><Link className="btn ghost" to="/stores/apply">Apply as a store</Link><Link to="/stores/orders">My orders →</Link></div></div>
  {error&&<div className="checkout-error api-error"><b>Could not load stores.</b> {error}<button className="btn ghost" onClick={()=>setRefreshKey(x=>x+1)}>Retry</button></div>}
  {!loading&&!error&&visible.length===0?<div className="empty-orders"><Store/><h2>No verified stores in this category yet</h2><p>Verified merchants will appear here after the backend approval workflow is completed.</p><Link className="btn primary" to="/stores/apply">Apply as a merchant</Link></div>:<section className="restaurant-grid">{visible.map(merchant=>{const visual=storeVisual(merchant.category);return <Link className="restaurant-card api-store-card" to={`/stores/${merchant.id}`} key={merchant.id}><div className="merchant-placeholder"><span>{visual.icon}</span><small>{merchant.category}</small></div><div><span className="verified-food"><BadgeCheck size={14}/>MeetMart Verified Store</span><h3>{merchant.name}</h3><p>{visual.copy}</p><div className="restaurant-meta"><span><Bike size={14}/>{merchant.deliveryFee?naira(merchant.deliveryFee):'Delivery fee set at checkout'}</span><span><WalletCards size={14}/>ASD Pay</span></div><small><MapPin size={13}/>{merchant.city||'Kaduna'} • {merchant.category}</small></div></Link>})}</section>}
  <section className="food-how"><h2>How verified commerce works</h2><div className="steps"><div><span>1</span><b>Choose</b><small>Shop from a backend-approved merchant.</small></div><div><span>2</span><b>Pay</b><small>The server creates the ASD Pay payment intent.</small></div><div><span>3</span><b>Merchant fulfils</b><small>The verified business receives the paid order.</small></div><div><span>4</span><b>Delivery</b><small>Status is updated through the merchant API.</small></div></div></section>
 </div></Shell>
}

function StorePage(){
 const navigate=useNavigate();
 const {id}=useParams();
 const [merchant,setMerchant]=useState(null);
 const [cart,setCart]=useState({});
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');
 useEffect(()=>{
  let active=true;setLoading(true);setError('');setMerchant(null);
  api.getMerchant(id).then(result=>{if(active)setMerchant(result.merchant||null);}).catch(err=>{if(active)setError(err.message||'Unable to load this store.');}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[id]);
 if(loading) return <Shell mode="stores"><div className="page"><div className="empty-orders"><Store/><h2>Loading verified store…</h2><p>Reading merchant and product data from the backend.</p></div></div></Shell>;
 if(error||!merchant) return <Shell mode="stores"><div className="page"><div className="empty-orders"><Store/><h2>Verified store unavailable</h2><p>{error||'This merchant is no longer available for online checkout.'}</p><Link className="btn primary" to="/stores">Back to stores</Link></div></div></Shell>;
 const visual=storeVisual(merchant.category);
 const products=(merchant.products||[]).filter(item=>item.active!==false);
 const add=(item)=>setCart(current=>({...current,[item.id]:(current[item.id]||0)+1}));
 const cartCount=Object.values(cart).reduce((a,b)=>a+b,0);
 const subtotal=products.reduce((sum,item)=>sum+item.price*(cart[item.id]||0),0);
 const goCheckout=()=>{
   if(!merchant.verified||!merchant.checkoutEnabled||cartCount===0) return;
   if(safeSessionSet('meetmart-store-cart',JSON.stringify({merchantId:merchant.id,cart}))) navigate('/stores/checkout');
 };
 return <Shell mode="stores"><div className="page restaurant-page"><section className="restaurant-banner api-merchant-banner"><div className="merchant-placeholder large"><span>{visual.icon}</span><small>{merchant.category}</small></div><div><span className="verified-food"><BadgeCheck size={14}/>MeetMart Verified Store</span><h1>{merchant.name}</h1><p>{visual.copy}</p><div className="restaurant-meta"><span><WalletCards size={15}/>ASD Pay enabled</span><span><Bike size={15}/>{merchant.deliveryFee?`${naira(merchant.deliveryFee)} delivery`:'Delivery fee configured by merchant'}</span><span><MapPin size={15}/>{merchant.city||'Kaduna'}</span></div><div className="merchant-checks"><span><CheckCircle2/>Backend verification passed</span><span><CheckCircle2/>Checkout enabled</span><span><CheckCircle2/>Server-priced products</span></div></div></section><div className="restaurant-layout"><section><div className="section-head"><div><h2>{itemLabelForCategory(merchant.category)}</h2><p>Product names and prices below are loaded from the merchant database.</p></div></div>{products.length===0?<div className="empty-orders compact"><Package/><h2>No active products yet</h2><p>This merchant has not published any products.</p></div>:<div className="menu-grid">{products.map(item=><article className="menu-card api-menu-card" key={item.id}><div className="product-placeholder"><Package/></div><div><h3>{item.name}</h3><p>{item.description||'Verified-store product'}</p><strong>{naira(item.price)}</strong><button className="btn primary" onClick={()=>add(item)}><Plus size={16}/>Add</button>{cart[item.id]>0&&<span className="qty-badge">{cart[item.id]} in cart</span>}</div></article>)}</div>}</section><aside className="cart-summary"><ShoppingBag/><h2>Your order</h2>{cartCount===0?<p>Add a product to start your order.</p>:<><div className="cart-lines">{products.filter(item=>cart[item.id]).map(item=><span key={item.id}><b>{cart[item.id]}× {item.name}</b><strong>{naira(item.price*cart[item.id])}</strong></span>)}</div><div className="cart-total"><span>Subtotal</span><strong>{naira(subtotal)}</strong></div><button className="btn primary full" onClick={goCheckout}>Checkout with ASD Pay <ArrowRight size={16}/></button><small className="privacy-note"><LockKeyhole size={13}/>Final price, delivery fee, commission and settlement are recalculated by the server.</small></>}</aside></div></div></Shell>
}

function StoreCheckout(){
 const navigate=useNavigate();
 const {user}=useAuth();
 const saved=(()=>{try{const current=JSON.parse(safeSessionGet('meetmart-store-cart','null'));if(current)return current;const legacy=JSON.parse(safeSessionGet('meetmart-food-cart','null'));return legacy?{merchantId:legacy.restaurantId,cart:legacy.cart}:null}catch{return null}})();
 const [merchant,setMerchant]=useState(null);
 const [commerceConfig,setCommerceConfig]=useState({commissionRate:0.05,customerServiceFee:300,currency:'NGN',asdPayMode:'demo'});
 const [loading,setLoading]=useState(Boolean(saved?.merchantId));
 const [loadError,setLoadError]=useState('');
 const cart=saved?.cart||{};
 useEffect(()=>{
  if(!saved?.merchantId){setLoading(false);return;}
  let active=true;setLoading(true);setLoadError('');
  Promise.all([api.getMerchant(saved.merchantId),api.getCommerceConfig()]).then(([merchantResult,configResult])=>{if(active){setMerchant(merchantResult.merchant||null);setCommerceConfig(configResult||{commissionRate:0.05,customerServiceFee:300,currency:'NGN',asdPayMode:'demo'});}}).catch(err=>{if(active)setLoadError(err.message||'Unable to load checkout merchant.');}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[saved?.merchantId]);
 const items=merchant?(merchant.products||[]).filter(item=>Number(cart[item.id])>0).map(item=>({...item,qty:Number(cart[item.id])})):[];
 const subtotal=items.reduce((sum,item)=>sum+item.price*item.qty,0);
 const estimate=(()=>{const deliveryFee=Number(merchant?.deliveryFee||0);const commission=Math.round(subtotal*Number(commerceConfig.commissionRate||0));const serviceFee=Math.round(Number(commerceConfig.customerServiceFee||0));return {subtotal,deliveryFee,serviceFee,commission,customerTotal:subtotal+deliveryFee+serviceFee,merchantSettlement:subtotal-commission+deliveryFee,meetMartGrossRevenue:commission+serviceFee};})();
 const [address,setAddress]=useState('Kaduna North, Kaduna');
 const [stage,setStage]=useState('review');
 const [order,setOrder]=useState(null);
 const [checkoutError,setCheckoutError]=useState('');
 const [busy,setBusy]=useState(false);
 const pay=async()=>{
   if(!user){setCheckoutError('Sign in before paying with ASD Pay.');return;}
   if(!merchant||items.length===0){setCheckoutError('Your cart is empty. Return to a verified store and add an item.');return;}
   if(!merchant.verified||!merchant.checkoutEnabled){setCheckoutError('This merchant is not enabled for online checkout.');return;}
   if(address.trim().length<8){setCheckoutError('Enter a valid delivery address before continuing.');return;}
   setBusy(true);setCheckoutError('');
   try{
    const result=await api.createCheckout({merchantId:merchant.id,deliveryAddress:address.trim(),items:items.map(item=>({productId:item.id,quantity:item.qty}))});
    setOrder(result.order);setStage('asdpay');
   }catch(error){setCheckoutError(error.message||'Unable to start ASD Pay checkout.');}
   finally{setBusy(false);}
 };
 const confirm=async()=>{
   if(!order?.id){setCheckoutError('Payment session is missing. Start checkout again.');setStage('review');return;}
   setBusy(true);setCheckoutError('');
   try{const result=await api.confirmDemoCheckout(order.id);setOrder(current=>({...current,...result.order}));setStage('success');safeSessionRemove('meetmart-store-cart');safeSessionRemove('meetmart-food-cart');}
   catch(error){setCheckoutError(error.message||'Unable to confirm payment.');}
   finally{setBusy(false);}
 };
 if(loading) return <Shell mode="stores"><div className="page checkout-page"><div className="empty-orders"><WalletCards/><h2>Preparing secure checkout…</h2><p>Loading the merchant and server-priced products.</p></div></div></Shell>;
 if(loadError) return <Shell mode="stores"><div className="page checkout-page"><div className="empty-orders"><ShoppingBag/><h2>Checkout unavailable</h2><p>{loadError}</p><Link className="btn primary" to="/stores">Browse verified stores</Link></div></div></Shell>;
 if(!merchant||items.length===0) return <Shell mode="stores"><div className="page checkout-page"><div className="empty-orders"><ShoppingBag/><h2>Your store cart is empty</h2><p>Choose a MeetMart Verified Store and add at least one item before checkout.</p><Link className="btn primary" to="/stores">Browse verified stores</Link></div></div></Shell>;
 const settlement=order?{subtotal:order.subtotal,deliveryFee:order.deliveryFee,serviceFee:order.serviceFee,commission:order.commission,customerTotal:order.customerTotal,merchantSettlement:order.merchantSettlement,meetMartGrossRevenue:order.meetMartGrossRevenue}:estimate;
 return <Shell mode="stores"><div className="page checkout-page"><div className="checkout-head"><div><span className="eyebrow">MEETMART VERIFIED STORE CHECKOUT</span><h1>{stage==='success'?'Order placed successfully':'Checkout'}</h1></div><div className="checkout-steps"><span className={stage==='review'?'active':''}>1 Review</span><span className={stage==='asdpay'?'active':''}>2 ASD Pay</span><span className={stage==='success'?'active':''}>3 Confirmed</span></div></div>{stage==='success'?<section className="payment-success"><CheckCheck/><h2>Payment confirmed by the backend</h2><p>Order <b>{order.id}</b> has been recorded for {merchant.name}.</p>{order.deliveryPin&&<div className="delivery-pin-box"><LockKeyhole/><div><small>Proof-of-delivery PIN</small><strong>{order.deliveryPin}</strong><p>Keep this private. Give it to the delivery person only after you have received and checked your order.</p></div></div>}<div className="status-track"><span className="done">Paid</span><span className="active">Merchant queue</span><span>Preparing</span><span>Out for delivery</span><span>Delivered</span></div><Link className="btn primary" to="/stores/orders">Track my order</Link></section>:<div className="checkout-grid"><section className="checkout-card"><h2>Delivery details</h2>{checkoutError&&<div className="success-notice checkout-error">{checkoutError}{!user&&<button className="btn ghost" onClick={()=>navigate('/auth')}>Sign in</button>}</div>}<label>Delivery address<textarea value={address} onChange={event=>setAddress(event.target.value)}/></label><h2>Your items</h2>{items.map(item=><div className="checkout-line" key={item.id}><div className="product-placeholder tiny"><Package/></div><span><b>{item.qty}× {item.name}</b><small>{merchant.name}</small></span><strong>{naira(item.price*item.qty)}</strong></div>)}{stage==='asdpay'&&<div className="asd-pay-panel"><div className="asd-pay-logo"><WalletCards/>ASD Pay</div><h2>Payment intent created</h2><p>The MeetMart backend has already recalculated product prices, delivery fee, service fee, commission and merchant settlement. The browser cannot override those amounts.</p><div className="asd-pay-reference"><span>Payment reference</span><b>{order.paymentReference}</b></div><button className="btn primary full" disabled={busy} onClick={confirm}><CreditCard size={17}/>{busy?'Confirming…':'Complete demo payment'}</button><small>{commerceConfig.asdPayMode==='demo'?'Demo mode only. No real money moves until the production ASD Pay provider is configured.':'ASD Pay production mode is configured on the backend.'}</small></div>}</section><aside className="order-summary"><ReceiptText/><h2>Order summary</h2><div><span>Items subtotal</span><b>{naira(settlement.subtotal)}</b></div><div><span>Delivery</span><b>{naira(settlement.deliveryFee)}</b></div><div><span>MeetMart service fee</span><b>{naira(settlement.serviceFee)}</b></div><div className="summary-total"><span>Total</span><strong>{naira(settlement.customerTotal)}</strong></div>{stage==='review'&&<button className="btn primary full" disabled={busy} onClick={pay}>{busy?'Creating payment…':'Pay with ASD Pay'} <ArrowRight size={16}/></button>}<div className="settlement-preview"><b>{order?'Server settlement':'Estimated settlement before server confirmation'}</b><small>Merchant receives: {naira(settlement.merchantSettlement)}</small><small>MeetMart gross revenue: {naira(settlement.meetMartGrossRevenue)}</small><small>Commission: {naira(settlement.commission)}</small><small>Payment-rail fees stay inside ASD Pay and are not trusted from browser input.</small></div></aside></div>}</div></Shell>
}

function StoreOrders(){
 const {user}=useAuth();
 const [orders,setOrders]=useState([]);
 const [loading,setLoading]=useState(Boolean(user));
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [refreshKey,setRefreshKey]=useState(0);
 const refresh=()=>setRefreshKey(x=>x+1);
 useEffect(()=>{
  if(!user){setOrders([]);setLoading(false);return;}
  let active=true;setLoading(true);setError('');
  api.getMyOrders().then(result=>{if(active)setOrders(result.orders||[]);}).catch(err=>{if(active)setError(err.message||'Unable to load orders.');}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[user?.id,refreshKey]);
 const resetPin=async order=>{setError('');setNotice('');try{const result=await api.resetDeliveryPin(order.id);window.alert(`Your new proof-of-delivery PIN is ${result.order.deliveryPin}. Keep it private until you receive the order.`);setNotice(`A new delivery PIN was generated for ${order.id}.`);refresh();}catch(err){setError(err.message)}};
 const requestRefund=async order=>{const reason=window.prompt('Why are you requesting a refund?');if(!reason)return;setError('');setNotice('');try{await api.requestRefund(order.id,reason);setNotice(`Refund case opened for ${order.id}. Fulfilment is paused for review.`);refresh();}catch(err){setError(err.message)}};
 const cancel=async order=>{const reason=window.prompt('Why are you cancelling this order?','Customer requested cancellation.');if(!reason)return;setError('');setNotice('');try{await api.cancelOrder(order.id,reason);setNotice(`Cancellation request recorded for ${order.id}.`);refresh();}catch(err){setError(err.message)}};
 const dispute=async(order,type='dispute')=>{const promptText=type==='address_misuse'?'Describe how your delivery address or private information was misused.':'Describe the delivery, product, or payment problem.';const reason=window.prompt(promptText);if(!reason)return;setError('');setNotice('');try{await api.openOrderDispute(order.id,reason,type);setNotice(type==='address_misuse'?'Privacy report sent to MeetMart admins.':'Dispute opened for admin review.');refresh();}catch(err){setError(err.message)}};
 if(!user) return <Shell mode="stores"><div className="page food-orders-page"><div className="empty-orders"><ShoppingBag/><h2>Sign in to see your orders</h2><p>Paid verified-store orders are stored against your MeetMart account.</p><Link className="btn primary" to="/auth">Sign in</Link></div></div></Shell>;
 return <Shell mode="stores"><div className="page food-orders-page"><div className="section-head"><div><h1>My Store Orders</h1><p>Protected delivery, refunds and disputes are controlled by the MeetMart backend.</p></div><div className="request-actions"><button className="btn ghost" onClick={refresh}>Refresh</button><Link className="btn primary" to="/stores">Shop verified stores</Link></div></div>{error&&<div className="checkout-error">{error}</div>}{notice&&<div className="success-notice"><CheckCircle2/>{notice}</div>}{loading?<div className="empty-orders compact"><ReceiptText/><h2>Loading orders…</h2></div>:orders.length===0?<div className="empty-orders"><ShoppingBag/><h2>No store orders yet</h2><p>Your orders will appear here after ASD Pay checkout.</p></div>:<div className="food-order-list">{orders.map(order=><article key={order.id} className="protected-order-card"><div><span className="verified-food"><BadgeCheck size={14}/>{order.paidAt?'ASD Pay order':'Payment pending'}</span><h3>{order.merchantName}</h3><small>Order {order.id} • {order.merchantCategory}</small><small>{(order.items||[]).map(item=>`${item.quantity}× ${item.name}`).join(' • ')}</small><small><MapPin size={12}/> {order.deliveryAddress}</small>{order.deliveryPinRequired&&<small className="privacy-inline"><LockKeyhole size={12}/>Delivery PIN active • ending in {order.deliveryPinLast2||'••'}</small>}</div><strong>{naira(order.customerTotal)}</strong><div className={`order-status ${orderStatusClass(order.status)}`}>{orderStatusLabel(order.status)}</div><div className="order-safety-actions">{order.deliveryPinRequired&&<button className="btn ghost" onClick={()=>resetPin(order)}>Reset delivery PIN</button>}{order.status==='payment_pending'&&<button className="btn ghost" onClick={()=>cancel(order)}>Cancel order</button>}{['paid','preparing'].includes(order.status)&&<button className="btn ghost" onClick={()=>requestRefund(order)}>Request refund</button>}{!['payment_pending','cancelled','refunded'].includes(order.status)&&<button className="btn ghost" onClick={()=>dispute(order)}>Open dispute</button>}{order.paidAt&&!['cancelled','refunded'].includes(order.status)&&<button className="btn ghost" onClick={()=>dispute(order,'address_misuse')}>Report address misuse</button>}</div>{(order.cases||[]).length>0&&<div className="case-list">{order.cases.map(c=><small key={c.id}><b>{c.type.replaceAll('_',' ')}</b> • {c.status}{c.resolution?` • ${c.resolution}`:''}</small>)}</div>}</article>)}</div>}</div></Shell>
}

function IdentityVerification(){
 const {identity,verify}=useIdentity();
 const {user}=useAuth();
 const [type,setType]=useState('nin');
 const [fullName,setFullName]=useState(user?.displayName||'');
 const [identifier,setIdentifier]=useState('');
 const [consent,setConsent]=useState(false);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [busy,setBusy]=useState(false);
 const [merchantEligible,setMerchantEligible]=useState(user?.role==='merchant');
 useEffect(()=>{setFullName(prev=>prev||user?.displayName||'');},[user?.displayName]);
 useEffect(()=>{
   let active=true;
   if(!user){setMerchantEligible(false);return;}
   api.getIdentityEligibility().then(result=>{if(active)setMerchantEligible(Boolean(result.bvnEligible));}).catch(()=>{if(active)setMerchantEligible(false);});
   return()=>{active=false;};
 },[user?.id,user?.role]);
 const runCheck=async()=>{
   setError('');setNotice('');setBusy(true);
   try{
     const result=await verify({type,identifier,fullName,consent});
     setIdentifier('');
     setNotice(`${type.toUpperCase()} check recorded by the MeetMart backend as ${result.status}. Only safe verification metadata was persisted.`);
   }catch(err){setError(err.message||'Identity check could not be completed.');}
   finally{setBusy(false);}
 };
 if(!user) return <Shell><div className="page identity-page"><div className="empty-orders"><LockKeyhole/><h2>Sign in before identity verification</h2><p>NIN/BVN verification is tied to a real MeetMart account on the backend.</p><Link className="btn primary" to="/auth">Sign in or create account</Link></div></div></Shell>;
 return <Shell><div className="page identity-page"><section className="seller-tools-hero"><div><span className="eyebrow">IDENTITY & MERCHANT KYC</span><h1>MeetMart Identity Center</h1><p>NIN verifies identity. BVN is available only after a merchant application exists or the account has merchant status.</p></div><div className="current-plan-card"><LockKeyhole/><small>Backend privacy rule</small><strong>Raw NIN/BVN is not persisted</strong><span>The API stores only masked metadata and provider references.</span></div></section><div className="identity-grid"><section className="identity-card"><div className="identity-card-head"><ShieldCheck/><div><h2>NIN identity check</h2><p>Optional for ordinary users; required before a Verified Store application.</p></div><span className={identity.nin?'identity-status ok':'identity-status'}>{identity.nin?identity.nin.status:'Not checked'}</span></div>{identity.nin&&<div className="safe-record"><b>Saved safe record</b><span>{identity.nin.maskedIdentifier}</span><small>Ref: {identity.nin.verificationReference}</small></div>}<button className={`identity-select ${type==='nin'?'active':''}`} onClick={()=>{setType('nin');setError('');setNotice('');}}>Use NIN</button></section><section className={`identity-card ${!merchantEligible?'muted-card':''}`}><div className="identity-card-head"><WalletCards/><div><h2>BVN financial identity check</h2><p>{merchantEligible?'Available for settlement / financial onboarding when required.':'Locked until you have a merchant application.'}</p></div><span className={identity.bvn?'identity-status ok':'identity-status'}>{identity.bvn?identity.bvn.status:'Not checked'}</span></div>{identity.bvn&&<div className="safe-record"><b>Saved safe record</b><span>{identity.bvn.maskedIdentifier}</span><small>Ref: {identity.bvn.verificationReference}</small></div>}<button disabled={!merchantEligible} className={`identity-select ${type==='bvn'?'active':''}`} onClick={()=>{setType('bvn');setError('');setNotice('');}}>Use BVN</button></section></div><div className="identity-check-layout"><section className="checkout-card"><h2>{type.toUpperCase()} backend verification</h2><p className="fine-print">The request now goes to the MeetMart backend. The current provider adapter is still in demo mode until official provider credentials are configured; the API clearly reports that status.</p><label>Full legal name<input value={fullName} onChange={e=>setFullName(e.target.value)} placeholder="Name exactly as registered"/></label><label>{type.toUpperCase()} number<input value={identifier} onChange={e=>setIdentifier(e.target.value.replace(/\D/g,'').slice(0,11))} inputMode="numeric" autoComplete="off" placeholder="11 digits"/></label><label className="identity-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/><span>I consent to this identity check for MeetMart account / merchant verification.</span></label>{error&&<div className="checkout-error">{error}</div>}{notice&&<div className="success-notice"><CheckCircle2/>{notice}</div>}<button className="btn primary full" disabled={busy||(type==='bvn'&&!merchantEligible)} onClick={runCheck}>{busy?'Checking…':`Submit ${type.toUpperCase()} check`}</button><small className="privacy-note"><LockKeyhole size={14}/>The browser sends the identifier over the API request only. The backend adapter deliberately excludes the raw number from database records and responses.</small></section><aside className="verification-steps"><h2>Current secure flow</h2>{[['1','Consent','Explicit consent is required before the backend accepts the identity request.'],['2','Authenticated API','The identity request is tied to the signed-in user session.'],['3','Provider adapter','Demo adapter today; official provider can be swapped in server-side later.'],['4','Minimal retention','The database stores status, masked digits, timestamps and provider reference.'],['5','Merchant gate','BVN eligibility is decided by server-side merchant state, not a browser toggle.']].map(x=><article key={x[0]}><span>{x[0]}</span><div><b>{x[1]}</b><p>{x[2]}</p></div></article>)}</aside></div></div></Shell>
}

function StoreApply(){
 const {identity}=useIdentity();
 const {user}=useAuth();
 const [businessName,setBusinessName]=useState('');
 const [category,setCategory]=useState('Food');
 const [businessAddress,setBusinessAddress]=useState('');
 const [registrationReference,setRegistrationReference]=useState('');
 const [submitted,setSubmitted]=useState(null);
 const [applications,setApplications]=useState([]);
 const [error,setError]=useState('');
 const [busy,setBusy]=useState(false);
 const ninReady=['verified','demo_verified'].includes(identity.nin?.status);
 const bvnReady=['verified','demo_verified'].includes(identity.bvn?.status);
 const refreshApps=async()=>{if(!user)return;try{const result=await api.getMyMerchantApplications();setApplications(result.applications||[]);const active=(result.applications||[]).find(app=>['pending','under_review','approved','suspended'].includes(app.status));if(active)setSubmitted(active);}catch{}};
 useEffect(()=>{refreshApps();},[user?.id]);
 const submit=async()=>{
   setError('');setBusy(true);
   try{const result=await api.submitMerchantApplication({businessName,category,businessAddress,registrationReference});setSubmitted(result.application);await refreshApps();}
   catch(err){setError(err.message||'Application could not be submitted.');}
   finally{setBusy(false);}
 };
 if(!user) return <Shell mode="stores"><div className="page verification-page"><div className="empty-orders"><Store/><h2>Sign in to apply as a store</h2><p>Merchant applications are stored against a real MeetMart account.</p><Link className="btn primary" to="/auth">Sign in or create account</Link></div></div></Shell>;
 return <Shell mode="stores"><div className="page verification-page"><section className="seller-tools-hero"><div><span className="eyebrow">MEETMART MERCHANT VERIFICATION</span><h1>Apply to become a Verified Store</h1><p>The application and its review state now live in the backend. Registration documents alone do not activate checkout.</p></div><div className="current-plan-card"><ShieldCheck/><small>Badge meaning</small><strong>MeetMart Verified Store</strong><span>Our verification, not a government endorsement</span></div></section>{submitted&&<div className="success-notice"><CheckCircle2/>Application <b>{submitted.id}</b> is stored on the server with status <b>{submitted.status}</b>.</div>}{error&&<div className="checkout-error">{error}</div>}<div className="merchant-identity-gate"><div><ShieldCheck/><span><b>Owner / representative identity</b><small>NIN is required before application. BVN eligibility is unlocked by the server after a merchant application exists.</small></span></div><div className="merchant-identity-status"><span className={ninReady?'ok':'pending'}>{ninReady?'NIN check recorded':'NIN pending'}</span><span className={bvnReady?'ok':'pending'}>{bvnReady?'BVN check recorded':'BVN later / when applicable'}</span><Link className="btn ghost" to="/verification">Open Identity Center</Link></div></div><div className="verification-grid"><section className="checkout-card"><h2>Merchant application</h2><label>Business / store name<input value={businessName} onChange={e=>setBusinessName(e.target.value)} placeholder="e.g. Ahmed Tech Hub"/></label><label>Category<select value={category} onChange={e=>setCategory(e.target.value)}><option>Food</option><option>Groceries</option><option>Electronics</option><option>Fashion</option><option>Home</option><option>Beauty</option><option>Books</option><option>Computers</option></select></label><label>Business address<textarea value={businessAddress} onChange={e=>setBusinessAddress(e.target.value)} placeholder="Full physical shop address in Kaduna"/></label><label>Registration / licence reference<input value={registrationReference} onChange={e=>setRegistrationReference(e.target.value)} placeholder="Document reference"/></label><button className="btn primary full" disabled={!ninReady||busy||Boolean(submitted)} onClick={submit}>{submitted?'Active application already exists':busy?'Submitting…':ninReady?'Submit for MeetMart review':'Complete NIN identity step first'}</button>{applications.length>0&&<div className="application-history"><b>Application history</b>{applications.slice(0,4).map(app=><span key={app.id}>{app.business_name||app.businessName} <em>{app.status}</em></span>)}</div>}</section><section className="verification-steps"><h2>What we check</h2>{merchantVerificationSteps.map(([title,copy],index)=><article key={title}><span>{index+1}</span><div><b>{title}</b><p>{copy}</p></div></article>)}<div className="trust-boundary"><BadgeCheck/><div><h3>Verification cannot be purchased</h3><p>Subscription or advertising payments do not bypass identity checks, inspection, document review or test-order requirements.</p></div></div></section></div></div></Shell>
}

function StoreDashboard(){
 const {user}=useAuth();
 const [merchant,setMerchant]=useState(null);
 const [orders,setOrders]=useState([]);
 const [revealed,setRevealed]=useState({});
 const [loading,setLoading]=useState(Boolean(user));
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [productName,setProductName]=useState('');
 const [productDescription,setProductDescription]=useState('');
 const [productPrice,setProductPrice]=useState('');
 const [deliveryFee,setDeliveryFee]=useState('');
 const [busy,setBusy]=useState(false);
 const load=async()=>{
  if(!user)return;
  setLoading(true);setError('');
  try{const [merchantResult,ordersResult]=await Promise.all([api.getMerchantMe(),api.getMerchantOrders()]);setMerchant(merchantResult.merchant);setDeliveryFee(String(merchantResult.merchant.deliveryFee||0));setOrders(ordersResult.orders||[]);}
  catch(err){setMerchant(null);setOrders([]);setError(err.message||'Unable to load merchant dashboard.');}
  finally{setLoading(false);}
 };
 useEffect(()=>{load();},[user?.id]);
 const addProduct=async()=>{setBusy(true);setError('');setNotice('');try{await api.createMerchantProduct({name:productName,description:productDescription,price:Number(productPrice)});setProductName('');setProductDescription('');setProductPrice('');setNotice('Product created on the backend.');await load();}catch(err){setError(err.message||'Unable to create product.');}finally{setBusy(false);}};
 const saveDelivery=async()=>{setBusy(true);setError('');setNotice('');try{await api.updateMerchantSettings({deliveryFee:Number(deliveryFee)});setNotice('Delivery fee updated on the backend.');await load();}catch(err){setError(err.message||'Unable to update delivery fee.');}finally{setBusy(false);}};
 const updateStatus=async(order,next)=>{setBusy(true);setError('');setNotice('');try{await api.updateMerchantOrderStatus(order.id,next);setNotice(`Order ${order.id} moved to ${orderStatusLabel(next)}.`);await load();}catch(err){setError(err.message||'Unable to update order status.');}finally{setBusy(false);}};
 const revealAddress=async order=>{const password=window.prompt('Re-enter your MeetMart password. The delivery address can be revealed only once and this access is logged.');if(!password)return;setBusy(true);setError('');setNotice('');try{const result=await api.revealMerchantOrderAddress(order.id,password);setRevealed(v=>({...v,[order.id]:result.deliveryAddress}));setNotice(result.warning);await load();}catch(err){setError(err.message)}finally{setBusy(false)}};
 const completeDelivery=async order=>{const pin=window.prompt('Ask the customer for their 6-digit proof-of-delivery PIN after they have received and checked the order.');if(!pin)return;setBusy(true);setError('');setNotice('');try{await api.completeMerchantDelivery(order.id,pin.trim());setNotice(`Order ${order.id} was completed with the customer PIN.`);await load();}catch(err){setError(err.message)}finally{setBusy(false)}};
 const requestCancellation=async order=>{const reason=window.prompt('Why can you no longer fulfil this paid order? A refund case will be opened.');if(!reason)return;setBusy(true);setError('');setNotice('');try{await api.requestMerchantCancellation(order.id,reason);setNotice(`Cancellation/refund review opened for ${order.id}.`);await load();}catch(err){setError(err.message)}finally{setBusy(false)}};
 const nextStatuses={paid:['preparing'],preparing:['out_for_delivery'],out_for_delivery:[],refund_pending:[],delivered:[],cancelled:[],refunded:[]};
 if(!user) return <Shell mode="stores"><div className="page restaurant-dashboard"><div className="empty-orders"><Store/><h2>Merchant sign-in required</h2><p>Sign in with the account that owns an approved MeetMart store.</p><Link className="btn primary" to="/auth">Sign in</Link></div></div></Shell>;
 if(loading) return <Shell mode="stores"><div className="page restaurant-dashboard"><div className="empty-orders"><Store/><h2>Loading merchant portal…</h2></div></div></Shell>;
 if(!merchant) return <Shell mode="stores"><div className="page restaurant-dashboard"><div className="empty-orders"><ShieldCheck/><h2>Merchant account required</h2><p>{error||'Your account does not have an approved merchant yet.'}</p><Link className="btn primary" to="/stores/apply">Open merchant application</Link></div></div></Shell>;
 const sales=orders.reduce((sum,o)=>sum+Number(o.customerTotal||0),0); const settlement=orders.reduce((sum,o)=>sum+Number(o.merchantSettlement||0),0); const suspended=merchant.verificationStatus==='suspended'||!merchant.checkoutEnabled;
 return <Shell mode="stores"><div className="page restaurant-dashboard"><section className="seller-tools-hero"><div><span className="eyebrow">VERIFIED STORE PORTAL • TRANSACTION SAFETY</span><h1>{merchant.name}</h1><p>Customer addresses stay protected until an active delivery genuinely needs them.</p></div><div className="current-plan-card"><BadgeCheck/><small>Store status</small><strong>{merchant.verificationStatus==='verified'?'MeetMart Verified':merchant.verificationStatus}</strong><span>{merchant.checkoutEnabled?'Online checkout active':'Checkout disabled'}</span></div></section>{suspended&&<div className="checkout-error"><ShieldCheck/>Store checkout is suspended. {merchant.suspensionReason||'Contact MeetMart admin for review.'}</div>}{error&&<div className="checkout-error">{error}</div>}{notice&&<div className="success-notice"><CheckCircle2/>{notice}</div>}<div className="seller-kpis"><div><ShoppingBag/><strong>{orders.length}</strong><small>Paid/fulfilment orders</small><span>Backend queue</span></div><div><ReceiptText/><strong>{naira(sales)}</strong><small>Customer order value</small><span>Current loaded orders</span></div><div><Package/><strong>{(merchant.products||[]).filter(p=>p.active).length}</strong><small>Active products</small><span>Server catalog</span></div><div><WalletCards/><strong>{naira(settlement)}</strong><small>Merchant settlement</small><span>Before external rail adjustments</span></div></div><section className="restaurant-orders"><div className="section-head"><div><h2>Incoming orders</h2><p>Addresses are one-time protected data. Delivery completion requires the customer PIN.</p></div><button className="btn ghost" onClick={load}>Refresh</button></div>{orders.length===0?<div className="empty-orders compact"><ReceiptText/><h2>No paid orders yet</h2></div>:orders.map(order=><div className="restaurant-order-row api-order-row protected-merchant-order" key={order.id}><span><b>{order.id}</b><small>{(order.items||[]).map(item=>`${item.quantity}× ${item.name}`).join(' • ')}</small><small className="privacy-inline"><LockKeyhole size={12}/>{revealed[order.id]||order.deliveryAddressMasked}</small>{revealed[order.id]&&<small className="address-warning">Private customer information. Use only for this delivery. Do not copy, share, store, photograph or reuse it.</small>}{order.addressRevealedAt&&!revealed[order.id]&&<small>Address access already used • {new Date(order.addressRevealedAt).toLocaleString()}</small>}</span><strong>{naira(order.customerTotal)}</strong><em>{orderStatusLabel(order.status)}</em><div className="order-actions">{order.addressRevealAvailable&&<button disabled={busy||suspended} className="btn ghost" onClick={()=>revealAddress(order)}><Eye size={15}/>Reveal address once</button>}{(nextStatuses[order.status]||[]).map(next=><button key={next} disabled={busy||suspended} className="btn primary" onClick={()=>updateStatus(order,next)}>{orderStatusLabel(next)}</button>)}{order.status==='out_for_delivery'&&<button disabled={busy||suspended} className="btn primary" onClick={()=>completeDelivery(order)}><CheckCircle2 size={15}/>Complete with PIN</button>}{['paid','preparing'].includes(order.status)&&<button disabled={busy||suspended} className="btn ghost" onClick={()=>requestCancellation(order)}>Request cancellation</button>}</div>{(order.cases||[]).length>0&&<div className="case-list">{order.cases.map(c=><small key={c.id}>{c.type.replaceAll('_',' ')} • {c.status}</small>)}</div>}</div>)}</section><div className="merchant-management-grid"><section className="checkout-card"><h2>Add product</h2><label>Product name<input value={productName} onChange={e=>setProductName(e.target.value)} placeholder="Product name"/></label><label>Description<textarea value={productDescription} onChange={e=>setProductDescription(e.target.value)} placeholder="Short product description"/></label><label>Price (₦)<input value={productPrice} onChange={e=>setProductPrice(e.target.value.replace(/\D/g,''))} inputMode="numeric" placeholder="e.g. 25000"/></label><button className="btn primary full" disabled={busy||suspended||!productName||!productPrice} onClick={addProduct}>Create product</button></section><section className="checkout-card"><h2>Store settings</h2><label>Delivery fee (₦)<input value={deliveryFee} onChange={e=>setDeliveryFee(e.target.value.replace(/\D/g,''))} inputMode="numeric"/></label><button className="btn primary full" disabled={busy||suspended} onClick={saveDelivery}>Save delivery fee</button><h3>Current products</h3><div className="dashboard-products">{(merchant.products||[]).map(product=><span key={product.id}><b>{product.name}</b><small>{naira(product.price)} • {product.active?'Active':'Inactive'}</small></span>)}</div></section></div></div></Shell>
}

function LegacyFoodStoreRedirect(){
 const {id}=useParams();
 return <Navigate to={`/stores/${id}`} replace/>;
}

function NotFound(){
 return <Shell><div className="page"><div className="empty-orders"><Search/><h2>Page not found</h2><p>The page or item you requested does not exist.</p><Link className="btn primary" to="/">Back to MeetMart NG</Link></div></div></Shell>
}

function Admin(){
 const {user}=useAuth();
 const [applications,setApplications]=useState([]); const [merchants,setMerchants]=useState([]); const [cases,setCases]=useState([]); const [addressAccess,setAddressAccess]=useState([]);
 const [loading,setLoading]=useState(Boolean(user)); const [error,setError]=useState(''); const [notice,setNotice]=useState('');
 const load=async()=>{if(!user)return;setLoading(true);setError('');try{const [a,m,c,x]=await Promise.all([api.getAdminMerchantApplications(),api.getAdminMerchants(),api.getAdminOrderCases(),api.getAdminAddressAccess()]);setApplications(a.applications||[]);setMerchants(m.merchants||[]);setCases(c.cases||[]);setAddressAccess(x.access||[]);}catch(err){setError(err.message||'Unable to load admin controls.');}finally{setLoading(false);}};
 useEffect(()=>{load();},[user?.id]);
 const passOperationalChecks=async app=>{setError('');setNotice('');try{await api.reviewMerchantApplication(app.id,{cac_status:'passed',physical_inspection_status:'passed',category_docs_status:'passed',settlement_account_status:'passed',test_order_status:'passed'});setNotice(`Operational checks recorded for ${app.business_name}.`);await load();}catch(err){setError(err.message)}};
 const decide=async(app,decision)=>{setError('');setNotice('');try{await api.reviewMerchantApplication(app.id,{decision});setNotice(`${app.business_name}: ${decision} recorded.`);await load();}catch(err){setError(err.message)}};
 const toggleMerchant=async merchant=>{const suspending=merchant.verificationStatus!=='suspended';const reason=suspending?window.prompt(`Why are you suspending ${merchant.name}? Checkout will be disabled immediately.`):'';if(suspending&&!reason)return;setError('');setNotice('');try{await api.updateAdminMerchantStatus(merchant.id,{status:suspending?'suspended':'verified',reason});setNotice(`${merchant.name} ${suspending?'suspended':'restored'}.`);await load();}catch(err){setError(err.message)}};
 const reviewCase=async(c,decision)=>{let note=window.prompt(decision==='approve_refund'?'Add a note for this refund approval:':'Add an admin resolution note:','');if(note===null)return;setError('');setNotice('');try{await api.reviewAdminOrderCase(c.id,{decision,note});setNotice(`Case ${c.id} updated.`);await load();}catch(err){setError(err.message)}};
 if(!user) return <Shell><div className="page admin-page"><div className="empty-orders"><ShieldCheck/><h2>Admin sign-in required</h2><Link className="btn primary" to="/auth">Sign in</Link></div></div></Shell>;
 const openCases=cases.filter(c=>['open','under_review'].includes(c.status));
 return <Shell><div className="page admin-page"><h1>Moderation, Verification & Transaction Safety</h1><p>Admin controls now include merchant checkout suspension, refund/dispute review and a delivery-address access audit trail.</p>{error&&<div className="checkout-error">{error}</div>}{notice&&<div className="success-notice"><CheckCircle2/>{notice}</div>}<div className="stat-grid admin-stats">{[[String(applications.length),'Merchant Applications'],[String(merchants.filter(m=>m.verificationStatus==='verified').length),'Active Verified Stores'],[String(merchants.filter(m=>m.verificationStatus==='suspended').length),'Suspended Stores'],[String(openCases.length),'Open Order Cases'],[String(addressAccess.length),'Address Reveals Logged']].map(item=><div key={item[1]}><strong>{item[0]}</strong><small>{item[1]}</small></div>)}</div><section className="merchant-review-table"><div className="section-head"><div><h2>Emergency merchant controls</h2><p>Suspension immediately disables new checkout and protected-address access.</p></div><button className="btn ghost" onClick={load}>Refresh</button></div>{merchants.map(m=><article key={m.id}><div><b>{m.name}</b><small>{m.category} • {m.ownerName} • {m.email}</small></div><span>{m.verificationStatus}<br/>Checkout: {m.checkoutEnabled?'enabled':'disabled'}</span><em>{m.suspensionReason||'No suspension reason'}</em><div className="request-actions"><button className={m.verificationStatus==='suspended'?'btn primary':'btn ghost'} onClick={()=>toggleMerchant(m)}>{m.verificationStatus==='suspended'?'Restore store':'Suspend checkout'}</button></div></article>)}</section><section className="merchant-review-table"><div className="section-head"><div><h2>Refunds, disputes & privacy cases</h2><p>Refund approval is routed through the ASD Pay adapter; privacy cases stay separately auditable.</p></div></div>{cases.length===0?<div className="empty-orders compact"><ReceiptText/><h2>No order cases</h2></div>:cases.map(c=><article key={c.id}><div><b>{c.type.replaceAll('_',' ')}</b><small>{c.merchantName} • Order {c.orderId} • {naira(c.customerTotal||0)}</small></div><span>{c.reason}</span><em>{c.status}</em><div className="request-actions">{['open','under_review'].includes(c.status)&&<>{c.type!=='address_misuse'&&<button className="btn primary" onClick={()=>reviewCase(c,'approve_refund')}>Approve refund</button>}<button className="btn ghost" onClick={()=>reviewCase(c,'reject')}>Reject</button><button className="btn ghost" onClick={()=>reviewCase(c,'resolve')}>Resolve</button></>}</div></article>)}</section><section className="merchant-review-table"><div className="section-head"><div><h2>Delivery-address access log</h2><p>The actual customer address is deliberately not shown here—only who accessed it, for which order, and when.</p></div></div>{addressAccess.length===0?<p>No delivery addresses have been revealed yet.</p>:addressAccess.map(x=><article key={x.id}><div><b>{x.merchantName}</b><small>{x.merchantUserName} • Order {x.orderId}</small></div><span>{x.ipAddress||'IP unavailable'}</span><em>{new Date(x.accessedAt).toLocaleString()}</em><small>{x.userAgent||'Device unavailable'}</small></article>)}</section><section className="merchant-review-table"><div className="section-head"><div><h2>Verified Store application queue</h2><p>{loading?'Loading backend applications…':`${applications.length} application${applications.length===1?'':'s'} in the backend.`}</p></div><Link className="btn ghost" to="/stores/apply">View application form</Link></div>{!loading&&applications.length===0?<div className="empty-orders compact"><Store/><h2>No merchant applications yet</h2></div>:applications.map(app=><article key={app.id}><div><b>{app.business_name}</b><small>{app.category} • {app.id}</small></div><span>NIN/identity: {app.identity_status}<br/>CAC: {app.cac_status}<br/>Inspection: {app.physical_inspection_status}</span><em>{app.status}</em><div className="request-actions"><button className="btn ghost" onClick={()=>passOperationalChecks(app)}>Pass operational checks</button><button className="btn primary" onClick={()=>decide(app,'approve')}>Approve</button><button className="btn ghost" onClick={()=>decide(app,'reject')}>Reject</button></div></article>)}</section></div></Shell>
}

export default function App(){return <BusinessProvider><AuthProvider><IdentityProvider><Routes><Route path="/" element={<Home/>}/><Route path="/auth" element={<Auth/>}/><Route path="/search" element={<SearchPage/>}/><Route path="/product/:id" element={<Product/>}/><Route path="/sell" element={<Sell/>}/><Route path="/requests" element={<Requests/>}/><Route path="/chat" element={<Chat/>}/><Route path="/chat/:conversationId" element={<Chat/>}/><Route path="/meetup" element={<Meetup/>}/><Route path="/meetup/:conversationId" element={<Meetup/>}/><Route path="/profile" element={<Profile/>}/><Route path="/verification" element={<IdentityVerification/>}/><Route path="/admin" element={<Admin/>}/><Route path="/seller-tools" element={<SellerTools/>}/><Route path="/stores" element={<StoresHome/>}/><Route path="/stores/apply" element={<StoreApply/>}/><Route path="/stores/checkout" element={<StoreCheckout/>}/><Route path="/stores/orders" element={<StoreOrders/>}/><Route path="/stores/:id" element={<StorePage/>}/><Route path="/store-dashboard" element={<StoreDashboard/>}/><Route path="/food" element={<Navigate to="/stores" replace/>}/><Route path="/food/restaurant/:id" element={<LegacyFoodStoreRedirect/>}/><Route path="/food/checkout" element={<Navigate to="/stores/checkout" replace/>}/><Route path="/food/orders" element={<Navigate to="/stores/orders" replace/>}/><Route path="/restaurant-dashboard" element={<Navigate to="/store-dashboard" replace/>}/><Route path="*" element={<NotFound/>}/></Routes></IdentityProvider></AuthProvider></BusinessProvider>}
