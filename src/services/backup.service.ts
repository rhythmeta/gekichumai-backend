import { z } from "zod";
import { Database, nowISO, type Game } from "../db/database.js";
import { StorageService } from "./storage.service.js";
import { AppError } from "../lib/errors.js";
export const createBackupSchema = z.object({
  formatVersion: z.literal(1),
  size: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024 * 1024),
  uncompressedSize: z
    .number()
    .int()
    .min(1)
    .max(512 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  deviceName: z.string().trim().min(1).max(128),
  clientVersion: z.string().min(1).max(64),
  profileCount: z.number().int().min(0).max(10000),
});
type Backup = {
  id: string;
  userId: string;
  game: Game;
  objectKey: string;
  uploadKey: string;
  state: "pending" | "committing" | "ready" | "deleting";
  formatVersion: number;
  size: number;
  uncompressedSize: number;
  sha256: string;
  deviceName: string;
  clientVersion: string;
  profileCount: number;
  createdAt: string;
  committedAt: string | null;
  leaseUntil: string | null;
  leaseToken: string | null;
};
export class BackupService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageService,
  ) {}
  async create(
    userId: string,
    game: Game,
    input: z.infer<typeof createBackupSchema>,
  ) {
    const id = crypto.randomUUID(),
      objectKey = `backups/${game}/${crypto.randomUUID()}.pb.gz`,
      uploadKey = `backup-uploads/${crypto.randomUUID()}`;
    const count = await this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM backups WHERE userId=? AND game=? AND state IN ('pending','committing')",
      userId,
      game,
    );
    if (count!.n >= 3)
      throw new AppError(
        429,
        "upload_limit",
        "Complete or cancel an existing upload first.",
      );
    const uploadUrl = await this.storage.uploadUrl(uploadKey, input.size);
    const result = await this.db.run(
      `INSERT INTO backups(id,userId,game,objectKey,uploadKey,formatVersion,size,uncompressedSize,sha256,deviceName,clientVersion,profileCount,createdAt)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM backups WHERE userId=? AND game=? AND state IN ('pending','committing'))<3`,
      id,
      userId,
      game,
      objectKey,
      uploadKey,
      input.formatVersion,
      input.size,
      input.uncompressedSize,
      input.sha256,
      input.deviceName,
      input.clientVersion,
      input.profileCount,
      nowISO(),
      userId,
      game,
    );
    if (!result.meta.changes)
      throw new AppError(429, "upload_limit", "Too many pending uploads.");
    return {
      id,
      uploadUrl,
      expiresIn: 300,
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
      },
    };
  }
  private async owned(userId: string, game: Game, id: string) {
    const row = await this.db.get<Backup>(
      "SELECT * FROM backups WHERE id=? AND userId=? AND game=?",
      id,
      userId,
      game,
    );
    if (!row) throw new AppError(404, "backup_not_found", "Backup not found.");
    return row;
  }
  private serialize(row: Backup) {
    return {
      id: row.id,
      game: row.game,
      formatVersion: row.formatVersion,
      size: row.size,
      uncompressedSize: row.uncompressedSize,
      sha256: row.sha256,
      deviceName: row.deviceName,
      clientVersion: row.clientVersion,
      profileCount: row.profileCount,
      createdAt: row.createdAt,
      committedAt: row.committedAt,
      downloadUrl: this.storage.publicUrl(row.objectKey),
    };
  }
  async list(userId: string, game: Game) {
    const rows = await this.db.all<Backup>(
      "SELECT * FROM backups WHERE userId=? AND game=? AND state='ready' ORDER BY committedAt DESC,id DESC LIMIT 3",
      userId,
      game,
    );
    return { backups: rows.map((row) => this.serialize(row)) };
  }
  async commit(userId: string, game: Game, id: string) {
    let row = await this.owned(userId, game, id);
    if (row.state === "ready") return this.serialize(row);
    const lease = crypto.randomUUID(),
      now = nowISO();
    const claimed = await this.db.run(
      "UPDATE backups SET state='committing',leaseUntil=?,leaseToken=? WHERE id=? AND userId=? AND game=? AND (state='pending' OR (state='committing' AND leaseUntil<?))",
      new Date(Date.now() + 300_000).toISOString(),
      lease,
      id,
      userId,
      game,
      now,
    );
    if (!claimed.meta.changes)
      throw new AppError(
        409,
        "backup_busy",
        "Backup is already being committed or deleted.",
      );
    try {
      await this.storage.finalize(
        row.uploadKey,
        row.objectKey,
        row.size,
        row.sha256,
      );
      const result = await this.db.batch([
        this.db.statement(
          "UPDATE backups SET state='ready',committedAt=?,leaseUntil=NULL,leaseToken=NULL WHERE id=? AND state='committing' AND leaseToken=?",
          nowISO(),
          id,
          lease,
        ),
        this.db.statement(
          "UPDATE backups SET state='deleting' WHERE id IN (SELECT id FROM backups WHERE userId=? AND game=? AND state='ready' ORDER BY committedAt DESC,id DESC LIMIT -1 OFFSET 3)",
          userId,
          game,
        ),
      ]);
      if (result[0].meta.changes !== 1)
        throw new AppError(
          409,
          "backup_commit_conflict",
          "Backup commit lease expired.",
        );
      await this.storage.delete(row.uploadKey);
      row = await this.owned(userId, game, id);
      return this.serialize(row);
    } catch (error) {
      await this.db.run(
        "UPDATE backups SET state='pending',leaseUntil=NULL,leaseToken=NULL WHERE id=? AND state='committing' AND leaseToken=?",
        id,
        lease,
      );
      throw error;
    }
  }
  async delete(userId: string, game: Game, id: string) {
    await this.owned(userId, game, id);
    const result = await this.db.run(
      "UPDATE backups SET state='deleting' WHERE id=? AND userId=? AND game=? AND state<>'committing'",
      id,
      userId,
      game,
    );
    if (!result.meta.changes)
      throw new AppError(409, "backup_busy", "Wait for the upload to finish.");
    await this.cleanup();
    return { deleted: true };
  }
  async cleanup() {
    const expired = new Date(Date.now() - 86400_000).toISOString();
    await this.db.run(
      "UPDATE backups SET state='deleting' WHERE createdAt<? AND (state='pending' OR (state='committing' AND leaseUntil<?))",
      expired,
      nowISO(),
    );
    const rows = await this.db.all<Backup>(
      "SELECT * FROM backups WHERE state='deleting' ORDER BY createdAt LIMIT 50",
    );
    for (const row of rows) {
      await this.storage.delete(row.objectKey);
      await this.storage.delete(row.uploadKey);
      await this.db.run(
        "DELETE FROM backups WHERE id=? AND state='deleting'",
        row.id,
      );
    }
  }
}
