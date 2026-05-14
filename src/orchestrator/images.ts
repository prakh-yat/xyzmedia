import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import type { Logger } from 'pino';
import type { GhlClient } from '../ghl/client.js';
import { uploadFile } from '../ghl/medias.js';
import type { StateStore } from '../state.js';
import { fetchImage } from '../trends/cdn.js';

export interface SyncImagesOpts {
  client: GhlClient;
  state: StateStore;
  locationId: string;
  code: string;
  imageCount: number;
  logger: Logger;
  dryRun: boolean;
  /** Concurrency for CDN fetch + upload. Default 10. */
  concurrency?: number;
}

const sha256 = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex');

/**
 * Fetch + upload all images for one product. Returns the GHL CDN URLs in source order.
 * Skips missing images (403/404 from CDN). Cached via state.medias.
 *
 * The returned list has gaps removed: if idx 1 was missing, you get [url_for_0, url_for_2]
 * (the product mapper renumbers these as 100109-0, 100109-1).
 */
export async function syncImagesForProduct(opts: SyncImagesOpts): Promise<string[]> {
  const { client, state, locationId, code, imageCount, logger, dryRun } = opts;
  if (imageCount <= 0) return [];

  const limit = pLimit(opts.concurrency ?? 10);
  type Slot = { idx: number; url: string | null };
  const slots: Slot[] = await Promise.all(
    Array.from({ length: imageCount }, (_, idx) =>
      limit(async (): Promise<Slot> => {
        // Cache hit?
        const cached = state.getMedia(code, idx);
        if (cached) {
          logger.info(
            { code, idx, url: cached.url },
            `· image cached for code ${code} idx=${idx} (reusing existing GHL media)`,
          );
          return { idx, url: cached.url };
        }
        // Fetch from CDN (with internal retry on transient errors)
        logger.info({ code, idx }, `→ fetching image for code ${code} idx=${idx} from CDN`);
        let img;
        try {
          img = await fetchImage(code, idx);
        } catch (err) {
          logger.warn(
            { code, idx, err: err instanceof Error ? err.message : String(err) },
            `✗ cdn fetch failed for code ${code} idx=${idx} after retries — product will be created without this image`,
          );
          return { idx, url: null };
        }
        if (!img) {
          logger.info(
            { code, idx },
            `· no image at CDN for code ${code} idx=${idx} (403/404 — slot is empty)`,
          );
          return { idx, url: null };
        }
        logger.info(
          { code, idx, size: img.bytes.byteLength, contentType: img.contentType },
          `✓ image fetched for code ${code} idx=${idx} (${img.bytes.byteLength} bytes)`,
        );
        if (dryRun) {
          logger.info({ code, idx, size: img.bytes.byteLength }, `[dry-run] would upload image code=${code} idx=${idx}`);
          return { idx, url: `dryrun://image/${code}-${idx}.jpg` };
        }
        // Upload
        const sha = sha256(img.bytes);
        try {
          const filename = `${code}-${idx}.jpg`;
          logger.info(
            { code, idx, filename, size: img.bytes.byteLength },
            `→ uploading image to store: ${filename}`,
          );
          const result = await uploadFile(client, {
            locationId,
            bytes: img.bytes,
            filename,
            contentType: img.contentType,
          });
          state.setMedia(code, idx, { url: result.url, sha, fileId: result.fileId });
          await state.save();
          logger.info(
            { code, idx, url: result.url, fileId: result.fileId },
            `✓ image uploaded for code ${code} idx=${idx} → fileId ${result.fileId}`,
          );
          return { idx, url: result.url };
        } catch (err) {
          logger.error(
            { code, idx, err: err instanceof Error ? err.message : String(err) },
            `✗ media upload failed for code ${code} idx=${idx}`,
          );
          return { idx, url: null };
        }
      }),
    ),
  );

  // Preserve source order, drop gaps
  return slots
    .sort((a, b) => a.idx - b.idx)
    .map((s) => s.url)
    .filter((u): u is string => u !== null);
}
