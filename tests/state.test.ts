import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'state-'));
}

describe('StateStore', () => {
  test('roundtrips a product', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    try {
      const s = await StateStore.load(path);
      s.setProduct('100109', {
        ghlProductId: 'p1',
        ghlPriceId: 'pr1',
        payloadSha: 'aaa',
        priceSha: 'bbb',
        syncedAt: '2026-05-08T00:00:00Z',
      });
      await s.save();

      const s2 = await StateStore.load(path);
      const got = s2.getProduct('100109');
      expect(got?.ghlProductId).toBe('p1');
      expect(got?.ghlPriceId).toBe('pr1');
      expect(got?.payloadSha).toBe('aaa');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('returns undefined for unseen code on fresh store', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    try {
      const s = await StateStore.load(path);
      expect(s.getProduct('999')).toBeUndefined();
      expect(s.hasProducts()).toBe(false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('roundtrips a media entry', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    try {
      const s = await StateStore.load(path);
      s.setMedia('100109', 0, { url: 'https://cdn/x.jpg', sha: 'h', fileId: 'f1' });
      await s.save();

      const s2 = await StateStore.load(path);
      expect(s2.getMedia('100109', 0)?.url).toBe('https://cdn/x.jpg');
      expect(s2.getMedia('100109', 1)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('roundtrips a collection entry', async () => {
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    try {
      const s = await StateStore.load(path);
      s.setCollection("Brands/SOL'S", { id: 'c1', slug: 'brands-sols' });
      await s.save();

      const s2 = await StateStore.load(path);
      expect(s2.getCollectionByName("Brands/SOL'S")?.id).toBe('c1');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('atomic write: concurrent saves serialize via mutex (no JSON corruption)', async () => {
    // Mocking node:fs/promises in pool:forks ESM is fragile; instead, verify
    // the load-bearing safety claim differently: hammer save() with concurrent
    // calls and assert the file is always valid JSON after every save. The
    // atomic .tmp + fsync + rename pattern guarantees no torn writes, and the
    // mutex serializes the rename ops so the last save wins cleanly.
    const dir = await tempDir();
    const path = join(dir, 'state.json');
    try {
      const s = await StateStore.load(path);
      // Fire 50 concurrent saves with mutating data
      const ops = Array.from({ length: 50 }, (_, i) => async () => {
        s.setProduct(String(i), {
          ghlProductId: `p${i}`,
          ghlPriceId: null,
          payloadSha: 'sha',
          priceSha: null,
          syncedAt: new Date().toISOString(),
        });
        await s.save();
        const raw = await readFile(path, 'utf8');
        // Must always parse cleanly mid-flight
        const parsed = JSON.parse(raw);
        expect(parsed.schemaVersion).toBe(1);
      });
      await Promise.all(ops.map((op) => op()));

      // Final state must contain all 50 products
      const final = await StateStore.load(path);
      expect(final.productCount()).toBe(50);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('handles missing file gracefully', async () => {
    const dir = await tempDir();
    try {
      const s = await StateStore.load(join(dir, 'does-not-exist.json'));
      expect(s.productCount()).toBe(0);
      expect(s.collectionNames()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
