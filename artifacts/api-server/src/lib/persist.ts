import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

const DATA_DIR = process.env["DATA_DIR"] ?? path.resolve(process.cwd(), "data");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function filePath(name: string): string {
  return path.join(DATA_DIR, name);
}

export function readJson<T>(name: string, defaultValue: T): T {
  ensureDir();
  const fp = filePath(name);
  try {
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, "utf-8");
      return JSON.parse(raw) as T;
    }
  } catch (err) {
    logger.warn({ err, file: name }, "Failed to read persisted file");
  }
  return defaultValue;
}

export function writeJson(name: string, value: unknown): void {
  ensureDir();
  const fp = filePath(name);
  try {
    fs.writeFileSync(fp, JSON.stringify(value, null, 2), "utf-8");
  } catch (err) {
    logger.error({ err, file: name }, "Failed to write persisted file");
  }
}
