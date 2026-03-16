# node-link-local

Sync a local npm package into another project via staged tarballs.  
Works with **pnpm**, **yarn**, and **npm** in any combination (e.g. library uses pnpm, app uses yarn).

Replaces the need for `npm link` / `yarn link` with a workspace-safe flow: the library is packed into a tarball, staged in the app’s `.local-packages/`, and installed from that file. No symlinks, no cross-workspace protocol issues.

### Why node-link-local instead of yalc?

[Yalc](https://github.com/wclr/yalc) is a popular “local package” tool, but it relies on symlinks (with `yalc link`) or on copying into `.yalc/` and `file:` references. That can cause real pain when developing and running tests locally:

- **Symlinks and test runners**  
  When the consumer’s `node_modules` contains symlinks into your local package, tools like Jest can resolve the same module via two paths (symlink path vs. real path). That can lead to duplicate module instances, flaky tests, or the need for `--preserve-symlinks` and extra config. With node-link-local, the app gets a normal install from a tarball—no symlinks—so test runners see a single, consistent module tree.

- **File watchers and memory**  
  Dev servers and test runners often watch `node_modules`. If they follow symlinks, they can end up watching the entire linked package repo (including its own `node_modules` and build artifacts). That can mean thousands of extra files, high memory use, and slow or crashing processes. Node-link-local installs a plain directory from a tarball, so watchers don’t follow a link into another repo.

- **Bundlers and frameworks**  
  Webpack 5 and Next.js have known issues with symlinked packages (e.g. [Next.js #35110](https://github.com/vercel/next.js/issues/35110), [yalc #188](https://github.com/wclr/yalc/issues/188)): symlinked ESM packages can be bundled as internal instead of external, or resolution can break. Node-link-local avoids that by not using symlinks at all.

- **Nested dependencies**  
  Yalc does not resolve “dependencies of dependencies” when using `file:` refs; nested `.yalc` paths can break. Node-link-local uses a single packed tarball, so the app’s package manager does normal dependency resolution for the installed package.

Trade-off: with node-link-local you run `node-link-local add` again after changing the library (no live “push” like yalc). In return you get a normal install, no symlink-related test or tooling surprises, and behavior that matches a real publish.

## Install

```bash
npm install -g node-link-local
```

Or run without installing:

```bash
npx node-link-local add /path/to/lib /path/to/app
```

Shortcut: the `nll` command is also available after install (`nll add ...`, `nll remove ...`).

## Commands

| Command | Description |
|--------|-------------|
| `node-link-local add <path-to-lib> <path-to-app>` | Build (if needed), pack the library, and install it into the app from a staged tarball |
| `node-link-local remove <path-to-lib> <path-to-app>` | Uninstall the library from the app and remove the staged tarball |

## Examples

```bash
# Use a local package "my-lib" inside "my-app"
node-link-local add ./packages/my-lib ./apps/my-app
# or
nll add ./packages/my-lib ./apps/my-app

# Stop using the local copy
node-link-local remove ./packages/my-lib ./apps/my-app
```

Paths can be absolute or relative. Both directories must contain a `package.json`. The library’s `package.json` is used to get the package name; the app’s lockfile is used to detect pnpm/yarn/npm.

## How it works

1. **add**
   - Detects package manager in both lib and app (pnpm / yarn / npm).
   - If the lib has no `dist/`, runs `build` with the lib’s package manager.
   - Copies the lib into a temp dir, normalizes `package.json` (e.g. `workspace:*` → `*`, strips prepare/prepack/postpack), and runs `pack`.
   - Copies the resulting `.tgz` into the app’s `.local-packages/`.
   - Installs from that tarball using the app’s package manager (with flags that avoid workspace linking issues where applicable).

2. **remove**
   - Uninstalls the package from the app using the app’s package manager.
   - Deletes any matching `.tgz` in the app’s `.local-packages/`.

## Requirements

- Node.js ≥ 18
- Library and app each have a `package.json`; library has a `name` (and ideally a build that produces `dist/` if you rely on it).

## Platform

Works on **Windows, macOS, and Linux**. Uses only Node built-ins (`path`, `fs`, `os`, `child_process`) and the system `PATH` to run pnpm/yarn/npm, so no shell-specific or platform-specific code.

## License

MIT
