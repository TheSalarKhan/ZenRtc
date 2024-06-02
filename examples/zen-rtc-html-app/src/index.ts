import { SimplePeer } from '@zen-rtc/index';

function main() {

  const rtcConfiguration: RTCConfiguration = {
    iceServers: [
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:global.stun.twilio.com:3478'
        ]
      }
    ],
  };

  const peer1 = new SimplePeer({
    config: rtcConfiguration,
    initiator: true,
    enableLogging: true,
    wrtc: {
      RTCIceCandidate,
      RTCPeerConnection,
      RTCSessionDescription,
    },
  });

  const peer2 = new SimplePeer({
    config: rtcConfiguration,
    initiator: false,
    enableLogging: true,
    wrtc: {
      RTCIceCandidate,
      RTCPeerConnection,
      RTCSessionDescription,
    },
  });

  peer1.on('connect', () => {
    console.log('peer1 connected');
  });
  peer1.on('signal', (payload) => {
    peer2.signal(payload);
  });
  peer2.on('connect', () => {
    console.log('peer2 connected');
  });
  peer2.on('signal', (payload) => {
    peer1.signal(payload);
  });
}

window.addEventListener('load', () => {
  main();
});