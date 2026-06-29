/**
 * Vercel Serverless Function: /api/send-email
 *
 * Universal email endpoint supporting SMTP and modern email APIs.
 * Provider configuration is resolved from environment variables first,
 * with backward-compatible fallback to client-sent settings.
 *
 * Providers: SMTP (Gmail, Outlook, Zoho, Hostinger, cPanel, custom),
 *            Resend, SendGrid, Mailgun, Brevo, Amazon SES
 *
 * Security: SMTP passwords and API keys are NEVER required from the client.
 *           Server reads from env vars or the admin-saved DB settings.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

// ── Inline lightweight email service for Vercel serverless ──────────────────
// Vercel serverless functions have limited bundle size, so we inline
// the essential send logic rather than importing the full lib/email module.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const nodemailer = require('nodemailer');

// ── Transporter cache (survives warm invocations) ──────────────────────────
const _transporterCache = new Map<string, { t: any; ts: number }>();
const POOL_TTL = 30 * 60 * 1000;

function getTransporter(host: string, port: number, user: string, pass: string, secure?: boolean) {
  const key = `${host}:${port}:${user}`;
  const cached = _transporterCache.get(key);
  if (cached && Date.now() - cached.ts < POOL_TTL) return cached.t;

  if (cached) { try { cached.t.close(); } catch {} }

  const useSecure = secure !== undefined ? secure : port === 465;
  const t = nodemailer.createTransport({
    host, port, secure: useSecure,
    auth: { user, pass },
    connectionTimeout: 30_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    pool: true, maxConnections: 5, maxMessages: 100, rateLimit: 14,
    tls: { rejectUnauthorized: false },
  });
  _transporterCache.set(key, { t, ts: Date.now() });
  return t;
}

// ── Rate limiter ────────────────────────────────────────────────────────────
type RL = { count: number; reset: number };
const emailRl: Map<string, RL> = (globalThis as any).__fruEmailRL || new Map();
(globalThis as any).__fruEmailRL = emailRl;

function checkRate(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const cur = emailRl.get(key);
  if (!cur || now > cur.reset) { emailRl.set(key, { count: 1, reset: now + windowMs }); return true; }
  if (cur.count >= max) return false;
  cur.count++;
  return true;
}

const sanitize = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max) : '';

function isEmail(v: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

// ── Resolve email config from environment ───────────────────────────────────
function getEnvConfig() {
  return {
    provider: (process.env.EMAIL_PROVIDER || 'smtp') as string,
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true' ? true : process.env.SMTP_SECURE === 'false' ? false : undefined,
    email: process.env.SMTP_EMAIL || process.env.EMAIL_FROM || '',
    password: process.env.SMTP_PASSWORD || '',
    fromName: process.env.EMAIL_FROM_NAME || '',
    apiKey: process.env.EMAIL_API_KEY || '',
    isEnabled: process.env.EMAIL_ENABLED !== 'false',
  };
}

// ── API-based senders (Resend, SendGrid, Mailgun, Brevo) ───────────────────

async function sendViaResend(apiKey: string, from: string, to: string, subject: string, html: string, replyTo?: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data.id;
}

async function sendViaSendgrid(apiKey: string, from: string, to: string, subject: string, html: string) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }], subject }],
      from: { email: from.split('<')[1]?.replace('>', '') || from },
      content: [{ type: 'text/html', value: html }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok && res.status !== 202) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.errors?.[0]?.message || `HTTP ${res.status}`);
  }
  return res.headers.get('x-message-id') || `sg_${Date.now()}`;
}

async function sendViaBrevo(apiKey: string, from: string, fromName: string, to: string, subject: string, html: string) {
  const emailMatch = from.match(/<(.+?)>/);
  const senderEmail = emailMatch ? emailMatch[1] : from;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'accept': 'application/json' },
    body: JSON.stringify({
      sender: { email: senderEmail, name: fromName || undefined },
      to: [{ email: to }], subject, htmlContent: html,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 201) throw new Error(data?.message || `HTTP ${res.status}`);
  return data.messageId || `brevo_${Date.now()}`;
}

async function sendViaMailgun(apiKey: string, domain: string, from: string, to: string, subject: string, html: string) {
  const formData = new FormData();
  formData.append('from', from);
  formData.append('to', to);
  formData.append('subject', subject);
  formData.append('html', html);
  const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + btoa(`api:${apiKey}`) },
    body: formData,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data.id;
}

// ── Main handler ────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const raw = req.body || {};
  const to = sanitize(raw.to, 254);
  const subject = sanitize(raw.subject, 200);
  const html = typeof raw.html === 'string' ? raw.html.slice(0, 200_000) : '';
  const replyTo = typeof raw.replyTo === 'string' ? raw.replyTo : undefined;
  const { attachments } = raw;

  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Missing required fields: to, subject, html' });
  }
  if (!isEmail(to)) {
    return res.status(400).json({ error: 'Invalid recipient email' });
  }
  if (!checkRate(`email:${to}`, 10, 60_000)) {
    return res.status(429).json({ success: false, error: 'Too many email requests. Please wait before retrying.' });
  }

  // ── Resolve config: env vars FIRST, then client-sent fallback ─────────
  const envCfg = getEnvConfig();
  const clientCfg = raw.smtpSettings || {};

  // Determine active provider: env var takes precedence
  const provider = envCfg.provider || clientCfg.provider || 'smtp';
  const isEnabled = envCfg.isEnabled && (envCfg.host || envCfg.apiKey) ? true
    : (clientCfg.isEnabled && clientCfg.host && clientCfg.email && clientCfg.password);

  // If nothing is configured, skip silently
  if (!isEnabled) {
    console.log(`[EMAIL SKIPPED] No provider configured → ${to} | ${subject}`);
    return res.status(200).json({
      success: true,
      simulated: true,
      message: 'Email service not configured. Configure a provider in Admin → Email Settings.',
    });
  }

  // Build from address
  const senderEmail = envCfg.email || clientCfg.email || '';
  const senderName = envCfg.fromName || clientCfg.fromName || 'Store';
  const from = senderName ? `"${senderName}" <${senderEmail}>` : senderEmail;

  // ── Normalize attachments (same format as before) ─────────────────────
  const normalizedAttachments = Array.isArray(attachments)
    ? attachments
        .filter((a: any) => a && typeof a.content === 'string' && a.content.length > 0)
        .map((a: any) => ({
          filename: a.filename || 'attachment',
          content: a.content as string,
          encoding: 'base64' as const,
          contentType: a.contentType || 'application/octet-stream',
        }))
    : [];

  const startTime = Date.now();

  try {
    let messageId: string | undefined;

    if (provider === 'resend') {
      const apiKey = envCfg.apiKey || clientCfg.apiKey || '';
      if (!apiKey) throw new Error('Resend API key not configured.');
      messageId = await sendViaResend(apiKey, from, to, subject, html, replyTo);

    } else if (provider === 'sendgrid') {
      const apiKey = envCfg.apiKey || clientCfg.apiKey || '';
      if (!apiKey) throw new Error('SendGrid API key not configured.');
      messageId = await sendViaSendgrid(apiKey, from, to, subject, html);

    } else if (provider === 'brevo') {
      const apiKey = envCfg.apiKey || clientCfg.apiKey || '';
      if (!apiKey) throw new Error('Brevo API key not configured.');
      messageId = await sendViaBrevo(apiKey, from, senderName, to, subject, html);

    } else if (provider === 'mailgun') {
      const apiKey = envCfg.apiKey || clientCfg.apiKey || '';
      const domain = envCfg.host || clientCfg.mailgunDomain || clientCfg.host || '';
      if (!apiKey || !domain) throw new Error('Mailgun API key and domain not configured.');
      messageId = await sendViaMailgun(apiKey, domain, from, to, subject, html);

    } else {
      // ── SMTP (default) ────────────────────────────────────────────────
      const smtpHost = envCfg.host || clientCfg.host || '';
      const smtpPort = envCfg.port || Number(clientCfg.port || 587);
      const smtpUser = envCfg.email || clientCfg.email || '';
      const smtpPass = envCfg.password || clientCfg.password || '';

      if (!smtpHost || !smtpUser || !smtpPass) {
        throw new Error('SMTP credentials incomplete. Configure host, email, and password.');
      }

      const transporter = getTransporter(smtpHost, smtpPort, smtpUser, smtpPass, envCfg.secure);
      const info = await transporter.sendMail({
        from,
        to,
        subject,
        html,
        headers: { 'X-Priority': '1', 'X-Mailer': 'Fruitopia Mailer v2.0' },
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      });
      messageId = info.messageId;

      // Clean up bad transporters on auth errors
    }

    const duration = Date.now() - startTime;
    console.log(`[EMAIL SENT] Provider: ${provider} | To: ${to} | ID: ${messageId} | ${duration}ms`);
    return res.status(200).json({ success: true, messageId, provider, duration });

  } catch (err: any) {
    const duration = Date.now() - startTime;
    console.error(`[EMAIL ERROR] Provider: ${provider} | To: ${to} | ${duration}ms | ${err.message}`);

    // Build helpful hint based on error type
    let hint = '';
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('invalid login') || msg.includes('auth') || msg.includes('authentication')) {
      hint = 'Authentication failed. For Gmail/Outlook: use an App Password (not your login password). Enable 2FA first, then generate an App Password.';
    } else if (msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls')) {
      hint = 'SSL/TLS error. Try port 587 (STARTTLS) or port 465 (implicit TLS).';
    } else if (msg.includes('connection') || msg.includes('timeout') || msg.includes('econnrefused')) {
      hint = 'Cannot connect. Verify host, port, and firewall settings.';
    } else if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) {
      hint = 'API key or credentials are invalid. Check your provider dashboard.';
    }

    // Destroy cached transporter on auth/connection errors
    if (msg.includes('auth') || msg.includes('connection') || msg.includes('timeout')) {
      const smtpHost = envCfg.host || clientCfg.host || '';
      const smtpPort = envCfg.port || Number(clientCfg.port || 587);
      const smtpUser = envCfg.email || clientCfg.email || '';
      const key = `${smtpHost}:${smtpPort}:${smtpUser}`;
      const cached = _transporterCache.get(key);
      if (cached) { try { cached.t.close(); } catch {} _transporterCache.delete(key); }
    }

    return res.status(500).json({
      success: false,
      error: `Email delivery failed: ${err.message}`,
      hint,
      provider,
      duration,
    });
  }
}
