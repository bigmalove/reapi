import app from "./app";
import { logger } from "./lib/logger";
import { initSettings } from "./lib/settings";
import { initModels } from "./lib/models";
import { recheckQuestionableDisabledNodes } from "./lib/disabledNodeRecheck";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main() {
  try {
    await Promise.all([initSettings(), initModels()]);
    logger.info("Persistent state loaded from database");
  } catch (err) {
    logger.warn({ err }, "Failed to load state from database, using defaults");
  }

  const server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });

  server.setTimeout(600_000);
  server.keepAliveTimeout = 600_000;

  // Fire-and-forget: fix entries that were blocked on an unreadable answer so
  // the panel shows what the node actually is (usually "免费额度耗尽" with its
  // monthly window, not a permanent "forbidden"). Deliberately not awaited —
  // a slow node must never hold up the port.
  void recheckQuestionableDisabledNodes().catch((err) => {
    logger.warn({ err }, "re-probe of questionable disabled nodes failed");
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal error during startup");
  process.exit(1);
});
