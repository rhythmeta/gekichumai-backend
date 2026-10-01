import assert from "node:assert/strict";
import * as opaque from "@serenity-kit/opaque";
await opaque.ready;
const base = process.env.RHYTHMETA_SMOKE_BASE;
assert(
  base,
  "Set RHYTHMETA_SMOKE_BASE to an isolated test deployment with the example.invalid fixture users.",
);
const password = "Migration-test123!",
  email = "migration-opaque@example.invalid";
async function post(path, body) {
  const response = await fetch(base + "/auth/v1/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, 200, `${path}: ${value.code}`);
  return value;
}
const initial = opaque.client.startLogin({ password });
const challenge = await post("login:start", {
  email,
  startLoginRequest: initial.startLoginRequest,
});
assert.equal(challenge.protocol, "opaque");
const finished = opaque.client.finishLogin({
  password,
  clientLoginState: initial.clientLoginState,
  loginResponse: challenge.loginResponse,
  keyStretching: "memory-constrained",
});
assert(finished);
const result = await post("login:finish", {
  challengeToken: challenge.challengeToken,
  finishLoginRequest: finished.finishLoginRequest,
});
assert.equal(result.user.id, "ffffffff-0000-4000-8000-000000000002");
await post("logout", { refreshToken: result.refreshToken });
console.log(
  "PASS: real Worker OPAQUE WASM handshake, preserved server setup, login and logout",
);
