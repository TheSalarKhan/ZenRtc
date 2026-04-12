# Ticket: Glare race window before `makingOffer` is set

## Metadata

- **Created:** 2026-04-12
- **Area:** `zen-rtc/src/peer/index.ts`
- **Severity:** High
- **Status:** Superseded by `2026-04-13-01-modern-perfect-negotiation-refactor.md`

## Issue

There is a timing window where negotiation has started, but `makingOffer` is still false.

## Why this occurs

`runNegotiationNeededJob()` sets `isNegotiating = true`, then defers offer creation with `setTimeout(0)`. `makingOffer = true` is set only inside that deferred callback.

During that window, incoming offer handling in `handleSignalPayload()` computes:

- `readyForOffer` from `!makingOffer` and signaling state
- `offerCollision` from `!readyForOffer`

Because `makingOffer` is not yet true, collision detection can evaluate as if no local offer is in progress even though offer work has already been committed.

## Why this is a problem

This weakens perfect-negotiation glare guarantees and can cause incorrect behavior under concurrent renegotiation, especially in timing-sensitive environments. The bug is subtle and race-driven, so it can pass normal testing and still fail in real deployments.

## Solution draft (methodology)

### Two phases, two flags

Treat negotiation as two distinct phases:

1. `**isNegotiating`** — We have committed to a negotiation cycle from `onnegotiationneeded` (slot taken, `runNegotiationNeededJob()` past its early returns) until signaling returns to `**stable`** (see `onSignalingStateChange()`).
2. `**makingOffer`** — The deferred local-offer path has actually started: the `setTimeout(0)` callback has run, `makingOffer` is true, and `createOffer()` is in progress or has completed its `finally` for that run.

`makingOffer` alone cannot represent the bad window: it stays false until the timer runs, even though `isNegotiating` is already true and local offer work is already scheduled.

### Three cases for an incoming offer


| `isNegotiating` | `makingOffer` | Meaning                                                                                                                                                                                               |
| --------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| false           | false         | Normal “happy” case: we are not in a self-started negotiation for this cycle; collision logic can use existing `readyForOffer` rules (subject to signaling state).                                    |
| true            | false         | **Pre-offer window**: negotiation is committed, but the `setTimeout(0)` that calls `createOffer()` has not run yet — no local SDP, `makingOffer` still false. This is the race this ticket describes. |
| true            | true          | **Classic glare**: local offer is in flight; impolite ignores colliding offers; polite uses rollback + `setRemoteDescription` (perfect-negotiation path).                                             |


### Proposed behavior

**Collision detection** should not rely on `makingOffer` alone. Incorporate `**isNegotiating`** (and signaling state) so that the pre-offer window is never misclassified as “ready for offer” when a remote `offer` arrives.

**Defer incoming offer handling**  
When an incoming session description of type `offer` arrives while `isNegotiating && !makingOffer` (and other conditions such as `signalingState === 'stable'` hold as appropriate), **do not** run the full `handleSignalPayload` collision path immediately. Instead `**setTimeout(0)`** (or equivalent) and re-enter handling on the next task.

**Reasoning:** The negotiation job has already queued **its own** `setTimeout(0)` for `createOffer()`. A second timer, scheduled when the remote offer is processed, is typically ordered **after** the first, so the local side sets `makingOffer` and starts `createOffer()` **before** the deferred remote-offer logic runs. The case then lines up with the **bottom row** (“both true”), where polite rollback has a real local offer to roll back from. Applying the polite **rollback** path while still `**stable`** with **no local description** is redundant at best and browser-dependent at worst.

**Related requirement:** Ensure the **original** `setTimeout(0)` from `runNegotiationNeededJob()` does not leave a **stale `createOffer()`** after glare handling has already applied the remote offer (e.g. re-check signaling state / negotiation generation when the timer fires, or cancel/invalidate the deferred job when a remote description wins). Ordering between remote-offer application and the local timer is nondeterministic unless explicitly coordinated.

### Acceptance criteria (draft)

- No window where `isNegotiating` is true, local offer is scheduled, but an incoming `offer` is classified as non-colliding solely because `makingOffer` is false.
- Polite / impolite branches behave as intended under concurrent offers (including ordering between deferred local `createOffer` and deferred remote-offer handling).
- No leaked flags or duplicate negotiation when destroying the peer mid-defer.
- Existing tests pass; add or extend coverage for the pre-offer window and defer ordering if feasible.