import { describe, expect, it } from "vitest";
import { presignPutObject } from "../src/services/storage.service.js";

/**
 * Golden vectors generated with `@aws-sdk/s3-request-presigner` before the AWS
 * SDK was removed from the Worker bundle. They pin the SigV4 canonicalisation
 * (header order, RFC 3986 encoding, query sorting) so the hand-rolled signer
 * cannot drift away from what R2 accepts.
 */
const sign = (
  key: string,
  size: number,
  now: string,
): Promise<string> =>
  presignPutObject({
    endpoint: "https://acc.r2.cloudflarestorage.com",
    region: "auto",
    bucket: "gekichumai-backups",
    key,
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    contentLength: size,
    expiresIn: 300,
    now: new Date(now),
  });

describe("S3 presigned upload URLs", () => {
  it("matches the AWS SDK output for a typical backup upload", async () => {
    await expect(
      sign(
        "backup-uploads/123e4567-e89b-12d3-a456-426614174000",
        1024,
        "2026-10-27T03:00:00.000Z",
      ),
    ).resolves.toBe(
      "https://acc.r2.cloudflarestorage.com/gekichumai-backups/backup-uploads/123e4567-e89b-12d3-a456-426614174000?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIDEXAMPLE%2F20261027%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261027T030000Z&X-Amz-Expires=300&X-Amz-Signature=89e89d81931ad015f603e7e48622f53c4af49968588fd47a1464b20611ea4f78&X-Amz-SignedHeaders=cache-control%3Bcontent-length%3Bcontent-type%3Bhost&x-id=PutObject",
    );
  });
  it("matches the AWS SDK at the 64 MiB upload ceiling", async () => {
    await expect(
      sign(
        "backup-uploads/ffffffff-ffff-4fff-8fff-ffffffffffff",
        67108864,
        "2026-12-31T23:59:59.000Z",
      ),
    ).resolves.toBe(
      "https://acc.r2.cloudflarestorage.com/gekichumai-backups/backup-uploads/ffffffff-ffff-4fff-8fff-ffffffffffff?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIDEXAMPLE%2F20261231%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261231T235959Z&X-Amz-Expires=300&X-Amz-Signature=c0e91310ae3b7d708719d6155ecb9a57ad94eee1ad0b94f07c93a2da09bc0ca8&X-Amz-SignedHeaders=cache-control%3Bcontent-length%3Bcontent-type%3Bhost&x-id=PutObject",
    );
  });
  it("escapes keys the way SigV4 requires", async () => {
    await expect(sign("a b/c+d/e~f", 7, "2027-02-28T08:00:00.000Z")).resolves.toBe(
      "https://acc.r2.cloudflarestorage.com/gekichumai-backups/a%20b/c%2Bd/e~f?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=AKIDEXAMPLE%2F20270228%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20270228T080000Z&X-Amz-Expires=300&X-Amz-Signature=060bb0b85da7ecb3c33e802929103930b6fd08cf7d08ea2cdbe1f24228817124&X-Amz-SignedHeaders=cache-control%3Bcontent-length%3Bcontent-type%3Bhost&x-id=PutObject",
    );
  });
});
