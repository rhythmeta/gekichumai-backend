import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../types/hono.js";
import type { Game } from "../../db/database.js";
import {
  BackupService,
  createBackupSchema,
} from "../../services/backup.service.js";
import { authRequired } from "../../middleware/auth.js";
import { standardValidator, validationHook } from "../../http/validation.js";
import { RateLimitService } from "../../services/rate-limit.service.js";
export const backupRoute = (game: Game) => {
  const app = new Hono<AppEnv>();
  app.use("*", authRequired);
  app.get("/", async (c) =>
    c.json(
      await c.var.resolve(BackupService).list(c.get("auth")!.userId, game),
    ),
  );
  app.post(
    "/",
    standardValidator("json", createBackupSchema, validationHook),
    async (c) => {
      const userId = c.get("auth")!.userId;
      await c.var.resolve(RateLimitService).consume({
        bucket: "backup.create",
        key: userId,
        limit: 20,
        windowSeconds: 3600,
      });
      return c.json(
        await c.var
          .resolve(BackupService)
          .create(userId, game, c.req.valid("json")),
        201,
      );
    },
  );
  const id = z.object({ id: z.uuid() });
  app.post(
    "/:id/commit",
    standardValidator("param", id, validationHook),
    async (c) =>
      c.json(
        await c.var
          .resolve(BackupService)
          .commit(c.get("auth")!.userId, game, c.req.valid("param").id),
      ),
  );
  app.delete(
    "/:id",
    standardValidator("param", id, validationHook),
    async (c) =>
      c.json(
        await c.var
          .resolve(BackupService)
          .delete(c.get("auth")!.userId, game, c.req.valid("param").id),
      ),
  );
  return app;
};
