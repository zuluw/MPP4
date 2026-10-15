import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

import { initDB, query } from "./db/db.js";
import {
  ensureInitialWorld,
  getFullWorldState,
  executeNodeAction,
  getPlayerEnergyData,
} from "./gameLogic.js";
import { logger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const PORT = process.env.PORT || 3000;
const WINNING_SCORE = 150;
const MAX_ACTIVE_RUNNERS = 4;

const FACTION_COLORS = ["#00ffcc", "#ff0055", "#39ff14", "#b026ff"];
const HQ_NODE_IDS = [13, 14, 15, 16];

const MIME_TYPES = {
  ".html": "text/html; charset=UTF-8",
  ".css": "text/css; charset=UTF-8",
  ".js": "application/javascript; charset=UTF-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const cleanUrl = req.url.split("?")[0];

  if (cleanUrl === "/api/reset-database-admin-secret") {
    (async () => {
      try {
        await query("TRUNCATE players, system_logs CASCADE;");
        await query(
          "UPDATE nodes SET owner_id = NULL, level = 1, hp = max_hp, version = 1;",
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=UTF-8" });
        res.end(
          '<h1 style="color: green; font-family: sans-serif;">Cleared</h1>',
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Error clearing DB: " + err.message);
      }
    })();
    return;
  }

  let reqPath = cleanUrl === "/" ? "/index.html" : cleanUrl;
  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Access Denied");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500, {
        "Content-Type": "text/plain",
      });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
});

const wss = new WebSocketServer({ server });
const clients = new Map();

function broadcast(payload, excludeWs = null) {
  const msg = JSON.stringify(payload);
  for (const [ws] of clients.entries()) {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function sendTo(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function getLeaderboardWithStatus() {
  const onlineIds = new Set(
    Array.from(clients.values())
      .map((c) => c.id)
      .filter(Boolean),
  );

  const res = await query(
    "SELECT id, name, color, score FROM players ORDER BY score DESC LIMIT 10",
  );
  return res.rows.map((p) => ({
    ...p,
    isOnline: onlineIds.has(p.id),
  }));
}

function getOccupiedColors() {
  return Array.from(clients.values())
    .filter((c) => c.id && c.isAlive && !c.isSpectator)
    .map((c) => c.color);
}

function getQueueList() {
  return Array.from(clients.values())
    .filter((c) => c.id && c.isSpectator)
    .map((c) => c.name);
}

async function restartRoundForActiveRunners() {
  logger.info("Restarting grid session for next round...");

  await query("UPDATE players SET score = 0");

  await query(`
    UPDATE nodes 
    SET owner_id = NULL, level = 1, 
        max_hp = CASE WHEN type = 'core' THEN 300 WHEN type = 'hq' THEN 200 WHEN type = 'firewall' THEN 150 ELSE 100 END,
        hp = CASE WHEN type = 'core' THEN 300 WHEN type = 'hq' THEN 200 WHEN type = 'firewall' THEN 150 ELSE 100 END,
        version = version + 1
  `);

  const activeClients = Array.from(clients.entries()).filter(
    ([_, c]) => c.id && c.isAlive,
  );
  const runnerSockets = activeClients.slice(0, MAX_ACTIVE_RUNNERS);
  const spectatorSockets = activeClients.slice(MAX_ACTIVE_RUNNERS);

  spectatorSockets.forEach(([_, c]) => {
    c.isSpectator = true;
    c.color = "#64748b";
  });

  for (let i = 0; i < runnerSockets.length; i++) {
    const [ws, c] = runnerSockets[i];
    c.isSpectator = false;
    c.color = FACTION_COLORS[i];
    const hqId = HQ_NODE_IDS[i];

    await query(
      "UPDATE nodes SET owner_id = $1, hp = 200, max_hp = 200, level = 1, version = version + 1 WHERE id = $2",
      [c.id, hqId],
    );
    await query("UPDATE players SET color = $1 WHERE id = $2", [c.color, c.id]);

    const resetEnergyData = getPlayerEnergyData(c.id, 1);
    sendTo(ws, {
      type: "ENERGY_SYNC",
      payload: { energy: 100, maxEnergy: resetEnergyData.maxEnergy },
    });
  }

  const freshWorld = await getFullWorldState();
  const freshLeaderboard = await getLeaderboardWithStatus();

  broadcast({
    type: "ROUND_RESTART",
    payload: {
      ...freshWorld,
      players: freshLeaderboard,
    },
  });

  broadcast({
    type: "ROOM_INFO",
    payload: { occupiedColors: getOccupiedColors(), queue: getQueueList() },
  });
}

wss.on("connection", (ws) => {
  clients.set(ws, { isAlive: true, id: null, isSpectator: false });

  sendTo(ws, {
    type: "ROOM_INFO",
    payload: { occupiedColors: getOccupiedColors(), queue: getQueueList() },
  });

  ws.on("pong", () => {
    const clientData = clients.get(ws);
    if (clientData) clientData.isAlive = true;
  });

  ws.on("message", async (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage);
      const { type, payload } = data;

      switch (type) {
        case "JOIN": {
          let { name, color } = payload;
          const cleanName = (name || "").trim();

          if (!cleanName) {
            sendTo(ws, {
              type: "AUTH_ERROR",
              payload: { message: "Имя не может быть пустым" },
            });
            break;
          }

          const playerId = "user_" + cleanName.toLowerCase();

          const existingEntry = Array.from(clients.entries()).find(
            ([clientWs, c]) => c.id === playerId && clientWs !== ws,
          );

          if (existingEntry) {
            const [oldWs, oldData] = existingEntry;
            logger.info(
              "Stale session detected on reload. Transferring session to new tab...",
              { name: cleanName },
            );

            if (oldData.color) color = oldData.color;

            clients.delete(oldWs);
            oldWs.terminate();
          }

          const activeRunners = Array.from(clients.values()).filter(
            (c) => c.id && !c.isSpectator,
          );
          const isSpectator = activeRunners.length >= MAX_ACTIVE_RUNNERS;

          let assignedColor = color;
          if (isSpectator) {
            assignedColor = "#64748b";
          } else {
            const occupied = getOccupiedColors();
            if (occupied.includes(color)) {
              assignedColor =
                FACTION_COLORS.find((c) => !occupied.includes(c)) || color;
            }
          }

          clients.set(ws, {
            isAlive: true,
            id: playerId,
            name: cleanName,
            color: assignedColor,
            isSpectator,
          });

          await query(
            `INSERT INTO players (id, name, color, last_seen) 
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (id) DO UPDATE 
             SET name = EXCLUDED.name, color = EXCLUDED.color, last_seen = NOW()`,
            [playerId, cleanName, assignedColor],
          );

          if (!isSpectator) {
            const hasNode = await query(
              "SELECT COUNT(*) FROM nodes WHERE owner_id = $1",
              [playerId],
            );
            if (parseInt(hasNode.rows[0].count, 10) === 0) {
              const freeHq = await query(`
                SELECT id FROM nodes 
                WHERE id IN (13, 14, 15, 16) AND owner_id IS NULL 
                ORDER BY id ASC LIMIT 1
              `);
              if (freeHq.rows.length > 0) {
                await query(
                  "UPDATE nodes SET owner_id = $1, hp = max_hp, level = 1, version = version + 1 WHERE id = $2",
                  [playerId, freeHq.rows[0].id],
                );
              }
            }
          }

          const ownedRes = await query(
            "SELECT COUNT(*) FROM nodes WHERE owner_id = $1",
            [playerId],
          );
          const energyData = getPlayerEnergyData(
            playerId,
            parseInt(ownedRes.rows[0].count, 10),
          );

          const worldState = await getFullWorldState();
          const leaderboard = await getLeaderboardWithStatus();

          sendTo(ws, {
            type: "INIT_STATE",
            payload: {
              ...worldState,
              players: leaderboard,
              yourId: playerId,
              yourName: cleanName,
              yourEnergy: energyData.energy,
              yourMaxEnergy: energyData.maxEnergy,
              assignedColor,
              isSpectator,
              winningScore: WINNING_SCORE,
            },
          });

          broadcast({ type: "LEADERBOARD_UPDATED", payload: { leaderboard } });
          broadcast({
            type: "ROOM_INFO",
            payload: {
              occupiedColors: getOccupiedColors(),
              queue: getQueueList(),
            },
          });

          const updatedWorld = await getFullWorldState();
          broadcast({
            type: "WORLD_NODES_UPDATED",
            payload: { nodes: updatedWorld.nodes },
          });

          broadcast(
            {
              type: "PLAYER_JOINED",
              payload: {
                id: playerId,
                name: cleanName,
                color: assignedColor,
                isSpectator,
              },
            },
            ws,
          );

          logger.info("Runner entered room", {
            playerId,
            isSpectator,
            color: assignedColor,
          });
          break;
        }

        case "ACTION_NODE": {
          const clientData = clients.get(ws);
          if (!clientData || !clientData.id || clientData.isSpectator) return;

          const { nodeId, clientVersion, actionType } = payload;
          const result = await executeNodeAction({
            playerId: clientData.id,
            nodeId,
            clientVersion,
            actionType: actionType || "ATTACK",
          });

          if (result.success) {
            broadcast({
              type: "NODE_UPDATED",
              payload: {
                node: result.node,
                updatedBy: clientData.name,
                updatedByColor: clientData.color,
              },
            });

            sendTo(ws, {
              type: "ENERGY_SYNC",
              payload: {
                energy: result.remainingEnergy,
                maxEnergy: result.maxEnergy,
              },
            });

            if (result.eliminatedPlayer) {
              const victimWs = Array.from(clients.entries()).find(
                ([_, c]) => c.id === result.eliminatedPlayer,
              );
              if (victimWs) {
                const [vWs, vData] = victimWs;
                vData.isSpectator = true;
                sendTo(vWs, {
                  type: "SYSTEM_ELIMINATED",
                  payload: {
                    message:
                      "Your HQ has fallen! You have been switched to spectator mode.",
                  },
                });
              }

              broadcast({
                type: "PLAYER_ELIMINATED",
                payload: {
                  victimId: result.eliminatedPlayer,
                  killerName: clientData.name,
                },
              });

              const freshWorld = await getFullWorldState();
              broadcast({
                type: "WORLD_NODES_UPDATED",
                payload: { nodes: freshWorld.nodes },
              });

              const remainingHqs = await query(
                "SELECT DISTINCT owner_id FROM nodes WHERE type = 'hq' AND owner_id IS NOT NULL",
              );
              if (remainingHqs.rows.length === 1) {
                const winnerId = remainingHqs.rows[0].owner_id;
                const winnerRes = await query(
                  "SELECT * FROM players WHERE id = $1",
                  [winnerId],
                );
                broadcast({
                  type: "GAME_OVER",
                  payload: { winner: winnerRes.rows[0] },
                });
              }
            }

            const leaderboard = await getLeaderboardWithStatus();
            broadcast({
              type: "LEADERBOARD_UPDATED",
              payload: { leaderboard },
            });
          } else {
            sendTo(ws, {
              type: "ACTION_REJECTED",
              payload: {
                reason: result.reason,
                nodeId,
                currentNode: result.currentNode || null,
                currentEnergy:
                  result.currentEnergy !== undefined
                    ? result.currentEnergy
                    : null,
                maxEnergy:
                  result.maxEnergy !== undefined ? result.maxEnergy : null,
              },
            });
          }
          break;
        }

        case "RESYNC": {
          const clientData = clients.get(ws);
          if (!clientData || !clientData.id) return;

          const ownedRes = await query(
            "SELECT COUNT(*) FROM nodes WHERE owner_id = $1",
            [clientData.id],
          );
          const energyData = getPlayerEnergyData(
            clientData.id,
            parseInt(ownedRes.rows[0].count, 10),
          );

          const worldState = await getFullWorldState();
          const leaderboard = await getLeaderboardWithStatus();

          sendTo(ws, {
            type: "STATE_RESYNC",
            payload: {
              ...worldState,
              players: leaderboard,
              yourEnergy: energyData.energy,
              yourMaxEnergy: energyData.maxEnergy,
            },
          });
          break;
        }
      }
    } catch (err) {
      logger.error("Error handling WebSocket message", { error: err.message });
    }
  });

  ws.on("close", async () => {
    const clientData = clients.get(ws);
    clients.delete(ws);

    if (clientData && clientData.id) {
      await query("UPDATE players SET last_seen = NOW() WHERE id = $1", [
        clientData.id,
      ]);

      if (!clientData.isSpectator) {
        const nextSpectator = Array.from(clients.entries()).find(
          ([_, c]) => c.id && c.isSpectator,
        );
        if (nextSpectator) {
          const [sWs, sData] = nextSpectator;
          sData.isSpectator = false;
          const freeColor =
            FACTION_COLORS.find((col) => !getOccupiedColors().includes(col)) ||
            "#00ffcc";
          sData.color = freeColor;
          await query("UPDATE players SET color = $1 WHERE id = $2", [
            freeColor,
            sData.id,
          ]);
          logger.info("Spectator promoted to active runner", {
            name: sData.name,
            color: freeColor,
          });
        }
      }

      const leaderboard = await getLeaderboardWithStatus();
      broadcast({ type: "LEADERBOARD_UPDATED", payload: { leaderboard } });
      broadcast({
        type: "ROOM_INFO",
        payload: { occupiedColors: getOccupiedColors(), queue: getQueueList() },
      });
      broadcast({ type: "PLAYER_LEFT", payload: { name: clientData.name } });
    }
  });
});

setInterval(() => {
  for (const [ws, data] of clients.entries()) {
    if (data.isAlive === false) {
      clients.delete(ws);
      ws.terminate();
      continue;
    }
    data.isAlive = false;
    ws.ping();
  }
}, 30000);

function startGameLoop() {
  setInterval(async () => {
    try {
      const coreRes = await query("SELECT owner_id FROM nodes WHERE id = 0");
      if (coreRes.rows.length > 0 && coreRes.rows[0].owner_id) {
        const coreOwnerId = coreRes.rows[0].owner_id;
        await query("UPDATE players SET score = score + 3 WHERE id = $1", [
          coreOwnerId,
        ]);

        const leaderboard = await getLeaderboardWithStatus();
        broadcast({ type: "LEADERBOARD_UPDATED", payload: { leaderboard } });

        const winner = leaderboard.find((p) => p.score >= WINNING_SCORE);
        if (winner) {
          broadcast({ type: "GAME_OVER", payload: { winner } });

          setTimeout(async () => {
            await restartRoundForActiveRunners();
          }, 7000);
        }
      }
    } catch (err) {
      logger.error("Game tick error", { error: err.message });
    }
  }, 1000);
}

async function startServer() {
  try {
    await initDB();
    await ensureInitialWorld();
    startGameLoop();

    server.listen(PORT, () => {
      logger.info(`Cyber-Grid Server running on http://localhost:${PORT}`);
      logger.info(`WebSockets listening on ws://localhost:${PORT}`);
    });
  } catch (err) {
    logger.error("Fatal startup error", { error: err.message });
    process.exit(1);
  }
}

startServer();
