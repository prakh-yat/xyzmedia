import { parse } from 'csv-parse';
import { createReadStream } from 'node:fs';
import type { Logger } from 'pino';
import {
  type Collection,
  createCollection,
  listCollections,
  MissingScopeError,
  SlugConflictError,
} from '../ghl/collections.js';
import type { GhlClient } from '../ghl/client.js';
import { slugify } from '../mapping/slugs.js';
import type { StateStore } from '../state.js';

export interface SyncCollectionsOpts {
  client: GhlClient;
  state: StateStore;
  locationId: string;
  categoryChangesCsv: string;
  logger: Logger;
  dryRun: boolean;
}

export interface AddedCollectionRecord {
  name: string;
  id: string;
  slug: string;
}

export interface SyncCollectionsResult {
  /** Map of category name -> GHL collection id, including pre-existing collections. */
  nameToId: Map<string, string>;
  /**
   * Collections this sync newly created via the diff (full record with id/slug).
   * For dry-runs, id will be the placeholder string "dry-run-id".
   */
  added: AddedCollectionRecord[];
  alreadyPresent: string[];
  failed: Array<{ name: string; error: string }>;
}

async function readAddedCategories(csvPath: string): Promise<string[]> {
  const out: string[] = [];
  const parser = createReadStream(csvPath).pipe(
    parse({ columns: true, skip_empty_lines: true, relax_column_count: true }),
  );
  for await (const row of parser) {
    if ((row as { Status?: string }).Status === 'ADDED') {
      const name = (row as { Category?: string }).Category;
      if (name) out.push(name);
    }
  }
  return out;
}

export async function syncCollections(opts: SyncCollectionsOpts): Promise<SyncCollectionsResult> {
  const { client, state, locationId, categoryChangesCsv, logger, dryRun } = opts;

  // Step 1: load all existing collections from GHL into the state cache
  logger.info('listing existing GHL collections');
  const existing = await listCollections(client, locationId);
  for (const c of existing) {
    state.setCollection(c.name, { id: c.id, slug: c.slug });
  }
  logger.info({ count: existing.length }, 'cached existing collections');
  await state.save();

  const nameToId = new Map<string, string>();
  for (const c of existing) nameToId.set(c.name, c.id);

  // Step 2: read ADDED categories
  const addedCats = await readAddedCategories(categoryChangesCsv);
  logger.info({ count: addedCats.length }, 'ADDED categories from diff');

  const result: SyncCollectionsResult = {
    nameToId,
    added: [],
    alreadyPresent: [],
    failed: [],
  };

  // Step 3: for each ADDED, create if missing
  for (const name of addedCats) {
    if (nameToId.has(name)) {
      result.alreadyPresent.push(name);
      continue;
    }
    const slug = slugify(name);
    if (dryRun) {
      logger.info({ name, slug }, '[dry-run] would create collection');
      result.added.push({ name, id: 'dry-run-id', slug });
      continue;
    }
    try {
      logger.info({ name, slug }, 'creating collection');
      const c = await createCollection(client, { locationId, name, slug });
      nameToId.set(c.name, c.id);
      state.setCollection(c.name, { id: c.id, slug: c.slug });
      await state.save();
      result.added.push({ name: c.name, id: c.id, slug: c.slug });
    } catch (err) {
      if (err instanceof MissingScopeError) {
        // Hard fail — the user has to fix this and re-run
        throw err;
      }
      if (err instanceof SlugConflictError) {
        // Re-list and find the existing one by name
        logger.warn({ name, slug }, 'slug conflict, re-listing to find existing');
        const reloaded = await listCollections(client, locationId);
        const found = reloaded.find((c: Collection) => c.name === name);
        if (found) {
          nameToId.set(found.name, found.id);
          state.setCollection(found.name, { id: found.id, slug: found.slug });
          await state.save();
          result.alreadyPresent.push(name);
          continue;
        }
        // Try once with -2 suffix
        try {
          const c = await createCollection(client, { locationId, name, slug: `${slug}-2` });
          nameToId.set(c.name, c.id);
          state.setCollection(c.name, { id: c.id, slug: c.slug });
          await state.save();
          result.added.push({ name: c.name, id: c.id, slug: c.slug });
          continue;
        } catch (retryErr) {
          result.failed.push({ name, error: String(retryErr) });
        }
      } else {
        result.failed.push({ name, error: err instanceof Error ? err.message : String(err) });
        logger.error({ name, err }, 'collection create failed');
      }
    }
  }

  return result;
}
