import {getSelectedCity, setSelectedCity} from '../location.js';

const API_BASE = String(import.meta.env.VITE_API_BASE_URL || (import.meta.env.PROD ? '' : 'http://localhost:8787')).replace(/\/$/, '');

function syncUserCity(payload){
  const city=payload?.user?.city;
  if(city) setSelectedCity(city);
  return payload;
}

async function request(path, {method='GET', body, headers={}} = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: {'content-type':'application/json', ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('MeetMart server is temporarily unreachable. Please retry.');
  }
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

async function uploadImage(file) {
  if (!file) throw new Error('Choose an image first.');
  let response;
  try {
    response = await fetch(`${API_BASE}/marketplace/uploads/image`, {
      method: 'POST',
      credentials: 'include',
      headers: {'content-type': file.type || 'application/octet-stream'},
      body: file,
    });
  } catch {
    throw new Error('MeetMart server is temporarily unreachable. Please retry.');
  }
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload.error || `Upload failed (${response.status}).`);
  return payload;
}

function subscribeEvents(onEvent, onError) {
  if (typeof EventSource === 'undefined') return () => {};
  const source = new EventSource(`${API_BASE}/events`, {withCredentials: true});
  const eventTypes = ['notification.created','message.created'];
  const listeners = eventTypes.map(type => {
    const fn = event => { try { onEvent?.(type, JSON.parse(event.data)); } catch {} };
    source.addEventListener(type, fn);
    return [type, fn];
  });
  source.onerror = error => onError?.(error);
  return () => { for (const [type,fn] of listeners) source.removeEventListener(type,fn); source.close(); };
}

export const api = {
  baseUrl: API_BASE,
  health: () => request('/health'),
  getCommerceConfig: () => request('/commerce/config'),
  me: async () => syncUserCity(await request('/auth/me')),
  signup: async data => syncUserCity(await request('/auth/signup',{method:'POST',body:{...data,city:data?.city||getSelectedCity()}})),
  login: async data => syncUserCity(await request('/auth/login',{method:'POST',body:data})),
  logout: () => request('/auth/logout',{method:'POST',body:{}}),
  logoutAll: () => request('/auth/logout-all',{method:'POST',body:{}}),
  requestEmailVerification: () => request('/auth/email-verification/request',{method:'POST',body:{}}),
  confirmEmailVerification: code => request('/auth/email-verification/confirm',{method:'POST',body:{code}}),
  forgotPassword: email => request('/auth/password/forgot',{method:'POST',body:{email}}),
  resetPassword: data => request('/auth/password/reset',{method:'POST',body:data}),
  getAccountSecurity: () => request('/account/security'),
  updateProfile: data => request('/account/profile',{method:'PATCH',body:data}),
  changePassword: data => request('/account/password',{method:'POST',body:data}),
  getIdentityVerifications: () => request('/identity/verifications'),
  getIdentityEligibility: () => request('/identity/eligibility'),
  verifyIdentity: data => request('/identity/verifications',{method:'POST',body:data}),
  submitMerchantApplication: data => request('/merchant-applications',{method:'POST',body:data}),
  getMyMerchantApplications: () => request('/merchant-applications/me'),
  getMerchants: () => request('/merchants'),
  getMerchant: merchantId => request(`/merchants/${encodeURIComponent(merchantId)}`),
  getMerchantMe: () => request('/merchant/me'),
  createMerchantProduct: data => request('/merchant/products',{method:'POST',body:data}),
  updateMerchantSettings: data => request('/merchant/settings',{method:'PATCH',body:data}),
  getAdminMerchantApplications: () => request('/admin/merchant-applications'),
  reviewMerchantApplication: (applicationId,data) => request(`/admin/merchant-applications/${encodeURIComponent(applicationId)}/review`,{method:'POST',body:data}),
  createCheckout: data => request('/checkout/create',{method:'POST',body:data}),
  confirmDemoCheckout: orderId => request(`/checkout/${encodeURIComponent(orderId)}/demo-confirm`,{method:'POST',body:{}}),
  getMyOrders: () => request('/orders/me'),
  resetDeliveryPin: orderId => request(`/orders/${encodeURIComponent(orderId)}/delivery-pin/reset`,{method:'POST',body:{}}),
  cancelOrder: (orderId,reason='Customer requested cancellation after payment.') => request(`/orders/${encodeURIComponent(orderId)}/cancel`,{method:'POST',body:{reason}}),
  requestRefund: (orderId,reason) => request(`/orders/${encodeURIComponent(orderId)}/refund-request`,{method:'POST',body:{reason}}),
  openOrderDispute: (orderId,reason,type='dispute') => request(`/orders/${encodeURIComponent(orderId)}/disputes`,{method:'POST',body:{reason,type}}),
  getMerchantOrders: () => request('/merchant/orders'),
  updateMerchantOrderStatus: (orderId,status) => request(`/merchant/orders/${encodeURIComponent(orderId)}/status`,{method:'PATCH',body:{status}}),
  requestMerchantCancellation: (orderId,reason) => request(`/merchant/orders/${encodeURIComponent(orderId)}/cancel`,{method:'POST',body:{reason}}),
  revealMerchantOrderAddress: (orderId,password) => request(`/merchant/orders/${encodeURIComponent(orderId)}/reveal-address`,{method:'POST',body:{password}}),
  completeMerchantDelivery: (orderId,pin) => request(`/merchant/orders/${encodeURIComponent(orderId)}/complete-delivery`,{method:'POST',body:{pin}}),
  getAdminMerchants: () => request('/admin/merchants'),
  updateAdminMerchantStatus: (merchantId,data) => request(`/admin/merchants/${encodeURIComponent(merchantId)}/status`,{method:'PATCH',body:data}),
  getAdminOrderCases: () => request('/admin/order-cases'),
  reviewAdminOrderCase: (caseId,data) => request(`/admin/order-cases/${encodeURIComponent(caseId)}/review`,{method:'POST',body:data}),
  getAdminAddressAccess: () => request('/admin/address-access'),

  getMarketplaceListings: (params={}) => {
    const withCity={...params,city:params.city||getSelectedCity()};
    const qs=new URLSearchParams(Object.entries(withCity).filter(([,v])=>v!==undefined&&v!==null&&v!=='')).toString();
    return request(`/marketplace/listings${qs?`?${qs}`:''}`);
  },
  getMarketplaceListing: listingId => request(`/marketplace/listings/${encodeURIComponent(listingId)}`),
  getMyMarketplaceListings: () => request('/marketplace/listings/me'),
  uploadMarketplaceImage: file => uploadImage(file),
  createMarketplaceListing: data => request('/marketplace/listings',{method:'POST',body:data}),
  updateMarketplaceListingStatus: (listingId,status) => request(`/marketplace/listings/${encodeURIComponent(listingId)}`,{method:'PATCH',body:{status}}),
  saveMarketplaceListing: listingId => request(`/marketplace/listings/${encodeURIComponent(listingId)}/save`,{method:'POST',body:{}}),
  unsaveMarketplaceListing: listingId => request(`/marketplace/listings/${encodeURIComponent(listingId)}/save`,{method:'DELETE'}),
  getSavedMarketplaceListings: () => request('/marketplace/saved'),
  getWantedRequests: (params={}) => {
    const withCity={...params,city:params.city||getSelectedCity()};
    const qs=new URLSearchParams(Object.entries(withCity).filter(([,v])=>v!==undefined&&v!==null&&v!=='')).toString();
    return request(`/wanted-requests${qs?`?${qs}`:''}`);
  },
  createWantedRequest: data => request('/wanted-requests',{method:'POST',body:data}),
  respondWantedRequest: (requestId,data) => request(`/wanted-requests/${encodeURIComponent(requestId)}/respond`,{method:'POST',body:data}),
  getWantedResponses: requestId => request(`/wanted-requests/${encodeURIComponent(requestId)}/responses`),
  startConversation: listingId => request('/conversations',{method:'POST',body:{listingId}}),
  getConversations: () => request('/conversations'),
  getConversationMessages: conversationId => request(`/conversations/${encodeURIComponent(conversationId)}/messages`),
  sendConversationMessage: (conversationId,body) => request(`/conversations/${encodeURIComponent(conversationId)}/messages`,{method:'POST',body:{body}}),
  getMeetupLocations: (city=getSelectedCity()) => request(`/meetup-locations?city=${encodeURIComponent(city)}`),
  createMeetup: data => request('/meetups',{method:'POST',body:data}),
  getMyMeetups: () => request('/meetups/me'),
  updateMeetupStatus: (meetupId,status) => request(`/meetups/${encodeURIComponent(meetupId)}/status`,{method:'PATCH',body:{status}}),
  createMarketplaceReview: data => request('/marketplace/reviews',{method:'POST',body:data}),
  getMarketplaceUserReviews: userId => request(`/marketplace/users/${encodeURIComponent(userId)}/reviews`),
  getMarketplaceUserProfile: userId => request(`/marketplace/users/${encodeURIComponent(userId)}/profile`),
  getBlockedUsers: () => request('/marketplace/blocks'),
  blockMarketplaceUser: userId => request('/marketplace/blocks',{method:'POST',body:{userId}}),
  unblockMarketplaceUser: userId => request(`/marketplace/blocks/${encodeURIComponent(userId)}`,{method:'DELETE'}),
  reportMarketplace: data => request('/marketplace/reports',{method:'POST',body:data}),
  getAdminMarketplaceReports: () => request('/admin/marketplace-reports'),
  reviewAdminMarketplaceReport: (reportId,data) => request(`/admin/marketplace-reports/${encodeURIComponent(reportId)}`,{method:'PATCH',body:data}),
  getAdminMeetupLocations: (city='') => request(`/admin/meetup-locations${city?`?city=${encodeURIComponent(city)}`:''}`),
  createAdminMeetupLocation: data => request('/admin/meetup-locations',{method:'POST',body:data}),
  updateAdminMeetupLocation: (locationId,status) => request(`/admin/meetup-locations/${encodeURIComponent(locationId)}`,{method:'PATCH',body:{status}}),
  getNotifications: (limit=30) => request(`/notifications?limit=${encodeURIComponent(limit)}`),
  markNotificationRead: notificationId => request(`/notifications/${encodeURIComponent(notificationId)}/read`,{method:'PATCH',body:{}}),
  markAllNotificationsRead: () => request('/notifications/read-all',{method:'POST',body:{}}),
  subscribeEvents,
};
