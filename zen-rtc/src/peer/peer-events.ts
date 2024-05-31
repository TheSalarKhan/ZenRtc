type AllPeerEvents = {
  eventName:'eventA',
  payload: {
    something: string;
    someOtherThing: number;
  }
} | {
  eventName: 'eventB',
  payload: {
    eventPayloadB: string;
  }
}

export type PeerEvents = {
  [K in AllPeerEvents['eventName']]: Extract<AllPeerEvents, { eventName: K }>['payload'];
};