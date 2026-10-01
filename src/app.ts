import "reflect-metadata";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { Scalar } from "@scalar/hono-api-reference";
import type { InjectionToken } from "tsyringe";
import type { AppEnv } from "./types/hono.js";
import { Database, type Game } from "./db/database.js";
import { parseEnv, type Env } from "./env.js";
import { TOKENS } from "./di/tokens.js";
import { JwtService } from "./services/jwt.service.js";
import { AuthService } from "./services/auth.service.js";
import { MfaService } from "./services/mfa.service.js";
import { RateLimitService } from "./services/rate-limit.service.js";
import { CommunityAliasService } from "./services/community-alias.service.js";
import { AdminUserService } from "./services/admin-user.service.js";
import { StorageService } from "./services/storage.service.js";
import { BackupService } from "./services/backup.service.js";
import { healthRoute } from "./routes/health.route.js";
import { authV1Route } from "./routes/v1/auth.route.js";
import { communityV1Route } from "./routes/v1/community.route.js";
import { adminV1Route, accountAdminRoute } from "./routes/v1/admin.route.js";
import { backupRoute } from "./routes/v1/backups.route.js";
import { isAppError } from "./lib/errors.js";

export function services(bindings: AppEnv["Bindings"], game: Game = "maimaid") {
  const env = parseEnv(bindings),
    db = new Database(bindings.DB),
    jwt = new JwtService(env),
    auth = new AuthService(db, jwt, env);
  const storage = new StorageService(env, bindings.BACKUP_BUCKET);
  const map = new Map<InjectionToken<unknown>, unknown>([
    [TOKENS.Env, env],
    [TOKENS.Database, db],
    [JwtService, jwt],
    [AuthService, auth],
    [MfaService, new MfaService(db, env, auth)],
    [RateLimitService, new RateLimitService(db)],
    [CommunityAliasService, new CommunityAliasService(db, env, game)],
    [AdminUserService, new AdminUserService(db, auth)],
    [StorageService, storage],
    [BackupService, new BackupService(db, storage)],
  ]);
  return <T>(key: InjectionToken<T>): T => {
    if (!map.has(key)) throw new Error("Unknown service");
    return map.get(key) as T;
  };
}
export const createApp = () => {
  const app = new Hono<AppEnv>();
  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) =>
        c.json(
          { code: "payload_too_large", message: "Request is too large." },
          413,
        ),
    }),
  );
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const game: Game = c.req.path.startsWith("/chunithmd/")
      ? "chunithmd"
      : "maimaid";
    c.set("resolve", services(c.env, game));
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        const env = (c as Context<AppEnv>).var.resolve<Env>(TOKENS.Env);
        return env.CORS_ALLOWED_ORIGINS.split(",")
          .map((x) => x.trim())
          .includes(origin)
          ? origin
          : null;
      },
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Maimaid-Client",
        "X-Rhythmeta-Client",
      ],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
  app.route("/health", healthRoute);
  app.route("/auth/v1", authV1Route);
  app.route("/auth/v1", accountAdminRoute);
  for (const game of ["maimaid", "chunithmd"] as const) {
    app.route(`/${game}/v1/community`, communityV1Route);
    app.route(`/${game}/v1`, adminV1Route);
    app.route(`/${game}/v1/backups`, backupRoute(game));
  }
  app.all("/v1/*", (c) =>
    c.json(
      {
        code: "service_retired",
        message:
          "This API has retired. Update the app to use your Rhythmeta account and cloud backups.",
      },
      410,
    ),
  );
  app.get("/", (c) => c.json({ name: "rhythmeta-backend", status: "ok" }));
  app.notFound((c) =>
    c.json({ code: "not_found", message: "Route not found." }, 404),
  );
  app.onError((error, c) => {
    if (isAppError(error))
      return c.json(
        {
          code: error.code,
          message: error.message,
          details: error.details ?? null,
        },
        error.status as 400,
      );
    if (error.message.includes("UNIQUE constraint failed"))
      return c.json(
        { code: "conflict", message: "This item already exists." },
        409,
      );
    // Never log request URLs, bodies, credentials, or database parameter values.
    console.error("request_failed", {
      method: c.req.method,
      errorType: error.name,
    });
    return c.json({ code: "internal_error", message: "Internal error." }, 500);
  });
  return app;
};
export const registerOpenApiRoutes = (
  app: ReturnType<typeof createApp>,
  document: unknown,
) => {
  app.get("/openapi.json", (c) => c.json(document as object));
  app.get(
    "/docs",
    Scalar({ url: "/openapi.json", pageTitle: "Rhythmeta API" }),
  );
};
