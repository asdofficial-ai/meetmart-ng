import crypto from 'node:crypto';
import {config} from '../config.js';

const digitsOnly = value => String(value || '').replace(/\D/g, '');

export async function verifyIdentity({type, identifier, fullName, consent, accountRole}) {
  if (!consent) throw new Error('Explicit consent is required.');
  if (!['nin','bvn'].includes(type)) throw new Error('Unsupported identity type.');
  if (!String(fullName || '').trim()) throw new Error('Full legal name is required.');
  if (type === 'bvn' && accountRole === 'marketplace_user') throw new Error('BVN is not required for an ordinary marketplace account.');
  const digits = digitsOnly(identifier);
  if (digits.length !== 11) throw new Error(`${type.toUpperCase()} must contain exactly 11 digits.`);

  // IMPORTANT: raw identifier is used only in memory in this adapter and is never returned or persisted.
  if (config.identityMode !== 'demo') {
    throw new Error('Official identity provider is not configured yet. Set provider credentials before enabling production verification.');
  }

  return {
    type,
    status: 'demo_verified',
    provider: 'demo-identity-adapter',
    providerReference: `${type.toUpperCase()}-${crypto.randomUUID()}`,
    maskedIdentifier: `*******${digits.slice(-4)}`,
    last4: digits.slice(-4),
    nameMatch: true,
    verifiedAt: new Date().toISOString(),
  };
}
