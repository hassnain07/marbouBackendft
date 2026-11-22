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

  // Catalog
  CATEGORY_NOT_FOUND: { ar: 'الفئة غير موجودة', en: 'Category not found' },
  CATEGORY_POSTING_DISABLED: { ar: 'النشر في هذه الفئة غير مسموح', en: 'Posting in this category is disabled' },
  ATTRIBUTE_NOT_FOUND: { ar: 'الخاصية غير موجودة', en: 'Attribute not found' },
  ATTRIBUTE_IN_USE: { ar: 'الخاصية مستخدمة في إعلانات، أرشفها بدلاً من الحذف', en: 'Attribute is in use by listings, archive instead' },

  // Media
  FILE_TOO_LARGE: { ar: 'حجم الملف كبير جداً', en: 'File too large' },
  UNSUPPORTED_IMAGE_FORMAT: { ar: 'صيغة الصورة غير مدعومة', en: 'Unsupported image format' },
  UNSUPPORTED_VIDEO_FORMAT: { ar: 'صيغة الفيديو غير مدعومة', en: 'Unsupported video format' },
  UNSUPPORTED_DOCUMENT_FORMAT: { ar: 'صيغة المستند غير مدعومة', en: 'Unsupported document format' },
  VIDEO_DISABLED: { ar: 'رفع الفيديو غير متاح حالياً', en: 'Video upload is disabled' },
  VIDEO_TOO_LARGE: { ar: 'حجم الفيديو كبير جداً', en: 'Video file too large' },
  VIDEO_TOO_LONG: { ar: 'مدة الفيديو تتجاوز الحد المسموح', en: 'Video duration exceeds limit' },
  VIDEO_PROBE_FAILED: { ar: 'تعذر قراءة ملف الفيديو', en: 'Could not read video file' },
  MEDIA_IN_USE: { ar: 'الملف مرتبط بمحتوى ولا يمكن حذفه', en: 'Media is in use and cannot be deleted' },
  MEDIA_NOT_PRIVATE: { ar: 'الملف ليس خاصاً', en: 'Media is not private' },
  MEDIA_WRONG_KIND: { ar: 'نوع الملف غير مناسب', en: 'Wrong media kind' },
  IMAGE_REJECTED: { ar: 'الصورة غير مقبولة', en: 'Image rejected by classifier' },
  INVALID_PURPOSE: { ar: 'الغرض غير صالح', en: 'Invalid upload purpose' },
  NO_FILE: { ar: 'لم يتم إرفاق ملف', en: 'No file attached' },
  OTP_NOT_FOUND: { ar: 'لم يتم العثور على رمز التحقق', en: 'No OTP found' },

  // Listings
  LISTING_NOT_FOUND: { ar: 'الإعلان غير موجود', en: 'Listing not found' },
  LISTING_CAP_REACHED: { ar: 'وصلت إلى الحد الأقصى للإعلانات النشطة', en: 'Active listing cap reached' },
  LISTING_RATE_LIMIT: { ar: 'تجاوزت حد نشر الإعلانات، حاول لاحقاً', en: 'Listing rate limit exceeded' },
  LISTING_NOT_EDITABLE: { ar: 'لا يمكن تعديل هذا الإعلان', en: 'Listing cannot be edited' },
  LISTING_NOT_DRAFT: { ar: 'الإعلان ليس مسودة', en: 'Listing is not a draft' },
  LISTING_NOT_RENEWABLE: { ar: 'الإعلان غير قابل للتجديد الآن', en: 'Listing is not renewable now' },
  RENEW_WINDOW_EXPIRED: { ar: 'انتهت فترة التجديد المسموحة', en: 'Renewal window has expired' },
  CUSTOM_OTHER_TEXT_REQUIRED: { ar: 'يجب إدخال نص الفئة الأخرى', en: 'Custom other text is required' },
  INVALID_PRICE: { ar: 'السعر غير صالح', en: 'Invalid price' },
  INVALID_CURRENCY: { ar: 'العملة غير مدعومة', en: 'Unsupported currency' },
  CAPABILITY_REQUIRED: { ar: 'هذه الميزة تتطلب صلاحية خاصة', en: 'This feature requires a capability' },
  CONTACT_HIDDEN: { ar: 'طريقة التواصل هذه غير متاحة', en: 'This contact channel is hidden' },
  CONTACT_UNAVAILABLE: { ar: 'معلومات التواصل غير متوفرة', en: 'Contact info not available' },
  REVEAL_LIMIT: { ar: 'تجاوزت حد الكشف عن معلومات التواصل اليومي', en: 'Daily contact reveal limit reached' },

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
