import { createHash } from 'crypto';
import { db } from '../../shared/db';
import { E } from '../../shared/errors';
import { audit } from '../../shared/audit';
import type { Category, CategoryAttribute } from '@prisma/client';

// ─── Cache ────────────────────────────────────────────────────────────────────

let catCache: { tree: CategoryNode[]; etag: string; loadedAt: number } | null = null;
const CAT_TTL = 60_000;

export interface CategoryNode {
  id: string;
  slug: string;
  parentId: string | null;
  nameAr: string;
  nameEn: string;
  iconUrl: string | null;
  schemaVersion: number;
  supportsCompare: boolean;
  isVideoAllowed: boolean;
  isOther?: boolean;
  children: CategoryNode[];
}

const OTHER_NODE: CategoryNode = {
  id: 'OTHER', slug: 'other', parentId: null,
  nameAr: 'أخرى', nameEn: 'Other',
  iconUrl: null, schemaVersion: 0,
  supportsCompare: false, isVideoAllowed: true,
  isOther: true, children: [],
};

function buildTree(rows: Category[], parentId: string | null): CategoryNode[] {
  return rows
    .filter((r) => r.parentId === parentId && r.isActive && !r.isArchived)
    .sort((a, b) => a.displayOrder - b.displayOrder || a.nameEn.localeCompare(b.nameEn))
    .map((r) => ({
      id: r.id, slug: r.slug, parentId: r.parentId,
      nameAr: r.nameAr, nameEn: r.nameEn, iconUrl: r.iconUrl,
      schemaVersion: r.schemaVersion, supportsCompare: r.supportsCompare,
      isVideoAllowed: r.isVideoAllowed,
      children: [...buildTree(rows, r.id), { ...OTHER_NODE, parentId: r.id }],
    }));
}

async function loadCategories(): Promise<{ tree: CategoryNode[]; etag: string }> {
  if (catCache && Date.now() - catCache.loadedAt < CAT_TTL) {
    return { tree: catCache.tree, etag: catCache.etag };
  }
  const rows = await db.category.findMany({ orderBy: [{ displayOrder: 'asc' }, { nameEn: 'asc' }] as never });
  const tree = buildTree(rows, null);
  const etag = `W/"${createHash('sha1').update(JSON.stringify(rows.map((r) => ({ id: r.id, v: r.schemaVersion })))).digest('hex').slice(0, 16)}"`;
  catCache = { tree, etag, loadedAt: Date.now() };
  return { tree, etag };
}

export function invalidateCategoryCache(): void {
  catCache = null;
}

// ─── Public category endpoints ────────────────────────────────────────────────

export async function getCategories(parentId?: string) {
  const { tree, etag } = await loadCategories();
  const list = parentId
    ? findNode(tree, parentId)?.children ?? []
    : tree;
  return { categories: list, etag };
}

function findNode(nodes: CategoryNode[], id: string): CategoryNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}

function breadcrumbs(tree: CategoryNode[], id: string): CategoryNode[] {
  function search(nodes: CategoryNode[], path: CategoryNode[]): CategoryNode[] | null {
    for (const n of nodes) {
      const next = [...path, n];
      if (n.id === id) return next;
      const found = search(n.children, next);
      if (found) return found;
    }
    return null;
  }
  return search(tree, []) ?? [];
}

export async function getCategoryById(id: string) {
  const { tree } = await loadCategories();
  const node = findNode(tree, id);
  if (!node || node.isOther) throw E.notFound('CATEGORY_NOT_FOUND');
  const crumbs = breadcrumbs(tree, id);
  return { category: node, breadcrumbs: crumbs, children: node.children };
}

// ─── Schema ───────────────────────────────────────────────────────────────────

export async function getCategorySchema(categoryId: string, includeArchived = false) {
  const cat = await db.category.findUnique({ where: { id: categoryId } });
  if (!cat || cat.isArchived) throw E.notFound('CATEGORY_NOT_FOUND');

  // Collect ancestor chain
  const chain: string[] = [];
  let cur: Category | null = cat;
  while (cur) {
    chain.unshift(cur.id);
    cur = cur.parentId ? await db.category.findUnique({ where: { id: cur.parentId } }) : null;
  }

  // Merge attributes: ancestor first, child overrides by attributeKey
  const attrMap = new Map<string, CategoryAttribute>();
  for (const cid of chain) {
    const attrs = await db.categoryAttribute.findMany({
      where: { categoryId: cid, ...(includeArchived ? {} : { isArchived: false }) },
      orderBy: { displayOrder: 'asc' } as never,
    });
    for (const a of attrs) attrMap.set(a.attributeKey, a);
  }

  const attributes = Array.from(attrMap.values()).sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));

  // ETag hashes all ancestor schema versions
  const versions = await Promise.all(
    chain.map((cid) => db.category.findUnique({ where: { id: cid }, select: { schemaVersion: true } })),
  );
  const versionStr = versions.map((v) => v?.schemaVersion ?? 0).join('-');
  const etag = `W/"${categoryId}-${versionStr}"`;

  return {
    categoryId,
    version: cat.schemaVersion,
    attributes: attributes.map((a) => ({
      attributeKey: a.attributeKey,
      labelAr: a.labelAr,
      labelEn: a.labelEn,
      dataType: a.dataType,
      isRequired: a.isRequired,
      isPrivate: a.isPrivate,
      isFilterable: a.isFilterable,
      promoteToIndex: a.promoteToIndex,
      showInCompare: a.showInCompare,
      optionsList: a.optionsList,
      validationRules: a.validationRules,
      dependsOn: a.dependsOn,
      isArchived: a.isArchived,
    })),
    postingRestricted: cat.postingRestricted,
    postingMessage: cat.postingMessage,
    videoAllowed: cat.isVideoAllowed,
    maxPhotos: 10,
    etag,
  };
}

// ─── Admin CRUD ───────────────────────────────────────────────────────────────

async function bumpSchemaVersion(categoryId: string, tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]): Promise<void> {
  // Bump the category and all descendants
  const toUpdate: string[] = [categoryId];
  const queue = [categoryId];
  while (queue.length) {
    const id = queue.shift()!;
    const children = await tx.category.findMany({ where: { parentId: id }, select: { id: true } });
    for (const c of children) { toUpdate.push(c.id); queue.push(c.id); }
  }
  await tx.category.updateMany({
    where: { id: { in: toUpdate } },
    data: { schemaVersion: { increment: 1 } },
  });
}

export async function adminCreateCategory(
  actorId: string,
  input: { slug: string; parentId?: string; nameAr: string; nameEn: string; descriptionAr?: string; descriptionEn?: string; postingRestricted?: boolean; postingMessage?: string; expiryDays?: number; supportsCompare?: boolean; isVideoAllowed?: boolean; displayOrder?: number },
) {
  const cat = await db.category.create({ data: { ...input } });
  invalidateCategoryCache();
  await audit.log({ actor: { type: 'ADMIN', id: actorId }, action: 'CATEGORY_CREATED', entity: 'Category', entityId: cat.id, after: { id: cat.id } });
  return cat;
}

export async function adminUpdateCategory(
  actorId: string,
  categoryId: string,
  input: Partial<{ nameAr: string; nameEn: string; descriptionAr: string; descriptionEn: string; postingRestricted: boolean; postingMessage: string; expiryDays: number; supportsCompare: boolean; isVideoAllowed: boolean; displayOrder: number }>,
) {
  const before = await db.category.findUnique({ where: { id: categoryId } });
  if (!before) throw E.notFound('CATEGORY_NOT_FOUND');
  const after = await db.$transaction(async (tx) => {
    await bumpSchemaVersion(categoryId, tx);
    return tx.category.update({ where: { id: categoryId }, data: input as never });
  });
  invalidateCategoryCache();
  await audit.log({ actor: { type: 'ADMIN', id: actorId }, action: 'CATEGORY_UPDATED', entity: 'Category', entityId: categoryId, before: { id: before.id }, after: { id: after.id } });
  return after;
}

export async function adminArchiveCategory(actorId: string, categoryId: string) {
  const cat = await db.category.findUnique({ where: { id: categoryId } });
  if (!cat) throw E.notFound('CATEGORY_NOT_FOUND');
  await db.category.update({ where: { id: categoryId }, data: { isArchived: true, isActive: false } });
  invalidateCategoryCache();
  await audit.log({ actor: { type: 'ADMIN', id: actorId }, action: 'CATEGORY_ARCHIVED', entity: 'Category', entityId: categoryId });
}

export async function adminRestoreCategory(actorId: string, categoryId: string) {
  const cat = await db.category.findUnique({ where: { id: categoryId } });
  if (!cat) throw E.notFound('CATEGORY_NOT_FOUND');
  await db.category.update({ where: { id: categoryId }, data: { isArchived: false, isActive: true } });
  invalidateCategoryCache();
  await audit.log({ actor: { type: 'ADMIN', id: actorId }, action: 'CATEGORY_RESTORED', entity: 'Category', entityId: categoryId });
}

export async function adminReorderCategories(actorId: string, orders: { id: string; displayOrder: number }[]) {
  await db.$transaction(orders.map((o) => db.category.update({ where: { id: o.id }, data: { displayOrder: o.displayOrder } })));
  invalidateCategoryCache();
  await audit.log({ actor: { type: 'ADMIN', id: actorId }, action: 'CATEGORIES_REORDERED', entity: 'Category', entityId: 'bulk' });
}

// ─── Admin attribute CRUD ─────────────────────────────────────────────────────

export async function adminCreateAttribute(
  actorId: string,
  categoryId: string,
  input: { attributeKey: string; labelAr: string; labelEn: string; dataType: string; isRequired?: boolean; isPrivate?: boolean; isFilterable?: boolean; promoteToIndex?: boolean; showInCompare?: boolean; optionsList?: unknown; validationRules?: unknown; dependsOn?: string; displayOrder?: number },
) {
  const cat = await db.category.findUnique({ where: { id: categoryId } });
  if (!cat) throw E.notFound('CATEGORY_NOT_FOUND');
  const attr = await db.$transaction(async (tx) => {
    const { dataType, displayOrder, ...rest } = input;
    const a = await tx.categoryAttribute.create({
      data: { categoryId, ...rest, dataType: dataType as never, displayOrder: displayOrder ?? 0 } as never,
    });
    await bumpSchemaVersion(categoryId, tx);
    return a;
  });
  invalidateCategoryCache();
  await audit.log({ actor: { type: 'ADMIN', id: actorId }, action: 'ATTRIBUTE_CREATED', entity: 'CategoryAttribute', entityId: attr.id, after: { key: attr.attributeKey } });
  return attr;
}

export async function adminUpdateAttribute(
  actorId: string,
  attributeId: string,
  input: Partial<{ labelAr: string; labelEn: string; isRequired: boolean; isPrivate: boolean; isFilterable: boolean; promoteToIndex: boolean; showInCompare: boolean; optionsList: unknown; validationRules: unknown; dependsOn: string; displayOrder: number }>,
) {
  const attr = await db.categoryAttribute.findUnique({ where: { id: attributeId } });
  if (!attr) throw E.notFound('ATTRIBUTE_NOT_FOUND');
  const updated = await db.$transaction(async (tx) => {
    const a = await tx.categoryAttribute.update({ where: { id: attributeId }, data: input as never });
    await bumpSchemaVersion(attr.categoryId, tx);
    return a;
  });
  invalidateCategoryCache();
  await audit.log({ actor: { type: 'ADMIN', id: actorId }, action: 'ATTRIBUTE_UPDATED', entity: 'CategoryAttribute', entityId: attributeId });
  return updated;
}

export async function adminArchiveAttribute(actorId: string, attributeId: string) {
  const attr = await db.categoryAttribute.findUnique({ where: { id: attributeId } });
  if (!attr) throw E.notFound('ATTRIBUTE_NOT_FOUND');
  // Check if used — if so, archive only (never delete)
  await db.$transaction(async (tx) => {
    await tx.categoryAttribute.update({ where: { id: attributeId }, data: { isArchived: true } });
    await bumpSchemaVersion(attr.categoryId, tx);
  });
  invalidateCategoryCache();
  await audit.log({ actor: { type: 'ADMIN', id: actorId }, action: 'ATTRIBUTE_ARCHIVED', entity: 'CategoryAttribute', entityId: attributeId });
}

export async function adminDeleteAttribute(actorId: string, attributeId: string) {
  const attr = await db.categoryAttribute.findUnique({ where: { id: attributeId } });
  if (!attr) throw E.notFound('ATTRIBUTE_NOT_FOUND');
  // Check if any listing uses this key
  const used = await db.listing.count({
    where: { categoryId: attr.categoryId, dynamicAttributes: { path: [attr.attributeKey], not: undefined } },
  });
  if (used > 0) throw E.rule('ATTRIBUTE_IN_USE');
  await db.$transaction(async (tx) => {
    await tx.categoryAttribute.delete({ where: { id: attributeId } });
    await bumpSchemaVersion(attr.categoryId, tx);
  });
  invalidateCategoryCache();
  await audit.log({ actor: { type: 'ADMIN', id: actorId }, action: 'ATTRIBUTE_DELETED', entity: 'CategoryAttribute', entityId: attributeId });
}
