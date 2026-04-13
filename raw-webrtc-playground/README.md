# Raw WebRTC Playground

This folder contains a standalone browser WebRTC reference app built without `zen-rtc`.

It exists for one reason: compare raw browser WebRTC behavior against the ZenRTC-based playground in this repository.

## Why This Exists

During debugging, the ZenRTC playground showed intermittent connection failures. To check whether the bug lived in the library or lower in the stack, this raw app was created as a control/reference implementation.

The app:

- runs two peers in the same page
- uses in-memory signaling between them
- uses browser `RTCPeerConnection` APIs directly
- implements perfect negotiation
- adds media after the data channel connects
- logs connection stages clearly for comparison

## What We Learned

At the time this app was created, the raw app and the ZenRTC playground showed roughly the same failure rate.

That strongly suggests the intermittent failure is not primarily caused by ZenRTC’s signaling logic. The more likely causes are:

- browser ICE behavior
- IPv4/IPv6 path selection quirks
- local network environment issues
- STUN / candidate-pair selection behavior

In other words: this app is mainly evidence that the problem appears below the library layer too.

## How It Differs From `development-playground`

`development-playground`:

- uses `zen-rtc`
- exercises the library API directly

`raw-webrtc-playground`:

- does not import `zen-rtc`
- implements the flow directly with browser WebRTC APIs
- is intended as a comparison baseline, not as a library consumer example

## Current Behavior

The raw app:

1. creates two `RTCPeerConnection` instances in the same page
2. creates an initial data channel on `pc1`
3. uses in-memory signaling between `pc1` and `pc2`
4. uses the perfect negotiation pattern with:
   - `pc1` as impolite
   - `pc2` as polite
5. exchanges simple data messages once connected
6. adds the same camera stream to both peers after the data channel opens
7. displays the remote streams in two video elements

## Run It

From this directory:

```bash
npm install
npm run start
```

Dev server default:

- `http://localhost:9001`

Build only:

```bash
npm run build
```

## Compare It Against ZenRTC

Use this app alongside:

- `development-playground` at `http://localhost:9000`

Questions this app helps answer:

- does the same ICE failure happen without ZenRTC?
- does the browser stall in `checking` in both apps?
- do both apps eventually succeed/fail under similar conditions?
- is the difference in behavior coming from the library or from browser/network ICE behavior?

## Recommended Future Debugging

If you come back here later, the next useful experiments are probably:

- compare Chrome vs Firefox
- compare IPv4-only vs IPv6-enabled environments
- compare host-only vs STUN-enabled ICE configs
- capture and compare `chrome://webrtc-internals` for success vs failure
- add periodic `getStats()` snapshots during `checking`

## Important Note

This app is a debugging/reference tool. It is not intended to be a production-quality sample app or a reusable abstraction.
