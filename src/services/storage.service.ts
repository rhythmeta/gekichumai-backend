import type { Env } from "../env.js";
import { AppError } from "../lib/errors.js";

const encoder = new TextEncoder();

/** RFC 3986 encoding as required by SigV4. */
const uriEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const sha256Hex = async (value: string): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const hmacSha256 = async (
  key: Uint8Array<ArrayBuffer>,
  value: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)),
  );
};

// Sorted by header name, which is what the canonical request requires.
const SIGNED_HEADERS = [
  "cache-control",
  "content-length",
  "content-type",
  "host",
] as const;

/**
 * Builds an S3 SigV4 query-string presigned PUT URL.
 *
 * Replaces `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (~720 KB of
 * Worker bundle, and part of every cold start) with the ~1 ms of HMAC that the
 * signature actually needs. Output is byte-identical to the SDK's.
 */
export const presignPutObject = async (input: {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  contentLength: number;
  expiresIn: number;
  now: Date;
}): Promise<string> => {
  const endpoint = new URL(input.endpoint);
  const path = `/${input.bucket}/${input.key.split("/").map(uriEncode).join("/")}`;
  const amzDate = input.now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const headerValues: Record<(typeof SIGNED_HEADERS)[number], string> = {
    "cache-control": "no-store",
    "content-length": String(input.contentLength),
    "content-type": "application/octet-stream",
    host: endpoint.host,
  };
  const signedHeaders = SIGNED_HEADERS.join(";");
  const canonicalHeaders = SIGNED_HEADERS.map(
    (name) => `${name}:${headerValues[name]}\n`,
  ).join("");
  const parameters: [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(input.expiresIn)],
    ["X-Amz-SignedHeaders", signedHeaders],
    ["x-id", "PutObject"],
  ];
  const canonicalQuery = parameters
    .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
    .sort()
    .join("&");
  const canonicalRequest = [
    "PUT",
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  let signingKey: Uint8Array<ArrayBuffer> = encoder.encode(
    `AWS4${input.secretAccessKey}`,
  );
  for (const part of [dateStamp, input.region, "s3", "aws4_request"])
    signingKey = await hmacSha256(signingKey, part);
  const signature = toHex(
    await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey(
        "raw",
        signingKey,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
      encoder.encode(stringToSign),
    ),
  );
  const query = [
    ...parameters,
    ["X-Amz-Signature", signature] as [string, string],
  ]
    .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
    .sort()
    .join("&");
  return `${endpoint.protocol}//${endpoint.host}${path}?${query}`;
};

export class StorageService {
  constructor(
    private readonly env: Env,
    private readonly bucket: R2Bucket,
  ) {}
  publicUrl(key: string) {
    return `${this.env.S3_PUBLIC_BASE_URL.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  async uploadUrl(key: string, size: number) {
    return presignPutObject({
      endpoint: this.env.S3_ENDPOINT,
      region: this.env.S3_REGION,
      bucket: this.env.S3_BUCKET,
      key,
      accessKeyId: this.env.S3_ACCESS_KEY_ID,
      secretAccessKey: this.env.S3_SECRET_ACCESS_KEY,
      contentLength: size,
      expiresIn: 300,
      now: new Date(),
    });
  }
  async finalize(
    uploadKey: string,
    objectKey: string,
    size: number,
    sha256: string,
  ) {
    const existing = await this.bucket.head(objectKey);
    if (existing) {
      this.verify(existing, size, sha256);
      return;
    }
    const source = await this.bucket.get(uploadKey);
    if (!source)
      throw new AppError(409, "upload_missing", "Upload has not completed.");
    if (source.size !== size) {
      await source.body.cancel();
      throw new AppError(
        400,
        "backup_size_mismatch",
        "Backup size does not match.",
      );
    }
    // R2 checks the supplied SHA-256 while streaming; the Worker never buffers the backup.
    const result = await this.bucket.put(objectKey, source.body, {
      sha256,
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/octet-stream",
        cacheControl: "no-store",
      },
    });
    if (!result) {
      const committed = await this.bucket.head(objectKey);
      if (!committed)
        throw new AppError(
          409,
          "backup_commit_conflict",
          "Retry backup commit.",
        );
      this.verify(committed, size, sha256);
    }
  }
  private verify(object: R2Object, size: number, sha256: string) {
    const hash = object.checksums.sha256
      ? toHex(object.checksums.sha256)
      : null;
    if (object.size !== size || hash !== sha256)
      throw new AppError(
        409,
        "backup_checksum_mismatch",
        "Backup checksum does not match.",
      );
  }
  async delete(key: string) {
    if (
      !/^backups\/(?:maimaid|chunithmd)\/[a-f0-9-]+\.pb\.gz$/.test(key) &&
      !/^backup-uploads\/[a-f0-9-]+$/.test(key)
    )
      throw new Error("Refusing to delete outside backup prefixes");
    await this.bucket.delete(key);
  }
}
