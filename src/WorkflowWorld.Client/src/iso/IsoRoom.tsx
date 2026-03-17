import { TILE_W, TILE_H, WALL_H, tileToScreen } from './isoEngine';
import type { IsoRoom, IsoConnection } from './isoEngine';

interface IsoRoomProps {
  room: IsoRoom;
  count: number;
  now: number;
  isHeatmap: boolean;
  isBottleneck: boolean;
  isDragOver: boolean;
}

const ZONE_COLORS: Record<string, { floor: string; wallL: string; wallR: string; accent: string }> = {
  door:       { floor: 'rgba(100,200,100,0.12)', wallL: 'rgba(60,140,60,0.4)', wallR: 'rgba(50,120,50,0.5)', accent: '#4CAF50' },
  desk:       { floor: 'rgba(74,144,217,0.08)', wallL: 'rgba(50,100,160,0.4)', wallR: 'rgba(40,85,140,0.5)', accent: '#4A90D9' },
  office:     { floor: 'rgba(245,166,35,0.08)', wallL: 'rgba(180,120,25,0.4)', wallR: 'rgba(160,105,20,0.5)', accent: '#F5A623' },
  seats:      { floor: 'rgba(155,142,196,0.08)', wallL: 'rgba(110,100,150,0.4)', wallR: 'rgba(95,85,135,0.5)', accent: '#9B8EC4' },
  room:       { floor: 'rgba(74,144,217,0.08)', wallL: 'rgba(50,100,160,0.4)', wallR: 'rgba(40,85,140,0.5)', accent: '#4A90D9' },
  machine:    { floor: 'rgba(26,188,156,0.08)', wallL: 'rgba(20,140,115,0.4)', wallR: 'rgba(15,120,100,0.5)', accent: '#1ABC9C' },
  'exit-good':{ floor: 'rgba(39,174,96,0.12)', wallL: 'rgba(30,130,70,0.45)', wallR: 'rgba(25,110,60,0.55)', accent: '#27AE60' },
  'exit-bad': { floor: 'rgba(231,76,60,0.08)', wallL: 'rgba(170,55,45,0.4)', wallR: 'rgba(150,45,35,0.5)', accent: '#E74C3C' },
  error:      { floor: 'rgba(231,76,60,0.12)', wallL: 'rgba(170,55,45,0.45)', wallR: 'rgba(150,45,35,0.55)', accent: '#E74C3C' },
};

// ─── Furniture per zone type ────────────────────────────────────────────
function RoomFurniture({ room, now }: { room: IsoRoom; now: number }) {
  const type = room.zone.type;
  const cx = room.screenX, cy = room.screenY;
  const items: JSX.Element[] = [];

  if (type === 'desk' || type === 'office') {
    // Desk
    items.push(<g key="desk" transform={`translate(${cx - 6}, ${cy - 4})`}>
      <polygon points="0,-4 12,0 0,4 -12,0" fill="#8B6914" stroke="#6B5010" strokeWidth="0.6" opacity="0.6" />
      <polygon points="-12,0 -12,3 0,7 0,4" fill="#6B5010" opacity="0.5" />
      <polygon points="12,0 12,3 0,7 0,4" fill="#5A4510" opacity="0.5" />
      <rect x="-3" y="-9" width="6" height="4" rx="0.5" fill="#333" stroke="#555" strokeWidth="0.4" />
      <rect x="-2.5" y="-8.5" width="5" height="3" rx="0.3" fill="#1a3a5c" opacity="0.7" />
    </g>);
    // Chair
    items.push(<g key="chair" transform={`translate(${cx + 8}, ${cy + 3})`}>
      <polygon points="0,-3 5,0 0,3 -5,0" fill="#555" opacity="0.5" />
      <rect x="-0.5" y="-6" width="1.5" height="3" rx="0.3" fill="#666" />
    </g>);
    // Filing cabinet (office only)
    if (type === 'office') {
      items.push(<g key="cabinet" transform={`translate(${cx - 16}, ${cy + 2})`}>
        <polygon points="0,-5 6,-2 0,1 -6,-2" fill="#546E7A" opacity="0.5" />
        <polygon points="-6,-2 -6,2 0,5 0,1" fill="#455A64" opacity="0.5" />
        <polygon points="6,-2 6,2 0,5 0,1" fill="#37474F" opacity="0.5" />
        <line x1="-2" y1="-1" x2="2" y2="1" stroke="#78909C" strokeWidth="0.4" />
      </g>);
    }
    // Plant
    items.push(<g key="plant" transform={`translate(${cx + 14}, ${cy - 6})`}>
      <circle cx="0" cy="2" r="2" fill="#5D4037" opacity="0.5" />
      <circle cx="0" cy="-1" r="3" fill="#4CAF50" opacity="0.4" />
      <circle cx="-2" cy="-2" r="2" fill="#66BB6A" opacity="0.4" />
      <circle cx="2" cy="-2" r="2" fill="#43A047" opacity="0.4" />
    </g>);
  } else if (type === 'seats') {
    // Row of chairs
    for (let i = 0; i < 3; i++) {
      items.push(<g key={`ch${i}`} transform={`translate(${cx - 14 + i * 12}, ${cy - 2 + (i % 2) * 3})`}>
        <polygon points="0,-2 4,0 0,2 -4,0" fill="#607D8B" opacity="0.45" />
        <rect x="-0.5" y="-4" width="1" height="2" rx="0.3" fill="#546E7A" opacity="0.5" />
      </g>);
    }
    // Coffee table
    items.push(<g key="table" transform={`translate(${cx}, ${cy + 6})`}>
      <polygon points="0,-2 6,0 0,2 -6,0" fill="#795548" opacity="0.4" />
    </g>);
    // Magazine rack
    items.push(<g key="mag" transform={`translate(${cx + 12}, ${cy + 1})`}>
      <rect x="-2" y="-3" width="4" height="5" rx="0.5" fill="#8D6E63" opacity="0.3" />
    </g>);
  } else if (type === 'machine') {
    // Server rack
    items.push(<g key="rack" transform={`translate(${cx - 4}, ${cy - 2})`}>
      <polygon points="0,-6 10,-1 0,4 -10,-1" fill="#37474F" stroke="#455A64" strokeWidth="0.4" opacity="0.6" />
      <polygon points="-10,-1 -10,4 0,9 0,4" fill="#263238" opacity="0.6" />
      <polygon points="10,-1 10,4 0,9 0,4" fill="#1C2529" opacity="0.6" />
      <circle cx="-3" cy="1" r="0.8" fill={Math.sin(now / 300) > 0 ? '#4CAF50' : '#4CAF5044'} />
      <circle cx="-3" cy="3" r="0.8" fill={Math.sin(now / 400) > 0 ? '#FF9800' : '#FF980044'} />
      <circle cx="3" cy="2" r="0.8" fill="#4CAF50" opacity="0.7" />
    </g>);
    // Second smaller rack
    items.push(<g key="rack2" transform={`translate(${cx + 10}, ${cy + 2})`}>
      <polygon points="0,-4 6,-1 0,2 -6,-1" fill="#37474F" opacity="0.4" />
      <polygon points="-6,-1 -6,2 0,5 0,2" fill="#263238" opacity="0.4" />
    </g>);
  } else if (type === 'door') {
    // Welcome mat
    items.push(<g key="mat" transform={`translate(${cx}, ${cy + 2})`}>
      <polygon points="0,-3 10,0 0,3 -10,0" fill="#8D6E63" opacity="0.35" />
    </g>);
    // Coat hooks on wall
    items.push(<g key="hooks" transform={`translate(${cx - 8}, ${cy - 8})`}>
      <line x1="0" y1="0" x2="0" y2="3" stroke="#888" strokeWidth="0.5" opacity="0.3" />
      <line x1="3" y1="1" x2="3" y2="4" stroke="#888" strokeWidth="0.5" opacity="0.3" />
    </g>);
  } else if (type === 'exit-good') {
    items.push(<text key="trophy" x={cx} y={cy + 1} textAnchor="middle" fontSize="10" opacity="0.5">🏆</text>);
    // Confetti on floor
    items.push(<g key="conf" opacity="0.3">
      <circle cx={cx - 8} cy={cy + 4} r="1" fill="#FFD700" />
      <circle cx={cx + 6} cy={cy - 2} r="1" fill="#E91E63" />
      <circle cx={cx + 10} cy={cy + 6} r="1" fill="#00BCD4" />
    </g>);
  } else if (type === 'exit-bad') {
    items.push(<text key="sad" x={cx} y={cy + 1} textAnchor="middle" fontSize="10" opacity="0.4">😔</text>);
  } else if (type === 'error') {
    // Hazard tape pattern
    items.push(<g key="hazard" transform={`translate(${cx}, ${cy})`}>
      <polygon points="0,-3 8,0 0,3 -8,0" fill="rgba(231,76,60,0.1)" stroke="#E74C3C" strokeWidth="0.4" strokeDasharray="2,2" />
    </g>);
    // Warning cone
    items.push(<g key="cone" transform={`translate(${cx + 8}, ${cy + 4})`}>
      <polygon points="0,-4 2,0 -2,0" fill="#FF5722" opacity="0.5" />
      <line x1="-1" y1="-2" x2="1" y2="-2" stroke="white" strokeWidth="0.5" opacity="0.4" />
    </g>);
  }

  return <>{items}</>;
}

// ─── Wall segment with door gap ─────────────────────────────────────────
function WallWithDoors({ room, wall, color }: {
  room: IsoRoom; wall: 'n' | 'w'; color: string;
}) {
  const { top, right, left } = room.corners;
  const doors = room.doors.filter(d => {
    // North wall doors are on the east side, west wall doors are on the south side
    if (wall === 'n') return d.wall === 'e';
    return d.wall === 's';
  });

  // If no doors on this wall, draw solid wall
  if (doors.length === 0) {
    if (wall === 'n') {
      const pts = `${top.x},${top.y - WALL_H} ${right.x},${right.y - WALL_H} ${right.x},${right.y} ${top.x},${top.y}`;
      return <polygon points={pts} fill={color} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />;
    } else {
      const pts = `${top.x},${top.y - WALL_H} ${top.x},${top.y} ${left.x},${left.y} ${left.x},${left.y - WALL_H}`;
      return <polygon points={pts} fill={color} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />;
    }
  }

  // Draw wall with door gap
  const doorWidth = 1.2; // tiles
  const segments: JSX.Element[] = [];

  if (wall === 'n') {
    // North wall goes from top to right
    // Door gaps are on east wall (right side), but for visual purposes let's put a gap in the north wall center
    const mid = { x: (top.x + right.x) / 2, y: (top.y + right.y) / 2 };
    const gapHalf = TILE_W * doorWidth / 4;
    const dirX = (right.x - top.x), dirY = (right.y - top.y);
    const len = Math.sqrt(dirX * dirX + dirY * dirY);
    const nx = dirX / len, ny = dirY / len;
    const g1 = { x: mid.x - nx * gapHalf, y: mid.y - ny * gapHalf };
    const g2 = { x: mid.x + nx * gapHalf, y: mid.y + ny * gapHalf };

    // Left segment
    segments.push(<polygon key="nl" points={`${top.x},${top.y - WALL_H} ${g1.x},${g1.y - WALL_H} ${g1.x},${g1.y} ${top.x},${top.y}`} fill={color} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />);
    // Right segment
    segments.push(<polygon key="nr" points={`${g2.x},${g2.y - WALL_H} ${right.x},${right.y - WALL_H} ${right.x},${right.y} ${g2.x},${g2.y}`} fill={color} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />);
    // Door frame
    segments.push(<line key="nf1" x1={g1.x} y1={g1.y - WALL_H} x2={g1.x} y2={g1.y} stroke="rgba(160,120,60,0.6)" strokeWidth="1.5" />);
    segments.push(<line key="nf2" x1={g2.x} y1={g2.y - WALL_H} x2={g2.x} y2={g2.y} stroke="rgba(160,120,60,0.6)" strokeWidth="1.5" />);
    // Door lintel
    segments.push(<line key="nl2" x1={g1.x} y1={g1.y - WALL_H} x2={g2.x} y2={g2.y - WALL_H} stroke="rgba(160,120,60,0.7)" strokeWidth="1.5" />);
  } else {
    // West wall goes from top to left
    const mid = { x: (top.x + left.x) / 2, y: (top.y + left.y) / 2 };
    const gapHalf = TILE_W * doorWidth / 4;
    const dirX = (left.x - top.x), dirY = (left.y - top.y);
    const len = Math.sqrt(dirX * dirX + dirY * dirY);
    const nx = dirX / len, ny = dirY / len;
    const g1 = { x: mid.x - nx * gapHalf, y: mid.y - ny * gapHalf };
    const g2 = { x: mid.x + nx * gapHalf, y: mid.y + ny * gapHalf };

    segments.push(<polygon key="wt" points={`${top.x},${top.y - WALL_H} ${top.x},${top.y} ${g1.x},${g1.y} ${g1.x},${g1.y - WALL_H}`} fill={color} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />);
    segments.push(<polygon key="wb" points={`${g2.x},${g2.y - WALL_H} ${g2.x},${g2.y} ${left.x},${left.y} ${left.x},${left.y - WALL_H}`} fill={color} stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" />);
    segments.push(<line key="wf1" x1={g1.x} y1={g1.y - WALL_H} x2={g1.x} y2={g1.y} stroke="rgba(160,120,60,0.6)" strokeWidth="1.5" />);
    segments.push(<line key="wf2" x1={g2.x} y1={g2.y - WALL_H} x2={g2.x} y2={g2.y} stroke="rgba(160,120,60,0.6)" strokeWidth="1.5" />);
    segments.push(<line key="wl2" x1={g1.x} y1={g1.y - WALL_H} x2={g2.x} y2={g2.y - WALL_H} stroke="rgba(160,120,60,0.7)" strokeWidth="1.5" />);
  }

  return <>{segments}</>;
}

// ─── Connection lines between rooms ─────────────────────────────────────
export function IsoConnectionLine({ conn, now }: { conn: IsoConnection; now: number }) {
  const from = conn.fromDoor ? { x: conn.fromDoor.screenX, y: conn.fromDoor.screenY } : { x: conn.fromRoom.screenX, y: conn.fromRoom.screenY };
  const to = conn.toDoor ? { x: conn.toDoor.screenX, y: conn.toDoor.screenY } : { x: conn.toRoom.screenX, y: conn.toRoom.screenY };

  // Animated dash offset for flow direction
  const dashOffset = -(now / 80) % 20;

  return (
    <g>
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y}
        stroke="rgba(255,255,255,0.08)" strokeWidth="2" strokeDasharray="6,8"
        strokeDashoffset={dashOffset} />
      {/* Arrow at midpoint */}
      {(() => {
        const mx = (from.x + to.x * 2) / 3, my = (from.y + to.y * 2) / 3;
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        return <polygon
          points={`0,-2.5 6,0 0,2.5`}
          fill="rgba(255,255,255,0.12)"
          transform={`translate(${mx},${my}) rotate(${angle * 180 / Math.PI})`}
        />;
      })()}
    </g>
  );
}

// ─── Main room component ────────────────────────────────────────────────
export default function IsoRoomComponent({ room, count, now, isHeatmap, isBottleneck, isDragOver }: IsoRoomProps) {
  const colors = ZONE_COLORS[room.zone.type] || ZONE_COLORS.desk;
  const { top, right, bottom, left } = room.corners;
  const isBusy = room.zone.capacity > 0 && count > room.zone.capacity;
  const floorPoints = `${top.x},${top.y} ${right.x},${right.y} ${bottom.x},${bottom.y} ${left.x},${left.y}`;

  let heatFill = colors.floor;
  if (isHeatmap && room.zone.capacity > 0 && count > 0) {
    const ratio = count / room.zone.capacity;
    if (ratio >= 0.9) heatFill = 'rgba(231,76,60,0.2)';
    else if (ratio >= 0.6) heatFill = 'rgba(245,166,35,0.15)';
    else heatFill = 'rgba(39,174,96,0.1)';
  }

  const hasDoorN = room.doors.some(d => d.wall === 'e');
  const hasDoorW = room.doors.some(d => d.wall === 's');

  // Tile grid
  const gridLines: JSX.Element[] = [];
  const ox = room.corners.top.x - tileToScreen(room.tileX, room.tileY, 0, 0).x;
  const oy = room.corners.top.y - tileToScreen(room.tileX, room.tileY, 0, 0).y;
  for (let i = 1; i < room.tileW; i++) {
    const a = tileToScreen(room.tileX + i, room.tileY, 0, 0);
    const b = tileToScreen(room.tileX + i, room.tileY + room.tileH, 0, 0);
    gridLines.push(<line key={`gx${i}`} x1={a.x + ox} y1={a.y + oy} x2={b.x + ox} y2={b.y + oy} stroke="rgba(255,255,255,0.035)" strokeWidth="0.5" />);
  }
  for (let i = 1; i < room.tileH; i++) {
    const a = tileToScreen(room.tileX, room.tileY + i, 0, 0);
    const b = tileToScreen(room.tileX + room.tileW, room.tileY + i, 0, 0);
    gridLines.push(<line key={`gy${i}`} x1={a.x + ox} y1={a.y + oy} x2={b.x + ox} y2={b.y + oy} stroke="rgba(255,255,255,0.035)" strokeWidth="0.5" />);
  }

  return (
    <g>
      {/* Shadow */}
      <polygon points={floorPoints} fill="rgba(0,0,0,0.12)" transform="translate(2, 4)" />

      {/* Floor */}
      <polygon points={floorPoints}
        fill={isDragOver ? 'rgba(39,185,80,0.2)' : heatFill}
        stroke={isDragOver ? '#3FB950' : isBottleneck ? '#F85149' : isBusy ? '#F5A623' : colors.accent}
        strokeWidth={isDragOver ? 2 : isBottleneck ? 1.5 : 0.8}
        strokeOpacity={isDragOver ? 1 : 0.35}
      />
      {gridLines}

      {/* Walls with door gaps */}
      <WallWithDoors room={room} wall="n" color={colors.wallL} />
      <WallWithDoors room={room} wall="w" color={colors.wallR} />

      {/* Wall top highlights */}
      <line x1={top.x} y1={top.y - WALL_H} x2={right.x} y2={right.y - WALL_H} stroke={colors.accent} strokeWidth="0.6" strokeOpacity="0.25" />
      <line x1={top.x} y1={top.y - WALL_H} x2={left.x} y2={left.y - WALL_H} stroke={colors.accent} strokeWidth="0.6" strokeOpacity="0.25" />

      {/* Furniture */}
      <RoomFurniture room={room} now={now} />

      {/* Label */}
      <text x={room.screenX} y={top.y - WALL_H - 6} textAnchor="middle" fontSize="8"
        fill="rgba(255,255,255,0.5)" fontFamily="'JetBrains Mono', monospace" fontWeight="600">
        {room.zone.emoji} {room.zone.label}
      </text>

      {/* Population badge */}
      {count > 0 && (
        <g transform={`translate(${right.x - 2}, ${right.y - WALL_H - 2})`}>
          <circle cx="0" cy="0" r="8" fill={isBusy ? 'rgba(245,166,35,0.85)' : isBottleneck ? 'rgba(248,81,73,0.85)' : 'rgba(0,0,0,0.6)'} />
          <text x="0" y="1" textAnchor="middle" dominantBaseline="middle" fontSize="8" fill="white" fontWeight="bold">{count}</text>
        </g>
      )}

      {isBottleneck && (
        <text x={room.screenX} y={bottom.y + 10} textAnchor="middle" fontSize="7"
          fill="#F85149" fontFamily="monospace" fontWeight="700" opacity={0.5 + Math.sin(now / 400) * 0.3}>
          🔥 BOTTLENECK
        </text>
      )}
      {isBusy && !isBottleneck && (
        <text x={room.screenX} y={bottom.y + 10} textAnchor="middle" fontSize="6"
          fill="#F5A623" fontFamily="monospace" opacity={0.5 + Math.sin(now / 400) * 0.3}>
          ⚠ BUSY
        </text>
      )}
    </g>
  );
}
