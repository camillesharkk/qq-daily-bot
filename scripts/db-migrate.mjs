import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Create a new Neon project for qq-daily-bot and set that variable.");
  process.exit(1);
}

const sql = neon(url);
const file = readFileSync(new URL("../db/migrations/001_daily_reports.sql", import.meta.url), "utf8");
const statements = file
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

for (const statement of statements) {
  await sql.query(statement);
}

console.log("applied db/migrations/001_daily_reports.sql");
