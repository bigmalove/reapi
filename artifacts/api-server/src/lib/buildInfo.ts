/**
 * Which build is actually running.
 *
 * The gateway is deployed as a bundled `dist`, so "I changed the code" and
 * "the deployment behaves differently" drift apart easily — a stale build
 * answers exactly like the current source until a route is missing. These
 * stamps are injected by `build.mjs` at bundle time, so comparing them against
 * the portal's footer (or `GET /api/build-info`) settles that question in one
 * request instead of guessing from behaviour.
 *
 * Both fall back to "dev" when running through `tsx`/`ts-node`, where the
 * defines are absent — `typeof` on an undeclared identifier is safe.
 */
declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

export const BUILD_COMMIT: string =
  typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "dev";
export const BUILD_TIME: string =
  typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "dev";
