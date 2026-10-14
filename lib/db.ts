import { neon } from "@neondatabase/serverless";
import { isRecord } from "@/lib/guard";
import { optionalEnv } from "@/lib/env";
import { safeLogMessage } from "@/lib/redact";

export class DailyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyStoreError";
  }
}

export type DbQuery = (text: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>;

let testQuery: DbQuery | null = null;

export function useQueryForTests(query: DbQuery | null): void {
  testQuery = query;
}

export async function dbQuery(text: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
  if (testQuery) return testQuery(text, params);
  const url = optionalEnv("DATABASE_URL");
  if (!url) throw new DailyStoreError("DATABASE_URL is not configured");
  const sql = neon(url);
  try {
    const result = await sql.query(text, [...params]);
    if (!Array.isArray(result)) return [];
    return result.filter(isRecord);
  } catch (error) {
    throw new DailyStoreError(safeLogMessage(error));
  }
}
