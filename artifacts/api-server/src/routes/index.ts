import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import setupRouter from "./setup.js";
import settingsRouter from "./settings.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(setupRouter);
router.use(settingsRouter);

export default router;
