import { ApiError, type GhlClient } from './client.js';

export interface UploadFileResult {
  url: string;
  fileId: string;
}

export interface UploadFileOpts {
  locationId: string;
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  /** Default 25 MB (the GHL hard limit). */
  maxBytes?: number;
}

export class MediaTooLargeError extends Error {
  constructor(public readonly size: number, public readonly limit: number) {
    super(`Media file is ${size} bytes; GHL limit is ${limit} bytes`);
    this.name = 'MediaTooLargeError';
  }
}

export class MissingMediaScopeError extends Error {
  constructor() {
    super(
      'OAuth token lacks scope "medias.write". Enable it in your GHL Marketplace app, ' +
        're-run `npm run oauth-setup`, and try again.',
    );
    this.name = 'MissingMediaScopeError';
  }
}

const DEFAULT_LIMIT = 25 * 1024 * 1024;

export async function uploadFile(client: GhlClient, opts: UploadFileOpts): Promise<UploadFileResult> {
  const max = opts.maxBytes ?? DEFAULT_LIMIT;
  if (opts.bytes.byteLength > max) {
    throw new MediaTooLargeError(opts.bytes.byteLength, max);
  }
  // Construct a Blob (Node 20 has native Blob/FormData).
  // Convert via Buffer to avoid TS confusion between Uint8Array<ArrayBufferLike>
  // and the BlobPart type (which expects ArrayBuffer-backed views).
  const buf = Buffer.from(opts.bytes);
  const blob = new Blob([buf], { type: opts.contentType });
  const form = new FormData();
  // Some endpoints accept hosted=true with a fileUrl, but the multipart 'file' part is the safer path
  form.append('file', blob, opts.filename);
  form.append('name', opts.filename);
  // The marketplace docs allow optional altType/altId on the upload — include them for safety
  form.append('hosted', 'false');

  try {
    const res = await client.request<{ fileId?: string; url?: string; _id?: string }>(
      '/medias/upload-file',
      {
        method: 'POST',
        body: form,
        isFormData: true,
        query: {
          // Some tenants want this in query; including doesn't hurt.
          locationId: opts.locationId,
        },
      },
    );
    const url = res.url;
    const fileId = res.fileId ?? res._id;
    if (!url || !fileId) {
      throw new Error(`upload-file response missing url/fileId: ${JSON.stringify(res)}`);
    }
    return { url, fileId };
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      throw new MissingMediaScopeError();
    }
    throw err;
  }
}
