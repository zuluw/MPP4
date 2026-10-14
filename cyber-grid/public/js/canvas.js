export class NetworkCanvas {
  constructor(canvasElement, onNodeClicked) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext("2d");
    this.onNodeClicked = onNodeClicked;

    this.width = 1000;
    this.height = 600;
    this.canvas.width = this.width;
    this.canvas.height = this.height;

    this.nodes = new Map();
    this.links = [];
    this.hoveredNodeId = null;

    this.packets = [];
    this.initDataPackets();

    this.setupEventListeners();

    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  setState(nodes, links) {
    this.nodes.clear();
    for (const node of nodes) {
      this.nodes.set(node.id, { ...node });
    }
    this.links = links;
  }

  updateNode(updatedNode) {
    if (this.nodes.has(updatedNode.id)) {
      const existing = this.nodes.get(updatedNode.id);
      this.nodes.set(updatedNode.id, { ...existing, ...updatedNode });
    }
  }

  initDataPackets() {
    this.packets = Array.from({ length: 16 }, () => ({
      linkIndex: 0,
      progress: Math.random(),
      speed: 0.003 + Math.random() * 0.005,
    }));
  }

  setupEventListeners() {
    const getCanvasCoords = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.width / rect.width;
      const scaleY = this.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
      };
    };

    this.canvas.addEventListener("mousemove", (e) => {
      const { x, y } = getCanvasCoords(e);
      let found = null;
      for (const node of this.nodes.values()) {
        const radius = this.getNodeRadius(node.type);
        const dist = Math.hypot(node.x - x, node.y - y);
        if (dist <= radius + 6) {
          found = node.id;
          break;
        }
      }
      this.hoveredNodeId = found;
      this.canvas.style.cursor = found !== null ? "pointer" : "crosshair";
    });

    this.canvas.addEventListener("click", (e) => {
      if (this.hoveredNodeId !== null && this.nodes.has(this.hoveredNodeId)) {
        const targetNode = this.nodes.get(this.hoveredNodeId);
        this.onNodeClicked(targetNode.id, targetNode.version);
      }
    });
  }

  getNodeRadius(type) {
    switch (type) {
      case "core":
        return 32;
      case "hq":
        return 26;
      case "firewall":
        return 22;
      default:
        return 18;
    }
  }

  animate() {
    this.ctx.clearRect(0, 0, this.width, this.height);

    this.drawBackgroundGrid();
    this.drawLinks();
    this.drawDataPackets();
    this.drawNodes();

    requestAnimationFrame(this.animate);
  }

  drawBackgroundGrid() {
    this.ctx.fillStyle = "rgba(0, 255, 204, 0.03)";
    for (let x = 20; x < this.width; x += 30) {
      for (let y = 20; y < this.height; y += 30) {
        this.ctx.fillRect(x, y, 2, 2);
      }
    }
  }

  drawLinks() {
    this.ctx.lineWidth = 1.5;
    for (const link of this.links) {
      const from = this.nodes.get(link.from_node);
      const to = this.nodes.get(link.to_node);
      if (!from || !to) continue;

      this.ctx.beginPath();
      this.ctx.moveTo(from.x, from.y);
      this.ctx.lineTo(to.x, to.y);

      if (from.owner_id && from.owner_id === to.owner_id && from.owner_color) {
        this.ctx.strokeStyle = from.owner_color;
        this.ctx.shadowColor = from.owner_color;
        this.ctx.shadowBlur = 8;
      } else {
        this.ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
        this.ctx.shadowBlur = 0;
      }
      this.ctx.stroke();
      this.ctx.shadowBlur = 0;
    }
  }

  drawDataPackets() {
    if (this.links.length === 0) return;

    for (const p of this.packets) {
      p.progress += p.speed;
      if (p.progress >= 1) {
        p.progress = 0;
        p.linkIndex = Math.floor(Math.random() * this.links.length);
      }

      const link = this.links[p.linkIndex];
      if (!link) continue;

      const from = this.nodes.get(link.from_node);
      const to = this.nodes.get(link.to_node);
      if (!from || !to) continue;

      const activeColor = from.owner_color || to.owner_color;
      if (!activeColor) continue;

      let startX = from.x,
        startY = from.y;
      let endX = to.x,
        endY = to.y;
      if (!from.owner_color && to.owner_color) {
        startX = to.x;
        startY = to.y;
        endX = from.x;
        endY = from.y;
      }

      const px = startX + (endX - startX) * p.progress;
      const py = startY + (endY - startY) * p.progress;

      this.ctx.fillStyle = activeColor;
      this.ctx.shadowColor = activeColor;
      this.ctx.shadowBlur = 8;

      this.ctx.beginPath();
      this.ctx.arc(px, py, 3, 0, Math.PI * 2);
      this.ctx.fill();
    }
    this.ctx.shadowBlur = 0;
  }

  drawNodes() {
    const time = Date.now() * 0.003;

    for (const node of this.nodes.values()) {
      const radius = this.getNodeRadius(node.type);
      const isHovered = this.hoveredNodeId === node.id;
      const ownerColor = node.owner_color || "#475569";
      const level = node.level || 1;

      if (level >= 2 && node.owner_id) {
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.arc(node.x, node.y, radius + 7, 0, Math.PI * 2);
        this.ctx.strokeStyle = ownerColor;
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([4, 4]);
        this.ctx.shadowColor = ownerColor;
        this.ctx.shadowBlur = 6;
        this.ctx.stroke();
        this.ctx.restore();
      }

      if (level === 3 && node.owner_id) {
        this.ctx.save();
        const pulse = Math.sin(time) * 2;
        this.ctx.beginPath();
        this.ctx.arc(node.x, node.y, radius + 12 + pulse, 0, Math.PI * 2);
        this.ctx.strokeStyle = "#ffd700";
        this.ctx.lineWidth = 1.5;
        this.ctx.shadowColor = "#ffd700";
        this.ctx.shadowBlur = 10;
        this.ctx.stroke();
        this.ctx.restore();
      }

      this.ctx.beginPath();
      this.ctx.arc(
        node.x,
        node.y,
        radius + (isHovered ? 3 : 0),
        0,
        Math.PI * 2,
      );
      this.ctx.fillStyle = "rgba(10, 15, 25, 0.92)";
      this.ctx.fill();

      this.ctx.lineWidth = isHovered ? 2.5 : 1.5;
      this.ctx.strokeStyle = isHovered ? "#fff" : ownerColor;
      this.ctx.shadowColor = ownerColor;
      this.ctx.shadowBlur = isHovered ? 15 : 6;
      this.ctx.stroke();
      this.ctx.shadowBlur = 0;

      this.ctx.fillStyle = ownerColor;
      this.ctx.font = `800 ${node.type === "core" ? 12 : 9}px JetBrains Mono`;
      this.ctx.textAlign = "center";
      this.ctx.textBaseline = "middle";

      let label = "RTR";
      if (node.type === "core") label = "CORE";
      if (node.type === "firewall") label = "WALL";
      if (node.type === "hq") label = "HQ";
      this.ctx.fillText(label, node.x, node.y - 4);

      let lvlStars = `v${node.version}`;
      if (level === 2) lvlStars = `★ Lv.2`;
      if (level === 3) lvlStars = `★★★ Lv.3`;

      this.ctx.fillStyle =
        level === 3 ? "#ffd700" : level === 2 ? "#38bdf8" : "#94a3b8";
      this.ctx.font = "700 8px JetBrains Mono";
      this.ctx.fillText(
        lvlStars,
        node.x,
        node.y + (node.type === "core" ? 11 : 8),
      );

      const barWidth = radius * 2;
      const barHeight = 4;
      const barX = node.x - radius;
      const barY = node.y + radius + 7;
      const hpPct = Math.max(0, Math.min(1, node.hp / node.max_hp));

      this.ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
      this.ctx.fillRect(barX, barY, barWidth, barHeight);

      this.ctx.fillStyle = hpPct > 0.4 ? ownerColor : "#ff0055";
      this.ctx.fillRect(barX, barY, barWidth * hpPct, barHeight);

      if (node.owner_name) {
        this.ctx.fillStyle = "#e2e8f0";
        this.ctx.font = "600 8.5px JetBrains Mono";
        this.ctx.fillText(`${node.owner_name} [${node.hp}]`, node.x, barY + 12);
      }
    }
  }
}
