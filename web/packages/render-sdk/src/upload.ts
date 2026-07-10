// upload.ts — media upload for conditioning workflows, pluggable + configurable.
//
// Video-gen providers only accept PUBLIC URLs for reference media (frames,
// previz clips) — never bytes. This module turns local render output into
// such URLs, with the same vendor-neutral layering as videogen.ts: the code
// ships PROTOCOL implementations only, and where the bytes actually land is
// the user's configuration and trust decision.
//
// Built-in kinds:
//   - 's3'    : the S3-compatible protocol (SigV4 PUT). Covers self-hosted
//               MinIO/Garage as well as any cloud object store speaking it —
//               a protocol, not a service.
//   - 'relay' : the simplest possible HTTP contract — POST the bytes, get
//               {url} back. Anyone can implement it in any stack (an example
//               worker lives in docs, deliberately NOT in the dependency
//               tree). A hosted deployment preconfigures one of these.
//
// No kind is configured by default: without user configuration the upload
// capability simply does not exist.

import { AwsClient } from 'aws4fetch';

export interface UploadResult {
  /** Publicly fetchable URL for the uploaded object. */
  url: string;
}

export interface UploadOptions {
  /** Basename hint (a UUID is always prepended — never trust it for identity). */
  name?: string;
  contentType?: string;
}

/** Bytes → a public URL. Any backend implements this. */
export interface MediaUploader {
  upload(data: Blob, opts?: UploadOptions): Promise<UploadResult>;
}

/** A registered upload protocol implementation. */
export interface UploaderKind {
  id: string;
  label: string;
  create(config: Record<string, unknown>): MediaUploader;
}

const KINDS = new Map<string, UploaderKind>();

export function registerUploaderKind(k: UploaderKind): void {
  KINDS.set(k.id, k);
}

export function uploaderKinds(): UploaderKind[] {
  return [...KINDS.values()];
}

export function createUploader(kindId: string, config: Record<string, unknown>): MediaUploader {
  const k = KINDS.get(kindId);
  if (!k) throw new Error(`unknown uploader kind: ${kindId} (have: ${[...KINDS.keys()].join(', ')})`);
  return k.create(config);
}

const extFor = (contentType?: string, name?: string): string => {
  const fromName = name?.match(/\.([a-z0-9]{2,5})$/i)?.[1];
  if (fromName) return fromName.toLowerCase();
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
  };
  return map[contentType ?? ''] ?? 'bin';
};

// ------------------------------------------------------------- kind: s3

export interface S3UploaderConfig {
  /** Service endpoint. Path-style stores (MinIO, R2): the service root, with
   *  `bucket` set. Virtual-host stores: the bucket domain itself, `bucket`
   *  left empty. */
  endpoint: string;
  /** Bucket name for path-style endpoints ('' when the endpoint IS the bucket). */
  bucket?: string;
  /** SigV4 region ('auto' works for R2/MinIO). */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix, e.g. 'velocut/' (a per-object UUID is always appended). */
  prefix?: string;
  /** Public base URL for reads (a public bucket / CDN). Without it, reads use
   *  a presigned GET valid for 7 days (the SigV4 maximum) — private buckets
   *  work too. */
  publicBase?: string;
}

export class S3Uploader implements MediaUploader {
  private config: S3UploaderConfig;
  private aws: AwsClient;
  constructor(config: S3UploaderConfig) {
    this.config = config;
    this.aws = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region || 'auto',
      service: 's3',
    });
  }

  private objectUrl(key: string): string {
    const base = this.config.endpoint.replace(/\/+$/, '');
    const bucket = this.config.bucket?.replace(/^\/+|\/+$/g, '');
    return bucket ? `${base}/${bucket}/${key}` : `${base}/${key}`;
  }

  async upload(data: Blob, opts?: UploadOptions): Promise<UploadResult> {
    const key = `${this.config.prefix ?? ''}${crypto.randomUUID()}.${extFor(opts?.contentType ?? data.type, opts?.name)}`;
    const target = this.objectUrl(key);
    const contentType = opts?.contentType ?? data.type ?? 'application/octet-stream';
    const resp = await this.aws.fetch(target, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: data,
    });
    if (!resp.ok) {
      throw new Error(`s3 upload failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 200)}`);
    }
    if (this.config.publicBase) {
      return { url: `${this.config.publicBase.replace(/\/+$/, '')}/${key}` };
    }
    // Private bucket: hand out a presigned GET (SigV4 caps expiry at 7 days).
    const u = new URL(target);
    u.searchParams.set('X-Amz-Expires', String(7 * 24 * 3600));
    const signed = await this.aws.sign(u.toString(), { method: 'GET', aws: { signQuery: true } });
    return { url: signed.url };
  }
}

// ---------------------------------------------------------- kind: relay

export interface RelayUploaderConfig {
  /** POST target. Contract: request body = raw bytes (content-type header set),
   *  response = JSON {url}. Auth via optional bearer token. */
  endpoint: string;
  authToken?: string;
}

export class RelayUploader implements MediaUploader {
  private config: RelayUploaderConfig;
  constructor(config: RelayUploaderConfig) {
    this.config = config;
  }

  async upload(data: Blob, opts?: UploadOptions): Promise<UploadResult> {
    const resp = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': opts?.contentType ?? data.type ?? 'application/octet-stream',
        ...(opts?.name ? { 'x-filename': encodeURIComponent(opts.name) } : {}),
        ...(this.config.authToken ? { authorization: `Bearer ${this.config.authToken}` } : {}),
      },
      body: data,
    });
    if (!resp.ok) {
      throw new Error(`relay upload failed (HTTP ${resp.status}): ${(await resp.text()).slice(0, 200)}`);
    }
    const body = (await resp.json().catch(() => ({}))) as { url?: string };
    if (!body.url) throw new Error('relay upload: response carried no {url}');
    return { url: body.url };
  }
}

registerUploaderKind({
  id: 's3',
  label: 'S3-compatible object store (SigV4 PUT)',
  create: (cfg) => new S3Uploader(cfg as unknown as S3UploaderConfig),
});
registerUploaderKind({
  id: 'relay',
  label: 'Upload relay (POST bytes → {url})',
  create: (cfg) => new RelayUploader(cfg as unknown as RelayUploaderConfig),
});
