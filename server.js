const WebSocket = require('ws');

const WORLD_WIDTH = 2000;
const WORLD_HEIGHT = 2000;
const TICK_RATE = 1000 / 60; // 60 FPS
const BULLET_SPEED = 8;
const PLAYER_SPEED = 4;
const MAX_PLAYERS = 10;

let players = new Map(); // ws -> { id, x, y, angle, health, color, shield, fireRate, lastShot, alive }
let bullets = [];
let powerUps = [];
let nextId = 1;

// Potenciadores iniciales
for (let i = 0; i < 10; i++) {
  spawnPowerUp();
}

function spawnPowerUp() {
  const types = ['speed', 'multishot', 'shield'];
  const type = types[Math.floor(Math.random() * types.length)];
  powerUps.push({
    id: Math.random().toString(36).substr(2, 6),
    x: Math.random() * WORLD_WIDTH - WORLD_WIDTH/2,
    y: Math.random() * WORLD_HEIGHT - WORLD_HEIGHT/2,
    type,
    radius: 15
  });
}

// Lógica de colisiones y físicas simple
function update() {
  // Mover jugadores (reciben input del cliente)
  // Mover balas
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += Math.cos(b.angle) * BULLET_SPEED;
    b.y += Math.sin(b.angle) * BULLET_SPEED;
    // Eliminar si sale del mundo
    if (Math.abs(b.x) > WORLD_WIDTH/2 || Math.abs(b.y) > WORLD_HEIGHT/2) {
      bullets.splice(i, 1);
      continue;
    }
    // Colisión con jugadores
    for (let [ws, player] of players) {
      if (player.alive && player.id !== b.ownerId) {
        const dx = player.x - b.x;
        const dy = player.y - b.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < 20) { // radio de colisión
          if (player.shield > 0) {
            player.shield--;
          } else {
            player.health -= 10;
            if (player.health <= 0) {
              player.alive = false;
              player.health = 0;
              broadcast({ type: 'playerDied', id: player.id, killerId: b.ownerId });
            }
          }
          bullets.splice(i, 1);
          break;
        }
      }
    }
  }
  // Potenciadores: recoger
  for (let [ws, player] of players) {
    if (!player.alive) continue;
    for (let i = powerUps.length - 1; i >= 0; i--) {
      const p = powerUps[i];
      const dx = player.x - p.x;
      const dy = player.y - p.y;
      if (Math.sqrt(dx*dx + dy*dy) < 30) {
        applyPowerUp(player, p.type);
        powerUps.splice(i, 1);
        spawnPowerUp(); // mantener 10 siempre
      }
    }
  }
}

function applyPowerUp(player, type) {
  switch (type) {
    case 'speed':
      player.speedBoost = 300; // 5 segundos a 60fps
      break;
    case 'multishot':
      player.multishot = 300;
      break;
    case 'shield':
      player.shield = Math.min(player.shield + 3, 5);
      break;
  }
}

function handlePlayerInput(ws, input) {
  const player = players.get(ws);
  if (!player || !player.alive) return;
  // input: { keys: { w, a, s, d }, mouseAngle }
  const speed = PLAYER_SPEED + (player.speedBoost > 0 ? 3 : 0);
  if (input.keys.w) player.y -= speed;
  if (input.keys.s) player.y += speed;
  if (input.keys.a) player.x -= speed;
  if (input.keys.d) player.x += speed;
  // Limitar mundo
  player.x = Math.max(-WORLD_WIDTH/2, Math.min(WORLD_WIDTH/2, player.x));
  player.y = Math.max(-WORLD_HEIGHT/2, Math.min(WORLD_HEIGHT/2, player.y));
  if (input.mouseAngle !== undefined) {
    player.angle = input.mouseAngle;
  }
  // Disparo
  if (input.shoot && Date.now() - player.lastShot > (player.multishot > 0 ? 100 : 200)) {
    player.lastShot = Date.now();
    const bullet = {
      id: Math.random().toString(36).substr(2, 6),
      x: player.x,
      y: player.y,
      angle: player.angle,
      ownerId: player.id
    };
    bullets.push(bullet);
    if (player.multishot > 0) {
      // dos balas extra
      bullets.push({ ...bullet, angle: player.angle + 0.15, id: Math.random().toString(36).substr(2,6) });
      bullets.push({ ...bullet, angle: player.angle - 0.15, id: Math.random().toString(36).substr(2,6) });
    }
  }
  // Reducir boosts
  if (player.speedBoost > 0) player.speedBoost--;
  if (player.multishot > 0) player.multishot--;
}

// Respawnear jugador
function respawnPlayer(player) {
  player.x = (Math.random() - 0.5) * WORLD_WIDTH * 0.8;
  player.y = (Math.random() - 0.5) * WORLD_HEIGHT * 0.8;
  player.health = 100;
  player.shield = 0;
  player.alive = true;
  player.speedBoost = 0;
  player.multishot = 0;
}

// WebSocket
const wss = new WebSocket.Server({ port: process.env.PORT || 3000 });

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) {
    ws.close(1000, 'Servidor lleno');
    return;
  }
  const playerId = nextId++;
  const color = `hsl(${Math.random() * 360}, 70%, 60%)`;
  const player = {
    id: playerId,
    x: (Math.random() - 0.5) * WORLD_WIDTH * 0.5,
    y: (Math.random() - 0.5) * WORLD_HEIGHT * 0.5,
    angle: 0,
    health: 100,
    color,
    shield: 0,
    speedBoost: 0,
    multishot: 0,
    lastShot: 0,
    alive: true
  };
  players.set(ws, player);

  // Enviar ID y estado inicial
  ws.send(JSON.stringify({ type: 'init', id: playerId, color, worldSize: { w: WORLD_WIDTH, h: WORLD_HEIGHT } }));
  // Enviar todos los jugadores
  broadcastGameState();

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'input') {
      handlePlayerInput(ws, msg);
    }
  });

  ws.on('close', () => {
    players.delete(ws);
    broadcastGameState();
  });
});

function broadcastGameState() {
  const state = {
    type: 'gameState',
    players: Array.from(players.values()).map(p => ({
      id: p.id,
      x: p.x,
      y: p.y,
      angle: p.angle,
      health: p.health,
      color: p.color,
      shield: p.shield,
      alive: p.alive,
      speedBoost: p.speedBoost > 0,
      multishot: p.multishot > 0
    })),
    bullets: bullets.map(b => ({ x: b.x, y: b.y, angle: b.angle })),
    powerUps: powerUps.map(p => ({ id: p.id, x: p.x, y: p.y, type: p.type }))
  };
  broadcast(state);
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

setInterval(() => {
  update();
  // Revivir jugadores muertos automáticamente después de 3 seg (simplificado: lo hacemos en el update)
  for (let [ws, player] of players) {
    if (!player.alive) {
      player.respawnTimer = (player.respawnTimer || 0) + 1;
      if (player.respawnTimer > 180) { // 3 segundos
        respawnPlayer(player);
        player.respawnTimer = 0;
      }
    }
  }
  broadcastGameState();
}, TICK_RATE);

console.log('Space Arena server running');
