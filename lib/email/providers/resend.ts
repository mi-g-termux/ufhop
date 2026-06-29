/**
 * Resend Email Provider
 *
 * Uses the Resend REST API via native fetch (no SDK dependency).
 * Docs: https://resend.com/docs/api-reference/emails/send-email
 *
 * Environment variables:
 *   RESEND_API_KEY    — your Resend API key
 *   EMAIL_FROM        — verified sender address (must be on your Resend domain)
 */

import type { EmailConfig, EmailMessage, EmailResult, VerifyResult } from '../types.js';

const RESEND_API = 'https://api.resend.com';

export async function sendResend(cfg: EmailConfig, msg: EmailMessage): Promise<EmailResult> {
  const start = Date.now();
  const apiKey = cfg.apiKey || process.env.RESEND_API_KEY || '';
  const fromEmail = cfg.email || process.env.EMAIL_FROM || '';
  const fromName = cfg.fromName || '';

  if (!apiKey) {
    return {
      success: false,
      provider: 'resend',
      error: 'Resend API key not configured.',
      hint: 'Get your API key at https://resend.com/api-keys and set it in Admin → Email Settings or as RESEND_API_KEY env var.',
      duration: 0,
    };
  }

  if (!fromEmail) {
    return {
      success: false,
      provider: 'resend',
      error: 'Sender email address not configured.',
      hint: 'Set a verified sender address in Admin → Email Settings or EMAIL_FROM env var.',
      duration: 0,
    };
  }

  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  // Build attachments
  const attachments = msg.attachments?.map(a => ({
    filename: a.filename,
    content: a.content,  // Resend accepts base64 directly
    content_type: a.contentType || 'application/octet-stream',
  }));

  const body: Record<string, unknown> = {
    from,
    to: Array.isArray(msg.to) ? msg.to : [msg.to],
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    reply_to: msg.replyTo,
  };

  if (msg.cc) body.cc = Array.isArray(msg.cc) ? msg.cc : [msg.cc];
  if (msg.bcc) body.bcc = Array.isArray(msg.bcc) ? msg.bcc : [msg.bcc];
  if (attachments?.length) body.attachments = attachments;
  if (msg.tags) {
    body.tags = Object.entries(msg.tags).map(([name, value]) => ({ name, value }));
  }

  try {
    const res = await fetch(`${RESEND_API}/emails`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeout || 30_000),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const errMsg = data?.message || data?.error || `HTTP ${res.status}`;
      let hint = '';
      if (res.status === 403) {
        hint = 'API key may be invalid or lacks permission. Check your Resend dashboard.';
      } else if (res.status === 422) {
        hint = 'Invalid request. Verify the sender email is verified in your Resend account.';
      } else if (res.status === 429) {
        hint = 'Rate limited by Resend. Wait a moment and try again.';
      }

      return {
        success: false,
        provider: 'resend',
        error: `Resend API error: ${errMsg}`,
        hint,
        duration: Date.now() - start,
      };
    }

    return {
      success: true,
      provider: 'resend',
      messageId: data.id,
      duration: Date.now() - start,
    };
  } catch (err: any) {
    return {
      success: false,
      provider: 'resend',
      error: `Resend delivery failed: ${err.message}`,
      hint: 'Check your network connection and Resend API status.',
      duration: Date.now() - start,
    };
  }
}

export async function verifyResend(cfg: EmailConfig): Promise<VerifyResult> {
  const apiKey = cfg.apiKey || process.env.RESEND_API_KEY || '';
  if (!apiKey) {
    return { success: false, provider: 'resend', message: 'Resend API key not configured.' };
  }

  try {
    // Verify by checking the API key validity via the domains endpoint
    const res = await fetch(`${RESEND_API}/domains`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const domains = data?.data || [];
      return {
        success: true,
        provider: 'resend',
        message: `Resend API verified. ${domains.length} domain(s) configured.`,
        details: { domains: domains.map((d: any) => d.name) },
      };
    }

    if (res.status === 401 || res.status === 403) {
      return { success: false, provider: 'resend', message: 'Invalid Resend API key.' };
    }

    return { success: false, provider: 'resend', message: `Resend verification failed (HTTP ${res.status}).` };
  } catch (err: any) {
    return { success: false, provider: 'resend', message: `Resend connection error: ${err.message}` };
  }
}
