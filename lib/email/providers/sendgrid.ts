/**
 * SendGrid Email Provider
 *
 * Uses the SendGrid v3 REST API via native fetch.
 * Docs: https://docs.sendgrid.com/api-reference/mail-send/mail-send
 *
 * Environment variables:
 *   SENDGRID_API_KEY   — your SendGrid API key (SG.xxxx)
 *   EMAIL_FROM         — verified sender address
 */

import type { EmailConfig, EmailMessage, EmailResult, VerifyResult } from '../types.js';

const SENDGRID_API = 'https://api.sendgrid.com/v3/mail/send';

export async function sendSendgrid(cfg: EmailConfig, msg: EmailMessage): Promise<EmailResult> {
  const start = Date.now();
  const apiKey = cfg.apiKey || process.env.SENDGRID_API_KEY || '';
  const fromEmail = cfg.email || process.env.EMAIL_FROM || '';
  const fromName = cfg.fromName || '';

  if (!apiKey) {
    return {
      success: false,
      provider: 'sendgrid',
      error: 'SendGrid API key not configured.',
      hint: 'Get your API key at https://app.sendgrid.com/settings/api_keys and set it in Admin → Email Settings or SENDGRID_API_KEY env var.',
      duration: 0,
    };
  }

  if (!fromEmail) {
    return {
      success: false,
      provider: 'sendgrid',
      error: 'Sender email address not configured.',
      hint: 'Set a verified sender in Admin → Email Settings or EMAIL_FROM env var.',
      duration: 0,
    };
  }

  const toList = (Array.isArray(msg.to) ? msg.to : [msg.to]).map(email => ({ email }));

  const personalizations: Record<string, unknown>[] = [{
    to: toList,
    subject: msg.subject,
  }];

  if (msg.cc) {
    personalizations[0].cc = (Array.isArray(msg.cc) ? msg.cc : [msg.cc]).map(email => ({ email }));
  }
  if (msg.bcc) {
    personalizations[0].bcc = (Array.isArray(msg.bcc) ? msg.bcc : [msg.bcc]).map(email => ({ email }));
  }

  const body: Record<string, unknown> = {
    personalizations,
    from: { email: fromEmail, name: fromName || undefined },
    subject: msg.subject,
    content: [
      { type: 'text/html', value: msg.html },
      ...(msg.text ? [{ type: 'text/plain', value: msg.text }] : []),
    ],
  };

  if (msg.replyTo) {
    body.reply_to = { email: msg.replyTo };
  }

  if (msg.attachments?.length) {
    body.attachments = msg.attachments.map(a => ({
      content: a.content,
      filename: a.filename,
      type: a.contentType || 'application/octet-stream',
      disposition: 'attachment',
    }));
  }

  if (msg.tags) {
    body.custom_args = msg.tags;
  }

  try {
    const res = await fetch(SENDGRID_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeout || 30_000),
    });

    if (res.ok || res.status === 202) {
      const messageId = res.headers.get('x-message-id') || undefined;
      return {
        success: true,
        provider: 'sendgrid',
        messageId: messageId || `sg_${Date.now()}`,
        duration: Date.now() - start,
      };
    }

    const data = await res.json().catch(() => ({}));
    const errMsg = data?.errors?.[0]?.message || data?.message || `HTTP ${res.status}`;
    let hint = '';

    if (res.status === 401) {
      hint = 'Invalid SendGrid API key. Ensure it has "Mail Send" permission.';
    } else if (res.status === 403) {
      hint = 'API key lacks permission. Enable "Mail Send" in SendGrid settings.';
    }

    return {
      success: false,
      provider: 'sendgrid',
      error: `SendGrid API error: ${errMsg}`,
      hint,
      duration: Date.now() - start,
    };
  } catch (err: any) {
    return {
      success: false,
      provider: 'sendgrid',
      error: `SendGrid delivery failed: ${err.message}`,
      hint: 'Check network connection and SendGrid API status.',
      duration: Date.now() - start,
    };
  }
}

export async function verifySendgrid(cfg: EmailConfig): Promise<VerifyResult> {
  const apiKey = cfg.apiKey || process.env.SENDGRID_API_KEY || '';
  if (!apiKey) {
    return { success: false, provider: 'sendgrid', message: 'SendGrid API key not configured.' };
  }

  try {
    // Verify by fetching user profile (lightweight endpoint)
    const res = await fetch('https://api.sendgrid.com/v3/user/profile', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        success: true,
        provider: 'sendgrid',
        message: `SendGrid API verified. Account: ${data.username || 'authenticated'}.`,
      };
    }

    if (res.status === 401 || res.status === 403) {
      return { success: false, provider: 'sendgrid', message: 'Invalid SendGrid API key or insufficient permissions.' };
    }

    return { success: false, provider: 'sendgrid', message: `SendGrid verification failed (HTTP ${res.status}).` };
  } catch (err: any) {
    return { success: false, provider: 'sendgrid', message: `SendGrid connection error: ${err.message}` };
  }
}
