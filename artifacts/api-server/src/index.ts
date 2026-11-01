import app from "./app";
import { logger } from "./lib/logger";
import { initSettings, restoreExpiredDisabledNodes } from "./lib/settings";
import { initModels } from "./lib/models";
import { recheckQuestionableDisabledNodes } from "./lib/disabledNodeRecheck";
import { initUsageLedger } from "./lib/usageLedger";

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
    await Promise.all([initSettings(), initModels(), initUsageLedger()]);
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

  // Age out stale disabled-node rows before the first request instead of waiting
  // for a model call to trigger the same sweep. After an outage the panel is the
  // first thing an operator looks at, and it must not keep claiming that healthy
  // nodes are 「屏蔽」 because nothing happened to turn the clock.
  try {
    restoreExpiredDisabledNodes();
  } catch (err) {
    logger.warn({ err }, "clearing expired disabled-node rows failed");
  }

  // Nothing else turns the clock for this sweep: it used to run only on the next
  // `resolveProviderEndpoint`. A quiet gateway therefore held rows past their
  // window indefinitely, and the panel kept rendering whatever badge the stale
  // row implied. Cheap when nothing is due — the function returns immediately
  // and only writes when it restores or drops a row.
  const sweepTimer = setInterval(() => {
    try {
      restoreExpiredDisabledNodes();
    } catch (err) {
      logger.warn({ err }, "periodic disabled-node sweep failed");
    }
  }, 60_000);
  sweepTimer.unref();

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
