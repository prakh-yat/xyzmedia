import { describe, expect, test } from 'vitest';
import { buildCreatePriceDto } from '../src/mapping/price.js';

describe('buildCreatePriceDto', () => {
  const row = {
    Code: '100109',
    Name: 'AD Labels 40 x 20mm',
    Price1: '0.21',
    SetupCharge1: '40',
    Quantity1: '250',
    CartonWeight: '1.00',
    CartonHeight: '7',
    CartonWidth: '30',
    CartonLength: '30',
  };

  test('happy path: all fields mapped', () => {
    const p = buildCreatePriceDto(row, { locationId: 'loc', currency: 'USD' });
    expect(p.name).toBe('AD Labels 40 x 20mm');
    expect(p.type).toBe('one_time');
    expect(p.currency).toBe('USD');
    expect(p.amount).toBe(0.21);
    expect(p.setupFee).toBe(40);
    expect(p.locationId).toBe('loc');
    expect(p.trackInventory).toBe(true);
    expect(p.availableQuantity).toBe(250);
    expect(p.sku).toBe('100109');
    expect(p.shippingOptions.weight.value).toBe(1.0);
    expect(p.shippingOptions.weight.unit).toBe('kg');
    expect(p.shippingOptions.dimensions.height).toBe(7);
    expect(p.shippingOptions.dimensions.width).toBe(30);
    expect(p.shippingOptions.dimensions.length).toBe(30);
    expect(p.shippingOptions.dimensions.unit).toBe('cm');
    expect(p.isDigitalProduct).toBe(false);
  });

  test('missing numeric fields default to 0, never null', () => {
    const p = buildCreatePriceDto(
      { Code: 'X', Name: 'Y', Price1: '', Quantity1: '' },
      { locationId: 'loc', currency: 'USD' },
    );
    expect(p.amount).toBe(0);
    expect(p.setupFee).toBe(0);
    expect(p.availableQuantity).toBe(0);
    expect(p.shippingOptions.weight.value).toBe(0);
  });

  test('honors currency override (NZD)', () => {
    const p = buildCreatePriceDto(row, { locationId: 'loc', currency: 'NZD' });
    expect(p.currency).toBe('NZD');
  });

  test('preserves decimal precision (0.21 not 21)', () => {
    const p = buildCreatePriceDto(
      { Code: 'X', Name: 'Y', Price1: '0.21' },
      { locationId: 'loc', currency: 'USD' },
    );
    expect(p.amount).toBe(0.21);
    expect(p.amount).not.toBe(21);
  });

  test('handles unparseable numbers as 0', () => {
    const p = buildCreatePriceDto(
      { Code: 'X', Name: 'Y', Price1: 'not-a-number', CartonWeight: 'oops' },
      { locationId: 'loc', currency: 'USD' },
    );
    expect(p.amount).toBe(0);
    expect(p.shippingOptions.weight.value).toBe(0);
  });
});
