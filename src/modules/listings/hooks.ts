import { db } from '../../shared/db';
import { notify } from '../../shared/notify';

// Called after a listing transitions to ACTIVE (publish/renew/scan approval)
export async function onListingActivated(listingId: string): Promise<void> {
  try {
    const listing = await db.listing.findUnique({
      where: { id: listingId },
      select: { id: true, ownerId: true, title: true, categoryId: true, publicSeq: true },
    });
    if (!listing) return;

    const readableId = `MARBOU-${String(listing.publicSeq).padStart(5, '0')}`;

    // Notify owner
    await notify(listing.ownerId, 'listing_published', { title: listing.title }, {
      dedupeKey: `lp:${listingId}`,
      data: { listingId, readableId },
    });

    // Check INSTANT saved searches whose category matches or is an ancestor
    setImmediate(() => setTimeout(() => _matchSavedSearches(listing).catch((e) => console.error('[hooks] savedSearch error:', e)), 50));
  } catch (e) {
    console.error('[hooks] onListingActivated error:', e);
  }
}

async function _matchSavedSearches(listing: { id: string; ownerId: string; title: string; categoryId: string }): Promise<void> {
  // Get ancestor category ids
  const ancestorIds = new Set<string>();
  let curId: string | null = listing.categoryId;
  while (curId) {
    ancestorIds.add(curId);
    const found: { parentId: string | null } | null = await db.category.findUnique({ where: { id: curId }, select: { parentId: true } });
    curId = found?.parentId ?? null;
  }
  const searches = await db.savedSearch.findMany({
    where: { frequency: 'INSTANT' },
  });

  for (const ss of searches) {
    if (ss.userId === listing.ownerId) continue; // never notify owner about own listing
    const query = ss.query as Record<string, unknown>;
    if (query.categoryId && !ancestorIds.has(query.categoryId as string)) continue;

    // Run a lightweight check: just verify the listing matches the saved search
    const { searchListings } = await import('../search/service');
    try {
      const result = await searchListings({ ...(query as Record<string, unknown>), onlyListingId: listing.id } as never, ss.userId);
      if (result.items.length > 0) {
        await notify(ss.userId, 'saved_search_match',
          { name: ss.name, title: listing.title },
          { dedupeKey: `ss:${ss.id}:${listing.id}`, data: { savedSearchId: ss.id, listingId: listing.id } },
        );
      }
    } catch { /* ignore search errors */ }
  }
}

// Called when a listing price decreases
export async function onListingPriceChanged(listingId: string, oldPrice: number, newPrice: number): Promise<void> {
  try {
    if (newPrice >= oldPrice) return;
    const listing = await db.listing.findUnique({
      where: { id: listingId },
      select: { title: true, currency: true },
    });
    if (!listing) return;

    const favs = await db.favorite.findMany({ where: { listingId }, select: { userId: true } });
    for (const fav of favs) {
      await notify(fav.userId, 'price_drop',
        { title: listing.title, newPrice, currency: listing.currency },
        { dedupeKey: `pd:${listingId}:${newPrice}`, data: { listingId } },
      );
    }
  } catch (e) {
    console.error('[hooks] onListingPriceChanged error:', e);
  }
}

const UNAVAILABLE_STATUSES = new Set(['SOLD', 'EXPIRED', 'HIDDEN', 'SUSPENDED', 'AUTO_HIDDEN']);

// Called when a listing status changes
export async function onListingStatusChanged(listingId: string, oldStatus: string, newStatus: string): Promise<void> {
  try {
    const listing = await db.listing.findUnique({
      where: { id: listingId },
      select: { id: true, ownerId: true, title: true },
    });
    if (!listing) return;

    // Notify favoriters when listing becomes unavailable
    if (UNAVAILABLE_STATUSES.has(newStatus) && !UNAVAILABLE_STATUSES.has(oldStatus)) {
      const favs = await db.favorite.findMany({ where: { listingId }, select: { userId: true } });
      for (const fav of favs) {
        if (fav.userId === listing.ownerId) continue;
        await notify(fav.userId, 'listing_unavailable',
          { title: listing.title },
          { dedupeKey: `lu:${listingId}:${newStatus}`, data: { listingId } },
        );
      }
    }

    // Notify owner on hidden/suspended/restored
    const ownerNotifyStatuses = ['HIDDEN', 'AUTO_HIDDEN', 'SUSPENDED', 'ACTIVE'];
    if (ownerNotifyStatuses.includes(newStatus) && newStatus !== oldStatus) {
      await notify(listing.ownerId, 'listing_status',
        { title: listing.title, reason: newStatus },
        { dedupeKey: `ls:${listingId}:${newStatus}`, data: { listingId, status: newStatus } },
      );
    }
  } catch (e) {
    console.error('[hooks] onListingStatusChanged error:', e);
  }
}
