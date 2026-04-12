# Ticket: Unguarded JSON parse in data-channel signaling path

## Metadata
- **Created:** 2026-04-12
- **Area:** `zen-rtc/src/peer/index.ts`
- **Severity:** Medium
- **Status:** Open

## Issue
Signal-like data-channel messages are parsed as JSON without error handling.

## Why this occurs
`onChannelMessage()` first checks a binary prefix to identify signal envelopes, then directly runs `JSON.parse(decoded)` and calls `signal(...)`.

Prefix matching does not guarantee valid JSON or valid payload shape. Any malformed/partial payload that passes prefix detection will throw during parsing.

## Why this is a problem
A malformed signaling message can trigger an unhandled runtime exception in the channel message handler. This risks unstable channel behavior and makes the signaling path vulnerable to malformed input rather than failing predictably.
