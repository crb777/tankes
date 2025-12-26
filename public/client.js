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

  // Controles por botones
  controlPanel: document.getElementById("controlPanel"),
  controlHint: document.getElementById("controlHint"),

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

// Para mostrar qué acción has elegido en este turno
let myLastAction = null;
let myLastActionTurn = null;

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
  canActNow = enabled;

  // Habilitar/deshabilitar botones del panel
  if (els.controlPanel) {
    const btns = els.controlPanel.querySelectorAll("button[data-action-type]");
    btns.forEach(b => (b.disabled = !enabled));
  }
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

// ===== UI helpers: acciones y pendientes =====
function describeAction(action) {
  if (!action || !action.type) return "—";

  if (action.type === "AIM") {
    const dx = action.dx;
    const dy = action.dy;
    return `Apuntar (dx=${dx}, dy=${dy})`;
  }
  if (action.type === "MOVE") {
    const s = action.steps;
    if (s === 0) return "Mover (0) — sin movimiento";
    return `Mover (${s > 0 ? "+" : ""}${s})`;
  }
  if (action.type === "TURN") return "Girar (90°)";
  if (action.type === "FIRE") return "Disparar";
  if (action.type === "WAIT") return "Esperar";

  return action.type;
}

function buildPendingText(state) {
  if (!state || !state.pending) return "Pendiente: —";

  const pA = !!state.pending.A;
  const pB = !!state.pending.B;

  // Si ya están las dos, el turno está a punto de resolverse
  if (pA && pB) return "Acciones recibidas: A y B. Resolviendo turno…";

  // Si no hay ninguna, es inicio de turno
  if (!pA && !pB) return "Esperando acciones: A y B.";

  // Falta una
  const missing = [];
  if (!pA) missing.push("A");
  if (!pB) missing.push("B");

  // Mensaje orientado al usuario si es jugador
  if (myRole === "A" || myRole === "B") {
    const meMissing = (myRole === "A" && !pA) || (myRole === "B" && !pB);
    if (meMissing) {
      return `Falta tu acción (${myRole}). Esperando también: ${missing.join(" y ")}.`;
    }
    return `Tu acción ya está enviada. Falta la acción de: ${missing.join(" y ")}.`;
  }

  // Espectador
  return `Falta la acción de: ${missing.join(" y ")}.`;
}

// ===== Envío de acciones =====
function sendAction(action) {
  if (!canActNow) return;

  // Guarda lo que has enviado para poder mostrarlo en UI
  myLastAction = action;
  myLastActionTurn = lastState ? lastState.turn : null;

  socket.emit("submit_action", action);
}

function parseActionFromButton(btn) {
  const t = btn.dataset.actionType;
  if (!t) return null;

  if (t === "AIM") {
    const dx = Number(btn.dataset.dx);
    const dy = Number(btn.dataset.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    return { type: "AIM", dx, dy };
  }

  if (t === "MOVE") {
    const steps = Number(btn.dataset.steps);
    if (!Number.isFinite(steps)) return null;
    return { type: "MOVE", steps };
  }

  if (t === "TURN") return { type: "TURN" };
  if (t === "FIRE") return { type: "FIRE" };
  if (t === "WAIT") return { type: "WAIT" };

  return null;
}

function bindButtonControls() {
  if (!els.controlPanel) return;

  els.controlPanel.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action-type]");
    if (!btn) return;

    // Si no eres jugador, no haces nada
    if (!(myRole === "A" || myRole === "B")) return;

    const action = parseActionFromButton(btn);
    if (!action) return;

    sendAction(action);
  });
}

// Acciones (MVP teclado):
// - Flechas: AIM (mueve mirilla 1)
// - Shift + flecha: AIM (mueve mirilla 2)
// - W/A/S/D: AIM (mueve mirilla 1) (alternativa)
// - Enter: FIRE
// - Space: TURN (girar)
// - Z/X/C/1/2: MOVE steps (-2..+2)
// - Backspace: WAIT


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
    setStatus("Listo. Usa los botones para elegir 1 acción por turno.");
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

  // Acciones pendientes (texto claro)
  if (els.pending) {
    els.pending.textContent = buildPendingText(state);
  }

  // Marcador
  if (els.score && state.score) {
    els.score.textContent = `A ${state.score.A} – ${state.score.B} B`;
  }

  renderBoard(state);

  const isPlayer = myRole === "A" || myRole === "B";
  const canMoveNow = isPlayer && !state.pending[myRole];
  setControlsEnabled(canMoveNow);

  // Estado: mostrar acción elegida y situación del turno
  if (!isPlayer) {
    // espectador
    setStatus("Observando partida.");
  } else {
    if (canMoveNow) {
      // Turno nuevo o aún no has enviado acción
      myLastAction = null;
      myLastActionTurn = null;
      setStatus("Tu turno: elige 1 acción.");
    } else {
      // Ya enviaste acción: indica cuál
      const sameTurn = (myLastActionTurn === state.turn);
      const actionText = sameTurn ? describeAction(myLastAction) : "—";
      setStatus(`Tu acción: ${actionText}. Esperando al otro jugador…`);
    }
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

// ===== Controles por botones =====
bindButtonControls();