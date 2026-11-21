import { b64urlEncode, b64urlDecode } from './crypto';

export interface CursorPayload {
  o: number;
}

export function encodeCursor(payload: CursorPayload): string {
  return b64urlEncode(payload);
}

export function decodeCursor(cursor: string): CursorPayload {
  try {
    return b64urlDecode<CursorPayload>(cursor);
  } catch {
    return { o: 0 };
  }
}

export function paginate<T>(
  items: T[],
  limit: number,
  offset: number,
): { data: T[]; nextCursor: string | null } {
  const hasMore = items.length > limit;
  const data = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? encodeCursor({ o: offset + limit }) : null;
  return { data, nextCursor };
}
