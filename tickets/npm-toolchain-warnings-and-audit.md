# Ticket: Clean up npm toolchain warnings and dependency audit (ZenRtc)

## Summary

Address recurring `**npm install**` noise and risk from **deprecated transitive dependencies** and `**npm audit`** findings across `zen-rtc` and `development-playground`. Optionally resolve the `**Unknown env config "devdir"**` warning if it originates from project or team-wide configuration.

## Background

During routine `npm install` and builds (see zen-rtc webpack build and development-playground production build), npm emitted:

1. `**npm warn Unknown env config "devdir"**` — npm does not recognize `devdir` as a valid config key; support may be removed in a future npm major version.
2. **Deprecation warnings** for transitive packages (examples observed): `inflight`, older `rimraf`, older `glob`, etc. These typically come through dev tooling (e.g. webpack, eslint) rather than first-party `package.json` entries.
3. `**npm audit`** reporting a non-zero count of vulnerabilities (severity mix varies with lockfile age and registry data).

Installs and builds completed successfully; this ticket is about **hygiene, maintainability, and security posture**, not an immediate build break.

## Scope


| Area        | Path                                                 |
| ----------- | ---------------------------------------------------- |
| Library     | `zen-rtc/`                                           |
| Example app | `development-playground/`                            |
| Optional    | Root-level or CI npm config if `devdir` is set there |


## Proposed work

### 1. `devdir` config warning

- **Discover source**: Check `~/.npmrc`, project `.npmrc`, CI env, and editor/tooling that might inject npm config.
- **Action**: Remove or rename the invalid key if under our control; document if it must stay (e.g. corporate image) and suppress expectation in internal runbooks.

### 2. Deprecated dependencies

- Run `**npm outdated`** in each package and review **direct** devDependencies (webpack, eslint, typescript, loaders, plugins).
- Upgrade **within semver** where possible; plan a **major upgrade** pass for webpack/eslint if needed to shed deprecated transitive trees.
- Re-run install and confirm deprecation warning count drops (goal: zero or materially reduced; full elimination may depend on upstream releases).

### 3. Security audit

- Run `**npm audit`** in `zen-rtc` and `development-playground`.
- Apply `**npm audit fix**` for non-breaking resolutions; review `**npm audit fix --force**` or manual overrides only with changelog review.
- Re-run `npm audit` and record remaining issues with justification (e.g. no fix yet, dev-only scope).

### 4. Verification

- `npm ci` or `npm install` completes without unexpected warnings (document any accepted warnings).
- `npm run build` succeeds in `zen-rtc` and `development-playground`.
- Commit updated `package-lock.json` files when dependency versions change.

## Acceptance criteria

- Root cause of `**devdir**` warning documented; fixed or explicitly accepted with note.
- `**npm audit**` reviewed; fixes applied where reasonable; remaining issues listed with rationale.
- Deprecated-package warnings reduced or eliminated as far as practical via upgrades.
- Builds verified for both packages after lockfile changes.

## Notes

- `development-playground` imports `zen-rtc` via path alias to `../zen-rtc/src`; dependency overlap may still pull `zen-rtc/node_modules` into the bundle graph—coordinate upgrades so both workspaces stay consistent if shared tooling is upgraded.
- Revisit this ticket after major npm releases if the `devdir` warning behavior changes.

## References

- npm config: [https://docs.npmjs.com/cli/v10/using-npm/config](https://docs.npmjs.com/cli/v10/using-npm/config)
- npm audit: [https://docs.npmjs.com/cli/v10/commands/npm-audit](https://docs.npmjs.com/cli/v10/commands/npm-audit)