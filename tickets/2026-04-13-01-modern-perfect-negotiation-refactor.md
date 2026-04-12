# Ticket: Adopt modern WebRTC perfect negotiation APIs

## Metadata

- **Created:** 2026-04-13
- **Area:** `zen-rtc/src/peer/index.ts`
- **Severity:** High
- **Status:** Open
- **Supersedes:** `2026-04-12-02-makingoffer-glare-race-window.md`

## Background

Ticket `2026-04-12-02` identified a glare race window: `runNegotiationNeededJob` sets `isNegotiating = true`, then defers offer creation with `setTimeout(0)`. Inside that deferred callback `makingOffer` is set to `true`. Any incoming offer that arrives in the gap sees `makingOffer === false` and misclassifies the collision.

Investigation into fixing that gap revealed a deeper problem: the codebase uses the **legacy two-step negotiation pattern** (`createOffer()` → `setLocalDescription(offer)`). These are two separate operations on the RTCPeerConnection operations chain. Because `createOffer` does not change `signalingState` (only `setLocalDescription` does), any glare-handling work (rollback, `setRemoteDescription`) that lands on the operations chain between them executes while `signalingState` is still `stable` — making explicit rollback invalid per spec and leaving a stale `setLocalDescription(localOffer)` queued behind it.

The W3C spec's own perfect negotiation example deliberately avoids this pattern. It uses:

1. `**setLocalDescription()` without arguments** — atomically creates the offer/answer **and** applies it as a single operation on the chain. No gap.
2. `**setRemoteDescription(offer)` with implicit rollback** — the browser auto-rolls back from `have-local-offer` when needed.

The spec note (§ Perfect Negotiation Example) states:

> *"This is timing sensitive, and deliberately uses versions of `setLocalDescription` (without arguments) and `setRemoteDescription` (with implicit rollback) to avoid races with other signaling messages being serviced."*

Both APIs are supported by modern browsers and by `react-native-webrtc` (since August 2021, commit `c818464`). The legacy helpers they replace (`createOffer`, `createAnswer`, `offerOptions`, `answerOptions`) are either deprecated by the spec or unnecessary when using the modern surface.

## Plan

### 1. Replace `createOffer` + `setLocalDescription(offer)` with `setLocalDescription()`

**Current code (`runNegotiationNeededJob`):**

```typescript
this.isNegotiating = true;
setTimeout(() => {                         // deferred — creates the race gap
  this.makingOffer = true;
  void this.createOffer().finally(() => {   // two-step: createOffer then setLocalDescription
    this.makingOffer = false;
  });
}, 0);
```

**New code:**

```typescript
this.isNegotiating = true;
this.makingOffer = true;                    // synchronous — no gap
void this.pc!.setLocalDescription()         // atomic create + apply — single operation on the chain
  .then(() => { /* signal the offer */ })
  .catch(() => { /* destroy on failure */ })
  .finally(() => { this.makingOffer = false; });
```

- `setTimeout(0)` is removed. The hack comment says *"Chrome crashes if we immediately call createOffer"* — we are no longer calling `createOffer`, so the bug does not apply.
- `isNegotiating` and `makingOffer` are both set synchronously before async work starts. The race window from the original ticket is eliminated by construction.
- `sdpTransform` is applied to the **signaled** SDP (read from `pc.localDescription` after `setLocalDescription` resolves), not to the SDP before it is set. This is a semantic shift: the local description now contains the browser-generated SDP; only the SDP sent to the remote peer is transformed.

### 2. Replace `createAnswer` + `setLocalDescription(answer)` with `setLocalDescription()`

Same pattern. When `signalingState` is `have-remote-offer`, argument-less `setLocalDescription()` auto-creates an answer.

**Current code (`createAnswer`):**

```typescript
this.pc!.createAnswer(this.options.answerOptions)
  .then(answer => {
    // sdpTransform, removeTrickle …
    this.pc!.setLocalDescription(answer).then(onSuccess).catch(onError);
  });
```

**New code (inside `handleSignalPayload`, after applying the remote offer):**

```typescript
await this.pc!.setLocalDescription();       // auto-creates answer
const desc = this.pc!.localDescription!;
// apply sdpTransform to signaled SDP, then emitSignal
```

### 3. Keep explicit rollback in the polite glare path

We will **not** rely on implicit rollback via `setRemoteDescription`. It is spec-defined and works in desktop browsers, but `react-native-webrtc` issue [#1223](https://github.com/react-native-webrtc/react-native-webrtc/issues/1223) reported failures with it. The existing explicit pattern is safe:

```typescript
if (offerCollision && this.polite) {
  await Promise.all([
    this.pc!.setLocalDescription({ type: 'rollback' }),
    this.pc!.setRemoteDescription(new SessionDesc(description))
  ]);
}
```

With the change from step 1, by the time this code runs, the atomic `setLocalDescription()` is already on the operations chain (or has completed). The rollback and `setRemoteDescription` are chained **after** it. When the rollback executes, `signalingState` is `have-local-offer` — rollback is valid. The stale-timer problem from the old ticket does not exist because there is no separate `createOffer` promise chain that could fire `setLocalDescription(localOffer)` later.

### 4. Remove legacy methods and options


| Removed                                    | Reason                                                | Modern replacement                                                                                            |
| ------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `createOffer()` private method             | Replaced by `setLocalDescription()`                   | —                                                                                                             |
| `createAnswer()` private method            | Replaced by `setLocalDescription()`                   | —                                                                                                             |
| `offerOptions` constructor option          | Deprecated by spec                                    | `addTransceiver()` (already on the class), `restartIce()`                                                     |
| `answerOptions` constructor option         | Deprecated by spec                                    | Not needed with `setLocalDescription()`                                                                       |
| `RTCSessionDescription` from `wrtc` option | No longer constructed manually for local descriptions | Keep only if still needed for `setRemoteDescription` in the polite path (check whether plain object suffices) |


### 5. `sdpTransform` — semantic change

`sdpTransform` will be applied to the SDP **after** `setLocalDescription` resolves, before signaling. The browser's local description retains the original SDP. This is the only change visible to consumers who use `sdpTransform`:

- If their transform only adjusts signaling-level concerns (codec reordering, removing candidates, munging for srflx/relay preference): **no behavioral change**.
- If their transform sets bandwidth limits or other constraints that the local browser must enforce via the local description: **behavioral change** — the local browser will not see those limits. This is an inherent trade-off of the modern API.

Document this in the changelog / release notes. Also mention this on the docstring for sdpTransform.

## Public API impact

**No changes to the public facade** except the removal of two constructor options:


| Surface                               | Change                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `SimplePeerInitOptions.offerOptions`  | Removed                                                                  |
| `SimplePeerInitOptions.answerOptions` | Removed                                                                  |
| `SimplePeerInitOptions.sdpTransform`  | Kept — semantic change (applied after `setLocalDescription`, not before) |
| All public methods                    | Unchanged                                                                |
| All events                            | Unchanged                                                                |


Consumers who do not use `offerOptions` or `answerOptions` (and whose `sdpTransform` is signaling-only) require zero changes.

## Acceptance criteria

- `makingOffer` and `isNegotiating` are both set synchronously before any async work; no window where `isNegotiating` is true but `makingOffer` is false.
- No `setTimeout(0)` in the negotiation path.
- No calls to `createOffer()` or `createAnswer()`.
- Polite rollback path works correctly under concurrent renegotiation (rollback always executes from `have-local-offer`, never from `stable`).
- Existing tests pass; extend coverage for glare under the new code path.
- `offerOptions` and `answerOptions` removed from `SimplePeerInitOptions`.
- Works on modern browsers and `react-native-webrtc` (>= 1.92).

