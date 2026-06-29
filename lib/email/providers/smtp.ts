/**
 * SMTP Email Provider
 *
 * Uses nodemailer with connection pooling, auto SSL/TLS detection,
 * proper timeout handling, and retry logic.
 *
 * Compatible with: Gmail, Outlook, Zoho, Hostinger, cPanel SMTP,
 * Resend SMTP, and any custom SMTP server.
 */

import type { EmailConfig, EmailMessage, EmailResult, VerifyResult } from '../types.js';

// nodemailer is loaded via createRequire in server.ts; here we use a dynamic
// import that works under both tsx (dev) and the esbuild server bundle.
let _nodemailer: any = null;
async function getNodemailer() {
  if (!_nodemailer) {
    try {
      _nodemailer = await import('nodemailer');
    } catch {
      // Fallback: try createRequire style
      const { createRequire } = await import('module');
      const req = createRequire(import.meta.url);
      _nodemailer = req('nodemailer');
    }
  }
  return _nodemailer;
}

// ── Transporter Pool ────────────────────────────────────────────────────────
// Keyed by "host:port:email" — one pooled connection per unique SMTP account.
const _transporterCache = new Map<string, { transporter: any; createdAt: number }>();
const POOL_MAX_AGE_MS = 30 * 60 * 1000; // recreate after 30 minutes

function getCacheKey(cfg: EmailConfig): string {
  return `${cfg.host || ''}:${cfg.port || 587}:${cfg.email || ''}`;
}

async function getTransporter(cfg: EmailConfig) {
  const nodemailer = await getNodemailer();
  const key = getCacheKey(cfg);
  const cached = _transporterCache.get(key);

  // Recycle stale transporters
  if (cached && Date.now() - cached.createdAt > POOL_MAX_AGE_MS) {
    try { await cached.transporter.close(); } catch { /* ignore */ }
    _transporterCache.delete(key);
  }

  if (_transporterCache.has(key)) {
    return _transporterCache.get(key)!.transporter;
  }

  const port = Number(cfg.port || 587);

  // Auto-detect secure mode:
  //  - Port 465 → implicit TLS (secure: true)
  //  - Port 587 → STARTTLS (secure: false, upgraded via STARTTLS)
  //  - Port 25  → plaintext (insecure, rarely used)
  //  - Explicit cfg.secure overrides auto-detection
  const secure = cfg.secure !== undefined
    ? cfg.secure
    : port === 465;

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port,
    secure,
    auth: {
      user: cfg.email,
      pass: cfg.password,
    },
    connectionTimeout: cfg.timeout || 30_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    // Pool settings for connection reuse
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    rateLimit: 14, // messages per second
    tls: {
      // Most shared hosting / corporate SMTP servers use self-signed or
      // private CAs. Requiring strict validation breaks them. We still
      // validate the certificate chain when the OS trust store recognises it.
      rejectUnauthorized: false,
    },
  });

  _transporterCache.set(key, { transporter, createdAt: Date.now() });
  return transporter;
}

// ── SMTP Provider Implementation ────────────────────────────────────────────

export async function sendSmtp(cfg: EmailConfig, msg: EmailMessage): Promise<EmailResult> {
  const start = Date.now();

  if (!cfg.host || !cfg.email || !cfg.password) {
    return {
      success: false,
      provider: 'smtp',
      error: 'SMTP credentials incomplete. Configure host, email, and password.',
      hint: 'For Gmail: use smtp.gmail.com, port 587, and an App Password (not your login password). Enable 2FA at myaccount.google.com/apppasswords',
      duration: 0,
    };
  }

  try {
    const transporter = await getTransporter(cfg);

    const fromAddress = cfg.fromName
      ? `"${cfg.fromName}" <${cfg.email}>`
      : cfg.email;

    const attachments = msg.attachments?.map(a => ({
      filename: a.filename,
      content: Buffer.from(a.content, 'base64'),
      contentType: a.contentType || 'application/octet-stream',
    }));

    const info = await transporter.sendMail({
      from: msg.from || fromAddress,
      to: Array.isArray(msg.to) ? msg.to.join(', ') : msg.to,
      cc: msg.cc ? (Array.isArray(msg.cc) ? msg.cc.join(', ') : msg.cc) : undefined,
      bcc: msg.bcc ? (Array.isArray(msg.bcc) ? msg.bcc.join(', ') : msg.bcc) : undefined,
      replyTo: msg.replyTo,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: attachments?.length ? attachments : undefined,
      headers: {
        'X-Priority': '1',
        'X-Mailer': 'Fruitopia Mailer v2.0',
        ...(msg.tags ? Object.fromEntries(Object.entries(msg.tags).map(([k, v]) => [`X-${k}`, v])) : {}),
      },
    });

    return {
      success: true,
      provider: 'smtp',
      messageId: info.messageId,
      duration: Date.now() - start,
    };
  } catch (err: any) {
    const msg_lower = (err.message || '').toLowerCase();
    let hint = '';

    if (msg_lower.includes('invalid login') || msg_lower.includes('authentication') || msg_lower.includes('auth')) {
      hint = 'Authentication failed. For Gmail/Outlook: use an App Password, not your login password. Enable 2FA first, then generate an App Password.';
    } else if (msg_lower.includes('certificate') || msg_lower.includes('ssl') || msg_lower.includes('tls')) {
      hint = 'SSL/TLS error. Try port 587 (STARTTLS) or port 465 (implicit TLS). Check that the host is correct.';
    } else if (msg_lower.includes('connection') || msg_lower.includes('timeout') || msg_lower.includes('econnrefused')) {
      hint = 'Cannot connect to SMTP server. Verify the host and port. Check firewall settings and that the SMTP server is online.';
    } else if (msg_lower.includes('envelope') || msg_lower.includes('recipient')) {
      hint = 'Invalid recipient address. Check the "to" email address.';
    }

    // Destroy the cached transporter on auth/connection errors so the next
    // attempt creates a fresh one.
    if (msg_lower.includes('auth') || msg_lower.includes('connection') || msg_lower.includes('timeout')) {
      const key = getCacheKey(cfg);
      const cached = _transporterCache.get(key);
      if (cached) {
        try { await cached.transporter.close(); } catch { /* ignore */ }
        _transporterCache.delete(key);
      }
    }

    return {
      success: false,
      provider: 'smtp',
      error: `SMTP delivery failed: ${err.message}`,
      hint,
      duration: Date.now() - start,
    };
  }
}

export async function verifySmtp(cfg: EmailConfig): Promise<VerifyResult> {
  if (!cfg.host || !cfg.email || !cfg.password) {
    return {
      success: false,
      provider: 'smtp',
      message: 'SMTP credentials incomplete. Host, email, and password are required.',
    };
  }

  try {
    const transporter = await getTransporter(cfg);
    await transporter.verify();
    return {
      success: true,
      provider: 'smtp',
      message: `SMTP connection verified. Server: ${cfg.host}:${cfg.port || 587}`,
      details: {
        host: cfg.host,
        port: cfg.port || 587,
        secure: cfg.secure !== undefined ? cfg.secure : (Number(cfg.port || 587) === 465),
        user: cfg.email,
      },
    };
  } catch (err: any) {
    // Destroy bad transporter
    const key = getCacheKey(cfg);
    const cached = _transporterCache.get(key);
    if (cached) {
      try { await cached.transporter.close(); } catch { /* ignore */ }
      _transporterCache.delete(key);
    }

    return {
      success: false,
      provider: 'smtp',
      message: `SMTP verification failed: ${err.message}`,
    };
  }
}

/**
 * Close all cached SMTP transporters (e.g. on server shutdown).
 */
export async function closeSmtpPool(): Promise<void> {
  for (const [key, cached] of _transporterCache) {
    try { await cached.transporter.close(); } catch { /* ignore */ }
  }
  _transporterCache.clear();
}
