export type SignalEventPayloadType = {
    type: 'renegotiate',
    renegotiate: boolean
  } | {
    type: RTCSdpType,
    sdp: string
  } | {
    type: 'candidate',
    candidate: {
      candidate: string,
      sdpMLineIndex: number | null,
      sdpMid: string | null
    }
  } | {
    type: 'transceiverRequest',
    transceiverRequest: {
      kind: string,
      init?: RTCRtpTransceiverInit
    }
  };

type PeerEventsMap = {
  eventName:'iceStateChange',
  payload: {
    iceConnectionState: RTCIceConnectionState,
    iceGatheringState: RTCIceGatheringState
  }
} | {
  eventName: 'connect',
  payload: undefined
} | {
  eventName: 'error',
  payload: Error
} | {
  eventName: 'close',
  payload: undefined
} | {
  eventName: 'data',
  payload: ArrayBuffer
} | {
  eventName: 'track',
  payload: {
    stream: MediaStream,
    track: MediaStreamTrack
  }
} | {
  eventName: 'stream',
  payload: {
    stream: MediaStream
  }
} | {
  eventName: 'signal',
  payload: SignalEventPayloadType
} | {
  eventName: '_iceComplete',
  payload: undefined
} | {
  eventName: 'iceTimeout',
  payload: undefined
} | {
  eventName: 'negotiated',
  payload: undefined
} | {
  eventName: 'signalingStateChange',
  payload: RTCSignalingState
}

export type PeerEvents = {
  [K in PeerEventsMap['eventName']]: Extract<PeerEventsMap, { eventName: K }>['payload'];
};