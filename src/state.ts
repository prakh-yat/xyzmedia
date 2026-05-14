import { open, readFile, rename, unlink, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';

export interface ProductRecord {
  ghlProductId: string;
  ghlPriceId: string | null;
  payloadSha: string;
  priceSha: string | null;
  syncedAt: string;
}

export interface MediaRecord {
  url: string;
  sha: string;
  fileId: string | null;
}

export interface CollectionRecord {
  id: string;
  slug: string;
}

export interface SyncState {
  schemaVersion: 1;
  products: Record<string, ProductRecord>;
  medias: Record<string, MediaRecord>;
  collections: Record<string, CollectionRecord>;
}

const emptyState = (): SyncState => ({
  schemaVersion: 1,
  products: {},
  medias: {},
  collections: {},
});

class Mutex {
  private p: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const tail = this.p.then(() => fn());
    this.p = tail.then(() => undefined, () => undefined);
    return tail;
  }
}

export class StateStore {
  private state: SyncState;
  private writeMutex = new Mutex();

  private constructor(
    private readonly path: string,
    state: SyncState,
  ) {
    this.state = state;
  }

  static async load(path: string): Promise<StateStore> {
    let state: SyncState;
    try {
      const raw = await readFile(path, 'utf8');
      state = JSON.parse(raw) as SyncState;
      if (!state.schemaVersion) state = emptyState();
      // Defensive defaults if file is partial
      state.products ??= {};
      state.medias ??= {};
      state.collections ??= {};
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e?.code === 'ENOENT') {
        state = emptyState();
      } else {
        throw err;
      }
    }
    return new StateStore(path, state);
  }

  // ---- Products ----
  getProduct(code: string): ProductRecord | undefined {
    return this.state.products[code];
  }

  setProduct(code: string, rec: ProductRecord): void {
    this.state.products[code] = rec;
  }

  deleteProduct(code: string): void {
    delete this.state.products[code];
    // Also drop any cached media entries for this code so a re-sync starts
    // from a clean slate.
    for (const key of Object.keys(this.state.medias)) {
      if (key.startsWith(`${code}-`)) delete this.state.medias[key];
    }
  }

  hasProducts(): boolean {
    return Object.keys(this.state.products).length > 0;
  }

  productCount(): number {
    return Object.keys(this.state.products).length;
  }

  // ---- Medias ----
  getMedia(code: string, idx: number): MediaRecord | undefined {
    return this.state.medias[`${code}-${idx}`];
  }

  setMedia(code: string, idx: number, rec: MediaRecord): void {
    this.state.medias[`${code}-${idx}`] = rec;
  }

  // ---- Collections ----
  getCollectionByName(name: string): CollectionRecord | undefined {
    return this.state.collections[name];
  }

  setCollection(name: string, rec: CollectionRecord): void {
    this.state.collections[name] = rec;
  }

  deleteCollection(name: string): void {
    delete this.state.collections[name];
  }

  collectionNames(): string[] {
    return Object.keys(this.state.collections);
  }

  /** All products as [code, record] pairs — used by the wipe tool. */
  allProducts(): Array<[string, ProductRecord]> {
    return Object.entries(this.state.products);
  }

  /** All collections as [name, record] pairs — used by the wipe tool. */
  allCollections(): Array<[string, CollectionRecord]> {
    return Object.entries(this.state.collections);
  }

  // ---- Persistence ----
  async save(): Promise<void> {
    await this.writeMutex.run(async () => {
      await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
      const tmp = `${this.path}.tmp`;
      const json = JSON.stringify(this.state, null, 2);
      // open + write + fsync + rename for crash-safe atomic write
      const fh = await open(tmp, 'w', 0o600);
      try {
        await fh.writeFile(json);
        await fh.sync();
      } finally {
        await fh.close();
      }
      try {
        await rename(tmp, this.path);
      } catch (renameErr) {
        // Cleanup tmp on rename failure so we don't leave debris
        await unlink(tmp).catch(() => {});
        throw renameErr;
      }
      // Also chmod the final file (rename preserves mode but be defensive)
      await chmod(this.path, 0o600).catch(() => {});
    });
  }

  // For testing
  snapshot(): SyncState {
    return JSON.parse(JSON.stringify(this.state)) as SyncState;
  }
}
