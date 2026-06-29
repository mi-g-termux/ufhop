/**
 * Universal Email Service — Provider Types
 *
 * Supports SMTP (Gmail, Outlook, Zoho, Hostinger, cPanel, custom)
 * and modern email APIs (Resend, SendGrid, Mailgun, Brevo, Amazon SES).
 *
 * Administrators switch providers via Admin Panel or environment variables
 * without modifying source code.
 */

export type EmailProvider = 'smtp' | 'resend' | 'sendgrid' | 'mailgun' | 'brevo' | 'ses' | 'none';

export interface EmailAttachment {
  filename: string;
  content: string;       // base64 (no data: URI prefix)
  contentType?: string;
}

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;         // plain-text fallback
  from?: string;         // override sender address
  fromName?: string;     // override sender display name
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  attachments?: EmailAttachment[];
  tags?: Record<string, string>;  // provider-specific tags/metadata
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  provider: EmailProvider;
  error?: string;
  hint?: string;         // actionable suggestion for the admin
  duration?: number;     // ms taken
  attempts?: number;     // how many retries were attempted
}

export interface VerifyResult {
  success: boolean;
  provider: EmailProvider;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Email configuration shape — stored in DB (Firebase/Supabase) and/or
 * environment variables. The server reads this; the client NEVER sends
 * passwords or API keys to the server.
 */
export interface EmailConfig {
  provider: EmailProvider;

  // SMTP-specific
  host?: string;
  port?: number;
  secure?: boolean;      // explicit TLS — auto-detected when omitted
  email?: string;        // SMTP username / sender address
  password?: string;     // SMTP password / app password
  fromName?: string;     // sender display name

  // API-based providers
  apiKey?: string;

  // Amazon SES specific
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;

  // Mailgun specific
  domain?: string;

  // Common
  isEnabled: boolean;
  timeout?: number;      // ms, default 30000
  retries?: number;      // default 2
  retryDelay?: number;   // ms base delay for exponential backoff, default 1000
}

/**
 * Rate limiter entry for email sending.
 */
export interface RateLimitEntry {
  count: number;
  reset: number;
}

/**
 * Logging levels for the email service.
 */
export type EmailLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface EmailLogEntry {
  timestamp: string;
  level: EmailLogLevel;
  provider: EmailProvider;
  action: string;
  to?: string;
  subject?: string;
  success?: boolean;
  error?: string;
  duration?: number;
  messageId?: string;
}
