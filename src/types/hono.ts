import type { InjectionToken } from "tsyringe";
export type AuthContext = { userId: string; email: string; isAdmin: boolean };
export type AppEnv = {
  Bindings: { DB: D1Database; BACKUP_BUCKET: R2Bucket; [key: string]: unknown };
  Variables: {
    auth: AuthContext | undefined;
    resolve: <T>(token: InjectionToken<T>) => T;
  };
};
