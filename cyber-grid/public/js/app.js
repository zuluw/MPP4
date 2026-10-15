import { NetworkCanvas } from "./canvas.js";
import { NetworkManager } from "./socket.js";

const loginModal = document.getElementById("loginModal");
const loginForm = document.getElementById("loginForm");
const runnerNameInput = document.getElementById("runnerName");
const gameContainer = document.getElementById("gameContainer");

const connectionBadge = document.getElementById("connectionBadge");
const connectionStatusText = document.getElementById("connectionStatusText");
const energyValueText = document.getElementById("energyValueText");
const energyBarFill = document.getElementById("energyBarFill");

const gridCanvas = document.getElementById("gridCanvas");
const glitchOverlay = document.getElementById("glitchFlashOverlay");
const leaderboardList = document.getElementById("leaderboardList");
const systemLogs = document.getElementById("systemLogs");

const victoryModal = document.getElementById("victoryModal");
const winnerBadge = document.getElementById("winnerBadge");
const countdownSec = document.getElementById("countdownSec");

const myRunnerName = document.getElementById("myRunnerName");
const myColorDot = document.getElementById("myColorDot");
const myColorName = document.getElementById("myColorName");

const spectatorQueueList = document.getElementById("spectatorQueueList");

let myPlayerId = null;
let canvasEngine = null;
let currentEnergy = 100;
let maxEnergy = 100;
let energyInterpolationTimer = null;
let network = null;

let currentActionMode = "ATTACK";

function initApp() {
  network = new NetworkManager({
    onStatusChange: handleStatusChange,
    onWorldSync: handleWorldSync,
    onWorldNodesUpdated: (nodes) => {
      if (canvasEngine) canvasEngine.setState(nodes, canvasEngine.links);
    },
    onNodeUpdated: handleNodeUpdated,
    onActionRejected: handleActionRejected,
    onEnergySync: handleEnergySync,
    onLeaderboardUpdated: handleLeaderboardUpdated,
    onGameOver: handleGameOver,
    onRoundRestart: handleRoundRestart,
    onAuthError: handleAuthError,
    onRoomInfo: handleRoomInfo,
    onLog: addLogEntry,
  });

  network.connect();

  canvasEngine = new NetworkCanvas(gridCanvas, (nodeId, clientVersion) => {
    if (network.ws && network.ws.readyState === WebSocket.OPEN) {
      network.send("ACTION_NODE", {
        nodeId,
        clientVersion,
        actionType: currentActionMode,
      });
    } else {
      addLogEntry(
        "Action blocked: Terminal is OFFLINE. Awaiting sync...",
        "warn",
      );
    }
  });

  const modeButtons = document.querySelectorAll(".mode-btn");
  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      modeButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentActionMode = btn.dataset.mode;
      addLogEntry(
        `Tactical protocol switched to: [${currentActionMode}]`,
        "system",
      );
    });
  });

  const cached = network.playerData;
  if (cached && cached.name && cached.id) {
    loginModal.classList.add('hidden');
    gameContainer.classList.remove('hidden');

    network.connect();
    network.send('JOIN', cached);

    startEnergyClientRegen();
    addLogEntry('Session restored seamlessly after page refresh.', 'system');
  } else {
    network.connect();
  }

  const connectBtn = document.getElementById("connectBtn");
  connectBtn.addEventListener("click", () => {
    const name = runnerNameInput.value.trim();
    const colorInput = document.querySelector(
      'input[name="factionColor"]:checked',
    );
    const color = colorInput ? colorInput.value : "#00ffcc";

    if (!name) {
      alert("Please, enter username!");
      return;
    }

    const playerId = "user_" + name.toLowerCase();
    const player = { id: playerId, name, color };

    network.savePlayer(player);

    loginModal.classList.add("hidden");
    gameContainer.classList.remove("hidden");

    network.send("JOIN", player);

    startEnergyClientRegen();
  });

  loginForm.addEventListener("submit", (e) => e.preventDefault());
}

function handleStatusChange(status, text) {
  connectionBadge.className = `status-badge ${status}`;
  connectionStatusText.textContent = text;
}

function handleWorldSync(payload) {
  if (payload.yourId) myPlayerId = payload.yourId;
  if (payload.yourName && myRunnerName)
    myRunnerName.textContent = payload.yourName;
  if (payload.assignedColor) {
    if (network.playerData) network.playerData.color = payload.assignedColor;
    if (myColorDot)
      myColorDot.style.setProperty("--my-color", payload.assignedColor);
    if (myColorName) {
      myColorName.textContent = payload.assignedColor;
      myColorName.style.color = payload.assignedColor;
    }
  }

  if (payload.yourMaxEnergy) {
    maxEnergy = payload.yourMaxEnergy;
  }

  canvasEngine.setState(payload.nodes, payload.links);
  handleLeaderboardUpdated(payload.players || []);
  handleEnergySync(payload.yourEnergy);
  addLogEntry("Grid state synchronized with PostgreSQL cluster.", "system");
}

function handleNodeUpdated(payload) {
  canvasEngine.updateNode(payload.node);
  const lvlInfo = payload.node.level > 1 ? ` [Lv.${payload.node.level}]` : "";
  addLogEntry(
    `Node #${payload.node.id}${lvlInfo} modified by ${payload.updatedBy} (v${payload.node.version})`,
    "success",
  );
}

function handleActionRejected(payload) {
  glitchOverlay.classList.remove("active");
  void glitchOverlay.offsetWidth;
  glitchOverlay.classList.add("active");

  if (payload.currentEnergy !== null && payload.currentEnergy !== undefined) {
    handleEnergySync({
      energy: payload.currentEnergy,
      maxEnergy: payload.maxEnergy,
    });
  }

  if (
    payload.reason === "CONFLICT_STALE_VERSION" ||
    payload.reason === "CONFLICT_RACE_CONDITION"
  ) {
    addLogEntry(
      `RACE CONDITION: Node #${payload.nodeId} state collided! Action rolled back.`,
      "conflict",
    );
    if (payload.currentNode) canvasEngine.updateNode(payload.currentNode);
  } else if (payload.reason === "NOT_ENOUGH_ENERGY") {
    addLogEntry("Action aborted: Insufficient CPU power pool.", "warn");
  } else if (payload.reason === "RATE_LIMITED") {
    addLogEntry(
      "Action throttled: Autoclick rate limit active (150ms).",
      "warn",
    );
  } else if (payload.reason === "NOT_CONNECTED") {
    addLogEntry(
      "Target unreachable: You must link adjacent nodes first!",
      "warn",
    );
  } else if (payload.reason === "NOT_YOUR_NODE") {
    addLogEntry(
      "Action blocked: You can only repair or upgrade your own nodes!",
      "warn",
    );
  } else if (payload.reason === "MAX_LEVEL_REACHED") {
    addLogEntry("Node is already at maximum fortress level (Lv.3)!", "warn");
  } else if (payload.reason === "CANNOT_ATTACK_OWN_NODE") {
    addLogEntry(
      "Action aborted: Friendly fire blocked! Switch to REPAIR or UPGRADE.",
      "warn",
    );
  } else if (payload.reason === "ALREADY_FULL_HP") {
    addLogEntry(
      "Repair canceled: Node integrity is already at 100%.",
      "system",
    );
  }
}

function handleEnergySync(data) {
  if (typeof data === "number") {
    currentEnergy = data;
  } else if (data && typeof data.energy === "number") {
    currentEnergy = data.energy;
    if (data.maxEnergy) maxEnergy = data.maxEnergy;
  }
  updateEnergyUI();
}

function updateEnergyUI() {
  const pct = Math.max(0, Math.min(100, (currentEnergy / maxEnergy) * 100));
  energyBarFill.style.width = `${pct}%`;
  energyValueText.textContent = `${Math.floor(currentEnergy)} / ${maxEnergy}`;
}

function startEnergyClientRegen() {
  if (energyInterpolationTimer) clearInterval(energyInterpolationTimer);
  energyInterpolationTimer = setInterval(() => {
    if (currentEnergy < maxEnergy) {
      currentEnergy = Math.min(maxEnergy, currentEnergy + 1.0);
      updateEnergyUI();
    }
  }, 100);
}

function handleLeaderboardUpdated(leaderboard) {
  leaderboardList.innerHTML = "";
  leaderboard.forEach((player, index) => {
    const isMe = player.id === myPlayerId;
    const li = document.createElement("li");
    li.className = `leaderboard-item ${player.isOnline ? "is-online" : "is-offline"} ${isMe ? "is-me" : ""}`;
    li.style.setProperty("--player-color", player.color);

    const statusBadge = player.isOnline
      ? '<span style="color: #39ff14; font-size: 0.65rem; font-weight: 800;">[ON]</span>'
      : '<span style="color: #64748b; font-size: 0.65rem;">[OFF]</span>';

    const youTag = isMe
      ? '<span style="color: var(--neon-cyan); font-weight: 800;"> (YOU)</span>'
      : "";

    li.innerHTML = `
      <div class="player-tag" style="${player.isOnline ? "" : "opacity: 0.5;"}">
        <span class="tag-dot" style="${player.isOnline ? "" : "box-shadow: none; filter: grayscale(1);"}"></span>
        <span>#${index + 1} ${player.name}${youTag}</span>
        ${statusBadge}
      </div>
      <span class="score-val" style="${player.isOnline ? "" : "opacity: 0.5;"}">${player.score} pts</span>
    `;
    leaderboardList.appendChild(li);
  });
}

function addLogEntry(text, type = "system") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const time = new Date().toTimeString().split(" ")[0];
  entry.textContent = `[${time}] ${text}`;

  systemLogs.appendChild(entry);
  systemLogs.scrollTop = systemLogs.scrollHeight;

  while (systemLogs.children.length > 60) {
    systemLogs.removeChild(systemLogs.firstChild);
  }
}

function handleGameOver(winner) {
  winnerBadge.innerHTML = `
    <h3 style="color: ${winner.color}; text-shadow: 0 0 15px ${winner.color}; font-size: 1.5rem; margin: 12px 0;">
      🏆 ${winner.name} (${winner.score} PTS)
    </h3>
  `;
  victoryModal.classList.remove("hidden");

  let sec = 7;
  countdownSec.textContent = sec;
  const timer = setInterval(() => {
    sec--;
    countdownSec.textContent = sec;
    if (sec <= 0) {
      clearInterval(timer);
      victoryModal.classList.add("hidden");
    }
  }, 1000);
}

function handleRoundRestart(worldState) {
  currentEnergy = 100;
  maxEnergy = 115;
  updateEnergyUI();

  handleWorldSync(worldState);
  addLogEntry(
    "Grid rebooted! Bases assigned to 4 active runners. Fight!",
    "system",
  );
}

function handleAuthError(message) {
  alert(`[SYSTEM] ${message}`);
  loginModal.classList.remove("hidden");
  gameContainer.classList.add("hidden");
}

function handleRoomInfo(data) {
  const occupiedColors = data.occupiedColors || [];
  const queue = data.queue || [];

  const colorChoices = document.querySelectorAll(".color-choice");
  colorChoices.forEach((choice) => {
    const radio = choice.querySelector("input");
    if (radio) {
      if (occupiedColors.includes(radio.value)) {
        choice.classList.add("disabled");
        radio.disabled = true;
        if (radio.checked) {
          const firstFree = document.querySelector(
            ".color-choice:not(.disabled) input",
          );
          if (firstFree) firstFree.checked = true;
        }
      } else {
        choice.classList.remove("disabled");
        radio.disabled = false;
      }
    }
  });

  if (spectatorQueueList) {
    spectatorQueueList.innerHTML = "";
    if (queue.length === 0) {
      spectatorQueueList.innerHTML =
        '<li class="queue-empty">[ NO SPECTATORS IN QUEUE ]</li>';
    } else {
      queue.forEach((name, idx) => {
        const li = document.createElement("li");
        li.className = "spectator-item";
        li.textContent = `#${idx + 1} ${name} (Waiting for slot)`;
        spectatorQueueList.appendChild(li);
      });
    }
  }
}

window.addEventListener("DOMContentLoaded", initApp);
