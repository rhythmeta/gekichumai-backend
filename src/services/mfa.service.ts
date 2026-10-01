import { inject, injectable } from "tsyringe";
import * as OTPAuth from "otpauth";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { TOKENS } from "../di/tokens.js";
import { Database, nowISO, type User } from "../db/database.js";
import type { Env } from "../env.js";
import { AppError } from "../lib/errors.js";
import { sha256Hex } from "../lib/crypto.js";
import { AuthService } from "./auth.service.js";

type Totp = { secretBase32: string; enabledAt: string | null };
type Passkey = {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: number[];
  counter: number;
  transports: string;
  rpId: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
};
type PasskeyPayload = {
  challenge?: string;
  rpId: string;
  origin: string;
  channel: string;
  allowIds?: string[];
};

@injectable()
export class MfaService {
  constructor(
    @inject(TOKENS.Database) private readonly db: Database,
    @inject(TOKENS.Env) private readonly env: Env,
    @inject(AuthService) private readonly auth: AuthService,
  ) {}
  async status(userId: string) {
    const row = await this.db.get<{
      totpEnabled: number;
      passkeyCount: number;
      backupCodeCount: number;
    }>(
      `SELECT
      EXISTS(SELECT 1 FROM user_totp_credentials WHERE userId=? AND enabledAt IS NOT NULL) AS totpEnabled,
      (SELECT COUNT(*) FROM user_passkey_credentials WHERE userId=?) AS passkeyCount,
      (SELECT COUNT(*) FROM user_mfa_backup_codes WHERE userId=? AND consumedAt IS NULL) AS backupCodeCount`,
      userId,
      userId,
      userId,
    );
    return {
      ...row!,
      totpEnabled: Boolean(row!.totpEnabled),
      mfaEnabled: Boolean(row!.totpEnabled || row!.passkeyCount),
    };
  }
  async shouldEnforceMfa(userId: string) {
    return (await this.status(userId)).mfaEnabled;
  }
  async createLoginChallenge(user: User, channel: "web" | "app") {
    const status = await this.status(user.id);
    return {
      challengeToken: await this.auth.createChallenge("mfa", user.id, {
        channel,
        rpId: this.env.WEBAUTHN_RP_ID,
        origin: this.env.WEBAUTHN_ORIGIN,
      }),
      methods: {
        totp: status.totpEnabled,
        passkey: status.passkeyCount > 0,
        backupCode: status.backupCodeCount > 0,
      },
    };
  }
  private totp(secret: string, email: string) {
    return new OTPAuth.TOTP({
      issuer: "Rhythmeta",
      label: email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(secret),
    });
  }
  async startTotpSetup(user: User) {
    const existing = await this.db.get<Totp>(
      "SELECT * FROM user_totp_credentials WHERE userId=?",
      user.id,
    );
    if (existing?.enabledAt)
      throw new AppError(
        409,
        "totp_already_enabled",
        "Disable the current TOTP before replacing it.",
      );
    const secretBase32 = new OTPAuth.Secret({ size: 20 }).base32,
      now = nowISO();
    await this.db.run(
      `INSERT INTO user_totp_credentials(id,userId,secretBase32,createdAt,updatedAt) VALUES(?,?,?,?,?)
      ON CONFLICT(userId) DO UPDATE SET secretBase32=excluded.secretBase32,updatedAt=excluded.updatedAt WHERE enabledAt IS NULL`,
      crypto.randomUUID(),
      user.id,
      secretBase32,
      now,
      now,
    );
    return {
      secretBase32,
      otpauthUrl: this.totp(secretBase32, user.email).toString(),
    };
  }
  async confirmTotpSetup(user: User, code: string) {
    const credential = await this.db.get<Totp>(
      "SELECT * FROM user_totp_credentials WHERE userId=?",
      user.id,
    );
    if (
      !credential ||
      this.totp(credential.secretBase32, user.email).validate({
        token: code.trim(),
        window: 1,
      }) === null
    )
      throw new AppError(400, "invalid_totp_code", "TOTP code is invalid.");
    await this.db.run(
      "UPDATE user_totp_credentials SET enabledAt=?,updatedAt=? WHERE userId=?",
      nowISO(),
      nowISO(),
      user.id,
    );
    return { enabled: true };
  }
  async disableTotp(userId: string) {
    await this.db.batch([
      this.db.statement(
        "DELETE FROM user_totp_credentials WHERE userId=?",
        userId,
      ),
      this.db.statement(
        "DELETE FROM user_mfa_backup_codes WHERE userId=?",
        userId,
      ),
    ]);
    return { disabled: true };
  }
  async getBackupCodeStatus(userId: string) {
    return this.db.get<{
      activeCount: number;
      latestGeneratedAt: string | null;
    }>(
      "SELECT COUNT(*) AS activeCount,MAX(createdAt) AS latestGeneratedAt FROM user_mfa_backup_codes WHERE userId=? AND consumedAt IS NULL",
      userId,
    );
  }
  async regenerateBackupCodes(userId: string) {
    if (!(await this.status(userId)).totpEnabled)
      throw new AppError(400, "totp_not_enabled", "TOTP is not enabled.");
    const codes = Array.from({ length: 10 }, () =>
      Buffer.from(crypto.getRandomValues(new Uint8Array(4)))
        .toString("hex")
        .toUpperCase()
        .replace(/(.{4})(.{4})/, "$1-$2"),
    );
    const now = nowISO();
    const statements = await Promise.all(
      codes.map(async (code) =>
        this.db.statement(
          "INSERT INTO user_mfa_backup_codes(id,userId,codeHash,createdAt) VALUES(?,?,?,?)",
          crypto.randomUUID(),
          userId,
          await sha256Hex(code.replaceAll("-", "")),
          now,
        ),
      ),
    );
    await this.db.batch([
      this.db.statement(
        "DELETE FROM user_mfa_backup_codes WHERE userId=?",
        userId,
      ),
      ...statements,
    ]);
    return { codes, activeCount: codes.length, generatedAt: now };
  }
  async verifyTotpLogin(token: string, code: string) {
    const challenge = await this.auth.getChallenge(token, "mfa"),
      user = await this.auth.findActiveUserById(challenge.userId!);
    const credential = await this.db.get<Totp>(
      "SELECT * FROM user_totp_credentials WHERE userId=?",
      user.id,
    );
    if (
      !credential?.enabledAt ||
      this.totp(credential.secretBase32, user.email).validate({
        token: code.trim(),
        window: 1,
      }) === null
    )
      throw new AppError(400, "invalid_totp_code", "TOTP code is invalid.");
    await this.auth.consumeChallengeId(challenge.id);
    return user;
  }
  async verifyBackupCodeLogin(token: string, code: string) {
    const challenge = await this.auth.getChallenge(token, "mfa"),
      now = nowISO();
    const user = await this.auth.findActiveUserById(challenge.userId!);
    if (!(await this.status(user.id)).totpEnabled)
      throw new AppError(400, "totp_not_enabled", "TOTP is not enabled.");
    const codeHash = await sha256Hex(
      code
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, ""),
    );
    const results = await this.db.batch([
      this.db.statement(
        `UPDATE user_mfa_backup_codes SET consumedAt=? WHERE userId=? AND codeHash=? AND consumedAt IS NULL
        AND EXISTS(SELECT 1 FROM auth_challenges WHERE id=? AND consumedAt IS NULL AND expiresAt>?)`,
        now,
        user.id,
        codeHash,
        challenge.id,
        now,
      ),
      this.db.statement(
        "UPDATE auth_challenges SET consumedAt=? WHERE id=? AND consumedAt IS NULL AND changes()=1",
        now,
        challenge.id,
      ),
    ]);
    if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1)
      throw new AppError(
        400,
        "invalid_backup_code",
        "Backup code or challenge is invalid.",
      );
    return user;
  }
  private summary(row: Passkey) {
    return {
      credentialId: row.credentialId,
      name: row.name,
      transports: JSON.parse(row.transports),
      rpId: row.rpId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  async listPasskeys(userId: string) {
    return {
      passkeys: (
        await this.db.all<Passkey>(
          "SELECT * FROM user_passkey_credentials WHERE userId=? ORDER BY createdAt DESC",
          userId,
        )
      ).map((row) => this.summary(row)),
    };
  }
  async startPasskeyRegistration(user: User): Promise<Record<string, unknown>> {
    const credentials = await this.db.all<Passkey>(
      "SELECT * FROM user_passkey_credentials WHERE userId=? AND rpId=?",
      user.id,
      this.env.WEBAUTHN_RP_ID,
    );
    const options = await generateRegistrationOptions({
      rpID: this.env.WEBAUTHN_RP_ID,
      rpName: this.env.WEBAUTHN_RP_NAME,
      userID: new TextEncoder().encode(user.id),
      userName: user.email,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      excludeCredentials: credentials.map((row) => ({ id: row.credentialId })),
    });
    await this.auth.createChallenge("passkey_registration", user.id, {
      challenge: options.challenge,
      rpId: this.env.WEBAUTHN_RP_ID,
      origin: this.env.WEBAUTHN_ORIGIN,
    });
    return options as unknown as Record<string, unknown>;
  }
  async finishPasskeyRegistration(userId: string, response: unknown) {
    const row = await this.db.get<{ id: string; payload: string }>(
      "SELECT id,payload FROM auth_challenges WHERE userId=? AND kind=? AND consumedAt IS NULL AND expiresAt>? ORDER BY createdAt DESC LIMIT 1",
      userId,
      "passkey_registration",
      nowISO(),
    );
    if (!row)
      throw new AppError(
        400,
        "passkey_challenge_missing",
        "Passkey challenge not found.",
      );
    const payload = JSON.parse(row.payload) as PasskeyPayload;
    const result = await verifyRegistrationResponse({
      response: response as Parameters<
        typeof verifyRegistrationResponse
      >[0]["response"],
      expectedChallenge: payload.challenge!,
      expectedOrigin: payload.origin,
      expectedRPID: payload.rpId,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo)
      throw new AppError(
        400,
        "passkey_registration_failed",
        "Passkey registration failed.",
      );
    const credential = result.registrationInfo.credential,
      now = nowISO();
    await this.auth.consumeChallengeId(row.id);
    await this.db.run(
      "INSERT INTO user_passkey_credentials(id,userId,credentialId,publicKey,counter,transports,rpId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)",
      crypto.randomUUID(),
      userId,
      credential.id,
      credential.publicKey,
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      payload.rpId,
      now,
      now,
    );
    return {
      success: true,
      passkey: this.summary(
        (await this.db.get<Passkey>(
          "SELECT * FROM user_passkey_credentials WHERE credentialId=?",
          credential.id,
        ))!,
      ),
    };
  }
  async renamePasskey(userId: string, credentialId: string, name: string) {
    const row = await this.db.get<Passkey>(
      "UPDATE user_passkey_credentials SET name=?,updatedAt=? WHERE userId=? AND credentialId=? RETURNING *",
      name.trim(),
      nowISO(),
      userId,
      credentialId,
    );
    if (!row)
      throw new AppError(404, "passkey_not_found", "Passkey not found.");
    return { updated: true, passkey: this.summary(row) };
  }
  async removePasskey(userId: string, credentialId: string) {
    return {
      deleted:
        (
          await this.db.run(
            "DELETE FROM user_passkey_credentials WHERE userId=? AND credentialId=?",
            userId,
            credentialId,
          )
        ).meta.changes > 0,
    };
  }
  async startPasskeyLogin(token: string): Promise<Record<string, unknown>> {
    const challenge = await this.auth.getChallenge(token, "mfa");
    const payload = JSON.parse(challenge.payload) as PasskeyPayload;
    const credentials = await this.db.all<Passkey>(
      "SELECT * FROM user_passkey_credentials WHERE userId=? AND rpId=?",
      challenge.userId!,
      payload.rpId,
    );
    if (!credentials.length)
      throw new AppError(
        400,
        "passkey_not_configured",
        "No passkey is available for this domain.",
      );
    const options = await generateAuthenticationOptions({
      rpID: payload.rpId,
      userVerification: "required",
      allowCredentials: credentials.map((row) => ({ id: row.credentialId })),
    });
    await this.db.run(
      "UPDATE auth_challenges SET payload=? WHERE id=? AND consumedAt IS NULL",
      JSON.stringify({
        ...payload,
        challenge: options.challenge,
        allowIds: credentials.map((row) => row.credentialId),
      }),
      challenge.id,
    );
    return options as unknown as Record<string, unknown>;
  }
  async startDirectPasskeyLogin(channel: "web" | "app") {
    const options = await generateAuthenticationOptions({
      rpID: this.env.WEBAUTHN_RP_ID,
      userVerification: "required",
    });
    const challengeToken = await this.auth.createChallenge(
      "passkey_login",
      null,
      {
        challenge: options.challenge,
        rpId: this.env.WEBAUTHN_RP_ID,
        origin: this.env.WEBAUTHN_ORIGIN,
        channel,
      },
    );
    return {
      challengeToken,
      options: options as unknown as Record<string, unknown>,
    };
  }
  async verifyPasskeyLogin(token: string, response: unknown) {
    const challenge = await this.db.get<{
      id: string;
      userId: string | null;
      kind: string;
      payload: string;
    }>(
      "SELECT * FROM auth_challenges WHERE tokenHash=? AND kind IN (?,?) AND consumedAt IS NULL AND expiresAt>?",
      await sha256Hex(token),
      "mfa",
      "passkey_login",
      nowISO(),
    );
    if (!challenge)
      throw new AppError(
        400,
        "invalid_mfa_challenge",
        "Passkey challenge is invalid.",
      );
    const payload = JSON.parse(challenge.payload) as PasskeyPayload;
    if (
      !payload.challenge ||
      typeof response !== "object" ||
      response === null ||
      !("id" in response) ||
      typeof response.id !== "string"
    )
      throw new AppError(
        400,
        "invalid_passkey_credential",
        "Invalid passkey response.",
      );
    const credential = await this.db.get<Passkey>(
      "SELECT * FROM user_passkey_credentials WHERE credentialId=? AND rpId=?",
      response.id,
      payload.rpId,
    );
    if (
      !credential ||
      (challenge.userId && credential.userId !== challenge.userId) ||
      (payload.allowIds && !payload.allowIds.includes(credential.credentialId))
    )
      throw new AppError(
        400,
        "invalid_passkey_credential",
        "Passkey is not allowed.",
      );
    const user = await this.auth.findActiveUserById(credential.userId);
    if (!user.emailVerifiedAt)
      throw new AppError(403, "email_not_verified", "Email is not verified.");
    const result = await verifyAuthenticationResponse({
      response: response as Parameters<
        typeof verifyAuthenticationResponse
      >[0]["response"],
      expectedChallenge: payload.challenge,
      expectedOrigin: payload.origin,
      expectedRPID: payload.rpId,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
      },
      requireUserVerification: true,
    });
    if (!result.verified)
      throw new AppError(
        400,
        "passkey_login_failed",
        "Passkey verification failed.",
      );
    await this.auth.consumeChallengeId(challenge.id);
    const updated = await this.db.run(
      "UPDATE user_passkey_credentials SET counter=?,updatedAt=? WHERE id=? AND counter=?",
      result.authenticationInfo.newCounter,
      nowISO(),
      credential.id,
      credential.counter,
    );
    if (updated.meta.changes !== 1)
      throw new AppError(
        409,
        "passkey_counter_changed",
        "Retry passkey authentication.",
      );
    return user;
  }
}
