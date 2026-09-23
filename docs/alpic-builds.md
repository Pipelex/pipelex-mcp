# How Alpic builds the hosted console

The hosted console is built and run by Alpic's remote builder, not by the repository's `Dockerfile`. Alpic's documentation says the builder detects the framework and its commands, but not what each stage installs or what the running image contains, and the `alpic` CLI carries none of it either. This page records what the build logs show, with the deployments that showed it, so a change to the dependency boundary or to the repository layout can be checked against something observed rather than assumed.

A deployment's log is read with `npx alpic deployment logs --non-interactive --deployment-id <id> --no-color`, and the project's settings with `npx alpic project inspect --project-id prj_csxv0ybe166jmf0kohzu8`.

## Where the configuration lives

The Alpic project's Root Directory, install command, build command and start command are project settings, shared by every environment, and all of them are unset on this project. Alpic's API sets the Root Directory only when a project is created, so it cannot be changed per environment or per branch.

An `alpic.json` at the repository root can override `installCommand`, `buildCommand`, `buildOutputDir` and `startCommand`. Unlike the project settings, it travels with the commit, so two branches with different layouts can each carry their own. This repository's `alpic.json` sets none of them, so every stage runs Alpic's detected default: an install from `package-lock.json`, `npm run build` (which is `skybridge build`), and `dist` as the build output.

## The install stage installs devDependencies

The builder runs one install at the repository root, from the lockfile, and that install includes devDependencies. Two things in every build log show it:

- The install adds far more packages than the lockfile's production closure holds. A build of `94755a6` printed `added 732 packages`, while that commit's lockfile has only 461 entries outside `devDependencies`. The difference from the lockfile's full size is the platform-specific optional packages a Linux x64 install skips.
- The build that follows runs `vite build` with this repository's `vite.config.ts`, which loads `@vitejs/plugin-react` and `@tailwindcss/vite` at config time. Both are declared only in `devDependencies`, and the build succeeds.

So the console's build-only packages belong in `devDependencies` (see the dependency convention in `CLAUDE.md`), and Alpic builds the console with them. Deployments `dpl_swlz0ucxswfo5lpsadwtj` and `dpl_3akp84bj6j7456rfxn4yw` both show it.

## What the running image contains

The image that runs is assembled from exactly two copies, as the build log prints them:

```
[runner 1/3] COPY --from=dependencies /var/task/node_modules node_modules
[runner 3/3] COPY --from=build /var/task/<buildOutputDir> <buildOutputDir>
```

`node_modules` comes from the install stage, before the build ran, and the build output directory comes from the build stage. Nothing else in the repository reaches the image. The start command runs from `/var/task`.

Two consequences follow:

- **Nothing outside the build output is there at runtime.** A file the server reads from the repository, or a package in an npm workspace that the server imports by name, is absent: the workspace's symlink in `node_modules` points at a directory the image never received. A trial deploy of the console from a workspace member failed exactly this way, with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/task/node_modules/@pipelex/mcp-core/dist/index.js' imported from /var/task/packages/console/dist/server.js` (deployment `dpl_9m9rn2oxadhj6m03o1r9z`). It deployed once the server was started from the esbuild bundle that `skybridge build` already emits for Vercel (`.vercel/output/functions/mcp.func/index.js`), copied into the build output (deployment `dpl_3akp84bj6j7456rfxn4yw`).
- **The runtime most likely carries devDependencies too.** The log shows no second install and no prune, and the runtime's `node_modules` is copied from the stage that installed them. That makes Alpic unlike the repository's `Dockerfile`, which prunes with `npm prune --omit=dev` before its runtime stage. So a server import of a devDependency would not crash on Alpic: only an `--omit=dev` install reveals one, which is why the dependency convention in `CLAUDE.md` has to be checked by hand.

## Assets and validation

The views' assets are extracted from `<buildOutputDir>/assets` (the log prints `Assets extracted`) and served under `/assets/assets/`. Pointing `buildOutputDir` at a wider directory therefore moves where Alpic looks for them.

After the image is deployed, Alpic starts the server and tests that it responds. A server that fails to start fails the deployment with `MCP server validation failed` and the server's own error. A failed deployment never takes traffic: the environment keeps serving its previous deployment.
