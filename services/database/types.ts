export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  transaction<T>(run: (sql: Sql) => Promise<T>): Promise<T>;
}
