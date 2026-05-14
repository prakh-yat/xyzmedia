import type { Logger } from 'pino';
import type { GhlClient } from '../ghl/client.js';
import {
  type Collection,
  createCollection,
  listCollections,
  MissingScopeError,
  SlugConflictError,
} from '../ghl/collections.js';
import { slugify } from '../mapping/slugs.js';
import type { StateStore } from '../state.js';

/**
 * Resolves a category name to a GHL collection ID, auto-creating the
 * collection if it doesn't exist.
 *
 * The diff stage (`category_changes.csv`) only catches categories that are
 * brand-new in `new.csv`. But some categories that existed in BOTH old and new
 * (i.e., flagged "UNCHANGED" by the diff) may not actually exist in GHL —
 * for instance, if the user deleted the collection or never created it.
 *
 * This resolver covers that gap: any unresolved category encountered while
 * processing products is auto-created on first reference. Concurrent product
 * processing is deduplicated via an in-flight promise cache, so 100 products
 * referencing the same missing category produce ONE POST.
 */
export class CollectionResolver {
  /** Promise cache to dedupe concurrent creates for the same name. */
  private inFlight = new Map<string, Promise<string | null>>();
  /** All collections created via this resolver during the current run. */
  private created: Collection[] = [];

  constructor(
    private readonly nameToId: Map<string, string>,
    private readonly state: StateStore,
    private readonly client: GhlClient,
    private readonly locationId: string,
    private readonly logger: Logger,
    private readonly dryRun: boolean,
    /**
     * When false, missing categories return null instead of being created.
     * Used by smoke tests / read-only inspection paths.
     */
    private readonly autoCreate: boolean = true,
  ) {}

  /**
   * Look up a collection ID by name. If not found, create the collection
   * (unless autoCreate=false). Returns null if creation failed.
   */
  async resolve(name: string): Promise<string | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;

    const cached = this.nameToId.get(trimmed);
    if (cached) return cached;

    if (!this.autoCreate) return null;

    const pending = this.inFlight.get(trimmed);
    if (pending) return pending;

    const promise = this.createAndCache(trimmed);
    this.inFlight.set(trimmed, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(trimmed);
    }
  }

  private async createAndCache(name: string): Promise<string | null> {
    const slug = slugify(name);

    if (this.dryRun) {
      // In dry-run mode, don't touch GHL — pretend the collection was created
      // with a stub ID so downstream product DTOs are coherent.
      const stubId = `dryrun-${slug}`;
      this.nameToId.set(name, stubId);
      this.state.setCollection(name, { id: stubId, slug });
      await this.state.save();
      this.created.push({ id: stubId, name, slug, altId: this.locationId });
      this.logger.info({ name, slug }, '[dry-run] would auto-create missing collection');
      return stubId;
    }

    try {
      this.logger.info({ name, slug }, 'auto-creating missing collection');
      const c = await createCollection(this.client, {
        locationId: this.locationId,
        name,
        slug,
      });
      this.nameToId.set(c.name, c.id);
      this.state.setCollection(c.name, { id: c.id, slug: c.slug });
      await this.state.save();
      this.created.push(c);
      this.logger.info({ name: c.name, id: c.id, slug: c.slug }, 'auto-created collection');
      return c.id;
    } catch (err) {
      if (err instanceof MissingScopeError) {
        // Hard fail — caller should abort the run entirely
        throw err;
      }
      if (err instanceof SlugConflictError) {
        // Probably means the collection already exists in GHL but wasn't in
        // our cache. Re-list to find it.
        this.logger.warn({ name, slug }, 'slug conflict on auto-create — re-listing to find existing');
        try {
          const all = await listCollections(this.client, this.locationId);
          const found = all.find((c) => c.name === name);
          if (found) {
            this.nameToId.set(found.name, found.id);
            this.state.setCollection(found.name, { id: found.id, slug: found.slug });
            await this.state.save();
            return found.id;
          }
          this.logger.warn({ name }, 'still not found after re-list — giving up this category');
        } catch (innerErr) {
          this.logger.error({ name, err: errMsg(innerErr) }, 'failed to re-list after slug conflict');
        }
        return null;
      }
      this.logger.error({ name, err: errMsg(err) }, 'auto-create collection failed');
      return null;
    }
  }

  /** All collections this resolver created during the current run. */
  getCreated(): Collection[] {
    return [...this.created];
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
