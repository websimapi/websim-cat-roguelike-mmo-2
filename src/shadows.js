import { CONFIG, MAP_DATA } from './config.js';

// Helper to get sun vector and intensity based on time (0..1)
export function getEnvironmentLight(time) {
    // 0.0 = Midnight
    // 0.25 = Sunrise
    // 0.5 = Noon
    // 0.75 = Sunset
    
    // Sun logic (Active 0.2 to 0.8)
    let sunActive = false;
    let moonActive = false;
    let lightVector = { x: 0, y: 0 };
    let shadowLength = 0;
    let opacity = 0;
    let colorOverlay = [0, 0, 0, 0]; // r,g,b,a

    // Calculate Sun Position
    // Map time 0.25..0.75 to angle -PI..0 (East to West)
    // Actually let's do a full cycle for smoother transition
    // Angle: 0 at Noon (0.5). -PI/2 at Sunrise (0.25). PI/2 at Sunset (0.75).
    
    const noon = 0.5;
    const isDay = time > 0.2 && time < 0.8;
    
    // Smooth transitions
    const transition = 0.05;

    if (isDay) {
        sunActive = true;
        // 0.25 -> -PI/2, 0.5 -> 0, 0.75 -> PI/2
        const angle = ((time - 0.25) / 0.5) * Math.PI - Math.PI/2; 
        // Sun moves Left to Right (-1 to 1)
        const sx = Math.sin(angle); 
        const sy = -Math.cos(angle); // Noon = -1 (Up/North), Sunrise/Set = 0

        // Shadow Vector is opposite to light
        // At Noon (Sun Up), shadow goes Down (+Y) ?? 
        // Let's stick to standard top-down: Sun travels East-West.
        // Sunrise (Left): Shadow Right (+x)
        // Sunset (Right): Shadow Left (-x)
        // Noon (Top): Shadow Down (+y)
        
        // Wait, standard map: East is Right.
        // Sunrise at East (Right) -> Casts Shadow Left.
        // Let's do that.
        // Time 0.25 (Sunrise). Sun at X=1. Shadow Vector X=-1.
        // Time 0.75 (Sunset). Sun at X=-1. Shadow Vector X=1.
        // Time 0.5 (Noon). Sun at Y=-1 (North). Shadow Vector Y=1.
        
        const sunAngle = ((time - 0.25) / 0.5) * Math.PI; // 0 to PI
        // 0 = Sunrise (East), PI = Sunset (West)
        
        const sunX = Math.cos(sunAngle); // 1 -> 0 -> -1
        const sunY = -Math.sin(sunAngle); // 0 -> -1 -> 0 (High noon)

        lightVector = { x: -sunX, y: -sunY }; 
        
        // Length factor: Long at horizon, Short at noon
        const height = Math.sin(sunAngle); // 0 -> 1 -> 0
        shadowLength = (1 - height) * 2 + 0.5; // Shortest 0.5, Longest 2.5
        
        opacity = 0.6 * Math.min(1, height * 4); // Fade in/out at horizon
    } else {
        // Moon logic (simpler, always casts generic night shadow or opposing sun)
        // Let's just use Moon as opposite sun
        const moonTime = (time + 0.5) % 1;
        // Same logic but dimmer
         const moonAngle = ((moonTime - 0.25) / 0.5) * Math.PI;
         const moonX = Math.cos(moonAngle);
         const moonY = -Math.sin(moonAngle);
         lightVector = { x: -moonX, y: -moonY };
         const height = Math.max(0, Math.sin(moonAngle));
         shadowLength = (1 - height) * 2 + 0.5;
         opacity = 0.3 * Math.min(1, height * 4); // Faint moon shadows
    }

    // Sky Color Overlay
    if (time < 0.2) {
        // Deep Night
        colorOverlay = [0, 0, 40, 0.6];
    } else if (time < 0.3) {
        // Sunrise (0.2 - 0.3)
        const t = (time - 0.2) / 0.1;
        // Night Blue -> Orange
        colorOverlay = [
            0 * (1-t) + 255 * t, 
            0 * (1-t) + 100 * t, 
            40 * (1-t) + 0 * t, 
            0.6 * (1-t) + 0.2 * t
        ];
    } else if (time < 0.7) {
        // Day (0.3 - 0.7)
        colorOverlay = [0, 0, 0, 0]; // Clear
    } else if (time < 0.8) {
        // Sunset (0.7 - 0.8)
        const t = (time - 0.7) / 0.1;
        // Clear -> Purple
        colorOverlay = [
            100 * t, 
            0, 
            100 * t, 
            0.3 * t
        ];
    } else {
        // Night (0.8 - 1.0)
        const t = (time - 0.8) / 0.2; // 0..1
        // Purple -> Deep Blue
        colorOverlay = [
            100 * (1-t) + 0 * t,
            0,
            100 * (1-t) + 40 * t,
            0.3 * (1-t) + 0.6 * t
        ];
    }

    return { vector: lightVector, length: shadowLength, opacity, color: colorOverlay };
}

export function drawShadows(ctx, gameState, renderer, camX, camY) {
    const time = gameState.time || 0;
    const light = getEnvironmentLight(time);

    if (light.opacity <= 0.05) return; // Too dark for shadows

    const tileSize = CONFIG.TILE_SIZE * CONFIG.SCALE;
    const shadowVec = {
        x: light.vector.x * light.length * tileSize,
        y: light.vector.y * light.length * tileSize
    };

    // Use a temporary canvas approach implicitly by setting comp op?
    // No, Canvas API doesn't support "draw all shapes then fill union".
    // We just draw them with some overlap. For "Raytraced" look, we want uniform density.
    // So we assume the renderer has set up a layer or we just accept overlap darkening.
    // User asked for "True Raytraced", which implies correct occlusion.
    // The renderer will handle the layer logic. Here we just draw black shapes.

    ctx.fillStyle = 'black';
    
    // 1. Walls
    for (let y = 0; y < CONFIG.GRID_H; y++) {
        for (let x = 0; x < CONFIG.GRID_W; x++) {
            if (MAP_DATA[y][x] === 1) {
                // Calculate Wall Geometry
                const pos = renderer.gridToScreen(x, y, camX, camY);
                
                // Wall visual top (shear logic matching wall-renderer)
                const shearX = (x - camX) * 1.5; 
                const shear = shearX * (tileSize / 32);
                
                // Base coords (Screen)
                const bx = pos.x;
                const by = pos.y + tileSize; // Bottom of tile
                
                // Top coords (Screen) - The wall "roof"
                const tx = pos.x + shear;
                const ty = pos.y - tileSize; // Top of visual wall (2 tiles high visually?)
                // wait, drawWall draws top face at `pos.y - tileSize`. 
                // And front face connects `pos.y` to `pos.y` (height 0?? No)
                // `drawWall`: Front face is `pos.y` to `pos.y` (height 0?? No)
                // `drawWall`: `ctx.setTransform(..., pos.y)` and fills rect `tileSize`.
                // It draws from `pos.y` down to `pos.y + tileSize`.
                // And Top Face is at `topY = pos.y - tileSize`.
                // So the wall is visually 2 tiles high (from -1 to +1 relative to pos.y).
                
                // Let's assume the "Shadow Caster" is the volume from Floor (y) to Top (y-size).
                // We project the Top Face.
                
                const p1 = { x: tx, y: ty }; // Top-Left
                const p2 = { x: tx + tileSize, y: ty }; // Top-Right (approximation, ignore shear width fix)
                const p3 = { x: tx + tileSize, y: ty + tileSize }; // Bottom-Right of top face
                const p4 = { x: tx, y: ty + tileSize }; // Bottom-Left of top face
                
                drawQuadShadow(ctx, p1, p2, p3, p4, shadowVec);
            }
        }
    }

    // 2. Shop (At 3, 2)
    {
        const shopPos = renderer.gridToScreen(3, 2, camX, camY);
        // Shop is ~3 tiles wide, ~2 tiles high visually
        // Let's cast a simple box shadow for it
        const w = tileSize * 3;
        const h = tileSize * 2;
        // Assume shop is a box
        const tx = shopPos.x;
        const ty = shopPos.y - tileSize; // bit of height
        
        const p1 = { x: tx, y: ty };
        const p2 = { x: tx + w, y: ty };
        const p3 = { x: tx + w, y: ty + tileSize };
        const p4 = { x: tx, y: ty + tileSize };
        drawQuadShadow(ctx, p1, p2, p3, p4, shadowVec);
    }

    // 3. Entities
    // Players
    Object.values(gameState.players).forEach(p => drawEntityShadow(ctx, p, renderer, camX, camY, shadowVec));
    // NPCs
    gameState.npcs.forEach(npc => drawEntityShadow(ctx, npc, renderer, camX, camY, shadowVec));
}

function drawQuadShadow(ctx, p1, p2, p3, p4, vec) {
    ctx.beginPath();
    // Project all 4 points
    // Construct Convex Hull of (Original Quad + Projected Quad)
    // Simple method: Draw projected quad, and connect corresponding corners
    
    const s1 = { x: p1.x + vec.x, y: p1.y + vec.y };
    const s2 = { x: p2.x + vec.x, y: p2.y + vec.y };
    const s3 = { x: p3.x + vec.x, y: p3.y + vec.y };
    const s4 = { x: p4.x + vec.x, y: p4.y + vec.y };
    
    // Draw the projection (The shadow on the ground)
    // And the connections (The volume sides) to ensure no gaps if shadow is short
    // Actually, just drawing the hull is cleaner.
    
    // Optimization: Just draw the projected quad connected to the base.
    // But since we want "True Raytraced" feel, the shadow is the projected silhouette.
    // For a top face, the shadow is the projected top face.
    // But we also need to fill the space between the object and the shadow if the angle is steep.
    // Lets simple draw the 6-point hexagon formed by extreme points?
    // Hard to determine extremes generically without dot products.
    
    // Brute force: Draw projected quad. Draw quads connecting p1-s1-s2-p2, etc.
    ctx.moveTo(s1.x, s1.y);
    ctx.lineTo(s2.x, s2.y);
    ctx.lineTo(s3.x, s3.y);
    ctx.lineTo(s4.x, s4.y);
    ctx.closePath();
    ctx.fill();
    
    // Connectors
    const drawConn = (a, b, sa, sb) => {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.lineTo(sa.x, sa.y);
        ctx.fill();
    };
    
    drawConn(p1, p2, s1, s2);
    drawConn(p2, p3, s2, s3);
    drawConn(p3, p4, s3, s4);
    drawConn(p4, p1, s4, s1);
}

function drawEntityShadow(ctx, entity, renderer, camX, camY, vec) {
    const pos = renderer.gridToScreen(entity.x - 0.5, entity.y - 0.5, camX, camY);
    const tileSize = CONFIG.TILE_SIZE * CONFIG.SCALE;
    const cx = pos.x + tileSize / 2;
    const cy = pos.y + tileSize / 2;
    const r = tileSize * 0.3; // Character radius
    
    // Character is a cylinder roughly.
    // Project the circle.
    ctx.beginPath();
    const sx = cx + vec.x;
    const sy = cy + vec.y;
    
    ctx.ellipse(sx, sy, r, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    
    // Connect base to shadow (cylinder body shadow)
    // Tangent points?
    // Simplified: Draw a thick line or rect between center and shadow center
    // Better: Polygon tangent to circle.
    
    // Calculate normal to vector
    const dx = vec.x;
    const dy = vec.y;
    const len = Math.hypot(dx, dy);
    if (len > 0.1) {
        const nx = -dy / len * r;
        const ny = dx / len * r * 0.5; // Scale Y for perspective squash
        
        ctx.beginPath();
        ctx.moveTo(cx + nx, cy + ny);
        ctx.lineTo(cx - nx, cy - ny);
        ctx.lineTo(sx - nx, sy - ny);
        ctx.lineTo(sx + nx, sy + ny);
        ctx.fill();
    }
}