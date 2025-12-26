// server.js — "tankes" (turnos simultáneos, 1 acción por turno)
// Ejecuta: npm i express socket.io  &&  node server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3000;

const app = express();
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

/**
 * tankes (MVP)
 * - 2 jugadores (A y B), 1 sala por URL
 * - Tablero gridW x gridH
 * - Muros: 0 vacío, 1 rompible, 2 indestructible
 * - Tanques:
 *    - body: (x,y) en casillas
 *    - orientation: "H"|"V" (eje permitido para moverse)
 *    - aim: (x,y) (mirilla libre; bombas vuelan y no se bloquean)
 * - Turnos simultáneos:
 *    Cada turno, cada jugador envía UNA acción:
 *      { type:"MOVE", steps:0|1|2 }              (se mueve en su eje actual)
 *      { type:"TURN" }                           (cambia H<->V)
 *      { type:"AIM", dx:-2..2, dy:-2..2 }        (mueve mirilla)
 *      { type:"FIRE" }                           (dispara a la mirilla)
 *      { type:"WAIT" }                           (no hace nada)
 * - Disparo: explota en cruz "+" (centro + N/S/E/W)
 *      - Destruye muros rompibles (1 -> 0)
 *      - Mata tanques en esas casillas => respawn
 */

const GRID_W = 12;
const GRID_H = 12;

const rooms = new Map();

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function inBounds(x, y) {
  return x >= 0 && x < GRID_W && y >= 0 && y < GRID_H;
}

function key(x, y) {
  return `${x},${y}`;
}

function deepCopyGrid(g) {
  return g.map(row => row.slice());
}

// ---- Generación de mapa (visual / editable) ----
// Leyenda:
//   # = muro indestructible (2)
//   * = muro rompible (1)
//   . = vacío (0)
//
// Reglas:
// - Debe haber exactamente GRID_H filas
// - Cada fila debe tener exactamente GRID_W caracteres
function makeBaseGrid() {
  const rows = [
    "############",
    "#...****...#",
    "#..........#",
    "#..#....#..#",
    "#*..*..*..*#",
    "#....##....#",
    "#....##....#",
    "#*..*..*..*#",
    "#..#....#..#",
    "#..........#",
    "#...****...#",
    "############",
  ];

  // Validación: si cambias GRID_W/H, te avisará en consola
  if (rows.length !== GRID_H) {
    throw new Error(`MAP: filas=${rows.length} pero GRID_H=${GRID_H}`);
  }
  for (let y = 0; y < rows.length; y++) {
    if (rows[y].length !== GRID_W) {
      throw new Error(`MAP: fila ${y} tiene ${rows[y].length} chars pero GRID_W=${GRID_W}`);
    }
  }

  const g = Array.from({ length: GRID_H }, () => Array(GRID_W).fill(0));

  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const ch = rows[y][x];
      if (ch === "#") g[y][x] = 2;
      else if (ch === "*") g[y][x] = 1;
      else g[y][x] = 0; // '.' o cualquier otro
    }
  }

  return g;
}

function sprinkleBreakables(grid, prob, x1 = 1, y1 = 1, x2 = 10, y2 = 10, forbidden = []) {
  // prob en [0..1]
  const p = Math.max(0, Math.min(1, Number(prob) || 0));

  // Para comparar rápido
  const forbid = new Set(forbidden.map(([x, y]) => `${x},${y}`));

  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      // Saltar casillas fuera del grid por seguridad
      if (!grid[y] || typeof grid[y][x] === "undefined") continue;

      // Saltar casillas prohibidas (spawns, etc.)
      if (forbid.has(`${x},${y}`)) continue;

      // Solo si está vacía
      if (grid[y][x] !== 0) continue;

      // Probabilidad de poner muro rompible (1)
      if (Math.random() < p) {
        grid[y][x] = 1;
      }
    }
  }
}

// ---- Estado de sala ----
function newRoom(roomId) {
  const grid = makeBaseGrid();

  const spawnA = { x: 1, y: 1 };
  const spawnB = { x: GRID_W - 2, y: GRID_H - 2 };

  // Relleno probabilístico de muros rompibles dentro del área 1..10 (ajusta prob a tu gusto)
  // OJO: aquí usamos (1,1) y (GRID_W-2, GRID_H-2) como spawns reales.
  sprinkleBreakables(
    grid,
    0.10,                 // <-- PROBABILIDAD (0..1). Cambia aquí
    1, 1, 10, 10,          // rectángulo a recorrer (x1,y1,x2,y2)
    [
      [spawnA.x, spawnA.y],
      [spawnB.x, spawnB.y]
    ]
  );

  return {
    roomId,
    players: { A: null, B: null },

    grid, // 0 vacío, 1 rompible, 2 indestructible

    tanks: {
      A: {
        body: { ...spawnA },
        spawn: { ...spawnA },
        orientation: "V", // eje vertical al inicio
        face: "D", // A mira hacia abajo al inicio
        aim: { x: spawnA.x, y: spawnA.y + 2 }
      },
      B: {
        body: { ...spawnB },
        spawn: { ...spawnB },
        orientation: "V",
        face: "U", // B mira hacia arriba al inicio
        aim: { x: spawnB.x, y: spawnB.y - 2 }
      }
    },

    turn: 1,
    pending: { A: null, B: null }, // acción pendiente por jugador

    // eventos del último turno para UI
    lastEvent: null,
    score: { A: 0, B: 0 }
  };
}

// ---- Roles ----
function assignRole(room, socketId) {
  if (!room.players.A) { room.players.A = socketId; return "A"; }
  if (!room.players.B) { room.players.B = socketId; return "B"; }
  return "SPECTATOR";
}

function releaseRole(room, socketId) {
  if (room.players.A === socketId) room.players.A = null;
  if (room.players.B === socketId) room.players.B = null;
}

// ---- Serialización ----
function sanitizeRoom(room, forRole) {
  function tankView(who) {
    const t = room.tanks[who];
    return {
      body: t.body,
      orientation: t.orientation,
      face: t.face,
      aim: (forRole === who || forRole === "SPECTATOR") ? t.aim : null
    };
  }

  return {
    roomId: room.roomId,
    occupied: { A: !!room.players.A, B: !!room.players.B },
    gridW: GRID_W,
    gridH: GRID_H,
    grid: room.grid,
    tanks: {
      A: tankView("A"),
      B: tankView("B")
    },
    turn: room.turn,
    pending: { A: !!room.pending.A, B: !!room.pending.B },
    lastEvent: room.lastEvent,
    score: room.score
  };
}

function broadcastRoom(room) {
  for (const [role, socketId] of Object.entries(room.players)) {
    if (!socketId) continue;
    io.to(socketId).emit("room_state", sanitizeRoom(room, role));
  }

  // Espectadores (sin mirillas)
  const spectators = io.sockets.adapter.rooms.get(room.roomId) || [];
  for (const sid of spectators) {
    if (sid !== room.players.A && sid !== room.players.B) {
      io.to(sid).emit("room_state", sanitizeRoom(room, "SPECTATOR"));
    }
  }
}

// ---- Acciones (validación) ----
function parseAction(payload) {
  const t = payload?.type;

  if (t === "MOVE") {
    const steps = Number(payload?.steps);
    if (!Number.isFinite(steps)) return null;
    if (![ -2, -1, 0, 1, 2 ].includes(steps)) return null;
    return { type: "MOVE", steps };
  }

  if (t === "TURN") return { type: "TURN" };

  if (t === "AIM") {
    const dx = Number(payload?.dx);
    const dy = Number(payload?.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    if (dx < -2 || dx > 2 || dy < -2 || dy > 2) return null;
    // permitir AIM (0,0) como "mantener" si lo desean
    return { type: "AIM", dx, dy };
  }

  if (t === "FIRE") return { type: "FIRE" };

  if (t === "WAIT") return { type: "WAIT" };

  return null;
}

// ---- Reglas de movimiento ----
function isBlocked(grid, x, y) {
  if (!inBounds(x, y)) return true;
  return grid[y][x] !== 0; // muros (1 o 2) bloquean el cuerpo del tanque
}

function rotateClockwise(face) {
  switch (face) {
    case "U": return "R";
    case "R": return "D";
    case "D": return "L";
    case "L": return "U";
    default: return "U";
  }
}

function faceToOrientation(face) {
  return (face === "U" || face === "D") ? "V" : "H";
}

function moveTank(room, who, steps) {
  const t = room.tanks[who];
  const absSteps = Math.abs(steps);
  const dir = Math.sign(steps); // -1,0,+1
  if (dir === 0 || absSteps === 0) return;

  // Vector según hacia dónde mira
  let fx = 0, fy = 0;
  switch (t.face) {
    case "U": fy = -1; break;
    case "D": fy =  1; break;
    case "L": fx = -1; break;
    case "R": fx =  1; break;
  }

  // Si steps es negativo, va marcha atrás
  const dx = fx * dir;
  const dy = fy * dir;

  let x = t.body.x;
  let y = t.body.y;

  for (let i = 0; i < absSteps; i++) {
    const nx = x + dx;
    const ny = y + dy;
    if (isBlocked(room.grid, nx, ny)) break;
    x = nx; y = ny;
  }

  t.body = { x, y };
}

function shiftAimByTankDelta(room, who, fromPos, toPos) {
  const dx = toPos.x - fromPos.x;
  const dy = toPos.y - fromPos.y;
  if (dx === 0 && dy === 0) return;

  const t = room.tanks[who];
  t.aim = {
    x: clamp(t.aim.x + dx, 0, GRID_W - 1),
    y: clamp(t.aim.y + dy, 0, GRID_H - 1)
  };
}

// ---- Explosión en cruz "+" ----
function crossCells(cx, cy) {
  const cells = [
    [cx, cy],
    [cx + 1, cy],
    [cx - 1, cy],
    [cx, cy + 1],
    [cx, cy - 1]
  ];
  return cells.filter(([x, y]) => inBounds(x, y));
}

function applyExplosion(room, cx, cy) {
  const cells = crossCells(cx, cy);

  // 1) Romper muros rompibles
  for (const [x, y] of cells) {
    if (room.grid[y][x] === 1) room.grid[y][x] = 0;
  }

  // 2) Matar tanques en la cruz
  const killed = [];
  for (const who of ["A", "B"]) {
    const t = room.tanks[who];
    if (cells.some(([x, y]) => x === t.body.x && y === t.body.y)) {
      killed.push(who);
    }
  }
  for (const who of killed) {
    respawn(room, who);
  }

  return { cells, killed };
}

function respawn(room, who) {
  const t = room.tanks[who];

  // 1) Lista de casillas vacías (sin muros) y sin tanque encima
  const empties = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (room.grid[y][x] !== 0) continue;

      // Evitar caer encima del otro tanque (o del propio si aún no fue movido por lógica)
      const occupied =
        (room.tanks.A.body.x === x && room.tanks.A.body.y === y) ||
        (room.tanks.B.body.x === x && room.tanks.B.body.y === y);

      if (!occupied) empties.push([x, y]);
    }
  }

  // 2) Si hay huecos, elige uno al azar (uniforme)
  if (empties.length > 0) {
    const [x, y] = empties[Math.floor(Math.random() * empties.length)];
    t.body = { x, y };

    // Ajustar mirilla dentro de límites (opcional)
    t.aim = {
      x: clamp(t.aim.x, 0, GRID_W - 1),
      y: clamp(t.aim.y, 0, GRID_H - 1)
    };
    return;
  }

  // 3) Caso extremo: no hay casillas vacías (no debería pasar salvo mapas absurdos)
  t.body = { ...t.spawn };
}

// ---- Resolución de turno (simultáneo) ----
function resolveTurn(room) {
  const aAct = room.pending.A;
  const bAct = room.pending.B;
  if (!aAct || !bAct) return;

  room.lastEvent = { turn: room.turn, explosions: [] };

  // Copias del estado previo para referencias si las necesitas después
  const prev = {
    grid: deepCopyGrid(room.grid),
    tanks: {
      A: { body: { ...room.tanks.A.body }, orientation: room.tanks.A.orientation, aim: { ...room.tanks.A.aim } },
      B: { body: { ...room.tanks.B.body }, orientation: room.tanks.B.orientation, aim: { ...room.tanks.B.aim } }
    }
  };

  // 1) TURN (orientaciones + dirección)
  for (const who of ["A", "B"]) {
    const act = room.pending[who];
    if (act.type === "TURN") {
      const t = room.tanks[who];
      t.face = rotateClockwise(t.face);
      t.orientation = faceToOrientation(t.face);
    }
  }

  // 2) MOVE (posiciones) + “la mirilla se mueve con el tanque”
  // Primero calculamos movimientos tentativos SIN aplicarlos definitivamente
  const fromPos = {
    A: { ...room.tanks.A.body },
    B: { ...room.tanks.B.body }
  };

  const nextPos = {
    A: { ...room.tanks.A.body },
    B: { ...room.tanks.B.body }
  };

  for (const who of ["A", "B"]) {
    const act = room.pending[who];
    if (act.type === "MOVE") {
      const before = { ...room.tanks[who].body };
      moveTank(room, who, act.steps);
      nextPos[who] = { ...room.tanks[who].body };
      room.tanks[who].body = before; // revertimos, aplicaremos luego
    }
  }

  // Resolver colisión tanque-tanque: si acaban en la misma casilla o swap => ambos se quedan donde estaban
  const aFrom = fromPos.A;
  const bFrom = fromPos.B;
  const aTo = nextPos.A;
  const bTo = nextPos.B;

  const same = (aTo.x === bTo.x && aTo.y === bTo.y);
  const swap = (aTo.x === bFrom.x && aTo.y === bFrom.y && bTo.x === aFrom.x && bTo.y === aFrom.y);

  if (!same && !swap) {
    // Aplicar posiciones finales
    room.tanks.A.body = aTo;
    room.tanks.B.body = bTo;

    // Mover mirillas con el delta real del tanque (solo si el tanque se movió)
    shiftAimByTankDelta(room, "A", aFrom, aTo);
    shiftAimByTankDelta(room, "B", bFrom, bTo);
  } else {
    // Rebote: nadie se mueve => mirillas NO se mueven
    room.tanks.A.body = aFrom;
    room.tanks.B.body = bFrom;
    room.lastEvent.moveBounce = true;
  }

  // 3) AIM (mirillas)
  for (const who of ["A", "B"]) {
    const act = room.pending[who];
    if (act.type === "AIM") {
      const t = room.tanks[who];
      const nx = clamp(t.aim.x + act.dx, 0, GRID_W - 1);
      const ny = clamp(t.aim.y + act.dy, 0, GRID_H - 1);
      t.aim = { x: nx, y: ny };
    }
  }

  // 4) FIRE (explosiones)
  // Regla: ambos disparos se aplican (si los dos disparan, pueden matarse ambos).
  const fires = [];
  for (const who of ["A", "B"]) {
    const act = room.pending[who];
    if (act.type === "FIRE") {
      const t = room.tanks[who];
      fires.push({ who, x: t.aim.x, y: t.aim.y });
    }
  }

  for (const f of fires) {
    const res = applyExplosion(room, f.x, f.y);

    // Puntuación: 1 punto por cada KO al rival (no puntúa el suicidio)
    for (const victim of (res.killed || [])) {
      if (victim !== f.who) {
        room.score[f.who] = (room.score[f.who] || 0) + 1;
      }
    }

    room.lastEvent.explosions.push({ by: f.who, at: { x: f.x, y: f.y }, ...res });
  }

  // 5) limpiar pendings y avanzar turno
  room.pending.A = null;
  room.pending.B = null;
  room.turn += 1;

  broadcastRoom(room);
}

// ---- Socket.IO ----
io.on("connection", (socket) => {
  socket.on("join_room", ({ roomId }) => {
    if (!roomId || typeof roomId !== "string") return;

    if (!rooms.has(roomId)) rooms.set(roomId, newRoom(roomId));
    const room = rooms.get(roomId);

    socket.join(roomId);

    const role = assignRole(room, socket.id);
    socket.data.roomId = roomId;
    socket.data.role = role;

    socket.emit("your_role", { role, roomId });
    broadcastRoom(room);
  });

  socket.on("submit_action", (payload) => {
    const roomId = socket.data.roomId;
    const role = socket.data.role;
    if (!roomId || !role) return;

    const room = rooms.get(roomId);
    if (!room) return;
    if (role !== "A" && role !== "B") return;

    // Solo 1 acción por turno
    if (room.pending[role]) return;

    const act = parseAction(payload);
    if (!act) return;

    room.pending[role] = act;
    broadcastRoom(room);
    resolveTurn(room);
  });

  socket.on("reset_game", () => {
    const roomId = socket.data.roomId;
    const role = socket.data.role;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // Solo jugadores A/B pueden resetear
    if (role !== "A" && role !== "B") return;

    // Mantener ocupación
    const fresh = newRoom(roomId);
    fresh.players = { ...room.players };
    rooms.set(roomId, fresh);
    broadcastRoom(fresh);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    releaseRole(room, socket.id);

    // limpiar sala si queda vacía
    const empty = !room.players.A && !room.players.B;
    if (empty) rooms.delete(roomId);
    else broadcastRoom(room);
  });
});

server.listen(PORT, () => {
  console.log(`tankes server en http://localhost:${PORT}`);
});
