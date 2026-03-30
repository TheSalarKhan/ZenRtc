type PeerLabel = 'pc1' | 'pc2';

type SignalMessage =
  | { type: 'description'; description: RTCSessionDescriptionInit }
  | { type: 'candidate'; candidate: RTCIceCandidateInit };

type PeerContext = {
  label: PeerLabel;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  dataChannel: RTCDataChannel | null;
  streamAdded: boolean;
};

function logPeer(peer: PeerLabel, message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`[${peer}] ${message}`);
    return;
  }
  console.log(`[${peer}] ${message}`, payload);
}

function setStatus(peer: PeerLabel, message: string) {
  const statusId = peer === 'pc1' ? 'status1' : 'status2';
  const node = document.getElementById(statusId);
  if (node) {
    node.textContent = `${peer}: ${message}`;
  }
}

function describeCandidate(candidate: RTCIceCandidateInit) {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment
  };
}

function describeDescription(description: RTCSessionDescriptionInit) {
  return {
    type: description.type,
    sdpLength: description.sdp?.length
  };
}

async function main() {
  const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
  const remoteVideo1 = document.getElementById('remoteVideo1') as HTMLVideoElement;
  const remoteVideo2 = document.getElementById('remoteVideo2') as HTMLVideoElement;

  const rtcConfiguration: RTCConfiguration = {
    iceServers: [
      {
        urls: [
          'stun:stun.l.google.com:19302',
        ]
      }
    ],
  };

  const pc1 = new RTCPeerConnection(rtcConfiguration);
  const pc2 = new RTCPeerConnection(rtcConfiguration);

  const ctx1: PeerContext = {
    label: 'pc1',
    pc: pc1,
    polite: false,
    makingOffer: false,
    ignoreOffer: false,
    isSettingRemoteAnswerPending: false,
    pendingCandidates: [],
    dataChannel: null,
    streamAdded: false
  };

  const ctx2: PeerContext = {
    label: 'pc2',
    pc: pc2,
    polite: true,
    makingOffer: false,
    ignoreOffer: false,
    isSettingRemoteAnswerPending: false,
    pendingCandidates: [],
    dataChannel: null,
    streamAdded: false
  };

  logPeer('pc1', 'created peer connection', { polite: ctx1.polite });
  logPeer('pc2', 'created peer connection', { polite: ctx2.polite });

  const getOtherContext = (context: PeerContext) => {
    return context.label === 'pc1' ? ctx2 : ctx1;
  };

  const maybeAddLocalStream = (context: PeerContext) => {
    if (context.streamAdded) return;
    cameraStream.getTracks().forEach(track => {
      context.pc.addTrack(track, cameraStream);
    });
    context.streamAdded = true;
    logPeer(context.label, 'added local stream tracks');
  };

  const flushPendingCandidates = async (context: PeerContext) => {
    if (!context.pc.remoteDescription) return;
    logPeer(context.label, `flush queued candidates count=${context.pendingCandidates.length}`);
    while (context.pendingCandidates.length > 0) {
      const candidate = context.pendingCandidates.shift();
      if (!candidate) continue;
      logPeer(context.label, 'flushing queued candidate', describeCandidate(candidate));
      await context.pc.addIceCandidate(candidate);
      logPeer(context.label, 'applied queued candidate', describeCandidate(candidate));
    }
  };

  const deliverSignal = async (from: PeerContext, to: PeerContext, message: SignalMessage) => {
    if (message.type === 'candidate') {
      logPeer(from.label, 'sending ICE candidate', describeCandidate(message.candidate));

      if (to.ignoreOffer && !to.pc.remoteDescription) {
        logPeer(to.label, 'ignoring ICE candidate because collided offer is being ignored', describeCandidate(message.candidate));
        return;
      }

      if (!to.pc.remoteDescription) {
        to.pendingCandidates.push(message.candidate);
        logPeer(to.label, 'queued ICE candidate before remote description', describeCandidate(message.candidate));
        return;
      }

      await to.pc.addIceCandidate(message.candidate);
      logPeer(to.label, 'applied ICE candidate', describeCandidate(message.candidate));
      return;
    }

    const description = message.description;
    logPeer(to.label, 'received remote description', describeDescription(description));

    const readyForOffer =
      !to.makingOffer &&
      (to.pc.signalingState === 'stable' || to.isSettingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;

    logPeer(to.label, `readyForOffer=${readyForOffer}`);
    logPeer(to.label, `offerCollision=${offerCollision}`);

    to.ignoreOffer = !to.polite && offerCollision;
    logPeer(to.label, `ignoreOffer=${to.ignoreOffer}`);

    if (to.ignoreOffer) {
      return;
    }

    try {
      if (description.type === 'answer') {
        to.isSettingRemoteAnswerPending = true;
      }

      if (offerCollision && to.polite) {
        logPeer(to.label, 'polite peer rolling back local description');
        await Promise.all([
          to.pc.setLocalDescription({ type: 'rollback' }),
          to.pc.setRemoteDescription(description)
        ]);
      } else {
        logPeer(to.label, `apply remote description type=${description.type}`);
        await to.pc.setRemoteDescription(description);
      }
      logPeer(to.label, 'setRemoteDescription success', describeDescription(description));
    } finally {
      if (description.type === 'answer') {
        to.isSettingRemoteAnswerPending = false;
      }
    }

    await flushPendingCandidates(to);

    if (description.type === 'offer') {
      logPeer(to.label, 'sending answer generated by setLocalDescription()');
      await to.pc.setLocalDescription();
      if (to.pc.localDescription) {
        await deliverSignal(to, from, {
          type: 'description',
          description: to.pc.localDescription.toJSON()
        });
      }
    }
  };

  const setupDataChannel = (context: PeerContext, channel: RTCDataChannel) => {
    context.dataChannel = channel;
    channel.onopen = () => {
      logPeer(context.label, `data channel open label=${channel.label}`);
      setStatus(context.label, 'data channel open');
      if (context.label === 'pc1') {
        channel.send('Hello pc2!');
      } else {
        channel.send('Hello pc1!');
      }
      maybeAddLocalStream(context);
    };
    channel.onclose = () => {
      logPeer(context.label, `data channel close label=${channel.label}`);
    };
    channel.onerror = (event) => {
      logPeer(context.label, `data channel error label=${channel.label}`, event);
    };
    channel.onmessage = (event) => {
      logPeer(context.label, `data channel message label=${channel.label}`, event.data);
    };
  };

  const installPeerEventLogging = (context: PeerContext) => {
    const pc = context.pc;
    pc.oniceconnectionstatechange = () => {
      logPeer(context.label, `iceConnectionState=${pc.iceConnectionState}`);
      setStatus(context.label, `ice=${pc.iceConnectionState}`);
    };
    pc.onconnectionstatechange = () => {
      logPeer(context.label, `connectionState=${pc.connectionState}`);
      setStatus(context.label, `connection=${pc.connectionState}`);
    };
    pc.onsignalingstatechange = () => {
      logPeer(context.label, `signalingState=${pc.signalingState}`);
    };
    pc.onicecandidateerror = (event) => {
      const errorEvent = event as RTCPeerConnectionIceErrorEvent;
      const hostCandidate = (errorEvent as RTCPeerConnectionIceErrorEvent & { hostCandidate?: string }).hostCandidate;
      logPeer(context.label, 'icecandidateerror', {
        address: errorEvent.address,
        hostCandidate,
        port: errorEvent.port,
        url: errorEvent.url,
        errorCode: errorEvent.errorCode,
        errorText: errorEvent.errorText
      });
    };
  };

  const installNegotiationHandlers = (context: PeerContext) => {
    context.pc.onnegotiationneeded = () => {
      logPeer(context.label, 'negotiationneeded fired');
      context.makingOffer = true;
      logPeer(context.label, 'makingOffer=true');
      context.pc.setLocalDescription()
        .then(async () => {
          if (!context.pc.localDescription) return;
          logPeer(context.label, `sending local description type=${context.pc.localDescription.type}`);
          await deliverSignal(context, getOtherContext(context), {
            type: 'description',
            description: context.pc.localDescription.toJSON()
          });
        })
        .catch((error: unknown) => {
          logPeer(context.label, 'negotiation failed', error);
        })
        .finally(() => {
          context.makingOffer = false;
          logPeer(context.label, 'makingOffer=false');
        });
    };
  };

  const installIceHandlers = (context: PeerContext) => {
    context.pc.onicecandidate = (event) => {
      if (!event.candidate) {
        logPeer(context.label, 'ice gathering complete');
        return;
      }
      const candidate: RTCIceCandidateInit = {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment
      };
      logPeer(context.label, 'gathered ICE candidate', describeCandidate(candidate));
      deliverSignal(context, getOtherContext(context), {
        type: 'candidate',
        candidate
      }).catch((error: unknown) => {
        logPeer(getOtherContext(context).label, `failed to apply ICE candidate from ${context.label}`, error);
      });
    };
  };

  const installTrackHandlers = (context: PeerContext) => {
    context.pc.ontrack = (event) => {
      logPeer(context.label, 'received track', {
        trackId: event.track.id,
        streamIds: event.streams.map(stream => stream.id)
      });
      const [stream] = event.streams;
      if (!stream) return;
      if (context.label === 'pc1') {
        remoteVideo1.srcObject = stream;
      } else {
        remoteVideo2.srcObject = stream;
      }
      logPeer(context.label, 'assigned remote stream to video', { streamId: stream.id });
    };
  };

  installPeerEventLogging(ctx1);
  installPeerEventLogging(ctx2);
  installNegotiationHandlers(ctx1);
  installNegotiationHandlers(ctx2);
  installIceHandlers(ctx1);
  installIceHandlers(ctx2);
  installTrackHandlers(ctx1);
  installTrackHandlers(ctx2);

  const initialDataChannel = ctx1.pc.createDataChannel('raw-webrtc-demo');
  logPeer(ctx1.label, `created data channel label=${initialDataChannel.label}`);
  setupDataChannel(ctx1, initialDataChannel);

  ctx2.pc.ondatachannel = (event) => {
    logPeer(ctx2.label, `received data channel label=${event.channel.label}`);
    setupDataChannel(ctx2, event.channel);
  };
}

window.addEventListener('load', () => {
  main().catch((error: unknown) => {
    console.error('[app] failed to start raw webrtc playground', error);
  });
});
