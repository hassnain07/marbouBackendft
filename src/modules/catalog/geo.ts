import { db } from '../../shared/db';
import { settings } from '../../shared/settings';

// ─── Countries ────────────────────────────────────────────────────────────────

export async function getCountries() {
  return settings.get<unknown[]>('countries', [
    { code: 'SD', dialCode: '+249', nameEn: 'Sudan', nameAr: 'السودان', defaultCurrency: 'SDG' },
  ]);
}

// ─── Places ───────────────────────────────────────────────────────────────────

const placeOrder = [{ displayOrder: 'asc' }, { nameEn: 'asc' }] as never;

export async function getStates(countryCode = 'SD') {
  return db.place.findMany({
    where: { level: 'STATE', countryCode, isActive: true },
    orderBy: placeOrder,
    select: { id: true, nameAr: true, nameEn: true, lat: true, lng: true },
  });
}

export async function getCities(stateId: string) {
  return db.place.findMany({
    where: { level: 'CITY', parentId: stateId, isActive: true },
    orderBy: placeOrder,
    select: { id: true, nameAr: true, nameEn: true, lat: true, lng: true },
  });
}

export async function getNeighborhoods(cityId: string) {
  return db.place.findMany({
    where: { level: 'NEIGHBORHOOD', parentId: cityId, isActive: true },
    orderBy: placeOrder,
    select: { id: true, nameAr: true, nameEn: true },
  });
}

export async function getPlaces(opts: { parentId?: string; level?: string }) {
  return db.place.findMany({
    where: {
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.level ? { level: opts.level as 'STATE' | 'CITY' | 'NEIGHBORHOOD' } : {}),
      isActive: true,
    },
    orderBy: placeOrder,
    select: { id: true, level: true, parentId: true, nameAr: true, nameEn: true, lat: true, lng: true },
  });
}
