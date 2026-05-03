import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import setupRouter from "./setup.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(setupRouter);

export default router;
