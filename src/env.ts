import { z } from "zod";
const optional = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);
const schema = z.object({
  NODE_ENV: z.string().default("production"),
  PORT: z.coerce.number().default(8787),
  APP_PUBLIC_URL: z.url().default("https://dash.rhythmeta.org"),
  CORS_ALLOWED_ORIGINS: z.string().default("https://dash.rhythmeta.org"),
  JWT_ISSUER: z.string().default("https://api.rhythmeta.org/auth/v1"),
  JWT_AUDIENCE: z.string().default("rhythmeta-clients"),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
  OPAQUE_SERVER_SETUP: z.string().min(1),
  MFA_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  WEBAUTHN_RP_ID: z.string().default("rhythmeta.org"),
  WEBAUTHN_RP_NAME: z.string().default("Rhythmeta"),
  WEBAUTHN_ORIGIN: z.url().default("https://dash.rhythmeta.org"),
  LEGACY_WEBAUTHN_RP_ID: optional,
  LEGACY_WEBAUTHN_ORIGIN: optional,
  LEGACY_WEBAUTHN_UNTIL: optional,
  RESEND_API_KEY: optional,
  RESEND_FROM_EMAIL: z.email().default("no-reply@rhythmeta.org"),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_PUBLIC_BASE_URL: z.url(),
  MAIMAID_STATIC_URL: z.url().default("https://maimaid-assets.rhythmeta.org"),
  CHUNITHMD_STATIC_URL: z
    .url()
    .default("https://chunithmd-assets.rhythmeta.org"),
});
export type Env = z.infer<typeof schema>;
export const parseEnv = (input: unknown): Env => schema.parse(input);
