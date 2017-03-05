'use strict';

const tls = require('tls');
const crypto = require('crypto');
const EventEmitter = require('events').EventEmitter;

require('./buffertools');

const IncomingMessageStream = require('./message/incoming-message-stream');

const Packet = require('./packet').Packet;
const TYPE = require('./packet').TYPE;
const packetHeaderLength = require('./packet').HEADER_LENGTH;

module.exports = class MessageIO extends EventEmitter {
  constructor(socket, _packetSize, debug) {
    super();

    this.socket = socket;
    this._packetSize = _packetSize;
    this.debug = debug;
    this.sendPacket = this.sendPacket.bind(this);

    this.incomingMessageStream = new IncomingMessageStream();
    this.incomingMessageStream.on('data', (message) => {
      message.on('data', (packet) => {
        this.logPacket('Received', packet);
        this.emit('data', packet.data());
      });

      message.on('end', () => {
        this.emit('message');
      });
    });

    this.socket.pipe(this.incomingMessageStream);
    this.packetDataSize = this._packetSize - packetHeaderLength;
  }

  packetSize(packetSize) {
    if (arguments.length > 0) {
      this.debug.log('Packet size changed from ' + this._packetSize + ' to ' + packetSize);
      this._packetSize = packetSize;
      this.packetDataSize = this._packetSize - packetHeaderLength;
    }
    return this._packetSize;
  }

  startTls(credentialsDetails, hostname, trustServerCertificate) {
    const credentials = tls.createSecureContext ? tls.createSecureContext(credentialsDetails) : crypto.createCredentials(credentialsDetails);

    this.securePair = tls.createSecurePair(credentials);
    this.tlsNegotiationComplete = false;

    this.securePair.on('secure', () => {
      const cipher = this.securePair.cleartext.getCipher();

      if (!trustServerCertificate) {
        let verifyError = this.securePair.ssl.verifyError();

        // Verify that server's identity matches it's certificate's names
        if (!verifyError) {
          verifyError = tls.checkServerIdentity(hostname, this.securePair.cleartext.getPeerCertificate());
        }

        if (verifyError) {
          this.securePair.destroy();
          this.socket.destroy(verifyError);
          return;
        }
      }

      this.debug.log('TLS negotiated (' + cipher.name + ', ' + cipher.version + ')');
      this.emit('secure', this.securePair.cleartext);
      this.encryptAllFutureTraffic();
    });

    this.securePair.encrypted.on('data', (data) => {
      this.sendMessage(TYPE.PRELOGIN, data);
    });

    // On Node >= 0.12, the encrypted stream automatically starts spewing out
    // data once we attach a `data` listener. But on Node <= 0.10.x, this is not
    // the case. We need to kick the cleartext stream once to get the
    // encrypted end of the secure pair to emit the TLS handshake data.
    this.securePair.cleartext.write('');
  }

  encryptAllFutureTraffic() {
    this.socket.unpipe(this.incomingMessageStream);
    this.securePair.encrypted.removeAllListeners('data');
    this.socket.pipe(this.securePair.encrypted);
    this.securePair.encrypted.pipe(this.socket);
    this.securePair.cleartext.pipe(this.incomingMessageStream);
    this.tlsNegotiationComplete = true;
  }

  tlsHandshakeData(data) {
    this.securePair.encrypted.write(data);
  }

  // TODO listen for 'drain' event when socket.write returns false.
  // TODO implement incomplete request cancelation (2.2.1.6)
  sendMessage(packetType, data, resetConnection) {

    let numberOfPackets;
    if (data) {
      numberOfPackets = (Math.floor((data.length - 1) / this.packetDataSize)) + 1;
    } else {
      numberOfPackets = 1;
      data = new Buffer(0);
    }

    for (let packetNumber = 0; packetNumber < numberOfPackets; packetNumber++) {
      const payloadStart = packetNumber * this.packetDataSize;

      let payloadEnd;
      if (packetNumber < numberOfPackets - 1) {
        payloadEnd = payloadStart + this.packetDataSize;
      } else {
        payloadEnd = data.length;
      }

      const packetPayload = data.slice(payloadStart, payloadEnd);

      const packet = new Packet(packetType);
      packet.last(packetNumber === numberOfPackets - 1);
      packet.resetConnection(resetConnection);
      packet.packetId(packetNumber + 1);
      packet.addData(packetPayload);
      this.sendPacket(packet);
    }
  }

  sendPacket(packet) {
    this.logPacket('Sent', packet);
    if (this.securePair && this.tlsNegotiationComplete) {
      this.securePair.cleartext.write(packet.buffer);
    } else {
      this.socket.write(packet.buffer);
    }
  }

  logPacket(direction, packet) {
    this.debug.packet(direction, packet);
    return this.debug.data(packet);
  }
};