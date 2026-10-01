import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { AppEnv, AuthContext } from "../types/hono.js";
import { JwtService } from "../services/jwt.service.js";
import { AuthService } from "../services/auth.service.js";
import { AppError } from "../lib/errors.js";
const resolve = async (c: Context<AppEnv>): Promise<AuthContext | null> => {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const payload = await c.var
    .resolve(JwtService)
    .verifyAccessToken(authorization.slice(7));
  const user = await c.var.resolve(AuthService).findActiveUserById(payload.sub);
  if (user.authVersion !== payload.authVersion)
    throw new AppError(401, "unauthorized", "Session was revoked.");
  return { userId: user.id, email: user.email, isAdmin: user.isAdmin };
};
export const authOptional = createMiddleware<AppEnv>(async (c, next) => {
  const auth = await resolve(c);
  if (auth) c.set("auth", auth);
  await next();
});
export const authRequired = createMiddleware<AppEnv>(async (c, next) => {
  const auth = await resolve(c);
  if (!auth)
    throw new AppError(401, "unauthorized", "Authentication required.");
  c.set("auth", auth);
  await next();
});
export const adminRequired = createMiddleware<AppEnv>(async (c, next) => {
  const auth = await resolve(c);
  if (!auth)
    throw new AppError(401, "unauthorized", "Authentication required.");
  if (!auth.isAdmin)
    throw new AppError(403, "forbidden", "Administrator permission required.");
  c.set("auth", auth);
  await next();
});
