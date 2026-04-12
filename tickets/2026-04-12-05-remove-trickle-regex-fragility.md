# Ticket: `removeTrickle` SDP filtering is overly narrow

## Metadata
- **Created:** 2026-04-12
- **Area:** `zen-rtc/src/peer/remove-trickle.ts`
- **Severity:** Low
- **Status:** Open

## Issue
`removeTrickle()` removes only one specific textual form of the trickle SDP line.

## Why this occurs
The implementation uses one regex replacement pattern (`/a=ice-options:trickle\\s\\n/g`) that depends on exact spacing/newline formatting.

SDP formatting differs across engines and environments (for example, line-ending and formatting variations), so semantically equivalent lines may not match this exact pattern.

## Why this is a problem
When `disableTrickle` is enabled, trickle-related lines can remain in SDP in some cases, producing inconsistent behavior across clients and making negotiation outcomes dependent on SDP text shape rather than intent.
