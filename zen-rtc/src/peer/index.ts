import 'fast-text-encoding';
import { EventEmitter } from 'eventemitter3';
import { PeerEvents, SignalEventPayloadType } from './peer-events';
import { v4 } from 'uuid';
import debuglib from 'debug';
import { removeTrickle } from './remove-trickle';


const CHANNEL_CLOSING_TIMEOUT = 5 * 1000;
const ICECOMPLETE_TIMEOUT = 5 * 1000;

interface GetStatsItem {
  id: string;
  type: string;
  selectedCandidatePairId?: string;
  googActiveConnection?: string;
  selected?: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
  // Spec
  ip?: string;
  address?: string;
  port?: number;
  // FireFox
  ipAddress?: string;
  portNumber?: number;
  googLocalAddress?: string;
  googRemoteAddress?: string;
}

export interface SimplePeerInitOptions {
  initiator: boolean;
  wrtc: {
    RTCPeerConnection: typeof RTCPeerConnection;
    RTCSessionDescription: typeof RTCSessionDescription;
    RTCIceCandidate: typeof RTCIceCandidate;
  };
  enableLogging?: boolean;
  logPrefix?: string;
  disableTrickle?: boolean;
  streams?: MediaStream[];
  channelConfig?: RTCDataChannelInit;
  config?: RTCConfiguration;
  offerOptions?: RTCOfferOptions;
  answerOptions?: RTCAnswerOptions;
  sdpTransform?: (sdp: string) => string;
  iceCompleteTimeout?: number;
}

export class SimplePeer {
  /** Perfect negotiation: polite peer rolls back on offer glare; impolite (initiator) ignores rival offers. */
  private get polite () {
    return !this.options.initiator;
  }

  private eventEmitter: EventEmitter;
  private pc: RTCPeerConnection | null;
  private id: string;
  private debugLogger: debuglib.Debugger;
  private textEncoder: TextEncoder;
  private textDecoder: TextDecoder;
  // state keeping variables
  private destroyed = false;
  private destroying = false;
  private pcReady = false;
  private channelReady = false;
  private connected = false;
  private connecting = false;
  private isReactNativeWebrtc = false;
  private localAddress?: string;
  private localPort?: number;
  private remoteAddress?: string;
  private remotePort?: number;
  private channel?: RTCDataChannel | null = null;
  private closingInterval?: ReturnType<typeof setInterval>;
  private senderMap: Map<MediaStreamTrack, Map<MediaStream, RTCRtpSender>> = new Map();
  private remoteTracks: { track: MediaStreamTrack; stream: MediaStream }[] = [];
  private batchedNegotiation: boolean = false;
  private isNegotiating: boolean = false;
  private queuedNegotiation: boolean = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;
  private iceComplete: boolean = false;
  private iceCompleteTimer?: ReturnType<typeof setTimeout>;
  private sendersAwaitingStable: RTCRtpSender[] = [];
  private pendingCandidates: Extract<SignalEventPayloadType, { type: 'candidate' }>['candidate'][] = [];


  constructor(private readonly options: SimplePeerInitOptions) {
    this.eventEmitter = new EventEmitter();
    this.id = v4();
    this.debugLogger = debuglib(`${options.logPrefix ? options.logPrefix : 'peer'}_${this.id}`);
    if(options.enableLogging) {
      this.debugLogger.enabled = true;
    }
    this.textEncoder = new TextEncoder();
    this.textDecoder = new TextDecoder('utf-8');

    const { RTCPeerConnection } = this.options.wrtc;
    // create the peer connection
    this.pc = new RTCPeerConnection(this.options.config);

    this.setIsReactNativeWebrtc();

    // attach event handlers
    this.pc.oniceconnectionstatechange = () => {
      this.onIceStateChange();
    };
    this.pc.onicegatheringstatechange = () => {
      this.onIceStateChange();
    };
    this.pc.onconnectionstatechange = () => {
      this.onConnectionStateChange();
    };
    this.pc.onsignalingstatechange = () => {
      this.onSignalingStateChange();
    };
    this.pc.onicecandidate = event => {
      this.onIceCandidate(event);
    };

    this.pc.onnegotiationneeded = () => {
      this.enqueueNegotiationNeeded();
    };

    // HACK: Fix for odd Firefox behavior, see: https://github.com/feross/simple-peer/pull/783
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    if (typeof (this.pc as any).peerIdentity === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unused-vars
      (this.pc as any).peerIdentity.catch((err: any) => {
        this._destroy(new Error('ERR_PC_PEER_IDENTITY'));
      });
    }

    if (this.options.initiator) {
      const dataChannelName = `dc_${v4()}`;
      this.setupDataChannel({
        channel: this.pc.createDataChannel(dataChannelName, this.options.channelConfig)
      });
    } else {
      this.pc.ondatachannel = event => {
        this.setupDataChannel(event);
      };
    }

    if (this.options.streams) {
      this.options.streams.forEach(stream => {
        this.addStream(stream);
      });
    }
    this.pc.ontrack = event => {
      this.onTrack(event);
    };
  }

  // #region perfectNegotiation
  private emitSignal(payload: SignalEventPayloadType) {
    if(this.channelReady && this.connected && this.channel) {
      const message = {
        type: 'zen-signal-message',
        payload
      };
      const jsonString = JSON.stringify(message);
      this.debug(`signal<via-data-channel> -> ${payload.type}`);
      // assuming the encoded string will always be under 16KiB
      // which is a sane size for a single `sendData`.
      this.sendData(this.textEncoder.encode(jsonString).buffer);
      return;
    }
    this.debug(`signal -> ${payload.type}`);
    this.emit('signal', payload);
  }

  private enqueueNegotiationNeeded () {
    this.debug('_enqueueNegotiationNeeded');
    if (this.batchedNegotiation) return;
    this.batchedNegotiation = true;
    queueMicrotask(() => {
      this.batchedNegotiation = false;
      this.runNegotiationNeededJob();
    });
  }

  private runNegotiationNeededJob () {
    if (this.destroyed || this.destroying) return;
    if (this.isNegotiating) {
      this.queuedNegotiation = true;
      this.debug('already negotiating, queueing');
      return;
    }
    if (this.pc!.signalingState !== 'stable') {
      this.queuedNegotiation = true;
      this.debug('defer negotiation until stable (signalingState=%s)', this.pc!.signalingState);
      return;
    }
    this.isNegotiating = true;
    this.debug('start negotiation (onnegotiationneeded)');
    setTimeout(() => { // HACK: Chrome crashes if we immediately call createOffer
      if (this.destroyed) return;
      this.makingOffer = true;
      void this.createOffer().finally(() => {
        this.makingOffer = false;
      });
    }, 0);
  }

  private async createOffer () {
    if (this.destroyed) return Promise.resolve();

    return this.pc!.createOffer(this.options.offerOptions)
      .then(offer => {
        if (this.destroyed || !offer.sdp) return;
        if (this.options.disableTrickle === true) offer.sdp = removeTrickle(offer.sdp);
        offer.sdp = this.options.sdpTransform ? this.options.sdpTransform(offer.sdp) : offer.sdp;

        const sendOffer = () => {
          if (this.destroyed) return;
          const signal = this.pc!.localDescription || offer;
          this.emitSignal({
            type: signal.type,
            sdp: signal.sdp ?? ''
          });
        };

        const onSuccess = () => {
          this.debug('createOffer success');
          if (this.destroyed) return;
          if (!this.options.disableTrickle || this.iceComplete) sendOffer();
          else this.eventEmitter.once('_iceComplete', sendOffer); // wait for candidates
        };

        const onError = () => {
          this._destroy(new Error('ERR_SET_LOCAL_DESCRIPTION'));
        };

        return this.pc!.setLocalDescription(offer)
          .then(onSuccess)
          .catch(onError);
      })
      .catch(() => {
        if (!this.destroyed) this._destroy(new Error('ERR_CREATE_OFFER'));
      });
  }

  private addIceCandidate (candidate: Extract<SignalEventPayloadType, { type: 'candidate' }>['candidate']) {
    const iceCandidateObj = new this.options.wrtc.RTCIceCandidate(candidate);
    this.pc!.addIceCandidate(iceCandidateObj)
      .catch(() => {
        if (!iceCandidateObj.address || iceCandidateObj.address.endsWith('.local')) {
          console.warn('Ignoring unsupported ICE candidate.');
        } else {
          this._destroy(new Error('ERR_ADD_ICE_CANDIDATE'));
        }
      });
  }

  private createAnswer () {
    if (this.destroyed) return;

    this.pc!.createAnswer(this.options.answerOptions)
      .then(answer => {
        if (this.destroyed || !answer.sdp) return;
        if (this.options.disableTrickle === true) answer.sdp = removeTrickle(answer.sdp);
        answer.sdp = this.options.sdpTransform ? this.options.sdpTransform(answer.sdp) : answer.sdp;

        const sendAnswer = () => {
          if (this.destroyed) return;
          const signal = this.pc!.localDescription || answer;
          this.emitSignal({
            type: signal.type,
            sdp: signal.sdp ?? ''
          });
        };

        const onSuccess = () => {
          if (this.destroyed) return;
          if (!this.options.disableTrickle || this.iceComplete) sendAnswer();
          else this.eventEmitter.once('_iceComplete', sendAnswer);
        };

        const onError = () => {
          this._destroy(new Error('ERR_SET_LOCAL_DESCRIPTION'));
        };

        this.pc!.setLocalDescription(answer)
          .then(onSuccess)
          .catch(onError);
      })
      .catch(() => {
        this._destroy(new Error('ERR_CREATE_ANSWER'));
      });
  }

  public signal (data: SignalEventPayloadType) {
    if (this.destroying) return;
    if (this.destroyed) throw new Error('ERR_DESTROYED');
    this.debug(`signal(${data.type})`);
    void this.handleSignalPayload(data);
  }

  private async handleSignalPayload (data: SignalEventPayloadType): Promise<void> {
    if (data.type === 'candidate') {
      if (this.ignoreOffer && !this.pc!.remoteDescription) {
        this.debug('skip ICE candidate (ignoreOffer, no remoteDescription)');
        return;
      }
      if (this.pc!.remoteDescription && this.pc!.remoteDescription.type) {
        this.addIceCandidate(data.candidate);
      } else {
        this.pendingCandidates.push(data.candidate);
      }
      return;
    }

    const description = data;
    const readyForOffer =
      !this.makingOffer &&
      (this.pc!.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
    const offerCollision = description.type === 'offer' && !readyForOffer;

    this.ignoreOffer = !this.polite && offerCollision;
    if (this.ignoreOffer) {
      this.debug('impolite: ignoring colliding offer');
      return;
    }

    if (description.type === 'answer') {
      this.isSettingRemoteAnswerPending = true;
    }

    const SessionDesc = this.options.wrtc.RTCSessionDescription;

    try {
      if (offerCollision && this.polite) {
        this.debug('polite: rollback + apply remote offer');
        await Promise.all([
          this.pc!.setLocalDescription({ type: 'rollback' }),
          this.pc!.setRemoteDescription(new SessionDesc(description))
        ]);
      } else {
        await this.pc!.setRemoteDescription(new SessionDesc(description));
      }
    } catch {
      this._destroy(new Error('ERR_SET_REMOTE_DESCRIPTION'));
      return;
    } finally {
      if (description.type === 'answer') {
        this.isSettingRemoteAnswerPending = false;
      }
    }

    if (this.destroyed) return;

    this.pendingCandidates.forEach(candidate => {
      this.addIceCandidate(candidate);
    });
    this.pendingCandidates = [];

    if (this.pc!.remoteDescription?.type === 'offer') this.createAnswer();
  }
  // #endregion

  private onTrack (event: RTCTrackEvent) {
    if (this.destroyed) return;

    event.streams.forEach(mediaStream => {
      this.debug('on track');
      this.emit('track', {
        track: event.track,
        stream: mediaStream
      });

      const mediaStreamAlreadyExists = this.remoteTracks.map(rt => rt.stream).some(remoteStream => remoteStream.id === mediaStream.id);

      this.remoteTracks.push({
        track: event.track,
        stream: mediaStream
      });

      if (mediaStreamAlreadyExists) return; // Only fire one 'stream' event, even though there may be multiple tracks per stream

      queueMicrotask(() => {
        this.debug('on stream');
        this.emit('stream', mediaStream); // ensure all tracks have been added
      });
    });
  }

  addTransceiver (kind: string, init?: RTCRtpTransceiverInit) {
    if (this.destroying) return;
    if (this.destroyed) throw new Error('ERR_DESTROYED');
    this.debug('addTransceiver()');

    try {
      this.pc!.addTransceiver(kind, init);
    } catch {
      this._destroy(new Error('ERR_ADD_TRANSCEIVER'));
    }
  }

  public addStream (stream: MediaStream) {
    if (this.destroying) return;
    if (this.destroyed) throw new Error('ERR_DESTROYED');
    this.debug('addStream()');
    if(this.pc!.addTrack != null) {
      stream.getTracks().forEach(track => {
        this.addTrack(track, stream);
      });
    } else {
      /* logic to support react-native-webrtc */
      type ReactNativeRTCPeerConnection = RTCPeerConnection & { addStream: (stream: MediaStream) => void };
      const pcForReactNative = this.pc! as ReactNativeRTCPeerConnection;
      pcForReactNative.addStream(stream);
    }
  }

  public addTrack (track: MediaStreamTrack, stream: MediaStream) {
    if (this.destroying) return;
    if (this.destroyed) throw new Error('ERR_DESTROYED');
    this.debug('addTrack()');

    const submap = this.senderMap.get(track) || new Map<MediaStream, RTCRtpSender>(); // nested Maps map [track, stream] to sender
    let sender = submap.get(stream);
    if (!sender) {
      sender = this.pc!.addTrack(track, stream);
      submap.set(stream, sender);
      this.senderMap.set(track, submap);
    } else {
      throw new Error('ERR_SENDER_ALREADY_ADDED');
    }
  }

  public removeTrack (track: MediaStreamTrack, stream: MediaStream) {
    if (this.destroying) return;
    if (this.destroyed) throw new Error('ERR_DESTROYED');
    this.debug('removeSender()');

    const submap = this.senderMap.get(track);
    const sender = submap ? submap.get(stream) : null;
    if (!sender) {
      throw new Error('ERR_TRACK_NOT_ADDED');
    }
    try {
      this.pc!.removeTrack(sender);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (err.name === 'NS_ERROR_UNEXPECTED') {
        this.sendersAwaitingStable.push(sender); // HACK: Firefox must wait until (signalingState === stable) https://bugzilla.mozilla.org/show_bug.cgi?id=1133874
      } else {
        this._destroy(new Error('ERR_REMOVE_TRACK'));
      }
    }
  }

  public removeStream (stream: MediaStream) {
    if (this.destroying) return;
    if (this.destroyed) throw new Error('ERR_DESTROYED');
    this.debug('removeSenders()');

    stream.getTracks().forEach(track => {
      this.removeTrack(track, stream);
    });
  }

  // #region setupDataChannel

  public sendData(data: ArrayBuffer) {
    if(this.destroyed || !this.channelReady) return false;
    this.channel!.send(data);
  }

  private isMessageSignal(event: MessageEvent<ArrayBuffer>) {
    // What's happening here?
    // In this function we want to distinguish between the message
    // being a signaling message as opposed to a user message.
    // To do this we check if the message starts with `{"type": "zen-signal-message"`
    // we don't convert to a string and parse to json to save memory.
    const eventData = new Uint8Array(event.data);
    const prefix = new Uint8Array([
      // {
      123,
      // "type":
      34, 116, 121, 112, 101, 34, 58,
      // "zen-signal-message"
      34, 122, 101, 110, 45, 115, 105, 103, 110, 97, 108, 45,
      109, 101, 115, 115,  97, 103, 101, 34
    ]);
    if(eventData.length > prefix.length) {
      const prefixDoesNotMatch = prefix.some((value, idx) => eventData.at(idx) !== value);
      const prefixMatches = !prefixDoesNotMatch;
      return prefixMatches;
    }
    return false;
  }

  private onChannelMessage (event: MessageEvent<ArrayBuffer>) {
    if (this.destroyed) return;
    // the data received could be a signaling message, in which case
    // we will emit the 'signal' event and not 'data'.
    const isSignal = this.isMessageSignal(event);
    if(isSignal) {
      const decoded = this.textDecoder.decode(event.data);
      const parsed = JSON.parse(decoded) as { payload: SignalEventPayloadType };
      this.debug(`signal(${parsed.payload.type}) received via data-channel`);
      this.signal(parsed.payload);
      return;
    }
    this.emit('data', event.data);
  }

  private onChannelOpen() {
    if (this.connected || this.destroyed) return;
    this.debug('on channel open');
    this.channelReady = true;
    this.waitForCandidatePair();
  }

  private onChannelClose () {
    if (this.destroyed) return;
    this.debug('on channel close');
    this._destroy();
  }

  private setupDataChannel(event: { channel: RTCDataChannel; }) {
    if (!event.channel) {
      // In some situations `pc.createDataChannel()` returns `undefined` (in wrtc),
      // which is invalid behavior. Handle it gracefully.
      // See: https://github.com/feross/simple-peer/issues/163
      return this._destroy(new Error('ERR_DATA_CHANNEL'));
    }

    this.channel = event.channel;
    this.channel.binaryType = 'arraybuffer';

    this.channel.onmessage = event => {
      this.onChannelMessage(event as MessageEvent<ArrayBuffer>);
    };
    this.channel.onopen = () => {
      this.onChannelOpen();
    };
    this.channel.onclose = () => {
      this.onChannelClose();
    };
    this.channel.onerror = (ev) => {
      const event = ev as RTCErrorEvent;
      this._destroy(event.error ?? new Error('ERR_DATA_CHANNEL_ON_ERROR'));
    };

    // HACK: Chrome will sometimes get stuck in readyState "closing", let's check for this condition
    // https://bugs.chromium.org/p/chromium/issues/detail?id=882743
    let isClosing = false;
    this.closingInterval = setInterval(() => { // No "onclosing" event
      if (this.channel && this.channel.readyState === 'closing') {
        if (isClosing) this.onChannelClose(); // closing timed out: equivalent to onclose firing
        isClosing = true;
      } else {
        isClosing = false;
      }
    }, CHANNEL_CLOSING_TIMEOUT);
  }

  // #endregion

  private setIsReactNativeWebrtc() {
    // We prefer feature detection whenever possible, but sometimes that's not
    // possible for certain implementations.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const anyCastForPC = this.pc as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    this.isReactNativeWebrtc = typeof (anyCastForPC._peerConnectionId) === 'number';
  }

  private debug(...args: unknown[]) {
    // eslint-disable-next-line prefer-rest-params
    // const args: unknown[] = [].slice.call(arguments);
    // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
    this.debugLogger(args[0], ...args.slice(1));
  }

  // #region IceStateChange

  /* eslint-disable */
  // TODO: Need to refactor this function it has been copied and pasted as is.
  private getStats(cb: (error?: any, items?: GetStatsItem[]) => void) {
    // statreports can come with a value array instead of properties
    const flattenValues = (report:any) => {
      if (Object.prototype.toString.call(report.values) === '[object Array]') {
        report.values.forEach((value:any) => {
          Object.assign(report, value);
        });
      }
      return report;
    };

    // Promise-based getStats() (standard)
    if (this.pc!.getStats.length === 0 || this.isReactNativeWebrtc) {
      this.pc!.getStats()
        .then(res => {
          const reports: any[] = [];
          res.forEach(report => {
            reports.push(flattenValues(report));
          });
          cb(null, reports);
        }, err => cb(err));

    // Single-parameter callback-based getStats() (non-standard)
    } else if (this.pc!.getStats.length > 0) {
      (this.pc as any).getStats((res: any) => {
        // If we destroy connection in `connect` callback this code might happen to run when actual connection is already closed
        if (this.destroyed) return;

        const reports: any[] = [];
        res.result().forEach((result: any) => {
          const report: any = {};
          result.names().forEach((name: any) => {
            report[name] = result.stat(name);
          });
          report.id = result.id;
          report.type = result.type;
          report.timestamp = result.timestamp;
          reports.push(flattenValues(report));
        });
        cb(null, reports);
      }, (err: any) => cb(err));

    // Unknown browser, skip getStats() since it's anyone's guess which style of
    // getStats() they implement.
    } else {
      cb(null, []);
    }
  }
  /* eslint-enable */

  private waitForCandidatePair () {
    this.debug('maybeReady pc %s channel %s', this.pcReady, this.channelReady);
    if (this.connected || this.connecting || !this.pcReady || !this.channelReady) return;

    this.connecting = true;

    // HACK: We can't rely on order here, for details see https://github.com/js-platform/node-webrtc/issues/339
    const findCandidatePair = () => {
      if (this.destroyed) return;

      this.getStats((err, items) => {
        if (this.destroyed) return;

        // Treat getStats error as non-fatal. It's not essential.
        if (err) items = [];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const remoteCandidates: { [k: string]: GetStatsItem } = {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const localCandidates: { [k: string]: GetStatsItem } = {};
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const candidatePairs: { [k: string]: GetStatsItem } = {};
        let foundSelectedCandidatePair = false;

        items?.forEach(item => {
          // TODO: Once all browsers support the hyphenated stats report types, remove
          // the non-hypenated ones
          if (item.type === 'remotecandidate' || item.type === 'remote-candidate') {
            remoteCandidates[item.id] = item;
          }
          if (item.type === 'localcandidate' || item.type === 'local-candidate') {
            localCandidates[item.id] = item;
          }
          if (item.type === 'candidatepair' || item.type === 'candidate-pair') {
            candidatePairs[item.id] = item;
          }
        });

        const setSelectedCandidatePair = (selectedCandidatePair: GetStatsItem) => {
          foundSelectedCandidatePair = true;

          const local = localCandidates[selectedCandidatePair.localCandidateId as string];

          if (local && (local.ip || local.address)) {
            // Spec
            this.localAddress = local.ip || local.address;
            this.localPort = Number(local.port);
          } else if (local && local.ipAddress) {
            // Firefox
            this.localAddress = local.ipAddress;
            this.localPort = Number(local.portNumber);
          } else if (typeof selectedCandidatePair.googLocalAddress === 'string') {
            // TODO: remove this once Chrome 58 is released
            const local = selectedCandidatePair.googLocalAddress.split(':');
            this.localAddress = local[0];
            this.localPort = Number(local[1]);
          }

          const remote = remoteCandidates[selectedCandidatePair.remoteCandidateId as string];

          if (remote && (remote.ip || remote.address)) {
            // Spec
            this.remoteAddress = remote.ip || remote.address;
            this.remotePort = Number(remote.port);
          } else if (remote && remote.ipAddress) {
            // Firefox
            this.remoteAddress = remote.ipAddress;
            this.remotePort = Number(remote.portNumber);
          } else if (typeof selectedCandidatePair.googRemoteAddress === 'string') {
            // TODO: remove this once Chrome 58 is released
            const remote = selectedCandidatePair.googRemoteAddress.split(':');
            this.remoteAddress = remote[0];
            this.remotePort = Number(remote[1]);
          }

          this.debug(
            'connect local: %s:%s remote: %s:%s',
            this.localAddress,
            this.localPort,
            this.remoteAddress,
            this.remotePort
          );
        };

        items?.forEach(item => {
          // Spec-compliant
          if (item.type === 'transport' && item.selectedCandidatePairId) {
            setSelectedCandidatePair(candidatePairs[item.selectedCandidatePairId]);
          }

          // Old implementations
          if (
            (item.type === 'googCandidatePair' && item.googActiveConnection === 'true') ||
            ((item.type === 'candidatepair' || item.type === 'candidate-pair') && item.selected)
          ) {
            setSelectedCandidatePair(item);
          }
        });

        // Ignore candidate pair selection in browsers like Safari 11 that do not have any local or remote candidates
        // But wait until at least 1 candidate pair is available
        if (!foundSelectedCandidatePair && (!Object.keys(candidatePairs).length || Object.keys(localCandidates).length)) {
          setTimeout(findCandidatePair, 100);
          return;
        } else {
          this.connecting = false;
          this.connected = true;
        }

        this.debug('connected');
        this.emit('connect', undefined);
      });
    };
    findCandidatePair();
  }

  private onIceStateChange() {
    if (this.destroyed) return;
    const iceConnectionState = this.pc!.iceConnectionState;
    const iceGatheringState = this.pc!.iceGatheringState;

    this.debug(
      'iceStateChange (connection: %s) (gathering: %s)',
      iceConnectionState,
      iceGatheringState
    );
    this.emit('iceStateChange', {
      iceConnectionState,
      iceGatheringState
    });

    if (iceConnectionState === 'connected' || iceConnectionState === 'completed') {
      this.pcReady = true;
      this.waitForCandidatePair();
    }
    if (iceConnectionState === 'failed') {
      this._destroy(new Error('ERR_ICE_CONNECTION_FAILURE'));
    }
    if (iceConnectionState === 'closed') {
      this._destroy(new Error('ERR_ICE_CONNECTION_CLOSED'));
    }
  }

  // #endregion
  public destroy() {
    this._destroy();
  }

  private _destroy(err?: Error) {
    if (this.destroyed || this.destroying) return;
    this.destroying = true;

    this.debug('destroying (error: %s)', err && (err.message || err));

    queueMicrotask(() => { // allow events concurrent with the call to _destroy() to fire (see #692)
      this.destroyed = true;
      this.destroying = false;

      this.debug('destroy (error: %s)', err && (err.message || err));

      this.connected = false;
      this.pcReady = false;
      this.channelReady = false;
      this.remoteTracks = [];
      this.senderMap = new Map();

      clearInterval(this.closingInterval);
      this.closingInterval = undefined;

      if (this.channel) {
        try {
          this.channel.close();
        } catch (err) {
          0;
        }

        // allow events concurrent with destruction to be handled
        this.channel.onmessage = null;
        this.channel.onopen = null;
        this.channel.onclose = null;
        this.channel.onerror = null;
      }
      if (this.pc) {
        try {
          this.pc.close();
        } catch (err) {
          0;
        }

        // allow events concurrent with destruction to be handled
        this.pc.oniceconnectionstatechange = null;
        this.pc.onicegatheringstatechange = null;
        this.pc.onsignalingstatechange = null;
        this.pc.onicecandidate = null;
        this.pc.onnegotiationneeded = null;
        this.pc.ontrack = null;
        this.pc.ondatachannel = null;
      }
      this.pc = null;
      this.channel = null;

      if (err) this.emit('error', err);
      this.emit('close', undefined);
    });
  }

  private onConnectionStateChange() {
    if (this.destroyed) return;
    if (this.pc!.connectionState === 'failed') {
      this._destroy(new Error('ERR_CONNECTION_FAILURE'));
    }
  }

  private onSignalingStateChange() {
    if (this.destroyed) return;

    if (this.pc!.signalingState === 'stable') {
      this.isNegotiating = false;

      if(this.sendersAwaitingStable.length > 0) {
        // HACK: Firefox doesn't yet support removing tracks when signalingState !== 'stable'
        this.debug('flushing sender queue', this.sendersAwaitingStable);
        this.sendersAwaitingStable.forEach(sender => {
          this.pc!.removeTrack(sender);
        });
        this.sendersAwaitingStable = [];
      }

      if (this.queuedNegotiation) {
        this.debug('flushing negotiation queue');
        this.queuedNegotiation = false;
        this.enqueueNegotiationNeeded();
      } else {
        this.debug('signaling state now stable');
        this.emit('negotiated', undefined);
      }
    }

    this.debug('signalingStateChange %s', this.pc!.signalingState);
    this.emit('signalingStateChange', this.pc!.signalingState);
  }

  // #region onIceCandidate
  private startIceCompleteTimeout () {
    if (this.destroyed) return;
    if (this.iceCompleteTimer) return;
    this.debug('started iceComplete timeout');
    this.iceCompleteTimer = setTimeout(() => {
      if (!this.iceComplete) {
        this.iceComplete = true;
        this.debug('iceComplete timeout completed');
        this.emit('iceTimeout', undefined);
        this.emit('_iceComplete', undefined);
      }
    }, this.options.iceCompleteTimeout != null ? this.options.iceCompleteTimeout : ICECOMPLETE_TIMEOUT);
  }

  private onIceCandidate(event: RTCPeerConnectionIceEvent) {
    if (this.destroyed) return;
    if (event.candidate && !this.options.disableTrickle) {
      this.emitSignal({
        type: 'candidate',
        candidate: {
          candidate: event.candidate.candidate,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          sdpMid: event.candidate.sdpMid
        }
      });
    } else if (!event.candidate && !this.iceComplete) {
      this.iceComplete = true;
      this.emit('_iceComplete', undefined);
    }
    // as soon as we've received one valid candidate start timeout
    if (event.candidate) {
      this.startIceCompleteTimeout();
    }
  }

  // #endregion

  public on<K extends keyof PeerEvents>(eventName: K, handler: (payload: PeerEvents[K]) => void): void {
    this.eventEmitter.on(eventName, handler);
  }

  private emit<K extends keyof PeerEvents>(eventName: K, payload: PeerEvents[K]): void {
    this.eventEmitter.emit(eventName, payload);
  }

  public removeAllListeners() {
    this.eventEmitter.removeAllListeners();
  }

  public getRTCPeerConnection() {
    return this.pc;
  }

}
