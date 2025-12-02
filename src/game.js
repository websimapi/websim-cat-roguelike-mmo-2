import { Input } from './input.js';
import { Renderer } from './renderer.js';
import { CONFIG, MAP_DATA } from './config.js';
import { ASSETS, loadAssets, playSound } from './assets.js';
import { interactWithNPC, closeChat } from './ai.js';

const room = new WebsimSocket();

const state = {
    players: {}, // Stores interpolated player states
    npcs: [
        { 
            id: 'npc_shop', 
            x: 4.5, 
            y: 4.5, 
            canTalk: true, 
            facing: 'down',
            // AI State
            aiState: 'idle',
            aiTimer: 0,
            targetX: 4.5,
            targetY: 4.5,
            patrolBounds: { x1: 2.5, x2: 6.5, y1: 4.5, y2: 6.5 }
        }
    ],
    projectiles: [],
    myId: null,
    lastUpdate: 0,
    time: 0 // Game time (0..1)
};

// Logic for local player
const localPlayer = {
    x: 10.5,
    y: 5.5,
    vx: 0,
    vy: 0,
    facing: 'right',
    aimAngle: 0, // NEW: precise aiming
    lastShot: 0,
    talking: false,
    hitAnim: null,
    isMoving: false,
    wasMoving: false
};

let renderer;
let animationFrame;
let lastTime = 0;

// NEW: helper to update facing based on current mouse position
function updateFacingFromMouse() {
    if (!Input.mouse.moved || !renderer) return;

    const tileSize = CONFIG.TILE_SIZE * CONFIG.SCALE;
    // Player is always rendered at screen center
    const originX_Screen = renderer.canvas.width / 2;
    const originY_Screen = renderer.canvas.height / 2;

    const dx = Input.mouse.x - originX_Screen;
    const dy = Input.mouse.y - originY_Screen;

    localPlayer.aimAngle = Math.atan2(dy, dx); // Update aim angle

    const len = Math.hypot(dx, dy);
    if (len < 0.01) return;

    if (Math.abs(dx) > Math.abs(dy)) {
        localPlayer.facing = dx > 0 ? 'right' : 'left';
    } else {
        localPlayer.facing = dy > 0 ? 'down' : 'up';
    }
}

async function init() {
    const canvas = document.getElementById('gameCanvas');
    renderer = new Renderer(canvas);
    Input.init(canvas);

    await loadAssets();
    await room.initialize();

    state.myId = room.clientId;
    document.getElementById('loading').style.display = 'none';

    // Initial spawn presence
    room.updatePresence({
        x: localPlayer.x,
        y: localPlayer.y,
        facing: localPlayer.facing,
        aimAngle: localPlayer.aimAngle,
        isMoving: false,
        lastSeq: 0
    });

    // Subscribe to updates
    room.subscribePresence((presence) => {
        // Sync other players
        for (const id in presence) {
            if (id === state.myId) continue;
            const p = presence[id];

            // Simple interpolation target setup
            if (!state.players[id]) {
                state.players[id] = { ...p, id, username: room.peers[id]?.username || "Cat" };
            } else {
                // Update target values
                state.players[id].targetX = p.x;
                state.players[id].targetY = p.y;
                state.players[id].facing = p.facing;
                state.players[id].aimAngle = p.aimAngle || 0; // Sync aim
                state.players[id].isMoving = p.isMoving;
            }
        }

        // Remove disconnected
        for (const id in state.players) {
            if (!presence[id]) delete state.players[id];
        }
    });

    // Handle projectile events
    room.onmessage = (e) => {
        if (e.data.type === 'shoot') {
            // Prevent duplicate projectile for local player (since we spawn it immediately on input)
            if (e.data.ownerId === state.myId) return;

            spawnProjectile(e.data.x, e.data.y, e.data.dx, e.data.dy, e.data.ownerId);
            playSound('shoot', 0.3); // remote sound
        }
    };

    requestAnimationFrame(gameLoop);
}

function updateLocalPlayer(dt) {
    // Moved the "frozen" check deeper to allow interaction updates to run
    const isFrozen = localPlayer.talking;

    if (!isFrozen) {
        const move = Input.getMovementVector();
        // Speed is now time-based
        const speed = CONFIG.PLAYER_SPEED * dt;

        let nextX = localPlayer.x + move.x * speed;
        let nextY = localPlayer.y + move.y * speed;

        // Collision Check (Simple Grid Box)
        // Check corners
        const checkCollision = (x, y) => {
            const gx = Math.floor(x);
            const gy = Math.floor(y);
            if (gy < 0 || gy >= CONFIG.GRID_H || gx < 0 || gx >= CONFIG.GRID_W) return true;
            
            // Allow walking through gates
            const gateX = Math.floor(CONFIG.GRID_W / 2);
            const gateY = Math.floor(CONFIG.GRID_H / 2);
            
            // Top/Bottom Gates
            if (gx === gateX && (gy === 0 || gy === CONFIG.GRID_H - 1)) return false;
            // Left/Right Gates
            if (gy === gateY && (gx === 0 || gx === CONFIG.GRID_W - 1)) return false;

            // Allow walking through the two interior north vestibule pillars (visual-only walls)
            if (gy === 1 && (gx === gateX - 1 || gx === gateX + 1)) return false;
            // Allow walking through the two interior south vestibule pillars (visual-only walls)
            if (gy === CONFIG.GRID_H - 2 && (gx === gateX - 1 || gx === gateX + 1)) return false;

            return MAP_DATA[gy][gx] === 1;
        };

        const margin = 0.3; // Hitbox radius roughly
        if (!checkCollision(nextX - margin, localPlayer.y - margin) && 
            !checkCollision(nextX + margin, localPlayer.y + margin) &&
            !checkCollision(nextX + margin, localPlayer.y - margin) &&
            !checkCollision(nextX - margin, localPlayer.y + margin)) {
            localPlayer.x = nextX;
        }

        if (!checkCollision(localPlayer.x - margin, nextY - margin) && 
            !checkCollision(localPlayer.x + margin, nextY + margin) &&
            !checkCollision(localPlayer.x + margin, nextY - margin) &&
            !checkCollision(localPlayer.x - margin, nextY + margin)) {
            localPlayer.y = nextY;
        }

        if (move.y < 0) {
            localPlayer.facing = 'up';
        } else if (move.x !== 0) {
            localPlayer.facing = move.x > 0 ? 'right' : 'left';
        } else if (move.y > 0) {
            localPlayer.facing = 'down';
        }

        const isMoving = (move.x !== 0 || move.y !== 0);
        localPlayer.isMoving = isMoving; // Store locally for immediate rendering updates

        // NEW: facing is driven by mouse position instead of movement
        updateFacingFromMouse();
    }

    // Network Sync (Throttle to ~20hz)
    const now = Date.now();
    const movingChanged = localPlayer.isMoving !== localPlayer.wasMoving;

    if (now - state.lastUpdate > 50) {
        // Send update if: moving, state changed (stopped/started), or heartbeat needed
        if (localPlayer.isMoving || movingChanged || now - state.lastUpdate > 1000) {
            room.updatePresence({
                x: localPlayer.x,
                y: localPlayer.y,
                facing: localPlayer.facing,
                aimAngle: localPlayer.aimAngle,
                isMoving: localPlayer.isMoving
            });
            state.lastUpdate = now;
            localPlayer.wasMoving = localPlayer.isMoving;
        }
    }

    // Shooting
    // FIRE_RATE is now in seconds
    if (!isFrozen && Input.isShooting() && (now/1000) - localPlayer.lastShot > CONFIG.FIRE_RATE) {
        localPlayer.lastShot = now/1000;

        // Use aimAngle for shooting
        const angle = localPlayer.aimAngle;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);

        // Calculate Muzzle Position
        const offsetDist = 0.5;
        const muzzleX = localPlayer.x + dx * offsetDist;
        const muzzleY = localPlayer.y + dy * offsetDist;

        spawnProjectile(muzzleX, muzzleY, dx, dy, state.myId);
        playSound('shoot');

        room.send({
            type: 'shoot',
            x: muzzleX,
            y: muzzleY,
            dx: dx,
            dy: dy,
            ownerId: state.myId
        });
    }

    // Interaction Check
    let nearbyNPC = null;
    state.npcs.forEach(npc => {
        const dist = Math.hypot(npc.x - localPlayer.x, npc.y - localPlayer.y);
        if (dist < 1.5) nearbyNPC = npc;
    });

    const prompt = document.getElementById('interaction-label');
    if (nearbyNPC) {
        // Only show prompt if not currently talking
        if (!localPlayer.talking) {
            prompt.style.display = 'block';
            const screenPos = renderer.gridToScreen(nearbyNPC.x, nearbyNPC.y, localPlayer.x, localPlayer.y);
            prompt.style.left = screenPos.x + 'px';
            prompt.style.top = (screenPos.y - 40) + 'px';

            if (Input.keys['KeyT'] || Input.keys['t']) {
                localPlayer.talking = true;
                Input.keys['KeyT'] = false;
                Input.keys['t'] = false; // consume key
                prompt.style.display = 'none';
                interactWithNPC(nearbyNPC, () => {
                    localPlayer.talking = false;
                });
            }
        } else {
            prompt.style.display = 'none';
        }
    } else {
        prompt.style.display = 'none';
    }

    // Mouse click interaction fallback
    if (!localPlayer.talking && Input.mouse.leftDown && nearbyNPC) {
        localPlayer.talking = true;
        Input.mouse.leftDown = false;
        interactWithNPC(nearbyNPC, () => {
             localPlayer.talking = false;
        });
    }
}

function triggerHit(entity, dx, dy) {
    // bounce down (squash) and back (direction of hit)
    entity.hitAnim = {
        vx: dx * 0.5, // Direction of hit
        vy: dy * 0.5,
        startTime: Date.now(),
        duration: 500
    };
}

function spawnProjectile(x, y, dx, dy, ownerId) {
    // Life is now in seconds (0.5s)
    state.projectiles.push({ x, y, dx, dy, ownerId, life: 0.5 });
}

function updateProjectiles(dt) {
    for (let i = state.projectiles.length - 1; i >= 0; i--) {
        const p = state.projectiles[i];
        p.x += p.dx * CONFIG.PROJECTILE_SPEED * dt;
        p.y += p.dy * CONFIG.PROJECTILE_SPEED * dt;
        p.life -= dt;

        // Wall collision
        const gx = Math.floor(p.x);
        const gy = Math.floor(p.y);
        const gateX = Math.floor(CONFIG.GRID_W / 2);
        const gateY = Math.floor(CONFIG.GRID_H / 2);
        const isGate = (gx === gateX && (gy === 0 || gy === CONFIG.GRID_H - 1)) || 
                       (gy === gateY && (gx === 0 || gx === CONFIG.GRID_W - 1));

        if (gx >= 0 && gx < CONFIG.GRID_W && gy >= 0 && gy < CONFIG.GRID_H) {
            if (MAP_DATA[gy][gx] === 1 && !isGate) p.life = 0;
        }

        // Entity Collision
        if (p.life > 0) {
            const hitRadius = 0.5; // Roughly the character size
            
            // 1. Check Local Player
            // Avoid hitting self immediately if we just shot it (ownerId check)
            // But usually in spawn we want to see effects. 
            // However, usually you don't hit yourself.
            if (p.ownerId !== state.myId) {
                const dx = localPlayer.x - p.x;
                const dy = localPlayer.y - p.y;
                if (dx*dx + dy*dy < hitRadius*hitRadius) {
                    triggerHit(localPlayer, p.dx, p.dy);
                    p.life = 0;
                }
            }

            // 2. Check NPCs
            if (p.life > 0) {
                for (const npc of state.npcs) {
                    const dx = npc.x - p.x;
                    const dy = npc.y - p.y;
                    if (dx*dx + dy*dy < hitRadius*hitRadius) {
                        triggerHit(npc, p.dx, p.dy);
                        p.life = 0;
                        break;
                    }
                }
            }

            // 3. Check Other Players
            if (p.life > 0) {
                for (const id in state.players) {
                    // state.players only contains others
                    if (id === p.ownerId) continue; // Don't hit shooter
                    const target = state.players[id];
                    const dx = target.x - p.x;
                    const dy = target.y - p.y;
                    if (dx*dx + dy*dy < hitRadius*hitRadius) {
                        triggerHit(target, p.dx, p.dy);
                        p.life = 0;
                        break;
                    }
                }
            }
        }

        if (p.life <= 0) state.projectiles.splice(i, 1);
    }
}

function updatePeers() {
    // Smoothly interpolate other players
    for (const id in state.players) {
        const p = state.players[id];
        if (p.targetX !== undefined) {
            p.x += (p.targetX - p.x) * 0.2;
            p.y += (p.targetY - p.y) * 0.2;
        }
    }
}

function updateNPCs(dt) {
    state.npcs.forEach(npc => {
        // 1. Find closest player (Local or Remote)
        let closestDist = Infinity;
        let targetPlayer = null;

        // Check Local
        const dLocal = Math.hypot(localPlayer.x - npc.x, localPlayer.y - npc.y);
        if (dLocal < closestDist) {
            closestDist = dLocal;
            targetPlayer = localPlayer;
        }

        // Check Peers
        Object.keys(state.players).forEach(id => {
            if (id === state.myId) return;
            const p = state.players[id];
            const d = Math.hypot(p.x - npc.x, p.y - npc.y);
            if (d < closestDist) {
                closestDist = d;
                targetPlayer = p;
            }
        });

        // 2. AI Logic
        const WATCH_DIST = 3.5;

        if (closestDist < WATCH_DIST && targetPlayer) {
            // Watch Mode (Look at player)
            npc.aiState = 'watch';
            npc.isMoving = false;
            npc.aiTimer = 1000;

            // Face target
            const dx = targetPlayer.x - npc.x;
            const dy = targetPlayer.y - npc.y;
            if (Math.abs(dx) > Math.abs(dy)) {
                npc.facing = dx > 0 ? 'right' : 'left';
            } else {
                npc.facing = dy > 0 ? 'down' : 'up';
            }
        } else {
            // Patrol Mode
            if (npc.aiState === 'watch') {
                npc.aiState = 'idle';
            }

            if (npc.aiState === 'idle') {
                npc.aiTimer -= dt * 1000; // Timer still in ms
                npc.isMoving = false;
                if (npc.aiTimer <= 0) {
                    npc.aiState = 'wander';
                    // Pick random spot in front of shop
                    const b = npc.patrolBounds;
                    npc.targetX = b.x1 + Math.random() * (b.x2 - b.x1);
                    npc.targetY = b.y1 + Math.random() * (b.y2 - b.y1);
                }
            } else if (npc.aiState === 'wander') {
                const speed = 0.9 * dt; // Slow leisurely walk (approx 0.9 tiles/sec)
                const dx = npc.targetX - npc.x;
                const dy = npc.targetY - npc.y;
                const dist = Math.hypot(dx, dy);

                if (dist < speed) {
                    npc.x = npc.targetX;
                    npc.y = npc.targetY;
                    npc.aiState = 'idle';
                    npc.aiTimer = 2000 + Math.random() * 3000;
                } else {
                    npc.x += (dx / dist) * speed;
                    npc.y += (dy / dist) * speed;
                    npc.isMoving = true;
                    
                    if (Math.abs(dx) > Math.abs(dy)) {
                        npc.facing = dx > 0 ? 'right' : 'left';
                    } else {
                        npc.facing = dy > 0 ? 'down' : 'up';
                    }
                }
            }
        }
    });
}

function gameLoop(timestamp) {
    if (!lastTime) lastTime = timestamp;
    // Calculate Delta Time in seconds
    // Cap dt at 0.1s (10FPS) to prevent physics explosions on lag spikes/tab switching
    const dt = Math.min((timestamp - lastTime) / 1000, 0.1);
    lastTime = timestamp;

    // Update Day/Night Cycle
    // 24 minutes = CONFIG.DAY_LENGTH seconds
    const cyclePos = (Date.now() / 1000) % CONFIG.DAY_LENGTH;
    state.time = cyclePos / CONFIG.DAY_LENGTH;

    updateLocalPlayer(dt);
    updatePeers(); // Interpolation doesn't strictly need dt as it's a dampening factor, but could be improved. Leaving as is for simple smoothing.
    updateNPCs(dt);
    updateProjectiles(dt);

    // Sync local player to state for rendering
    state.players[state.myId] = {
        ...localPlayer, 
        id: state.myId, 
        username: room.peers[state.myId]?.username || 'Me' 
    };

    renderer.render(state, state.myId);
    animationFrame = requestAnimationFrame(gameLoop);
}

// Start
init();