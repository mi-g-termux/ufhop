/**
 * Universal Email Service — Main Entry Point
 *
 * Provider-agnostic email delivery supporting SMTP and modern email APIs.
 * Administrators switch providers via Admin Panel or environment variables
 * without modifying source code.
 *
 * Features:
 *   - Provider abstraction (SMTP, Resend, SendGrid, Mailgun, Brevo, SES)
 *   - Automatic SSL/TLS configuration
 *   - Connection pooling (SMTP)
 *   - Retry with exponential backoff
 *   - Rate limiting
 *   - Structured logging
 *   - Connection verification
 *   - Timeout handling
 */

import type {
  EmailConfig,
  EmailMessage,
  EmailResult,
  EmailProvider,
  VerifyResult,
  RateLimitEntry,
  EmailLogEntry,
  EmailLogLevel,
} from './types.js';

// ── Provider Imports ────────────────────────────────────────────────────────
import { sendSmtp, verifySmtp, closeSmtpPool } from './providers/smtp.js';
import { sendResend, verifyResend } from './providers/resend.js';
import { sendSendgrid, verifySendgrid } from './providers/sendgrid.js';
import { sendMailgun, verifyMailgun } from './providers/mailgun.js';
import { sendBrevo, verifyBrevo } from './providers/brevo.js';
import { sendSes, verifySes } from './providers/ses.js';

// ── Rate Limiting ───────────────────────────────────────────────────────────
const _rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_DEFAULTS = { maxPerWindow: 10, windowMs: 60_000 };

function checkRateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = _rateLimitMap.get(key);
  if (!entry || now > entry.reset) {
    _rateLimitMap.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

// ── Structured Logging ──────────────────────────────────────────────────────
const _logBuffer: EmailLogEntry[] = [];
const MAX_LOG_ENTRIES = 500;

function logEmail(entry: EmailLogEntry): void {
  _logBuffer.push(entry);
  if (_logBuffer.length > MAX_LOG_ENTRIES) {
    _logBuffer.splice(0, _logBuffer.length - MAX_LOG_ENTRIES);
  }

  // Also write to console with structured prefix
  const prefix = `[EMAIL ${entry.level.toUpperCase()}]`;
  const msg = `${prefix} [${entry.provider}] ${entry.action}`;
  const details = entry.to ? ` → ${entry.to}` : '';
  const duration = entry.duration ? ` (${entry.duration}ms)` : '';
  const error = entry.error ? ` — ${entry.error}` : '';

  switch (entry.level) {
    case 'error':
      console.error(`${msg}${details}${duration}${error}`);
      break;
    case 'warn':
      console.warn(`${msg}${details}${duration}${error}`);
      break;
    case 'debug':
      console.debug(`${msg}${details}${duration}`);
      break;
    default:
      console.log(`${msg}${details}${duration}`);
  }
}

// ── Configuration Resolution ─────────────────────────────────────────────────

/**
 * Resolve email configuration from environment variables.
 * This is the PRIMARY source of email config on the server.
 * The admin panel saves settings to env vars via persistEnvVars().
 */
function resolveConfigFromEnv(): EmailConfig {
  const provider = (process.env.EMAIL_PROVIDER || 'smtp') as EmailProvider;

  return {
    provider,
    isEnabled: process.env.EMAIL_ENABLED !== 'false',

    // SMTP
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true' ? true : process.env.SMTP_SECURE === 'false' ? false : undefined,
    email: process.env.SMTP_EMAIL || process.env.EMAIL_FROM || '',
    password: process.env.SMTP_PASSWORD || '',
    fromName: process.env.EMAIL_FROM_NAME || '',

    // API providers
    apiKey: process.env.EMAIL_API_KEY || '',

    // SES
    region: process.env.AWS_SES_REGION || process.env.AWS_REGION || 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',

    // Mailgun
    domain: process.env.MAILGUN_DOMAIN || '',

    // Timeouts & retries
    timeout: Number(process.env.EMAIL_TIMEOUT || 30_000),
    retries: Number(process.env.EMAIL_RETRIES || 2),
    retryDelay: Number(process.env.EMAIL_RETRY_DELAY || 1000),
  };
}

/**
 * Merge environment config with request-provided config.
 * Env vars take precedence for sensitive fields (password, apiKey).
 * Request config provides non-sensitive fields (to, subject, html).
 */
function mergeConfig(
  envConfig: EmailConfig,
  requestConfig?: Partial<EmailConfig>,
): EmailConfig {
  if (!requestConfig) return envConfig;

  return {
    ...envConfig,
    // Provider: use env if set, otherwise request
    provider: envConfig.provider || requestConfig.provider || 'smtp',
    // Non-sensitive fields: request can override
    host: envConfig.host || requestConfig.host || '',
    port: envConfig.port || requestConfig.port || 587,
    email: envConfig.email || requestConfig.email || '',
    fromName: envConfig.fromName || requestConfig.fromName || '',
    domain: envConfig.domain || requestConfig.domain || '',
    region: envConfig.region || requestConfig.region || '',
    // Sensitive fields: ALWAYS prefer env vars
    password: envConfig.password || requestConfig.password || '',
    apiKey: envConfig.apiKey || requestConfig.apiKey || '',
    accessKeyId: envConfig.accessKeyId || requestConfig.accessKeyId || '',
    secretAccessKey: envConfig.secretAccessKey || requestConfig.secretAccessKey || '',
    // Common
    isEnabled: envConfig.isEnabled !== undefined ? envConfig.isEnabled : (requestConfig.isEnabled ?? true),
    timeout: envConfig.timeout || requestConfig.timeout || 30_000,
    retries: envConfig.retries ?? requestConfig.retries ?? 2,
    retryDelay: envConfig.retryDelay || requestConfig.retryDelay || 1000,
  };
}

// ── Provider Dispatch ───────────────────────────────────────────────────────

async function dispatchSend(cfg: EmailConfig, msg: EmailMessage): Promise<EmailResult> {
  switch (cfg.provider) {
    case 'resend':
      return sendResend(cfg, msg);
    case 'sendgrid':
      return sendSendgrid(cfg, msg);
    case 'mailgun':
      return sendMailgun(cfg, msg);
    case 'brevo':
      return sendBrevo(cfg, msg);
    case 'ses':
      return sendSes(cfg, msg);
    case 'smtp':
    default:
      return sendSmtp(cfg, msg);
  }
}

async function dispatchVerify(cfg: EmailConfig): Promise<VerifyResult> {
  switch (cfg.provider) {
    case 'resend':
      return verifyResend(cfg);
    case 'sendgrid':
      return verifySendgrid(cfg);
    case 'mailgun':
      return verifyMailgun(cfg);
    case 'brevo':
      return verifyBrevo(cfg);
    case 'ses':
      return verifySes(cfg);
    case 'smtp':
    default:
      return verifySmtp(cfg);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Send an email using the configured provider.
 *
 * @param msg - The email message to send
 * @param requestConfig - Optional provider config from the request (backward compat)
 * @param rateLimitKey - Optional rate limit key (default: recipient email)
 * @returns EmailResult with success status, message ID, and metadata
 */
export async function sendEmail(
  msg: EmailMessage,
  requestConfig?: Partial<EmailConfig>,
  rateLimitKey?: string,
): Promise<EmailResult> {
  const envConfig = resolveConfigFromEnv();
  const cfg = mergeConfig(envConfig, requestConfig);

  // ── Guard: provider disabled ──────────────────────────────────────────
  if (!cfg.isEnabled || cfg.provider === 'none') {
    logEmail({
      timestamp: new Date().toISOString(),
      level: 'info',
      provider: cfg.provider,
      action: 'SEND_SKIPPED',
      to: Array.isArray(msg.to) ? msg.to.join(', ') : msg.to,
      subject: msg.subject,
      success: true,
    });
    return {
      success: true,
      provider: cfg.provider,
      messageId: undefined,
      duration: 0,
    };
  }

  // ── Rate limiting ─────────────────────────────────────────────────────
  const rlKey = rateLimitKey || (Array.isArray(msg.to) ? msg.to[0] : msg.to) || 'global';
  if (!checkRateLimit(`email:${rlKey}`, RATE_LIMIT_DEFAULTS.maxPerWindow, RATE_LIMIT_DEFAULTS.windowMs)) {
    logEmail({
      timestamp: new Date().toISOString(),
      level: 'warn',
      provider: cfg.provider,
      action: 'RATE_LIMITED',
      to: Array.isArray(msg.to) ? msg.to.join(', ') : msg.to,
      subject: msg.subject,
    });
    return {
      success: false,
      provider: cfg.provider,
      error: 'Too many email requests. Please wait before retrying.',
      hint: 'Rate limited. Try again in a moment.',
      duration: 0,
    };
  }

  // ── Validate recipient ────────────────────────────────────────────────
  const recipients = Array.isArray(msg.to) ? msg.to : [msg.to];
  for (const r of recipients) {
    if (!r || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r)) {
      return {
        success: false,
        provider: cfg.provider,
        error: `Invalid recipient email: "${r}"`,
        duration: 0,
      };
    }
  }

  // ── Sanitize inputs ───────────────────────────────────────────────────
  const sanitizedMsg: EmailMessage = {
    ...msg,
    to: recipients,
    subject: msg.subject.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 200),
    html: msg.html.slice(0, 200_000), // 200KB max
  };

  // ── Send with retry ───────────────────────────────────────────────────
  const maxAttempts = (cfg.retries || 0) + 1;
  let lastResult: EmailResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logEmail({
      timestamp: new Date().toISOString(),
      level: 'debug',
      provider: cfg.provider,
      action: attempt === 1 ? 'SEND_ATTEMPT' : `RETRY_${attempt}/${maxAttempts}`,
      to: Array.isArray(sanitizedMsg.to) ? sanitizedMsg.to.join(', ') : sanitizedMsg.to,
      subject: sanitizedMsg.subject,
    });

    lastResult = await dispatchSend(cfg, sanitizedMsg);

    if (lastResult.success) {
      logEmail({
        timestamp: new Date().toISOString(),
        level: 'info',
        provider: cfg.provider,
        action: 'SEND_SUCCESS',
        to: Array.isArray(sanitizedMsg.to) ? sanitizedMsg.to.join(', ') : sanitizedMsg.to,
        subject: sanitizedMsg.subject,
        success: true,
        messageId: lastResult.messageId,
        duration: lastResult.duration,
      });
      lastResult.attempts = attempt;
      return lastResult;
    }

    // Don't retry on auth/config errors (only on transient errors)
    const errMsg = (lastResult.error || '').toLowerCase();
    const isTransient = errMsg.includes('timeout') ||
      errMsg.includes('connection') ||
      errMsg.includes('network') ||
      errMsg.includes('econnreset') ||
      errMsg.includes('429') ||
      errMsg.includes('rate');

    if (!isTransient || attempt >= maxAttempts) {
      break;
    }

    // Exponential backoff
    const delay = (cfg.retryDelay || 1000) * Math.pow(2, attempt - 1);
    logEmail({
      timestamp: new Date().toISOString(),
      level: 'warn',
      provider: cfg.provider,
      action: `RETRY_WAIT_${delay}ms`,
      to: Array.isArray(sanitizedMsg.to) ? sanitizedMsg.to.join(', ') : sanitizedMsg.to,
    });
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  // ── All attempts failed ───────────────────────────────────────────────
  logEmail({
    timestamp: new Date().toISOString(),
    level: 'error',
    provider: cfg.provider,
    action: 'SEND_FAILED',
    to: Array.isArray(sanitizedMsg.to) ? sanitizedMsg.to.join(', ') : sanitizedMsg.to,
    subject: sanitizedMsg.subject,
    success: false,
    error: lastResult?.error,
    duration: lastResult?.duration,
  });

  return {
    ...lastResult!,
    attempts: maxAttempts,
  };
}

/**
 * Verify email provider connectivity.
 * Tests the configured provider's connection without sending an email.
 */
export async function verifyEmailConnection(
  config?: Partial<EmailConfig>,
): Promise<VerifyResult> {
  const envConfig = resolveConfigFromEnv();
  const cfg = mergeConfig(envConfig, config);

  logEmail({
    timestamp: new Date().toISOString(),
    level: 'info',
    provider: cfg.provider,
    action: 'VERIFY_CONNECTION',
  });

  return dispatchVerify(cfg);
}

/**
 * Get recent email logs (for admin panel display).
 */
export function getEmailLogs(limit = 50): EmailLogEntry[] {
  return _logBuffer.slice(-limit);
}

/**
 * Get email service status summary.
 */
export function getEmailStatus(): {
  provider: EmailProvider;
  isEnabled: boolean;
  logsCount: number;
} {
  const cfg = resolveConfigFromEnv();
  return {
    provider: cfg.provider,
    isEnabled: cfg.isEnabled,
    logsCount: _logBuffer.length,
  };
}

/**
 * Close all provider connections (for graceful server shutdown).
 */
export async function closeEmailConnections(): Promise<void> {
  await closeSmtpPool();
}

// Re-export types
export type { EmailConfig, EmailMessage, EmailResult, EmailProvider, VerifyResult, EmailLogEntry } from './types.js';
