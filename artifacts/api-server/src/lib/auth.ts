import type { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const proxyKey = process.env["PROXY_API_KEY"];

  if (!proxyKey) {
    next();
    return;
  }

  const authHeader = req.headers["authorization"];
  const xApiKey = req.headers["x-api-key"];

  let provided: string | null = null;

  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    provided = authHeader.slice(7);
  } else if (typeof xApiKey === "string") {
    provided = xApiKey;
  }

  if (provided !== proxyKey) {
    res.status(401).json({ error: { message: "Unauthorized", type: "auth_error" } });
    return;
  }

  next();
}
