import { SimplePeer } from '@zen-rtc/index';

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  (window as any).DEBUG='*';
  // const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const peer1 = new SimplePeer({
    initiator: true,
    enableLogging: true,
    wrtc: {
      RTCIceCandidate,
      RTCPeerConnection,
      RTCSessionDescription,
    }
  });
  console.log(peer1);
  console.log('heya');
}

window.addEventListener('load', () => {
  main().then(() => {}).catch(() => {});
});