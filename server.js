const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

const rooms = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 3 * 60 * 60 * 1000) {
      rooms.delete(code);
      console.log(`[cleanup] Комната ${code} удалена`);
    }
  }
}, 10 * 60 * 1000);

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms.has(code));
  return code;
}

app.get('/', (req, res) => {
  res.send(`
    <h1>Sky Runner Multiplayer Server</h1>
    <p>Status: ONLINE</p>
    <p>Rooms: ${rooms.size}</p>
    <p>Players: ${io.engine.clientsCount}</p>
    <p>Uptime: ${Math.floor(process.uptime())}s</p>
  `);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size, players: io.engine.clientsCount });
});

app.get('/rooms', (req, res) => {
  const list = [];
  for (const [code, room] of rooms) {
    list.push({ code, players: room.players.size, maxPlayers: 4, createdAt: room.createdAt });
  }
  res.json(list);
});

io.on('connection', (socket) => {
  console.log(`[+] Подключился: ${socket.id}`);
  socket.data.roomCode = null;
  socket.data.nick = null;

  socket.on('createRoom', ({ nick }, cb) => {
    try {
      if (!nick || nick.length < 2 || nick.length > 16) {
        return cb({ ok: false, err: 'Ник 2-16 символов' });
      }
      const code = generateRoomCode();
      const room = { players: new Map(), hostId: socket.id, createdAt: Date.now() };
      const player = {
        id: socket.id, nick, hp: 100, score: 0, kills: 0,
        x: 0, y: 150, z: 0, yaw: 0, pitch: 0, roll: 0,
        isHost: true, alive: true,
      };
      room.players.set(socket.id, player);
      rooms.set(code, room);
      socket.data.roomCode = code;
      socket.data.nick = nick;
      socket.join(code);
      console.log(`[room] ${nick} создал комнату ${code}`);
      cb({ ok: true, code, players: Array.from(room.players.values()) });
    } catch (e) { cb({ ok: false, err: 'Ошибка сервера' }); }
  });

  socket.on('joinRoom', ({ nick, code }, cb) => {
    try {
      if (!nick || nick.length < 2 || nick.length > 16) {
        return cb({ ok: false, err: 'Ник 2-16 символов' });
      }
      code = (code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return cb({ ok: false, err: 'Комната не найдена' });
      if (room.players.size >= 4) return cb({ ok: false, err: 'Комната заполнена' });
      for (const p of room.players.values()) {
        if (p.nick.toLowerCase() === nick.toLowerCase()) {
          return cb({ ok: false, err: 'Такой ник уже есть' });
        }
      }
      const player = {
        id: socket.id, nick, hp: 100, score: 0, kills: 0,
        x: 0, y: 150, z: 0, yaw: 0, pitch: 0, roll: 0,
        isHost: false, alive: true,
      };
      room.players.set(socket.id, player);
      socket.data.roomCode = code;
      socket.data.nick = nick;
      socket.join(code);
      console.log(`[room] ${nick} вошёл в ${code}`);
      socket.to(code).emit('playerJoined', player);
      cb({ ok: true, code, players: Array.from(room.players.values()) });
    } catch (e) { cb({ ok: false, err: 'Ошибка сервера' }); }
  });

  socket.on('update', (data) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.x = data.x; p.y = data.y; p.z = data.z;
    p.yaw = data.yaw; p.pitch = data.pitch; p.roll = data.roll;
    p.hp = data.hp;
    socket.to(code).emit('playerUpdate', {
      id: socket.id, x: data.x, y: data.y, z: data.z,
      yaw: data.yaw, pitch: data.pitch, roll: data.roll, hp: data.hp,
    });
  });

  socket.on('shoot', (data) => {
    const code = socket.data.roomCode;
    if (!code) return;
    socket.to(code).emit('playerShot', {
      id: socket.id, x: data.x, y: data.y, z: data.z,
      dx: data.dx, dy: data.dy, dz: data.dz,
    });
  });

  socket.on('hitPlayer', ({ targetId, damage }) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const victim = room.players.get(targetId);
    const shooter = room.players.get(socket.id);
    if (!victim || !shooter || !victim.alive) return;
    victim.hp -= damage;
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.alive = false;
      shooter.kills++;
      shooter.score += 200;
      io.to(code).emit('playerKilled', {
        killer: shooter.nick, killerId: shooter.id,
        victim: victim.nick, victimId: victim.id,
      });
      console.log(`[kill] ${shooter.nick} -> ${victim.nick}`);
    } else {
      io.to(targetId).emit('takeDamage', { damage, from: shooter.nick });
    }
  });

  socket.on('respawn', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.hp = 100; p.alive = true;
    p.x = (Math.random() - 0.5) * 400;
    p.y = 150 + Math.random() * 100;
    p.z = (Math.random() - 0.5) * 400;
    io.to(code).emit('playerRespawned', {
      id: socket.id, x: p.x, y: p.y, z: p.z, hp: 100,
    });
  });

  socket.on('chat', (msg) => {
    const code = socket.data.roomCode;
    if (!code || !msg) return;
    msg = String(msg).slice(0, 100);
    io.to(code).emit('chatMessage', { nick: socket.data.nick, msg, time: Date.now() });
  });

  socket.on('leaveRoom', () => { handleLeave(socket); });

  socket.on('disconnect', () => {
    console.log(`[-] Отключился: ${socket.id}`);
    handleLeave(socket);
  });
});

function handleLeave(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  const player = room.players.get(socket.id);
  if (player) {
    console.log(`[room] ${player.nick} покинул ${code}`);
    socket.to(code).emit('playerLeft', { id: socket.id, nick: player.nick });
  }
  room.players.delete(socket.id);
  socket.leave(code);
  if (room.hostId === socket.id && room.players.size > 0) {
    const newHost = room.players.values().next().value;
    room.hostId = newHost.id;
    newHost.isHost = true;
    io.to(code).emit('newHost', { id: newHost.id, nick: newHost.nick });
  }
  if (room.players.size === 0) {
    rooms.delete(code);
    console.log(`[room] Комната ${code} удалена`);
  }
  socket.data.roomCode = null;
  socket.data.nick = null;
}

server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
});
