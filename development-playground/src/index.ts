import { SimplePeer } from '@zen-rtc/index';

async function main() {

  const cameraStream = await navigator.mediaDevices.getUserMedia({video: true});
  const remoteVideo1 = document.getElementById('remoteVideo1') as HTMLVideoElement;
  const remoteVideo2 = document.getElementById('remoteVideo2') as HTMLVideoElement;

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
    logPrefix: 'P1',
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
    logPrefix: '   P2',
    wrtc: {
      RTCIceCandidate,
      RTCPeerConnection,
      RTCSessionDescription,
    },
  });

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder('utf-8');

  peer1.on('connect', () => {
    console.log('peer1 connected');
    peer1.sendData(textEncoder.encode('Hello peer2!').buffer);
    peer1.addStream(cameraStream);
  });
  peer1.on('signal', (payload) => {
    peer2.signal(payload);
  });
  peer1.on('data', (payload) => {
    console.log('got data from peer2');
    console.log(textDecoder.decode(payload));
  });
  peer1.on('stream', (stream) => {
    remoteVideo1.srcObject = stream;
  });

  peer2.on('connect', () => {
    console.log('peer2 connected');
    peer2.sendData(textEncoder.encode('Hello peer1!').buffer);
    peer2.addStream(cameraStream);
  });
  peer2.on('signal', (payload) => {
    peer1.signal(payload);
  });
  peer2.on('data', (payload) => {
    console.log('got data from peer1');
    console.log(textDecoder.decode(payload));
  });
  peer2.on('stream', (stream) => {
    remoteVideo2.srcObject = stream;
  });

}

window.addEventListener('load', () => {
  main().then(() => {}).catch(() => {});
});