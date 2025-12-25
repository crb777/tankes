/* global io */
const socket = io();

const els = {
  roomId: document.getElementById("roomId"),
  role: document.getElementById("role"),
  turn: document.getElementById("turn"),
  pending: document.getElementById("pending"),
  score: document.getElementById("score"),
  status: document.getElementById("status"),
  board: document.getElementById("board"),
  copyLinkBtn: document.getElementById("copyLinkBtn"),
  resetBtn: document.getElementById("resetBtn"),

  // Modal KO
  koModal: document.getElementById("koModal"),
  koText: document.getElementById("koText"),
  koContinueBtn: document.getElementById("koContinueBtn")
};

const KO_AUTO_CLOSE_MS = 3000;

// ===== Sala desde URL =====
function getRoomFromUrl() {
  const u = new URL(window.location.href);
  const q = u.searchParams.get("room");
  if (q) return q;

  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  u.searchParams.set("room", rand);
  history.replaceState(null, "", u.toString());
  return rand;
}

const roomId = getRoomFromUrl();
els.roomId.textContent = roomId;

// ===== Estado local =====
let lastState = null;
let myRole = "—";
let canActNow = false;

// Para evitar repetición (key repeat)
const pressed = new Set();

// ===== Explosión temporal =====
let flashCells = new Set();  // conjunto de "x,y"
let flashToken = 0;          // para invalidar timeouts antiguos
let lastFlashedEventTurn = null; // para no repetir animación del mismo lastEvent

// ===== Modal KO =====
let lastKoEventTurn = null;
let koAutoCloseToken = 0;

function showKoModal(text, autoCloseMs = 1200) {
  if (!els.koModal) return;

  els.koText.textContent = text;
  els.koModal.classList.remove("hidden");
  els.koModal.setAttribute("aria-hidden", "false");

  const myToken = ++koAutoCloseToken;
  if (autoCloseMs > 0) {
    setTimeout(() => {
      if (koAutoCloseToken !== myToken) return;
      hideKoModal();
    }, autoCloseMs);
  }
}

function hideKoModal() {
  if (!els.koModal) return;
  els.koModal.classList.add("hidden");
  els.koModal.setAttribute("aria-hidden", "true");
}

function buildKoMessage(evt) {
  const ex = evt?.explosions || [];
  const killed = new Set();

  for (const e of ex) {
    for (const v of (e.killed || [])) killed.add(v);
  }

  if (killed.size === 0) return null;

  const victims = Array.from(killed).sort().join(" y ");
  if (killed.size === 2) return `Doble KO: ${victims}.`;

  return `KO: ${victims}.`;
}


// ===== Helpers =====
function setStatus(text) {
  els.status.textContent = text;
}

function setControlsEnabled(enabled) {
  // MVP sin botones de acción; solo teclado.
  canActNow = enabled;
}

function renderBoard(state) {
  const { gridW, gridH, grid, tanks } = state;

  // Construcción en DOM (sencillo y suficiente para MVP)
  // Nota: se apoya en CSS .board con grid-template dinámico
  els.board.style.gridTemplateColumns = `repeat(${gridW}, 1fr)`;
  els.board.style.gridTemplateRows = `repeat(${gridH}, 1fr)`;

  els.board.innerHTML = "";

  // Para pintar mirillas (aim) encima de casillas:
  // (pueden ser null si el servidor oculta la mirilla del rival)
  const aimA = tanks.A.aim ? key(tanks.A.aim.x, tanks.A.aim.y) : null;
  const aimB = tanks.B.aim ? key(tanks.B.aim.x, tanks.B.aim.y) : null;

  // Para pintar tanques
  const bodyA = key(tanks.A.body.x, tanks.A.body.y);
  const bodyB = key(tanks.B.body.x, tanks.B.body.y);

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const cell = document.createElement("div");
      cell.className = "cell";

      const v = grid[y][x];
      if (v === 1) cell.classList.add("wall-break");
      if (v === 2) cell.classList.add("wall-solid");

      const k = key(x, y);

      // Explosión temporal (cruz)
      if (flashCells.has(k)) {
        cell.classList.add("explosion");
      }

      // Mirillas (prioridad baja)
      if (aimA && k === aimA) cell.classList.add("aim-a");
      if (aimB && k === aimB) cell.classList.add("aim-b");

      // Tanques (prioridad alta)
      if (k === bodyA) {
        const t = document.createElement("div");
        t.className = `tank tank-a face-${tanks.A.face}`;
        t.textContent = "A";
        cell.appendChild(t);
      }
      if (k === bodyB) {
        const t = document.createElement("div");
        t.className = `tank tank-b face-${tanks.B.face}`;
        t.textContent = "B";
        cell.appendChild(t);
      }

      els.board.appendChild(cell);
    }
  }
}

function key(x, y) {
  return `${x},${y}`;
}

function prettyLastEvent(evt) {
  if (!evt) return "";
  const ex = evt.explosions || [];
  if (!ex.length) return "";
  const pieces = ex.map(e => {
    const who = e.by;
    const at = `(${e.at.x},${e.at.y})`;
    const killed = (e.killed && e.killed.length) ? `; KO: ${e.killed.join(",")}` : "";
    return `${who} dispara a ${at}${killed}`;
  });
  return pieces.join(" · ");
}

// ===== Envío de acciones =====
function sendAction(action) {
  if (!canActNow) return;
  socket.emit("submit_action", action);
}

// Acciones (MVP teclado):
// - Flechas: AIM (mueve mirilla 1)
// - Shift + flecha: AIM (mueve mirilla 2)
// - W/A/S/D: AIM (mueve mirilla 1) (alternativa)
// - Enter: FIRE
// - Space: TURN (girar)
// - Z/X/C/1/2: MOVE steps (-2..+2)
// - Backspace: WAIT

function onKeyDown(e) {
  // Ignorar si escribes en inputs
  const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea") return;

  if (pressed.has(e.code)) return;
  pressed.add(e.code);

  if (!lastState) return;
  if (!(myRole === "A" || myRole === "B")) return;

  // Si ya envié acción este turno, no sigo
  if (!canActNow) return;

  const isShift = e.shiftKey;
  const stepAim = isShift ? 2 : 1;

  // ===== AIM con flechas =====
  if (e.code === "ArrowUp")    { sendAction({ type: "AIM", dx: 0, dy: -stepAim }); e.preventDefault(); return; }
  if (e.code === "ArrowDown")  { sendAction({ type: "AIM", dx: 0, dy:  stepAim }); e.preventDefault(); return; }
  if (e.code === "ArrowLeft")  { sendAction({ type: "AIM", dx: -stepAim, dy: 0 }); e.preventDefault(); return; }
  if (e.code === "ArrowRight") { sendAction({ type: "AIM", dx:  stepAim, dy: 0 }); e.preventDefault(); return; }

  // ===== AIM con WASD =====
  if (e.code === "KeyW") { sendAction({ type: "AIM", dx: 0, dy: -1 }); e.preventDefault(); return; }
  if (e.code === "KeyS") { sendAction({ type: "AIM", dx: 0, dy:  1 }); e.preventDefault(); return; }
  if (e.code === "KeyA") { sendAction({ type: "AIM", dx: -1, dy: 0 }); e.preventDefault(); return; }
  if (e.code === "KeyD") { sendAction({ type: "AIM", dx:  1, dy: 0 }); e.preventDefault(); return; }

  // ===== TURN =====
  if (e.code === "Space") { sendAction({ type: "TURN" }); e.preventDefault(); return; }

  // ===== FIRE =====
  if (e.code === "Enter") { sendAction({ type: "FIRE" }); e.preventDefault(); return; }

  // ===== MOVE (-2 .. +2) =====
  if (e.code === "KeyZ") { sendAction({ type: "MOVE", steps: -2 }); e.preventDefault(); return; }
  if (e.code === "KeyX") { sendAction({ type: "MOVE", steps: -1 }); e.preventDefault(); return; }
  if (e.code === "KeyC") { sendAction({ type: "MOVE", steps:  0 }); e.preventDefault(); return; }

  if (e.code === "Digit1" || e.code === "Numpad1") { sendAction({ type: "MOVE", steps: 1 }); e.preventDefault(); return; }
  if (e.code === "Digit2" || e.code === "Numpad2") { sendAction({ type: "MOVE", steps: 2 }); e.preventDefault(); return; }

  // ===== WAIT =====
  if (e.code === "Backspace") { sendAction({ type: "WAIT" }); e.preventDefault(); return; }
}

function onKeyUp(e) {
  pressed.delete(e.code);
}

// ===== Socket events =====
socket.on("connect", () => {
  setStatus("Conectado. Entrando en sala…");
  socket.emit("join_room", { roomId });
});

socket.on("your_role", ({ role }) => {
  myRole = role;
  els.role.textContent = role;

  if (role === "SPECTATOR") {
    setStatus("Sala llena: estás como espectador.");
  } else {
    setStatus("Listo. Controles: Flechas/WASD apuntar (Shift=2). Z/X/C/1/2 mover (-2..+2). Espacio girar. Enter disparar. Backspace esperar.");
  }
});

socket.on("room_state", (state) => {
  lastState = state;

  // ===== Explosión animada/temporal (solo una vez por turno resuelto) =====
  const evt = state.lastEvent || null;
  const ex = evt?.explosions || [];

  // Animar solo si:
  // - hay explosiones
  // - y es un lastEvent nuevo (turn distinto)
  if (ex.length && evt.turn !== lastFlashedEventTurn) {
    lastFlashedEventTurn = evt.turn;

    const s = new Set();
    for (const e of ex) {
      for (const [x, y] of (e.cells || [])) {
        s.add(`${x},${y}`);
      }
    }

    flashCells = s;

    const myToken = ++flashToken;
    setTimeout(() => {
      if (flashToken !== myToken) return;
      flashCells = new Set();
      if (lastState) renderBoard(lastState);
    }, 500);
  }

  // ===== Modal KO (si hubo muertes) =====
  if (evt && typeof evt.turn === "number" && evt.turn !== lastKoEventTurn) {
    const msg = buildKoMessage(evt);
    if (msg) {
      lastKoEventTurn = evt.turn;
      showKoModal(msg, KO_AUTO_CLOSE_MS); // 0 si lo quieres solo con botón
    }
  }

  // UI básica
  els.turn.textContent = state.turn;

  // (Recomendado) Ocultar pistas: no mostrar estado por jugador, solo genérico.
  // Si quieres mantenerlo, deja tu línea original.
  if (els.pending) {
    els.pending.textContent = state.pending && (state.pending.A || state.pending.B)
      ? "Pendiente: esperando acciones…"
      : "Pendiente: —";
  }

  // Marcador (si existe en el HTML)
  if (els.score && state.score) {
    els.score.textContent = `A ${state.score.A} – ${state.score.B} B`;
  }

  renderBoard(state);

  const isPlayer = myRole === "A" || myRole === "B";
  const canMoveNow = isPlayer && !state.pending[myRole];
  setControlsEnabled(canMoveNow);

  if (!isPlayer) {
    setStatus("Observando partida.");
  } else if (canMoveNow) {
    setStatus("Tu turno. Elige 1 acción.");
  } else {
    setStatus("Acción enviada. Esperando al otro jugador…");
  }
});

// ===== Botones UI =====
els.copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    els.copyLinkBtn.textContent = "Enlace copiado";
    setTimeout(() => (els.copyLinkBtn.textContent = "Copiar enlace"), 1200);
  } catch (e) {
    prompt("Copia este enlace:", window.location.href);
  }
});

els.resetBtn.addEventListener("click", () => {
  lastFlashedEventTurn = null;
  lastKoEventTurn = null;
  flashCells = new Set();
  koAutoCloseToken++;
  hideKoModal();
  socket.emit("reset_game");
});

// ===== Modal KO eventos =====
if (els.koContinueBtn) {
  els.koContinueBtn.addEventListener("click", () => {
    // invalida autocierre anterior y cierra
    koAutoCloseToken++;
    hideKoModal();
  });
}

// Cerrar si haces click fuera del cuadro
if (els.koModal) {
  els.koModal.addEventListener("click", (e) => {
    if (e.target === els.koModal) {
      koAutoCloseToken++;
      hideKoModal();
    }
  });
}

// ===== Eventos teclado =====
window.addEventListener("keydown", onKeyDown);
window.addEventListener("keyup", onKeyUp);
