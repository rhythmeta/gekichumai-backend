import { inject, injectable } from "tsyringe";
import { TOKENS } from "../di/tokens.js";
import { Database, nowISO, type User } from "../db/database.js";
import { AuthService } from "./auth.service.js";
import {
  buildUsernameBaseFromEmail,
  serializeUserIdentity,
} from "../lib/user-handle.js";
import { AppError } from "../lib/errors.js";
@injectable()
export class AdminUserService {
  constructor(
    @inject(TOKENS.Database) private readonly db: Database,
    @inject(AuthService) private readonly auth: AuthService,
  ) {}
  async listUsers(input: { limit: number; offset: number }) {
    const rows = await this.db.all<
      User & { totpEnabled: number; passkeyCount: number }
    >(
      `SELECT u.*,
   EXISTS(SELECT 1 FROM user_totp_credentials WHERE userId=u.id AND enabledAt IS NOT NULL) AS totpEnabled,
   (SELECT COUNT(*) FROM user_passkey_credentials WHERE userId=u.id) AS passkeyCount FROM users u ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
      input.limit,
      input.offset,
    );
    const total = (await this.db.get<{ total: number }>(
      "SELECT COUNT(*) AS total FROM users",
    ))!.total;
    return {
      total,
      rows: rows.map((row) => ({
        ...serializeUserIdentity({ ...row, isAdmin: Boolean(row.isAdmin) }),
        status: row.status,
        emailVerifiedAt: row.emailVerifiedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        mfa: {
          totpEnabled: Boolean(row.totpEnabled),
          passkeyCount: row.passkeyCount,
          enabled: Boolean(row.totpEnabled || row.passkeyCount),
        },
      })),
    };
  }
  startOpaqueCreateUser(input: { email: string; registrationRequest: string }) {
    return this.auth.startOpaqueRegistration(
      input.email,
      input.registrationRequest,
    );
  }
  async finishOpaqueCreateUser(input: {
    email: string;
    registrationRecord: string;
    passwordFingerprint: string;
  }) {
    const { user } = await this.auth.finishOpaqueRegistration(
      input.email,
      buildUsernameBaseFromEmail(input.email),
      input.registrationRecord,
      input.passwordFingerprint,
    );
    return { ...serializeUserIdentity(user), createdAt: user.createdAt };
  }
  async deleteUser(userId: string) {
    // Preserve attribution on community records. Disabled identities cannot authenticate.
    const result = await this.db.run(
      "UPDATE users SET status='disabled',authVersion=authVersion+1,updatedAt=? WHERE id=?",
      nowISO(),
      userId,
    );
    if (!result.meta.changes)
      throw new AppError(404, "user_not_found", "User not found.");
    await this.db.run(
      "UPDATE backups SET state='deleting' WHERE userId=?",
      userId,
    );
    return { deleted: true };
  }
}
