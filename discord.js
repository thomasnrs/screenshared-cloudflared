'use strict';
/*
 * telar - Rich Presence pelo IPC local do cliente Discord.
 *
 * O cliente de desktop abre um named pipe (Windows) ou socket unix (Linux/mac)
 * chamado discord-ipc-N. O protocolo e' [op int32 LE][tamanho int32 LE][json].
 * Nao passa pela rede nem precisa de token: quem autentica e' o proprio cliente.
 */

const net = require('net');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

const RETRY_MS = 15000;      // Discord fechado: tenta de novo daqui a pouco
const MIN_GAP_MS = 4500;     // o RPC limita ~5 atualizacoes a cada 20s

function pipeBases() {
  if (process.platform === 'win32') return ['\\\\.\\pipe\\'];
  const root = (process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp')
    .replace(/\/+$/, '');
  // flatpak e snap escondem o socket dentro da sandbox
  return [
    root + '/',
    root + '/app/com.discordapp.Discord/',
    root + '/snap.discord/',
    root + '/app/com.discordapp.DiscordCanary/',
    '/tmp/',
  ];
}

function candidates() {
  // escape para caminho fora do padrao (sandbox de flatpak/snap, ou teste)
  if (process.env.TELAR_DISCORD_PIPE) return [process.env.TELAR_DISCORD_PIPE];
  const out = [];
  for (const base of pipeBases()) for (let i = 0; i < 10; i++) out.push(base + 'discord-ipc-' + i);
  return out;
}

function pack(op, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.allocUnsafe(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

class Presence {
  constructor(clientId, log) {
    this.clientId = String(clientId || '');
    this.log = log || function () {};
    this.sock = null;
    this.ready = false;
    this.stopped = false;
    this.user = null;

    this.pending = null;       // ultima atividade pedida
    this.sentAt = 0;
    this.timer = null;
    this.retry = null;
    this.buf = Buffer.alloc(0);
    this.warned = false;
    this.showing = false;   // ja tem atividade aparecendo no perfil?
  }

  start() {
    if (!this.clientId) return;
    this.stopped = false;
    this.tryConnect(candidates(), 0);
  }

  tryConnect(list, i) {
    if (this.stopped) return;
    if (i >= list.length) {
      if (!this.warned) {
        this.warned = true;   // so' avisa uma vez, senao polui o terminal
        this.log('Discord não encontrado; segue tentando em segundo plano');
      }
      this.retry = setTimeout(() => this.tryConnect(candidates(), 0), RETRY_MS);
      if (this.retry.unref) this.retry.unref();
      return;
    }

    const sock = net.connect(list[i]);
    let settled = false;

    const giveUp = () => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) {}
      this.tryConnect(list, i + 1);
    };

    sock.once('error', giveUp);
    sock.once('connect', () => {
      if (settled) return;
      settled = true;
      sock.removeListener('error', giveUp);
      this.attach(sock);
      sock.write(pack(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
    });
  }

  attach(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);

    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        if (this.buf.length < 8) return;
        const op = this.buf.readInt32LE(0);
        const len = this.buf.readInt32LE(4);
        if (len < 0 || len > 1 << 20) return this.drop();
        if (this.buf.length < 8 + len) return;
        const raw = this.buf.subarray(8, 8 + len).toString('utf8');
        this.buf = this.buf.subarray(8 + len);
        let msg = null;
        try { msg = JSON.parse(raw); } catch (e) {}
        this.handle(op, msg);
      }
    });

    const bye = () => this.drop();
    sock.on('close', bye);
    sock.on('end', bye);
    sock.on('error', bye);
  }

  handle(op, msg) {
    if (op === OP.PING) { this.write(OP.PONG, msg); return; }

    if (op === OP.CLOSE) {
      const code = msg && msg.code;
      if (code === 4000) {
        this.log('Discord recusou o App ID (' + this.clientId + '). Confira em discord.com/developers');
        this.stopped = true;   // ID errado nao melhora tentando de novo
      }
      return this.drop();
    }

    if (op !== OP.FRAME || !msg) return;

    if (msg.evt === 'READY') {
      this.ready = true;
      this.warned = false;
      this.user = (msg.data && msg.data.user) || null;
      this.log('Rich Presence ligado' + (this.user && this.user.username ? ' como ' + this.user.username : ''));
      if (this.pending) this.flush();
      return;
    }

    if (msg.evt === 'ERROR') {
      const d = msg.data || {};
      this.log('Discord recusou a atividade: ' + (d.message || JSON.stringify(d)));
    }
  }

  write(op, obj) {
    if (!this.sock || this.sock.destroyed) return false;
    try { this.sock.write(pack(op, obj)); return true; } catch (e) { return false; }
  }

  drop() {
    this.ready = false;
    if (this.sock) { try { this.sock.destroy(); } catch (e) {} this.sock = null; }
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.tryConnect(candidates(), 0), RETRY_MS);
    if (this.retry.unref) this.retry.unref();
  }

  // guarda a ultima atividade e manda respeitando o limite do RPC
  set(activity) {
    this.pending = activity;
    if (!this.ready) return;
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - this.sentAt));
    if (this.timer) return;
    if (wait === 0) return this.flush();
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, wait);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (!this.ready || this.pending === null) return;
    const activity = this.pending;
    this.pending = null;
    this.sentAt = Date.now();
    this.showing = true;
    this.write(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      nonce: 'telar-' + this.sentAt,
      args: { pid: process.pid, activity: activity },
    });
  }

  clear() {
    this.pending = null;
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.ready) return;
    // nada aparecendo: limpar seria um frame a' toa, e gastaria a cota que a
    // primeira atividade de verdade vai precisar logo em seguida
    if (!this.showing) return;
    this.showing = false;
    this.sentAt = Date.now();
    this.write(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      nonce: 'telar-clear-' + this.sentAt,
      args: { pid: process.pid },      // sem activity = limpa
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.retry);
    this.clear();
    setTimeout(() => { if (this.sock) { try { this.sock.destroy(); } catch (e) {} } }, 120);
  }
}

module.exports = { Presence: Presence };
