import { inject, injectable } from "tsyringe";
import { Database } from "../db/database.js";
import { TOKENS } from "../di/tokens.js";
import { sha256Hex } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
@injectable()
export class RateLimitService {
  constructor(@inject(TOKENS.Database) private readonly db: Database) {}
  async consume(input: {
    bucket: string;
    key: string;
    limit: number;
    windowSeconds: number;
  }) {
    const windowMs = input.windowSeconds * 1000,
      start = Math.floor(Date.now() / windowMs) * windowMs;
    const row = await this.db.get<{ count: number }>(
      `INSERT INTO rate_limit_counters(bucket,keyHash,windowStart,windowEnd,count) VALUES(?,?,?,?,1)
   ON CONFLICT(bucket,keyHash,windowStart) DO UPDATE SET count=count+1 RETURNING count`,
      input.bucket,
      await sha256Hex(input.key),
      start,
      start + windowMs,
    );
    if (row!.count > input.limit)
      throw new AppError(
        429,
        "rate_limited",
        "Too many requests. Please try again later.",
      );
  }
}
