import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import apiRouter from "./routes/index.js";
import modelfarmRouter from "./routes/modelfarm.js";
import { logger } from "./lib/logger.js";

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

// Modelfarm proxy: mounted with raw body parser BEFORE express.json so we
// can stream the original bytes through to upstream untouched.
app.use(
  "/modelfarm",
  express.raw({ type: "*/*", limit: "50mb" }),
  modelfarmRouter,
);

// JSON parsing for the small management API surface.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check at both root and /api so the artifact health probe and
// in-app calls both work.
app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", apiRouter);

export default app;
