import { z } from 'zod';
import { db } from '../../shared/db';

// ─── Validator cache keyed by "categoryId:version" ───────────────────────────

const validatorCache = new Map<string, z.ZodTypeAny>();

interface AttrOption { value: string; labelEn: string; labelAr: string; dependsOn?: Record<string, string> }
interface ValidationRules { min?: number; max?: number; minLength?: number; maxLength?: number }

function buildFieldSchema(
  type: string,
  rules: ValidationRules | null,
  options: AttrOption[] | null,
  isRequired: boolean,
): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (type) {
    case 'TEXT': {
      let s = z.string();
      if (rules?.minLength) s = s.min(rules.minLength);
      if (rules?.maxLength) s = s.max(rules.maxLength);
      schema = s;
      break;
    }
    case 'NUMBER': {
      let s = z.number();
      if (rules?.min !== undefined) s = s.min(rules.min);
      if (rules?.max !== undefined) s = s.max(rules.max);
      schema = s;
      break;
    }
    case 'BOOLEAN':
      schema = z.boolean();
      break;
    case 'SINGLE_SELECT': {
      const vals = (options ?? []).map((o) => o.value);
      schema = vals.length ? z.enum(vals as [string, ...string[]]) : z.string();
      break;
    }
    case 'MULTI_SELECT': {
      const vals = (options ?? []).map((o) => o.value);
      schema = vals.length
        ? z.array(z.enum(vals as [string, ...string[]]))
        : z.array(z.string());
      break;
    }
    case 'DATE':
      schema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');
      break;
    case 'RANGE':
      schema = z.object({
        min: z.number().optional(),
        max: z.number().optional(),
      });
      break;
    case 'FILE_URL':
      schema = z.string().url();
      break;
    default:
      schema = z.unknown();
  }
  return isRequired ? schema : schema.optional();
}

export async function buildValidator(categoryId: string, partial = false): Promise<z.ZodTypeAny> {
  const cat = await db.category.findUnique({ where: { id: categoryId }, select: { schemaVersion: true } });
  const version = cat?.schemaVersion ?? 0;
  const cacheKey = `${categoryId}:${version}:${partial ? 'p' : 'f'}`;
  if (validatorCache.has(cacheKey)) return validatorCache.get(cacheKey)!;

  // Collect all active (non-archived) attributes for this category and ancestors
  const chain: string[] = [];
  let curId: string | null = categoryId;
  while (curId) {
    chain.unshift(curId);
    const parent: { parentId: string | null } | null = await db.category.findUnique({ where: { id: curId }, select: { parentId: true } });
    curId = parent?.parentId ?? null;
  }

  const attrMap = new Map<string, { dataType: string; isRequired: boolean; rules: ValidationRules | null; options: AttrOption[] | null }>();
  for (const cid of chain) {
    const attrs = await db.categoryAttribute.findMany({
      where: { categoryId: cid, isArchived: false },
      orderBy: { displayOrder: 'asc' } as never,
    });
    for (const a of attrs) {
      attrMap.set(a.attributeKey, {
        dataType: a.dataType,
        isRequired: a.isRequired,
        rules: (a.validationRules as ValidationRules | null) ?? null,
        options: (a.optionsList as AttrOption[] | null) ?? null,
      });
    }
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, def] of attrMap) {
    // In partial/edit mode all fields are optional (existing listing may predate required flag)
    shape[key] = buildFieldSchema(def.dataType, def.rules, def.options, partial ? false : def.isRequired);
  }

  // Unknown keys rejected
  const schema = z.object(shape).strict();
  validatorCache.set(cacheKey, schema);
  return schema;
}

export function invalidateValidatorCache(categoryId: string): void {
  for (const key of validatorCache.keys()) {
    if (key.startsWith(categoryId + ':')) validatorCache.delete(key);
  }
}
