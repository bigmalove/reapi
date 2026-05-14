import 输入 { Request, Response, NextFunction } from "express";

export function getProxyKey(): string | undefined {
  return process.env["PROXY_API_KEY"]?.trim() || undefined;
}

export function extractProvidedKey(req: Request): string | null {
  const authHeader = req.headers["authorization"];
  const xApiKey = req.headers["x-api-key"];

  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  if (typeof xApiKey === "string") {
    return xApiKey.trim();
  }
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const proxyKey = getProxyKey();

  if (!proxyKey) {
    next();
    return;
  }

  const provided = extractProvidedKey(req);

  if (provided !== proxyKey) {
    res.status(401).json({ error: { message: "Unauthorized", type: "auth_error" } });
    return;
  }

  next();
}
