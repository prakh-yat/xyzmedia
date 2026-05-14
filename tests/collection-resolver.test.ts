import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { GhlClient } from '../src/ghl/client.js';
import { CollectionResolver } from '../src/orchestrator/collection-resolver.js';
import { StateStore } from '../src/state.js';
import type { Tokens } from '../src/oauth/flow.js';

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterAll(() => mswServer.close());
afterEach(() => mswServer.resetHandlers());

const silentLogger = pino({ level: 'silent' });

function makeTokens(): Tokens {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scope: '',
    locationId: 'loc',
    companyId: 'co',
    userId: 'u',
  };
}

async function makeState() {
  const dir = await mkdtemp(join(tmpdir(), 'resolver-test-'));
  const state = await StateStore.load(join(dir, 'state.json'));
  return { dir, state };
}

function makeClient(): GhlClient {
  return new GhlClient({
    baseUrl: 'https://services.leadconnectorhq.com',
    apiVersion: '2021-07-28',
    oauth: { clientId: 'cid', clientSecret: 'cs', redirectUri: 'http://localhost:3000/api/oauth/callback' },
    tokens: makeTokens(),
    persistTokens: async () => undefined,
    logger: silentLogger,
  });
}

describe('CollectionResolver', () => {
  test('returns cached id without calling GHL', async () => {
    const { dir, state } = await makeState();
    try {
      const map = new Map<string, string>([['Brands/Existing', 'id-existing']]);
      const resolver = new CollectionResolver(map, state, makeClient(), 'loc', silentLogger, false);
      const id = await resolver.resolve('Brands/Existing');
      expect(id).toBe('id-existing');
      // No GHL calls were made; if they had, msw with `onUnhandledRequest: 'error'` would have thrown
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('returns null for blank category', async () => {
    const { dir, state } = await makeState();
    try {
      const resolver = new CollectionResolver(new Map(), state, makeClient(), 'loc', silentLogger, false);
      expect(await resolver.resolve('')).toBeNull();
      expect(await resolver.resolve('   ')).toBeNull();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('auto-creates a missing collection and persists to state', async () => {
    let postCount = 0;
    mswServer.use(
      http.post('https://services.leadconnectorhq.com/products/collections', async ({ request }) => {
        postCount += 1;
        const body = await request.json();
        return HttpResponse.json({
          data: {
            _id: 'new-id-1',
            name: (body as { name: string }).name,
            slug: (body as { slug: string }).slug,
            altId: 'loc',
          },
        }, { status: 201 });
      }),
    );

    const { dir, state } = await makeState();
    try {
      const map = new Map<string, string>();
      const resolver = new CollectionResolver(map, state, makeClient(), 'loc', silentLogger, false);
      const id = await resolver.resolve('Collections/Real Estate');
      expect(id).toBe('new-id-1');
      expect(postCount).toBe(1);

      // Cached in the map for subsequent lookups
      expect(map.get('Collections/Real Estate')).toBe('new-id-1');

      // Persisted to state
      expect(state.getCollectionByName('Collections/Real Estate')?.id).toBe('new-id-1');
      expect(state.getCollectionByName('Collections/Real Estate')?.slug).toBe('collections-real-estate');

      // Tracked in getCreated()
      const created = resolver.getCreated();
      expect(created).toHaveLength(1);
      expect(created[0]?.name).toBe('Collections/Real Estate');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('dedupes concurrent creates for the same name (one POST)', async () => {
    let postCount = 0;
    mswServer.use(
      http.post('https://services.leadconnectorhq.com/products/collections', async ({ request }) => {
        postCount += 1;
        const body = await request.json();
        // Slow response to maximize chance of races
        await new Promise((r) => setTimeout(r, 20));
        return HttpResponse.json({
          data: { _id: 'dedup-id', name: (body as { name: string }).name, slug: (body as { slug: string }).slug, altId: 'loc' },
        }, { status: 201 });
      }),
    );

    const { dir, state } = await makeState();
    try {
      const resolver = new CollectionResolver(new Map(), state, makeClient(), 'loc', silentLogger, false);
      // 10 concurrent asks for the same name
      const results = await Promise.all(Array.from({ length: 10 }, () => resolver.resolve('Collections/Hospitality')));
      expect(new Set(results)).toEqual(new Set(['dedup-id']));
      // Exactly one POST despite 10 concurrent callers
      expect(postCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('handles slug conflict by re-listing and finding by name', async () => {
    let postCount = 0;
    let listCount = 0;
    mswServer.use(
      http.post('https://services.leadconnectorhq.com/products/collections', () => {
        postCount += 1;
        return HttpResponse.json(
          { statusCode: 422, message: 'Slug already exists' },
          { status: 422 },
        );
      }),
      http.get('https://services.leadconnectorhq.com/products/collections', () => {
        listCount += 1;
        return HttpResponse.json({
          data: [{ _id: 'existing-id', name: 'Collections/Children', slug: 'collections-children', altId: 'loc' }],
          total: 1,
        });
      }),
    );

    const { dir, state } = await makeState();
    try {
      const resolver = new CollectionResolver(new Map(), state, makeClient(), 'loc', silentLogger, false);
      const id = await resolver.resolve('Collections/Children');
      expect(id).toBe('existing-id');
      expect(postCount).toBe(1);
      expect(listCount).toBeGreaterThanOrEqual(1);
      expect(state.getCollectionByName('Collections/Children')?.id).toBe('existing-id');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('dry-run uses a stub id and never calls GHL', async () => {
    // No msw handler registered for POST /products/collections; if it's called the test fails
    const { dir, state } = await makeState();
    try {
      const map = new Map<string, string>();
      const resolver = new CollectionResolver(map, state, makeClient(), 'loc', silentLogger, true /* dryRun */);
      const id = await resolver.resolve('Collections/Test');
      expect(id).toBe('dryrun-collections-test');
      expect(state.getCollectionByName('Collections/Test')?.id).toBe('dryrun-collections-test');
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('autoCreate=false returns null for missing collections without POSTing', async () => {
    // No msw handler — any POST will fail the test
    const { dir, state } = await makeState();
    try {
      const resolver = new CollectionResolver(
        new Map(),
        state,
        makeClient(),
        'loc',
        silentLogger,
        false,
        false /* autoCreate */,
      );
      const id = await resolver.resolve('Brands/Unknown');
      expect(id).toBeNull();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
