type LangMap = { ar: string; en: string };

const MESSAGES: Record<string, LangMap> = {
  // Generic
  VALIDATION_ERROR: { ar: 'خطأ في البيانات المدخلة', en: 'Validation error' },
  INTERNAL_ERROR: { ar: 'خطأ داخلي في الخادم', en: 'Internal server error' },
  NOT_FOUND: { ar: 'العنصر غير موجود', en: 'Not found' },
  CONFLICT: { ar: 'تعارض في البيانات', en: 'Conflict' },
  UNAUTHORIZED: { ar: 'غير مصرح لك', en: 'Unauthorized' },
  FORBIDDEN: { ar: 'ليس لديك صلاحية', en: 'Forbidden' },
  RATE_LIMITED: { ar: 'تجاوزت الحد المسموح به', en: 'Rate limit exceeded' },
  MAINTENANCE: { ar: 'الخدمة في وضع الصيانة', en: 'Service is under maintenance' },
  APP_UPDATE_REQUIRED: { ar: 'يرجى تحديث التطبيق', en: 'Please update the app' },

  // Auth
  EMAIL_TAKEN: { ar: 'البريد الإلكتروني مستخدم بالفعل', en: 'Email already taken' },
  EMAIL_NOT_VERIFIED: { ar: 'يرجى تأكيد بريدك الإلكتروني أولاً', en: 'Email not verified' },
  INVALID_CREDENTIALS: { ar: 'بيانات الدخول غير صحيحة', en: 'Invalid credentials' },
  ACCOUNT_LOCKED: { ar: 'الحساب مقفل مؤقتاً بسبب محاولات متعددة', en: 'Account temporarily locked' },
  ACCOUNT_SUSPENDED: { ar: 'الحساب موقوف', en: 'Account suspended' },
  ACCOUNT_BANNED: { ar: 'الحساب محظور', en: 'Account banned' },
  OTP_EXPIRED: { ar: 'انتهت صلاحية رمز التحقق', en: 'OTP has expired' },
  OTP_INVALID: { ar: 'رمز التحقق غير صحيح', en: 'Invalid OTP code' },
  OTP_ATTEMPTS_EXCEEDED: { ar: 'تجاوزت عدد المحاولات المسموح بها', en: 'OTP attempts exceeded' },
  OTP_COOLDOWN: { ar: 'يرجى الانتظار قبل إعادة الإرسال', en: 'Please wait before resending' },
  OTP_CHANNEL_DISABLED: { ar: 'قناة التحقق هذه غير متاحة', en: 'OTP channel is disabled' },
  INVALID_REFRESH: { ar: 'رمز التحديث غير صالح', en: 'Invalid refresh token' },
  SESSION_REVOKED: { ar: 'انتهت جلسة العمل', en: 'Session has been revoked' },
  REFRESH_REUSED: { ar: 'تم اكتشاف إعادة استخدام رمز التحديث', en: 'Refresh token reuse detected' },
  INVALID_PROVIDER: { ar: 'مزود الهوية غير مدعوم', en: 'Unsupported identity provider' },
  SOCIAL_TOKEN_INVALID: { ar: 'رمز المصادقة الاجتماعية غير صالح', en: 'Invalid social auth token' },
  WEAK_PASSWORD: { ar: 'كلمة المرور ضعيفة (8 أحرف على الأقل، حرف ورقم)', en: 'Password too weak (min 8 chars, letter + digit)' },
  PHONE_FLAG_DISABLED: { ar: 'التحقق عبر الهاتف غير متاح حالياً', en: 'Phone verification is not available' },
  SESSION_NOT_FOUND: { ar: 'الجلسة غير موجودة', en: 'Session not found' },
  SAME_EMAIL: { ar: 'البريد الإلكتروني الجديد مطابق للحالي', en: 'New email is the same as current' },
  SAME_PASSWORD: { ar: 'كلمة المرور الجديدة مطابقة للحالية', en: 'New password is the same as current' },
  WRONG_PASSWORD: { ar: 'كلمة المرور الحالية غير صحيحة', en: 'Current password is incorrect' },
  INVALID_PHONE: { ar: 'رقم الهاتف غير صالح', en: 'Invalid phone number' },
  TOKEN_EXPIRED: { ar: 'انتهت صلاحية الرمز', en: 'Token has expired' },

  // Admin
  ADMIN_NOT_FOUND: { ar: 'المشرف غير موجود', en: 'Admin not found' },
  ADMIN_INACTIVE: { ar: 'حساب المشرف غير نشط', en: 'Admin account is inactive' },
  ADMIN_IP_BLOCKED: { ar: 'عنوان IP غير مسموح به', en: 'IP address not allowed' },
  TOTP_INVALID: { ar: 'رمز المصادقة الثنائية غير صحيح', en: 'Invalid 2FA code' },
  MFA_TOKEN_INVALID: { ar: 'رمز MFA غير صالح أو منتهي الصلاحية', en: 'Invalid or expired MFA token' },
  ADMIN_EMAIL_TAKEN: { ar: 'البريد الإلكتروني مستخدم بالفعل', en: 'Email already taken' },
  CANNOT_MODIFY_SELF: { ar: 'لا يمكنك تعديل حسابك الخاص من هنا', en: 'Cannot modify your own account here' },
  LAST_OTP_CHANNEL: { ar: 'لا يمكن تعطيل آخر قناة OTP', en: 'Cannot disable the last OTP channel' },

  // Users
  USER_NOT_FOUND: { ar: 'المستخدم غير موجود', en: 'User not found' },
  ALREADY_BLOCKED: { ar: 'المستخدم محظور بالفعل', en: 'User already blocked' },
  NOT_BLOCKED: { ar: 'المستخدم غير محظور', en: 'User is not blocked' },
  CANNOT_BLOCK_SELF: { ar: 'لا يمكنك حظر نفسك', en: 'Cannot block yourself' },
  BUSINESS_SETUP_REQUIRED: { ar: 'يجب إنشاء ملف تجاري أولاً', en: 'Business setup required' },
  CAPABILITY_ALREADY_GRANTED: { ar: 'الصلاحية ممنوحة بالفعل', en: 'Capability already granted' },
  VERIFICATION_PENDING: { ar: 'طلب التحقق قيد المراجعة', en: 'Verification request is pending' },
  MEDIA_NOT_FOUND: { ar: 'الملف غير موجود', en: 'Media asset not found' },
  MEDIA_NOT_OWNED: { ar: 'لا تملك هذا الملف', en: 'Media asset not owned by you' },

  // Settings
  SETTING_NOT_FOUND: { ar: 'الإعداد غير موجود', en: 'Setting not found' },
  SETTING_INVALID_VALUE: { ar: 'قيمة الإعداد غير صالحة', en: 'Invalid setting value' },

  // OTP email templates
  OTP_EMAIL_SUBJECT_REGISTER: { ar: 'رمز التحقق من مربو', en: 'Your MARBOU verification code' },
  OTP_EMAIL_SUBJECT_RESET: { ar: 'إعادة تعيين كلمة المرور - مربو', en: 'Reset your MARBOU password' },
  OTP_EMAIL_SUBJECT_CHANGE_EMAIL: { ar: 'تأكيد البريد الإلكتروني الجديد - مربو', en: 'Confirm your new email - MARBOU' },
};

export function getMessage(code: string, lang: 'ar' | 'en'): string | undefined {
  return MESSAGES[code]?.[lang];
}

export function getOtpEmailTemplate(
  purpose: string,
  code: string,
  lang: 'ar' | 'en',
): { subject: string; body: string } {
  const subjectKey = `OTP_EMAIL_SUBJECT_${purpose}`;
  const subject = getMessage(subjectKey, lang) ?? getMessage('OTP_EMAIL_SUBJECT_REGISTER', lang)!;

  const body =
    lang === 'ar'
      ? `رمز التحقق الخاص بك هو: <strong>${code}</strong>\nصالح لمدة 10 دقائق. لا تشاركه مع أحد.`
      : `Your verification code is: <strong>${code}</strong>\nValid for 10 minutes. Do not share it.`;

  return { subject, body };
}

export function getPasswordResetTemplate(
  code: string,
  lang: 'ar' | 'en',
): { subject: string; body: string } {
  const subject =
    lang === 'ar' ? 'إعادة تعيين كلمة المرور - مربو' : 'Reset your MARBOU password';
  const body =
    lang === 'ar'
      ? `رمز إعادة تعيين كلمة المرور: <strong>${code}</strong>\nصالح لمدة 10 دقائق.`
      : `Your password reset code: <strong>${code}</strong>\nValid for 10 minutes.`;
  return { subject, body };
}
