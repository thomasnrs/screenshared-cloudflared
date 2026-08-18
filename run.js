#!/usr/bin/env node
'use strict';
/*
 * telar - launcher.
 * Acha uma porta livre, garante o cloudflared, sobe o servidor e o tunel,
 * e imprime os links. Sem dependencias.
 */

const { spawn, spawnSync } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const BIN = path.join(__dirname, 'bin');
const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------- argumentos

const argv = process.argv.slice(2);
function flag(name) { return argv.includes('--' + name); }
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

const WANT_PORT = parseInt(opt('port', process.env.TELAR_PORT || '8787'), 10);
const NO_TUNNEL = flag('no-tunnel');
const NO_OPEN = flag('no-open');
const PIN = opt('pin', process.env.TELAR_PIN || '');
const DISCORD_ID = opt('discord-app-id', process.env.TELAR_DISCORD_APP_ID || '');
const DISCORD_INVITE = opt('discord-invite', process.env.TELAR_DISCORD_INVITE || '');
const KEY = process.env.TELAR_KEY || crypto.randomBytes(5).toString('hex');

// ---------------------------------------------------------------- enfeites

const C = process.stdout.isTTY
  ? { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', cy: '\x1b[36m', gr: '\x1b[32m', ye: '\x1b[33m', rd: '\x1b[31m' }
  : { r: '', b: '', dim: '', cy: '', gr: '', ye: '', rd: '' };

function say(m) { process.stdout.write(m + '\n'); }
function step(m) { say(C.dim + '  · ' + m + C.r); }
function warn(m) { say(C.ye + '  ! ' + m + C.r); }
function fail(m) { say(C.rd + '  x ' + m + C.r); }

function banner(publicUrl, port) {
  const panel = 'http://localhost:' + port + '/b?k=' + KEY;
  const lan = lanAddress();
  const line = '─'.repeat(64);

  say('');
  say(C.cy + '┌' + line + '┐' + C.r);
  say('');
  if (publicUrl) {
    say('  ' + C.b + 'MANDE ESTE LINK PARA QUEM VAI ASSISTIR:' + C.r);
    say('');
    say('      ' + C.gr + C.b + publicUrl + (PIN ? '?p=' + PIN : '') + C.r);
    say('');
    say('  ' + C.dim + 'Endereço novo leva alguns segundos para responder no mundo todo.' + C.r);
    say('  ' + C.dim + 'Se der erro 1033, espere a linha de confirmação aqui embaixo.' + C.r);
  } else {
    say('  ' + C.b + 'LINK NA REDE LOCAL (sem túnel):' + C.r);
    say('');
    say('      ' + C.gr + C.b + 'http://' + lan + ':' + port + '/' + C.r);
  }
  say('');
  say('  ' + C.dim + 'Seu painel (só nesta máquina):' + C.r);
  say('      ' + C.cy + panel + C.r);
  say('');
  if (publicUrl && lan) say('  ' + C.dim + 'Na mesma rede também dá: http://' + lan + ':' + port + '/' + C.r);
  say('  ' + C.dim + 'Ctrl+C encerra tudo.' + C.r);
  say('');
  say(C.cy + '└' + line + '┘' + C.r);
  say('');
}

function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '';
}

// ---------------------------------------------------------------- porta

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '0.0.0.0');
  });
}

async function findPort(start) {
  for (let p = start; p < start + 40; p++) if (await portFree(p)) return p;
  throw new Error('nenhuma porta livre entre ' + start + ' e ' + (start + 40));
}

// ---------------------------------------------------------------- cloudflared

function cloudflaredAsset() {
  const arch = process.arch;
  if (IS_WIN) {
    return { name: arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe', file: 'cloudflared.exe', tgz: false };
  }
  if (process.platform === 'darwin') {
    return { name: arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz', file: 'cloudflared', tgz: true };
  }
  const map = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' };
  return { name: 'cloudflared-linux-' + (map[arch] || 'amd64'), file: 'cloudflared', tgz: false };
}

function haveCommand(cmd) {
  try {
    const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', timeout: 8000 });
    return r.status === 0;
  } catch (e) { return false; }
}

function download(url, dest, redirects) {
  return new Promise((resolve, reject) => {
    if ((redirects || 0) > 6) return reject(new Error('redirecionamentos demais'));
    https.get(url, { headers: { 'user-agent': 'telar' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, (redirects || 0) + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0, lastPct = -1;
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        if (total && process.stdout.isTTY) {
          const pct = Math.floor((got / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            process.stdout.write('\r' + C.dim + '  · baixando cloudflared... ' + pct + '%' + C.r);
          }
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        if (process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(48) + '\r');
        resolve();
      }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureCloudflared() {
  const asset = cloudflaredAsset();
  const local = path.join(BIN, asset.file);
  if (fs.existsSync(local)) return local;
  if (haveCommand('cloudflared')) return 'cloudflared';

  fs.mkdirSync(BIN, { recursive: true });
  const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + asset.name;
  step('cloudflared não encontrado, baixando (uma vez só, ~40 MB)...');

  const tmp = path.join(BIN, asset.tgz ? 'cf.tgz' : asset.file + '.part');
  await download(url, tmp);

  if (asset.tgz) {
    const r = spawnSync('tar', ['-xzf', tmp, '-C', BIN], { stdio: 'ignore' });
    fs.unlinkSync(tmp);
    if (r.status !== 0) throw new Error('falha ao extrair o cloudflared');
  } else {
    if (fs.statSync(tmp).size < 1000000) { fs.unlinkSync(tmp); throw new Error('download veio truncado'); }
    fs.renameSync(tmp, local);
  }
  if (!IS_WIN) fs.chmodSync(local, 0o755);
  step('cloudflared pronto em bin/');
  return local;
}

// ---------------------------------------------------------------- processos

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  say('');
  step('encerrando...');
  for (const c of children) { try { c.kill(); } catch (e) {} }
  setTimeout(() => process.exit(code || 0), 350);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
if (IS_WIN) {
  // no Windows o Ctrl+C nem sempre vira SIGINT sem isso
  try {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', () => shutdown(0));
  } catch (e) {}
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: Object.assign({}, process.env, {
        TELAR_PORT: String(port),
        TELAR_KEY: KEY,
        TELAR_PIN: PIN,
        TELAR_DISCORD_APP_ID: DISCORD_ID,
        TELAR_DISCORD_INVITE: DISCORD_INVITE,
      }),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.push(child);

    let ready = false;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.startsWith('TELAR_READY')) { ready = true; resolve(child); }
        else if (line.trim()) step(line.replace(/^\[telar\]\s*/, ''));
      }
    });

    child.on('exit', (code) => {
      if (!ready) reject(new Error('servidor saiu com código ' + code));
      else if (!shuttingDown) { fail('servidor caiu'); shutdown(1); }
    });
  });
}

const CF_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const TUNLOG = path.join(__dirname, 'tunnel.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startTunnel(bin, port, protocol) {
  return new Promise((resolve) => {
    const args = ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + port];
    if (protocol) args.push('--protocol', protocol);

    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);

    let log = null;
    try {
      log = fs.createWriteStream(TUNLOG, { flags: 'a' });
      log.write('\n=== ' + new Date().toISOString() + '  protocolo=' + (protocol || 'auto') + ' ===\n');
    } catch (e) {}

    let done = false;
    let url = null;
    let registered = false;
    const finish = () => {
      if (!done) { done = true; resolve({ url: url, registered: registered, child: child }); }
    };

    // "Registered tunnel connection" e' o sinal de que o cloudflared fechou com a
    // borda. O que sobra depois disso e' propagacao do hostname, que nao da' pra
    // apressar e nao significa que o tunel esteja ruim.
    const scan = (d) => {
      const s = d.toString();
      if (log) log.write(s);
      if (!url) { const m = s.match(CF_URL_RE); if (m) url = m[0]; }
      if (!registered && /Registered tunnel connection/i.test(s)) registered = true;
      if (url && registered) finish();
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);

    child.on('exit', (code) => {
      if (log) log.write('\n[cloudflared saiu, codigo ' + code + ']\n');
      finish();
    });
    setTimeout(finish, 30000);
  });
}

// o cloudflared anuncia a URL antes das conexoes com a borda ficarem de pe'.
// so' vale mostrar o link depois que ele responder de verdade, senao a pessoa
// recebe um link morto (erro 1033 da Cloudflare).
function probe(url) {
  return new Promise((resolve) => {
    const req = https.get(url + '/health', { headers: { 'user-agent': 'telar' } }, (res) => {
      let body = '';
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        let good = false;
        try { good = res.statusCode === 200 && JSON.parse(body).ok === true; } catch (e) {}
        resolve(good);
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitReachable(url, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await probe(url)) return true;
    await sleep(3000);
  }
  return false;
}

// nao segura o link refem do probe: mostra logo e avisa quando confirmar
async function confirmWhenLive(url) {
  if (await waitReachable(url, 25)) return say('  ' + C.gr + '✓ link confirmado — pode mandar' + C.r + '\n');
  say('  ' + C.ye + '· o link ainda está propagando na Cloudflare; aviso aqui quando responder' + C.r);
  if (await waitReachable(url, 240)) return say('  ' + C.gr + '✓ link confirmado — pode mandar agora' + C.r + '\n');
  fail('o link não respondeu em ~4 min. O túnel está de pé (veja tunnel.log);');
  fail('se continuar dando erro 1033, use Ctrl+C e rode de novo para pegar outro endereço.');
}

function tellServer(port, url) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: port, path: '/tunnel?k=' + encodeURIComponent(KEY) + '&u=' + encodeURIComponent(url) },
      (res) => { res.resume(); resolve(); }
    );
    req.on('error', () => resolve());
  });
}

function openBrowser(url) {
  if (NO_OPEN) return;
  try {
    if (IS_WIN) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {}
}

async function openTunnel(bin, port) {
  // sem UDP a borda da Cloudflare nao fecha o QUIC; http2 vai por TCP/443 e passa
  const attempts = process.env.TELAR_CF_PROTOCOL ? [process.env.TELAR_CF_PROTOCOL] : [null, 'http2'];

  for (let i = 0; i < attempts.length; i++) {
    const proto = attempts[i];
    step('abrindo túnel do Cloudflare' + (proto ? ' (' + proto + ')' : '') + '...');
    const r = await startTunnel(bin, port, proto);

    if (r.url && r.registered) { step('túnel registrado na borda da Cloudflare'); return r; }

    try { r.child.kill(); } catch (e) {}
    if (i < attempts.length - 1) {
      warn(r.url ? 'o túnel não registrou conexão — tentando por HTTP2...'
                 : 'o túnel não abriu — tentando por HTTP2...');
    }
  }
  return null;
}

function superviseTunnel(bin, port, r) {
  r.child.on('exit', async () => {
    if (shuttingDown) return;
    warn('o túnel caiu — reabrindo (atenção: o link muda)');
    const next = await openTunnel(bin, port);
    if (!next) return fail('não consegui reabrir o túnel; veja tunnel.log');
    await tellServer(port, next.url);
    banner(next.url, port);
    confirmWhenLive(next.url);
    superviseTunnel(bin, port, next);
  });
}

// ---------------------------------------------------------------- main

(async function main() {
  say('');
  say('  ' + C.b + C.cy + 'telar' + C.r + C.dim + ' — espelhamento de tela pelo navegador' + C.r);
  say('');

  const port = await findPort(WANT_PORT);
  if (port !== WANT_PORT) step('porta ' + WANT_PORT + ' ocupada, usando ' + port);

  await startServer(port);
  step('servidor no ar na porta ' + port);

  let publicUrl = '';
  if (!NO_TUNNEL) {
    let bin = null;
    try { bin = await ensureCloudflared(); }
    catch (e) { warn('não deu pra preparar o cloudflared: ' + e.message); }

    if (bin) {
      const r = await openTunnel(bin, port);
      if (r) { publicUrl = r.url; superviseTunnel(bin, port, r); }
      else warn('o túnel não subiu; seguindo só com a rede local (detalhes em tunnel.log)');
    }
  }

  if (publicUrl) await tellServer(port, publicUrl);

  banner(publicUrl, port);
  openBrowser('http://localhost:' + port + '/b?k=' + KEY);
  if (publicUrl) confirmWhenLive(publicUrl);

  process.stdin.resume();
})().catch((e) => {
  fail(e.message);
  shutdown(1);
});
