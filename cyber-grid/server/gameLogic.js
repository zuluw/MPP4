import { query } from "./db/db.js";
import { logger } from "./logger.js";

const playerEnergyState = new Map();

const BASE_MAX_ENERGY = 100;
const BONUS_MAX_ENERGY_PER_NODE = 15;
const BASE_REGEN_PER_SEC = 10;
const BONUS_REGEN_PER_NODE = 1.0;

const ACTION_COOLDOWN_MS = 150;
const COST_ATTACK = 20;
const COST_REPAIR = 15;
const COST_UPGRADE = 35;

export function getPlayerEnergyData(playerId, ownedNodesCount = 0) {
  const now = Date.now();
  const maxEnergy =
    BASE_MAX_ENERGY + ownedNodesCount * BONUS_MAX_ENERGY_PER_NODE;
  const regenRate = BASE_REGEN_PER_SEC + ownedNodesCount * BONUS_REGEN_PER_NODE;

  if (!playerEnergyState.has(playerId)) {
    playerEnergyState.set(playerId, {
      energy: maxEnergy,
      lastActionTimestamp: 0,
      lastTick: now,
    });
    return { energy: maxEnergy, maxEnergy };
  }

  const state = playerEnergyState.get(playerId);
  const elapsedSeconds = (now - state.lastTick) / 1000;

  state.energy = Math.min(
    maxEnergy,
    Math.max(0, state.energy + elapsedSeconds * regenRate),
  );
  state.lastTick = now;
  return { energy: Math.floor(state.energy), maxEnergy };
}

export async function ensureInitialWorld() {
  const check = await query("SELECT COUNT(*) FROM nodes");
  if (parseInt(check.rows[0].count, 10) > 0) {
    logger.info("Existing network topology loaded from database");
    return;
  }

  logger.info("Generating new Cyber Grid topology in PostgreSQL...");

  const initialNodes = [
    { id: 0, type: "core", x: 500, y: 300, hp: 300, max_hp: 300, level: 2 },
    { id: 1, type: "firewall", x: 380, y: 220, hp: 150, max_hp: 150, level: 1 },
    { id: 2, type: "firewall", x: 620, y: 220, hp: 150, max_hp: 150, level: 1 },
    { id: 3, type: "firewall", x: 620, y: 380, hp: 150, max_hp: 150, level: 1 },
    { id: 4, type: "firewall", x: 380, y: 380, hp: 150, max_hp: 150, level: 1 },
    { id: 5, type: "router", x: 220, y: 150, hp: 100, max_hp: 100, level: 1 },
    { id: 6, type: "router", x: 500, y: 120, hp: 100, max_hp: 100, level: 1 },
    { id: 7, type: "router", x: 780, y: 150, hp: 100, max_hp: 100, level: 1 },
    { id: 8, type: "router", x: 820, y: 300, hp: 100, max_hp: 100, level: 1 },
    { id: 9, type: "router", x: 780, y: 450, hp: 100, max_hp: 100, level: 1 },
    { id: 10, type: "router", x: 500, y: 480, hp: 100, max_hp: 100, level: 1 },
    { id: 11, type: "router", x: 220, y: 450, hp: 100, max_hp: 100, level: 1 },
    { id: 12, type: "router", x: 180, y: 300, hp: 100, max_hp: 100, level: 1 },
    { id: 13, type: "hq", x: 80, y: 80, hp: 200, max_hp: 200, level: 1 },
    { id: 14, type: "hq", x: 920, y: 80, hp: 200, max_hp: 200, level: 1 },
    { id: 15, type: "hq", x: 920, y: 520, hp: 200, max_hp: 200, level: 1 },
    { id: 16, type: "hq", x: 80, y: 520, hp: 200, max_hp: 200, level: 1 },
  ];

  for (const node of initialNodes) {
    await query(
      `INSERT INTO nodes (id, type, x, y, hp, max_hp, level, version) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
      [node.id, node.type, node.x, node.y, node.hp, node.max_hp, node.level],
    );
  }

  const initialLinks = [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 1],
    [1, 5],
    [1, 6],
    [2, 6],
    [2, 7],
    [2, 8],
    [3, 8],
    [3, 9],
    [3, 10],
    [4, 10],
    [4, 11],
    [4, 12],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 8],
    [8, 9],
    [9, 10],
    [10, 11],
    [11, 12],
    [12, 5],
    [13, 5],
    [13, 12],
    [14, 7],
    [14, 8],
    [15, 9],
    [15, 10],
    [16, 11],
    [16, 12],
  ];

  for (const [from, to] of initialLinks) {
    await query(
      `INSERT INTO links (from_node, to_node) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [from, to],
    );
  }

  logger.info("Cyber Grid topology initialized with upgrade levels.");
}

export async function getFullWorldState() {
  const nodes = await query(`
    SELECT n.*, p.name as owner_name, p.color as owner_color 
    FROM nodes n
    LEFT JOIN players p ON n.owner_id = p.id
    ORDER BY n.id ASC
  `);
  const links = await query("SELECT from_node, to_node FROM links");
  const players = await query(
    "SELECT id, name, color, score FROM players ORDER BY score DESC",
  );

  return {
    nodes: nodes.rows,
    links: links.rows,
    players: players.rows,
  };
}

async function isNodeConnectedToPlayer(nodeId, playerId) {
  const playerNodes = await query(
    "SELECT COUNT(*) FROM nodes WHERE owner_id = $1",
    [playerId],
  );
  const hasNodes = parseInt(playerNodes.rows[0].count, 10) > 0;

  if (!hasNodes) return true;

  const adjRes = await query(
    `
    SELECT 1 FROM links l
    JOIN nodes n ON (n.id = l.from_node OR n.id = l.to_node)
    WHERE (l.from_node = $1 OR l.to_node = $1)
      AND n.id != $1
      AND n.owner_id = $2
    LIMIT 1
  `,
    [nodeId, playerId],
  );

  return adjRes.rows.length > 0;
}

export async function executeNodeAction({
  playerId,
  nodeId,
  clientVersion,
  actionType,
}) {
  const now = Date.now();
  let pState = playerEnergyState.get(playerId);
  if (!pState) {
    pState = { energy: BASE_MAX_ENERGY, lastActionTimestamp: 0, lastTick: now };
    playerEnergyState.set(playerId, pState);
  }

  if (now - pState.lastActionTimestamp < ACTION_COOLDOWN_MS) {
    return { success: false, reason: "RATE_LIMITED" };
  }

  const nodeRes = await query("SELECT * FROM nodes WHERE id = $1", [nodeId]);
  if (nodeRes.rows.length === 0) {
    return { success: false, reason: "NODE_NOT_FOUND" };
  }
  const node = nodeRes.rows[0];

  const countRes = await query(
    "SELECT COUNT(*) FROM nodes WHERE owner_id = $1",
    [playerId],
  );
  const ownedCount = parseInt(countRes.rows[0].count, 10);
  const { energy: currentEnergy, maxEnergy } = getPlayerEnergyData(
    playerId,
    ownedCount,
  );

  let energyCost = COST_ATTACK;
  const isMine = node.owner_id === playerId;

  if (actionType === "ATTACK" || actionType === "HACK") {
    if (isMine) {
      return { success: false, reason: "CANNOT_ATTACK_OWN_NODE" };
    }
    energyCost = COST_ATTACK;
  } else if (actionType === "REPAIR") {
    if (!isMine) return { success: false, reason: "NOT_YOUR_NODE" };

    if (node.hp >= node.max_hp) {
      return { success: false, reason: "ALREADY_FULL_HP" };
    }
    energyCost = COST_REPAIR;
  } else if (actionType === "UPGRADE") {
    if (!isMine) return { success: false, reason: "NOT_YOUR_NODE" };
    if (node.level >= 3) return { success: false, reason: "MAX_LEVEL_REACHED" };
    energyCost = COST_UPGRADE;
  }

  if (currentEnergy < energyCost) {
    logger.warn("Action rejected: Insufficient energy", {
      playerId,
      currentEnergy,
      required: energyCost,
    });
    return {
      success: false,
      reason: "NOT_ENOUGH_ENERGY",
      currentEnergy,
      maxEnergy,
    };
  }

  if (node.version !== clientVersion) {
    logger.warn("OCC Conflict: Stale version", {
      nodeId,
      dbVer: node.version,
      clientVer: clientVersion,
      playerId,
    });

    await query(
      `INSERT INTO system_logs (event_type, player_id, node_id, details)
       VALUES ('RACE_CONFLICT', $1, $2, $3)`,
      [
        playerId,
        nodeId,
        `Stale version conflict: DB ${node.version} != Client ${clientVersion}`,
      ],
    );

    const fullNode = await query(
      `
      SELECT n.*, p.name as owner_name, p.color as owner_color 
      FROM nodes n LEFT JOIN players p ON n.owner_id = p.id WHERE n.id = $1
    `,
      [nodeId],
    );

    return {
      success: false,
      reason: "CONFLICT_STALE_VERSION",
      currentNode: fullNode.rows[0],
      currentEnergy,
      maxEnergy,
    };
  }

  if (!isMine) {
    const isConnected = await isNodeConnectedToPlayer(nodeId, playerId);
    if (!isConnected) {
      return { success: false, reason: "NOT_CONNECTED" };
    }
  }

  let newOwner = node.owner_id;
  let newHp = node.hp;
  let newMaxHp = node.max_hp;
  let newLevel = node.level;
  let isEliminatedPlayer = null;

  if (actionType === "UPGRADE") {
    newLevel = node.level + 1;
    newMaxHp = newLevel === 2 ? 200 : 350;
    newHp = newMaxHp;
  } else if (actionType === "REPAIR" || (isMine && actionType !== "ATTACK")) {
    newHp = Math.min(node.max_hp, node.hp + 25);
  } else {
    let baseDamage = 45;

    if (node.level === 2) {
      baseDamage = Math.round(baseDamage * 0.75);
    } else if (node.level === 3) {
      baseDamage = Math.round(baseDamage * 0.5);
      pState.energy = Math.max(0, pState.energy - 5);
    }

    newHp = node.hp - baseDamage;

    if (newHp <= 0) {
      const previousOwner = node.owner_id;
      newOwner = playerId;
      newLevel = 1;
      newMaxHp = node.type === "core" ? 300 : node.type === "hq" ? 200 : 100;
      newHp = Math.floor(newMaxHp * 0.5);

      if (node.type === "hq" && previousOwner && previousOwner !== playerId) {
        isEliminatedPlayer = previousOwner;
        await query(
          "UPDATE nodes SET owner_id = NULL, level = 1, hp = max_hp, version = version + 1 WHERE owner_id = $1 AND id != $2",
          [previousOwner, nodeId],
        );
      }
    }
  }

  const updateRes = await query(
    `UPDATE nodes 
     SET owner_id = $1, hp = $2, max_hp = $3, level = $4, version = version + 1, updated_at = NOW()
     WHERE id = $5 AND version = $6
     RETURNING *`,
    [newOwner, newHp, newMaxHp, newLevel, nodeId, clientVersion],
  );

  if (updateRes.rowCount === 0) {
    return {
      success: false,
      reason: "CONFLICT_RACE_CONDITION",
      currentNode: (await query("SELECT * FROM nodes WHERE id = $1", [nodeId]))
        .rows[0],
    };
  }

  pState.energy = Math.max(0, currentEnergy - energyCost);
  pState.lastActionTimestamp = now;
  pState.lastTick = now;

  if (newOwner === playerId && node.owner_id && node.owner_id !== playerId) {
    const victimId = node.owner_id;

    await query('UPDATE players SET score = score + 10 WHERE id = $1', [playerId]);

    await query('UPDATE players SET score = GREATEST(0, score - 10) WHERE id = $1', [victimId]);
    
    logger.info('Score transfer on capture', { killer: playerId, victim: victimId, pts: 10 });
  } else if (newOwner === playerId && !node.owner_id) {
    await query('UPDATE players SET score = score + 10 WHERE id = $1', [playerId]);
  }

  const fullUpdatedNode = await query(
    `
    SELECT n.*, p.name as owner_name, p.color as owner_color 
    FROM nodes n 
    LEFT JOIN players p ON n.owner_id = p.id 
    WHERE n.id = $1
  `,
    [nodeId],
  );

  const updatedOwnedCount = (
    await query("SELECT COUNT(*) FROM nodes WHERE owner_id = $1", [playerId])
  ).rows[0].count;
  const updatedEnergyData = getPlayerEnergyData(
    playerId,
    parseInt(updatedOwnedCount, 10),
  );

  return {
    success: true,
    node: fullUpdatedNode.rows[0],
    remainingEnergy: updatedEnergyData.energy,
    maxEnergy: updatedEnergyData.maxEnergy,
    eliminatedPlayer: isEliminatedPlayer,
  };
}
