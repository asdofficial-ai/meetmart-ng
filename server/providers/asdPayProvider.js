import crypto from 'node:crypto';
import {config} from '../config.js';

export function calculateSettlement({subtotal, deliveryFee = 0}) {
  const safeSubtotal = Math.round(Number(subtotal));
  const safeDelivery = Math.round(Number(deliveryFee));
  if (!Number.isFinite(safeSubtotal) || safeSubtotal < 0) throw new Error('Invalid subtotal.');
  if (!Number.isFinite(safeDelivery) || safeDelivery < 0) throw new Error('Invalid delivery fee.');
  const commission = Math.round(safeSubtotal * config.meetMartCommissionRate);
  const serviceFee = Math.round(config.customerServiceFee);
  return {
    subtotal: safeSubtotal,
    deliveryFee: safeDelivery,
    serviceFee,
    commission,
    customerTotal: safeSubtotal + safeDelivery + serviceFee,
    merchantSettlement: safeSubtotal - commission + safeDelivery,
    meetMartGrossRevenue: commission + serviceFee,
  };
}

export async function createPaymentIntent({orderId, amount}) {
  if (config.asdPayMode !== 'demo') {
    throw new Error('ASD Pay production provider is not configured yet.');
  }
  return {
    paymentReference: `ASDP-${crypto.randomUUID()}`,
    provider: 'demo-asdpay-adapter',
    amount,
    orderId,
    status: 'pending',
  };
}


export async function confirmDemoPaymentIntent({paymentReference, amount}) {
  if (config.asdPayMode !== 'demo') {
    throw new Error('Demo payment confirmation is disabled outside ASD Pay demo mode.');
  }
  if (!String(paymentReference || '').startsWith('ASDP-')) throw new Error('Invalid ASD Pay payment reference.');
  const safeAmount = Math.round(Number(amount));
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) throw new Error('Invalid payment amount.');
  return {
    paymentReference,
    amount: safeAmount,
    provider: 'demo-asdpay-adapter',
    status: 'paid',
    paidAt: new Date().toISOString(),
  };
}


export async function processRefund({paymentReference, amount, orderId}) {
  if (config.asdPayMode !== 'demo') {
    throw new Error('ASD Pay production refund provider is not configured yet.');
  }
  if (!String(paymentReference || '').startsWith('ASDP-')) throw new Error('Invalid ASD Pay payment reference.');
  const safeAmount = Math.round(Number(amount));
  if (!Number.isFinite(safeAmount) || safeAmount <= 0) throw new Error('Invalid refund amount.');
  return {
    paymentReference,
    amount: safeAmount,
    orderId,
    provider: 'demo-asdpay-adapter',
    status: 'refunded',
    refundedAt: new Date().toISOString(),
  };
}
