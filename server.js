// PEW PEW GAME multiplayer server — no npm install needed (Node 16+).
// Run:  node server.js        then open http://localhost:8080
// Put this file next to the game HTML. Env: PORT, GAME_FILE.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 8080;

function gameFile() {
  if (process.env.GAME_FILE) return process.env.GAME_FILE;
  const fl = fs.readdirSync(__dirname).filter(f => /\.html?$/i.test(f));
  return path.join(__dirname, fl.find(f => /^index\.html?$/i.test(f)) || fl.find(f => /pew/i.test(f)) || fl[0] || 'index.html');
}

process.on('uncaughtException', e => console.error('error:', e && e.message));
const clients = new Map(), rooms = new Map();
let nid = 1;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => { let c; do { c = Array.from({ length: 5 }, () => CODE_CHARS[Math.random() * CODE_CHARS.length | 0]).join(''); } while ([...rooms.values()].some(r => r.code === c)); return c; };
const num = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : d; };
const str = (v, n, d = '') => typeof v === 'string' ? v.replace(/[<>]/g, '').slice(0, n) : d;

function cleanOpts(o, old = {}) {
  o = o || {};
  const r = { ...old };
  if ('map' in o) r.map = str(o.map, 40, 'earth');
  if ('era' in o) r.era = str(o.era, 20, 'modern');
  if ('cm' in o) r.cm = o.cm === 'random' ? 'random' : 'pick';
  if ('speed' in o) r.speed = num(o.speed, .25, 8, 1);
  if ('diff' in o) r.diff = num(o.diff, .25, 3, 1);
  if ('evt' in o) r.evt = num(o.evt, 0, 4, 1);
  if ('reb' in o) r.reb = num(o.reb, 0, 4, 1);
  if ('eco' in o) r.eco = num(o.eco, .25, 4, 1);
  if ('army' in o) r.army = num(o.army, .25, 4, 1);
  if (Array.isArray(o.cl)) r.cl = o.cl.slice(0, 500).map(x => [num(x[0], 0, 1e6, 0), str(String(x[1]), 40)]);
  return r;
}
const view = r => ({ id: r.id, code: r.code, name: r.name, pub: r.pub, max: r.max, started: r.started, host: r.host, o: r.o,
  players: r.players.map(id => { const c = clients.get(id); return { id, name: c.name, cid: c.cid || 0 }; }) });
const listing = () => [...rooms.values()].filter(r => r.pub).map(r => ({ id: r.id, name: r.name, n: r.players.length, max: r.max,
  map: r.o.map, era: r.o.era, cm: r.o.cm, started: r.started, host: clients.get(r.host)?.name || '?' }));

function mk(op, p) {
  const n = p.length; let h;
  if (n < 126) h = Buffer.from([128 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 128 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
const wr = (c, fb) => { if (c && !c.sock.destroyed) { try { c.sock.write(fb); } catch (e) { } } };
const frame = (c, op, p) => wr(c, mk(op, p));
// Game packets ("R|<to>|<json>") are forwarded byte-for-byte, so the server never parses them (keeps a tiny free CPU fast).
function rawRelay(c, buf) {
  const r = rooms.get(c.room); if (!r) return;
  const j = buf.indexOf(0x7c, 2); if (j < 0) return;
  const to = buf.toString('utf8', 2, j), payload = buf.subarray(j + 1);
  const fb = mk(1, Buffer.concat([Buffer.from('M|' + c.id + '|'), payload]));
  const head = payload.toString('latin1', 0, 12), droppable = head.startsWith('{"k":"pos"') || head.startsWith('{"k":"full"') || head.startsWith('{"k":"terr"');
  const defer = p => { if (p) p.needsFull = true; };
  if (to === 'host') {
    if (r.host !== c.id) { const p = clients.get(r.host); if (p && p.sock.writableLength > 1.5e6) defer(p); else wr(p, fb); }
  }
  else if (to === 'all') r.players.forEach(id => {
    if (id === c.id) return;
    const p = clients.get(id); if (!p) return;
    if (p.sock.writableLength > 7.5e5) { if (!droppable) defer(p); return; }
    wr(p, fb);
  });
  else if (r.players.includes(to)) { const p = clients.get(to); if (p && p.sock.writableLength > 1.5e6) defer(p); else wr(p, fb); }
}
const sendTo = (c, o) => c && frame(c, 1, Buffer.from(JSON.stringify(o)));
const toRoom = (r, o, except) => r.players.forEach(id => id !== except && sendTo(clients.get(id), o));
const pushRoom = r => toRoom(r, { t: 'room', room: view(r) });
const pushList = () => { const l = listing(); clients.forEach(c => { if (!c.room) sendTo(c, { t: 'rooms', rooms: l }); }); };

function leave(c) {
  const r = rooms.get(c.room); if (!r) return;
  c.room = null; c.cid = 0;
  r.players = r.players.filter(id => id !== c.id);
  if (r.host === c.id || !r.players.length) {
    r.players.forEach(id => { const p = clients.get(id); if (p) { p.room = null; p.cid = 0; sendTo(p, { t: 'closed', why: 'The host left, so the lobby was closed.' }); } });
    rooms.delete(r.id);
  } else { toRoom(r, { t: 'chat', from: '', text: c.name + ' left' }); pushRoom(r); }
  pushList();
}

function onMsg(c, m) {
  const r = rooms.get(c.room);
  switch (m.t) {
    case 'hello': {
      const token = str(m.token, 100, '');
      const prior = token && [...clients.values()].find(x => { const lostAt = x.disconnectedAt || (x.sock.destroyed ? Date.now() : 0); return x !== c && x.token === token && x.room && !!lostAt && Date.now() - lostAt < 30000; });
      if (prior) {
        const oldId = prior.id, roomId = prior.room, oldCid = prior.cid, oldName = prior.name, rr = rooms.get(roomId);
        if (prior.resumeTimer) clearTimeout(prior.resumeTimer);
        prior.room = null; prior.cid = 0; prior.disconnectedAt = 0; prior.resumeTimer = null;
        if (clients.get(oldId) === prior) clients.delete(oldId);
        clients.delete(c.id); c.id = oldId; c.room = roomId; c.cid = oldCid; c.name = oldName; c.token = token; c.disconnectedAt = 0; c.needsFull = false;
        clients.set(c.id, c);
        sendTo(c, { t: 'welcome', id: c.id, resumed: true });
        if (rr) { pushRoom(rr); toRoom(rr, { t: 'chat', from: '', text: c.name + ' reconnected' }, c.id); }
      } else {
        c.name = str(m.name, 18, 'Player') || 'Player'; c.token = token;
        sendTo(c, { t: 'welcome', id: c.id, resumed: false });
      }
      break;
    }
    case 'list': sendTo(c, { t: 'rooms', rooms: listing() }); break;
    case 'create': {
      if (c.room) leave(c);
      const id = 'r' + nid++;
      const o = cleanOpts(m.o, { map: 'earth', era: 'modern', cm: 'pick', speed: 1, diff: 1, evt: 1, reb: 1, eco: 1, army: 1, cl: [] });
      const nr = { id, code: newCode(), name: str(m.name, 32, 'Lobby') || 'Lobby', pub: !!m.pub, max: num(m.max, 2, 12, 4) | 0, host: c.id, o, players: [c.id], started: false };
      rooms.set(id, nr); c.room = id; c.cid = 0;
      sendTo(c, { t: 'room', room: view(nr) }); pushList(); break;
    }
    case 'join': {
      if (c.room) leave(c);
      const code = str(m.code, 8).toUpperCase().trim();
      const t = code ? [...rooms.values()].find(x => x.code === code) : rooms.get(m.id);
      if (!t || (!code && !t.pub)) return sendTo(c, { t: 'err', m: 'Lobby not found. Check the code.' });
      if (t.started) return sendTo(c, { t: 'err', m: 'That game has already started.' });
      if (t.players.length >= t.max) return sendTo(c, { t: 'err', m: 'That lobby is full.' });
      t.players.push(c.id); c.room = t.id; c.cid = 0;
      toRoom(t, { t: 'chat', from: '', text: c.name + ' joined' }, c.id); pushRoom(t); pushList(); break;
    }
    case 'leave': leave(c); sendTo(c, { t: 'rooms', rooms: listing() }); break;
    case 'set': {
      if (!r || r.host !== c.id || r.started) return;
      const mapChanged = m.o && 'map' in m.o && m.o.map !== r.o.map;
      r.o = cleanOpts(m.o, r.o);
      if (typeof m.name === 'string') r.name = str(m.name, 32, r.name) || r.name;
      if ('pub' in m) r.pub = !!m.pub;
      if ('max' in m) r.max = Math.max(r.players.length, num(m.max, 2, 12, r.max) | 0);
      if (mapChanged || r.o.cm === 'random') r.players.forEach(id => clients.get(id).cid = 0);
      pushRoom(r); pushList(); break;
    }
    case 'pick': {
      if (!r || r.started || r.o.cm !== 'pick') return;
      const cid = num(m.cid, 0, 1e6, 0);
      if (cid && !r.o.cl.some(x => x[0] === cid)) return;
      if (cid && r.players.some(id => id !== c.id && clients.get(id).cid === cid)) return sendTo(c, { t: 'err', m: 'That country is already taken.' });
      c.cid = cid; pushRoom(r); break;
    }
    case 'chat': if (r) toRoom(r, { t: 'chat', from: c.name, text: str(m.text, 200) }); break;
    case 'start': if (r && r.host === c.id && !r.started) { r.started = true; pushRoom(r); pushList(); } break;
    case 'relay': {
      if (!r || m.d == null) return;
      const out = { t: 'msg', from: c.id, d: m.d };
      if (m.to === 'host') { if (r.host !== c.id) sendTo(clients.get(r.host), out); }
      else if (m.to === 'all') r.players.forEach(id => {
        if (id === c.id) return; const p = clients.get(id);
        if (m.d.k === 'snap' && p.sock.writableLength > 1.5e6) return; // drop snapshots for slow clients
        sendTo(p, out);
      });
      else if (r.players.includes(m.to)) sendTo(clients.get(m.to), out);
      break;
    }
  }
}

function parse(c) {
  for (;;) {
    const b = c.buf; if (b.length < 2) return;
    const op = b[0] & 15, fin = b[0] & 128; let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const masked = b[1] & 128; if (masked) off += 4;
    if (len > 12e6) return c.sock.destroy();
    if (b.length < off + len) return;
    const p = Buffer.from(b.subarray(off, off + len));
    if (masked) { const k = b.subarray(off - 4, off); for (let i = 0; i < p.length; i++) p[i] ^= k[i & 3]; }
    c.buf = b.subarray(off + len);
    if (op === 8) { c.sock.end(); return; }
    if (op === 9) { frame(c, 10, p); continue; }
    if (op === 10) continue;
    if (op === 1 || op === 0) {
      if (op === 1) c.frag = [];
      if (c.frag) c.frag.push(p);
      if (fin && c.frag) { const buf = Buffer.concat(c.frag); c.frag = null; if (buf[0] === 0x52 && buf[1] === 0x7c) rawRelay(c, buf); else { try { onMsg(c, JSON.parse(buf.toString())); } catch (e) { } } }
    }
  }
}

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/lobbies') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); return res.end(JSON.stringify(listing())); }
  if (u === '/health') { res.writeHead(200); return res.end('ok'); }
  if (u === '/' || /^\/index\.html?$/.test(u)) {
    fs.readFile(gameFile(), (e, d) => {
      if (e) { res.writeHead(500); return res.end('Game HTML not found next to server.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
    return;
  }
  res.writeHead(404); res.end('Not found');
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url.split('?')[0] !== '/ws' || !key) return sock.destroy();
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
  const c = { id: 'p' + nid++, sock, name: 'Player', room: null, cid: 0, token: '', disconnectedAt: 0, resumeTimer: null, needsFull: false, buf: Buffer.alloc(0), frag: null };
  clients.set(c.id, c); sock.setNoDelay(true);
  sock.on('data', d => { c.buf = Buffer.concat([c.buf, d]); parse(c); });
  sock.on('drain', () => { if (c.needsFull && c.room) { c.needsFull = false; sendTo(c, { t: 'resync' }); } });
  sock.on('close', () => {
    if (c.room && c.token) {
      c.disconnectedAt = Date.now();
      c.resumeTimer = setTimeout(() => { if (clients.get(c.id) === c && c.disconnectedAt) { leave(c); clients.delete(c.id); } }, 30000);
      return;
    }
    leave(c); if (clients.get(c.id) === c) clients.delete(c.id);
  });
  sock.on('error', () => { });
  sendTo(c, { t: 'rooms', rooms: listing() });
});
setInterval(() => clients.forEach(c => frame(c, 9, Buffer.alloc(0))), 25000); // keep-alive pings (helps behind proxies)

server.listen(PORT, () => console.log('PEW PEW GAME server on http://localhost:' + PORT + '  (game: ' + path.basename(gameFile()) + ')'));
