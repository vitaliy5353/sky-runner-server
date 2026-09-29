const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

// ============================================================
//   ХРАНИЛИЩЕ КОМНАТ
// ============================================================
const rooms = new Map();

// Очистка старых комнат (старше 3 часов)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > 3 * 60 * 60 * 1000) {
      rooms.delete(code);
      console.log(`[cleanup] Комната ${code} удалена (устарела)`);
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

// ============================================================
//   HTTP
// ============================================================
app.get('/', (req, res) => {
  res.send(`
    <h1>✈️ Sky Runner Multiplayer Server</h1>
    <p>Статус: <b style="color:green">ONLINE</b></p>
    <p>Активных комнат: ${rooms.size}</p>
    <p>Подключено игроков: ${io.engine.clientsCount}</p>
    <p>Uptime: ${Math.floor(process.uptime())}s</p>
  `);
});

app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size, players: io.engine.clientsCount });
});

app.get('/rooms', (req, res) => {
  const list = [];
  for (const [code, room] of rooms) {
    list.push({
      code,
      players: room.players.size,
      maxPlayers: 4,
      createdAt: room.createdAt,
      inGame: room.inGame || false,
    });
  }
  res.json(list);
});

// ============================================================
//   SOCKET.IO
// ============================================================
io.on('connection', (socket) => {
  console.log(`[+] Подключился: ${socket.id}`);
  socket.data.roomCode = null;
  socket.data.nick = null;

  // ---- Создать комнату ----
  socket.on('createRoom', ({ nick }, cb) => {
    try {
      if (!nick || nick.length < 2 || nick.length > 16) {
        return cb({ ok: false, err: 'Ник должен быть 2-16 символов' });
      }
      const code = generateRoomCode();
      const room = {
        players: new Map(),
        hostId: socket.id,
        createdAt: Date.now(),
        inGame: false,
      };
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
    } catch (e) {
      cb({ ok: false, err: 'Ошибка сервера' });
    }
  });

  // ---- Войти в комнату ----
  socket.on('joinRoom', ({ nick, code }, cb) => {
    try {
      if (!nick || nick.length < 2 || nick.length > 16) {
        return cb({ ok: false, err: 'Ник должен быть 2-16 символов' });
      }
      code = (code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return cb({ ok: false, err: 'Комната не найдена' });
      if (room.players.size >= 4) return cb({ ok: false, err: 'Комната заполнена (4/4)' });
      if (room.inGame) return cb({ ok: false, err: 'Бой уже идёт' });
      // Проверка на дубликат ника
      for (const p of room.players.values()) {
        if (p.nick.toLowerCase() === nick.toLowerCase()) {
          return cb({ ok: false, err: 'Такой ник уже есть в комнате' });
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
      console.log(`[room] ${nick} вошёл в комнату ${code}`);
      socket.to(code).emit('playerJoined', player);
      cb({ ok: true, code, players: Array.from(room.players.values()) });
    } catch (e) {
      cb({ ok: false, err: 'Ошибка сервера' });
    }
  });

  // ---- ХОСТ НАЧИНАЕТ ИГРУ ----
  socket.on('startGame', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    // Только хост может запустить
    if (room.hostId !== socket.id) {
      console.log(`[startGame] ${socket.data.nick} не хост, отклонено`);
      return;
    }
    room.inGame = true;
    // Сбросить состояния всех игроков
    room.players.forEach(p => {
      p.hp = 100;
      p.alive = true;
      p.score = 0;
      p.kills = 0;
      p.x = (Math.random() - 0.5) * 200;
      p.y = 150 + Math.random() * 100;
      p.z = (Math.random() - 0.5) * 200;
      p.yaw = 0; p.pitch = 0; p.roll = 0;
    });
    console.log(`[room] Хост ${socket.data.nick} начал игру в ${code} (${room.players.size} игроков)`);
    io.to(code).emit('gameStarted', {
      players: Array.from(room.players.values()),
    });
  });

  // ---- Обновление позиции самолёта ----
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
      id: socket.id,
      x: data.x, y: data.y, z: data.z,
      yaw: data.yaw, pitch: data.pitch, roll: data.roll,
      hp: data.hp,
    });
  });

  // ---- Выстрел ----
  socket.on('shoot', (data) => {
    const code = socket.data.roomCode;
    if (!code) return;
    socket.to(code).emit('playerShot', {
      id: socket.id,
      x: data.x, y: data.y, z: data.z,
      dx: data.dx, dy: data.dy, dz: data.dz,
    });
  });

  // ---- Попадание ----
  socket.on('hitPlayer', ({ targetId, damage }) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const victim = room.players.get(targetId);
    const shooter = room.players.get(socket.id);
    if (!victim || !shooter) return;
    if (!victim.alive) return;
    victim.hp -= damage;
    if (victim.hp <= 0) {
      victim.hp = 0;
      victim.alive = false;
      shooter.kills++;
      shooter.score += 200;
      io.to(code).emit('playerKilled', {
        killer: shooter.nick,
        killerId: shooter.id,
        victim: victim.nick,
        victimId: victim.id,
      });
      console.log(`[kill] ${shooter.nick} -> ${victim.nick}`);
    } else {
      io.to(targetId).emit('takeDamage', { damage, from: shooter.nick });
    }
  });

  // ---- Respawn ----
  socket.on('respawn', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.hp = 100;
    p.alive = true;
    p.x = (Math.random() - 0.5) * 400;
    p.y = 150 + Math.random() * 100;
    p.z = (Math.random() - 0.5) * 400;
    io.to(code).emit('playerRespawned', {
      id: socket.id,
      x: p.x, y: p.y, z: p.z, hp: 100,
    });
  });

  // ---- Чат ----
  socket.on('chat', (msg) => {
    const code = socket.data.roomCode;
    if (!code || !msg) return;
    msg = String(msg).slice(0, 100);
    io.to(code).emit('chatMessage', {
      nick: socket.data.nick,
      msg,
      time: Date.now(),
    });
  });

  // ---- Вернуться в лобби ----
  socket.on('returnToLobby', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    room.inGame = false;
    // Сбросить состояние игроков
    room.players.forEach(p => {
      p.hp = 100;
      p.alive = true;
      p.score = 0;
      p.kills = 0;
      p.x = 0; p.y = 150; p.z = 0;
      p.yaw = 0; p.pitch = 0; p.roll = 0;
    });
    io.to(code).emit('backToLobby', {
      players: Array.from(room.players.values()),
    });
    console.log(`[room] ${code} вернулись в лобби`);
  });

  // ---- Покинуть комнату ----
  socket.on('leaveRoom', () => {
    handleLeave(socket);
  });

  // ---- Отключение ----
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
    console.log(`[room] ${player.nick} покинул комнату ${code}`);
    socket.to(code).emit('playerLeft', { id: socket.id, nick: player.nick });
  }
  room.players.delete(socket.id);
  socket.leave(code);
  // Если хост ушёл — назначаем нового
  if (room.hostId === socket.id && room.players.size > 0) {
    const newHost = room.players.values().next().value;
    room.hostId = newHost.id;
    newHost.isHost = true;
    io.to(code).emit('newHost', { id: newHost.id, nick: newHost.nick });
  }
  // Если комната пуста — удаляем
  if (room.players.size === 0) {
    rooms.delete(code);
    console.log(`[room] Комната ${code} удалена (пуста)`);
  }
  socket.data.roomCode = null;
  socket.data.nick = null;
}

server.listen(PORT, () => {
  console.log(`🚀 Server запущен на порту ${PORT}`);
  console.log(`📡 WebSocket готов к подключениям`);
});
