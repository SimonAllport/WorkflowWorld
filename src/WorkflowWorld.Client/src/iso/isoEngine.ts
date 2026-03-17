import type { ZoneDefinition } from '../types/workflow';

// ─── Tile constants (smaller = tighter layout) ─────────────────────────
export const TILE_W = 48;
export const TILE_H = 24;
export const WALL_H = 18;

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
  wall: 'n' | 's' | 'e' | 'w';
  tileOffset: number;
  connectsTo: string;
  // Screen coords of door gap center
  screenX: number;
  screenY: number;
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

export interface IsoLayout {
  rooms: IsoRoom[];
  connections: IsoConnection[];
  totalWidth: number;
  totalHeight: number;
  offsetX: number;
  offsetY: number;
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

// ─── Room size from zone type/capacity (compact) ────────────────────────
function getRoomSize(zone: ZoneDefinition): { w: number; h: number } {
  if (zone.type === 'door') return { w: 3, h: 3 };
  if (zone.type === 'error') return { w: 3, h: 3 };
  if (zone.type === 'exit-good' || zone.type === 'exit-bad') return { w: 3, h: 3 };
  const cap = zone.capacity || 5;
  if (cap <= 3) return { w: 3, h: 3 };
  if (cap <= 6) return { w: 4, h: 3 };
  if (cap <= 10) return { w: 4, h: 4 };
  return { w: 5, h: 4 };
}

// ─── Auto-layout zones into isometric rooms ─────────────────────────────
export function computeIsoLayout(zones: ZoneDefinition[]): IsoLayout {
  if (zones.length === 0) return { rooms: [], connections: [], totalWidth: 600, totalHeight: 400, offsetX: 300, offsetY: 50 };

  const entrance = zones.find(z => z.type === 'door');
  const exit = zones.find(z => z.type === 'exit-good');
  const errorZone = zones.find(z => z.type === 'error');
  const rejected = zones.find(z => z.type === 'exit-bad');
  const activities = zones.filter(z =>
    z.type !== 'door' && z.type !== 'exit-good' && z.type !== 'exit-bad' && z.type !== 'error'
  );

  const placed: { zone: ZoneDefinition; tileX: number; tileY: number; tileW: number; tileH: number }[] = [];

  const GAP = 1; // tight gap
  const ROW_HEIGHT = 5; // tiles per row including gap
  let cursorX = 0;

  // Entrance on left, vertically centered
  if (entrance) {
    const size = getRoomSize(entrance);
    placed.push({ zone: entrance, tileX: cursorX, tileY: 3, tileW: size.w, tileH: size.h });
    cursorX += size.w + GAP;
  }

  // Activities in 2-row staggered layout, tightly packed
  const cols = Math.ceil(activities.length / 2);
  for (let i = 0; i < activities.length; i++) {
    const col = Math.floor(i / 2);
    const isTop = i % 2 === 0;
    const size = getRoomSize(activities[i]);
    const ty = isTop ? 0 : ROW_HEIGHT;
    placed.push({
      zone: activities[i],
      tileX: cursorX + col * (size.w + GAP),
      tileY: ty,
      tileW: size.w,
      tileH: size.h,
    });
  }

  // Advance past activities
  if (cols > 0) {
    const lastActSize = getRoomSize(activities[activities.length - 1] || activities[0]);
    cursorX += cols * (lastActSize.w + GAP);
  }

  // Exit top-right
  if (exit) {
    const size = getRoomSize(exit);
    placed.push({ zone: exit, tileX: cursorX, tileY: 1, tileW: size.w, tileH: size.h });
  }

  // Rejected below exit
  if (rejected) {
    const size = getRoomSize(rejected);
    placed.push({ zone: rejected, tileX: cursorX, tileY: ROW_HEIGHT + 1, tileW: size.w, tileH: size.h });
  }

  // Error corner — offset right and down
  if (errorZone) {
    const size = getRoomSize(errorZone);
    placed.push({ zone: errorZone, tileX: cursorX + (exit ? 4 : 0), tileY: ROW_HEIGHT + 4, tileW: size.w, tileH: size.h });
  }

  // Compute bounding box
  let minSX = Infinity, maxSX = -Infinity, minSY = Infinity, maxSY = -Infinity;
  const tmpOff = 500;
  for (const r of placed) {
    const corners = computeCorners(r.tileX, r.tileY, r.tileW, r.tileH, tmpOff, tmpOff);
    for (const c of [corners.top, corners.right, corners.bottom, corners.left]) {
      minSX = Math.min(minSX, c.x);
      maxSX = Math.max(maxSX, c.x);
      minSY = Math.min(minSY, c.y);
      maxSY = Math.max(maxSY, c.y);
    }
  }

  const padding = 60;
  const offsetX = tmpOff - minSX + padding;
  const offsetY = tmpOff - minSY + padding + WALL_H;
  const totalWidth = (maxSX - minSX) + padding * 2;
  const totalHeight = (maxSY - minSY) + padding * 2 + WALL_H + 30;

  // Build IsoRoom array
  const isoRooms: IsoRoom[] = placed.map(r => {
    const corners = computeCorners(r.tileX, r.tileY, r.tileW, r.tileH, offsetX, offsetY);
    const screenX = (corners.top.x + corners.bottom.x) / 2;
    const screenY = (corners.top.y + corners.bottom.y) / 2;
    return {
      zone: r.zone,
      tileX: r.tileX, tileY: r.tileY, tileW: r.tileW, tileH: r.tileH,
      screenX, screenY,
      screenBoundsW: corners.right.x - corners.left.x,
      screenBoundsH: corners.bottom.y - corners.top.y,
      corners,
      doors: [],
    };
  });

  // Compute door positions between adjacent rooms
  for (const room of isoRooms) {
    for (const other of isoRooms) {
      if (other.zone.id === room.zone.id) continue;
      const rRight = room.tileX + room.tileW;
      const rBottom = room.tileY + room.tileH;
      const oRight = other.tileX + other.tileW;
      const oBottom = other.tileY + other.tileH;

      // East neighbor
      if (other.tileX >= rRight && other.tileX <= rRight + GAP + 1) {
        const overlapStart = Math.max(room.tileY, other.tileY);
        const overlapEnd = Math.min(rBottom, oBottom);
        if (overlapEnd > overlapStart) {
          const midTileY = (overlapStart + overlapEnd) / 2;
          const doorScreen = tileToScreen(rRight, midTileY, offsetX, offsetY);
          room.doors.push({ wall: 'e', tileOffset: Math.floor((midTileY - room.tileY)), connectsTo: other.zone.id, screenX: doorScreen.x, screenY: doorScreen.y });
        }
      }
      // South neighbor
      if (other.tileY >= rBottom && other.tileY <= rBottom + GAP + 1) {
        const overlapStart = Math.max(room.tileX, other.tileX);
        const overlapEnd = Math.min(rRight, oRight);
        if (overlapEnd > overlapStart) {
          const midTileX = (overlapStart + overlapEnd) / 2;
          const doorScreen = tileToScreen(midTileX, rBottom, offsetX, offsetY);
          room.doors.push({ wall: 's', tileOffset: Math.floor((midTileX - room.tileX)), connectsTo: other.zone.id, screenX: doorScreen.x, screenY: doorScreen.y });
        }
      }
    }
  }

  // Build connections for flow lines
  const connections: IsoConnection[] = [];
  for (const room of isoRooms) {
    for (const door of room.doors) {
      const targetRoom = isoRooms.find(r => r.zone.id === door.connectsTo);
      if (targetRoom) {
        const targetDoor = targetRoom.doors.find(d => d.connectsTo === room.zone.id);
        // Avoid duplicate connections
        if (!connections.some(c => c.fromRoom.zone.id === targetRoom.zone.id && c.toRoom.zone.id === room.zone.id)) {
          connections.push({ fromRoom: room, toRoom: targetRoom, fromDoor: door, toDoor: targetDoor || null });
        }
      }
    }
  }
  // Also connect rooms that don't have direct doors (entrance→first activity, last activity→exit)
  if (entrance && activities.length > 0) {
    const entranceRoom = isoRooms.find(r => r.zone.id === entrance.id);
    const firstAct = isoRooms.find(r => r.zone.id === activities[0].id);
    if (entranceRoom && firstAct && !connections.some(c => c.fromRoom.zone.id === entrance.id && c.toRoom.zone.id === activities[0].id)) {
      connections.push({ fromRoom: entranceRoom, toRoom: firstAct, fromDoor: null, toDoor: null });
    }
  }

  return { rooms: isoRooms, connections, totalWidth, totalHeight, offsetX, offsetY };
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
