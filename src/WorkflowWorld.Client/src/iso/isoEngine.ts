import type { ZoneDefinition } from '../types/workflow';

// ─── Tile constants ─────────────────────────────────────────────────────
export const TILE_W = 40;
export const TILE_H = 20;
export const WALL_H = 22;

// ─── Coordinate transforms ─────────────────────────────────────────────
export function tileToScreen(tx: number, ty: number, offsetX: number, offsetY: number) {
  return {
    x: (tx - ty) * TILE_W / 2 + offsetX,
    y: (tx + ty) * TILE_H / 2 + offsetY,
  };
}

export function screenToTile(sx: number, sy: number, offsetX: number, offsetY: number) {
  const rx = sx - offsetX;
  const ry = sy - offsetY;
  return {
    tx: (rx / (TILE_W / 2) + ry / (TILE_H / 2)) / 2,
    ty: (ry / (TILE_H / 2) - rx / (TILE_W / 2)) / 2,
  };
}

// ─── Room types ─────────────────────────────────────────────────────────
export interface DoorPosition {
  wall: 'se' | 'sw' | 'ne' | 'nw';
  screenX: number;
  screenY: number;
  // Point just outside the door (for approach/exit waypoints)
  outsideX: number;
  outsideY: number;
  g1: { x: number; y: number };
  g2: { x: number; y: number };
}

export interface IsoRoom {
  zone: ZoneDefinition;
  tileX: number;
  tileY: number;
  tileW: number;
  tileH: number;
  screenX: number;
  screenY: number;
  screenBoundsW: number;
  screenBoundsH: number;
  doors: DoorPosition[];
  corners: { top: {x:number,y:number}; right: {x:number,y:number}; bottom: {x:number,y:number}; left: {x:number,y:number} };
}

export interface IsoConnection {
  fromRoom: IsoRoom;
  toRoom: IsoRoom;
  fromDoor: DoorPosition | null;
  toDoor: DoorPosition | null;
}

export interface CorridorTile {
  screenX: number;
  screenY: number;
}

export interface IsoLayout {
  rooms: IsoRoom[];
  connections: IsoConnection[];
  corridors: CorridorTile[];
  totalWidth: number;
  totalHeight: number;
  offsetX: number;
  offsetY: number;
  corridorCenterTileY: number; // tile Y of corridor center for waypoint computation
}

// ─── Compute diamond corners for a room ─────────────────────────────────
function computeCorners(tileX: number, tileY: number, tileW: number, tileH: number, offsetX: number, offsetY: number) {
  const top = tileToScreen(tileX, tileY, offsetX, offsetY);
  const right = tileToScreen(tileX + tileW, tileY, offsetX, offsetY);
  const bottom = tileToScreen(tileX + tileW, tileY + tileH, offsetX, offsetY);
  const left = tileToScreen(tileX, tileY + tileH, offsetX, offsetY);
  return { top, right, bottom, left };
}

// ─── Point in diamond test ──────────────────────────────────────────────
export function pointInDiamond(px: number, py: number, room: IsoRoom): boolean {
  const { top, right, bottom, left } = room.corners;
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return (
    cross(top.x, top.y, right.x, right.y, px, py) >= 0 &&
    cross(right.x, right.y, bottom.x, bottom.y, px, py) >= 0 &&
    cross(bottom.x, bottom.y, left.x, left.y, px, py) >= 0 &&
    cross(left.x, left.y, top.x, top.y, px, py) >= 0
  );
}

// ─── Room size from zone type/capacity ──────────────────────────────────
function getRoomSize(zone: ZoneDefinition): { w: number; h: number } {
  if (zone.type === 'door') return { w: 3, h: 3 };
  if (zone.type === 'error') return { w: 4, h: 3 };
  if (zone.type === 'exit-good' || zone.type === 'exit-bad') return { w: 3, h: 3 };
  const cap = zone.capacity || 5;
  if (cap <= 3) return { w: 3, h: 3 };
  if (cap <= 6) return { w: 4, h: 3 };
  if (cap <= 10) return { w: 4, h: 4 };
  return { w: 5, h: 4 };
}

// ─── Add a door to a room on a specific wall ────────────────────────────
function addDoor(room: IsoRoom, wall: 'se' | 'sw' | 'ne' | 'nw') {
  const { top, right, bottom, left } = room.corners;
  const doorWidth = 0.7;
  let start: {x:number,y:number}, end: {x:number,y:number};

  // se = right→bottom (front-right), sw = left→bottom (front-left)
  // ne = top→right (back-right), nw = top→left (back-left)
  if (wall === 'se') { start = right; end = bottom; }
  else if (wall === 'sw') { start = left; end = bottom; }
  else if (wall === 'ne') { start = top; end = right; }
  else { start = top; end = left; }

  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const dirX = end.x - start.x, dirY = end.y - start.y;
  const len = Math.sqrt(dirX * dirX + dirY * dirY);
  const nx = dirX / len, ny = dirY / len;
  const gapHalf = TILE_W * doorWidth / 3;

  // Outward normal: perpendicular to wall, pointing away from room center
  // Wall tangent is (nx, ny), perpendicular is (-ny, nx) or (ny, -nx)
  // Pick the one pointing away from the room center
  const centerX = (room.corners.top.x + room.corners.bottom.x) / 2;
  const centerY = (room.corners.top.y + room.corners.bottom.y) / 2;
  const outNorm1 = { x: -ny, y: nx };
  const dot1 = (mid.x + outNorm1.x - centerX) * outNorm1.x + (mid.y + outNorm1.y - centerY) * outNorm1.y;
  const outward = dot1 > 0 ? outNorm1 : { x: ny, y: -nx };
  const OUTSIDE_DIST = 18; // pixels beyond the door

  room.doors.push({
    wall,
    screenX: mid.x, screenY: mid.y,
    outsideX: mid.x + outward.x * OUTSIDE_DIST,
    outsideY: mid.y + outward.y * OUTSIDE_DIST,
    g1: { x: mid.x - nx * gapHalf, y: mid.y - ny * gapHalf },
    g2: { x: mid.x + nx * gapHalf, y: mid.y + ny * gapHalf },
  });
}

// ─── Auto-layout: corridor-based office floor plan ──────────────────────
export function computeIsoLayout(zones: ZoneDefinition[]): IsoLayout {
  if (zones.length === 0) return { rooms: [], connections: [], corridors: [], totalWidth: 600, totalHeight: 400, offsetX: 300, offsetY: 50, corridorCenterTileY: 6 };

  const entrance = zones.find(z => z.type === 'door');
  const exit = zones.find(z => z.type === 'exit-good');
  const errorZone = zones.find(z => z.type === 'error');
  const rejected = zones.find(z => z.type === 'exit-bad');
  const activities = zones.filter(z =>
    z.type !== 'door' && z.type !== 'exit-good' && z.type !== 'exit-bad' && z.type !== 'error'
  );

  // Layout: rooms above and below a central corridor
  // ┌─────┐  ┌─────┐  ┌─────┐
  // │Top 1│  │Top 2│  │Top 3│     ← top row rooms
  // └──┬──┘  └──┬──┘  └──┬──┘
  //  ══╧════════╧════════╧═══════ ← corridor
  // ┌──┴──┐  ┌──┴──┐  ┌──┴──┐
  // │Bot 1│  │Bot 2│  │Bot 3│     ← bottom row rooms
  // └─────┘  └─────┘  └─────┘
  //                        ┌────┐
  //                        │Exit│  ← at corridor end
  //                        └────┘
  //                    ┌─────┐
  //                    │Error│     ← separate, below
  //                    └─────┘

  const CORRIDOR_Y = 6;     // tile row for corridor center
  const ROOM_GAP = 1;       // gap between rooms in same row (tiles)
  const CORRIDOR_WIDTH = 2; // corridor is 2 tiles tall

  const placed: { zone: ZoneDefinition; tileX: number; tileY: number; tileW: number; tileH: number; row: 'top' | 'bottom' | 'corridor' | 'special' }[] = [];

  let cursorX = 0;

  // Entrance — on the left, spanning the corridor
  if (entrance) {
    const size = getRoomSize(entrance);
    placed.push({ zone: entrance, tileX: cursorX, tileY: CORRIDOR_Y - 1, tileW: size.w, tileH: size.h, row: 'corridor' });
    cursorX += size.w + ROOM_GAP;
  }

  // Split activities into top and bottom rows
  const topRow: ZoneDefinition[] = [];
  const bottomRow: ZoneDefinition[] = [];
  for (let i = 0; i < activities.length; i++) {
    if (i % 2 === 0) topRow.push(activities[i]);
    else bottomRow.push(activities[i]);
  }

  // Place top row rooms (above corridor, doors face down toward corridor)
  const maxCols = Math.max(topRow.length, bottomRow.length);
  for (let col = 0; col < topRow.length; col++) {
    const size = getRoomSize(topRow[col]);
    const tx = cursorX + col * (size.w + ROOM_GAP);
    const ty = CORRIDOR_Y - CORRIDOR_WIDTH - size.h; // above corridor
    placed.push({ zone: topRow[col], tileX: tx, tileY: ty, tileW: size.w, tileH: size.h, row: 'top' });
  }

  // Place bottom row rooms (below corridor, doors face up toward corridor)
  for (let col = 0; col < bottomRow.length; col++) {
    const size = getRoomSize(bottomRow[col]);
    const tx = cursorX + col * (size.w + ROOM_GAP);
    const ty = CORRIDOR_Y + CORRIDOR_WIDTH; // below corridor
    placed.push({ zone: bottomRow[col], tileX: tx, tileY: ty, tileW: size.w, tileH: size.h, row: 'bottom' });
  }

  // Corridor end X
  const lastColSize = activities.length > 0 ? getRoomSize(activities[activities.length - 1]) : { w: 3, h: 3 };
  const corridorEndX = cursorX + maxCols * (lastColSize.w + ROOM_GAP);

  // Place exit at corridor end
  if (exit) {
    const size = getRoomSize(exit);
    placed.push({ zone: exit, tileX: corridorEndX, tileY: CORRIDOR_Y - 1, tileW: size.w, tileH: size.h, row: 'corridor' });
  }

  // Place rejected below exit
  if (rejected) {
    const size = getRoomSize(rejected);
    placed.push({ zone: rejected, tileX: corridorEndX, tileY: CORRIDOR_Y + CORRIDOR_WIDTH + 1, tileW: size.w, tileH: size.h, row: 'special' });
  }

  // Place error room — separate, below and to the right
  if (errorZone) {
    const size = getRoomSize(errorZone);
    placed.push({ zone: errorZone, tileX: corridorEndX - 2, tileY: CORRIDOR_Y + CORRIDOR_WIDTH + 5, tileW: size.w, tileH: size.h, row: 'special' });
  }

  // Compute bounding box
  let minSX = Infinity, maxSX = -Infinity, minSY = Infinity, maxSY = -Infinity;
  const tmpOff = 500;
  for (const r of placed) {
    const corners = computeCorners(r.tileX, r.tileY, r.tileW, r.tileH, tmpOff, tmpOff);
    for (const c of [corners.top, corners.right, corners.bottom, corners.left]) {
      minSX = Math.min(minSX, c.x); maxSX = Math.max(maxSX, c.x);
      minSY = Math.min(minSY, c.y); maxSY = Math.max(maxSY, c.y);
    }
  }

  const padding = 30;
  const offsetX = tmpOff - minSX + padding;
  const offsetY = tmpOff - minSY + padding + WALL_H;
  const totalWidth = (maxSX - minSX) + padding * 2;
  const totalHeight = (maxSY - minSY) + padding * 2 + WALL_H + 20;

  // Build IsoRoom array
  const isoRooms: IsoRoom[] = placed.map(r => {
    const corners = computeCorners(r.tileX, r.tileY, r.tileW, r.tileH, offsetX, offsetY);
    const screenX = (corners.top.x + corners.bottom.x) / 2;
    const screenY = (corners.top.y + corners.bottom.y) / 2;
    return {
      zone: r.zone, tileX: r.tileX, tileY: r.tileY, tileW: r.tileW, tileH: r.tileH,
      screenX, screenY,
      screenBoundsW: corners.right.x - corners.left.x,
      screenBoundsH: corners.bottom.y - corners.top.y,
      corners, doors: [],
    };
  });

  // Add doors facing the corridor
  // In isometric: corridor runs left→right along increasing tileX
  // Top row rooms are at lower tileY → their bottom edge (SW: left→bottom) faces corridor
  // Bottom row rooms are at higher tileY → their top edge (NE: top→right) faces corridor
  for (let i = 0; i < isoRooms.length; i++) {
    const r = placed[i];
    const room = isoRooms[i];
    if (r.row === 'top') {
      // Top row rooms: door on SE wall (right→bottom, faces toward corridor below-right)
      addDoor(room, 'se');
    } else if (r.row === 'bottom') {
      // Bottom row rooms: door on NW wall (top→left, faces toward corridor above-left)
      addDoor(room, 'nw');
    } else if (r.zone.type === 'door') {
      // Entrance: door on SE wall (facing into the building)
      addDoor(room, 'se');
    } else if (r.zone.type === 'exit-good') {
      // Completed exit: door on NW wall (facing back toward corridor)
      addDoor(room, 'nw');
    } else {
      // Special rooms (error, rejected): door on NW wall (toward main area)
      addDoor(room, 'nw');
    }
  }

  // Build corridor tiles — fill the entire corridor strip plus branches
  const corridors: CorridorTile[] = [];
  const corridorTileSet = new Set<string>(); // avoid duplicates
  const addTile = (tx: number, ty: number) => {
    const key = `${tx},${ty}`;
    if (corridorTileSet.has(key)) return;
    corridorTileSet.add(key);
    const screen = tileToScreen(tx, ty, offsetX, offsetY);
    corridors.push({ screenX: screen.x, screenY: screen.y });
  };

  // Find extent of the corridor
  let minTX = Infinity, maxTX = -Infinity;
  for (const r of placed) {
    minTX = Math.min(minTX, r.tileX);
    maxTX = Math.max(maxTX, r.tileX + r.tileW);
  }

  // Main corridor strip — wider (3 tiles) for better visual
  for (let tx = minTX; tx <= maxTX; tx++) {
    for (let ty = CORRIDOR_Y - 1; ty <= CORRIDOR_Y + CORRIDOR_WIDTH; ty++) {
      addTile(tx, ty);
    }
  }

  // Add tiles connecting each room's door to the corridor
  for (const r of placed) {
    const room = isoRooms.find(rm => rm.zone.id === r.zone.id);
    if (!room) continue;

    if (r.row === 'top') {
      // Top row: tiles from room bottom edge down to corridor
      for (let ty = r.tileY + r.tileH; ty <= CORRIDOR_Y + CORRIDOR_WIDTH; ty++) {
        for (let tx = r.tileX; tx < r.tileX + r.tileW; tx++) addTile(tx, ty);
      }
    } else if (r.row === 'bottom') {
      // Bottom row: tiles from corridor up to room top edge
      for (let ty = CORRIDOR_Y - 1; ty <= r.tileY; ty++) {
        for (let tx = r.tileX; tx < r.tileX + r.tileW; tx++) addTile(tx, ty);
      }
    } else if (r.row === 'special') {
      // Error/rejected: tiles from corridor down to room
      const midX = r.tileX + Math.floor(r.tileW / 2);
      for (let ty = CORRIDOR_Y + CORRIDOR_WIDTH; ty <= r.tileY + r.tileH; ty++) {
        addTile(midX, ty);
        addTile(midX + 1, ty);
      }
    }
  }

  // Build connections
  const connections: IsoConnection[] = [];
  for (let i = 0; i < isoRooms.length; i++) {
    for (let j = i + 1; j < isoRooms.length; j++) {
      const a = isoRooms[i], b = isoRooms[j];
      // Connect rooms that share a corridor (both have doors)
      if (a.doors.length > 0 && b.doors.length > 0) {
        const dist = Math.sqrt((a.screenX - b.screenX) ** 2 + (a.screenY - b.screenY) ** 2);
        if (dist < 300) {
          connections.push({ fromRoom: a, toRoom: b, fromDoor: a.doors[0], toDoor: b.doors[0] });
        }
      }
    }
  }

  return { rooms: isoRooms, connections, corridors, totalWidth, totalHeight, offsetX, offsetY, corridorCenterTileY: CORRIDOR_Y };
}

// ─── Get random position within an isometric room (screen coords) ───────
export function randomPositionInRoom(room: IsoRoom, seed: number): { x: number; y: number } {
  const t1 = 0.2 + (seed * 0.6);
  const t2 = 0.2 + (((seed * 7.13) % 1) * 0.6);
  const { top, right, bottom, left } = room.corners;
  const midTop = { x: top.x + (right.x - top.x) * t1, y: top.y + (right.y - top.y) * t1 };
  const midBot = { x: left.x + (bottom.x - left.x) * t1, y: left.y + (bottom.y - left.y) * t1 };
  return {
    x: midTop.x + (midBot.x - midTop.x) * t2,
    y: midTop.y + (midBot.y - midTop.y) * t2,
  };
}
