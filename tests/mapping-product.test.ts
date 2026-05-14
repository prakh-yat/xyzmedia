import { describe, expect, test } from 'vitest';
import { buildCreateProductDto, resolveCollectionIds } from '../src/mapping/product.js';

describe('buildCreateProductDto', () => {
  const baseRow = {
    Code: '100109',
    Name: 'AD Labels 40 x 20mm',
    Description: 'Standard sized labels.',
    Category1: 'Print/Ad Labels',
    Category2: 'Collections/Full Custom',
    ImageCount: '3',
  };

  test('image equals medias[0].url so storefront thumbnail matches gallery', () => {
    const mediaUrls = ['https://cdn/100109-0.jpg', 'https://cdn/100109-1.jpg'];
    const dto = buildCreateProductDto(baseRow, {
      locationId: 'loc',
      mediaUrls,
      collectionIds: ['c1', 'c2'],
    });
    expect(dto.image).toBe(mediaUrls[0]);
    expect(dto.medias[0]?.url).toBe(mediaUrls[0]);
    expect(dto.medias[0]?.isFeatured).toBe(true);
    expect(dto.medias[1]?.isFeatured).toBe(false);
  });

  test('returns image="" when no images succeeded', () => {
    const dto = buildCreateProductDto(baseRow, {
      locationId: 'loc',
      mediaUrls: [],
      collectionIds: [],
    });
    expect(dto.image).toBe('');
    expect(dto.medias).toEqual([]);
  });

  test('renumbers media indices 0..N-1 (no gaps from CDN 403/404)', () => {
    // Caller (orchestrator) already removed gaps from mediaUrls; we just renumber sequential ids
    const dto = buildCreateProductDto(baseRow, {
      locationId: 'loc',
      mediaUrls: ['https://cdn/0.jpg', 'https://cdn/2.jpg'],
      collectionIds: [],
    });
    expect(dto.medias.map((m) => m.id)).toEqual(['100109-0', '100109-1']);
    expect(dto.medias[0]?.isFeatured).toBe(true);
    expect(dto.medias[1]?.isFeatured).toBe(false);
  });

  test('basic fields are constant', () => {
    const dto = buildCreateProductDto(baseRow, {
      locationId: 'loc-x',
      mediaUrls: [],
      collectionIds: [],
    });
    expect(dto.productType).toBe('PHYSICAL');
    expect(dto.locationId).toBe('loc-x');
    expect(dto.availableInStore).toBe(true);
    expect(dto.isTaxesEnabled).toBe(false);
    expect(dto.slug).toBe('ad-labels-40-x-20mm');
  });

  test('slugOverride wins for retry-after-conflict path', () => {
    const dto = buildCreateProductDto(baseRow, {
      locationId: 'loc',
      mediaUrls: [],
      collectionIds: [],
      slugOverride: 'ad-labels-40-x-20mm-100109',
    });
    expect(dto.slug).toBe('ad-labels-40-x-20mm-100109');
  });
});

describe('resolveCollectionIds', () => {
  test('maps Category1..6 via name->id and reports unresolved', () => {
    const map = new Map([
      ['Print/Ad Labels', 'c1'],
      ['Collections/Full Custom', 'c2'],
    ]);
    const row = {
      Category1: 'Print/Ad Labels',
      Category2: 'Collections/Full Custom',
      Category3: 'Brands/Unknown',
      Category4: '',
    };
    const { ids, unresolved } = resolveCollectionIds(row, map);
    expect(ids).toEqual(['c1', 'c2']);
    expect(unresolved).toEqual(['Brands/Unknown']);
  });
});
