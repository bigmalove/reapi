---
name: Rebuild and commit dist before pushing
description: Deployment ships committed artifacts/*/dist — the deploy container cannot install or build.
---

`artifacts/api-server/dist` 与 `artifacts/api-portal/dist` 是**提交进仓库的部署产物**。
Replit 的部署容器不能 `pnpm install`（包防火墙对未缓存的 tarball 一律 403）也不能 `pnpm build`，
线上跑的就是仓库里的这两个目录。

**How to apply**：任何改动只要碰到 `artifacts/**/src`、`artifacts/**/index.html`、`vite.config.ts`、
`build.mjs`、`lib/**` 或 `pnpm-lock.yaml`，提交前必须：

```bash
pnpm run build          # 重新生成 bundle + 门户静态产物
pnpm run check:dist     # 必须 exit 0
git add -f artifacts/api-server/dist artifacts/api-portal/dist
```

产物里的构建戳是 `__BUILD_COMMIT__`（`build.mjs` 注入 `git rev-parse --short HEAD`），
`scripts/check-dist.mjs` 用它判断「dist 是否由当前提交构建」以及「是否有未提交的构建输入」。

**Why it matters**：漏了这一步，部署会继续跑旧 bundle，而 `/api/build-info` 报告的也是旧 commit，
表现和「修复没生效」一模一样——已经因此浪费过一轮排查。
