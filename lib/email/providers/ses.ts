/**
 * Amazon SES Email Provider
 *
 * Uses the AWS SES v2 API via native fetch with SigV4 signing.
 * Docs: https://docs.aws.amazon.com/ses/latest/APIReference-V2/
 *
 * Environment variables:
 *   AWS_ACCESS_KEY_ID      — your IAM access key
 *   AWS_SECRET_ACCESS_KEY  — your IAM secret key
 *   AWS_SES_REGION         — SES region (default: us-east-1)
 *   EMAIL_FROM             — verified sender address
 */

import type { EmailConfig, EmailMessage, EmailResult, VerifyResult } from '../types.js';

// AWS SigV4 signing helpers (lightweight — no SDK dependency)
async function sha256(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: CryptoKey, data: string): Promise<ArrayBuffer> {
  return crypto.subtle.importKey('raw', key as any, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    .then(k => crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
}

async function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<CryptoKey> {
  const kDate = await hmac(
    await crypto.subtle.importKey('raw', new TextEncoder().encode(`AWS4${secretKey}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    dateStamp,
  );
  const kRegion = await hmac(
    await crypto.subtle.importKey('raw', kDate, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    region,
  );
  const kService = await hmac(
    await crypto.subtle.importKey('raw', kRegion, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    service,
  );
  const kSigning = await crypto.subtle.importKey('raw', kService, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return kSigning;
}

async function signRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string,
  accessKey: string,
  secretKey: string,
  region: string,
): Promise<Record<string, string>> {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 8);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const service = 'ses';

  const payloadHash = await sha256(body);

  const signedHeaders = 'content-type;host;x-amz-date;x-amz-target';
  const canonicalHeaders = `content-type:application/json\nhost:${new URL(url).host}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `${method}\n${new URL(url).pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256(canonicalRequest)}`;

  const key = await getSignatureKey(secretKey, dateStamp, region, service);
  const signature = Array.from(new Uint8Array(await hmac(key, stringToSign))).map(b => b.toString(16).padStart(2, '0')).join('');

  return {
    'Content-Type': 'application/json',
    'X-Amz-Target': 'SESV2.SendEmail',
    'X-Amz-Date': amzDate,
    'Authorization': `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export async function sendSes(cfg: EmailConfig, msg: EmailMessage): Promise<EmailResult> {
  const start = Date.now();
  const accessKey = cfg.accessKeyId || process.env.AWS_ACCESS_KEY_ID || cfg.apiKey || '';
  const secretKey = cfg.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '';
  const region = cfg.region || process.env.AWS_SES_REGION || 'us-east-1';
  const fromEmail = cfg.email || process.env.EMAIL_FROM || '';
  const fromName = cfg.fromName || '';

  if (!accessKey || !secretKey) {
    return {
      success: false,
      provider: 'ses',
      error: 'AWS SES credentials not configured.',
      hint: 'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in Admin → Email Settings or as environment variables.',
      duration: 0,
    };
  }

  if (!fromEmail) {
    return {
      success: false,
      provider: 'ses',
      error: 'Sender email address not configured.',
      duration: 0,
    };
  }

  const toList = Array.isArray(msg.to) ? msg.to : [msg.to];

  const body: Record<string, unknown> = {
    FromEmailAddress: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
    Destination: {
      ToAddresses: toList,
      ...(msg.cc ? { CcAddresses: Array.isArray(msg.cc) ? msg.cc : [msg.cc] } : {}),
      ...(msg.bcc ? { BccAddresses: Array.isArray(msg.bcc) ? msg.bcc : [msg.bcc] } : {}),
    },
    Content: {
      Simple: {
        Subject: { Data: msg.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: msg.html, Charset: 'UTF-8' },
          ...(msg.text ? { Text: { Data: msg.text, Charset: 'UTF-8' } } : {}),
        },
      },
    },
  };

  const bodyStr = JSON.stringify(body);
  const url = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;

  try {
    const headers = await signRequest('POST', url, {}, bodyStr, accessKey, secretKey, region);

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(cfg.timeout || 30_000),
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      return {
        success: true,
        provider: 'ses',
        messageId: data.MessageId,
        duration: Date.now() - start,
      };
    }

    const errMsg = data?.message || data?.error?.message || `HTTP ${res.status}`;
    let hint = '';
    if (res.status === 403) {
      hint = 'AWS credentials lack SES permissions. Attach the AmazonSESFullAccess policy.';
    } else if (res.status === 400 && errMsg.includes('not verified')) {
      hint = 'Sender email is not verified in SES. Check your SES verified identities.';
    } else if (res.status === 400 && errMsg.includes('sandbox')) {
      hint = 'SES is in sandbox mode. Only verified addresses can receive email. Request production access in the SES console.';
    }

    return {
      success: false,
      provider: 'ses',
      error: `AWS SES error: ${errMsg}`,
      hint,
      duration: Date.now() - start,
    };
  } catch (err: any) {
    return {
      success: false,
      provider: 'ses',
      error: `AWS SES delivery failed: ${err.message}`,
      hint: 'Check AWS credentials, region, and network connection.',
      duration: Date.now() - start,
    };
  }
}

export async function verifySes(cfg: EmailConfig): Promise<VerifyResult> {
  const accessKey = cfg.accessKeyId || process.env.AWS_ACCESS_KEY_ID || cfg.apiKey || '';
  const secretKey = cfg.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '';
  const region = cfg.region || process.env.AWS_SES_REGION || 'us-east-1';

  if (!accessKey || !secretKey) {
    return { success: false, provider: 'ses', message: 'AWS SES credentials not configured.' };
  }

  try {
    // Use GetAccountAttributes to verify credentials
    const body = '{}';
    const url = `https://email.${region}.amazonaws.com/v2/email/account`;
    const headers = await signRequest('GET', url, {}, body, accessKey, secretKey, region);

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        success: true,
        provider: 'ses',
        message: `AWS SES verified. Region: ${region}`,
        details: { productionAccessEnabled: data.ProductionAccessEnabled },
      };
    }

    return { success: false, provider: 'ses', message: `AWS SES verification failed (HTTP ${res.status}).` };
  } catch (err: any) {
    return { success: false, provider: 'ses', message: `AWS SES connection error: ${err.message}` };
  }
}
