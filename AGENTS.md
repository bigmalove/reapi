# AGENTS.md — 本仓库的硬规则

面向所有进入本仓库的人/Agent。违反下面任一条，Replit 上就会出现「代码改了但线上没变」或直接 502。

## 1. 改完代码必须在本机 `pnpm run build`，并提交产物

```bash
pnpm run build            # typecheck + api-server(esbuild) + api-portal(vite) + mockup-sandbox
pnpm run check:dist       # 必须 exit 0：产物里的构建戳 == 当前 HEAD
git add -f artifacts/api-server/dist artifacts/api-portal/dist
git commit                # 产物与源码同一个 commit
```

- 改动范围只要碰到 `artifacts/**/src/**`、`artifacts/**/index.html`、`artifacts/**/vite.config.ts`、
  `lib/**`、根 `pnpm-workspace.yaml`/`tsconfig*`，就必须重新构建并提交 dist。
- 只改 `replit.md`、`scripts/**`、`.replit` 这类不参与打包的文件时，可以不重建；但提交前跑一次
  `pnpm run check:dist` 确认它本来就是对的。
- 提交前用 `git add -f`（`dist` 被 `.gitignore` 的通用规则忽略，只对
  `artifacts/api-server/dist`、`artifacts/api-portal/dist` 放开）。不要为了省事删掉 `.gitignore`
  里的放行规则，也不要提交 `*.map`。

**为什么**：Replit 部署容器**不能** `pnpm install`，也不能 `pnpm build` —— 包防火墙对任何未缓存的
tarball 都回 `403 No authorization header was set for the request`，而 deployment 里没有终端可用。
线上跑的就是仓库里的 `artifacts/api-server/dist/index.mjs`（自包含 bundle，含 express/pg/pino）和
`artifacts/api-portal/dist/public`（静态门户，由 api-server 托管）。产物不提交 / 不重建，线上就是旧的。

## 2. 部署链只有两个入口，别改语义

- `[deployment].build` → `scripts/deploy-build.sh`：有构建工具才重编译；没有就先尝试装（失败不致命）；
  再没有就用仓库里的产物；只有产物缺失才失败。**绝不在工具缺失时调用 `build.mjs`**——它会先
  `rm -rf dist`，失败会把兜底产物一起删掉。
- `[deployment].run` → `scripts/deploy-run.sh`：直接 `node artifacts/api-server/dist/index.mjs`，
  不经过 pnpm、不读 `node_modules`。

## 3. 依赖安装相关的坑（改之前先读）

- pnpm 11 只认 `pnpm-workspace.yaml` 的 `allowBuilds`，`onlyBuiltDependencies` 是 pnpm 10 的；
  两个都保留，esbuild 的构建脚本被拦时 pnpm 11 会**硬失败**。
- 非 TTY 环境必须 `confirmModulesPurge: false`（写在 `pnpm-workspace.yaml`，`.npmrc` 同名项实测无效）。
- 多个 workflow 会同时 `pnpm install`，必须走 `.cache/install.lock` 串行化（`ensure-deps.mjs` /
  `bootstrap.sh` 已实现），否则 `ERR_PNPM_ENOTEMPTY`。
- 装不上时 `ensure-deps.mjs` 会回退公共 registry 一次；仍失败就 15 分钟内不再重试。

## 4. 提交前自检清单

```bash
pnpm run check:dist        # 产物 == HEAD
bash scripts/bootstrap.sh  # 依赖齐全（本机）
PORT=24927 bash scripts/deploy-run.sh   # curl /healthz -> {"status":"ok"}，/ 返回门户 HTML
```

细节与事故复盘见 `replit.md` 的「Install / Build / Deploy」一节。
