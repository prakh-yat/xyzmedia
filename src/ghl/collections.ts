import type { GhlClient } from './client.js';
import { ApiError } from './client.js';

export interface Collection {
  id: string;
  name: string;
  slug: string;
  altId: string;
}

/**
 * The raw collection object as returned by GHL. We persist these verbatim to
 * collections.json so the file matches the shape from the marketplace docs.
 */
export interface RawCollection {
  _id: string;
  altId: string;
  type?: string;
  name: string;
  slug: string;
  image?: string;
  createdAt?: string;
  updatedAt?: string;
  stats?: {
    productCount?: number;
    lastEvaluatedAt?: string;
  };
}

interface ListCollectionsResponse {
  data: RawCollection[];
  total: number;
}

interface CreateCollectionResponse {
  data: { _id: string; name: string; slug: string; altId: string };
}

const PAGE_SIZE = 100;

export async function listCollections(client: GhlClient, locationId: string): Promise<Collection[]> {
  const raw = await listCollectionsRaw(client, locationId);
  return raw.map((c) => ({ id: c._id, name: c.name, slug: c.slug, altId: c.altId }));
}

/**
 * List collections returning the raw GHL response objects. Used by the
 * collections.json writeback so the file matches the canonical shape.
 */
export async function listCollectionsRaw(
  client: GhlClient,
  locationId: string,
): Promise<RawCollection[]> {
  const out: RawCollection[] = [];
  let offset = 0;
  while (true) {
    const res = await client.request<ListCollectionsResponse>('/products/collections', {
      query: {
        altId: locationId,
        altType: 'location',
        limit: PAGE_SIZE,
        offset,
      },
    });
    const items = res.data ?? [];
    out.push(...items);
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return out;
}

export interface CreateCollectionOpts {
  locationId: string;
  name: string;
  slug: string;
  image?: string;
}

export class SlugConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlugConflictError';
  }
}

export class MissingScopeError extends Error {
  constructor(public readonly scope: string) {
    super(
      `PIT/OAuth token lacks scope "${scope}". Enable it in your GHL Marketplace app ` +
        'settings, re-run `npm run oauth-setup`, and try again.',
    );
    this.name = 'MissingScopeError';
  }
}

export async function deleteCollection(
  client: GhlClient,
  collectionId: string,
  locationId: string,
): Promise<void> {
  try {
    await client.request<void>(
      `/products/collections/${encodeURIComponent(collectionId)}`,
      {
        method: 'DELETE',
        query: { altId: locationId, altType: 'location' },
      },
    );
  } catch (err) {
    // 404 = already gone, treat as success (idempotent revert).
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  }
}

export async function createCollection(client: GhlClient, opts: CreateCollectionOpts): Promise<Collection> {
  const body: Record<string, unknown> = {
    altId: opts.locationId,
    altType: 'location',
    name: opts.name,
    slug: opts.slug,
  };
  if (opts.image) body.image = opts.image;
  try {
    const res = await client.request<CreateCollectionResponse>('/products/collections', {
      method: 'POST',
      body,
    });
    const c = res.data;
    return { id: c._id, name: c.name, slug: c.slug, altId: c.altId };
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 422 || err.status === 409) {
        throw new SlugConflictError(`Slug conflict on "${opts.name}" (${opts.slug}): ${String(err.body).slice(0, 200)}`);
      }
      if (err.status === 403) {
        throw new MissingScopeError('products/collection.write');
      }
    }
    throw err;
  }
}
