/**
 * mock-server.mjs — Lightweight mock backend for frontend visual verification.
 * Serves /health, /api/me, /api/fleet/discover, /sub/fleet/:id (SSE).
 * Pushes realistic fleet aggregates with memberSnapshots every 2s.
 *
 * Usage: node server/mock-server.mjs
 * Then: cd client && npm run dev  (proxies /api → :3000, /sub → :80)
 */
import http from 'node:http';

const PORT_API = 3100;
const PORT_SSE = 3101;
const FLEET_ID = 'mock-fleet-001';

// ── Ship roster (real EVE shipTypeIds from shipTypes.ts) ─────────────────────
const pilots = [
  { charId: 1001, name: 'PilotAlpha',    ship: 'Muninn',     shipTypeId: 12015, groupId: 358, role: 'combat' },
  { charId: 1002, name: 'PilotBravo',    ship: 'Muninn',     shipTypeId: 12015, groupId: 358, role: 'combat' },
  { charId: 1003, name: 'PilotCharlie',  ship: 'Muninn',     shipTypeId: 12015, groupId: 358, role: 'combat' },
  { charId: 1004, name: 'PilotDelta',    ship: 'Muninn',     shipTypeId: 12015, groupId: 358, role: 'combat' },
  { charId: 1005, name: 'PilotEcho',     ship: 'Muninn',     shipTypeId: 12015, groupId: 358, role: 'combat' },
  { charId: 1006, name: 'PilotFoxtrot',  ship: 'Cerberus',   shipTypeId: 11993, groupId: 358, role: 'combat' },
  { charId: 1007, name: 'PilotGolf',     ship: 'Cerberus',   shipTypeId: 11993, groupId: 358, role: 'combat' },
  { charId: 1008, name: 'PilotHotel',    ship: 'Cerberus',   shipTypeId: 11993, groupId: 358, role: 'combat' },
  // Zero DPS combat pilot (AFK)
  { charId: 1009, name: 'PilotIndia',    ship: 'Cerberus',   shipTypeId: 11993, groupId: 358, role: 'combat', afk: true },
  // Logistics
  { charId: 1010, name: 'PilotJuliet',   ship: 'Scimitar',   shipTypeId: 11978, groupId: 832, role: 'logistics' },
  { charId: 1011, name: 'PilotKilo',     ship: 'Scimitar',   shipTypeId: 11978, groupId: 832, role: 'logistics' },
  // EWAR
  { charId: 1012, name: 'PilotLima',     ship: 'Huginn',     shipTypeId: 11961, groupId: 906, role: 'ewar' },
];

function rand(min, max) { return min + Math.random() * (max - min); }

function makeHitQuality(pilot) {
  // Missiles (Cerberus) → empty distribution
  if (pilot.ship === 'Cerberus') return {};
  // Logistics → empty
  if (pilot.role === 'logistics') return {};
  // EWAR → sparse
  if (pilot.role === 'ewar') return { Hits: Math.floor(rand(5, 15)) };
  // Turret DPS ships → full distribution
  return {
    Wrecks:        Math.floor(rand(2, 8)),
    Smashes:       Math.floor(rand(8, 20)),
    Penetrates:    Math.floor(rand(15, 30)),
    Hits:          Math.floor(rand(10, 25)),
    'Glances Off': Math.floor(rand(3, 10)),
    Grazes:        Math.floor(rand(1, 5)),
    Misses:        Math.floor(rand(0, 3)),
  };
}

const targets = ['Hostile Loki', 'Hostile Machariel', 'Hostile Scimitar', 'Hostile Muninn'];

function buildAggregate() {
  const memberSnapshots = {};
  let totalDps = 0;
  const breakdownMap = {};

  for (const p of pilots) {
    let dpsOut = 0;
    if (p.afk) {
      dpsOut = 0;
    } else if (p.role === 'logistics') {
      dpsOut = 0;
    } else if (p.role === 'ewar') {
      dpsOut = Math.floor(rand(20, 80));
    } else {
      dpsOut = Math.floor(rand(400, 900));
    }

    const logiOut = p.role === 'logistics' ? Math.floor(rand(200, 500)) : 0;

    memberSnapshots[p.charId] = {
      dpsOut,
      dpsIn: Math.floor(rand(0, 100)),
      logiOut,
      logiIn: 0,
      capTransfered: 0,
      capRecieved: 0,
      capDamageOut: 0,
      capDamageIn: 0,
      mined: 0,
      shipTypeId: p.shipTypeId,
      solarSystemId: 30004759,
      characterName: p.name,
      shipName: p.ship,
      totalDps: dpsOut,
      hitQualityDistribution: makeHitQuality(p),
      hitQualityDistributionIn: {},
    };

    totalDps += dpsOut;

    // Build breakdown entries (each pilot → a target)
    if (dpsOut > 0) {
      // 70% focus on primary target, rest spread
      const primaryIdx = 0;
      const targetIdx = Math.random() < 0.7 ? primaryIdx : Math.floor(rand(0, targets.length));
      const target = targets[targetIdx];
      breakdownMap[`${p.name}→${target}`] = {
        pilotName: p.name,
        targetName: target,
        weaponName: p.ship === 'Cerberus' ? 'Heavy Assault Missile' : '720mm Howitzer',
        shipName: p.ship,
        amount: dpsOut,
      };
    }
  }

  const breakdown = Object.values(breakdownMap)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 20);

  // Aggregate hit quality
  const hqOut = {};
  for (const snap of Object.values(memberSnapshots)) {
    for (const [q, c] of Object.entries(snap.hitQualityDistribution || {})) {
      hqOut[q] = (hqOut[q] || 0) + c;
    }
  }

  return {
    fleetSessionId: FLEET_ID,
    dpsOut: totalDps,
    dpsIn: Math.floor(rand(500, 2000)),
    logiOut: Object.values(memberSnapshots).reduce((s, m) => s + (m.logiOut || 0), 0),
    logiIn: Math.floor(rand(100, 400)),
    capTransfered: 0,
    capRecieved: 0,
    capDamageOut: 0,
    capDamageIn: 0,
    mined: 0,
    memberCount: pilots.length,
    hitQualityDistribution: hqOut,
    hitQualityDistributionIn: {},
    breakdown,
    memberSnapshots,
  };
}

// ── API server (:3000) ───────────────────────────────────────────────────────
const apiServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT_API}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (url.pathname === '/api/me') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      userId: 'mock-user-001',
      name: 'MockFC',
      roles: ['pilot', 'fc', 'war_commander'],
      characters: [
        { id: 90001, name: 'MockFC Alpha' },
        { id: 90002, name: 'MockFC Bravo' },
      ],
    }));
    return;
  }

  if (url.pathname === '/api/fleet/discover') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ fleet: { id: FLEET_ID } }));
    return;
  }

  // Catch-all
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Not found' }));
});

apiServer.listen(PORT_API, () => {
  console.log(`[mock] API server on http://localhost:${PORT_API}`);
  console.log(`[mock]   /health, /api/me, /api/fleet/discover`);
});

// ── SSE server (:80) — mimics Nchan ─────────────────────────────────────────
const sseClients = new Set();

const sseServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT_SSE}`);

  if (!url.pathname.startsWith('/sub/fleet/')) {
    res.writeHead(404); res.end(); return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send initial aggregate immediately
  const initial = buildAggregate();
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

sseServer.listen(PORT_SSE, () => {
  console.log(`[mock] SSE server on http://localhost:${PORT_SSE}`);
  console.log(`[mock]   Pushing fleet data every 2s to ${sseClients.size} client(s)`);
});

// Push every 2 seconds
setInterval(() => {
  if (sseClients.size === 0) return;
  const data = JSON.stringify(buildAggregate());
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}, 2000);

console.log(`\n[mock] Ready. Start frontend:`);
console.log(`  cd client && MOCK=1 npm run dev`);
console.log(`  or: cd client && npx rsbuild dev --port 3000`);
console.log(`  (with rsbuild proxy pointing to :3001/:3002)`);
console.log(`[mock] Then open http://localhost:3000/commander\n`);
