import pg from "pg";
import { logger } from "../logger.js";

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ||
  "postgres://cyber_user:cyber_password@localhost:5432/cyber_grid_db";

export const pool = new Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function initDB(retries = 10, delay = 2000) {
  while (retries > 0) {
    try {
      const client = await pool.connect();
      logger.info("PostgreSQL connected successfully", {
        connectionString: connectionString.split("@")[1] || "localhost",
      });
      client.release();
      return;
    } catch (err) {
      retries -= 1;
      logger.warn(
        `Waiting for PostgreSQL to be ready... (${retries} retries left)`,
        { error: err.message },
      );
      if (retries === 0) {
        logger.error(
          "PostgreSQL connection failed permanently. Terminating process.",
          { error: err.stack },
        );
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
      logger.warn("Slow database query detected", {
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
