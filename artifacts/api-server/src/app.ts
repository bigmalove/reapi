import express, { type Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import modelsRouter from "./routes/v1/models.js";
import chatRouter from "./routes/v1/chat.js";
import messagesRouter from "./routes/v1/messages.js";
import imagesRouter from "./routes/v1/images.js";
import videosRouter from "./routes/v1/videos.js";
import { logger } from "./lib/logger.js";
import { BUILD_COMMIT, BUILD_TIME } from "./lib/buildInfo.js";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Claude Code inlines file contents and screenshots in the request body;
// Anthropic's own limit is 32 MB, so the Messages API gets a larger budget than
// the rest of the gateway. The global parser below skips already-parsed bodies.
app.use("/v1/messages", express.json({ limit: "32mb" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

// Public on purpose: a commit stamp is not a secret, and the whole point is to
// answer "is this deployment running my fix?" without an admin key.
app.get("/api/build-info", (_req, res) => {
  res.json({ commit: BUILD_COMMIT, builtAt: BUILD_TIME });
});

// The admin portal is a static bundle (artifacts/api-portal/dist/public). Serving
// it from the same process means the deployment needs no vite, no node_modules and
// no second workflow — the bundle in dist/ is the whole app. When the folder is
// absent (dev without a portal build) the old behaviour is unchanged.
const portalDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../api-portal/dist/public",
);
const portalIndex = path.join(portalDir, "index.html");

if (existsSync(portalIndex)) {
  app.use(express.static(portalDir, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api") || req.path.startsWith("/v1")) return next();
    if (req.path === "/healthz") return next();
    res.sendFile(portalIndex);
  });
}

app.use(router);
app.use(modelsRouter);
app.use(chatRouter);
app.use(messagesRouter);
app.use(imagesRouter);
app.use(videosRouter);

export default app;
