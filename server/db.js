import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {config} from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), {recursive: true});
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT 'Kaduna',
  role TEXT NOT NULL DEFAULT 'marketplace_user' CHECK(role IN ('marketplace_user','merchant','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleted')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS identity_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('nin','bvn')),
  status TEXT NOT NULL CHECK(status IN ('pending','verified','failed','demo_verified')),
  provider TEXT NOT NULL,
  provider_reference TEXT NOT NULL,
  masked_identifier TEXT NOT NULL,
  last4 TEXT NOT NULL,
  name_match INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, type)
);

CREATE TABLE IF NOT EXISTS merchant_applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  category TEXT NOT NULL,
  business_address TEXT NOT NULL,
  registration_reference TEXT NOT NULL DEFAULT '',
  cac_status TEXT NOT NULL DEFAULT 'pending',
  identity_status TEXT NOT NULL DEFAULT 'pending',
  physical_inspection_status TEXT NOT NULL DEFAULT 'pending',
  category_docs_status TEXT NOT NULL DEFAULT 'pending',
  settlement_account_status TEXT NOT NULL DEFAULT 'pending',
  test_order_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','under_review','approved','rejected','suspended')),
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merchant_app_user ON merchant_applications(user_id);

CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL UNIQUE REFERENCES merchant_applications(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT 'Kaduna',
  verification_status TEXT NOT NULL DEFAULT 'verified',
  checkout_enabled INTEGER NOT NULL DEFAULT 0,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  sensitive_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merchants_user ON merchants(user_id);

CREATE TABLE IF NOT EXISTS merchant_products (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL CHECK(price >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merchant_products_merchant ON merchant_products(merchant_id);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  buyer_user_id TEXT NOT NULL REFERENCES users(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  status TEXT NOT NULL DEFAULT 'payment_pending',
  delivery_address TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL,
  service_fee INTEGER NOT NULL,
  commission INTEGER NOT NULL,
  customer_total INTEGER NOT NULL,
  merchant_settlement INTEGER NOT NULL,
  payment_reference TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
`);

export function nowIso(){ return new Date().toISOString(); }

try { db.exec('ALTER TABLE merchants ADD COLUMN delivery_fee INTEGER NOT NULL DEFAULT 0'); } catch {}
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

db.exec(`
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id TEXT PRIMARY KEY,
  seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  condition TEXT NOT NULL DEFAULT 'used',
  price INTEGER NOT NULL CHECK(price >= 0),
  city TEXT NOT NULL DEFAULT 'Kaduna',
  area TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','sold','removed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_city_status ON marketplace_listings(city,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller ON marketplace_listings(seller_user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS saved_listings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id, listing_id)
);

CREATE TABLE IF NOT EXISTS wanted_requests (
  id TEXT PRIMARY KEY,
  requester_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Other',
  budget INTEGER NOT NULL CHECK(budget >= 0),
  city TEXT NOT NULL DEFAULT 'Kaduna',
  area TEXT NOT NULL DEFAULT '',
  urgency TEXT NOT NULL DEFAULT 'This week',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','fulfilled','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wanted_requests_city_status ON wanted_requests(city,status,created_at DESC);

CREATE TABLE IF NOT EXISTS wanted_responses (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES wanted_requests(id) ON DELETE CASCADE,
  responder_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL DEFAULT '',
  listing_id TEXT REFERENCES marketplace_listings(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(request_id,responder_user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(listing_id,buyer_user_id,seller_user_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_buyer ON conversations(buyer_user_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_seller ON conversations(seller_user_id,updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id,created_at);

CREATE TABLE IF NOT EXISTS meetup_locations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT 'Kaduna',
  area TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'Public place',
  status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('approved','disabled')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meetups (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  buyer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL REFERENCES meetup_locations(id),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','completed','cancelled')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetups_participants ON meetups(buyer_user_id,seller_user_id,scheduled_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id TEXT PRIMARY KEY,
  meetup_id TEXT NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  reviewer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(meetup_id,reviewer_user_id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_reviews_reviewee ON marketplace_reviews(reviewee_user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_path TEXT NOT NULL UNIQUE,
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','deleted')),
  claimed_listing_id TEXT REFERENCES marketplace_listings(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_marketplace_uploads_user ON marketplace_uploads(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  href TEXT NOT NULL DEFAULT '',
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id,read_at,created_at DESC);

`);

const seedMeetupLocation = db.prepare('INSERT OR IGNORE INTO meetup_locations(id,name,city,area,kind,status,created_at) VALUES(?,?,?,?,?,?,?)');
for (const location of [
  ['loc_kaduna_central_market','Kaduna Central Market','Kaduna','Kaduna North','Market'],
  ['loc_kaduna_mall','Kaduna Shopping Mall','Kaduna','Kaduna North','Mall'],
  ['loc_murtala_square','Murtala Mohammed Square','Kaduna','Kaduna North','Public square'],
  ['loc_kawo_total','Total Filling Station (Kawo)','Kaduna','Kawo','Fuel station'],
  ['loc_police_gate','Kaduna State Police Command (Outside Gate)','Kaduna','Kaduna North','Police-adjacent public area']
]) seedMeetupLocation.run(location[0],location[1],location[2],location[3],location[4],'approved',nowIso());

// Transaction-safety extensions. These ALTERs are intentionally idempotent for existing dev databases.
try { db.exec("ALTER TABLE orders ADD COLUMN address_revealed_at TEXT"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN address_reveal_count INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN delivery_pin_hash TEXT"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN delivery_pin_last2 TEXT"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN delivery_pin_created_at TEXT"); } catch {}
try { db.exec("ALTER TABLE orders ADD COLUMN delivered_at TEXT"); } catch {}
try { db.exec("ALTER TABLE merchants ADD COLUMN suspension_reason TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE merchants ADD COLUMN suspended_at TEXT"); } catch {}

db.exec(`
CREATE TABLE IF NOT EXISTS order_address_access (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  merchant_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  accessed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_address_access_order ON order_address_access(order_id,accessed_at DESC);

CREATE TABLE IF NOT EXISTS order_cases (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  case_type TEXT NOT NULL CHECK(case_type IN ('refund_request','merchant_cancellation','dispute','address_misuse')),
  opened_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','under_review','resolved','rejected')),
  previous_order_status TEXT NOT NULL DEFAULT '',
  resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_cases_order ON order_cases(order_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_cases_status ON order_cases(status,created_at DESC);
`);
