import { AppError } from "./errors.js";

export const USERNAME_MIN_LENGTH = 2;
export const USERNAME_MAX_LENGTH = 32;
export const USERNAME_DISCRIMINATOR_DIGITS = 4;
export const USERNAME_DISCRIMINATOR_MAX = 9999;
export const USERNAME_PATTERN = /^[\p{L}\p{N}_.-]+$/u;
export const INVALID_USERNAME_MESSAGE =
  "Username must be 2-32 characters and use only letters, numbers, underscores, hyphens, or periods.";

export type SerializedUserIdentity = {
  id: string;
  email: string;
  username: string;
  usernameDiscriminator: string;
  handle: string;
  isAdmin: boolean;
};

export function sanitizeUsername(raw: string) {
  const username = raw.normalize("NFKC").trim();
  const length = Array.from(username).length;

  if (
    length < USERNAME_MIN_LENGTH ||
    length > USERNAME_MAX_LENGTH ||
    /\s/u.test(username) ||
    !USERNAME_PATTERN.test(username)
  ) {
    throw new AppError(400, "invalid_username", INVALID_USERNAME_MESSAGE);
  }

  return {
    username,
    usernameNormalized: username.toLocaleLowerCase(),
  };
}

export function buildHandle(username: string, usernameDiscriminator: string) {
  return `${username}#${usernameDiscriminator}`;
}

export function serializeUserIdentity(input: {
  id: string;
  email: string;
  username: string;
  usernameDiscriminator: string;
  isAdmin: boolean;
}): SerializedUserIdentity {
  return {
    id: input.id,
    email: input.email,
    username: input.username,
    usernameDiscriminator: input.usernameDiscriminator,
    handle: buildHandle(input.username, input.usernameDiscriminator),
    isAdmin: input.isAdmin,
  };
}

export function buildUsernameBaseFromEmail(email: string) {
  const localPart = email.split("@")[0] ?? "";
  const cleaned = localPart
    .normalize("NFKC")
    .trim()
    .replace(/[^\p{L}\p{N}_.-]+/gu, "");
  const shortened = Array.from(cleaned).slice(0, USERNAME_MAX_LENGTH).join("");

  if (Array.from(shortened).length >= USERNAME_MIN_LENGTH) {
    return shortened;
  }

  return "user";
}
