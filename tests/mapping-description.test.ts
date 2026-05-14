import { describe, expect, test } from 'vitest';
import { buildDescription } from '../src/mapping/description.js';

describe('buildDescription', () => {
  test('full row has all sections', () => {
    const row = {
      Description: 'Sticky labels.',
      Colours: 'White',
      'Colours 2': 'Black',
      'Colours 3': '',
      Dimension1: 'W 40mm x H 20mm',
      PrintType1: 'Digital Label',
      PrintDescription1: 'As shown',
      PrintType2: 'Pad Print',
      PrintDescription2: 'On the front',
      Packing: 'Loose',
      PrimaryPriceDes: 'Includes printing',
      Quantity1: '250',
      Price1: '0.21',
      Quantity2: '500',
      Price2: '0.20',
      AdditionalCostDesc1: 'Setup',
      AdditionalCost1: '0',
      SetupCharge1: '40',
      'Sizing 1': 'S',
      'Sizing 2': 'M',
      AdditionalText: 'Note: special.',
    };
    const d = buildDescription(row);
    expect(d).toContain('Sticky labels.');
    expect(d).toContain('Colours: White, Black');
    expect(d).toContain('Dimensions: W 40mm x H 20mm');
    expect(d).toContain('Print Types:');
    expect(d).toContain('  - Digital Label: As shown');
    expect(d).toContain('  - Pad Print: On the front');
    expect(d).toContain('Packaging: Loose');
    expect(d).toContain('Includes printing');
    expect(d).toContain('Pricing tiers:');
    expect(d).toContain('Qty 250+ — $0.21');
    expect(d).toContain('Qty 500+ — $0.20');
    expect(d).toContain('Sizing: S / M');
    expect(d).toContain('Note: special.');
  });

  test('handles a sparse row with only Description', () => {
    const d = buildDescription({ Description: 'Just this.' });
    expect(d).toBe('Just this.');
  });

  test('strips newlines and converts double quotes to single', () => {
    const d = buildDescription({ Description: 'Line1\nLine2 "quoted"' });
    expect(d).not.toContain('\n');
    expect(d).not.toContain('"');
    expect(d).toContain("'quoted'");
  });

  test('truncates at 6000 chars', () => {
    const big = 'x'.repeat(7000);
    const d = buildDescription({ Description: big });
    expect(d.length).toBe(6000);
    expect(d.endsWith('…')).toBe(true);
  });

  test('omits sections when source fields are empty', () => {
    const d = buildDescription({ Description: 'Only this.', Colours: '' });
    expect(d).not.toContain('Colours:');
  });
});
