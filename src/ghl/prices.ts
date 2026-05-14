import type { CreatePriceDto } from '../mapping/price.js';
import type { GhlClient } from './client.js';

export interface Price {
  id: string;
  productId: string;
  name: string;
  type: string;
  currency: string;
  amount: number;
  sku: string;
  availableQuantity?: number;
  setupFee?: number;
}

interface RawPrice {
  _id: string;
  product?: string;
  name: string;
  type?: string;
  priceType?: string;
  currency: string;
  amount: number;
  sku?: string;
  availableQuantity?: number;
  setupFee?: number;
}

function fromRaw(p: RawPrice, productId: string): Price {
  return {
    id: p._id,
    productId: p.product ?? productId,
    name: p.name,
    type: p.type ?? p.priceType ?? 'one_time',
    currency: p.currency,
    amount: p.amount,
    sku: p.sku ?? '',
    availableQuantity: p.availableQuantity,
    setupFee: p.setupFee,
  };
}

export async function createPrice(
  client: GhlClient,
  productId: string,
  dto: CreatePriceDto,
): Promise<Price> {
  const res = await client.request<RawPrice>(
    `/products/${encodeURIComponent(productId)}/price`,
    { method: 'POST', body: dto },
  );
  return fromRaw(res, productId);
}

export async function updatePrice(
  client: GhlClient,
  productId: string,
  priceId: string,
  dto: CreatePriceDto,
): Promise<Price> {
  const res = await client.request<RawPrice>(
    `/products/${encodeURIComponent(productId)}/price/${encodeURIComponent(priceId)}`,
    { method: 'PUT', body: dto },
  );
  return fromRaw(res, productId);
}

interface ListPricesResponse {
  prices: RawPrice[];
  total?: number;
}

export async function listPrices(
  client: GhlClient,
  productId: string,
  locationId: string,
): Promise<Price[]> {
  const res = await client.request<ListPricesResponse>(
    `/products/${encodeURIComponent(productId)}/price`,
    { query: { locationId, limit: 100 } },
  );
  return (res.prices ?? []).map((p) => fromRaw(p, productId));
}
