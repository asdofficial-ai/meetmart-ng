import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {URL} from 'node:url';
import {config, validateRuntimeConfig} from './config.js';
import {db, nowIso} from './db.js';
import {hashPassword, verifyPassword, randomId, newSessionToken, hashToken, sanitizeEmail} from './security.js';
import {verifyIdentity} from './providers/identityProvider.js';
import {calculateSettlement, createPaymentIntent, confirmDemoPaymentIntent, processRefund} from './providers/asdPayProvider.js';
import {createRateLimiter} from './infra/rateLimit.js';
import {ensureStorageReady, writeUpload, resolveUpload, storageHealth} from './infra/storage.js';
import {startBackupScheduler} from './infra/backup.js';

ensureStorageReady();
const liveClients=new Map();
const rateLimiter=createRateLimiter({windowMs:config.rateLimitWindowMs,defaultLimit:config.rateLimitDefault,authLimit:config.rateLimitAuth,sensitiveLimit:config.rateLimitSensitive});

const json = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {'content-type':'application/json; charset=utf-8', 'content-length':Buffer.byteLength(payload), ...headers});
  res.end(payload);
};

const parseCookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(v=>v.trim()).filter(Boolean).map(pair=>{
  const i=pair.indexOf('='); return i<0?[pair,'']:[pair.slice(0,i),decodeURIComponent(pair.slice(i+1))];
}));

const readBody = req => new Promise((resolve,reject)=>{
  let data='';
  req.on('data',chunk=>{ data+=chunk; if(Buffer.byteLength(data)>config.maxJsonBytes){ reject(Object.assign(new Error('Request too large.'),{status:413})); req.destroy(); } });
  req.on('end',()=>{ if(!data) return resolve({}); try{ resolve(JSON.parse(data)); }catch{ reject(new Error('Invalid JSON.')); } });
  req.on('error',reject);
});


const readRawBody = (req,maxBytes) => new Promise((resolve,reject)=>{
  const chunks=[]; let size=0;
  req.on('data',chunk=>{ size+=chunk.length; if(size>maxBytes){reject(Object.assign(new Error('Image is too large.'),{status:413}));req.destroy();return;} chunks.push(chunk); });
  req.on('end',()=>resolve(Buffer.concat(chunks)));
  req.on('error',reject);
});

function sniffImage(buffer,declaredType=''){
  const type=String(declaredType).split(';')[0].trim().toLowerCase();
  const signatures={
    'image/jpeg': b=>b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff,
    'image/png': b=>b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    'image/webp': b=>b.length>=12&&b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP',
  };
  if(!signatures[type]||!signatures[type](buffer)) throw Object.assign(new Error('Upload a valid JPEG, PNG or WebP image.'),{status:415});
  return {mime:type,extension:type==='image/jpeg'?'.jpg':type==='image/png'?'.png':'.webp'};
}

function publicAssetUrl(req,value){
  if(!value) return '';
  if(/^https?:\/\//i.test(value)) return value;
  const proto=String(req.headers['x-forwarded-proto']||'http').split(',')[0].trim();
  const host=String(req.headers['x-forwarded-host']||req.headers.host||'localhost').split(',')[0].trim();
  return `${proto}://${host}${value.startsWith('/')?'':'/'}${value}`;
}

function sendLive(userId,event,data){
  const clients=liveClients.get(userId); if(!clients) return;
  const payload=`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for(const res of [...clients]){ try{res.write(payload);}catch{clients.delete(res);} }
  if(!clients.size) liveClients.delete(userId);
}

function createNotification(userId,{type,title,body='',href='',entityType='',entityId=''}){
  const id=randomId('ntf_'), createdAt=nowIso();
  db.prepare('INSERT INTO notifications(id,user_id,type,title,body,href,entity_type,entity_id,read_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id,userId,type,title,body,href,entityType,entityId,null,createdAt);
  const notification={id,type,title,body,href,entityType,entityId,readAt:null,createdAt};
  sendLive(userId,'notification.created',notification);
  return notification;
}

function notifyAdmins(payload){
  const admins=db.prepare("SELECT id FROM users WHERE role='admin' AND status='active'").all();
  for(const admin of admins) createNotification(admin.id,payload);
}

function getMerchantForUser(userId){
  return db.prepare('SELECT * FROM merchants WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(userId);
}

function requireVerifiedMerchantForUser(userId){
  const merchant=getMerchantForUser(userId);
  if(!merchant||merchant.verification_status!=='verified'||!merchant.checkout_enabled) throw Object.assign(new Error('Verified active merchant account required.'),{status:403});
  return merchant;
}

function deliveryPinHash(orderId,pin){
  if(!config.deliveryPinSecret) throw Object.assign(new Error('Delivery PIN secret is not configured.'),{status:500});
  return crypto.createHmac('sha256',config.deliveryPinSecret).update(`${orderId}:${String(pin)}`).digest('hex');
}

function createDeliveryPin(orderId){
  const pin=String(crypto.randomInt(0,1_000_000)).padStart(6,'0');
  return {pin,hash:deliveryPinHash(orderId,pin),last2:pin.slice(-2),createdAt:nowIso()};
}

function verifyDeliveryPin(orderId,pin,hash){
  if(!/^\d{6}$/.test(String(pin||''))||!hash) return false;
  const expected=Buffer.from(deliveryPinHash(orderId,pin),'hex');
  const actual=Buffer.from(String(hash),'hex');
  return expected.length===actual.length&&crypto.timingSafeEqual(expected,actual);
}

function requestIp(req){
  return String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'').split(',')[0].trim().slice(0,120);
}

function deliveryAddressKey(){
  if(!config.deliveryAddressSecret) throw Object.assign(new Error('Delivery address encryption secret is not configured.'),{status:500});
  return crypto.createHash('sha256').update(config.deliveryAddressSecret).digest();
}

function encryptDeliveryAddress(value){
  const plain=String(value||'').trim(); const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm',deliveryAddressKey(),iv);
  const encrypted=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]); const tag=cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decryptDeliveryAddress(value){
  const stored=String(value||''); if(!stored.startsWith('enc:v1:')) return stored;
  const [,version,ivB64,tagB64,dataB64]=stored.split(':'); if(version!=='v1') throw new Error('Unsupported address encryption version.');
  const decipher=crypto.createDecipheriv('aes-256-gcm',deliveryAddressKey(),Buffer.from(ivB64,'base64url')); decipher.setAuthTag(Buffer.from(tagB64,'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64,'base64url')),decipher.final()]).toString('utf8');
}

function publicOrderCase(row){
  return {id:row.id,orderId:row.order_id,type:row.case_type,reason:row.reason,status:row.status,previousOrderStatus:row.previous_order_status,resolution:row.resolution,createdAt:row.created_at,updatedAt:row.updated_at,resolvedAt:row.resolved_at};
}

function openOrderCase({order,openedByUserId,type,reason,moveToRefundPending=false}){
  const cleanReason=String(reason||'').trim();
  if(cleanReason.length<8) throw Object.assign(new Error('Please provide a clear reason (at least 8 characters).'),{status:400});
  const duplicate=db.prepare("SELECT id FROM order_cases WHERE order_id=? AND case_type=? AND status IN ('open','under_review')").get(order.id,type);
  if(duplicate) throw Object.assign(new Error('An active case of this type already exists for this order.'),{status:409});
  const id=randomId('case_'), now=nowIso();
  db.prepare('INSERT INTO order_cases(id,order_id,case_type,opened_by_user_id,reason,status,previous_order_status,resolution,created_at,updated_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,order.id,type,openedByUserId,cleanReason,'open',order.status,'',now,now,null);
  if(moveToRefundPending) db.prepare("UPDATE orders SET status='refund_pending' WHERE id=?").run(order.id);
  return db.prepare('SELECT * FROM order_cases WHERE id=?').get(id);
}

const corsHeaders = origin => {
  const allowed = origin && config.allowedOrigins.includes(origin);
  return allowed ? {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials':'true',
    'access-control-allow-headers':'content-type',
    'access-control-allow-methods':'GET,POST,PATCH,DELETE,OPTIONS',
    'vary':'origin'
  } : {};
};

function assertMutationOrigin(req){
  const origin=req.headers.origin;
  if (!origin) return;
  if (!isOriginAllowed(req,origin)) throw Object.assign(new Error('Origin not allowed.'),{status:403});
}

function sessionCookie(token, maxAgeSeconds){
  const parts=[`${config.cookieName}=${encodeURIComponent(token)}`,'HttpOnly','Path=/',`SameSite=${config.cookieSameSite}`,`Max-Age=${maxAgeSeconds}`];
  if(config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function getCurrentUser(req){
  const token=parseCookies(req)[config.cookieName];
  if(!token) return null;
  const row=db.prepare(`SELECT u.id,u.email,u.display_name,u.city,u.role,u.status,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hashToken(token));
  if(!row) return null;
  if(new Date(row.expires_at).getTime()<=Date.now()) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token)); return null; }
  if(row.status!=='active') return null;
  return {id:row.id,email:row.email,displayName:row.display_name,city:row.city,role:row.role};
}

function requireUser(req){ const user=getCurrentUser(req); if(!user) throw Object.assign(new Error('Authentication required.'),{status:401}); return user; }
function requireAdmin(req){ const user=requireUser(req); if(user.role!=='admin') throw Object.assign(new Error('Admin access required.'),{status:403}); return user; }

function audit(actorUserId, action, entityType, entityId, metadata={}){
  db.prepare('INSERT INTO audit_events(id,actor_user_id,action,entity_type,entity_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(randomId('aud_'),actorUserId||null,action,entityType,entityId,JSON.stringify(metadata),nowIso());
}


function requestOrigin(req){
  const proto=String(req.headers['x-forwarded-proto']||(req.socket?.encrypted?'https':'http')).split(',')[0].trim();
  const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim();
  return host?`${proto}://${host}`:'';
}

function isOriginAllowed(req,origin){
  if(!origin) return true;
  if(config.allowedOrigins.includes(origin)) return true;
  return origin===requestOrigin(req);
}

function applySecurityHeaders(req,res){
  const requestId=String(req.headers['x-request-id']||crypto.randomUUID()).slice(0,120);
  res.setHeader('x-request-id',requestId);
  res.setHeader('x-content-type-options','nosniff');
  res.setHeader('referrer-policy','strict-origin-when-cross-origin');
  res.setHeader('x-frame-options','DENY');
  res.setHeader('permissions-policy','camera=(), microphone=(), geolocation=()');
  if(config.isProduction) res.setHeader('strict-transport-security','max-age=31536000; includeSubDomains');
  res.setHeader('content-security-policy',"default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https: wss:");
  return requestId;
}

function serveFrontend(req,res,url){
  if(!config.serveFrontend||req.method!=='GET'||!fs.existsSync(config.frontendDir)) return false;
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/uploads/')||url.pathname.startsWith('/health')) return false;
  const contentTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.json':'application/json; charset=utf-8','.woff2':'font/woff2'};
  const requested=url.pathname==='/'?'index.html':url.pathname.replace(/^\/+/, '');
  const candidate=path.resolve(config.frontendDir,requested);
  const root=path.resolve(config.frontendDir)+path.sep;
  let filePath=candidate.startsWith(root)?candidate:'';
  const exists=filePath&&fs.existsSync(filePath)&&fs.statSync(filePath).isFile();
  if(!exists){
    const acceptsHtml=String(req.headers.accept||'').includes('text/html');
    if(!acceptsHtml) return false;
    filePath=path.join(config.frontendDir,'index.html');
  }
  if(!fs.existsSync(filePath)) return false;
  const ext=path.extname(filePath).toLowerCase(); const stat=fs.statSync(filePath);
  res.writeHead(200,{'content-type':contentTypes[ext]||'application/octet-stream','content-length':stat.size,'cache-control':ext==='.html'?'no-cache':'public, max-age=31536000, immutable'});
  fs.createReadStream(filePath).pipe(res); return true;
}

function infrastructureStatus(){
  let database={ok:true};
  try{db.prepare('SELECT 1 ok').get();}catch(error){database={ok:false,error:error.message};}
  const storage=storageHealth();
  const runtime=validateRuntimeConfig({strict:config.isProduction});
  const frontend={ok:!config.serveFrontend||fs.existsSync(path.join(config.frontendDir,'index.html')),serveFrontend:config.serveFrontend};
  if(!frontend.ok) frontend.error='Frontend build is missing.';
  return {ok:database.ok&&storage.ok&&runtime.ok&&frontend.ok,database,storage,frontend,runtime};
}

async function route(req,res){
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  const origin=req.headers.origin;
  const cors=corsHeaders(origin);
  if(req.method==='OPTIONS') return json(res,204,{},cors);
  if(['POST','PATCH','PUT','DELETE'].includes(req.method)) assertMutationOrigin(req);

  if(req.method==='GET'&&url.pathname==='/health') return json(res,200,{ok:true,service:'meetmart-api',env:config.env,identityMode:config.identityMode,asdPayMode:config.asdPayMode,storageMode:config.storageMode},cors);
  if(req.method==='GET'&&url.pathname==='/health/live') return json(res,200,{ok:true,service:'meetmart-api',at:nowIso()},cors);
  if(req.method==='GET'&&url.pathname==='/health/ready'){const status=infrastructureStatus();return json(res,status.ok?200:503,status,cors);}
  if(req.method==='GET'&&url.pathname==='/commerce/config') return json(res,200,{currency:'NGN',commissionRate:config.meetMartCommissionRate,customerServiceFee:config.customerServiceFee,asdPayMode:config.asdPayMode},cors);


  const uploadedAsset=url.pathname.match(/^\/uploads\/marketplace\/([A-Za-z0-9._-]+)$/);
  if(req.method==='GET'&&uploadedAsset){
    const filename=path.basename(uploadedAsset[1]); const filePath=resolveUpload(filename);
    const row=db.prepare("SELECT mime_type FROM marketplace_uploads WHERE storage_path=? AND status<>'deleted'").get(filePath);
    if(!row||!fs.existsSync(filePath)) return json(res,404,{error:'Image not found.'},cors);
    const stat=fs.statSync(filePath); res.writeHead(200,{'content-type':row.mime_type,'content-length':stat.size,'cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff',...cors});
    return fs.createReadStream(filePath).pipe(res);
  }

  if(req.method==='GET'&&url.pathname==='/events'){
    const user=requireUser(req);
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive',...cors});
    res.write(`event: ready\ndata: ${JSON.stringify({userId:user.id,at:nowIso()})}\n\n`);
    if(!liveClients.has(user.id)) liveClients.set(user.id,new Set()); liveClients.get(user.id).add(res);
    const keepAlive=setInterval(()=>{try{res.write(': keep-alive\n\n');}catch{}},25000);
    req.on('close',()=>{clearInterval(keepAlive);const set=liveClients.get(user.id);if(set){set.delete(res);if(!set.size)liveClients.delete(user.id);}});
    return;
  }

  if(req.method==='GET'&&url.pathname==='/notifications'){
    const user=requireUser(req); const limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit')||30)));
    const rows=db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(user.id,limit);
    const unread=db.prepare('SELECT COUNT(*) count FROM notifications WHERE user_id=? AND read_at IS NULL').get(user.id);
    return json(res,200,{unreadCount:Number(unread.count||0),notifications:rows.map(r=>({id:r.id,type:r.type,title:r.title,body:r.body,href:r.href,entityType:r.entity_type,entityId:r.entity_id,readAt:r.read_at,createdAt:r.created_at}))},cors);
  }
  const notificationRead=url.pathname.match(/^\/notifications\/([^/]+)\/read$/);
  if(req.method==='PATCH'&&notificationRead){
    const user=requireUser(req); const row=db.prepare('SELECT id FROM notifications WHERE id=? AND user_id=?').get(notificationRead[1],user.id); if(!row) throw Object.assign(new Error('Notification not found.'),{status:404});
    const readAt=nowIso(); db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?').run(readAt,row.id); return json(res,200,{id:row.id,readAt},cors);
  }
  if(req.method==='POST'&&url.pathname==='/notifications/read-all'){
    const user=requireUser(req); const readAt=nowIso(); db.prepare('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(readAt,user.id); return json(res,200,{ok:true,readAt},cors);
  }

  if(req.method==='POST'&&url.pathname==='/marketplace/uploads/image'){
    const user=requireUser(req); const raw=await readRawBody(req,config.maxImageBytes); if(!raw.length) throw Object.assign(new Error('Choose an image to upload.'),{status:400});
    const info=sniffImage(raw,req.headers['content-type']); const id=randomId('upl_'); const filename=`${id}${info.extension}`; const storagePath=path.join(config.uploadDir,filename); const publicPath=`/uploads/marketplace/${filename}`;
    fs.writeFileSync(storagePath,raw,{flag:'wx'});
    try{db.prepare('INSERT INTO marketplace_uploads(id,user_id,public_path,storage_path,mime_type,size_bytes,status,claimed_listing_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,user.id,publicPath,storagePath,info.mime,raw.length,'pending',null,nowIso());}
    catch(error){try{fs.unlinkSync(storagePath);}catch{} throw error;}
    audit(user.id,'marketplace.image.upload','marketplace_upload',id,{mime:info.mime,sizeBytes:raw.length});
    return json(res,201,{upload:{id,url:publicAssetUrl(req,publicPath),mimeType:info.mime,sizeBytes:raw.length}},cors);
  }

  if(req.method==='POST'&&url.pathname==='/auth/signup'){
    const body=await readBody(req); const email=sanitizeEmail(body.email); const displayName=String(body.displayName||'').trim();
    if(!/^\S+@\S+\.\S+$/.test(email)) throw Object.assign(new Error('Enter a valid email address.'),{status:400});
    if(!displayName) throw Object.assign(new Error('Display name is required.'),{status:400});
    if(db.prepare('SELECT id FROM users WHERE email=?').get(email)) throw Object.assign(new Error('An account with this email already exists.'),{status:409});
    const id=randomId('usr_'), created=nowIso(), passwordHash=await hashPassword(String(body.password||''));
    db.prepare('INSERT INTO users(id,email,password_hash,display_name,city,role,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,email,passwordHash,displayName,'Kaduna','marketplace_user','active',created);
    const token=newSessionToken(), expires=new Date(Date.now()+config.sessionTtlMs).toISOString();
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hashToken(token),id,expires,created);
    audit(id,'auth.signup','user',id);
    return json(res,201,{user:{id,email,displayName,city:'Kaduna',role:'marketplace_user'}},{...cors,'set-cookie':sessionCookie(token,Math.floor(config.sessionTtlMs/1000))});
  }

  if(req.method==='POST'&&url.pathname==='/auth/login'){
    const body=await readBody(req); const email=sanitizeEmail(body.email); const row=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if(!row||!(await verifyPassword(String(body.password||''),row.password_hash))) throw Object.assign(new Error('Invalid email or password.'),{status:401});
    if(row.status!=='active') throw Object.assign(new Error('This account is not active.'),{status:403});
    const token=newSessionToken(), created=nowIso(), expires=new Date(Date.now()+config.sessionTtlMs).toISOString();
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hashToken(token),row.id,expires,created);
    audit(row.id,'auth.login','user',row.id);
    return json(res,200,{user:{id:row.id,email:row.email,displayName:row.display_name,city:row.city,role:row.role}},{...cors,'set-cookie':sessionCookie(token,Math.floor(config.sessionTtlMs/1000))});
  }

  if(req.method==='POST'&&url.pathname==='/auth/logout'){
    const token=parseCookies(req)[config.cookieName]; if(token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
    return json(res,200,{ok:true},{...cors,'set-cookie':sessionCookie('',0)});
  }

  if(req.method==='GET'&&url.pathname==='/auth/me') return json(res,200,{user:getCurrentUser(req)},cors);

  if(req.method==='POST'&&url.pathname==='/identity/verifications'){
    const user=requireUser(req); const body=await readBody(req);
    const hasMerchantApplication = Boolean(db.prepare('SELECT id FROM merchant_applications WHERE user_id=? LIMIT 1').get(user.id));
    const accountRole = user.role === 'merchant' || hasMerchantApplication ? 'merchant' : 'marketplace_user';
    const result=await verifyIdentity({type:String(body.type||'').toLowerCase(),identifier:body.identifier,fullName:body.fullName,consent:Boolean(body.consent),accountRole});
    const id=randomId('idv_'), created=nowIso();
    db.prepare(`INSERT INTO identity_verifications(id,user_id,type,status,provider,provider_reference,masked_identifier,last4,name_match,verified_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,type) DO UPDATE SET status=excluded.status,provider=excluded.provider,provider_reference=excluded.provider_reference,masked_identifier=excluded.masked_identifier,last4=excluded.last4,name_match=excluded.name_match,verified_at=excluded.verified_at`)
      .run(id,user.id,result.type,result.status,result.provider,result.providerReference,result.maskedIdentifier,result.last4,result.nameMatch?1:0,result.verifiedAt,created);
    audit(user.id,'identity.verify',result.type,id,{status:result.status,provider:result.provider});
    return json(res,200,{verification:result},cors);
  }

  if(req.method==='GET'&&url.pathname==='/identity/verifications'){
    const user=requireUser(req); const rows=db.prepare('SELECT type,status,provider,provider_reference,masked_identifier,last4,name_match,verified_at FROM identity_verifications WHERE user_id=?').all(user.id);
    return json(res,200,{verifications:rows.map(r=>({type:r.type,status:r.status,provider:r.provider,verificationReference:r.provider_reference,maskedIdentifier:r.masked_identifier,last4:r.last4,nameMatch:Boolean(r.name_match),verifiedAt:r.verified_at}))},cors);
  }

  if(req.method==='GET'&&url.pathname==='/identity/eligibility'){
    const user=requireUser(req);
    const application=db.prepare("SELECT id,status,submitted_at FROM merchant_applications WHERE user_id=? ORDER BY submitted_at DESC LIMIT 1").get(user.id);
    const bvnEligible=user.role==='merchant'||Boolean(application);
    return json(res,200,{
      bvnEligible,
      reason:bvnEligible?(user.role==='merchant'?'merchant_role':'merchant_application'):'ordinary_marketplace_account',
      merchantApplication:application?{id:application.id,status:application.status,submittedAt:application.submitted_at}:null,
    },cors);
  }

  if(req.method==='POST'&&url.pathname==='/merchant-applications'){
    const user=requireUser(req); const nin=db.prepare("SELECT status FROM identity_verifications WHERE user_id=? AND type='nin'").get(user.id);
    if(!nin||!['verified','demo_verified'].includes(nin.status)) throw Object.assign(new Error('Complete NIN identity verification before applying.'),{status:400});
    const activeApplication=db.prepare("SELECT id,status FROM merchant_applications WHERE user_id=? AND status IN ('pending','under_review','approved','suspended') ORDER BY submitted_at DESC LIMIT 1").get(user.id);
    if(activeApplication) throw Object.assign(new Error('You already have an active merchant application.'),{status:409});
    const body=await readBody(req); for(const key of ['businessName','category','businessAddress']) if(!String(body[key]||'').trim()) throw Object.assign(new Error(`${key} is required.`),{status:400});
    const id=randomId('mapp_'), now=nowIso();
    db.prepare(`INSERT INTO merchant_applications(id,user_id,business_name,category,business_address,registration_reference,identity_status,status,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(id,user.id,String(body.businessName).trim(),String(body.category).trim(),String(body.businessAddress).trim(),String(body.registrationReference||'').trim(),nin.status,'pending',now,now);
    audit(user.id,'merchant.apply','merchant_application',id);
    return json(res,201,{application:{id,status:'pending',submittedAt:now}},cors);
  }

  if(req.method==='GET'&&url.pathname==='/merchant-applications/me'){
    const user=requireUser(req); const rows=db.prepare('SELECT * FROM merchant_applications WHERE user_id=? ORDER BY submitted_at DESC').all(user.id); return json(res,200,{applications:rows},cors);
  }

  if(req.method==='GET'&&url.pathname==='/admin/merchant-applications'){
    requireAdmin(req); const rows=db.prepare('SELECT * FROM merchant_applications ORDER BY submitted_at DESC').all(); return json(res,200,{applications:rows},cors);
  }

  const adminReview=url.pathname.match(/^\/admin\/merchant-applications\/([^/]+)\/review$/);
  if(req.method==='POST'&&adminReview){
    const admin=requireAdmin(req); const appId=adminReview[1]; const body=await readBody(req); const app=db.prepare('SELECT * FROM merchant_applications WHERE id=?').get(appId); if(!app) throw Object.assign(new Error('Application not found.'),{status:404});
    const allowedChecks=['cac_status','physical_inspection_status','category_docs_status','settlement_account_status','test_order_status'];
    for(const key of allowedChecks){ if(body[key]&&['pending','passed','failed','not_applicable'].includes(body[key])) db.prepare(`UPDATE merchant_applications SET ${key}=?, updated_at=? WHERE id=?`).run(body[key],nowIso(),appId); }
    const fresh=db.prepare('SELECT * FROM merchant_applications WHERE id=?').get(appId);
    const checks=[fresh.cac_status,fresh.identity_status,fresh.physical_inspection_status,fresh.category_docs_status,fresh.settlement_account_status,fresh.test_order_status];
    const allGood=checks.every(v=>['passed','verified','not_applicable'].includes(v));
    if(body.decision==='approve'){
      if(!allGood) throw Object.assign(new Error('All required verification checks must pass before approval.'),{status:400});
      db.prepare("UPDATE merchant_applications SET status='approved', updated_at=? WHERE id=?").run(nowIso(),appId);
      const merchantId=randomId('mer_');
      db.prepare(`INSERT OR IGNORE INTO merchants(id,application_id,user_id,name,category,city,verification_status,checkout_enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(merchantId,appId,fresh.user_id,fresh.business_name,fresh.category,'Kaduna','verified',1,nowIso(),nowIso());
      db.prepare("UPDATE users SET role=CASE WHEN role='admin' THEN role ELSE 'merchant' END WHERE id=?").run(fresh.user_id);
      audit(admin.id,'merchant.approve','merchant_application',appId);
    } else if(body.decision==='reject') { db.prepare("UPDATE merchant_applications SET status='rejected', updated_at=? WHERE id=?").run(nowIso(),appId); audit(admin.id,'merchant.reject','merchant_application',appId); }
    return json(res,200,{application:db.prepare('SELECT * FROM merchant_applications WHERE id=?').get(appId)},cors);
  }

  if(req.method==='GET'&&url.pathname==='/merchants'){
    const merchants=db.prepare("SELECT id,name,category,city,delivery_fee,created_at FROM merchants WHERE verification_status='verified' AND checkout_enabled=1 ORDER BY name").all();
    return json(res,200,{merchants:merchants.map(m=>({id:m.id,name:m.name,category:m.category,city:m.city,deliveryFee:m.delivery_fee,verified:true,checkoutEnabled:true,createdAt:m.created_at}))},cors);
  }

  if(req.method==='GET'&&url.pathname==='/merchant/me'){
    const user=requireUser(req);
    const merchant=db.prepare("SELECT id,name,category,city,delivery_fee,verification_status,checkout_enabled,suspension_reason,suspended_at,created_at,updated_at FROM merchants WHERE user_id=? ORDER BY created_at DESC LIMIT 1").get(user.id);
    if(!merchant) throw Object.assign(new Error('Merchant account not found.'),{status:404});
    const products=db.prepare('SELECT id,name,description,price,active,created_at,updated_at FROM merchant_products WHERE merchant_id=? ORDER BY created_at DESC').all(merchant.id);
    return json(res,200,{merchant:{id:merchant.id,name:merchant.name,category:merchant.category,city:merchant.city,deliveryFee:merchant.delivery_fee,verificationStatus:merchant.verification_status,checkoutEnabled:Boolean(merchant.checkout_enabled),createdAt:merchant.created_at,updatedAt:merchant.updated_at,suspensionReason:merchant.suspension_reason||'',suspendedAt:merchant.suspended_at||null,products:products.map(p=>({id:p.id,name:p.name,description:p.description,price:p.price,active:Boolean(p.active),createdAt:p.created_at,updatedAt:p.updated_at}))}},cors);
  }

  const merchantPublic=url.pathname.match(/^\/merchants\/([^/]+)$/);
  if(req.method==='GET'&&merchantPublic){
    const merchant=db.prepare("SELECT id,name,category,city,delivery_fee,created_at FROM merchants WHERE id=? AND verification_status='verified' AND checkout_enabled=1").get(merchantPublic[1]);
    if(!merchant) throw Object.assign(new Error('Verified merchant not found.'),{status:404});
    const products=db.prepare('SELECT id,name,description,price FROM merchant_products WHERE merchant_id=? AND active=1 ORDER BY created_at DESC').all(merchant.id);
    return json(res,200,{merchant:{id:merchant.id,name:merchant.name,category:merchant.category,city:merchant.city,deliveryFee:merchant.delivery_fee,verified:true,checkoutEnabled:true,createdAt:merchant.created_at,products}},cors);
  }

  if(req.method==='POST'&&url.pathname==='/merchant/products'){
    const user=requireUser(req); const merchant=db.prepare("SELECT * FROM merchants WHERE user_id=? AND verification_status='verified'").get(user.id);
    if(!merchant) throw Object.assign(new Error('Verified merchant account required.'),{status:403});
    const body=await readBody(req); const name=String(body.name||'').trim(); const description=String(body.description||'').trim(); const price=Math.round(Number(body.price));
    if(!name||!Number.isFinite(price)||price<0) throw Object.assign(new Error('Valid product name and price are required.'),{status:400});
    const id=randomId('prd_'), now=nowIso();
    db.prepare('INSERT INTO merchant_products(id,merchant_id,name,description,price,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,merchant.id,name,description,price,1,now,now);
    audit(user.id,'merchant.product.create','merchant_product',id,{merchantId:merchant.id});
    return json(res,201,{product:{id,name,description,price}},cors);
  }

  if(req.method==='PATCH'&&url.pathname==='/merchant/settings'){
    const user=requireUser(req); const merchant=db.prepare("SELECT * FROM merchants WHERE user_id=? AND verification_status='verified'").get(user.id);
    if(!merchant) throw Object.assign(new Error('Verified merchant account required.'),{status:403});
    const body=await readBody(req); const deliveryFee=Math.round(Number(body.deliveryFee));
    if(!Number.isFinite(deliveryFee)||deliveryFee<0||deliveryFee>100000) throw Object.assign(new Error('Delivery fee is invalid.'),{status:400});
    db.prepare('UPDATE merchants SET delivery_fee=?,updated_at=? WHERE id=?').run(deliveryFee,nowIso(),merchant.id);
    audit(user.id,'merchant.settings.update','merchant',merchant.id,{deliveryFee});
    return json(res,200,{merchant:{id:merchant.id,deliveryFee}},cors);
  }

  if(req.method==='POST'&&url.pathname==='/checkout/create'){
    const user=requireUser(req); const body=await readBody(req); const merchant=db.prepare("SELECT * FROM merchants WHERE id=? AND verification_status='verified' AND checkout_enabled=1").get(String(body.merchantId||''));
    if(!merchant) throw Object.assign(new Error('Merchant is not enabled for online checkout.'),{status:400});
    if(!Array.isArray(body.items)||body.items.length===0) throw Object.assign(new Error('At least one order item is required.'),{status:400});
    if(String(body.deliveryAddress||'').trim().length<8) throw Object.assign(new Error('A valid delivery address is required.'),{status:400});
    const normalized=[];
    for(const requested of body.items){
      const productId=String(requested.productId||requested.id||''); const quantity=Math.round(Number(requested.quantity??requested.qty));
      if(!productId||!Number.isInteger(quantity)||quantity<=0||quantity>100) throw Object.assign(new Error('Invalid order item quantity.'),{status:400});
      const product=db.prepare('SELECT id,name,price FROM merchant_products WHERE id=? AND merchant_id=? AND active=1').get(productId,merchant.id);
      if(!product) throw Object.assign(new Error('One or more products are unavailable.'),{status:400});
      normalized.push({productId:product.id,name:product.name,unitPrice:product.price,quantity});
    }
    const subtotal=normalized.reduce((s,i)=>s+i.unitPrice*i.quantity,0); const settlement=calculateSettlement({subtotal,deliveryFee:merchant.delivery_fee});
    const id=randomId('ord_'); const intent=await createPaymentIntent({orderId:id,amount:settlement.customerTotal}); const now=nowIso();
    db.exec('BEGIN');
    try{
      db.prepare(`INSERT INTO orders(id,buyer_user_id,merchant_id,status,delivery_address,subtotal,delivery_fee,service_fee,commission,customer_total,merchant_settlement,payment_reference,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id,user.id,merchant.id,'payment_pending',encryptDeliveryAddress(String(body.deliveryAddress).trim()),settlement.subtotal,settlement.deliveryFee,settlement.serviceFee,settlement.commission,settlement.customerTotal,settlement.merchantSettlement,intent.paymentReference,now);
      const insertItem=db.prepare('INSERT INTO order_items(id,order_id,product_id,name,unit_price,quantity) VALUES(?,?,?,?,?,?)');
      for(const item of normalized) insertItem.run(randomId('oit_'),id,item.productId,item.name,item.unitPrice,item.quantity);
      db.exec('COMMIT');
    }catch(error){ db.exec('ROLLBACK'); throw error; }
    audit(user.id,'checkout.create','order',id,{merchantId:merchant.id});
    return json(res,201,{order:{id,paymentReference:intent.paymentReference,status:'payment_pending',...settlement,provider:intent.provider}},cors);
  }

  const demoConfirm=url.pathname.match(/^\/checkout\/([^/]+)\/demo-confirm$/);
  if(req.method==='POST'&&demoConfirm){
    const user=requireUser(req); const orderId=demoConfirm[1];
    const order=db.prepare('SELECT * FROM orders WHERE id=? AND buyer_user_id=?').get(orderId,user.id);
    if(!order) throw Object.assign(new Error('Order not found.'),{status:404});
    if(order.status!=='payment_pending') throw Object.assign(new Error('Order payment is not pending.'),{status:409});
    const confirmed=await confirmDemoPaymentIntent({paymentReference:order.payment_reference,amount:order.customer_total});
    const pod=createDeliveryPin(order.id);
    db.prepare("UPDATE orders SET status='paid',paid_at=?,delivery_pin_hash=?,delivery_pin_last2=?,delivery_pin_created_at=? WHERE id=? AND status='payment_pending'")
      .run(confirmed.paidAt,pod.hash,pod.last2,pod.createdAt,order.id);
    const merchant=db.prepare('SELECT user_id,name FROM merchants WHERE id=?').get(order.merchant_id);
    if(merchant) createNotification(merchant.user_id,{type:'store_order',title:'New paid order',body:`Order ${order.id} is ready for fulfilment.`,href:'/store-dashboard',entityType:'order',entityId:order.id});
    audit(user.id,'checkout.demo_paid','order',order.id,{paymentReference:order.payment_reference,provider:confirmed.provider});
    return json(res,200,{order:{id:order.id,status:'paid',paymentReference:order.payment_reference,paidAt:confirmed.paidAt,customerTotal:order.customer_total,deliveryPin:pod.pin,deliveryPinLast2:pod.last2}},cors);
  }

  if(req.method==='GET'&&url.pathname==='/orders/me'){
    const user=requireUser(req);
    const orders=db.prepare(`SELECT o.*,m.name merchant_name,m.category merchant_category FROM orders o JOIN merchants m ON m.id=o.merchant_id WHERE o.buyer_user_id=? ORDER BY o.created_at DESC`).all(user.id);
    const itemStmt=db.prepare('SELECT product_id,name,unit_price,quantity FROM order_items WHERE order_id=? ORDER BY rowid');
    const caseStmt=db.prepare("SELECT * FROM order_cases WHERE order_id=? ORDER BY created_at DESC");
    return json(res,200,{orders:orders.map(o=>({
      id:o.id,merchantId:o.merchant_id,merchantName:o.merchant_name,merchantCategory:o.merchant_category,status:o.status,deliveryAddress:decryptDeliveryAddress(o.delivery_address),
      subtotal:o.subtotal,deliveryFee:o.delivery_fee,serviceFee:o.service_fee,commission:o.commission,customerTotal:o.customer_total,merchantSettlement:o.merchant_settlement,
      paymentReference:o.payment_reference,createdAt:o.created_at,paidAt:o.paid_at,deliveredAt:o.delivered_at,deliveryPinLast2:o.delivery_pin_last2||'',deliveryPinRequired:Boolean(o.delivery_pin_hash)&&o.status!=='delivered'&&o.status!=='refunded',
      items:itemStmt.all(o.id).map(i=>({productId:i.product_id,name:i.name,unitPrice:i.unit_price,quantity:i.quantity})),cases:caseStmt.all(o.id).map(publicOrderCase)
    }))},cors);
  }

  const resetDeliveryPin=url.pathname.match(/^\/orders\/([^/]+)\/delivery-pin\/reset$/);
  if(req.method==='POST'&&resetDeliveryPin){
    const user=requireUser(req); const order=db.prepare('SELECT * FROM orders WHERE id=? AND buyer_user_id=?').get(resetDeliveryPin[1],user.id);
    if(!order) throw Object.assign(new Error('Order not found.'),{status:404});
    if(!['paid','preparing','out_for_delivery'].includes(order.status)) throw Object.assign(new Error('Delivery PIN can only be reset for an active paid delivery.'),{status:409});
    const pod=createDeliveryPin(order.id);
    db.prepare('UPDATE orders SET delivery_pin_hash=?,delivery_pin_last2=?,delivery_pin_created_at=? WHERE id=?').run(pod.hash,pod.last2,pod.createdAt,order.id);
    audit(user.id,'order.delivery_pin.reset','order',order.id);
    return json(res,200,{order:{id:order.id,status:order.status,deliveryPin:pod.pin,deliveryPinLast2:pod.last2}},cors);
  }

  const customerCancel=url.pathname.match(/^\/orders\/([^/]+)\/cancel$/);
  if(req.method==='POST'&&customerCancel){
    const user=requireUser(req); const order=db.prepare('SELECT * FROM orders WHERE id=? AND buyer_user_id=?').get(customerCancel[1],user.id);
    if(!order) throw Object.assign(new Error('Order not found.'),{status:404});
    const body=await readBody(req);
    if(order.status==='payment_pending'){
      db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(order.id);
      audit(user.id,'order.cancel.unpaid','order',order.id);
      return json(res,200,{order:{id:order.id,status:'cancelled'}},cors);
    }
    if(order.status==='paid'){
      const opened=openOrderCase({order,openedByUserId:user.id,type:'refund_request',reason:body.reason||'Customer requested cancellation after payment.',moveToRefundPending:true});
      const merchant=db.prepare('SELECT user_id FROM merchants WHERE id=?').get(order.merchant_id);
      if(merchant) createNotification(merchant.user_id,{type:'order_case',title:'Order cancellation requested',body:`Order ${order.id} is paused for refund review.`,href:'/store-dashboard',entityType:'order',entityId:order.id});
      notifyAdmins({type:'order_case',title:'Refund review required',body:`Customer requested cancellation for order ${order.id}.`,href:'/admin',entityType:'order_case',entityId:opened.id});
      audit(user.id,'order.cancel.refund_requested','order',order.id,{caseId:opened.id});
      return json(res,202,{order:{id:order.id,status:'refund_pending'},case:publicOrderCase(opened)},cors);
    }
    throw Object.assign(new Error('This order can no longer be cancelled directly. Open a dispute if there is a delivery or product problem.'),{status:409});
  }

  const refundRequest=url.pathname.match(/^\/orders\/([^/]+)\/refund-request$/);
  if(req.method==='POST'&&refundRequest){
    const user=requireUser(req); const order=db.prepare('SELECT * FROM orders WHERE id=? AND buyer_user_id=?').get(refundRequest[1],user.id);
    if(!order) throw Object.assign(new Error('Order not found.'),{status:404});
    if(!['paid','preparing'].includes(order.status)) throw Object.assign(new Error('A refund request is only available before the order is out for delivery. Open a dispute instead.'),{status:409});
    const body=await readBody(req); const opened=openOrderCase({order,openedByUserId:user.id,type:'refund_request',reason:body.reason,moveToRefundPending:true});
    const merchant=db.prepare('SELECT user_id FROM merchants WHERE id=?').get(order.merchant_id);
    if(merchant) createNotification(merchant.user_id,{type:'order_case',title:'Refund requested',body:`Order ${order.id} is paused while MeetMart reviews the refund request.`,href:'/store-dashboard',entityType:'order',entityId:order.id});
    notifyAdmins({type:'order_case',title:'Refund review required',body:`Refund requested for order ${order.id}.`,href:'/admin',entityType:'order_case',entityId:opened.id});
    audit(user.id,'order.refund.request','order',order.id,{caseId:opened.id});
    return json(res,202,{order:{id:order.id,status:'refund_pending'},case:publicOrderCase(opened)},cors);
  }

  const disputeRequest=url.pathname.match(/^\/orders\/([^/]+)\/disputes$/);
  if(req.method==='POST'&&disputeRequest){
    const user=requireUser(req); const order=db.prepare('SELECT * FROM orders WHERE id=? AND buyer_user_id=?').get(disputeRequest[1],user.id);
    if(!order) throw Object.assign(new Error('Order not found.'),{status:404});
    if(['payment_pending','cancelled','refunded'].includes(order.status)) throw Object.assign(new Error('This order is not eligible for a dispute.'),{status:409});
    const body=await readBody(req); const type=body.type==='address_misuse'?'address_misuse':'dispute';
    const opened=openOrderCase({order,openedByUserId:user.id,type,reason:body.reason,moveToRefundPending:false});
    notifyAdmins({type:'order_case',title:type==='address_misuse'?'Customer privacy report':'Order dispute opened',body:`Order ${order.id} requires admin review.`,href:'/admin',entityType:'order_case',entityId:opened.id});
    const merchant=db.prepare('SELECT user_id FROM merchants WHERE id=?').get(order.merchant_id);
    if(merchant) createNotification(merchant.user_id,{type:'order_case',title:type==='address_misuse'?'Customer privacy report opened':'Order dispute opened',body:`MeetMart opened a case for order ${order.id}.`,href:'/store-dashboard',entityType:'order',entityId:order.id});
    audit(user.id,type==='address_misuse'?'order.address_misuse.report':'order.dispute.open','order',order.id,{caseId:opened.id});
    return json(res,201,{case:publicOrderCase(opened)},cors);
  }

  if(req.method==='GET'&&url.pathname==='/merchant/orders'){
    const user=requireUser(req); const merchant=getMerchantForUser(user.id);
    if(!merchant) throw Object.assign(new Error('Merchant account required.'),{status:403});
    const orders=db.prepare(`SELECT id,status,subtotal,delivery_fee,service_fee,commission,customer_total,merchant_settlement,payment_reference,created_at,paid_at,delivered_at,address_revealed_at,address_reveal_count,delivery_pin_last2 FROM orders WHERE merchant_id=? AND status<>'payment_pending' ORDER BY created_at DESC`).all(merchant.id);
    const itemStmt=db.prepare('SELECT product_id,name,unit_price,quantity FROM order_items WHERE order_id=? ORDER BY rowid');
    const caseStmt=db.prepare("SELECT * FROM order_cases WHERE order_id=? AND status IN ('open','under_review') ORDER BY created_at DESC");
    return json(res,200,{merchantStatus:merchant.verification_status,checkoutEnabled:Boolean(merchant.checkout_enabled),orders:orders.map(o=>({id:o.id,status:o.status,deliveryAddressMasked:'Protected delivery address',addressRevealAvailable:merchant.verification_status==='verified'&&Boolean(merchant.checkout_enabled)&&['preparing','out_for_delivery'].includes(o.status)&&Number(o.address_reveal_count||0)===0,addressRevealedAt:o.address_revealed_at||null,subtotal:o.subtotal,deliveryFee:o.delivery_fee,serviceFee:o.service_fee,commission:o.commission,customerTotal:o.customer_total,merchantSettlement:o.merchant_settlement,paymentReference:o.payment_reference,createdAt:o.created_at,paidAt:o.paid_at,deliveredAt:o.delivered_at,deliveryPinRequired:o.status==='out_for_delivery',deliveryPinLast2:o.delivery_pin_last2||'',items:itemStmt.all(o.id).map(i=>({productId:i.product_id,name:i.name,unitPrice:i.unit_price,quantity:i.quantity})),cases:caseStmt.all(o.id).map(publicOrderCase)}))},cors);
  }

  const merchantOrderStatus=url.pathname.match(/^\/merchant\/orders\/([^/]+)\/status$/);
  if(req.method==='PATCH'&&merchantOrderStatus){
    const user=requireUser(req); const merchant=requireVerifiedMerchantForUser(user.id);
    const order=db.prepare('SELECT * FROM orders WHERE id=? AND merchant_id=?').get(merchantOrderStatus[1],merchant.id);
    if(!order) throw Object.assign(new Error('Merchant order not found.'),{status:404});
    const blockingCase=db.prepare("SELECT id FROM order_cases WHERE order_id=? AND case_type IN ('refund_request','merchant_cancellation','dispute','address_misuse') AND status IN ('open','under_review') LIMIT 1").get(order.id);
    if(blockingCase) throw Object.assign(new Error('This order is paused while MeetMart reviews an active case.'),{status:409});
    const body=await readBody(req); const next=String(body.status||'');
    const transitions={paid:['preparing'],preparing:['out_for_delivery'],out_for_delivery:[],refund_pending:[],delivered:[],cancelled:[],refunded:[]};
    const allowed=transitions[order.status]||[];
    if(!allowed.includes(next)) throw Object.assign(new Error(next==='delivered'?'Delivery completion requires the customer proof-of-delivery PIN.':`Invalid order status transition from ${order.status} to ${next||'empty'}.`),{status:409});
    db.prepare('UPDATE orders SET status=? WHERE id=?').run(next,order.id);
    createNotification(order.buyer_user_id,{type:'order_update',title:'Order status updated',body:`Order ${order.id} is now ${next.replaceAll('_',' ')}.`,href:'/stores/orders',entityType:'order',entityId:order.id});
    audit(user.id,'merchant.order.status','order',order.id,{from:order.status,to:next,merchantId:merchant.id});
    return json(res,200,{order:{id:order.id,status:next}},cors);
  }

  const merchantCancel=url.pathname.match(/^\/merchant\/orders\/([^/]+)\/cancel$/);
  if(req.method==='POST'&&merchantCancel){
    const user=requireUser(req); const merchant=requireVerifiedMerchantForUser(user.id);
    const order=db.prepare('SELECT * FROM orders WHERE id=? AND merchant_id=?').get(merchantCancel[1],merchant.id);
    if(!order) throw Object.assign(new Error('Merchant order not found.'),{status:404});
    if(!['paid','preparing'].includes(order.status)) throw Object.assign(new Error('This order can no longer be cancelled by the merchant.'),{status:409});
    const body=await readBody(req); const opened=openOrderCase({order,openedByUserId:user.id,type:'merchant_cancellation',reason:body.reason||'Merchant cannot fulfil this paid order.',moveToRefundPending:true});
    createNotification(order.buyer_user_id,{type:'order_case',title:'Merchant requested cancellation',body:`Order ${order.id} is paused for refund review.`,href:'/stores/orders',entityType:'order',entityId:order.id});
    notifyAdmins({type:'order_case',title:'Merchant cancellation requires refund',body:`Merchant requested cancellation for order ${order.id}.`,href:'/admin',entityType:'order_case',entityId:opened.id});
    audit(user.id,'merchant.order.cancel.request','order',order.id,{caseId:opened.id});
    return json(res,202,{order:{id:order.id,status:'refund_pending'},case:publicOrderCase(opened)},cors);
  }

  const revealAddress=url.pathname.match(/^\/merchant\/orders\/([^/]+)\/reveal-address$/);
  if(req.method==='POST'&&revealAddress){
    const user=requireUser(req); const merchant=requireVerifiedMerchantForUser(user.id);
    const order=db.prepare('SELECT * FROM orders WHERE id=? AND merchant_id=?').get(revealAddress[1],merchant.id);
    if(!order) throw Object.assign(new Error('Merchant order not found.'),{status:404});
    if(!['preparing','out_for_delivery'].includes(order.status)) throw Object.assign(new Error('The delivery address is available only after preparation has started and before delivery is completed.'),{status:409});
    if(Number(order.address_reveal_count||0)>0) throw Object.assign(new Error('This delivery address has already been revealed once. Access is closed.'),{status:409});
    const blockingCase=db.prepare("SELECT id FROM order_cases WHERE order_id=? AND status IN ('open','under_review') LIMIT 1").get(order.id);
    if(blockingCase) throw Object.assign(new Error('Address access is paused while MeetMart reviews an active order case.'),{status:409});
    const body=await readBody(req); const userRow=db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
    if(!body.password||!await verifyPassword(String(body.password),userRow?.password_hash)){
      audit(user.id,'merchant.order.address_reveal_denied','order',order.id,{reason:'reauth_failed'});
      throw Object.assign(new Error('Re-enter your correct MeetMart password to reveal the delivery address.'),{status:403});
    }
    const accessedAt=nowIso();
    db.exec('BEGIN');
    try{
      const changed=db.prepare('UPDATE orders SET address_revealed_at=?,address_reveal_count=address_reveal_count+1 WHERE id=? AND address_reveal_count=0').run(accessedAt,order.id);
      if(Number(changed.changes)!==1) throw Object.assign(new Error('This delivery address has already been revealed once. Access is closed.'),{status:409});
      db.prepare('INSERT INTO order_address_access(id,order_id,merchant_user_id,ip_address,user_agent,accessed_at) VALUES(?,?,?,?,?,?)')
        .run(randomId('addr_'),order.id,user.id,requestIp(req),String(req.headers['user-agent']||'').slice(0,500),accessedAt);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    audit(user.id,'merchant.order.address_reveal','order',order.id,{merchantId:merchant.id,accessedAt});
    createNotification(order.buyer_user_id,{type:'privacy',title:'Delivery address accessed',body:`Your delivery address for order ${order.id} was revealed to the verified merchant for fulfilment.`,href:'/stores/orders',entityType:'order',entityId:order.id});
    return json(res,200,{orderId:order.id,deliveryAddress:decryptDeliveryAddress(order.delivery_address),revealedAt:accessedAt,warning:'Use this address only to complete this delivery. Do not copy, share, store, photograph or reuse it. Access has been logged by MeetMart.'},cors);
  }

  const completeDelivery=url.pathname.match(/^\/merchant\/orders\/([^/]+)\/complete-delivery$/);
  if(req.method==='POST'&&completeDelivery){
    const user=requireUser(req); const merchant=requireVerifiedMerchantForUser(user.id);
    const order=db.prepare('SELECT * FROM orders WHERE id=? AND merchant_id=?').get(completeDelivery[1],merchant.id);
    if(!order) throw Object.assign(new Error('Merchant order not found.'),{status:404});
    if(order.status!=='out_for_delivery') throw Object.assign(new Error('Order must be out for delivery before completion.'),{status:409});
    const blockingCase=db.prepare("SELECT id FROM order_cases WHERE order_id=? AND status IN ('open','under_review') LIMIT 1").get(order.id);
    if(blockingCase) throw Object.assign(new Error('Delivery completion is paused while MeetMart reviews an active order case.'),{status:409});
    const body=await readBody(req);
    if(!verifyDeliveryPin(order.id,body.pin,order.delivery_pin_hash)){
      audit(user.id,'merchant.order.delivery_pin_failed','order',order.id,{merchantId:merchant.id});
      throw Object.assign(new Error('Incorrect proof-of-delivery PIN.'),{status:403});
    }
    const deliveredAt=nowIso();
    db.prepare("UPDATE orders SET status='delivered',delivered_at=?,delivery_pin_hash=NULL WHERE id=?").run(deliveredAt,order.id);
    audit(user.id,'merchant.order.delivered','order',order.id,{merchantId:merchant.id});
    createNotification(order.buyer_user_id,{type:'order_update',title:'Order delivered',body:`Order ${order.id} was completed using your delivery PIN.`,href:'/stores/orders',entityType:'order',entityId:order.id});
    return json(res,200,{order:{id:order.id,status:'delivered',deliveredAt}},cors);
  }

  if(req.method==='GET'&&url.pathname==='/admin/merchants'){
    requireAdmin(req);
    const rows=db.prepare(`SELECT m.*,u.email,u.display_name FROM merchants m JOIN users u ON u.id=m.user_id ORDER BY m.created_at DESC`).all();
    return json(res,200,{merchants:rows.map(m=>({id:m.id,userId:m.user_id,name:m.name,category:m.category,city:m.city,verificationStatus:m.verification_status,checkoutEnabled:Boolean(m.checkout_enabled),suspensionReason:m.suspension_reason||'',suspendedAt:m.suspended_at||null,email:m.email,ownerName:m.display_name,createdAt:m.created_at}))},cors);
  }

  const adminMerchantStatus=url.pathname.match(/^\/admin\/merchants\/([^/]+)\/status$/);
  if(req.method==='PATCH'&&adminMerchantStatus){
    const admin=requireAdmin(req); const merchant=db.prepare('SELECT * FROM merchants WHERE id=?').get(adminMerchantStatus[1]);
    if(!merchant) throw Object.assign(new Error('Merchant not found.'),{status:404});
    const body=await readBody(req); const status=String(body.status||'');
    if(status==='suspended'){
      const reason=String(body.reason||'').trim(); if(reason.length<8) throw Object.assign(new Error('Suspension reason must be at least 8 characters.'),{status:400});
      const at=nowIso(); db.prepare("UPDATE merchants SET verification_status='suspended',checkout_enabled=0,suspension_reason=?,suspended_at=?,updated_at=? WHERE id=?").run(reason,at,at,merchant.id);
      db.prepare("UPDATE merchant_applications SET status='suspended',updated_at=? WHERE id=?").run(at,merchant.application_id);
      createNotification(merchant.user_id,{type:'merchant_status',title:'Store suspended',body:'MeetMart has temporarily disabled your store checkout. Open the merchant dashboard for status details.',href:'/store-dashboard',entityType:'merchant',entityId:merchant.id});
      const activeBuyers=db.prepare("SELECT DISTINCT buyer_user_id,id FROM orders WHERE merchant_id=? AND status IN ('paid','preparing','out_for_delivery','refund_pending')").all(merchant.id);
      for(const activeOrder of activeBuyers) createNotification(activeOrder.buyer_user_id,{type:'merchant_status',title:'Store temporarily paused',body:`MeetMart paused the store handling order ${activeOrder.id}. Do not share your delivery PIN until the order is cleared.`,href:'/stores/orders',entityType:'order',entityId:activeOrder.id});
      audit(admin.id,'admin.merchant.suspend','merchant',merchant.id,{reason,activeOrders:activeBuyers.length});
      return json(res,200,{merchant:{id:merchant.id,verificationStatus:'suspended',checkoutEnabled:false,suspensionReason:reason,suspendedAt:at}},cors);
    }
    if(status==='verified'){
      const app=db.prepare('SELECT status FROM merchant_applications WHERE id=?').get(merchant.application_id);
      if(!app||!['approved','suspended'].includes(app.status)) throw Object.assign(new Error('Merchant application is not eligible for restoration.'),{status:409});
      const at=nowIso(); db.prepare("UPDATE merchants SET verification_status='verified',checkout_enabled=1,suspension_reason='',suspended_at=NULL,updated_at=? WHERE id=?").run(at,merchant.id);
      db.prepare("UPDATE merchant_applications SET status='approved',updated_at=? WHERE id=?").run(at,merchant.application_id);
      createNotification(merchant.user_id,{type:'merchant_status',title:'Store restored',body:'MeetMart restored your Verified Store checkout.',href:'/store-dashboard',entityType:'merchant',entityId:merchant.id});
      audit(admin.id,'admin.merchant.restore','merchant',merchant.id);
      return json(res,200,{merchant:{id:merchant.id,verificationStatus:'verified',checkoutEnabled:true,suspensionReason:'',suspendedAt:null}},cors);
    }
    throw Object.assign(new Error('Status must be suspended or verified.'),{status:400});
  }

  if(req.method==='GET'&&url.pathname==='/admin/order-cases'){
    requireAdmin(req);
    const status=String(url.searchParams.get('status')||'').trim();
    const rows=status?db.prepare(`SELECT c.*,o.status order_status,o.customer_total,m.name merchant_name,u.display_name opened_by FROM order_cases c JOIN orders o ON o.id=c.order_id JOIN merchants m ON m.id=o.merchant_id JOIN users u ON u.id=c.opened_by_user_id WHERE c.status=? ORDER BY c.created_at DESC`).all(status):db.prepare(`SELECT c.*,o.status order_status,o.customer_total,m.name merchant_name,u.display_name opened_by FROM order_cases c JOIN orders o ON o.id=c.order_id JOIN merchants m ON m.id=o.merchant_id JOIN users u ON u.id=c.opened_by_user_id ORDER BY c.created_at DESC`).all();
    return json(res,200,{cases:rows.map(r=>({...publicOrderCase(r),orderStatus:r.order_status,customerTotal:r.customer_total,merchantName:r.merchant_name,openedBy:r.opened_by}))},cors);
  }

  const adminCaseReview=url.pathname.match(/^\/admin\/order-cases\/([^/]+)\/review$/);
  if(req.method==='POST'&&adminCaseReview){
    const admin=requireAdmin(req); const row=db.prepare('SELECT * FROM order_cases WHERE id=?').get(adminCaseReview[1]);
    if(!row) throw Object.assign(new Error('Order case not found.'),{status:404});
    if(!['open','under_review'].includes(row.status)) throw Object.assign(new Error('This case is already closed.'),{status:409});
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(row.order_id); const body=await readBody(req); const decision=String(body.decision||''); const note=String(body.note||'').trim(); const at=nowIso();
    if(decision==='approve_refund'){
      if(row.case_type==='address_misuse') throw Object.assign(new Error('Privacy cases require investigation; they cannot auto-refund from this action.'),{status:409});
      const refunded=await processRefund({paymentReference:order.payment_reference,amount:order.customer_total,orderId:order.id});
      db.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(order.id);
      db.prepare("UPDATE order_cases SET status='resolved',resolution=?,updated_at=?,resolved_at=? WHERE id=?").run(`refund_approved${note?`: ${note}`:''}`,at,refunded.refundedAt,row.id);
      createNotification(order.buyer_user_id,{type:'order_case',title:'Refund approved',body:`Refund approved for order ${order.id}.`,href:'/stores/orders',entityType:'order_case',entityId:row.id});
      audit(admin.id,'admin.order_case.refund','order_case',row.id,{orderId:order.id,provider:refunded.provider});
    }else if(decision==='reject'){
      if(order.status==='refund_pending'&&row.previous_order_status) db.prepare('UPDATE orders SET status=? WHERE id=?').run(row.previous_order_status,order.id);
      db.prepare("UPDATE order_cases SET status='rejected',resolution=?,updated_at=?,resolved_at=? WHERE id=?").run(note||'request_rejected',at,at,row.id);
      createNotification(order.buyer_user_id,{type:'order_case',title:'Order case reviewed',body:`MeetMart reviewed case ${row.id}.`,href:'/stores/orders',entityType:'order_case',entityId:row.id});
      audit(admin.id,'admin.order_case.reject','order_case',row.id,{orderId:order.id});
    }else if(decision==='resolve'){
      db.prepare("UPDATE order_cases SET status='resolved',resolution=?,updated_at=?,resolved_at=? WHERE id=?").run(note||'resolved_by_admin',at,at,row.id);
      createNotification(order.buyer_user_id,{type:'order_case',title:'Order case resolved',body:`MeetMart resolved case ${row.id}.`,href:'/stores/orders',entityType:'order_case',entityId:row.id});
      audit(admin.id,'admin.order_case.resolve','order_case',row.id,{orderId:order.id});
    }else throw Object.assign(new Error('Decision must be approve_refund, reject, or resolve.'),{status:400});
    return json(res,200,{case:publicOrderCase(db.prepare('SELECT * FROM order_cases WHERE id=?').get(row.id)),order:{id:order.id,status:db.prepare('SELECT status FROM orders WHERE id=?').get(order.id).status}},cors);
  }

  if(req.method==='GET'&&url.pathname==='/admin/address-access'){
    requireAdmin(req);
    const rows=db.prepare(`SELECT a.id,a.order_id,a.merchant_user_id,a.ip_address,a.user_agent,a.accessed_at,m.name merchant_name,u.display_name merchant_user_name FROM order_address_access a JOIN orders o ON o.id=a.order_id JOIN merchants m ON m.id=o.merchant_id JOIN users u ON u.id=a.merchant_user_id ORDER BY a.accessed_at DESC LIMIT 200`).all();
    return json(res,200,{access:rows.map(r=>({id:r.id,orderId:r.order_id,merchantUserId:r.merchant_user_id,merchantName:r.merchant_name,merchantUserName:r.merchant_user_name,ipAddress:r.ip_address,userAgent:r.user_agent,accessedAt:r.accessed_at}))},cors);
  }


  // --- Person-to-person marketplace API -----------------------------------
  if(req.method==='GET'&&url.pathname==='/marketplace/listings'){
    const current=getCurrentUser(req); const city=current?.city||'Kaduna';
    const search=String(url.searchParams.get('search')||'').trim(); const category=String(url.searchParams.get('category')||'').trim(); const area=String(url.searchParams.get('area')||'').trim();
    const where=["l.status='active'","l.city=?"]; const params=[city];
    if(search){where.push('(l.title LIKE ? OR l.description LIKE ?)'); params.push(`%${search}%`,`%${search}%`);}
    if(category&&category!=='All'){where.push('l.category=?');params.push(category);}
    if(area){where.push('l.area=?');params.push(area);}
    const rows=db.prepare(`SELECT l.*,u.display_name seller_name,
      (SELECT COUNT(*) FROM marketplace_reviews r WHERE r.reviewee_user_id=l.seller_user_id) review_count,
      COALESCE((SELECT ROUND(AVG(r.rating),1) FROM marketplace_reviews r WHERE r.reviewee_user_id=l.seller_user_id),0) seller_rating,
      ${current?"EXISTS(SELECT 1 FROM saved_listings s WHERE s.user_id=? AND s.listing_id=l.id)":"0"} saved
      FROM marketplace_listings l JOIN users u ON u.id=l.seller_user_id
      WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT 100`);
    const rowsParams=current?[current.id,...params]:params;
    const listings=rows.all(...rowsParams).map(r=>({id:r.id,title:r.title,description:r.description,category:r.category,condition:r.condition,price:r.price,city:r.city,area:r.area,imageUrl:publicAssetUrl(req,r.image_url),status:r.status,createdAt:r.created_at,saved:Boolean(r.saved),seller:{id:r.seller_user_id,displayName:r.seller_name,rating:Number(r.seller_rating||0),reviewCount:Number(r.review_count||0)}}));
    return json(res,200,{listings,city},cors);
  }

  if(req.method==='GET'&&url.pathname==='/marketplace/listings/me'){
    const user=requireUser(req); const rows=db.prepare(`SELECT * FROM marketplace_listings WHERE seller_user_id=? ORDER BY created_at DESC`).all(user.id);
    return json(res,200,{listings:rows.map(r=>({id:r.id,title:r.title,description:r.description,category:r.category,condition:r.condition,price:r.price,city:r.city,area:r.area,imageUrl:publicAssetUrl(req,r.image_url),status:r.status,createdAt:r.created_at,updatedAt:r.updated_at}))},cors);
  }

  if(req.method==='POST'&&url.pathname==='/marketplace/listings'){
    const user=requireUser(req); const body=await readBody(req);
    const title=String(body.title||'').trim(), description=String(body.description||'').trim(), category=String(body.category||'Other').trim(), condition=String(body.condition||'used').trim(), area=String(body.area||'').trim();
    const price=Math.round(Number(body.price)); const imageUploadId=String(body.imageUploadId||'').trim(); let storedImage='';
    if(title.length<3||title.length>120) throw Object.assign(new Error('Listing title must be between 3 and 120 characters.'),{status:400});
    if(!Number.isFinite(price)||price<0||price>1_000_000_000) throw Object.assign(new Error('Enter a valid listing price.'),{status:400});
    if(!area) throw Object.assign(new Error('Choose an area in your city.'),{status:400});
    let upload=null; if(imageUploadId){upload=db.prepare("SELECT * FROM marketplace_uploads WHERE id=? AND user_id=? AND status='pending'").get(imageUploadId,user.id);if(!upload) throw Object.assign(new Error('Uploaded image is unavailable or already used.'),{status:400});storedImage=upload.public_path;}
    const legacyImage=String(body.imageUrl||'').trim(); if(!storedImage&&legacyImage){if(!/^https?:\/\//i.test(legacyImage))throw Object.assign(new Error('Image URL must use http or https.'),{status:400});storedImage=legacyImage;}
    const id=randomId('lst_'), now=nowIso();
    db.prepare('INSERT INTO marketplace_listings(id,seller_user_id,title,description,category,condition,price,city,area,image_url,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,user.id,title,description,category,condition,price,user.city,area,storedImage,'active',now,now);
    if(upload) db.prepare("UPDATE marketplace_uploads SET status='claimed',claimed_listing_id=? WHERE id=? AND status='pending'").run(id,upload.id);
    audit(user.id,'marketplace.listing.create','marketplace_listing',id,{city:user.city,category,imageUploadId:imageUploadId||null});
    return json(res,201,{listing:{id,title,description,category,condition,price,city:user.city,area,imageUrl:publicAssetUrl(req,storedImage),status:'active',createdAt:now}},cors);
  }

  const listingDetail=url.pathname.match(/^\/marketplace\/listings\/([^/]+)$/);
  if(req.method==='GET'&&listingDetail){
    const current=getCurrentUser(req); const r=db.prepare(`SELECT l.*,u.display_name seller_name,u.city seller_city,
      (SELECT COUNT(*) FROM marketplace_reviews rv WHERE rv.reviewee_user_id=l.seller_user_id) review_count,
      COALESCE((SELECT ROUND(AVG(rv.rating),1) FROM marketplace_reviews rv WHERE rv.reviewee_user_id=l.seller_user_id),0) seller_rating,
      ${current?"EXISTS(SELECT 1 FROM saved_listings s WHERE s.user_id=? AND s.listing_id=l.id)":"0"} saved
      FROM marketplace_listings l JOIN users u ON u.id=l.seller_user_id WHERE l.id=? AND l.status<>'removed'`).get(...(current?[current.id,listingDetail[1]]:[listingDetail[1]]));
    if(!r) throw Object.assign(new Error('Listing not found.'),{status:404});
    if(current&&current.city!==r.city) throw Object.assign(new Error('This listing is outside your marketplace city.'),{status:403});
    return json(res,200,{listing:{id:r.id,title:r.title,description:r.description,category:r.category,condition:r.condition,price:r.price,city:r.city,area:r.area,imageUrl:publicAssetUrl(req,r.image_url),status:r.status,createdAt:r.created_at,saved:Boolean(r.saved),seller:{id:r.seller_user_id,displayName:r.seller_name,city:r.seller_city,rating:Number(r.seller_rating||0),reviewCount:Number(r.review_count||0)}}},cors);
  }

  if(req.method==='PATCH'&&listingDetail){
    const user=requireUser(req); const existing=db.prepare('SELECT * FROM marketplace_listings WHERE id=? AND seller_user_id=?').get(listingDetail[1],user.id);
    if(!existing) throw Object.assign(new Error('Your listing was not found.'),{status:404});
    const body=await readBody(req); const nextStatus=body.status===undefined?existing.status:String(body.status);
    if(!['draft','active','sold','removed'].includes(nextStatus)) throw Object.assign(new Error('Invalid listing status.'),{status:400});
    db.prepare('UPDATE marketplace_listings SET status=?,updated_at=? WHERE id=?').run(nextStatus,nowIso(),existing.id);
    audit(user.id,'marketplace.listing.status','marketplace_listing',existing.id,{from:existing.status,to:nextStatus});
    return json(res,200,{listing:{id:existing.id,status:nextStatus}},cors);
  }

  const listingSave=url.pathname.match(/^\/marketplace\/listings\/([^/]+)\/save$/);
  if(req.method==='POST'&&listingSave){
    const user=requireUser(req); const listing=db.prepare("SELECT id,city FROM marketplace_listings WHERE id=? AND status='active'").get(listingSave[1]);
    if(!listing||listing.city!==user.city) throw Object.assign(new Error('Listing is unavailable in your city.'),{status:404});
    db.prepare('INSERT OR IGNORE INTO saved_listings(user_id,listing_id,created_at) VALUES(?,?,?)').run(user.id,listing.id,nowIso());
    return json(res,200,{saved:true},cors);
  }
  if(req.method==='DELETE'&&listingSave){
    const user=requireUser(req); db.prepare('DELETE FROM saved_listings WHERE user_id=? AND listing_id=?').run(user.id,listingSave[1]); return json(res,200,{saved:false},cors);
  }
  if(req.method==='GET'&&url.pathname==='/marketplace/saved'){
    const user=requireUser(req); const rows=db.prepare(`SELECT l.*,u.display_name seller_name FROM saved_listings s JOIN marketplace_listings l ON l.id=s.listing_id JOIN users u ON u.id=l.seller_user_id WHERE s.user_id=? AND l.status<>'removed' ORDER BY s.created_at DESC`).all(user.id);
    return json(res,200,{listings:rows.map(r=>({id:r.id,title:r.title,description:r.description,category:r.category,condition:r.condition,price:r.price,city:r.city,area:r.area,imageUrl:publicAssetUrl(req,r.image_url),status:r.status,seller:{id:r.seller_user_id,displayName:r.seller_name}}))},cors);
  }

  if(req.method==='GET'&&url.pathname==='/wanted-requests'){
    const current=getCurrentUser(req); const city=current?.city||'Kaduna'; const status=String(url.searchParams.get('status')||'open');
    const rows=db.prepare(`SELECT w.*,u.display_name requester_name,(SELECT COUNT(*) FROM wanted_responses wr WHERE wr.request_id=w.id) response_count FROM wanted_requests w JOIN users u ON u.id=w.requester_user_id WHERE w.city=? AND w.status=? ORDER BY w.created_at DESC LIMIT 100`).all(city,status);
    return json(res,200,{requests:rows.map(r=>({id:r.id,title:r.title,details:r.details,category:r.category,budget:r.budget,city:r.city,area:r.area,urgency:r.urgency,status:r.status,createdAt:r.created_at,responseCount:Number(r.response_count||0),requester:{id:r.requester_user_id,displayName:r.requester_name}}))},cors);
  }
  if(req.method==='POST'&&url.pathname==='/wanted-requests'){
    const user=requireUser(req); const body=await readBody(req); const title=String(body.title||'').trim(), details=String(body.details||'').trim(), category=String(body.category||'Other').trim(), area=String(body.area||'').trim(), urgency=String(body.urgency||'This week').trim(); const budget=Math.round(Number(body.budget));
    if(title.length<3||!Number.isFinite(budget)||budget<0||!area) throw Object.assign(new Error('Title, budget and area are required.'),{status:400});
    const id=randomId('wnt_'), now=nowIso(); db.prepare('INSERT INTO wanted_requests(id,requester_user_id,title,details,category,budget,city,area,urgency,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,user.id,title,details,category,budget,user.city,area,urgency,'open',now,now);
    audit(user.id,'wanted.create','wanted_request',id,{city:user.city}); return json(res,201,{request:{id,title,details,category,budget,city:user.city,area,urgency,status:'open',createdAt:now}},cors);
  }
  const wantedRespond=url.pathname.match(/^\/wanted-requests\/([^/]+)\/respond$/);
  if(req.method==='POST'&&wantedRespond){
    const user=requireUser(req); const requestRow=db.prepare("SELECT * FROM wanted_requests WHERE id=? AND status='open'").get(wantedRespond[1]);
    if(!requestRow||requestRow.city!==user.city) throw Object.assign(new Error('Wanted request is unavailable in your city.'),{status:404});
    if(requestRow.requester_user_id===user.id) throw Object.assign(new Error('You cannot respond to your own wanted request.'),{status:400});
    const body=await readBody(req); const message=String(body.message||'I may have this item.').trim(); let listingId=body.listingId?String(body.listingId):null;
    if(listingId){const owned=db.prepare("SELECT id FROM marketplace_listings WHERE id=? AND seller_user_id=? AND city=? AND status='active'").get(listingId,user.id,user.city); if(!owned) throw Object.assign(new Error('Linked listing must be one of your active listings.'),{status:400});}
    const id=randomId('wrp_'); try{db.prepare('INSERT INTO wanted_responses(id,request_id,responder_user_id,message,listing_id,created_at) VALUES(?,?,?,?,?,?)').run(id,requestRow.id,user.id,message,listingId,nowIso());}catch{throw Object.assign(new Error('You already responded to this request.'),{status:409});}
    createNotification(requestRow.requester_user_id,{type:'wanted_response',title:'New response to your Wanted Request',body:`${user.displayName} responded to “${requestRow.title}”.`,href:'/requests',entityType:'wanted_request',entityId:requestRow.id});
    audit(user.id,'wanted.respond','wanted_request',requestRow.id,{responseId:id}); return json(res,201,{response:{id,requestId:requestRow.id,message,listingId}},cors);
  }

  const wantedResponses=url.pathname.match(/^\/wanted-requests\/([^/]+)\/responses$/);
  if(req.method==='GET'&&wantedResponses){
    const user=requireUser(req);
    const requestRow=db.prepare('SELECT id,requester_user_id,city FROM wanted_requests WHERE id=?').get(wantedResponses[1]);
    if(!requestRow||requestRow.requester_user_id!==user.id||requestRow.city!==user.city) throw Object.assign(new Error('Wanted request not found.'),{status:404});
    const rows=db.prepare(`SELECT wr.id,wr.message,wr.created_at,wr.listing_id,u.id responder_id,u.display_name responder_name,l.title listing_title,l.price listing_price,l.area listing_area,l.status listing_status
      FROM wanted_responses wr JOIN users u ON u.id=wr.responder_user_id LEFT JOIN marketplace_listings l ON l.id=wr.listing_id
      WHERE wr.request_id=? ORDER BY wr.created_at DESC`).all(requestRow.id);
    return json(res,200,{responses:rows.map(r=>({id:r.id,message:r.message,createdAt:r.created_at,responder:{id:r.responder_id,displayName:r.responder_name},listing:r.listing_id?{id:r.listing_id,title:r.listing_title,price:r.listing_price,area:r.listing_area,status:r.listing_status}:null}))},cors);
  }

  if(req.method==='POST'&&url.pathname==='/conversations'){
    const user=requireUser(req); const body=await readBody(req); const listing=db.prepare("SELECT * FROM marketplace_listings WHERE id=? AND status='active'").get(String(body.listingId||''));
    if(!listing||listing.city!==user.city) throw Object.assign(new Error('Listing is unavailable in your city.'),{status:404});
    if(listing.seller_user_id===user.id) throw Object.assign(new Error('You cannot start a buyer chat on your own listing.'),{status:400});
    let conversation=db.prepare('SELECT * FROM conversations WHERE listing_id=? AND buyer_user_id=? AND seller_user_id=?').get(listing.id,user.id,listing.seller_user_id);
    if(!conversation){const id=randomId('cnv_'),now=nowIso();db.prepare('INSERT INTO conversations(id,listing_id,buyer_user_id,seller_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,listing.id,user.id,listing.seller_user_id,now,now);conversation={id,listing_id:listing.id,buyer_user_id:user.id,seller_user_id:listing.seller_user_id,created_at:now,updated_at:now};audit(user.id,'conversation.create','conversation',id,{listingId:listing.id});}
    return json(res,200,{conversation:{id:conversation.id,listingId:conversation.listing_id,buyerUserId:conversation.buyer_user_id,sellerUserId:conversation.seller_user_id}},cors);
  }
  if(req.method==='GET'&&url.pathname==='/conversations'){
    const user=requireUser(req); const rows=db.prepare(`SELECT c.*,l.title,l.price,l.image_url,l.area,bu.display_name buyer_name,su.display_name seller_name,
      (SELECT body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) last_message,
      (SELECT created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) last_message_at
      FROM conversations c JOIN marketplace_listings l ON l.id=c.listing_id JOIN users bu ON bu.id=c.buyer_user_id JOIN users su ON su.id=c.seller_user_id
      WHERE c.buyer_user_id=? OR c.seller_user_id=? ORDER BY COALESCE(last_message_at,c.updated_at) DESC`).all(user.id,user.id);
    return json(res,200,{conversations:rows.map(r=>({id:r.id,listing:{id:r.listing_id,title:r.title,price:r.price,imageUrl:publicAssetUrl(req,r.image_url),area:r.area},buyer:{id:r.buyer_user_id,displayName:r.buyer_name},seller:{id:r.seller_user_id,displayName:r.seller_name},otherUser:r.buyer_user_id===user.id?{id:r.seller_user_id,displayName:r.seller_name}:{id:r.buyer_user_id,displayName:r.buyer_name},lastMessage:r.last_message||'',updatedAt:r.last_message_at||r.updated_at}))},cors);
  }
  const conversationMessages=url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
  if(req.method==='GET'&&conversationMessages){
    const user=requireUser(req); const c=db.prepare('SELECT * FROM conversations WHERE id=? AND (buyer_user_id=? OR seller_user_id=?)').get(conversationMessages[1],user.id,user.id); if(!c) throw Object.assign(new Error('Conversation not found.'),{status:404});
    const messages=db.prepare('SELECT m.id,m.sender_user_id,u.display_name sender_name,m.body,m.created_at FROM messages m JOIN users u ON u.id=m.sender_user_id WHERE m.conversation_id=? ORDER BY m.created_at').all(c.id);
    return json(res,200,{messages:messages.map(m=>({id:m.id,senderUserId:m.sender_user_id,senderName:m.sender_name,body:m.body,createdAt:m.created_at}))},cors);
  }
  if(req.method==='POST'&&conversationMessages){
    const user=requireUser(req); const c=db.prepare('SELECT * FROM conversations WHERE id=? AND (buyer_user_id=? OR seller_user_id=?)').get(conversationMessages[1],user.id,user.id); if(!c) throw Object.assign(new Error('Conversation not found.'),{status:404});
    const body=await readBody(req); const text=String(body.body||'').trim(); if(!text||text.length>2000) throw Object.assign(new Error('Message must be between 1 and 2000 characters.'),{status:400});
    const id=randomId('msg_'), now=nowIso(); db.prepare('INSERT INTO messages(id,conversation_id,sender_user_id,body,created_at) VALUES(?,?,?,?,?)').run(id,c.id,user.id,text,now);db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now,c.id);
    const recipientId=user.id===c.buyer_user_id?c.seller_user_id:c.buyer_user_id; const listing=db.prepare('SELECT title FROM marketplace_listings WHERE id=?').get(c.listing_id);
    const message={id,senderUserId:user.id,senderName:user.displayName,body:text,createdAt:now,conversationId:c.id};
    createNotification(recipientId,{type:'message',title:`New message from ${user.displayName}`,body:text.length>120?`${text.slice(0,117)}…`:text,href:`/chat/${c.id}`,entityType:'conversation',entityId:c.id});
    sendLive(recipientId,'message.created',message); audit(user.id,'message.send','conversation',c.id,{messageId:id,listingTitle:listing?.title||''});
    return json(res,201,{message},cors);
  }

  if(req.method==='GET'&&url.pathname==='/meetup-locations'){
    const current=getCurrentUser(req); const city=current?.city||'Kaduna'; const rows=db.prepare("SELECT id,name,city,area,kind FROM meetup_locations WHERE city=? AND status='approved' ORDER BY name").all(city); return json(res,200,{locations:rows.map(r=>({id:r.id,name:r.name,city:r.city,area:r.area,kind:r.kind}))},cors);
  }
  if(req.method==='POST'&&url.pathname==='/meetups'){
    const user=requireUser(req); const body=await readBody(req); const c=db.prepare('SELECT c.*,l.city FROM conversations c JOIN marketplace_listings l ON l.id=c.listing_id WHERE c.id=? AND (c.buyer_user_id=? OR c.seller_user_id=?)').get(String(body.conversationId||''),user.id,user.id);
    if(!c) throw Object.assign(new Error('Conversation not found.'),{status:404}); if(c.city!==user.city) throw Object.assign(new Error('Meetups must stay within your marketplace city.'),{status:400});
    const location=db.prepare("SELECT * FROM meetup_locations WHERE id=? AND city=? AND status='approved'").get(String(body.locationId||''),user.city); if(!location) throw Object.assign(new Error('Choose an approved meetup location.'),{status:400});
    const scheduledAt=new Date(body.scheduledAt); if(Number.isNaN(scheduledAt.getTime())||scheduledAt.getTime()<Date.now()+5*60*1000||scheduledAt.getTime()>Date.now()+60*24*60*60*1000) throw Object.assign(new Error('Choose a meetup time between 5 minutes and 60 days from now.'),{status:400});
    const activeMeetup=db.prepare("SELECT id FROM meetups WHERE conversation_id=? AND status IN ('pending','confirmed') LIMIT 1").get(c.id);
    if(activeMeetup) throw Object.assign(new Error('This conversation already has an active meetup plan.'),{status:409});
    const id=randomId('mtp_'), now=nowIso(); db.prepare('INSERT INTO meetups(id,conversation_id,listing_id,buyer_user_id,seller_user_id,location_id,scheduled_at,status,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,c.id,c.listing_id,c.buyer_user_id,c.seller_user_id,location.id,scheduledAt.toISOString(),'pending',user.id,now,now);
    const otherId=user.id===c.buyer_user_id?c.seller_user_id:c.buyer_user_id; createNotification(otherId,{type:'meetup_proposed',title:'Meetup proposal received',body:`${user.displayName} proposed ${location.name}.`,href:`/meetup/${c.id}`,entityType:'meetup',entityId:id});
    audit(user.id,'meetup.create','meetup',id,{locationId:location.id});
    return json(res,201,{meetup:{id,conversationId:c.id,listingId:c.listing_id,location:{id:location.id,name:location.name,area:location.area},scheduledAt:scheduledAt.toISOString(),status:'pending'}},cors);
  }
  if(req.method==='GET'&&url.pathname==='/meetups/me'){
    const user=requireUser(req); const rows=db.prepare(`SELECT m.*,l.title,ml.name location_name,ml.area location_area,bu.display_name buyer_name,su.display_name seller_name FROM meetups m JOIN marketplace_listings l ON l.id=m.listing_id JOIN meetup_locations ml ON ml.id=m.location_id JOIN users bu ON bu.id=m.buyer_user_id JOIN users su ON su.id=m.seller_user_id WHERE m.buyer_user_id=? OR m.seller_user_id=? ORDER BY m.scheduled_at DESC`).all(user.id,user.id);
    return json(res,200,{meetups:rows.map(r=>({id:r.id,conversationId:r.conversation_id,listing:{id:r.listing_id,title:r.title},buyer:{id:r.buyer_user_id,displayName:r.buyer_name},seller:{id:r.seller_user_id,displayName:r.seller_name},location:{id:r.location_id,name:r.location_name,area:r.location_area},scheduledAt:r.scheduled_at,status:r.status,createdAt:r.created_at}))},cors);
  }
  const meetupStatus=url.pathname.match(/^\/meetups\/([^/]+)\/status$/);
  if(req.method==='PATCH'&&meetupStatus){
    const user=requireUser(req); const meetup=db.prepare('SELECT * FROM meetups WHERE id=? AND (buyer_user_id=? OR seller_user_id=?)').get(meetupStatus[1],user.id,user.id); if(!meetup) throw Object.assign(new Error('Meetup not found.'),{status:404});
    const body=await readBody(req); const next=String(body.status||''); const transitions={pending:['confirmed','cancelled'],confirmed:['completed','cancelled'],completed:[],cancelled:[]}; if(!(transitions[meetup.status]||[]).includes(next)) throw Object.assign(new Error(`Invalid meetup transition from ${meetup.status} to ${next||'empty'}.`),{status:409});
    if(next==='confirmed'&&meetup.created_by_user_id===user.id) throw Object.assign(new Error('The other participant must confirm the meetup proposal.'),{status:403});
    if(next==='completed'&&Date.parse(meetup.scheduled_at)>Date.now()) throw Object.assign(new Error('A meetup cannot be completed before its scheduled time.'),{status:409});
    db.prepare('UPDATE meetups SET status=?,updated_at=? WHERE id=?').run(next,nowIso(),meetup.id); const otherId=user.id===meetup.buyer_user_id?meetup.seller_user_id:meetup.buyer_user_id;
    createNotification(otherId,{type:'meetup_status',title:`Meetup ${next.replaceAll('_',' ')}`,body:`${user.displayName} updated your meetup to ${next.replaceAll('_',' ')}.`,href:`/meetup/${meetup.conversation_id}`,entityType:'meetup',entityId:meetup.id});
    audit(user.id,'meetup.status','meetup',meetup.id,{from:meetup.status,to:next});return json(res,200,{meetup:{id:meetup.id,status:next}},cors);
  }

  if(req.method==='POST'&&url.pathname==='/marketplace/reviews'){
    const user=requireUser(req); const body=await readBody(req); const meetup=db.prepare("SELECT * FROM meetups WHERE id=? AND status='completed' AND (buyer_user_id=? OR seller_user_id=?)").get(String(body.meetupId||''),user.id,user.id); if(!meetup) throw Object.assign(new Error('Complete the meetup before leaving a review.'),{status:400});
    const reviewee=user.id===meetup.buyer_user_id?meetup.seller_user_id:meetup.buyer_user_id; const rating=Math.round(Number(body.rating)); const reviewBody=String(body.body||'').trim(); if(!Number.isInteger(rating)||rating<1||rating>5||reviewBody.length>1000) throw Object.assign(new Error('Rating must be 1 to 5 and review text under 1000 characters.'),{status:400});
    const id=randomId('rev_'); try{db.prepare('INSERT INTO marketplace_reviews(id,meetup_id,reviewer_user_id,reviewee_user_id,rating,body,created_at) VALUES(?,?,?,?,?,?,?)').run(id,meetup.id,user.id,reviewee,rating,reviewBody,nowIso());}catch{throw Object.assign(new Error('You already reviewed this meetup.'),{status:409});}
    createNotification(reviewee,{type:'review',title:'You received a marketplace review',body:`${user.displayName} left you a ${rating}-star review.`,href:'/profile',entityType:'marketplace_review',entityId:id});
    audit(user.id,'review.create','marketplace_review',id,{meetupId:meetup.id,revieweeUserId:reviewee,rating}); return json(res,201,{review:{id,meetupId:meetup.id,revieweeUserId:reviewee,rating,body:reviewBody}},cors);
  }
  const userReviews=url.pathname.match(/^\/marketplace\/users\/([^/]+)\/reviews$/);
  if(req.method==='GET'&&userReviews){
    const rows=db.prepare(`SELECT r.id,r.meetup_id,r.rating,r.body,r.created_at,u.display_name reviewer_name,m.listing_id,l.title listing_title FROM marketplace_reviews r JOIN users u ON u.id=r.reviewer_user_id JOIN meetups m ON m.id=r.meetup_id JOIN marketplace_listings l ON l.id=m.listing_id WHERE r.reviewee_user_id=? ORDER BY r.created_at DESC`).all(userReviews[1]);
    const summary=db.prepare('SELECT COUNT(*) count,COALESCE(ROUND(AVG(rating),1),0) average FROM marketplace_reviews WHERE reviewee_user_id=?').get(userReviews[1]); return json(res,200,{summary:{count:Number(summary.count||0),average:Number(summary.average||0)},reviews:rows.map(r=>({id:r.id,meetupId:r.meetup_id,rating:r.rating,body:r.body,createdAt:r.created_at,reviewerName:r.reviewer_name,listing:{id:r.listing_id,title:r.listing_title}}))},cors);
  }

  if(serveFrontend(req,res,url)) return;
  return json(res,404,{error:'Not found.'},cors);
}

const server=http.createServer(async(req,res)=>{
  const startedAt=Date.now(); const requestId=applySecurityHeaders(req,res);
  try{
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    const rate=config.env==='test'?null:rateLimiter(req,url.pathname,requestIp(req));
    if(rate){res.setHeader('x-ratelimit-limit',String(rate.limit));res.setHeader('x-ratelimit-remaining',String(rate.remaining));res.setHeader('x-ratelimit-reset',String(rate.resetSeconds));}
    if(rate&&!rate.allowed) return json(res,429,{error:'Too many requests. Please try again shortly.',requestId},{'retry-after':String(rate.resetSeconds),...corsHeaders(req.headers.origin)});
    await route(req,res);
  }
  catch(error){ const status=Number(error.status)||400; console.error(`[meetmart-api] ${requestId} ${req.method} ${req.url}:`, error.message); if(!res.headersSent) json(res,status,{error:error.message||'Request failed.',requestId},corsHeaders(req.headers.origin)); else try{res.end();}catch{} }
  finally{ if(config.env!=='test'&&Date.now()-startedAt>2000) console.warn(`[meetmart-api] slow request ${requestId} ${req.method} ${req.url} ${Date.now()-startedAt}ms`); }
});

let stopBackups=()=>{};
if(process.env.NODE_ENV!=='test'){
  const validation=validateRuntimeConfig({strict:config.isProduction});
  if(!validation.ok){console.error('[meetmart-config] startup blocked:\n'+validation.errors.map(v=>`- ${v}`).join('\n'));process.exit(1);}
  for(const warning of validation.warnings) console.warn(`[meetmart-config] ${warning}`);
  stopBackups=startBackupScheduler(console);
  server.listen(config.port,config.host,()=>console.log(`MeetMart listening on http://${config.host}:${config.port} (${config.env}, storage=${config.storageMode})`));
  const shutdown=signal=>{console.log(`[meetmart-api] ${signal} received; shutting down.`);stopBackups();for(const set of liveClients.values())for(const client of set)try{client.end();}catch{};server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),10_000).unref?.();};
  process.once('SIGTERM',()=>shutdown('SIGTERM')); process.once('SIGINT',()=>shutdown('SIGINT'));
}
export {server};
