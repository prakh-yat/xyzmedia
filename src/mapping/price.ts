export interface CreatePriceDto {
  name: string;
  type: 'one_time';
  currency: string;
  amount: number;
  setupFee: number;
  locationId: string;
  trackInventory: boolean;
  availableQuantity: number;
  sku: string;
  shippingOptions: {
    weight: { value: number; unit: 'kg' };
    dimensions: { height: number; width: number; length: number; unit: 'cm' };
  };
  isDigitalProduct: false;
}

export interface BuildPriceOpts {
  locationId: string;
  currency: string;
}

function toFloat(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}

function toInt(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

export function buildCreatePriceDto(
  row: Record<string, string | undefined>,
  opts: BuildPriceOpts,
): CreatePriceDto {
  const name = (row.Name ?? '').replace(/\n/g, ' ').trim();
  return {
    name,
    type: 'one_time',
    currency: opts.currency,
    amount: toFloat(row.Price1),
    setupFee: toFloat(row.SetupCharge1),
    locationId: opts.locationId,
    trackInventory: true,
    availableQuantity: toInt(row.Quantity1),
    sku: (row.Code ?? '').trim(),
    shippingOptions: {
      weight: { value: toFloat(row.CartonWeight), unit: 'kg' },
      dimensions: {
        height: toFloat(row.CartonHeight),
        width: toFloat(row.CartonWidth),
        length: toFloat(row.CartonLength),
        unit: 'cm',
      },
    },
    isDigitalProduct: false,
  };
}
