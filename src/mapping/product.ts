import { buildDescription } from './description.js';
import { slugify } from './slugs.js';

export const CATEGORY_KEYS = ['Category1', 'Category2', 'Category3', 'Category4', 'Category5', 'Category6'] as const;

export interface ProductMedia {
  id: string;
  url: string;
  type: 'image' | 'video';
  isFeatured: boolean;
}

export interface CreateProductDto {
  name: string;
  locationId: string;
  productType: 'PHYSICAL';
  description: string;
  image: string;
  medias: ProductMedia[];
  collectionIds: string[];
  availableInStore: true;
  isTaxesEnabled: false;
  slug: string;
}

export interface BuildProductOpts {
  locationId: string;
  /** URLs of successfully uploaded images (gaps already removed). */
  mediaUrls: string[];
  /** Resolved collection IDs from Category1..6 lookup. */
  collectionIds: string[];
  /** Optional override for slug (e.g. when retrying after 422 conflict). */
  slugOverride?: string;
}

export function buildCreateProductDto(
  row: Record<string, string | undefined>,
  opts: BuildProductOpts,
): CreateProductDto {
  const name = (row.Name ?? '').replace(/\n/g, ' ').trim();
  const description = buildDescription(row);
  const baseSlug = opts.slugOverride ?? slugify(name);

  // Renumber media indices 0..N-1 (gaps removed). isFeatured = idx 0.
  const code = (row.Code ?? '').trim();
  const medias: ProductMedia[] = opts.mediaUrls.map((url, idx) => ({
    id: `${code}-${idx}`,
    url,
    type: 'image',
    isFeatured: idx === 0,
  }));

  const image = medias.length > 0 ? (medias[0]?.url ?? '') : '';

  return {
    name,
    locationId: opts.locationId,
    productType: 'PHYSICAL',
    description,
    image,
    medias,
    collectionIds: opts.collectionIds,
    availableInStore: true,
    isTaxesEnabled: false,
    slug: baseSlug,
  };
}

/**
 * Resolve Category1..Category6 into GHL collection IDs via a name->id map.
 * Skips categories that aren't in the map (logs separately if you want).
 */
export function resolveCollectionIds(
  row: Record<string, string | undefined>,
  nameToId: Map<string, string>,
): { ids: string[]; unresolved: string[] } {
  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const k of CATEGORY_KEYS) {
    const cat = (row[k] ?? '').trim();
    if (!cat) continue;
    const id = nameToId.get(cat);
    if (id) ids.push(id);
    else unresolved.push(cat);
  }
  return { ids, unresolved };
}
