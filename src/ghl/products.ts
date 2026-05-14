import type { CreateProductDto } from '../mapping/product.js';
import { ApiError, type GhlClient } from './client.js';

export interface Product {
  id: string;
  name: string;
  slug: string;
  description?: string;
  image?: string;
  medias?: Array<{ id: string; url: string; type: string; isFeatured?: boolean }>;
  collectionIds?: string[];
}

export class SlugCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlugCollisionError';
  }
}

interface RawProduct {
  _id: string;
  name: string;
  slug?: string;
  description?: string;
  image?: string;
  medias?: Array<{ id: string; url: string; type: string; isFeatured?: boolean }>;
  collectionIds?: string[];
}

function fromRaw(p: RawProduct): Product {
  return {
    id: p._id,
    name: p.name,
    slug: p.slug ?? '',
    description: p.description,
    image: p.image,
    medias: p.medias,
    collectionIds: p.collectionIds,
  };
}

export async function createProduct(client: GhlClient, dto: CreateProductDto): Promise<Product> {
  try {
    const res = await client.request<RawProduct>('/products/', { method: 'POST', body: dto });
    return fromRaw(res);
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) {
      const text = String(err.body).toLowerCase();
      if (text.includes('slug')) {
        throw new SlugCollisionError(`Slug collision on "${dto.name}": ${String(err.body).slice(0, 200)}`);
      }
    }
    throw err;
  }
}

export async function updateProduct(
  client: GhlClient,
  productId: string,
  dto: CreateProductDto,
): Promise<Product> {
  const res = await client.request<RawProduct>(`/products/${encodeURIComponent(productId)}`, {
    method: 'PUT',
    body: dto,
  });
  return fromRaw(res);
}

export async function deleteProduct(
  client: GhlClient,
  productId: string,
  locationId: string,
): Promise<void> {
  try {
    await client.request<void>(`/products/${encodeURIComponent(productId)}`, {
      method: 'DELETE',
      query: { locationId, altId: locationId, altType: 'location' },
    });
  } catch (err) {
    // 404 = already gone, treat as success (idempotent revert).
    if (err instanceof ApiError && err.status === 404) return;
    throw err;
  }
}

export async function getProduct(
  client: GhlClient,
  productId: string,
  locationId: string,
): Promise<Product | null> {
  try {
    const res = await client.request<RawProduct>(`/products/${encodeURIComponent(productId)}`, {
      query: { locationId },
    });
    return fromRaw(res);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

interface ListProductsResponse {
  products: RawProduct[];
  total?: Array<{ total: number }> | number;
}

export interface ListProductsOpts {
  locationId: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listProducts(client: GhlClient, opts: ListProductsOpts): Promise<Product[]> {
  const res = await client.request<ListProductsResponse>('/products/', {
    query: {
      locationId: opts.locationId,
      search: opts.search,
      limit: opts.limit ?? 100,
      offset: opts.offset ?? 0,
    },
  });
  return (res.products ?? []).map(fromRaw);
}

/**
 * Find a product by SKU. GHL has no direct SKU search, so we paginate by name
 * and filter by price.sku. Returns the first match or null.
 *
 * This is the recovery path when state.json is lost — see R14.
 */
export async function findProductBySku(
  client: GhlClient,
  sku: string,
  opts: { locationId: string; productName?: string },
): Promise<{ productId: string; priceId: string | null } | null> {
  const { listPrices } = await import('./prices.js');
  let offset = 0;
  const limit = 50;
  // Search by name if provided (faster); else we'd have to scan all products which we won't do
  if (!opts.productName) return null;
  while (true) {
    const products = await listProducts(client, {
      locationId: opts.locationId,
      search: opts.productName,
      limit,
      offset,
    });
    if (products.length === 0) return null;
    for (const p of products) {
      const prices = await listPrices(client, p.id, opts.locationId);
      const match = prices.find((pr) => pr.sku === sku);
      if (match) return { productId: p.id, priceId: match.id };
    }
    if (products.length < limit) return null;
    offset += limit;
    if (offset > 500) return null; // safety cap
  }
}
