/**
 * Compose the GHL product description from a CSV row, mirroring the user's n8n template.
 * Skips empty sections; truncates at 6000 chars (R6).
 */

const MAX_LEN = 6000;

function clean(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\n/g, ' ').replace(/"/g, "'").trim();
}

function nonEmpty(v: unknown): boolean {
  return clean(v).length > 0;
}

export function buildDescription(row: Record<string, string | undefined>): string {
  const parts: string[] = [];

  // 1. Description
  const desc = clean(row.Description);
  if (desc) parts.push(desc);

  // 2. Colours (with optional Colours 2 / Colours 3)
  const cols: string[] = [];
  for (const k of ['Colours', 'Colours 2', 'Colours 3']) {
    const v = clean(row[k]);
    if (v) cols.push(v);
  }
  if (cols.length) parts.push(`Colours: ${cols.join(', ')}`);

  // 3. Dimensions
  const dims: string[] = [];
  for (const k of ['Dimension1', 'Dimension2', 'Dimension3']) {
    const v = clean(row[k]);
    if (v) dims.push(v);
  }
  if (dims.length) parts.push(`Dimensions: ${dims.join(' | ')}`);

  // 4. Print Types (PrintType1..8 paired with PrintDescription1..8)
  const printLines: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const t = clean(row[`PrintType${i}`]);
    const d = clean(row[`PrintDescription${i}`]);
    if (t || d) {
      if (t && d) printLines.push(`  - ${t}: ${d}`);
      else if (t) printLines.push(`  - ${t}`);
      else printLines.push(`  - ${d}`);
    }
  }
  if (printLines.length) parts.push(`Print Types:\n${printLines.join('\n')}`);

  // 5. Packaging
  const pack = clean(row.Packing);
  if (pack) parts.push(`Packaging: ${pack}`);

  // 6. PrimaryPriceDes
  const ppd = clean(row.PrimaryPriceDes);
  if (ppd) parts.push(ppd);

  // 7. Pricing tiers (Quantity1..6 / Price1..6)
  const tierLines: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const q = clean(row[`Quantity${i}`]);
    const p = clean(row[`Price${i}`]);
    if (q && p) tierLines.push(`  Qty ${q}+ — $${p}`);
  }
  if (tierLines.length) parts.push(`Pricing tiers:\n${tierLines.join('\n')}`);

  // 8. Additional costs (1..12)
  const acLines: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const desc2 = clean(row[`AdditionalCostDesc${i}`]);
    const cost = clean(row[`AdditionalCost${i}`]);
    const setup = clean(row[`SetupCharge${i}`]);
    if (desc2 || cost || setup) {
      const setupPart = setup && setup !== '0' ? ` (setup $${setup})` : '';
      const costPart = cost ? `: $${cost}` : '';
      acLines.push(`  - ${desc2 || 'Additional cost'}${costPart}${setupPart}`);
    }
  }
  if (acLines.length) parts.push(`Additional costs:\n${acLines.join('\n')}`);

  // 9. Sizing 1..3
  const sizes: string[] = [];
  for (const k of ['Sizing 1', 'Sizing 2', 'Sizing 3']) {
    const v = clean(row[k]);
    if (v) sizes.push(v);
  }
  if (sizes.length) parts.push(`Sizing: ${sizes.join(' / ')}`);

  // 10. AdditionalText
  const at = clean(row.AdditionalText);
  if (at) parts.push(at);

  let out = parts.join('\n\n');
  if (out.length > MAX_LEN) out = out.slice(0, MAX_LEN - 1) + '…';
  return out;
}
