import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
const base =
  process.env.RHYTHMETA_SMOKE_BASE ??
  "https://rhythmeta-backend-staging.cqbe.workers.dev";
let token;
async function request(path, method = "GET", body, expected = 200) {
  const response = await fetch(`${base}/${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    expected,
    `${path}: ${data.code ?? "unexpected status"}`,
  );
  return data;
}
await request("health");
const login = await request("auth/v1/login", "POST", {
  email: "migration-test@example.invalid",
  password: "Migration-test123!",
});
assert.equal(login.user.id, "ffffffff-0000-4000-8000-000000000001");
token = login.accessToken;
console.log("PASS: staging bcrypt login");
const verifier = randomBytes(32).toString("base64url"),
  challenge = createHash("sha256").update(verifier).digest("base64url");
const code = await request("auth/v1/session:create", "POST", {
  clientId: "chunithmd",
  redirectUri: "chunithmd://auth/callback",
  codeChallenge: challenge,
  codeChallengeMethod: "S256",
});
const exchanged = await request("auth/v1/session:exchange", "POST", {
  sessionCode: code.sessionCode,
  clientId: "chunithmd",
  redirectUri: "chunithmd://auth/callback",
  codeVerifier: verifier,
});
assert.equal(exchanged.user.id, login.user.id);
console.log("PASS: staging PKCE account handoff");
const fixture = await readFile(
  new URL("../test/fixtures/maimaid-v1.pb.gz", import.meta.url),
);
const sha256 = createHash("sha256").update(fixture).digest("hex");
const upload = await request(
  "maimaid/v1/backups",
  "POST",
  {
    formatVersion: 1,
    size: fixture.length,
    uncompressedSize: gunzipSync(fixture).length,
    sha256,
    deviceName: "Migration smoke test",
    clientVersion: "fixture-1",
    profileCount: 1,
  },
  201,
);
try {
  const put = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: upload.headers,
    body: fixture,
  });
  assert.equal(put.status, 200, "R2 signed upload");
  const backup = await request(
    `maimaid/v1/backups/${upload.id}/commit`,
    "POST",
  );
  const downloaded = await fetch(backup.downloadUrl, { cache: "no-store" });
  assert.equal(downloaded.status, 200, "Public download");
  assert.match(downloaded.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(
    createHash("sha256")
      .update(Buffer.from(await downloaded.arrayBuffer()))
      .digest("hex"),
    sha256,
  );
  assert.equal((await request("chunithmd/v1/backups")).backups.length, 0);
  console.log(
    "PASS: real signed R2 upload, immutable commit, public download, checksum, cache headers and game isolation",
  );
  await request(`maimaid/v1/backups/${upload.id}`, "DELETE");
  assert.equal(
    (await fetch(backup.downloadUrl, { cache: "no-store" })).status,
    404,
    "Deleted public object must disappear",
  );
  console.log("PASS: real R2 deletion");
} catch (error) {
  await request(`maimaid/v1/backups/${upload.id}`, "DELETE").catch(() => {});
  throw error;
}
const aliases = await request("maimaid/v1/community/aliases:sync");
assert.equal(aliases.complete, true);
assert(aliases.rows.some((row) => row.status === "rejected"));
await request("v1/profiles", "GET", undefined, 410);
await request("auth/v1/logout", "POST", { refreshToken: login.refreshToken });
await request("auth/v1/logout", "POST", {
  refreshToken: exchanged.refreshToken,
});
console.log(
  "PASS: full alias synchronization, tombstones, legacy retirement and logout",
);
