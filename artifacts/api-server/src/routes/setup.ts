import { Router, type IRouter } from "express";
import { listSegmentStatus } from "./modelfarm.js";

const router: IRouter = Router();

router.get("/setup-status", (_req, res) => {
  const segments = listSegmentStatus();
  const providers: Record<string, boolean> = {};
  for (const s of segments) providers[s.segment] = s.configured;

  res.json({
    role: "upstream-pool-node",
    proxyKey: !!process.env["PROXY_API_KEY"],
    providers,
    segments,
  });
});

export default router;
