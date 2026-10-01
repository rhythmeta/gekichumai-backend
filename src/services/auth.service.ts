import { compare, hash } from "bcryptjs";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../di/tokens.js";
import { Database, normalizeUser, nowISO, type User } from "../db/database.js";
import { AppError } from "../lib/errors.js";
import { JwtService } from "./jwt.service.js";
import type { Env } from "../env.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { sanitizeUsername } from "../lib/user-handle.js";
import { isPasswordComplexEnough } from "../lib/auth-validation.js";
import {
  createOpaqueRegistrationResponse,
  finishOpaqueLogin,
  hashPasswordFingerprint,
  normalizeOpaqueEnvelope,
  startOpaqueLogin,
} from "../lib/opaque-password.js";

export type AuthEmailLinkContext = {
  channel?: "web" | "app";
  redirectUri?: string;
};
export type AppAuthorization = {
  clientId: "maimaid" | "chunithmd";
  redirectUri: string;
  codeChallenge: string;
};
export type AppExchange = {
  clientId: "maimaid" | "chunithmd";
  redirectUri: string;
  codeVerifier: string;
};
export type Challenge = {
  id: string;
  userId: string | null;
  kind: string;
  payload: string;
  expiresAt: string;
  consumedAt: string | null;
};
export const APP_CALLBACKS = {
  maimaid: "maimaid://auth/callback",
  chunithmd: "chunithmd://auth/callback",
} as const;

@injectable()
export class AuthService {
  constructor(
    @inject(TOKENS.Database) readonly db: Database,
    @inject(JwtService) private readonly jwt: JwtService,
    @inject(TOKENS.Env) readonly env: Env,
  ) {}

  async findActiveUserById(id: string): Promise<User> {
    const user = await this.db.get<User>(
      "SELECT * FROM users WHERE id = ?",
      id,
    );
    if (!user || user.status !== "active")
      throw new AppError(401, "invalid_credentials", "User is not active.");
    return normalizeUser(user);
  }
  private async byEmail(email: string) {
    const row = await this.db.get<User>(
      "SELECT * FROM users WHERE email = ?",
      email.trim().toLowerCase(),
    );
    return row ? normalizeUser(row) : null;
  }
  async findActiveVerifiedUserByEmail(email: string) {
    const user = await this.byEmail(email);
    if (!user || user.status !== "active")
      throw new AppError(
        401,
        "invalid_credentials",
        "Email or password is incorrect.",
      );
    this.requireVerified(user);
    return user;
  }
  private requireVerified(user: User) {
    if (!user.emailVerifiedAt)
      throw new AppError(
        403,
        "email_not_verified",
        "Email is not verified. Please check your inbox.",
      );
  }
  async validateLoginCredentials(email: string, password: string) {
    const user = await this.byEmail(email);
    if (!user || user.status !== "active")
      throw new AppError(
        401,
        "invalid_credentials",
        "Email or password is incorrect.",
      );
    if (user.opaqueRegistrationRecord || !user.passwordHash)
      throw new AppError(
        400,
        "opaque_required",
        "This account requires OPAQUE.",
      );
    if (!(await compare(password, user.passwordHash)))
      throw new AppError(
        401,
        "invalid_credentials",
        "Email or password is incorrect.",
      );
    this.requireVerified(user);
    return user;
  }
  async startOpaqueRegistration(email: string, registrationRequest: string) {
    email = email.trim().toLowerCase();
    if (await this.byEmail(email))
      throw new AppError(409, "email_exists", "Email already exists.");
    return {
      registrationResponse: await createOpaqueRegistrationResponse({
        serverSetup: this.env.OPAQUE_SERVER_SETUP,
        userIdentifier: email,
        registrationRequest,
      }),
    };
  }
  async createUser(
    email: string,
    username: string,
    registrationRecord: string,
    passwordFingerprint: string,
  ) {
    email = email.trim().toLowerCase();
    const name = sanitizeUsername(username);
    const record = normalizeOpaqueEnvelope(registrationRecord);
    const fingerprint = await hashPasswordFingerprint(passwordFingerprint);
    // Select a free discriminator and insert in one statement; the UNIQUE constraint is authoritative.
    const id = crypto.randomUUID(),
      now = nowISO();
    try {
      await this.db.run(
        `WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n<9999)
        INSERT INTO users(id,email,username,usernameNormalized,usernameDiscriminator,opaqueRegistrationRecord,passwordFingerprintHash,createdAt,updatedAt)
        SELECT ?,?,?,?,printf('%04d',n),?,?,?,? FROM slots
        WHERE NOT EXISTS(SELECT 1 FROM users WHERE usernameNormalized=? AND usernameDiscriminator=printf('%04d',n)) LIMIT 1`,
        id,
        email,
        name.username,
        name.usernameNormalized,
        record,
        fingerprint,
        now,
        now,
        name.usernameNormalized,
      );
    } catch (error) {
      if (await this.byEmail(email))
        throw new AppError(409, "email_exists", "Email already exists.");
      throw error;
    }
    const row = await this.db.get<User>("SELECT * FROM users WHERE id=?", id);
    if (!row)
      throw new AppError(
        409,
        "username_slots_exhausted",
        "This username has no discriminator slots left.",
      );
    return normalizeUser(row);
  }
  async finishOpaqueRegistration(
    email: string,
    username: string,
    registrationRecord: string,
    passwordFingerprint: string,
    context?: AuthEmailLinkContext,
  ) {
    const user = await this.createUser(
      email,
      username,
      registrationRecord,
      passwordFingerprint,
    );
    return {
      user,
      verificationEmailSent: await this.sendAuthEmail(user, "verify", context),
    };
  }
  async startOpaqueLogin(email: string, startLoginRequest: string) {
    const user = await this.findActiveVerifiedUserByEmail(email);
    if (!user.opaqueRegistrationRecord)
      return { protocol: "legacy-bcrypt" as const };
    const result = await startOpaqueLogin({
      serverSetup: this.env.OPAQUE_SERVER_SETUP,
      userIdentifier: user.email,
      registrationRecord: user.opaqueRegistrationRecord,
      startLoginRequest,
    });
    const challengeToken = await this.createChallenge("opaque", user.id, {
      serverLoginState: result.serverLoginState,
    });
    return {
      protocol: "opaque" as const,
      challengeToken,
      loginResponse: result.loginResponse,
    };
  }
  async finishOpaqueLogin(token: string, finishLoginRequest: string) {
    const challenge = await this.consumeChallenge(token, "opaque");
    await finishOpaqueLogin({
      serverLoginState: JSON.parse(challenge.payload).serverLoginState,
      finishLoginRequest,
    });
    const user = await this.findActiveUserById(challenge.userId!);
    this.requireVerified(user);
    return user;
  }
  async startPasswordEnrollmentOpaque(
    userId: string,
    registrationRequest: string,
  ) {
    const user = await this.findActiveUserById(userId);
    return {
      registrationResponse: await createOpaqueRegistrationResponse({
        serverSetup: this.env.OPAQUE_SERVER_SETUP,
        userIdentifier: user.email,
        registrationRequest,
      }),
    };
  }
  async finishPasswordEnrollmentOpaque(
    userId: string,
    registrationRecord: string,
    passwordFingerprint: string,
  ) {
    const user = await this.findActiveUserById(userId),
      fingerprint = await hashPasswordFingerprint(passwordFingerprint);
    if (fingerprint === user.passwordFingerprintHash)
      throw new AppError(
        400,
        "password_reused",
        "New password must differ from the current password.",
      );
    await this.setPassword(
      userId,
      null,
      normalizeOpaqueEnvelope(registrationRecord),
      fingerprint,
    );
  }
  private async setPassword(
    userId: string,
    passwordHash: string | null,
    record: string | null,
    fingerprint: string | null,
  ) {
    const now = nowISO();
    await this.db.batch([
      this.db.statement(
        "UPDATE users SET passwordHash=?,opaqueRegistrationRecord=?,passwordFingerprintHash=?,authVersion=authVersion+1,updatedAt=? WHERE id=?",
        passwordHash,
        record,
        fingerprint,
        now,
        userId,
      ),
      this.db.statement(
        "UPDATE refresh_tokens SET revokedAt=? WHERE userId=? AND revokedAt IS NULL",
        now,
        userId,
      ),
      this.db.statement(
        "UPDATE auth_challenges SET consumedAt=? WHERE userId=? AND consumedAt IS NULL",
        now,
        userId,
      ),
    ]);
  }
  async updateUsername(userId: string, username: string) {
    const user = await this.findActiveUserById(userId),
      name = sanitizeUsername(username);
    if (user.usernameNormalized === name.usernameNormalized)
      await this.db.run(
        "UPDATE users SET username=?,updatedAt=? WHERE id=?",
        name.username,
        nowISO(),
        userId,
      );
    else {
      const result = await this.db.get<User>(
        `WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n<9999)
        UPDATE users SET username=?,usernameNormalized=?,updatedAt=?,usernameDiscriminator=(SELECT printf('%04d',n) FROM slots WHERE NOT EXISTS(SELECT 1 FROM users WHERE usernameNormalized=? AND usernameDiscriminator=printf('%04d',n)) LIMIT 1)
        WHERE id=? AND EXISTS(SELECT 1 FROM slots WHERE NOT EXISTS(SELECT 1 FROM users WHERE usernameNormalized=? AND usernameDiscriminator=printf('%04d',n))) RETURNING *`,
        name.username,
        name.usernameNormalized,
        nowISO(),
        name.usernameNormalized,
        userId,
        name.usernameNormalized,
      );
      if (!result)
        throw new AppError(
          409,
          "username_slots_exhausted",
          "No available username slot.",
        );
    }
    return this.findActiveUserById(userId);
  }
  async createChallenge(
    kind: string,
    userId: string | null,
    payload: unknown,
    ttlSeconds = this.env.MFA_CHALLENGE_TTL_SECONDS,
  ) {
    const token = randomToken(36),
      now = nowISO();
    await this.db.run(
      "INSERT INTO auth_challenges(id,userId,kind,tokenHash,payload,expiresAt,createdAt) VALUES(?,?,?,?,?,?,?)",
      crypto.randomUUID(),
      userId,
      kind,
      await sha256Hex(token),
      JSON.stringify(payload),
      new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      now,
    );
    return token;
  }
  async getChallenge(token: string, kind: string) {
    const row = await this.db.get<Challenge>(
      "SELECT * FROM auth_challenges WHERE tokenHash=? AND kind=? AND consumedAt IS NULL AND expiresAt>?",
      await sha256Hex(token),
      kind,
      nowISO(),
    );
    if (!row)
      throw new AppError(
        400,
        "invalid_challenge",
        "Challenge is expired or already used.",
      );
    return row;
  }
  async consumeChallenge(token: string, kind: string) {
    const now = nowISO();
    const row = await this.db.get<Challenge>(
      "UPDATE auth_challenges SET consumedAt=? WHERE tokenHash=? AND kind=? AND consumedAt IS NULL AND expiresAt>? RETURNING *",
      now,
      await sha256Hex(token),
      kind,
      now,
    );
    if (!row)
      throw new AppError(
        400,
        "invalid_challenge",
        "Challenge is expired or already used.",
      );
    return row;
  }
  async consumeChallengeId(id: string) {
    const now = nowISO();
    const result = await this.db.run(
      "UPDATE auth_challenges SET consumedAt=? WHERE id=? AND consumedAt IS NULL AND expiresAt>?",
      now,
      id,
      now,
    );
    if (result.meta.changes !== 1)
      throw new AppError(
        400,
        "invalid_challenge",
        "Challenge is expired or already used.",
      );
  }
  async issueTokensForUser(user: User) {
    const accessToken = await this.jwt.signAccessToken({
      sub: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      authVersion: user.authVersion,
    });
    const refreshToken = randomToken();
    await this.db.run(
      "INSERT INTO refresh_tokens(id,userId,tokenHash,expiresAt,createdAt) VALUES(?,?,?,?,?)",
      crypto.randomUUID(),
      user.id,
      await sha256Hex(refreshToken),
      new Date(
        Date.now() + this.env.JWT_REFRESH_TTL_SECONDS * 1000,
      ).toISOString(),
      nowISO(),
    );
    return {
      accessToken,
      refreshToken,
      expiresIn: this.env.JWT_ACCESS_TTL_SECONDS,
    };
  }
  async refresh(token: string) {
    const now = nowISO();
    const row = await this.db.get<{ userId: string }>(
      "UPDATE refresh_tokens SET revokedAt=? WHERE tokenHash=? AND revokedAt IS NULL AND expiresAt>? RETURNING userId",
      now,
      await sha256Hex(token),
      now,
    );
    if (!row)
      throw new AppError(
        401,
        "invalid_refresh_token",
        "Invalid refresh token.",
      );
    const user = await this.findActiveUserById(row.userId);
    return { user, tokens: await this.issueTokensForUser(user) };
  }
  async logout(token: string) {
    await this.db.run(
      "UPDATE refresh_tokens SET revokedAt=? WHERE tokenHash=? AND revokedAt IS NULL",
      nowISO(),
      await sha256Hex(token),
    );
  }
  async createSessionCodeForUser(userId: string, request: AppAuthorization) {
    if (
      APP_CALLBACKS[request.clientId] !== request.redirectUri ||
      !/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge)
    )
      throw new AppError(
        400,
        "invalid_authorization",
        "Invalid application authorization.",
      );
    return this.createChallenge("app_code", userId, request, 120);
  }
  async exchangeSessionCode(code: string, request: AppExchange) {
    const challenge = await this.getChallenge(code, "app_code");
    const expected = JSON.parse(challenge.payload) as AppAuthorization;
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(request.codeVerifier))
      throw new AppError(400, "invalid_pkce", "Invalid code verifier.");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(request.codeVerifier),
    );
    const actual = Buffer.from(digest).toString("base64url");
    if (
      expected.clientId !== request.clientId ||
      expected.redirectUri !== request.redirectUri ||
      expected.codeChallenge !== actual
    )
      throw new AppError(
        400,
        "invalid_pkce",
        "Authorization binding does not match.",
      );
    await this.consumeChallengeId(challenge.id);
    const user = await this.findActiveUserById(challenge.userId!);
    this.requireVerified(user);
    return { user, tokens: await this.issueTokensForUser(user) };
  }
  async resendVerification(email: string, context?: AuthEmailLinkContext) {
    const user = await this.byEmail(email);
    return {
      verificationEmailSent:
        !user ||
        Boolean(user.emailVerifiedAt) ||
        (await this.sendAuthEmail(user, "verify", context)),
    };
  }
  async verifyEmail(token: string) {
    const row = await this.consumeChallenge(token, "verify");
    await this.db.run(
      "UPDATE users SET emailVerifiedAt=?,updatedAt=? WHERE id=?",
      nowISO(),
      nowISO(),
      row.userId!,
    );
    return this.findActiveUserById(row.userId!);
  }
  async forgotPassword(email: string, context?: AuthEmailLinkContext) {
    const user = await this.byEmail(email);
    return {
      resetEmailSent:
        !user || (await this.sendAuthEmail(user, "reset", context)),
    };
  }
  async validatePasswordResetToken(token: string) {
    const row = await this.getChallenge(token, "reset");
    return { email: (await this.findActiveUserById(row.userId!)).email };
  }
  async startOpaquePasswordReset(token: string, registrationRequest: string) {
    const { email } = await this.validatePasswordResetToken(token);
    return {
      email,
      registrationResponse: await createOpaqueRegistrationResponse({
        serverSetup: this.env.OPAQUE_SERVER_SETUP,
        userIdentifier: email,
        registrationRequest,
      }),
    };
  }
  async finishOpaquePasswordReset(
    token: string,
    registrationRecord: string,
    passwordFingerprint: string,
  ) {
    const challenge = await this.getChallenge(token, "reset");
    const user = await this.findActiveUserById(challenge.userId!);
    const fingerprint = await hashPasswordFingerprint(passwordFingerprint),
      record = normalizeOpaqueEnvelope(registrationRecord);
    if (fingerprint === user.passwordFingerprintHash)
      throw new AppError(
        400,
        "password_reused",
        "New password must differ from the current password.",
      );
    await this.consumeChallengeId(challenge.id);
    await this.setPassword(user.id, null, record, fingerprint);
  }
  async resetPassword(token: string, password: string) {
    const challenge = await this.getChallenge(token, "reset"),
      user = await this.findActiveUserById(challenge.userId!);
    if (user.opaqueRegistrationRecord)
      throw new AppError(400, "opaque_required", "Use OPAQUE password reset.");
    if (!isPasswordComplexEnough(password))
      throw new AppError(
        400,
        "invalid_password",
        "Password does not meet complexity requirements.",
      );
    if (user.passwordHash && (await compare(password, user.passwordHash)))
      throw new AppError(
        400,
        "password_reused",
        "New password must differ from the current password.",
      );
    const passwordHash = await hash(password, 12);
    await this.consumeChallengeId(challenge.id);
    await this.setPassword(user.id, passwordHash, null, null);
  }
  private async sendAuthEmail(
    user: User,
    kind: "verify" | "reset",
    context?: AuthEmailLinkContext,
  ) {
    if (!this.env.RESEND_API_KEY) return false;
    const token = await this.createChallenge(
      kind,
      user.id,
      {},
      kind === "verify" ? 3600 : 900,
    );
    const url = new URL("/", this.env.APP_PUBLIC_URL);
    url.searchParams.set(
      "authAction",
      kind === "verify" ? "verify-email" : "reset-password",
    );
    url.searchParams.set("token", token);
    if (
      context?.channel === "app" &&
      Object.values(APP_CALLBACKS).includes(
        context.redirectUri as typeof APP_CALLBACKS.maimaid,
      )
    ) {
      url.searchParams.set("client", "app");
      url.searchParams.set("redirect_uri", context.redirectUri!);
    }
    const action =
      kind === "verify" ? "Verify your email" : "Reset your password";
    const escaped = url
      .toString()
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;");
    try {
      return (
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: this.env.RESEND_FROM_EMAIL,
            to: [user.email],
            subject: `Rhythmeta — ${action}`,
            html: `<p>${action}</p><p><a href="${escaped}">${action}</a></p><p>If you did not request this email, you can ignore it.</p>`,
          }),
        })
      ).ok;
    } catch {
      return false;
    }
  }
}
