import { CONFIG, MAP_DATA } from './config.js';
import { ASSETS } from './assets.js';
import { drawCharacter } from './character-renderer.js';
import { drawWall, drawGateOverlay } from './wall-renderer.js';
import { drawShadows, getEnvironmentLight } from './shadows.js';

export class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        
        // Shadow buffer canvas
        this.shadowCanvas = document.createElement('canvas');
        this.shadowCtx = this.shadowCanvas.getContext('2d');
        
        // Reusable bucket arrays to reduce GC
        this.entitiesByRow = Array.from({ length: CONFIG.GRID_H }, () => []);
        
        this.cachedFloor = null;

        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        
        const isPhonePortrait = h > w && w < 760;

        if (isPhonePortrait) {
            this.canvas.width = h;
            this.canvas.height = w;
        } else {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        
        this.shadowCanvas.width = this.canvas.width;
        this.shadowCanvas.height = this.canvas.height;

        this.ctx.imageSmoothingEnabled = false;
        
        this.cachedFloor = null;
    }

    // Helper to convert grid coords to screen pixels
    gridToScreen(gx, gy, camX, camY) {
        const centerScreenX = this.canvas.width / 2;
        const centerScreenY = this.canvas.height / 2;
        const tileSize = CONFIG.TILE_SIZE * CONFIG.SCALE;

        const screenX = centerScreenX + (gx - camX) * tileSize;
        const screenY = centerScreenY + (gy - camY) * tileSize;
        
        return { x: screenX, y: screenY, size: tileSize };
    }

    render(gameState, localPlayerId) {
        const ctx = this.ctx;
        const { width, height } = this.canvas;
        
        // Clear
        ctx.clearRect(0, 0, width, height);

        if (!ASSETS.loaded) return;

        // Camera follows local player
        let camX = CONFIG.GRID_W / 2;
        let camY = CONFIG.GRID_H / 2;
        
        if (gameState.players[localPlayerId]) {
            const p = gameState.players[localPlayerId];
            camX = p.x;
            camY = p.y;
        }

        const tileSize = CONFIG.TILE_SIZE * CONFIG.SCALE;
        const gateX = 11; // 11th grid tile (Center of 23)

        // Clear buckets
        this.entitiesByRow.forEach(row => row.length = 0);

        // Helper to add entity to row bucket
        const addToBucket = (type, obj) => {
            const r = Math.floor(obj.y);
            if (r >= 0 && r < CONFIG.GRID_H) {
                this.entitiesByRow[r].push({ type, obj });
            }
        };

        // Add NPCs, Players, Projectiles
        gameState.npcs.forEach(npc => addToBucket('npc', npc));
        Object.values(gameState.players).forEach(p => addToBucket('player', p));
        gameState.projectiles.forEach(p => addToBucket('projectile', p));

        // Create cached floor tile if needed
        if (!this.cachedFloor && ASSETS.loaded) {
            this.cachedFloor = document.createElement('canvas');
            this.cachedFloor.width = tileSize;
            this.cachedFloor.height = tileSize;
            const fCtx = this.cachedFloor.getContext('2d');
            const subSize = tileSize / 2;
            for (let oy = 0; oy < 2; oy++) {
                for (let ox = 0; ox < 2; ox++) {
                    fCtx.drawImage(ASSETS.floor, ox * subSize, oy * subSize, subSize, subSize);
                }
            }
        }

        // 1. Draw ALL Floors First (Background Layer)
        const floorCullMarginX = tileSize * 2;
        const floorCullMarginY = tileSize * 2;
        for (let y = 0; y < CONFIG.GRID_H; y++) {
            for (let x = 0; x < CONFIG.GRID_W; x++) {
                const pos = this.gridToScreen(x, y, camX, camY);
                if (
                    pos.x < -floorCullMarginX ||
                    pos.x > width + floorCullMarginX ||
                    pos.y < -floorCullMarginY ||
                    pos.y > height + floorCullMarginY
                ) continue;
                
                if (this.cachedFloor) {
                    this.ctx.drawImage(this.cachedFloor, pos.x, pos.y);
                }
            }
        }

        // 2. Shadows Pass (New)
        const lightInfo = getEnvironmentLight(gameState.time || 0);
        
        // Prepare shadow layer
        this.shadowCtx.clearRect(0, 0, width, height);
        this.shadowCtx.save();
        // Draw shadows as solid black shapes
        drawShadows(this.shadowCtx, gameState, this, camX, camY);
        this.shadowCtx.restore();

        // Composite shadows onto main canvas
        ctx.save();
        ctx.globalAlpha = lightInfo.opacity; // Opacity changes with day/night
        ctx.drawImage(this.shadowCanvas, 0, 0);
        ctx.restore();


        // 3. Draw Walls, Props, and Entities
        for (let y = 0; y < CONFIG.GRID_H; y++) {
            // A. Draw Shop
            if (y === 3) {
                const shopPos = this.gridToScreen(3, 2, camX, camY);
                ctx.drawImage(ASSETS.shop, shopPos.x, shopPos.y, tileSize * 3, tileSize * 2);
            }

            // B. Draw Entities
            this.entitiesByRow[y].sort((a, b) => a.obj.y - b.obj.y);
            this.entitiesByRow[y].forEach(item => {
                if (item.type === 'projectile') {
                    this.drawProjectile(ctx, item.obj, camX, camY, tileSize);
                } else {
                    const pos = this.gridToScreen(item.obj.x - 0.5, item.obj.y - 0.5, camX, camY);
                    drawCharacter(ctx, item.obj, pos.x, pos.y, tileSize, item.type === 'npc');
                }
            });

            // C. Draw Walls
            if (y === CONFIG.GRID_H - 1) {
                drawWall(this, gateX - 1, CONFIG.GRID_H, camX, camY);
                drawWall(this, gateX + 1, CONFIG.GRID_H, camX, camY);
            }

            if (y === 0) {
                const northGateX = Math.floor(CONFIG.GRID_W / 2);
                drawWall(this, northGateX - 1, 1, camX, camY);
                drawWall(this, northGateX + 1, 1, camX, camY);
            }

            for (let x = 0; x < CONFIG.GRID_W; x++) {
                if (MAP_DATA[y][x] === 1) {
                    const northGateX = Math.floor(CONFIG.GRID_W / 2);
                    const isNorthVestibulePillar =
                        (y === 1 && (x === northGateX - 1 || x === northGateX + 1));
                    if (isNorthVestibulePillar) continue;
                    drawWall(this, x, y, camX, camY);
                }
            }
        }
        
        // 4. Day/Night Color Overlay
        const col = lightInfo.color;
        if (col[3] > 0) {
            ctx.fillStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${col[3]})`;
            ctx.fillRect(0, 0, width, height);
        }
    }

    drawProjectile(ctx, proj, camX, camY, tileSize) {
        const pos = this.gridToScreen(proj.x - 0.5, proj.y - 0.5, camX, camY);
        const r = (CONFIG.PROJECTILE_RADIUS || 0.1) * tileSize;
        ctx.fillStyle = '#00ffff'; 
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#00ffff';
        ctx.beginPath();
        ctx.arc(pos.x + tileSize/2, pos.y + tileSize/2, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }
}