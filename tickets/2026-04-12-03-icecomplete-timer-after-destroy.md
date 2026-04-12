# Ticket: ICE complete timer may fire after peer destruction

## Metadata

- **Created:** 2026-04-12
- **Area:** `zen-rtc/src/peer/index.ts`
- **Severity:** Medium
- **Status:** Open

## Issue

`iceCompleteTimer` is not cleared in teardown logic.

## Why this occurs

`startIceCompleteTimeout()` assigns `this.iceCompleteTimer = setTimeout(...)`, but `_destroy()` does not clear that timeout before or during state teardown.

## Why this is a problem

A pending timer can execute after destruction and emit `_iceComplete` / `iceTimeout` events on a peer that is no longer active. This creates lifecycle inconsistencies, confusing event ordering, and brittle behavior for consumers that assume no further events after teardown.