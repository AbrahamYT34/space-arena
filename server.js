const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Servir archivos estáticos desde la carpeta 'public' (ahí pondremos el HTML)
app.use(express.static('public'));

// Constantes del juego
const WORLD_W = 3000, WORLD_H = 3000;
const TICK = 1000 / 60;
const MAX_PLAYERS = 20;

// Almacenamiento
let players = new Map(); // ws -> player
let bullets = [];
let powerUps = [];
let mines = [];
let obstacles = [];
let flags = { red: null, blue: null }; // Para CTF
let gameMode = 'deathmatch'; // 'deathmatch', 'ctf', 'king', 'survival'
let nextId = 1;

// Inicializar obstáculos
for (let i = 0; i < 15; i++) {
  obstacles.push({
    id: i,
    x: Math.random() * WORLD_W - WORLD_W/2,
    y: Math.random() * WORLD_H - WORLD_H/2,
    radius: 30 + Math.random() * 50,
    type: Math.random() < 0.3 ? 'blackhole' : 'asteroid',
    angle: Math.random() * Math.PI * 2,
    speed: 0.5 + Math.random()
  });
}

// Potenciadores
for (let i = 0; i < 20; i++) spawnPowerUp();

function spawnPowerUp() {
  const types = ['speed', 'multishot', 'shield', 'laser', 'health', 'invis', 'teleport', 'mine'];
  const type = types[Math.floor(Math.random() * types.length)];
  powerUps.push({
    id: Math.random().toString(36).substr(2,6),
    x: Math.random() * WORLD_W - WORLD_W/2,
    y: Math.random() * WORLD_H - WORLD_H/2,
    type
  });
}

// Chat
let chatMessages = [];

// Lógica del juego
function update() {
  // Mover obstáculos
  obstacles.forEach(o => {
    if (o.type === 'asteroid') {
      o.x += Math.cos(o.angle) * o.speed;
      o.y += Math.sin(o.angle) * o.speed;
      if (Math.abs(o.x) > WORLD_W/2 || Math.abs(o.y) > WORLD_H/2) o.angle += Math.PI;
    } else if (o.type === 'blackhole') {
      // Atraer jugadores cercanos
      for (let [ws, p] of players) {
        if (!p.alive) continue;
        const dx = o.x - p.x, dy = o.y - p.y;
        const dist = Math.sqrt(dx*dx+dy*dy);
        if (dist < 200) {
          p.x += dx / dist * 0.8;
          p.y += dy / dist * 0.8;
        }
      }
    }
  });

  // Balas
  for (let i = bullets.length-1; i >=0; i--) {
    const b = bullets[i];
    b.x += Math.cos(b.angle) * b.speed;
    b.y += Math.sin(b.angle) * b.speed;
    if (Math.abs(b.x) > WORLD_W/2 || Math.abs(b.y) > WORLD_H/2) {
      bullets.splice(i,1);
      continue;
    }
    // Colisión con jugadores
    for (let [ws, p] of players) {
      if (!p.alive || p.id === b.ownerId) continue;
      if (p.invisible) continue;
      const dx = p.x - b.x, dy = p.y - b.y;
      if (Math.sqrt(dx*dx+dy*dy) < 18) {
        if (p.shield > 0) { p.shield--; }
        else {
          p.health -= b.damage;
          if (p.health <= 0) {
            p.health = 0;
            p.alive = false;
            p.deathTimer = 180;
            // Dar puntos al que mató
            const killer = getPlayerById(b.ownerId);
            if (killer) killer.score = (killer.score||0) + 100;
          }
        }
        bullets.splice(i,1);
        break;
      }
    }
  }

  // Minas
  mines.forEach(m => {
    for (let [ws, p] of players) {
      if (!p.alive || p.id === m.ownerId) continue;
      if (p.invisible) continue;
      const dx = p.x - m.x, dy = p.y - m.y;
      if (Math.sqrt(dx*dx+dy*dy) < 30) {
        // Explosión
        p.health -= 30;
        if (p.health <= 0) {
          p.alive = false;
          p.deathTimer = 180;
          const killer = getPlayerById(m.ownerId);
          if (killer) killer.score = (killer.score||0) + 50;
        }
        // Remover mina
        mines = mines.filter(m2 => m2.id !== m.id);
        // Efecto de área (daño a otros)
        for (let [ws2, p2] of players) {
          if (p2.id !== p.id && p2.alive && !p2.invisible) {
            const dx2 = p2.x - m.x, dy2 = p2.y - m.y;
            if (Math.sqrt(dx2*dx2+dy2*dy2) < 80) p2.health -= 15;
          }
        }
        break;
      }
    }
  });

  // PowerUps
  for (let [ws, p] of players) {
    if (!p.alive) continue;
    for (let i = powerUps.length-1; i>=0; i--) {
      const pu = powerUps[i];
      const dx = p.x - pu.x, dy = p.y - pu.y;
      if (Math.sqrt(dx*dx+dy*dy) < 25) {
        applyPowerUp(p, pu.type);
        powerUps.splice(i,1);
        spawnPowerUp();
      }
    }
  }

  // Reapariciones
  for (let [ws, p] of players) {
    if (!p.alive) {
      p.deathTimer--;
      if (p.deathTimer <= 0) respawn(p);
    }
    // Recargar escudo
    if (p.alive && p.shield < p.maxShield) {
      p.shieldRecharge = (p.shieldRecharge || 0) + 1;
      if (p.shieldRecharge >= 120) { // 2 segundos
        p.shield = Math.min(p.shield+1, p.maxShield);
        p.shieldRecharge = 0;
      }
    }
  }
}

function applyPowerUp(p, type) {
  switch(type) {
    case 'speed': p.speedBoost = 300; break;
    case 'multishot': p.multishot = 300; break;
    case 'shield': p.shield = Math.min(p.shield+3, 5); break;
    case 'laser': p.laserBeam = 180; break;
    case 'health': p.health = Math.min(p.health+30, 100); break;
    case 'invis': p.invisible = 240; break;
    case 'teleport': p.teleport = true; break;
    case 'mine': p.mines = (p.mines||0) + 2; break;
  }
}

function respawn(p) {
  p.x = (Math.random() - 0.5) * WORLD_W * 0.7;
  p.y = (Math.random() - 0.5) * WORLD_H * 0.7;
  p.health = 100;
  p.shield = 0;
  p.alive = true;
  p.deathTimer = 0;
  p.invisible = 0;
  p.speedBoost = 0;
  p.multishot = 0;
  p.laserBeam = 0;
  p.teleport = false;
  p.invulnerable = 120; // 2 seg invulnerable
}

function getPlayerById(id) {
  for (let [ws, p] of players) if (p.id === id) return p;
  return null;
}

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) { ws.close(); return; }
  const id = nextId++;
  const color = `hsl(${id * 50 % 360}, 70%, 60%)`;
  const player = {
    id, name: `Player${id}`, x: 0, y: 0, angle: 0,
    health: 100, maxHealth: 100, shield: 0, maxShield: 5,
    alive: true, score: 0,
    color, speedBoost: 0, multishot: 0, laserBeam: 0,
    invisible: false, teleport: false, mines: 0,
    invulnerable: 0,
    weapon: 'laser', // arma actual
    kills: 0, deaths: 0
  };
  players.set(ws, player);
  ws.send(JSON.stringify({ type:'init', id, color, worldSize:{w:WORLD_W,h:WORLD_H} }));
  broadcastGameState();

  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'input') handleInput(ws, msg);
    if (msg.type === 'chat') {
      chatMessages.push({name: player.name, text: msg.text, time: Date.now()});
      if (chatMessages.length > 20) chatMessages.shift();
      broadcast({ type:'chat', messages: chatMessages });
    }
    if (msg.type === 'changeWeapon') player.weapon = msg.weapon;
  });

  ws.on('close', () => {
    players.delete(ws);
    broadcastGameState();
  });
});

function handleInput(ws, input) {
  const p = players.get(ws);
  if (!p || !p.alive) return;
  const speed = 4 + (p.speedBoost > 0 ? 3 : 0);
  if (input.keys.w) p.y -= speed;
  if (input.keys.s) p.y += speed;
  if (input.keys.a) p.x -= speed;
  if (input.keys.d) p.x += speed;
  p.angle = input.mouseAngle;
  p.x = Math.max(-WORLD_W/2, Math.min(WORLD_W/2, p.x));
  p.y = Math.max(-WORLD_H/2, Math.min(WORLD_H/2, p.y));

  if (p.invulnerable > 0) p.invulnerable--;

  // Teleport
  if (p.teleport && input.teleport) {
    p.x = input.mouseWorldX;
    p.y = input.mouseWorldY;
    p.teleport = false;
  }

  // Disparo
  if (input.shoot && Date.now() - (p.lastShot||0) > 200) {
    p.lastShot = Date.now();
    const weapon = p.weapon || 'laser';
    switch(weapon) {
      case 'laser':
        bullets.push({ id:Math.random().toString(36), x:p.x, y:p.y, angle:p.angle, speed:8, damage:10, ownerId:p.id });
        break;
      case 'shotgun':
        for (let i=-2; i<=2; i++) {
          bullets.push({ id:Math.random().toString(36), x:p.x, y:p.y, angle:p.angle+i*0.15, speed:7, damage:8, ownerId:p.id });
        }
        break;
      case 'rocket':
        bullets.push({ id:Math.random().toString(36), x:p.x, y:p.y, angle:p.angle, speed:5, damage:30, ownerId:p.id });
        break;
      case 'sniper':
        bullets.push({ id:Math.random().toString(36), x:p.x, y:p.y, angle:p.angle, speed:15, damage:25, ownerId:p.id });
        break;
      case 'mine':
        if (p.mines > 0) {
          mines.push({ id:Math.random().toString(36), x:p.x, y:p.y, ownerId:p.id });
          p.mines--;
        }
        break;
    }
    if (p.multishot > 0 && weapon !== 'shotgun') {
      bullets.push({ id:Math.random().toString(36), x:p.x, y:p.y, angle:p.angle+0.2, speed:8, damage:10, ownerId:p.id });
      bullets.push({ id:Math.random().toString(36), x:p.x, y:p.y, angle:p.angle-0.2, speed:8, damage:10, ownerId:p.id });
    }
    if (p.laserBeam > 0) {
      bullets.push({ id:Math.random().toString(36), x:p.x, y:p.y, angle:p.angle, speed:20, damage:15, ownerId:p.id });
    }
  }

  if (p.speedBoost > 0) p.speedBoost--;
  if (p.multishot > 0) p.multishot--;
  if (p.laserBeam > 0) p.laserBeam--;
  if (p.invisible > 0) p.invisible--;
}

function broadcastGameState() {
  const state = {
    type: 'gameState',
    players: Array.from(players.values()).map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, angle: p.angle,
      health: p.health, maxHealth: p.maxHealth, shield: p.shield,
      alive: p.alive, color: p.color, score: p.score,
      invisible: p.invisible > 0, weapon: p.weapon
    })),
    bullets, mines, powerUps, obstacles,
    gameMode, chatMessages: chatMessages.slice(-5)
  };
  broadcast(state);
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

setInterval(() => {
  update();
  broadcastGameState();
}, TICK);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Space Arena Ultra en puerto', PORT));
