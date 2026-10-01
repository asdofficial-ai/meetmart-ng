import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'meetmart-api-'));
process.env.NODE_ENV='test';
process.env.MEETMART_DB_PATH=path.join(tmp,'test.sqlite');
process.env.MEETMART_UPLOAD_DIR=path.join(tmp,'uploads');
process.env.ALLOWED_ORIGINS='http://localhost:5173';
const {server}=await import('../index.js');
const {db}=await import('../db.js');
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const origin='http://localhost:5173';
let cookie='';
const call=async(pathname,opts={})=>{
  const res=await fetch(`http://127.0.0.1:${port}${pathname}`,{...opts,headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{}),...(opts.headers||{})}});
  const setCookie=res.headers.get('set-cookie'); if(setCookie) cookie=setCookie.split(';')[0];
  const body=await res.json(); return {res,body};
};

try{
  let r=await call('/health'); assert.equal(r.res.status,200); assert.equal(r.body.ok,true);
  r=await call('/commerce/config'); assert.equal(r.res.status,200); assert.equal(r.body.currency,'NGN'); assert.equal(r.body.commissionRate,0.05); assert.equal(r.body.customerServiceFee,300);
  r=await call('/auth/signup',{method:'POST',body:JSON.stringify({email:'test@example.com',password:'StrongPass1',displayName:'Test User'})}); assert.equal(r.res.status,201); assert.ok(cookie);
  const userId=r.body.user.id;
  r=await call('/auth/me'); assert.equal(r.body.user.email,'test@example.com');

  // Ordinary accounts cannot run BVN just by asking for it.
  r=await call('/identity/eligibility'); assert.equal(r.res.status,200); assert.equal(r.body.bvnEligible,false); assert.equal(r.body.reason,'ordinary_marketplace_account');
  r=await call('/identity/verifications',{method:'POST',body:JSON.stringify({type:'bvn',identifier:'10987654321',fullName:'Test User',consent:true,accountRole:'merchant'})});
  assert.equal(r.res.status,400); assert.equal(JSON.stringify(r.body).includes('10987654321'),false);

  r=await call('/identity/verifications',{method:'POST',body:JSON.stringify({type:'nin',identifier:'12345678901',fullName:'Test User',consent:true})});
  assert.equal(r.res.status,200); assert.equal(r.body.verification.maskedIdentifier,'*******8901'); assert.equal(JSON.stringify(r.body).includes('12345678901'),false);

  r=await call('/merchant-applications',{method:'POST',body:JSON.stringify({businessName:'Test Store',category:'Electronics',businessAddress:'12 Test Road, Kaduna',registrationReference:'CAC-TEST'})});
  assert.equal(r.res.status,201); const appId=r.body.application.id;
  r=await call('/merchant-applications/me'); assert.equal(r.body.applications.length,1); assert.equal(r.body.applications[0].identity_status,'demo_verified');
  r=await call('/identity/eligibility'); assert.equal(r.res.status,200); assert.equal(r.body.bvnEligible,true); assert.equal(r.body.reason,'merchant_application'); assert.equal(r.body.merchantApplication.id,appId);

  // Duplicate active applications are blocked instead of creating parallel KYC records.
  r=await call('/merchant-applications',{method:'POST',body:JSON.stringify({businessName:'Duplicate Store',category:'Food',businessAddress:'13 Test Road, Kaduna'})});
  assert.equal(r.res.status,409);

  // After a real merchant application exists, BVN can be checked; raw BVN is not returned or stored.
  r=await call('/identity/verifications',{method:'POST',body:JSON.stringify({type:'bvn',identifier:'10987654321',fullName:'Test User',consent:true})});
  assert.equal(r.res.status,200); assert.equal(r.body.verification.maskedIdentifier,'*******4321'); assert.equal(JSON.stringify(r.body).includes('10987654321'),false);
  const bvnRow=db.prepare("SELECT * FROM identity_verifications WHERE user_id=? AND type='bvn'").get(userId);
  assert.ok(bvnRow); assert.equal(JSON.stringify(bvnRow).includes('10987654321'),false);

  // Production approval must not accept a demo identity. Promote only inside this isolated test to exercise later gates.
  db.prepare("UPDATE merchant_applications SET identity_status='verified' WHERE id=?").run(appId);
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(userId);
  r=await call(`/admin/merchant-applications/${appId}/review`,{method:'POST',body:JSON.stringify({cac_status:'passed',physical_inspection_status:'passed',category_docs_status:'passed',settlement_account_status:'passed',test_order_status:'passed',decision:'approve'})});
  assert.equal(r.res.status,200); assert.equal(r.body.application.status,'approved');

  r=await call('/merchant/products',{method:'POST',body:JSON.stringify({name:'Server Priced Item',description:'Test',price:10000})});
  assert.equal(r.res.status,201); const productId=r.body.product.id;
  r=await call('/merchant/settings',{method:'PATCH',body:JSON.stringify({deliveryFee:1500})}); assert.equal(r.res.status,200);
  r=await call('/merchant/me'); assert.equal(r.res.status,200); assert.equal(r.body.merchant.deliveryFee,1500); assert.equal(r.body.merchant.products.length,1); assert.equal(r.body.merchant.products[0].price,10000);
  r=await call('/merchants'); assert.equal(r.res.status,200); assert.equal(r.body.merchants.length,1); const merchantId=r.body.merchants[0].id; assert.equal(r.body.merchants[0].checkoutEnabled,true);
  r=await call(`/merchants/${merchantId}`); assert.equal(r.res.status,200); assert.equal(r.body.merchant.products.length,1); assert.equal(r.body.merchant.products[0].price,10000);

  // Browser-supplied fake price is ignored. Server product price (₦10,000) is authoritative.
  r=await call('/checkout/create',{method:'POST',body:JSON.stringify({merchantId,deliveryAddress:'Kaduna North, Kaduna',items:[{productId,quantity:2,price:1,unitPrice:1}],deliveryFee:1})});
  assert.equal(r.res.status,201); assert.equal(r.body.order.subtotal,20000); assert.equal(r.body.order.deliveryFee,1500); assert.equal(r.body.order.commission,1000); assert.equal(r.body.order.customerTotal,21800); assert.equal(r.body.order.merchantSettlement,20500);
  const orderId=r.body.order.id;

  // Demo payment confirmation is backend-owned and creates a proof-of-delivery PIN.
  r=await call(`/checkout/${orderId}/demo-confirm`,{method:'POST',body:'{}'}); assert.equal(r.res.status,200); assert.equal(r.body.order.status,'paid'); assert.ok(r.body.order.paidAt);
  const deliveryPin=r.body.order.deliveryPin; assert.match(deliveryPin,/^\d{6}$/);
  r=await call(`/checkout/${orderId}/demo-confirm`,{method:'POST',body:'{}'}); assert.equal(r.res.status,409);
  r=await call('/orders/me'); assert.equal(r.res.status,200); assert.equal(r.body.orders.length,1); assert.equal(r.body.orders[0].items[0].unitPrice,10000); assert.equal(r.body.orders[0].status,'paid'); assert.equal(r.body.orders[0].deliveryPinLast2,deliveryPin.slice(-2));
  const storedOrder=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId); assert.equal(JSON.stringify(storedOrder).includes(deliveryPin),false); assert.equal(String(storedOrder.delivery_address).startsWith('enc:v1:'),true); assert.equal(String(storedOrder.delivery_address).includes('Kaduna North, Kaduna'),false);

  // Merchant queue never leaks the address. Reveal requires correct password, is one-time and audited.
  r=await call('/merchant/orders'); assert.equal(r.res.status,200); assert.equal(r.body.orders.length,1); assert.equal(r.body.orders[0].deliveryAddress,undefined); assert.equal(r.body.orders[0].deliveryAddressMasked,'Protected delivery address');
  r=await call(`/merchant/orders/${orderId}/status`,{method:'PATCH',body:JSON.stringify({status:'out_for_delivery'})}); assert.equal(r.res.status,409);
  r=await call(`/merchant/orders/${orderId}/status`,{method:'PATCH',body:JSON.stringify({status:'preparing'})}); assert.equal(r.res.status,200); assert.equal(r.body.order.status,'preparing');
  r=await call(`/merchant/orders/${orderId}/reveal-address`,{method:'POST',body:JSON.stringify({password:'wrong-password'})}); assert.equal(r.res.status,403);
  r=await call(`/merchant/orders/${orderId}/reveal-address`,{method:'POST',body:JSON.stringify({password:'StrongPass1'})}); assert.equal(r.res.status,200); assert.equal(r.body.deliveryAddress,'Kaduna North, Kaduna'); assert.ok(r.body.warning.includes('logged'));
  r=await call(`/merchant/orders/${orderId}/reveal-address`,{method:'POST',body:JSON.stringify({password:'StrongPass1'})}); assert.equal(r.res.status,409);
  r=await call('/admin/address-access'); assert.equal(r.res.status,200); assert.equal(r.body.access.length,1); assert.equal(r.body.access[0].orderId,orderId);
  r=await call(`/merchant/orders/${orderId}/status`,{method:'PATCH',body:JSON.stringify({status:'out_for_delivery'})}); assert.equal(r.res.status,200);
  r=await call(`/merchant/orders/${orderId}/status`,{method:'PATCH',body:JSON.stringify({status:'delivered'})}); assert.equal(r.res.status,409);
  r=await call(`/merchant/orders/${orderId}/complete-delivery`,{method:'POST',body:JSON.stringify({pin:'000000'})}); assert.equal(r.res.status,403);
  r=await call(`/orders/${orderId}/disputes`,{method:'POST',body:JSON.stringify({reason:'Delivery has an issue that needs MeetMart review before completion.'})}); assert.equal(r.res.status,201); const deliveryDisputeId=r.body.case.id;
  r=await call(`/merchant/orders/${orderId}/complete-delivery`,{method:'POST',body:JSON.stringify({pin:deliveryPin})}); assert.equal(r.res.status,409);
  r=await call(`/admin/order-cases/${deliveryDisputeId}/review`,{method:'POST',body:JSON.stringify({decision:'resolve',note:'Delivery issue cleared after review.'})}); assert.equal(r.res.status,200);
  r=await call(`/merchant/orders/${orderId}/complete-delivery`,{method:'POST',body:JSON.stringify({pin:deliveryPin})}); assert.equal(r.res.status,200); assert.equal(r.body.order.status,'delivered');

  // Disputes are persistent admin cases; privacy misuse reports do not expose the address in case data.
  r=await call(`/orders/${orderId}/disputes`,{method:'POST',body:JSON.stringify({type:'address_misuse',reason:'Merchant contacted me after delivery without permission.'})}); assert.equal(r.res.status,201); const privacyCaseId=r.body.case.id;
  r=await call('/admin/order-cases'); assert.equal(r.res.status,200); assert.ok(r.body.cases.some(c=>c.id===privacyCaseId&&c.type==='address_misuse')); assert.equal(JSON.stringify(r.body).includes('Kaduna North, Kaduna'),false);
  r=await call(`/admin/order-cases/${privacyCaseId}/review`,{method:'POST',body:JSON.stringify({decision:'resolve',note:'Privacy report recorded for investigation.'})}); assert.equal(r.res.status,200); assert.equal(r.body.case.status,'resolved');

  // Paid cancellations become refund cases instead of silently cancelling captured money.
  r=await call('/checkout/create',{method:'POST',body:JSON.stringify({merchantId,deliveryAddress:'Barnawa, Kaduna',items:[{productId,quantity:1}]})}); assert.equal(r.res.status,201); const refundOrderId=r.body.order.id;
  r=await call(`/checkout/${refundOrderId}/demo-confirm`,{method:'POST',body:'{}'}); assert.equal(r.res.status,200);
  r=await call(`/orders/${refundOrderId}/refund-request`,{method:'POST',body:JSON.stringify({reason:'I ordered the wrong item and need a refund.'})}); assert.equal(r.res.status,202); assert.equal(r.body.order.status,'refund_pending'); const refundCaseId=r.body.case.id;
  r=await call(`/admin/order-cases/${refundCaseId}/review`,{method:'POST',body:JSON.stringify({decision:'approve_refund',note:'Approved in demo provider.'})}); assert.equal(r.res.status,200); assert.equal(r.body.order.status,'refunded');

  // Admin kill switch removes a suspicious store from checkout immediately, then can restore it after review.
  r=await call('/admin/merchants'); assert.equal(r.res.status,200); assert.equal(r.body.merchants.length,1);
  r=await call(`/admin/merchants/${merchantId}/status`,{method:'PATCH',body:JSON.stringify({status:'suspended',reason:'Test suspension for transaction safety.'})}); assert.equal(r.res.status,200); assert.equal(r.body.merchant.checkoutEnabled,false);
  r=await call('/merchants'); assert.equal(r.res.status,200); assert.equal(r.body.merchants.length,0);
  r=await call('/checkout/create',{method:'POST',body:JSON.stringify({merchantId,deliveryAddress:'Kaduna South, Kaduna',items:[{productId,quantity:1}]})}); assert.equal(r.res.status,400);
  r=await call(`/admin/merchants/${merchantId}/status`,{method:'PATCH',body:JSON.stringify({status:'verified'})}); assert.equal(r.res.status,200); assert.equal(r.body.merchant.checkoutEnabled,true);

  // Person-to-person marketplace image upload is real server storage, not a browser-only preview.
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  r=await call('/marketplace/uploads/image',{method:'POST',headers:{'content-type':'image/png'},body:png});
  assert.equal(r.res.status,201); assert.equal(r.body.upload.mimeType,'image/png'); const uploadId=r.body.upload.id;
  const uploadedImage=await fetch(r.body.upload.url); assert.equal(uploadedImage.status,200); assert.equal(uploadedImage.headers.get('content-type'),'image/png');
  r=await call('/marketplace/listings',{method:'POST',body:JSON.stringify({title:'Marketplace Test Phone',description:'Clean test phone',category:'Phones',condition:'Used - Like New',price:250000,area:'Kaduna North',imageUploadId:uploadId})});
  assert.equal(r.res.status,201); assert.ok(r.body.listing.imageUrl.includes('/uploads/marketplace/')); const listingId=r.body.listing.id; const sellerCookie=cookie;
  const uploadRow=db.prepare('SELECT status,claimed_listing_id FROM marketplace_uploads WHERE id=?').get(uploadId); assert.equal(uploadRow.status,'claimed'); assert.equal(uploadRow.claimed_listing_id,listingId);
  r=await call('/marketplace/listings/me'); assert.equal(r.res.status,200); assert.equal(r.body.listings.length,1);

  // Create a second real account to exercise buyer/seller boundaries.
  r=await call('/auth/signup',{method:'POST',body:JSON.stringify({email:'buyer@example.com',password:'StrongPass2',displayName:'Buyer User'})}); assert.equal(r.res.status,201); const buyerId=r.body.user.id; const buyerCookie=cookie;
  r=await call('/marketplace/listings?search=Marketplace%20Test'); assert.equal(r.res.status,200); assert.equal(r.body.listings.length,1); assert.equal(r.body.listings[0].id,listingId);
  r=await call('/marketplace/listings?city=Kano&search=Marketplace%20Test'); assert.equal(r.res.status,200); assert.equal(r.body.listings.length,1); assert.equal(r.body.listings[0].city,'Kaduna');
  r=await call(`/marketplace/listings/${listingId}/save`,{method:'POST',body:'{}'}); assert.equal(r.res.status,200); assert.equal(r.body.saved,true);
  r=await call('/marketplace/saved'); assert.equal(r.body.listings.length,1);
  r=await call('/conversations',{method:'POST',body:JSON.stringify({listingId})}); assert.equal(r.res.status,200); const conversationId=r.body.conversation.id;
  // Seller opens the authenticated realtime stream before the buyer sends a message.
  const liveAbort=new AbortController();
  const liveRes=await fetch(`http://127.0.0.1:${port}/events`,{headers:{origin,cookie:sellerCookie},signal:liveAbort.signal}); assert.equal(liveRes.status,200); assert.ok(String(liveRes.headers.get('content-type')).startsWith('text/event-stream'));
  const liveReader=liveRes.body.getReader(); const decoder=new TextDecoder(); let liveText=decoder.decode((await liveReader.read()).value||new Uint8Array()); assert.ok(liveText.includes('event: ready'));
  r=await call(`/conversations/${conversationId}/messages`,{method:'POST',body:JSON.stringify({body:'Is this still available?'})}); assert.equal(r.res.status,201);
  for(let i=0;i<4&&!liveText.includes('event: message.created');i++){const chunk=await Promise.race([liveReader.read(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Realtime event timeout')),1500))]);liveText+=decoder.decode(chunk.value||new Uint8Array());}
  assert.ok(liveText.includes('event: notification.created')); assert.ok(liveText.includes('event: message.created')); liveAbort.abort();
  r=await call(`/conversations/${conversationId}/messages`); assert.equal(r.res.status,200); assert.equal(r.body.messages.length,1);
  cookie=sellerCookie; r=await call('/notifications'); assert.equal(r.res.status,200); assert.ok(r.body.notifications.some(n=>n.type==='message'&&n.entityId===conversationId)); assert.ok(r.body.unreadCount>=1);
  const messageNotification=r.body.notifications.find(n=>n.type==='message'&&n.entityId===conversationId); r=await call(`/notifications/${messageNotification.id}/read`,{method:'PATCH',body:'{}'}); assert.equal(r.res.status,200);
  cookie=buyerCookie;
  r=await call('/wanted-requests',{method:'POST',body:JSON.stringify({title:'Need a laptop',details:'Core i5 or better',category:'Computers',budget:300000,area:'Kaduna North',urgency:'This week'})}); assert.equal(r.res.status,201); const wantedId=r.body.request.id;
  r=await call('/meetup-locations'); assert.equal(r.res.status,200); assert.ok(r.body.locations.length>0); const locationId=r.body.locations[0].id;
  const future=new Date(Date.now()+60*60*1000).toISOString();
  r=await call('/meetups',{method:'POST',body:JSON.stringify({conversationId,locationId,scheduledAt:future})}); assert.equal(r.res.status,201); const meetupId=r.body.meetup.id;
  r=await call('/meetups',{method:'POST',body:JSON.stringify({conversationId,locationId,scheduledAt:future})}); assert.equal(r.res.status,409);
  r=await call(`/meetups/${meetupId}/status`,{method:'PATCH',body:JSON.stringify({status:'confirmed'})}); assert.equal(r.res.status,403);

  // Seller can respond to the buyer's wanted request and confirm the proposed meetup.
  cookie=sellerCookie;
  r=await call(`/wanted-requests/${wantedId}/respond`,{method:'POST',body:JSON.stringify({message:'I may have a suitable laptop.',listingId:null})}); assert.equal(r.res.status,201);
  const wantedResponseId=r.body.response.id;
  r=await call(`/meetups/${meetupId}/status`,{method:'PATCH',body:JSON.stringify({status:'confirmed'})}); assert.equal(r.res.status,200); assert.equal(r.body.meetup.status,'confirmed');
  db.prepare('UPDATE meetups SET scheduled_at=? WHERE id=?').run(new Date(Date.now()-60*60*1000).toISOString(),meetupId);
  r=await call(`/meetups/${meetupId}/status`,{method:'PATCH',body:JSON.stringify({status:'completed'})}); assert.equal(r.res.status,200); assert.equal(r.body.meetup.status,'completed');

  // Buyer can inspect seller responses and review only after the meetup is completed.
  cookie=buyerCookie;
  r=await call(`/wanted-requests/${wantedId}/responses`); assert.equal(r.res.status,200); assert.equal(r.body.responses.length,1); assert.equal(r.body.responses[0].id,wantedResponseId); assert.equal(r.body.responses[0].responder.id,userId);
  r=await call('/notifications'); assert.equal(r.res.status,200); assert.ok(r.body.notifications.some(n=>n.type==='wanted_response'&&n.entityId===wantedId));
  r=await call('/marketplace/reviews',{method:'POST',body:JSON.stringify({meetupId,rating:5,body:'Item matched the listing and meetup was safe.'})}); assert.equal(r.res.status,201);
  r=await call(`/marketplace/users/${userId}/reviews`); assert.equal(r.res.status,200); assert.equal(r.body.summary.count,1); assert.equal(r.body.summary.average,5);
  r=await call('/meetups/me'); assert.equal(r.res.status,200); assert.equal(r.body.meetups.length,1); assert.equal(r.body.meetups[0].status,'completed');
  assert.equal(r.body.meetups[0].buyer.id,buyerId);


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

  r=await call('/auth/logout',{method:'POST',body:'{}'}); assert.equal(r.res.status,200);
  console.log('MeetMart API smoke test passed');
} finally { await new Promise(resolve=>server.close(resolve)); fs.rmSync(tmp,{recursive:true,force:true}); }
