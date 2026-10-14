class CyberAudio {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  playHack() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
      1760,
      this.ctx.currentTime + 0.08,
    );

    gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.08);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.08);
  }

  playConflict() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(120, this.ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(60, this.ctx.currentTime + 0.25);

    gain.gain.setValueAtTime(0.3, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.01, this.ctx.currentTime + 0.25);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 0.25);
  }

  playVictory() {
    if (!this.ctx) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      setTimeout(() => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(
          0.01,
          this.ctx.currentTime + 0.4,
        );
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + 0.4);
      }, i * 120);
    });
  }
}

export class NetworkManager {
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.audio = new CyberAudio();

    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectTimeout = null;
    this.isExplicitlyClosed = false;

    this.playerData = this.loadCachedPlayer();
  }

  loadCachedPlayer() {
    try {
      const data = localStorage.getItem("cyber_player");
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  savePlayer(player) {
    this.playerData = player;
    localStorage.setItem("cyber_player", JSON.stringify(player));
  }

  connect() {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.audio.init();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}`;

    this.handlers.onStatusChange(
      "reconnecting",
      `CONNECTING (${this.reconnectAttempts + 1})...`,
    );

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.handlers.onStatusChange("online", "SYS_ONLINE");

      if (this.playerData && this.playerData.id) {
        this.send("JOIN", this.playerData);
        this.send("RESYNC", {});
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (err) {
        console.error("Failed to parse WebSocket message:", err);
      }
    };

    this.ws.onclose = () => {
      if (this.isExplicitlyClosed) return;
      this.handlers.onStatusChange("offline", "SYS_OFFLINE");
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.warn("WebSocket error encountered:", err);
      this.ws.close();
    };
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.handlers.onStatusChange("offline", "LINK_DEAD (MAX RETRIES)");
      return;
    }

    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
    this.reconnectAttempts++;

    this.handlers.onStatusChange(
      "reconnecting",
      `RECONNECT IN ${Math.round(delay / 1000)}s...`,
    );

    clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  send(type, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
      return true;
    }
    return false;
  }

  handleMessage({ type, payload }) {
    switch (type) {
      case "INIT_STATE":
      case "STATE_RESYNC":
        this.handlers.onWorldSync(payload);
        break;

      case "NODE_UPDATED":
        this.audio.playHack();
        this.handlers.onNodeUpdated(payload);
        break;

      case "ACTION_REJECTED":
        this.audio.playConflict();
        this.handlers.onActionRejected(payload);
        break;

      case "ENERGY_SYNC":
        this.handlers.onEnergySync(payload);
        break;

      case "LEADERBOARD_UPDATED":
        this.handlers.onLeaderboardUpdated(payload.leaderboard);
        break;

      case "PLAYER_JOINED":
        this.handlers.onLog(`Runner connected: ${payload.name}`, "system");
        break;

      case "PLAYER_LEFT":
        this.handlers.onLog(`Runner signal lost: ${payload.name}`, "system");
        break;

      case "GAME_OVER":
        this.audio.playVictory();
        this.handlers.onGameOver(payload.winner);
        break;

      case "ROUND_RESTART":
        this.handlers.onRoundRestart(payload);
        break;

      case "AUTH_ERROR":
        this.handlers.onAuthError(payload.message);
        break;

      case "WORLD_NODES_UPDATED":
        this.handlers.onWorldNodesUpdated(payload.nodes);
        break;

      case "ROOM_INFO":
        if (this.handlers.onRoomInfo) {
          this.handlers.onRoomInfo(payload);
        }
        break;
    }
  }

  sendNodeAction(nodeId, clientVersion) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send("ACTION_NODE", { nodeId, clientVersion, actionType: "HACK" });
    } else {
      this.handlers.onLog(
        "Action blocked: Terminal is OFFLINE. Awaiting sync...",
        "warn",
      );
    }
  }
}
