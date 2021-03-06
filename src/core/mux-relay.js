import {Relay} from './relay';
import {logger} from '../utils';

import {
  TcpInbound, TcpOutbound,
  TlsInbound, TlsOutbound,
  WsInbound, WsOutbound,
  MuxInbound, MuxOutbound,
} from '../transports';

import {
  MUX_DATA_FRAME,
  MUX_NEW_CONN,
  MUX_CLOSE_CONN,
} from '../presets/defs';

export class MuxRelay extends Relay {

  static allSubRelays = new Map();

  _subRelays = new Map();

  // overwrites

  getBounds(transport) {
    const mapping = {
      'tcp': [TcpInbound, TcpOutbound],
      'tls': [TlsInbound, TlsOutbound],
      'ws': [WsInbound, WsOutbound],
    };
    const [Inbound, Outbound] = __IS_CLIENT__ ? [MuxInbound, mapping[transport][1]] : [mapping[transport][0], MuxOutbound];
    return {Inbound, Outbound};
  }

  onBroadcast(action) {
    switch (action.type) {
      case MUX_NEW_CONN:
        return this.onNewSubConn(action.payload);
      case MUX_DATA_FRAME:
        return this.onDataFrame(action.payload);
      case MUX_CLOSE_CONN:
        return this.onSubConnCloseByProtocol(action.payload);
    }
    this._inbound && this._inbound.onBroadcast(action);
    this._outbound && this._outbound.onBroadcast(action);
  }

  preparePresets(presets) {
    const first = presets[0];
    // add "mux" preset to the top if it's a mux relay
    if (!first || first.name !== 'mux') {
      presets = [{'name': 'mux'}].concat(presets);
    }
    return presets;
  }

  destroy() {
    super.destroy();
    const subRelays = this.getSubRelays();
    if (subRelays) {
      logger.info(`[mux-${this.id}] connection destroyed, cleanup ${subRelays.size} sub connections`);
      // cleanup associate relays
      for (const relay of subRelays.values()) {
        relay.destroy();
      }
      subRelays.clear();
      this._subRelays = null;
    }
  }

  // events

  onNewSubConn({cid, host, port}) {
    // const muxRelay = this;
    const muxRelay = this._ctx.getMuxRelay();
    if (muxRelay) {
      const context = {
        socket: this._ctx.socket,
        remoteInfo: this._ctx.remoteInfo,
        cid,
        muxRelay, // NOTE: associate the mux relay here
      };
      const relay = new Relay({transport: 'mux', context});
      const proxyRequest = {
        host: host,
        port: port,
        onConnected: () => {
          // logger.debug(`[mux-${muxRelay.id}] flush ${relay.__pendingFrames.length} pending frames`);
          for (const frame of relay.__pendingFrames) {
            relay.decode(frame);
          }
          relay.__pendingFrames = null;
        }
      };

      function onClose() {
        const relay = muxRelay._getSubRelay(cid);
        if (relay) {
          muxRelay.destroySubRelay(cid);
          logger.debug(`[mux-${muxRelay.id}] sub connection(cid=${cid}) closed by self, remains: ${muxRelay.getSubRelays().size}`);
        }
        // else {
        //   logger.warn(`[mux-${muxRelay.id}] fail to close sub connection by self, no such sub connection(cid=${cid})`);
        // }
      }

      relay.__pendingFrames = [];
      relay.init({proxyRequest});

      // NOTE: here we should replace relay.id to cid
      relay.id = cid;
      relay.on('close', onClose);

      // create relations between mux relay and its sub relays,
      // when mux relay destroyed, all sub relays should be destroyed as well.
      muxRelay.addSubRelay(relay);

      logger.debug(`[mux-${muxRelay.id}] create sub connection(cid=${relay.id}), total: ${muxRelay.getSubRelays().size}`);
      return relay;
    } else {
      logger.warn(`[mux-${muxRelay.id}] cannot create new sub connection due to no mux connection are available`);
    }
  }

  onDataFrame({cid, data}) {
    const relay = MuxRelay.allSubRelays.get(cid);
    if (!relay) {
      logger.error(`[mux-${this.id}] fail to dispatch data frame(size=${data.length}), no such sub connection(cid=${cid})`);
      return;
    }
    if (__IS_CLIENT__ || relay.isOutboundReady()) {
      relay.decode(data);
    } else {
      // TODO: find a way to avoid using relay._pendingFrames
      // cache data frames to the array
      // before sub relay(newly created) established connection to destination
      relay.__pendingFrames = [];
      relay.__pendingFrames.push(data);
    }
  }

  onSubConnCloseByProtocol({cid}) {
    const relay = MuxRelay.allSubRelays.get(cid);
    if (relay) {
      this._removeSubRelay(cid);
      relay.destroy();
      logger.debug(`[mux-${this.id}] sub connection(cid=${cid}) closed by protocol`);
    }
    // else {
    //   logger.warn(`[mux-${this.id}] fail to close sub connection by protocol, no such sub connection(cid=${cid})`);
    // }
  }

  // methods

  addSubRelay(relay) {
    this._subRelays.set(relay.id, relay);
    MuxRelay.allSubRelays.set(relay.id, relay);
  }

  getSubRelays() {
    return this._subRelays;
  }

  destroySubRelay(cid) {
    const relay = this._getSubRelay(cid);
    if (relay) {
      this.encode(Buffer.alloc(0), {cid, isClosing: true});
      this._removeSubRelay(cid);
      relay.destroy();
    }
    // else {
    //   logger.warn(`[mux-${this.id}] fail to close sub connection by calling destroySubRelay(), no such sub connection(cid=${cid})`);
    // }
  }

  _removeSubRelay(cid) {
    this._subRelays.delete(cid);
    MuxRelay.allSubRelays.delete(cid);
  }

  _getSubRelay(cid) {
    if (this._subRelays) {
      return this._subRelays.get(cid);
    }
  }

}
