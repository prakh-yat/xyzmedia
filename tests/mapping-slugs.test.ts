import { describe, expect, test } from 'vitest';
import { slugify } from '../src/mapping/slugs.js';

describe('slugify', () => {
  test.each([
    ["Brands/SOL'S", 'brands-sols'],
    ['Bags/Crossbody & Belt Bags', 'bags-crossbody-belt-bags'],
    ['Apparel/Polos', 'apparel-polos'],
    ['AD Labels 40 x 20mm', 'ad-labels-40-x-20mm'],
    ['  leading and trailing  ', 'leading-and-trailing'],
    ['Multiple   spaces', 'multiple-spaces'],
    ['Headwear/Caps - 5 Panel', 'headwear-caps-5-panel'],
    ['Brands/XD Design', 'brands-xd-design'],
    ['Bags/Cooler Bags', 'bags-cooler-bags'],
  ])('"%s" → "%s"', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});
