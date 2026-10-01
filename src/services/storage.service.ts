import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "../env.js";
import { AppError } from "../lib/errors.js";
export class StorageService {
  private readonly client: S3Client;
  constructor(
    private readonly env: Env,
    private readonly bucket: R2Bucket,
  ) {
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  publicUrl(key: string) {
    return `${this.env.S3_PUBLIC_BASE_URL.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  async uploadUrl(key: string, size: number) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.env.S3_BUCKET,
        Key: key,
        ContentType: "application/octet-stream",
        ContentLength: size,
        CacheControl: "no-store",
      }),
      {
        expiresIn: 300,
        signableHeaders: new Set([
          "content-length",
          "content-type",
          "cache-control",
        ]),
      },
    );
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
      ? Buffer.from(object.checksums.sha256).toString("hex")
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
