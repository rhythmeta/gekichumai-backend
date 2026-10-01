export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;
export class Database {
  constructor(readonly binding: D1Database) {}
  statement(sql: string, ...values: SqlValue[]) {
    return this.binding.prepare(sql).bind(...values);
  }
  get<T>(sql: string, ...values: SqlValue[]) {
    return this.statement(sql, ...values).first<T>();
  }
  async all<T>(sql: string, ...values: SqlValue[]): Promise<T[]> {
    return (await this.statement(sql, ...values).all<T>()).results;
  }
  run(sql: string, ...values: SqlValue[]) {
    return this.statement(sql, ...values).run();
  }
  batch(statements: D1PreparedStatement[]) {
    return this.binding.batch(statements);
  }
}
export type User = {
  id: string;
  email: string;
  username: string;
  usernameNormalized: string;
  usernameDiscriminator: string;
  passwordHash: string | null;
  opaqueRegistrationRecord: string | null;
  passwordFingerprintHash: string | null;
  status: "active" | "disabled";
  isAdmin: boolean;
  authVersion: number;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export const normalizeUser = (row: User): User => ({
  ...row,
  isAdmin: Boolean(row.isAdmin),
});
export type Game = "maimaid" | "chunithmd";
export const nowISO = () => new Date().toISOString();
