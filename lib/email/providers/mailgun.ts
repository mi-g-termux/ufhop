/**
 * Mailgun Email Provider
 *
 * Uses the Mailgun REST API via native fetch.
 * Docs: https://documentation.mailgun.com/api-sanitized.html
 *
 * Environment variables:
 *   MAILGUN_API_KEY    — your Mailgun private API key
 *   MAILGUN_DOMAIN     — your verified Mailgun domain
 *   EMAIL_FROM         — sender address (must be on your Mailgun domain)
 */

import type { EmailConfig, EmailMessage, EmailResult, VerifyResult } from '../types.js';

const MAILGUN_API = 'https://api.mailgun.net/v3';

export async function sendMailgun(cfg: EmailConfig, msg: EmailMessage): Promise<EmailResult> {
  const start = Date.now();
  const apiKey = cfg.apiKey || process.env.MAILGUN_API_KEY || '';
  const domain = cfg.domain || process.env.MAILGUN_DOMAIN || '';
  const fromEmail = cfg.email || process.env.EMAIL_FROM || '';
  const fromName = cfg.fromName || '';

  if (!apiKey) {
    return {
      success: false,
      provider: 'mailgun',
      error: 'Mailgun API key not configured.',
      hint: 'Get your API key at https://app.mailgun.com/app/api and set it in Admin → Email Settings or MAILGUN_API_KEY env var.',
      duration: 0,
    };
  }

  if (!domain) {
    return {
      success: false,
      provider: 'mailgun',
      error: 'Mailgun domain not configured.',
      hint: 'Set your verified Mailgun domain in Admin → Email Settings or MAILGUN_DOMAIN env var.',
      duration: 0,
    };
  }

  if (!fromEmail) {
    return {
      success: false,
      provider: 'mailgun',
      error: 'Sender email address not configured.',
      duration: 0,
    };
  }

  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  // Mailgun uses multipart form-data
  const formData = new FormData();
  formData.append('from', from);

  const toList = Array.isArray(msg.to) ? msg.to : [msg.to];
  toList.forEach(to => formData.append('to', to));

  if (msg.cc) {
    const ccList = Array.isArray(msg.cc) ? msg.cc : [msg.cc];
    ccList.forEach(cc => formData.append('cc', cc));
  }
  if (msg.bcc) {
    const bccList = Array.isArray(msg.bcc) ? msg.bcc : [msg.bcc];
    bccList.forEach(bcc => formData.append('bcc', bcc));
  }

  formData.append('subject', msg.subject);
  formData.append('html', msg.html);
  if (msg.text) formData.append('text', msg.text);
  if (msg.replyTo) formData.append('h:Reply-To', msg.replyTo);

  // Tags
  if (msg.tags) {
    Object.entries(msg.tags).forEach(([key, value]) => {
      formData.append(`v:${key}`, value);
    });
  }

  // Attachments
  if (msg.attachments?.length) {
    for (const att of msg.attachments) {
      const binary = atob(att.content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: att.contentType || 'application/octet-stream' });
      formData.append('attachment', blob, att.filename);
    }
  }

  // Basic auth: "api" + API key
  const authHeader = 'Basic ' + btoa(`api:${apiKey}`);

  try {
    const res = await fetch(`${MAILGUN_API}/${domain}/messages`, {
      method: 'POST',
      headers: { 'Authorization': authHeader },
      body: formData,
      signal: AbortSignal.timeout(cfg.timeout || 30_000),
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      return {
        success: true,
        provider: 'mailgun',
        messageId: data.id,
        duration: Date.now() - start,
      };
    }

    const errMsg = data?.message || data?.error || `HTTP ${res.status}`;
    let hint = '';
    if (res.status === 401) {
      hint = 'Invalid Mailgun API key.';
    } else if (res.status === 400) {
      hint = 'Invalid request. Check that the sender domain is verified in Mailgun.';
    }

    return {
      success: false,
      provider: 'mailgun',
      error: `Mailgun API error: ${errMsg}`,
      hint,
      duration: Date.now() - start,
    };
  } catch (err: any) {
    return {
      success: false,
      provider: 'mailgun',
      error: `Mailgun delivery failed: ${err.message}`,
      hint: 'Check network connection and Mailgun API status.',
      duration: Date.now() - start,
    };
  }
}

export async function verifyMailgun(cfg: EmailConfig): Promise<VerifyResult> {
  const apiKey = cfg.apiKey || process.env.MAILGUN_API_KEY || '';
  const domain = cfg.domain || process.env.MAILGUN_DOMAIN || '';

  if (!apiKey || !domain) {
    return { success: false, provider: 'mailgun', message: 'Mailgun API key and domain are required.' };
  }

  try {
    const authHeader = 'Basic ' + btoa(`api:${apiKey}`);
    const res = await fetch(`${MAILGUN_API}/${domain}/domains/${domain}`, {
      headers: { 'Authorization': authHeader },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const domainData = data?.domain || {};
      return {
        success: true,
        provider: 'mailgun',
        message: `Mailgun domain verified: ${domain}`,
        details: {
          state: domainData.state,
          receiving: domainData.receiving_dns_records?.length || 0,
          sending: domainData.sending_dns_records?.length || 0,
        },
      };
    }

    return { success: false, provider: 'mailgun', message: `Mailgun verification failed (HTTP ${res.status}). Check domain: ${domain}` };
  } catch (err: any) {
    return { success: false, provider: 'mailgun', message: `Mailgun connection error: ${err.message}` };
  }
}
