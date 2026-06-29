/**
 * Brevo (formerly Sendinblue) Email Provider
 *
 * Uses the Brevo SMTP v3 API via native fetch.
 * Docs: https://developers.brevo.com/reference/sendtransacemail
 *
 * Environment variables:
 *   BREVO_API_KEY      — your Brevo API key (xkeysib-...)
 *   EMAIL_FROM         — sender address (must be on your Brevo account)
 */

import type { EmailConfig, EmailMessage, EmailResult, VerifyResult } from '../types.js';

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

export async function sendBrevo(cfg: EmailConfig, msg: EmailMessage): Promise<EmailResult> {
  const start = Date.now();
  const apiKey = cfg.apiKey || process.env.BREVO_API_KEY || '';
  const fromEmail = cfg.email || process.env.EMAIL_FROM || '';
  const fromName = cfg.fromName || '';

  if (!apiKey) {
    return {
      success: false,
      provider: 'brevo',
      error: 'Brevo API key not configured.',
      hint: 'Get your API key at https://app.brevo.com/settings/keys/api and set it in Admin → Email Settings or BREVO_API_KEY env var.',
      duration: 0,
    };
  }

  if (!fromEmail) {
    return {
      success: false,
      provider: 'brevo',
      error: 'Sender email address not configured.',
      duration: 0,
    };
  }

  const toList = (Array.isArray(msg.to) ? msg.to : [msg.to]).map(email => ({ email }));

  const body: Record<string, unknown> = {
    sender: { email: fromEmail, name: fromName || undefined },
    to: toList,
    subject: msg.subject,
    htmlContent: msg.html,
    textContent: msg.text,
  };

  if (msg.cc) {
    body.cc = (Array.isArray(msg.cc) ? msg.cc : [msg.cc]).map(email => ({ email }));
  }
  if (msg.bcc) {
    body.bcc = (Array.isArray(msg.bcc) ? msg.bcc : [msg.bcc]).map(email => ({ email }));
  }
  if (msg.replyTo) {
    body.replyTo = { email: msg.replyTo };
  }
  if (msg.attachments?.length) {
    body.attachment = msg.attachments.map(a => ({
      name: a.filename,
      content: a.content,
    }));
  }
  if (msg.tags) {
    body.tags = Object.entries(msg.tags).map(([key, value]) => `${key}:${value}`);
  }

  try {
    const res = await fetch(BREVO_API, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeout || 30_000),
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok || res.status === 201) {
      return {
        success: true,
        provider: 'brevo',
        messageId: data.messageId || `brevo_${Date.now()}`,
        duration: Date.now() - start,
      };
    }

    const errMsg = data?.message || data?.error || `HTTP ${res.status}`;
    let hint = '';
    if (res.status === 401) {
      hint = 'Invalid Brevo API key. Generate a new one at https://app.brevo.com/settings/keys/api.';
    } else if (res.status === 400) {
      hint = 'Invalid request. Verify the sender email is verified in your Brevo account.';
    }

    return {
      success: false,
      provider: 'brevo',
      error: `Brevo API error: ${errMsg}`,
      hint,
      duration: Date.now() - start,
    };
  } catch (err: any) {
    return {
      success: false,
      provider: 'brevo',
      error: `Brevo delivery failed: ${err.message}`,
      hint: 'Check network connection and Brevo API status.',
      duration: Date.now() - start,
    };
  }
}

export async function verifyBrevo(cfg: EmailConfig): Promise<VerifyResult> {
  const apiKey = cfg.apiKey || process.env.BREVO_API_KEY || '';
  if (!apiKey) {
    return { success: false, provider: 'brevo', message: 'Brevo API key not configured.' };
  }

  try {
    // Verify by fetching account info
    const res = await fetch('https://api.brevo.com/v3/account', {
      headers: {
        'api-key': apiKey,
        'accept': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        success: true,
        provider: 'brevo',
        message: `Brevo API verified. Email: ${data.email || 'authenticated'}`,
        details: { plan: data.plan?.[0]?.type, credits: data.credits?.creditsRemaining },
      };
    }

    if (res.status === 401) {
      return { success: false, provider: 'brevo', message: 'Invalid Brevo API key.' };
    }

    return { success: false, provider: 'brevo', message: `Brevo verification failed (HTTP ${res.status}).` };
  } catch (err: any) {
    return { success: false, provider: 'brevo', message: `Brevo connection error: ${err.message}` };
  }
}
