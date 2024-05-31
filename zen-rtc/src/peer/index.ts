import { EventEmitter } from 'eventemitter3';
import { PeerEvents } from './peer-events';

export class Peer {
  private eventEmitter: EventEmitter;

  constructor() {
    this.eventEmitter = new EventEmitter();
  }

  public on<K extends keyof PeerEvents>(eventName: K, handler: (payload: PeerEvents[K]) => void): void {
    this.eventEmitter.on(eventName, handler);
  }

  private emit<K extends keyof PeerEvents>(eventName: K, payload: PeerEvents[K]): void {
    this.eventEmitter.emit(eventName, payload);
  }

}