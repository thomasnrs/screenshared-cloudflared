#!/usr/bin/env node
'use strict';
/*
 * screenshared - servidor de espelhamento de tela.
 * HTTP estatico + hub WebSocket, sem nenhuma dependencia externa.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { Presence } = require('./discord.js');

// nomes novos SCREENSHARED_*, aceitando os antigos TELAR_* sem quebrar nada
function env(name, def) {
  return process.env['SCREENSHARED_' + name] || process.env['TELAR_' + name] || def || '';
}

const PORT = parseInt(env('PORT', '8787'), 10);
const KEY = env('KEY') || crypto.randomBytes(5).toString('hex');
const PIN = env('PIN');
const PUBDIR = path.join(__dirname, 'public');
const CFG_FILE = path.join(__dirname, 'screenshared.config.json');

const MAX_THUMB = 512 * 1024;
const THUMB_PATH = '/t/' + crypto.randomBytes(6).toString('hex');   // nao adivinhavel

const MAX_FRAME = 24 * 1024 * 1024;   // teto de um frame ws
const SLOW_BYTES = 4 * 1024 * 1024;   // acima disso o espectador e' lento: descarta video
const MAX_VIEWERS = parseInt(env('MAX_VIEWERS', '50'), 10);

// ---------------------------------------------------------------- config salva

// o painel edita isto e fica gravado; variavel de ambiente so' semeia na primeira vez
const DEFAULT_CFG = {
  discordAppId: '',
  discordInvite: '',
  statusText: 'Compartilhando a tela',
  activityType: 0,
};

let cfg = Object.assign({}, DEFAULT_CFG);

// o Discord recusa a atividade INTEIRA se um campo tiver menos de 2 caracteres,
// entao campo curto demais e' omitido em vez de mandado
function fitField(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 128);
  return t.length >= 2 ? t : '';
}

function sanitizeCfg(raw) {
  const out = Object.assign({}, DEFAULT_CFG);
  if (!raw || typeof raw !== 'object') return out;

  const id = String(raw.discordAppId == null ? '' : raw.discordAppId).trim();
  out.discordAppId = /^[0-9]{15,25}$/.test(id) ? id : '';

  const inv = String(raw.discordInvite == null ? '' : raw.discordInvite).trim().slice(0, 200);
  out.discordInvite = /^https:\/\/[^\s]+$/.test(inv) ? inv : '';

  const txt = String(raw.statusText == null ? '' : raw.statusText).replace(/\s+/g, ' ').trim().slice(0, 128);
  out.statusText = txt.length >= 2 ? txt : DEFAULT_CFG.statusText;

  const t = parseInt(raw.activityType, 10);
  out.activityType = [0, 2, 3, 5].indexOf(t) >= 0 ? t : 0;   // 1 o Discord recusa
  return out;
}

function loadCfg() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch (e) {}
  cfg = sanitizeCfg(saved);
  if (!cfg.discordAppId) cfg.discordAppId = sanitizeCfg({ discordAppId: env('DISCORD_APP_ID') }).discordAppId;
  if (!cfg.discordInvite) cfg.discordInvite = sanitizeCfg({ discordInvite: env('DISCORD_INVITE') }).discordInvite;
  const envType = env('DISCORD_TYPE');
  if (envType !== '' && !saved.activityType) cfg.activityType = sanitizeCfg({ activityType: envType }).activityType;
}

function saveCfg() {
  try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); return true; }
  catch (e) { log('não consegui salvar a config: ' + e.message); return false; }
}

// ---------------------------------------------------------------- seguranca

const LIM = {
  wsPerMin: 30,                  // aberturas de websocket por IP por minuto
  concurrent: 6,                 // abas simultaneas por IP
  httpPerMin: 300,               // requisicoes http por IP por minuto
  keyFails: 8,                   // chutes na chave/pin antes de bloquear o IP
  blockMs: 10 * 60 * 1000,
};

const banned = new Set();        // IPs banidos pelo transmissor
const buckets = new Map();       // IP -> contadores

function normIp(ip) {
  if (!ip) return '?';
  ip = String(ip).trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);   // ipv4 mapeado em ipv6
  if (ip === '::1') ip = '127.0.0.1';               // mesma maquina, dois nomes:
  return ip;                                        // o navegador usa ::1 em "localhost"
}

// esta maquina. O painel vive aqui, entao loopback nunca e' bloqueado nem
// limitado — senao uma aba velha com a chave antiga tranca o dono para fora.
function isLoopback(ip) { return normIp(ip) === '127.0.0.1'; }

// atras do cloudflared toda conexao chega de 127.0.0.1; o IP de verdade vem no
// cabecalho. So' confiamos nele quando o salto imediato e' local, senao qualquer
// um na LAN forjaria o proprio IP e escaparia de ban e rate-limit.
function clientIp(req) {
  const hop = normIp(req.socket && req.socket.remoteAddress);
  if (isLoopback(hop)) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return normIp(cf);
    const xff = req.headers['x-forwarded-for'];
    if (xff) return normIp(String(xff).split(',')[0]);
  }
  return hop;
}

function bucket(ip) {
  let b = buckets.get(ip);
  if (!b) { b = { ws: [], http: [], live: 0, fails: 0, until: 0 }; buckets.set(ip, b); }
  return b;
}

function blocked(ip) {
  if (isLoopback(ip)) return false;
  if (banned.has(ip)) return true;
  const b = buckets.get(ip);
  return !!(b && b.until > Date.now());
}

function allow(list, windowMs, limit) {
  const now = Date.now();
  while (list.length && now - list[0] > windowMs) list.shift();
  if (list.length >= limit) return false;
  list.push(now);
  return true;
}

function noteFail(ip) {
  if (isLoopback(ip)) return;   // o dono da maquina nao esta se atacando
  const b = bucket(ip);
  if (++b.fails >= LIM.keyFails) {
    b.until = Date.now() + LIM.blockMs;
    b.fails = 0;
    log('bloqueando ' + ip + ' por tentativas de chave');
  }
}

// evita vazar o tamanho do prefixo correto pelo tempo de comparacao
function safeEqual(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

// montados com new RegExp para nao depender de caracteres de controle literais no fonte.
// invisiveis somem (servem pra forjar nicks "iguais"); controle vira espaco (senao
// "linha1\nlinha2" cola as duas palavras). ‪-‮ inverte a exibicao do texto.
const NICK_HIDE = new RegExp('[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]', 'g');
const NICK_CTRL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

function cleanNick(s) {
  return String(s == null ? '' : s)
    .replace(NICK_HIDE, '')
    .replace(NICK_CTRL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

// buckets ociosos nao ficam guardados pra sempre
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) {
    if (b.live > 0 || b.until > now) continue;
    const lastWs = b.ws.length ? b.ws[b.ws.length - 1] : 0;
    const lastHttp = b.http.length ? b.http[b.http.length - 1] : 0;
    if (now - Math.max(lastWs, lastHttp) > 15 * 60 * 1000) buckets.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------- websocket

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function wsFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.allocUnsafe(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.allocUnsafe(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.allocUnsafe(10);
    head[1] = 127;
    head.writeUInt32BE(Math.floor(len / 4294967296), 2);
    head.writeUInt32BE(len >>> 0, 6);
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.open = true;
    this.role = null;
    this.id = 0;
    this.dropped = 0;
    this.onmessage = null;
    this.onclose = null;

    let buf = Buffer.alloc(0);
    let fragOp = 0;
    let frags = [];
    let fragLen = 0;

    socket.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      for (;;) {
        if (buf.length < 2) return;
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < off + 2) return;
          len = buf.readUInt16BE(off); off += 2;
        } else if (len === 127) {
          if (buf.length < off + 8) return;
          len = buf.readUInt32BE(off) * 4294967296 + buf.readUInt32BE(off + 4);
          off += 8;
        }
        if (len > MAX_FRAME || fragLen + len > MAX_FRAME) return this.destroy();
        let mask = null;
        if (masked) {
          if (buf.length < off + 4) return;
          mask = buf.subarray(off, off + 4); off += 4;
        }
        if (buf.length < off + len) return;
        let payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
        buf = Buffer.from(buf.subarray(off + len));

        if (opcode === OP.CLOSE) return this.close();
        if (opcode === OP.PING) { this.send(OP.PONG, payload); continue; }
        if (opcode === OP.PONG) continue;

        if (opcode === OP.CONT) {
          if (!fragOp) return this.destroy();
          frags.push(payload); fragLen += len;
          if (!fin) continue;
          payload = Buffer.concat(frags, fragLen);
          const op = fragOp;
          fragOp = 0; frags = []; fragLen = 0;
          this.deliver(op, payload);
          continue;
        }
        if (!fin) { fragOp = opcode; frags = [payload]; fragLen = len; continue; }
        this.deliver(opcode, payload);
      }
    });

    const bye = () => { if (this.open) { this.open = false; if (this.onclose) this.onclose(); } };
    socket.on('close', bye);
    socket.on('end', bye);
    socket.on('error', bye);
  }

  deliver(opcode, payload) {
    if (!this.onmessage) return;
    if (opcode === OP.TEXT) {
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { return; }
      this.onmessage(msg, null);
    } else if (opcode === OP.BIN) {
      this.onmessage(null, payload);
    }
  }

  send(opcode, payload) {
    if (!this.open) return false;
    try { this.socket.write(wsFrame(opcode, payload)); return true; }
    catch (e) { return false; }
  }

  json(obj) { return this.send(OP.TEXT, Buffer.from(JSON.stringify(obj))); }

  // video: se o socket ja' esta' entupido, descarta em vez de acumular memoria
  media(chunk) {
    if (!this.open) return false;
    if (this.socket.writableLength > SLOW_BYTES) { this.dropped++; return false; }
    return this.send(OP.BIN, chunk);
  }

  ping() { this.send(OP.PING, Buffer.alloc(0)); }

  close() {
    if (!this.open) return;
    this.open = false;
    try { this.socket.write(wsFrame(OP.CLOSE, Buffer.alloc(0))); this.socket.end(); } catch (e) {}
    if (this.onclose) this.onclose();
  }

  destroy() {
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch (e) {}
    if (this.onclose) this.onclose();
  }
}

// ---------------------------------------------------------------- estado

let broadcaster = null;
let mode = 'webrtc';        // 'webrtc' | 'relay'
let live = false;
let relayMime = '';
let relayInit = null;       // primeiro chunk do MediaRecorder (cabecalho webm)
let awaitingInit = false;
let title = '';
let publicUrl = '';
let liveSince = 0;
let hasAudio = false;   // a captura veio com som?
let thumb = null;          // miniatura borrada, JPEG cru
let thumbVersion = 0;

const viewers = new Map();
let nextId = 1;

function toViewers(obj) { for (const v of viewers.values()) v.json(obj); }

// ---------------------------------------------------------------- chat

const CHAT_KEEP = 60;      // quantas mensagens quem chega depois recebe
const CHAT_LEN = 300;
const CHAT_BURST = 6;      // mensagens por janela, por conexao
const CHAT_WINDOW = 10000;

const chat = [];
let chatSeq = 0;

function cleanMsg(s) {
  return String(s == null ? '' : s)
    .replace(NICK_HIDE, '')
    .replace(NICK_CTRL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_LEN);
}

// spam nao derruba a sala: passa do limite, a mensagem so' e' descartada
function chatAllowed(conn) {
  const now = Date.now();
  if (!conn.chatTimes) conn.chatTimes = [];
  while (conn.chatTimes.length && now - conn.chatTimes[0] > CHAT_WINDOW) conn.chatTimes.shift();
  if (conn.chatTimes.length >= CHAT_BURST) return false;
  conn.chatTimes.push(now);
  return true;
}

function sendChat(conn, raw, host) {
  const text = cleanMsg(raw);
  if (!text) return;
  if (!chatAllowed(conn)) {
    conn.json({ t: 'chat-slow', wait: Math.ceil(CHAT_WINDOW / 1000) });
    return;
  }
  const m = {
    t: 'chat',
    id: ++chatSeq,
    nick: host ? 'transmissor' : conn.nick,
    host: !!host,
    text: text,
    at: Date.now(),
  };
  chat.push(m);
  if (chat.length > CHAT_KEEP) chat.shift();
  toViewers(m);
  if (broadcaster) broadcaster.json(m);
}

function viewerList() {
  return Array.from(viewers.values()).map((v) => ({
    id: v.id, nick: v.nick, ip: v.ip, since: v.since, dropped: v.dropped,
  }));
}

// o IP so' vai para o transmissor; espectador nenhum recebe IP de ninguem
function pushViewers() {
  if (broadcaster) broadcaster.json({ t: 'viewers', list: viewerList(), banned: Array.from(banned) });
}

function announceCount() {
  const n = viewers.size;
  if (broadcaster) broadcaster.json({ t: 'count', n: n });
  toViewers({ t: 'count', n: n, names: Array.from(viewers.values()).map((v) => v.nick) });
  pushViewers();
  updatePresence();
}

// ---------------------------------------------------------------- discord

let presence = null;
let discordNote = '';
let appName = '';

// o nome do app e' a primeira linha do status, e quem decide e' o Developer
// Portal — buscamos para o painel poder mostrar a previa de verdade
function fetchAppName(id) {
  appName = '';
  if (!id) return;
  const req = https.get(
    'https://discord.com/api/v10/applications/' + id + '/rpc',
    { headers: { 'user-agent': 'screenshared' } },
    (res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 8192) body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { discordNote = 'App ID não encontrado no Discord'; return; }
        try { appName = String(JSON.parse(body).name || '').slice(0, 60); } catch (e) {}
      });
    }
  );
  req.setTimeout(8000, () => req.destroy());
  req.on('error', () => {});
}

function applyDiscord() {
  const id = cfg.discordAppId;
  if (presence && presence.clientId === id) return updatePresence();
  if (presence) { presence.stop(); presence = null; }
  discordNote = '';
  fetchAppName(id);
  if (id) {
    presence = new Presence(id, (m) => { discordNote = m; log('discord: ' + m); });
    presence.start();
  }
  updatePresence();
}

function plural(n) {
  if (n === 0) return 'ninguém assistindo ainda';
  if (n === 1) return '1 pessoa assistindo';
  return n + ' pessoas assistindo';
}

function buildActivity() {
  const act = {
    type: cfg.activityType,
    timestamps: { start: liveSince || Date.now() },
    instance: false,
  };

  const details = fitField(title || cfg.statusText);
  const state = fitField(plural(viewers.size));
  if (details) act.details = details;
  if (state) act.state = state;

  const buttons = [];
  if (publicUrl) buttons.push({ label: 'Assistir a tela', url: publicUrl + (PIN ? '?p=' + PIN : '') });
  if (cfg.discordInvite) buttons.push({ label: 'Entrar no servidor', url: cfg.discordInvite });
  if (buttons.length) act.buttons = buttons;

  // so' manda imagem quando existe: chave de asset inexistente faz o RPC recusar
  if (thumb && publicUrl) {
    act.assets = {
      large_image: publicUrl + THUMB_PATH + '/' + thumbVersion + '.jpg',
      large_text: 'screenshared',
    };
  }

  return act;
}

function updatePresence() {
  if (!presence) return;
  if (!live) return presence.clear();
  presence.set(buildActivity());
}

function disconnect(v, reason) {
  v.json({ t: 'kicked', reason: reason });
  setTimeout(() => v.close(), 60);   // deixa a mensagem sair antes de fechar
}

function resetStream() {
  live = false;
  liveSince = 0;
  thumb = null;
  hasAudio = false;
  relayInit = null;
  relayMime = '';
  awaitingInit = false;
}

// ---------------------------------------------------------------- http

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Le' o corpo com teto. Estourou: responde 413 e DRENA o resto.
// Destruir a requisicao no meio deixava o cliente sem resposta e derrubava o
// processo com uma assercao do libuv.
function readBody(req, res, limit, done) {
  const declared = parseInt(req.headers['content-length'] || '0', 10);
  const tooBig = () => {
    res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('corpo grande demais');
    req.resume();
  };

  if (declared > limit) return tooBig();

  const chunks = [];
  let size = 0;
  let over = false;

  req.on('data', (c) => {
    if (over) return;
    size += c.length;
    if (size > limit) { over = true; chunks.length = 0; return tooBig(); }
    chunks.push(c);
  });

  req.on('aborted', () => { over = true; });
  req.on('error', () => { over = true; });

  req.on('end', () => {
    if (over) return;
    if (!size) { res.writeHead(400); return res.end(); }
    done(Buffer.concat(chunks, size));
  });
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('404'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': data.length,
    });
    res.end(data);
  });
}

function iceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TELAR_TURN_URL) {
    list.push({
      urls: process.env.TELAR_TURN_URL.split(',').map((s) => s.trim()).filter(Boolean),
      username: process.env.TELAR_TURN_USER || undefined,
      credential: process.env.TELAR_TURN_PASS || undefined,
    });
  }
  return list;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = clientIp(req);

  if (blocked(ip)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Acesso bloqueado pelo dono da transmissao.');
  }
  if (!isLoopback(ip) && !allow(bucket(ip).http, 60000, LIM.httpPerMin)) {
    res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '30' });
    return res.end('Requisicoes demais. Espere um pouco.');
  }

  if (p === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, live: live, mode: mode, viewers: viewers.size }));
  }

  if (p === '/config.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: iceServers(), pin: !!PIN, title: title, publicUrl: publicUrl, discord: !!cfg.discordAppId }));
  }

  // o launcher avisa aqui qual URL o cloudflared entregou (so' aceita com a chave)
  if (p === '/tunnel') {
    if (!safeEqual(url.searchParams.get('k'), KEY)) { noteFail(ip); res.writeHead(403); return res.end(); }
    publicUrl = url.searchParams.get('u') || '';
    updatePresence();
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // config editada pelo painel (protegida pela mesma chave do painel)
  if (p === '/settings') {
    if (!safeEqual(url.searchParams.get('k'), KEY)) { noteFail(ip); res.writeHead(403); return res.end(); }

    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({
        cfg: cfg,
        connected: !!(presence && presence.ready),
        user: presence && presence.user ? presence.user.username : '',
        note: discordNote,
        appName: appName,
        lastResult: presence ? presence.lastResult : null,
        live: live,
      }));
    }

    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

    return readBody(req, res, 8192, (buf) => {
      let body = null;
      try { body = JSON.parse(buf.toString('utf8')); } catch (e) {}
      if (!body) { res.writeHead(400); return res.end(); }
      cfg = sanitizeCfg(body);
      saveCfg();
      applyDiscord();
      log('config atualizada pelo painel');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cfg: cfg }));
    });
    return;
  }

  // força o status agora, mesmo sem transmitir — para dar pra conferir sozinho
  if (p === '/discord-test') {
    if (!safeEqual(url.searchParams.get('k'), KEY)) { noteFail(ip); res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (!presence) return res.end(JSON.stringify({ ok: false, why: 'sem App ID configurado' }));
    if (!presence.ready) return res.end(JSON.stringify({ ok: false, why: 'não conectou no cliente do Discord' }));

    presence.lastResult = null;
    const act = buildActivity();
    if (!liveSince) act.timestamps = { start: Date.now() };
    presence.sentAt = 0;              // teste manual fura a fila de espera
    presence.set(act);
    return res.end(JSON.stringify({ ok: true, activity: act }));
  }

  // o painel manda a miniatura ja' borrada e reduzida; aqui so' guardamos
  if (p === '/thumb') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    if (!safeEqual(url.searchParams.get('k'), KEY)) { noteFail(ip); res.writeHead(403); return res.end(); }
    return readBody(req, res, MAX_THUMB, (buf) => {
      thumb = buf;
      thumbVersion++;
      updatePresence();
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  }

  // caminho com token aleatorio: a miniatura nao fica adivinhavel a partir do link
  if (p.startsWith(THUMB_PATH + '/')) {
    if (!thumb) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': thumb.length,
      'cache-control': 'public, max-age=120',
    });
    return res.end(thumb);
  }

  if (p === '/') return serveFile(res, path.join(PUBDIR, 'watch.html'));

  if (p === '/b' || p === '/b/') {
    if (!safeEqual(url.searchParams.get('k'), KEY)) {
      noteFail(ip);
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<meta charset="utf-8"><body style="font:16px system-ui;background:#111;color:#eee;padding:3rem">'
        + '<h2>Chave invalida</h2><p>Abra o painel pelo link que apareceu no terminal.</p>');
    }
    return serveFile(res, path.join(PUBDIR, 'broadcast.html'));
  }

  // estatico simples, sem escapar do diretorio public
  const safe = path.normalize(decodeURIComponent(p)).replace(/^[\\/]+/, '');
  const file = path.join(PUBDIR, safe);
  if (!file.startsWith(PUBDIR)) { res.writeHead(403); return res.end(); }
  serveFile(res, file);
});

// ---------------------------------------------------------------- upgrade

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) return socket.destroy();

  const ip = clientIp(req);
  const b = bucket(ip);
  const local = isLoopback(ip);
  if (blocked(ip)) return socket.destroy();
  if (!local && !allow(b.ws, 60000, LIM.wsPerMin)) return socket.destroy();

  const role = url.searchParams.get('role') === 'broadcast' ? 'broadcast' : 'view';

  if (role === 'broadcast') {
    if (!safeEqual(url.searchParams.get('key'), KEY)) { noteFail(ip); return socket.destroy(); }
  } else {
    if (PIN && !safeEqual(url.searchParams.get('pin'), PIN)) { noteFail(ip); return socket.destroy(); }
    if (!local && b.live >= LIM.concurrent) return socket.destroy();
    if (viewers.size >= MAX_VIEWERS) return socket.destroy();
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const conn = new Conn(socket);
  conn.role = role;
  conn.ip = ip;
  conn.since = Date.now();
  conn.nick = cleanNick(url.searchParams.get('nick'));

  b.live++;
  socket.on('close', () => { b.live = Math.max(0, b.live - 1); });

  if (role === 'broadcast') attachBroadcaster(conn);
  else attachViewer(conn);
});

function attachBroadcaster(conn) {
  if (broadcaster) {
    const old = broadcaster;
    broadcaster = null;
    old.json({ t: 'kicked' });
    old.close();
  }
  broadcaster = conn;
  resetStream();
  conn.json({
    t: 'welcome', role: 'broadcast', mode: mode, n: viewers.size,
    viewers: Array.from(viewers.keys()),
    list: viewerList(), banned: Array.from(banned),
  });
  if (chat.length) conn.json({ t: 'chat-history', list: chat });
  log('painel do transmissor conectado');

  conn.onmessage = (msg, bin) => {
    if (bin) {
      if (mode !== 'relay') return;
      if (awaitingInit) { relayInit = bin; awaitingInit = false; }
      for (const v of viewers.values()) v.media(bin);
      return;
    }
    if (!msg) return;
    switch (msg.t) {
      case 'mode':
        mode = msg.mode === 'relay' ? 'relay' : 'webrtc';
        relayInit = null; relayMime = ''; awaitingInit = false;
        toViewers({ t: 'mode', mode: mode, live: live });
        log('modo -> ' + mode);
        break;
      case 'live':
        live = !!msg.live;
        hasAudio = !!msg.audio;
        if (live) { if (!liveSince) liveSince = Date.now(); }
        else { relayInit = null; awaitingInit = false; liveSince = 0; thumb = null; hasAudio = false; }
        toViewers({ t: 'live', live: live, mode: mode, audio: hasAudio });
        updatePresence();
        log(live ? 'transmissao iniciada' : 'transmissao encerrada');
        break;
      case 'title':
        title = String(msg.title || '').slice(0, 80);
        toViewers({ t: 'title', title: title });
        updatePresence();
        break;
      case 'relay-init':
        relayMime = String(msg.mime || '');
        awaitingInit = true;
        toViewers({ t: 'relay-init', mime: relayMime });
        break;
      case 'sdp':
      case 'ice': {
        const v = viewers.get(msg.to);
        if (v) v.json({ t: msg.t, data: msg.data });
        break;
      }

      case 'kick': {
        const v = viewers.get(msg.id);
        if (v) { log('expulsou ' + v.nick + ' (' + v.ip + ')'); disconnect(v, 'expulso'); }
        break;
      }

      case 'ban': {
        const v = viewers.get(msg.id);
        const ip = v ? v.ip : normIp(msg.ip);
        if (!ip || ip === '?') break;
        if (isLoopback(ip)) {
          conn.json({ t: 'notice', text: 'Esse espectador está nesta mesma máquina — banir o IP trancaria o seu painel. Use Expulsar.' });
          break;
        }
        banned.add(ip);
        log('baniu o IP ' + ip);
        for (const w of Array.from(viewers.values())) if (w.ip === ip) disconnect(w, 'banido');
        pushViewers();
        break;
      }

      case 'chat':
        sendChat(conn, msg.text, true);
        break;

      case 'unban':
        if (banned.delete(normIp(msg.ip))) log('desbaniu o IP ' + normIp(msg.ip));
        pushViewers();
        break;
    }
  };

  conn.onclose = () => {
    if (broadcaster === conn) {
      broadcaster = null;
      resetStream();
      toViewers({ t: 'offline' });
      updatePresence();
      log('painel do transmissor desconectado');
    }
  };
}

function attachViewer(conn) {
  const id = nextId++;
  conn.id = id;
  if (!conn.nick) conn.nick = 'Convidado ' + id;
  viewers.set(id, conn);

  conn.json({ t: 'welcome', role: 'view', id: id, nick: conn.nick, mode: mode, live: live, audio: hasAudio, title: title });
  if (chat.length) conn.json({ t: 'chat-history', list: chat });
  if (mode === 'relay' && live && relayInit) {
    conn.json({ t: 'relay-init', mime: relayMime });
    conn.send(OP.BIN, relayInit);
  }
  if (broadcaster) broadcaster.json({ t: 'viewer-join', id: id, nick: conn.nick, ip: conn.ip, n: viewers.size });
  announceCount();

  conn.onmessage = (msg) => {
    if (!msg) return;
    if (msg.t === 'chat') return sendChat(conn, msg.text, false);
    if (msg.t === 'sdp' || msg.t === 'ice' || msg.t === 'webrtc-failed') {
      if (broadcaster) broadcaster.json({ t: msg.t, from: id, data: msg.data });
    }
  };

  conn.onclose = () => {
    viewers.delete(id);
    if (broadcaster) broadcaster.json({ t: 'viewer-leave', id: id, nick: conn.nick, n: viewers.size });
    announceCount();
  };
}

// keepalive: tunel/proxy derruba websocket ocioso
setInterval(() => {
  if (broadcaster) broadcaster.ping();
  for (const v of viewers.values()) v.ping();
}, 25000).unref();

function log(m) { process.stdout.write('[screenshared] ' + m + '\n'); }

loadCfg();
applyDiscord();

server.listen(PORT, () => {
  log('escutando em http://localhost:' + PORT);
  process.stdout.write('TELAR_READY ' + JSON.stringify({ port: PORT, key: KEY, pin: PIN }) + '\n');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { if (presence) presence.stop(); setTimeout(() => process.exit(0), 200); });
}

server.on('error', (e) => {
  process.stderr.write('[screenshared] erro no servidor: ' + e.message + '\n');
  process.exit(1);
});
