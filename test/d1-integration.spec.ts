import "reflect-metadata";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { Database, type User } from "../src/db/database.js";
import { AuthService } from "../src/services/auth.service.js";
import { JwtService } from "../src/services/jwt.service.js";
import { CommunityAliasService } from "../src/services/community-alias.service.js";
import { BackupService } from "../src/services/backup.service.js";
import { StorageService } from "../src/services/storage.service.js";
import { parseEnv } from "../src/env.js";
import { hash } from "bcryptjs";
import * as opaque from "@serenity-kit/opaque";
let mf: Miniflare, db: Database, auth: AuthService, bucket: R2Bucket;
const env = parseEnv({
  JWT_ACCESS_SECRET: "testing-only-secret-with-at-least-32-bytes",
  OPAQUE_SERVER_SETUP: "unused",
  S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  S3_BUCKET: "test",
  S3_ACCESS_KEY_ID: "test",
  S3_SECRET_ACCESS_KEY: "test",
  S3_PUBLIC_BASE_URL: "https://assets.example.com",
});
const userId = "10000000-0000-4000-8000-000000000001";
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      compatibilityDate: "2026-10-01",
      d1Databases: ["DB"],
      r2Buckets: ["BACKUP_BUCKET"],
    }),
  );
  db = new Database((await mf.getD1Database("DB")) as unknown as D1Database);
  bucket = (await mf.getR2Bucket("BACKUP_BUCKET")) as unknown as R2Bucket;
  const sql = await readFile(
    new URL("../migrations/0001_rhythmeta.sql", import.meta.url),
    "utf8",
  );
  for (const statement of sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean))
    await db.run(statement);
  await opaque.ready;
  env.OPAQUE_SERVER_SETUP = opaque.server.createSetup();
  auth = new AuthService(db, new JwtService(env), env);
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  for (const table of [
    "backups",
    "community_alias_votes",
    "community_alias_candidates",
    "aliases",
    "auth_challenges",
    "refresh_tokens",
    "user_passkey_credentials",
    "user_totp_credentials",
    "user_mfa_backup_codes",
    "users",
  ])
    await db.run(`DELETE FROM ${table}`);
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO users(id,email,username,usernameNormalized,usernameDiscriminator,passwordHash,emailVerifiedAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)",
    userId,
    "test@example.com",
    "Test",
    "test",
    "0001",
    await hash("Example-password1!", 4),
    now,
    now,
    now,
  );
});
describe("D1 authentication", () => {
  it("preserves bcrypt logins and only rotates a refresh token once under concurrency", async () => {
    const user = await auth.validateLoginCredentials(
      "TEST@example.com",
      "Example-password1!",
    );
    expect(user.id).toBe(userId);
    const tokens = await auth.issueTokensForUser(user);
    const results = await Promise.allSettled([
      auth.refresh(tokens.refreshToken),
      auth.refresh(tokens.refreshToken),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it("binds app authorization codes to PKCE, client, and redirect URI", async () => {
    const verifier = "a".repeat(64),
      challenge = Buffer.from(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ).toString("base64url");
    const code = await auth.createSessionCodeForUser(userId, {
      clientId: "maimaid",
      redirectUri: "maimaid://auth/callback",
      codeChallenge: challenge,
    });
    await expect(
      auth.exchangeSessionCode(code, {
        clientId: "chunithmd",
        redirectUri: "chunithmd://auth/callback",
        codeVerifier: verifier,
      }),
    ).rejects.toThrow();
    const request = {
      clientId: "maimaid" as const,
      redirectUri: "maimaid://auth/callback",
      codeVerifier: verifier,
    };
    expect((await auth.exchangeSessionCode(code, request)).user.id).toBe(
      userId,
    );
    await expect(auth.exchangeSessionCode(code, request)).rejects.toThrow();
  });
  it("completes an OPAQUE registration and login without changing password parameters", async () => {
    const password = "Example-password2!",
      email = "opaque@example.com";
    const start = opaque.client.startRegistration({ password });
    const response = await auth.startOpaqueRegistration(
      email,
      start.registrationRequest,
    );
    const registration = opaque.client.finishRegistration({
      password,
      clientRegistrationState: start.clientRegistrationState,
      registrationResponse: response.registrationResponse,
    });
    const user = await auth.createUser(
      email,
      "Opaque",
      registration.registrationRecord,
      "fingerprint",
    );
    await db.run(
      "UPDATE users SET emailVerifiedAt=? WHERE id=?",
      new Date().toISOString(),
      user.id,
    );
    const login = opaque.client.startLogin({ password });
    const challenge = await auth.startOpaqueLogin(
      email,
      login.startLoginRequest,
    );
    if (challenge.protocol !== "opaque") throw new Error("Expected OPAQUE");
    const finish = opaque.client.finishLogin({
      password,
      clientLoginState: login.clientLoginState,
      loginResponse: challenge.loginResponse,
    });
    if (!finish) throw new Error("OPAQUE failed");
    expect(
      (
        await auth.finishOpaqueLogin(
          challenge.challengeToken,
          finish.finishLoginRequest,
        )
      ).id,
    ).toBe(user.id);
  });
});
describe("D1 community", () => {
  it("settles approved aliases once and isolates games", async () => {
    const now = new Date().toISOString(),
      id = crypto.randomUUID();
    await db.run(
      "INSERT INTO community_alias_candidates(id,game,songIdentifier,aliasText,aliasNorm,submitterId,status,voteCloseAt,submittedLocalDate,createdAt,updatedAt) VALUES(?,'maimaid','song','alias','alias',?,'voting',?,?,?,?)",
      id,
      userId,
      "2020-01-01T00:00:00.000Z",
      "2020-01-01",
      now,
      now,
    );
    for (let i = 0; i < 3; i++) {
      const voter = crypto.randomUUID();
      await db.run(
        "INSERT INTO users(id,email,username,usernameNormalized,usernameDiscriminator,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)",
        voter,
        `${i}@example.com`,
        "Voter",
        "voter",
        String(i),
        now,
        now,
      );
      await db.run(
        "INSERT INTO community_alias_votes VALUES(?,?,?,?,?,?)",
        crypto.randomUUID(),
        id,
        voter,
        1,
        now,
        now,
      );
    }
    const service = new CommunityAliasService(db, env, "maimaid");
    const results = await Promise.all([
      service.rollCycle(),
      service.rollCycle(),
    ]);
    expect(results.reduce((n, r) => n + r.settledCount, 0)).toBe(1);
    expect(await service.approvedSync(null, 10)).toHaveLength(1);
    expect(
      await new CommunityAliasService(db, env, "chunithmd").approvedSync(
        null,
        10,
      ),
    ).toHaveLength(0);
  });
});
describe("R2 backup commit", () => {
  it("checks ownership and checksum, preserves only three ready snapshots, and never overwrites committed bytes", async () => {
    const storage = new StorageService(env, bucket),
      backups = new BackupService(db, storage);
    const payload = new TextEncoder().encode("example backup"),
      sha256 = Buffer.from(
        await crypto.subtle.digest("SHA-256", payload),
      ).toString("hex");
    for (let i = 0; i < 4; i++) {
      const result = await backups.create(userId, "maimaid", {
        formatVersion: 1,
        size: payload.length,
        uncompressedSize: 100,
        sha256,
        deviceName: "test",
        clientVersion: "1",
        profileCount: 1,
      });
      const row = await db.get<{ uploadKey: string; objectKey: string }>(
        "SELECT * FROM backups WHERE id=?",
        result.id,
      );
      await bucket.put(row!.uploadKey, payload);
      await expect(
        backups.commit("other-user", "maimaid", result.id),
      ).rejects.toThrow();
      await backups.commit(userId, "maimaid", result.id);
      await bucket.put(row!.uploadKey, "changed");
      await backups.commit(userId, "maimaid", result.id);
      expect(await (await bucket.get(row!.objectKey))!.text()).toBe(
        "example backup",
      );
    }
    expect((await backups.list(userId, "maimaid")).backups).toHaveLength(3);
    expect((await backups.list(userId, "chunithmd")).backups).toHaveLength(0);
    await backups.cleanup();
    expect(
      (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM backups"))!.n,
    ).toBe(3);
  });
});

describe("revocation and failed commits", () => {
  it("returns a durable alias tombstone when moderation revokes approval", async () => {
    const now = new Date().toISOString(),
      id = crypto.randomUUID();
    await db.run(
      "INSERT INTO community_alias_candidates(id,game,songIdentifier,aliasText,aliasNorm,submitterId,status,submittedLocalDate,createdAt,updatedAt) VALUES(?,'maimaid','song','alias','alias',?,'approved','2026-10-01',?,?)",
      id,
      userId,
      now,
      now,
    );
    await db.run(
      "INSERT INTO aliases VALUES(?,'maimaid','song','alias','alias','community','approved',?,?)",
      id,
      now,
      now,
    );
    const service = new CommunityAliasService(db, env, "maimaid");
    await service.adminSetStatus(id, "rejected");
    expect(await service.approvedSync(new Date(), 1)).toEqual([
      expect.objectContaining({ candidateId: id, status: "rejected" }),
    ]);
    await service.adminSetStatus(id, "approved");
    expect(await service.approvedSync(null, 1)).toEqual([
      expect.objectContaining({ candidateId: id, status: "approved" }),
    ]);
  });
  it("never exposes an invalid checksum and releases the commit lease for retry", async () => {
    const backups = new BackupService(db, new StorageService(env, bucket));
    const result = await backups.create(userId, "maimaid", {
      formatVersion: 1,
      size: 3,
      uncompressedSize: 100,
      sha256: "0".repeat(64),
      deviceName: "test",
      clientVersion: "1",
      profileCount: 1,
    });
    const row = await db.get<{ uploadKey: string; objectKey: string }>(
      "SELECT * FROM backups WHERE id=?",
      result.id,
    );
    await bucket.put(row!.uploadKey, "bad");
    await expect(
      backups.commit(userId, "maimaid", result.id),
    ).rejects.toThrow();
    expect((await backups.list(userId, "maimaid")).backups).toHaveLength(0);
    expect(await bucket.head(row!.objectKey)).toBeNull();
    expect(
      await db.get(
        "SELECT state,leaseToken FROM backups WHERE id=?",
        result.id,
      ),
    ).toEqual({ state: "pending", leaseToken: null });
  });
  it("enforces the upload limit under concurrent requests", async () => {
    const backups = new BackupService(db, new StorageService(env, bucket));
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        backups.create(userId, "chunithmd", {
          formatVersion: 1,
          size: 3,
          uncompressedSize: 100,
          sha256: "0".repeat(64),
          deviceName: "test",
          clientVersion: "1",
          profileCount: 1,
        }),
      ),
    );
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(3);
  });
});
