/**
 * Slugify a name to a URL-safe slug, matching the existing 224 GHL collection slugs:
 *   "Brands/SOL'S"               -> "brands-sols"
 *   "Bags/Crossbody & Belt Bags" -> "bags-crossbody-belt-bags"
 *   "AD Labels 40 x 20mm"        -> "ad-labels-40-x-20mm"
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    // Strip apostrophes/quotes so "SOL'S" → "sols" not "sol-s"
    // (matches existing GHL slugs in collections.json snapshot)
    .replace(/['"]/g, '')
    // All other non-alnum runs become a single dash
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
