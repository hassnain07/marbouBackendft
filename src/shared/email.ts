import { env } from '../config/env';

// In-memory store for dev: last OTP per email+purpose
const lastOtpStore = new Map<string, string>();

export function storeLastOtp(email: string, purpose: string, code: string): void {
  lastOtpStore.set(`${email}:${purpose}`, code);
}

export function getLastOtp(email: string, purpose: string): string | undefined {
  return lastOtpStore.get(`${email}:${purpose}`);
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  if (env.EMAIL_DRIVER === 'console') {
    console.log(`[EMAIL] To: ${to} | Subject: ${subject}\n${body}`);
    return;
  }

  // SMTP driver (lazy import)
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport(env.SMTP_URL);
  await transport.sendMail({ from: 'noreply@marbou.sd', to, subject, html: body });
}

export async function sendOtpEmail(
  to: string,
  code: string,
  purpose: string,
  lang: 'ar' | 'en',
): Promise<void> {
  const { getOtpEmailTemplate } = await import('./messages');
  const { subject, body } = getOtpEmailTemplate(purpose, code, lang);
  storeLastOtp(to, purpose, code);
  await sendEmail(to, subject, body);
}
