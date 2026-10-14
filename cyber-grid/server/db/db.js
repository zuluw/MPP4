import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ||
  "postgres://cyber_user:cyber_password@localhost:5432/cyber_grid_db";

export const pool = new Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl:
    process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost")
      ? { rejectUnauthorized: false }
      : false,
});

export async function initDB(retries = 10, delay = 2000) {
  while (retries > 0) {
    try {
      const client = await pool.connect();
      logger.info("PostgreSQL connected successfully");

      const schemaPath = path.join(__dirname, "schema.sql");
      if (fs.existsSync(schemaPath)) {
        const schemaSql = fs.readFileSync(schemaPath, "utf8");
        await client.query(schemaSql);
        logger.info(
          "Database schema verified/created successfully from schema.sql",
        );
      }

      client.release();
      return;
    } catch (err) {
      retries -= 1;
      logger.warn(
        `Waiting for PostgreSQL to be ready... (${retries} retries left)`,
        { error: err.message },
      );
      if (retries === 0) {
        logger.error("PostgreSQL connection failed permanently.", {
          error: err.stack,
        });
        process.exit(1);
      }
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 50) {
      logger.warn("Slow query detected", {
        duration: `${duration}ms`,
        query: text,
      });
    }
    return res;
  } catch (err) {
    logger.error("Database query execution error", {
      query: text,
      params,
      error: err.message,
    });
    throw err;
  }
}
