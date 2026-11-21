import { env } from '../config/env';

export async function sendSms(phone: string, text: string): Promise<void> {
  if (env.SMS_DRIVER === 'mock') {
    console.log(`[SMS] To: ${phone} | ${text}`);
    return;
  }
  // HTTP driver placeholder
  console.warn('[SMS] HTTP driver not configured');
}

export async function sendWhatsAppOtp(phone: string, code: string): Promise<void> {
  if (env.WHATSAPP_DRIVER === 'mock') {
    console.log(`[WHATSAPP] To: ${phone} | OTP: ${code}`);
    return;
  }
  console.warn('[WHATSAPP] HTTP driver not configured');
}
