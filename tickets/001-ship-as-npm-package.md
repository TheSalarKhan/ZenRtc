# Ship zen-rtc as a proper open-source npm package

## Context

zen-rtc is a WebRTC library that wraps `RTCPeerConnection` with perfect negotiation,
data channels, and media stream management. Currently it lives in `zen-rtc/` and works
via source alias from the playground apps — but it is not consumable as an npm package.

The `raw-webrtc-playground/` exists as a contrast demo showing how painful raw WebRTC is
without this library.

## Goal

`npm install zen-rtc` → `import { SimplePeer } from 'zen-rtc'` works in any
Vite/webpack/Node app with full TypeScript types. Repo is credible open-source
with CI, tests, docs, and a clean publish pipeline.

---

## Phase 1: Package foundation

### 1.1 — Fix `zen-rtc/package.json`

- [ ] Set `license` to `"MIT"` (matches LICENSE file; currently says ISC)
- [ ] Set `version` to `"0.1.0"` (signals pre-stable API)
- [ ] Add `description`: `"WebRTC peer connections with zero friction"`
- [ ] Add `author`, `repository`, `homepage`, `bugs`, `keywords`
- [ ] Set `main`, `module`, `types`, and `exports` map pointing to `dist/`
- [ ] Add `files: ["dist", "README.md", "LICENSE"]`
- [ ] Add `sideEffects: false`
- [ ] Move `@types/debug` from `dependencies` to `devDependencies`

### 1.2 — Replace webpack build with `tsup`

- [ ] Install `tsup` as devDependency
- [ ] Configure to emit ESM (`dist/esm/`) + CJS (`dist/cjs/`) + `.d.ts`
- [ ] Remove webpack + ts-loader + terser-webpack-plugin from devDependencies
- [ ] Remove `webpack.config.js`
- [ ] Update `build` script to use tsup
- [ ] Verify `npm pack` contains correct files

### 1.3 — Ship LICENSE in package

- [ ] Copy root `LICENSE` into `zen-rtc/` (or reference via `files` path)
- [ ] Verify it appears in the npm tarball

---

## Phase 2: API surface cleanup

### 2.1 — Export types

- [ ] Export `SimplePeerInitOptions` from `src/index.ts`
- [ ] Export `SignalEventPayloadType` from `src/index.ts`
- [ ] Export `PeerEvents` from `src/index.ts`

### 2.2 — Add `off()` method

- [ ] Add `off()` to `SimplePeer` (single listener removal, trivial with eventemitter3)

### 2.3 — Naming decision

- [ ] Decide: keep `SimplePeer` or rename to `ZenPeer` (avoid confusion with abandoned `simple-peer` package)
- [ ] If renamed, update all references

---

## Phase 3: Documentation

### 3.1 — Root README.md

- [ ] What zen-rtc is (1 paragraph)
- [ ] Install command
- [ ] Minimal working example (two peers, signal exchange, send data)
- [ ] "Why not raw WebRTC?" section → link to `raw-webrtc-playground/`
- [ ] API reference (inline or link to `docs/API.md`)
- [ ] Link to `development-playground/` for full demo

### 3.2 — `zen-rtc/README.md`

- [ ] Create package-level README (this is what npm displays)

### 3.3 — CHANGELOG.md

- [ ] Create with initial `0.1.0 — Initial release` entry

---

## Phase 4: Tests

### 4.1 — Unit tests (Vitest)

- [ ] Mock RTCPeerConnection / RTCSessionDescription / RTCIceCandidate
- [ ] Test: constructor (initiator vs non-initiator)
- [ ] Test: `.signal()` with offer/answer/candidate
- [ ] Test: `.destroy()` cleanup
- [ ] Test: `.addStream()` / `.removeStream()` track management
- [ ] Test: error events on ICE failure
- [ ] Test: `sendData` → `data` event round-trip

### 4.2 — Integration test

- [ ] Two SimplePeer instances wired together in-memory
- [ ] Verify `connect` fires, data flows, streams attach

---

## Phase 5: CI / CD

### 5.1 — GitHub Actions: CI

- [ ] `.github/workflows/ci.yml`
- [ ] Trigger: push to main, PRs
- [ ] Steps: checkout → npm ci → lint → build → test (in `zen-rtc/`)

### 5.2 — GitHub Actions: Publish

- [ ] `.github/workflows/publish.yml`
- [ ] Trigger: push tag `v*`
- [ ] Steps: build → npm publish with `--provenance`
- [ ] Add NPM_TOKEN secret to repo

---

## Phase 6: Repo polish

### 6.1 — Root `.gitignore`

- [ ] Add: `node_modules`, `dist`, `.DS_Store`, `*.log`

### 6.2 — Delete `improvement-plan.md`

### 6.3 — `CONTRIBUTING.md`

- [ ] How to clone, install, run playground, run tests, submit PR

### 6.4 — `raw-webrtc-playground/README.md`

- [ ] Explicitly frame as "WebRTC without zen-rtc" contrast demo
- [ ] Link back to the library

---

## Execution order

| Priority | Step | Reason |
|----------|------|--------|
| 1 | Fix package.json + tsup build | Without this, npm install is broken |
| 2 | Export types | Consumers can't type their code |
| 3 | Write READMEs | Nobody installs undocumented libraries |
| 4 | Add CI workflow | Prevents regressions |
| 5 | Add tests | Proves library works |
| 6 | Repo cleanup | Polish |
| 7 | First publish as 0.1.0 | Ship it |
