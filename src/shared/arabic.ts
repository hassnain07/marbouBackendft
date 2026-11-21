export function normalizeArabic(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // diacritics + tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function stemArabic(token: string): string {
  return (
    token
      .replace(/^(وال|بال|كال|فال|ال)/, '')
      .replace(/(ات|ون|ين|ان|ها|ه)$/, '') || token
  );
}

export function toSearchText(...parts: (string | undefined)[]): string {
  return normalizeArabic(parts.filter(Boolean).join(' '))
    .split(' ')
    .map(stemArabic)
    .join(' ');
}
