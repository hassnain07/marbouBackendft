// prisma/seed-data.ts — compact data module for seed.ts

export const SUDAN_STATES: { nameAr: string; nameEn: string }[] = [
  { nameAr: 'الخرطوم', nameEn: 'Khartoum' },
  { nameAr: 'الجزيرة', nameEn: 'Al Jazirah' },
  { nameAr: 'النيل الأبيض', nameEn: 'White Nile' },
  { nameAr: 'النيل الأزرق', nameEn: 'Blue Nile' },
  { nameAr: 'نهر النيل', nameEn: 'River Nile' },
  { nameAr: 'الشمالية', nameEn: 'Northern' },
  { nameAr: 'كسلا', nameEn: 'Kassala' },
  { nameAr: 'القضارف', nameEn: 'Gedaref' },
  { nameAr: 'البحر الأحمر', nameEn: 'Red Sea' },
  { nameAr: 'سنار', nameEn: 'Sennar' },
  { nameAr: 'شمال كردفان', nameEn: 'North Kordofan' },
  { nameAr: 'جنوب كردفان', nameEn: 'South Kordofan' },
  { nameAr: 'غرب كردفان', nameEn: 'West Kordofan' },
  { nameAr: 'شمال دارفور', nameEn: 'North Darfur' },
  { nameAr: 'جنوب دارفور', nameEn: 'South Darfur' },
  { nameAr: 'غرب دارفور', nameEn: 'West Darfur' },
  { nameAr: 'وسط دارفور', nameEn: 'Central Darfur' },
  { nameAr: 'شرق دارفور', nameEn: 'East Darfur' },
];

// Cities per state (by state nameEn)
export const CITIES_BY_STATE: Record<string, { nameAr: string; nameEn: string }[]> = {
  'Khartoum': [
    { nameAr: 'الخرطوم', nameEn: 'Khartoum' },
    { nameAr: 'أم درمان', nameEn: 'Omdurman' },
    { nameAr: 'بحري', nameEn: 'Bahri' },
  ],
  'Al Jazirah': [
    { nameAr: 'ود مدني', nameEn: 'Wad Madani' },
    { nameAr: 'رفاعة', nameEn: 'Rufaa' },
  ],
  'Red Sea': [
    { nameAr: 'بورتسودان', nameEn: 'Port Sudan' },
    { nameAr: 'سواكن', nameEn: 'Suakin' },
  ],
  'Kassala': [
    { nameAr: 'كسلا', nameEn: 'Kassala' },
    { nameAr: 'القضارف', nameEn: 'Gedaref City' },
  ],
  'River Nile': [
    { nameAr: 'عطبرة', nameEn: 'Atbara' },
    { nameAr: 'شندي', nameEn: 'Shendi' },
  ],
  'North Kordofan': [
    { nameAr: 'الأبيض', nameEn: 'El Obeid' },
  ],
  'South Darfur': [
    { nameAr: 'نيالا', nameEn: 'Nyala' },
  ],
  'North Darfur': [
    { nameAr: 'الفاشر', nameEn: 'El Fasher' },
  ],
  'White Nile': [
    { nameAr: 'كوستي', nameEn: 'Kosti' },
  ],
  'Sennar': [
    { nameAr: 'سنار', nameEn: 'Sennar City' },
  ],
  'Gedaref': [
    { nameAr: 'القضارف', nameEn: 'Gedaref' },
  ],
  'Northern': [
    { nameAr: 'دنقلا', nameEn: 'Dongola' },
  ],
};

// Neighborhoods for main Khartoum cities
export const NEIGHBORHOODS_BY_CITY: Record<string, { nameAr: string; nameEn: string }[]> = {
  'Khartoum': [
    { nameAr: 'الخرطوم 2', nameEn: 'Khartoum 2' },
    { nameAr: 'الخرطوم 3', nameEn: 'Khartoum 3' },
    { nameAr: 'المنشية', nameEn: 'Al Manshiya' },
    { nameAr: 'بري', nameEn: 'Burri' },
    { nameAr: 'الديوم', nameEn: 'Al Daim' },
  ],
  'Omdurman': [
    { nameAr: 'الثورة', nameEn: 'Al Thawra' },
    { nameAr: 'أبو روف', nameEn: 'Abu Rouf' },
    { nameAr: 'الملازمين', nameEn: 'Al Mulazimin' },
    { nameAr: 'كرري', nameEn: 'Karari' },
  ],
  'Bahri': [
    { nameAr: 'الحاج يوسف', nameEn: 'Al Haj Yousif' },
    { nameAr: 'شمبات', nameEn: 'Shambat' },
    { nameAr: 'الدرجة', nameEn: 'Al Daraja' },
  ],
};

// ─── Category spec ────────────────────────────────────────────────────────────

type AttrSpec = {
  key: string;
  labelAr: string;
  labelEn: string;
  type: string;
  required?: boolean;
  filterable?: boolean;
  searchable?: boolean;
  options?: { value: string; labelEn: string; labelAr: string; dependsOn?: { attr: string; value: string } }[];
  rules?: Record<string, number>;
  displayOrder?: number;
};

type CatSpec = {
  slug: string;
  nameAr: string;
  nameEn: string;
  displayOrder: number;
  children?: CatSpec[];
  attrs?: AttrSpec[];
};

const CONDITION_OPTS = [
  { value: 'new', labelEn: 'New', labelAr: 'جديد' },
  { value: 'used_excellent', labelEn: 'Used - Excellent', labelAr: 'مستعمل - ممتاز' },
  { value: 'used_good', labelEn: 'Used - Good', labelAr: 'مستعمل - جيد' },
  { value: 'used_fair', labelEn: 'Used - Fair', labelAr: 'مستعمل - مقبول' },
];

const CAR_MAKES = [
  { value: 'toyota', labelEn: 'Toyota', labelAr: 'تويوتا' },
  { value: 'hyundai', labelEn: 'Hyundai', labelAr: 'هيونداي' },
  { value: 'kia', labelEn: 'Kia', labelAr: 'كيا' },
  { value: 'nissan', labelEn: 'Nissan', labelAr: 'نيسان' },
  { value: 'mitsubishi', labelEn: 'Mitsubishi', labelAr: 'ميتسوبيشي' },
  { value: 'suzuki', labelEn: 'Suzuki', labelAr: 'سوزوكي' },
  { value: 'isuzu', labelEn: 'Isuzu', labelAr: 'إيسوزو' },
  { value: 'ford', labelEn: 'Ford', labelAr: 'فورد' },
  { value: 'chevrolet', labelEn: 'Chevrolet', labelAr: 'شيفروليه' },
  { value: 'bmw', labelEn: 'BMW', labelAr: 'بي إم دبليو' },
  { value: 'mercedes', labelEn: 'Mercedes-Benz', labelAr: 'مرسيدس بنز' },
  { value: 'other', labelEn: 'Other', labelAr: 'أخرى' },
];

const CAR_MODELS = [
  { value: 'corolla', labelEn: 'Corolla', labelAr: 'كورولا', dependsOn: { attr: 'make', value: 'toyota' } },
  { value: 'camry', labelEn: 'Camry', labelAr: 'كامري', dependsOn: { attr: 'make', value: 'toyota' } },
  { value: 'land_cruiser', labelEn: 'Land Cruiser', labelAr: 'لاند كروزر', dependsOn: { attr: 'make', value: 'toyota' } },
  { value: 'hilux', labelEn: 'Hilux', labelAr: 'هايلكس', dependsOn: { attr: 'make', value: 'toyota' } },
  { value: 'elantra', labelEn: 'Elantra', labelAr: 'النترا', dependsOn: { attr: 'make', value: 'hyundai' } },
  { value: 'tucson', labelEn: 'Tucson', labelAr: 'توسان', dependsOn: { attr: 'make', value: 'hyundai' } },
  { value: 'sportage', labelEn: 'Sportage', labelAr: 'سبورتاج', dependsOn: { attr: 'make', value: 'kia' } },
  { value: 'sunny', labelEn: 'Sunny', labelAr: 'صني', dependsOn: { attr: 'make', value: 'nissan' } },
  { value: 'patrol', labelEn: 'Patrol', labelAr: 'باترول', dependsOn: { attr: 'make', value: 'nissan' } },
  { value: 'l200', labelEn: 'L200', labelAr: 'L200', dependsOn: { attr: 'make', value: 'mitsubishi' } },
  { value: 'other_model', labelEn: 'Other', labelAr: 'أخرى' },
];

export const CATEGORY_SPEC: CatSpec[] = [
  {
    slug: 'vehicles', nameAr: 'مركبات', nameEn: 'Vehicles', displayOrder: 1,
    children: [
      {
        slug: 'cars', nameAr: 'سيارات', nameEn: 'Cars', displayOrder: 1,
        attrs: [
          { key: 'make', labelAr: 'الماركة', labelEn: 'Make', type: 'SINGLE_SELECT', required: true, filterable: true, searchable: true, options: CAR_MAKES, displayOrder: 1 },
          { key: 'model', labelAr: 'الموديل', labelEn: 'Model', type: 'SINGLE_SELECT', required: true, filterable: true, options: CAR_MODELS, displayOrder: 2 },
          { key: 'year', labelAr: 'سنة الصنع', labelEn: 'Year', type: 'NUMBER', required: true, filterable: true, rules: { min: 1970, max: 2026 }, displayOrder: 3 },
          { key: 'mileage', labelAr: 'المسافة المقطوعة (كم)', labelEn: 'Mileage (km)', type: 'NUMBER', rules: { min: 0 }, displayOrder: 4 },
          { key: 'condition', labelAr: 'الحالة', labelEn: 'Condition', type: 'SINGLE_SELECT', required: true, options: CONDITION_OPTS, displayOrder: 5 },
          { key: 'fuel_type', labelAr: 'نوع الوقود', labelEn: 'Fuel Type', type: 'SINGLE_SELECT', options: [{ value: 'petrol', labelEn: 'Petrol', labelAr: 'بنزين' }, { value: 'diesel', labelEn: 'Diesel', labelAr: 'ديزل' }, { value: 'hybrid', labelEn: 'Hybrid', labelAr: 'هجين' }], displayOrder: 6 },
          { key: 'transmission', labelAr: 'ناقل الحركة', labelEn: 'Transmission', type: 'SINGLE_SELECT', options: [{ value: 'automatic', labelEn: 'Automatic', labelAr: 'أوتوماتيك' }, { value: 'manual', labelEn: 'Manual', labelAr: 'يدوي' }], displayOrder: 7 },
          { key: 'duty_paid', labelAr: 'الجمارك مدفوعة', labelEn: 'Duty Paid', type: 'BOOLEAN', displayOrder: 8 },
        ],
      },
      {
        slug: 'motorcycles', nameAr: 'دراجات نارية', nameEn: 'Motorcycles', displayOrder: 2,
        attrs: [
          { key: 'make', labelAr: 'الماركة', labelEn: 'Make', type: 'TEXT', required: true, displayOrder: 1 },
          { key: 'year', labelAr: 'سنة الصنع', labelEn: 'Year', type: 'NUMBER', required: true, rules: { min: 1970, max: 2026 }, displayOrder: 2 },
          { key: 'condition', labelAr: 'الحالة', labelEn: 'Condition', type: 'SINGLE_SELECT', options: CONDITION_OPTS, displayOrder: 3 },
        ],
      },
      {
        slug: 'trucks', nameAr: 'شاحنات', nameEn: 'Trucks', displayOrder: 3,
        attrs: [
          { key: 'make', labelAr: 'الماركة', labelEn: 'Make', type: 'TEXT', required: true, displayOrder: 1 },
          { key: 'year', labelAr: 'سنة الصنع', labelEn: 'Year', type: 'NUMBER', required: true, rules: { min: 1970, max: 2026 }, displayOrder: 2 },
          { key: 'payload_tons', labelAr: 'الحمولة (طن)', labelEn: 'Payload (tons)', type: 'NUMBER', rules: { min: 0 }, displayOrder: 3 },
        ],
      },
    ],
  },
  {
    slug: 'real-estate', nameAr: 'عقارات', nameEn: 'Real Estate', displayOrder: 2,
    children: [
      {
        slug: 'apartments', nameAr: 'شقق', nameEn: 'Apartments', displayOrder: 1,
        attrs: [
          { key: 'rooms', labelAr: 'عدد الغرف', labelEn: 'Rooms', type: 'NUMBER', required: true, filterable: true, rules: { min: 1, max: 20 }, displayOrder: 1 },
          { key: 'bathrooms', labelAr: 'عدد الحمامات', labelEn: 'Bathrooms', type: 'NUMBER', rules: { min: 1 }, displayOrder: 2 },
          { key: 'area_sqm', labelAr: 'المساحة (م²)', labelEn: 'Area (sqm)', type: 'NUMBER', rules: { min: 10 }, displayOrder: 3 },
          { key: 'floor', labelAr: 'الطابق', labelEn: 'Floor', type: 'NUMBER', rules: { min: 0 }, displayOrder: 4 },
          { key: 'furnished', labelAr: 'مفروش', labelEn: 'Furnished', type: 'BOOLEAN', displayOrder: 5 },
        ],
      },
      {
        slug: 'land', nameAr: 'أراضي', nameEn: 'Land', displayOrder: 2,
        attrs: [
          { key: 'area_sqm', labelAr: 'المساحة (م²)', labelEn: 'Area (sqm)', type: 'NUMBER', required: true, rules: { min: 1 }, displayOrder: 1 },
          { key: 'land_type', labelAr: 'نوع الأرض', labelEn: 'Land Type', type: 'SINGLE_SELECT', options: [{ value: 'residential', labelEn: 'Residential', labelAr: 'سكني' }, { value: 'commercial', labelEn: 'Commercial', labelAr: 'تجاري' }, { value: 'agricultural', labelEn: 'Agricultural', labelAr: 'زراعي' }], displayOrder: 2 },
        ],
      },
    ],
  },
  {
    slug: 'electronics', nameAr: 'إلكترونيات', nameEn: 'Electronics', displayOrder: 3,
    children: [
      {
        slug: 'phones', nameAr: 'هواتف', nameEn: 'Phones', displayOrder: 1,
        attrs: [
          { key: 'brand', labelAr: 'الماركة', labelEn: 'Brand', type: 'SINGLE_SELECT', required: true, filterable: true, options: [{ value: 'samsung', labelEn: 'Samsung', labelAr: 'سامسونج' }, { value: 'apple', labelEn: 'Apple', labelAr: 'آبل' }, { value: 'huawei', labelEn: 'Huawei', labelAr: 'هواوي' }, { value: 'xiaomi', labelEn: 'Xiaomi', labelAr: 'شاومي' }, { value: 'other', labelEn: 'Other', labelAr: 'أخرى' }], displayOrder: 1 },
          { key: 'storage_gb', labelAr: 'التخزين (GB)', labelEn: 'Storage (GB)', type: 'NUMBER', rules: { min: 1 }, displayOrder: 2 },
          { key: 'condition', labelAr: 'الحالة', labelEn: 'Condition', type: 'SINGLE_SELECT', required: true, options: CONDITION_OPTS, displayOrder: 3 },
        ],
      },
      {
        slug: 'computers', nameAr: 'حواسيب', nameEn: 'Computers', displayOrder: 2,
        attrs: [
          { key: 'type', labelAr: 'النوع', labelEn: 'Type', type: 'SINGLE_SELECT', required: true, options: [{ value: 'laptop', labelEn: 'Laptop', labelAr: 'محمول' }, { value: 'desktop', labelEn: 'Desktop', labelAr: 'مكتبي' }, { value: 'tablet', labelEn: 'Tablet', labelAr: 'لوحي' }], displayOrder: 1 },
          { key: 'ram_gb', labelAr: 'الذاكرة (GB)', labelEn: 'RAM (GB)', type: 'NUMBER', rules: { min: 1 }, displayOrder: 2 },
          { key: 'condition', labelAr: 'الحالة', labelEn: 'Condition', type: 'SINGLE_SELECT', required: true, options: CONDITION_OPTS, displayOrder: 3 },
        ],
      },
    ],
  },
  {
    slug: 'jobs', nameAr: 'وظائف', nameEn: 'Jobs', displayOrder: 4,
    attrs: [
      { key: 'job_type', labelAr: 'نوع الوظيفة', labelEn: 'Job Type', type: 'SINGLE_SELECT', required: true, filterable: true, options: [{ value: 'full_time', labelEn: 'Full Time', labelAr: 'دوام كامل' }, { value: 'part_time', labelEn: 'Part Time', labelAr: 'دوام جزئي' }, { value: 'contract', labelEn: 'Contract', labelAr: 'عقد' }, { value: 'freelance', labelEn: 'Freelance', labelAr: 'عمل حر' }], displayOrder: 1 },
      { key: 'experience_years', labelAr: 'سنوات الخبرة', labelEn: 'Experience (years)', type: 'NUMBER', rules: { min: 0, max: 50 }, displayOrder: 2 },
      { key: 'education', labelAr: 'المؤهل العلمي', labelEn: 'Education', type: 'SINGLE_SELECT', options: [{ value: 'high_school', labelEn: 'High School', labelAr: 'ثانوي' }, { value: 'diploma', labelEn: 'Diploma', labelAr: 'دبلوم' }, { value: 'bachelor', labelEn: 'Bachelor', labelAr: 'بكالوريوس' }, { value: 'master', labelEn: 'Master', labelAr: 'ماجستير' }, { value: 'phd', labelEn: 'PhD', labelAr: 'دكتوراه' }], displayOrder: 3 },
      { key: 'gender', labelAr: 'الجنس', labelEn: 'Gender', type: 'SINGLE_SELECT', options: [{ value: 'male', labelEn: 'Male', labelAr: 'ذكر' }, { value: 'female', labelEn: 'Female', labelAr: 'أنثى' }, { value: 'any', labelEn: 'Any', labelAr: 'كلاهما' }], displayOrder: 4 },
      { key: 'nationality', labelAr: 'الجنسية', labelEn: 'Nationality', type: 'TEXT', displayOrder: 5 },
    ],
  },
  {
    slug: 'furniture', nameAr: 'أثاث', nameEn: 'Furniture', displayOrder: 5,
    attrs: [
      { key: 'condition', labelAr: 'الحالة', labelEn: 'Condition', type: 'SINGLE_SELECT', required: true, options: CONDITION_OPTS, displayOrder: 1 },
      { key: 'material', labelAr: 'المادة', labelEn: 'Material', type: 'TEXT', displayOrder: 2 },
    ],
  },
  {
    slug: 'services', nameAr: 'خدمات', nameEn: 'Services', displayOrder: 6,
    attrs: [
      { key: 'service_type', labelAr: 'نوع الخدمة', labelEn: 'Service Type', type: 'TEXT', required: true, displayOrder: 1 },
    ],
  },
];
