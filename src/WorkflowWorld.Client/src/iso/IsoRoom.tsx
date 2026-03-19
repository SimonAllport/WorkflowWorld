import React from 'react';
import { TILE_W, TILE_H, WALL_H, tileToScreen } from './isoEngine';
import type { IsoRoom, IsoConnection, CorridorTile, DoorPosition } from './isoEngine';

interface IsoRoomProps {
  room: IsoRoom;
  count: number;
  now: number;
  isHeatmap: boolean;
  isBottleneck: boolean;
  isDragOver: boolean;
  hasNearbyWalker: boolean;
}

// ─── Warm, solid color palette per zone type ─────────────────────────
const ZONE_COLORS: Record<string, { floor: string; floorAlt: string; wallL: string; wallR: string; wallTop: string; accent: string }> = {
  door:       { floor: '#C8D8C0', floorAlt: '#B8C8B0', wallL: '#7A9A6A', wallR: '#6A8A5A', wallTop: '#8AAA7A', accent: '#5A7A4A' },
  desk:       { floor: '#E8DCC8', floorAlt: '#DDD0B8', wallL: '#C4A864', wallR: '#B09850', wallTop: '#D4B874', accent: '#A08840' },
  office:     { floor: '#E8DCC8', floorAlt: '#DDD0B8', wallL: '#C4A864', wallR: '#B09850', wallTop: '#D4B874', accent: '#A08840' },
  seats:      { floor: '#DDD8E8', floorAlt: '#D0C8D8', wallL: '#9888B0', wallR: '#8878A0', wallTop: '#A898C0', accent: '#7868A0' },
  room:       { floor: '#E8DCC8', floorAlt: '#DDD0B8', wallL: '#C4A864', wallR: '#B09850', wallTop: '#D4B874', accent: '#A08840' },
  machine:    { floor: '#D0DDD8', floorAlt: '#C0CCC8', wallL: '#6AA898', wallR: '#5A9888', wallTop: '#7AB8A8', accent: '#4A8878' },
  'exit-good':{ floor: '#C8E0C0', floorAlt: '#B8D0B0', wallL: '#68B060', wallR: '#58A050', wallTop: '#78C070', accent: '#489040' },
  'exit-bad': { floor: '#E0C8C0', floorAlt: '#D0B8B0', wallL: '#C07060', wallR: '#B06050', wallTop: '#D08070', accent: '#A05040' },
  error:      { floor: '#E8C0B8', floorAlt: '#D8B0A8', wallL: '#D06858', wallR: '#C05848', wallTop: '#E07868', accent: '#B04838' },
  teleporter: { floor: '#1A1A2E', floorAlt: '#16163A', wallL: '#2A3050', wallR: '#222840', wallTop: '#3A4060', accent: '#4A5080' },
};

// ─── Furniture per zone type (bigger, warmer, more detailed) ─────────
function RoomFurniture({ room, now }: { room: IsoRoom; now: number }) {
  const type = room.zone.type;
  const cx = room.screenX, cy = room.screenY;
  const items: JSX.Element[] = [];

  if (type === 'desk' || type === 'office') {
    // Large desk with monitor
    items.push(<g key="desk" transform={`translate(${cx - 8}, ${cy - 6})`}>
      {/* Desk top */}
      <polygon points="0,-6 16,0 0,6 -16,0" fill="#A07830" stroke="#8A6820" strokeWidth="0.8" />
      {/* Desk front face */}
      <polygon points="-16,0 -16,4 0,10 0,6" fill="#8A6820" />
      <polygon points="16,0 16,4 0,10 0,6" fill="#785818" />
      {/* Monitor */}
      <rect x="-5" y="-16" width="10" height="8" rx="1" fill="#2A2A2A" stroke="#444" strokeWidth="0.8" />
      <rect x="-4" y="-15" width="8" height="6" rx="0.5" fill="#4488AA" opacity="0.8" />
      {/* Monitor stand */}
      <rect x="-1" y="-8" width="2" height="3" fill="#444" />
      {/* Keyboard */}
      <polygon points="3,-5 9,-2 3,1 -3,-2" fill="#555" stroke="#666" strokeWidth="0.4" />
    </g>);
    // Office chair
    items.push(<g key="chair" transform={`translate(${cx + 12}, ${cy + 4})`}>
      <polygon points="0,-4 7,0 0,4 -7,0" fill="#4A4A5A" stroke="#3A3A4A" strokeWidth="0.6" />
      <polygon points="-7,0 -7,2 0,6 0,4" fill="#3A3A4A" />
      <polygon points="7,0 7,2 0,6 0,4" fill="#2A2A3A" />
      <rect x="-1" y="-8" width="2" height="4" rx="0.5" fill="#4A4A5A" />
      <polygon points="-3,-10 3,-7 -3,-4" fill="#4A4A5A" />
    </g>);
    // Filing cabinet (office only)
    if (type === 'office') {
      items.push(<g key="cabinet" transform={`translate(${cx - 20}, ${cy + 4})`}>
        <polygon points="0,-8 8,-4 0,0 -8,-4" fill="#788898" stroke="#687888" strokeWidth="0.6" />
        <polygon points="-8,-4 -8,2 0,6 0,0" fill="#687888" />
        <polygon points="8,-4 8,2 0,6 0,0" fill="#586878" />
        {/* Drawer handles */}
        <line x1="-3" y1="-1" x2="3" y2="2" stroke="#9AA8B8" strokeWidth="0.8" />
        <line x1="-3" y1="1" x2="3" y2="4" stroke="#9AA8B8" strokeWidth="0.8" />
      </g>);
    }
    // Potted plant
    items.push(<g key="plant" transform={`translate(${cx + 18}, ${cy - 8})`}>
      <polygon points="0,2 4,0 0,-2 -4,0" fill="#6D4C2A" />
      <polygon points="-4,0 -4,3 0,1 0,-2" fill="#5D3C1A" />
      <polygon points="4,0 4,3 0,1 0,-2" fill="#4D2C0A" />
      <circle cx="0" cy="-4" r="5" fill="#3A8A3A" />
      <circle cx="-3" cy="-6" r="3.5" fill="#4A9A4A" />
      <circle cx="3" cy="-5" r="3" fill="#2A7A2A" />
      <circle cx="0" cy="-7" r="2.5" fill="#5AAA5A" />
    </g>);
  } else if (type === 'seats') {
    // Waiting room chairs
    for (let i = 0; i < 3; i++) {
      items.push(<g key={`ch${i}`} transform={`translate(${cx - 16 + i * 14}, ${cy - 4 + (i % 2) * 4})`}>
        <polygon points="0,-4 6,0 0,4 -6,0" fill="#6080A0" stroke="#5070A0" strokeWidth="0.5" />
        <polygon points="-6,0 -6,2 0,6 0,4" fill="#5070A0" />
        <polygon points="6,0 6,2 0,6 0,4" fill="#4060A0" />
        <rect x="-1" y="-8" width="2" height="4" rx="0.5" fill="#5070A0" />
      </g>);
    }
    // Coffee table
    items.push(<g key="table" transform={`translate(${cx}, ${cy + 8})`}>
      <polygon points="0,-3 8,0 0,3 -8,0" fill="#8A6830" stroke="#7A5820" strokeWidth="0.5" />
      <polygon points="-8,0 -8,2 0,5 0,3" fill="#7A5820" />
      <polygon points="8,0 8,2 0,5 0,3" fill="#6A4810" />
    </g>);
    // Magazine on table
    items.push(<g key="mag" transform={`translate(${cx + 2}, ${cy + 6})`}>
      <polygon points="0,-1.5 3,0 0,1.5 -3,0" fill="#D85050" opacity="0.8" />
    </g>);
  } else if (type === 'machine') {
    // Server rack — big with blinking lights
    items.push(<g key="rack" transform={`translate(${cx - 6}, ${cy - 3})`}>
      <polygon points="0,-10 14,-3 0,4 -14,-3" fill="#3A4A5A" stroke="#4A5A6A" strokeWidth="0.8" />
      <polygon points="-14,-3 -14,5 0,12 0,4" fill="#2A3A4A" />
      <polygon points="14,-3 14,5 0,12 0,4" fill="#1A2A3A" />
      {/* Blinking LEDs */}
      <circle cx="-6" cy="0" r="1.2" fill={Math.sin(now / 300) > 0 ? '#4CAF50' : '#2A5A2A'} />
      <circle cx="-6" cy="3" r="1.2" fill={Math.sin(now / 400) > 0 ? '#FF9800' : '#5A3A0A'} />
      <circle cx="-6" cy="6" r="1.2" fill="#4CAF50" />
      <circle cx="6" cy="1" r="1.2" fill={Math.sin(now / 350 + 1) > 0 ? '#4CAF50' : '#2A5A2A'} />
      <circle cx="6" cy="4" r="1.2" fill={Math.sin(now / 450 + 2) > 0 ? '#FF9800' : '#5A3A0A'} />
      {/* Vent lines */}
      <line x1="-4" y1="-5" x2="4" y2="-2" stroke="#4A5A6A" strokeWidth="0.5" />
      <line x1="-4" y1="-3" x2="4" y2="0" stroke="#4A5A6A" strokeWidth="0.5" />
    </g>);
    // Second rack
    items.push(<g key="rack2" transform={`translate(${cx + 12}, ${cy + 3})`}>
      <polygon points="0,-7 10,-2 0,3 -10,-2" fill="#3A4A5A" stroke="#4A5A6A" strokeWidth="0.6" />
      <polygon points="-10,-2 -10,3 0,8 0,3" fill="#2A3A4A" />
      <polygon points="10,-2 10,3 0,8 0,3" fill="#1A2A3A" />
      <circle cx="-3" cy="0" r="1" fill="#4CAF50" />
    </g>);
  } else if (type === 'door') {
    // Welcome mat
    items.push(<g key="mat" transform={`translate(${cx}, ${cy + 3})`}>
      <polygon points="0,-4 12,0 0,4 -12,0" fill="#8B6E3C" stroke="#7B5E2C" strokeWidth="0.5" />
      <polygon points="0,-2 6,0 0,2 -6,0" fill="#9B7E4C" />
    </g>);
    // Umbrella stand
    items.push(<g key="umbrella" transform={`translate(${cx - 12}, ${cy - 4})`}>
      <polygon points="0,0 3,-1 0,-2 -3,-1" fill="#5A5A6A" />
      <polygon points="-3,-1 -3,3 0,2 0,-2" fill="#4A4A5A" />
      <polygon points="3,-1 3,3 0,2 0,-2" fill="#3A3A4A" />
      <line x1="0" y1="-2" x2="0" y2="-8" stroke="#4488CC" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M-3,-8 Q0,-12 3,-8" fill="#4488CC" opacity="0.8" />
    </g>);
  } else if (type === 'exit-good') {
    // Trophy
    items.push(<g key="trophy" transform={`translate(${cx}, ${cy})`}>
      <rect x="-2" y="2" width="4" height="3" rx="0.5" fill="#8B7530" />
      <polygon points="0,2 4,0 0,-2 -4,0" fill="#A08530" />
      <path d="M-4,-2 Q-5,-7 -2,-8 L2,-8 Q5,-7 4,-2" fill="#FFD700" stroke="#DAA520" strokeWidth="0.6" />
      <path d="M-2,-8 Q0,-11 2,-8" fill="#FFD700" stroke="#DAA520" strokeWidth="0.4" />
      <circle cx="0" cy="-5" r="1.5" fill="#DAA520" />
    </g>);
    // Confetti on floor
    items.push(<g key="conf" opacity="0.6">
      <circle cx={cx - 10} cy={cy + 5} r="1.5" fill="#FFD700" />
      <circle cx={cx + 8} cy={cy - 3} r="1.5" fill="#E91E63" />
      <circle cx={cx + 14} cy={cy + 7} r="1.2" fill="#00BCD4" />
      <rect x={cx - 6} y={cy + 8} width="2" height="3" rx="0.3" fill="#7CFF6B" transform={`rotate(25, ${cx - 5}, ${cy + 9})`} />
    </g>);
  } else if (type === 'exit-bad') {
    // Sad rain cloud
    items.push(<g key="cloud" transform={`translate(${cx}, ${cy - 4})`} opacity="0.5">
      <ellipse cx="0" cy="0" rx="8" ry="4" fill="#8899AA" />
      <ellipse cx="-4" cy="-2" rx="5" ry="3" fill="#8899AA" />
      <ellipse cx="4" cy="-1" rx="4" ry="3" fill="#8899AA" />
      <line x1="-3" y1="4" x2="-4" y2="8" stroke="#6688AA" strokeWidth="0.8" opacity={0.3 + Math.sin(now / 300) * 0.3} />
      <line x1="1" y1="4" x2="0" y2="8" stroke="#6688AA" strokeWidth="0.8" opacity={0.3 + Math.sin(now / 300 + 1) * 0.3} />
      <line x1="5" y1="4" x2="4" y2="8" stroke="#6688AA" strokeWidth="0.8" opacity={0.3 + Math.sin(now / 300 + 2) * 0.3} />
    </g>);
  } else if (type === 'teleporter') {
    // Transporter pad — concentric isometric rings on the floor
    const padCx = cx, padCy = cy + 2;
    items.push(<g key="pad">
      {/* Outer ring */}
      <ellipse cx={padCx} cy={padCy} rx={16} ry={8} fill="none" stroke="#4466CC" strokeWidth="1.5" opacity={0.5 + Math.sin(now / 400) * 0.2} />
      {/* Mid ring */}
      <ellipse cx={padCx} cy={padCy} rx={11} ry={5.5} fill="none" stroke="#6688EE" strokeWidth="1.2" opacity={0.6 + Math.sin(now / 350 + 1) * 0.2} />
      {/* Inner ring */}
      <ellipse cx={padCx} cy={padCy} rx={6} ry={3} fill="none" stroke="#88AAFF" strokeWidth="1" opacity={0.7 + Math.sin(now / 300 + 2) * 0.2} />
      {/* Center glow */}
      <ellipse cx={padCx} cy={padCy} rx={3} ry={1.5} fill="#88AAFF" opacity={0.3 + Math.sin(now / 250) * 0.15} />
      {/* Pad surface glow */}
      <ellipse cx={padCx} cy={padCy} rx={16} ry={8} fill="#4466CC" opacity={0.06 + Math.sin(now / 500) * 0.03} />
    </g>);
    // Shimmering particle beam — a few animated vertical lines and rising sparkles
    items.push(<g key="beam" opacity={0.4 + Math.sin(now / 600) * 0.15}>
      {/* Vertical energy lines */}
      {[- 6, -2, 2, 6].map((dx, i) => (
        <line key={`vl${i}`}
          x1={padCx + dx} y1={padCy - 28 + Math.sin(now / 200 + i * 1.5) * 3}
          x2={padCx + dx} y2={padCy - 2}
          stroke="#7799FF" strokeWidth={0.8} opacity={0.2 + Math.sin(now / 250 + i * 2) * 0.15}
          strokeDasharray="3,4" strokeDashoffset={-(now / 60 + i * 5) % 14} />
      ))}
      {/* Rising sparkle particles (6 total for performance) */}
      {[0, 1, 2, 3, 4, 5].map(i => {
        const phase = (now / 800 + i * 0.167) % 1; // 0→1 cycle per particle
        const px = padCx + Math.sin(i * 2.3) * 8;
        const py = padCy - phase * 30;
        return <circle key={`sp${i}`} cx={px} cy={py} r={0.8 + Math.sin(now / 200 + i) * 0.4}
          fill="#AACCFF" opacity={phase < 0.1 ? phase * 10 : phase > 0.85 ? (1 - phase) * 6.67 : 0.7} />;
      })}
    </g>);
    // Console panel on the back wall
    items.push(<g key="console" transform={`translate(${cx - 14}, ${cy - 10})`}>
      <rect x="-4" y="-6" width="8" height="5" rx="1" fill="#1A2040" stroke="#3A4A6A" strokeWidth="0.6" />
      <rect x="-3" y="-5" width="6" height="3" rx="0.5" fill="#2244AA" opacity="0.5" />
      {/* Blinking indicator */}
      <circle cx="5" cy="-4" r="1" fill={Math.sin(now / 350) > 0 ? '#44AAFF' : '#1A3366'} />
    </g>);
  } else if (type === 'error') {
    // Warning cones
    items.push(<g key="cone1" transform={`translate(${cx - 6}, ${cy + 2})`}>
      <polygon points="0,-8 3,0 -3,0" fill="#FF6B35" stroke="#E55B25" strokeWidth="0.5" />
      <line x1="-1.5" y1="-4" x2="1.5" y2="-4" stroke="white" strokeWidth="1.2" />
      <polygon points="0,0 4,-1 0,-2 -4,-1" fill="#FF6B35" opacity="0.6" />
    </g>);
    items.push(<g key="cone2" transform={`translate(${cx + 8}, ${cy + 5})`}>
      <polygon points="0,-8 3,0 -3,0" fill="#FF6B35" stroke="#E55B25" strokeWidth="0.5" />
      <line x1="-1.5" y1="-4" x2="1.5" y2="-4" stroke="white" strokeWidth="1.2" />
      <polygon points="0,0 4,-1 0,-2 -4,-1" fill="#FF6B35" opacity="0.6" />
    </g>);
    // Hazard tape
    items.push(<g key="tape" transform={`translate(${cx}, ${cy})`} opacity="0.5">
      <polygon points="0,-3 10,0 0,3 -10,0" fill="none" stroke="#FFD700" strokeWidth="1" strokeDasharray="3,3" />
    </g>);
  }

  return <>{items}</>;
}

// ─── Render a thick wall edge with optional door gap ─────────────────
function WallEdge({ start, end, colorFace, colorTop, door, hasNearbyWalker }: {
  start: {x:number,y:number}; end: {x:number,y:number}; colorFace: string; colorTop: string;
  door: DoorPosition | null; hasNearbyWalker: boolean;
}) {
  if (!door) {
    // Wall face
    const pts = `${start.x},${start.y - WALL_H} ${end.x},${end.y - WALL_H} ${end.x},${end.y} ${start.x},${start.y}`;
    // Wall top edge (thickness = 3px visual)
    const topPts = `${start.x},${start.y - WALL_H} ${end.x},${end.y - WALL_H} ${end.x - 1.5},${end.y - WALL_H - 2} ${start.x - 1.5},${start.y - WALL_H - 2}`;
    return <g>
      <polygon points={pts} fill={colorFace} stroke="rgba(0,0,0,0.15)" strokeWidth="0.5" />
      <polygon points={topPts} fill={colorTop} />
    </g>;
  }

  const { g1, g2 } = door;
  const isOpen = hasNearbyWalker;
  const mid = { x: (g1.x + g2.x) / 2, y: (g1.y + g2.y) / 2 };

  return <g>
    {/* Wall segment: start -> g1 */}
    <polygon points={`${start.x},${start.y - WALL_H} ${g1.x},${g1.y - WALL_H} ${g1.x},${g1.y} ${start.x},${start.y}`}
      fill={colorFace} stroke="rgba(0,0,0,0.15)" strokeWidth="0.5" />
    <polygon points={`${start.x},${start.y - WALL_H} ${g1.x},${g1.y - WALL_H} ${g1.x - 1.5},${g1.y - WALL_H - 2} ${start.x - 1.5},${start.y - WALL_H - 2}`}
      fill={colorTop} />
    {/* Wall segment: g2 -> end */}
    <polygon points={`${g2.x},${g2.y - WALL_H} ${end.x},${end.y - WALL_H} ${end.x},${end.y} ${g2.x},${g2.y}`}
      fill={colorFace} stroke="rgba(0,0,0,0.15)" strokeWidth="0.5" />
    <polygon points={`${g2.x},${g2.y - WALL_H} ${end.x},${end.y - WALL_H} ${end.x - 1.5},${end.y - WALL_H - 2} ${g2.x - 1.5},${g2.y - WALL_H - 2}`}
      fill={colorTop} />
    {/* Door frame */}
    <line x1={g1.x} y1={g1.y - WALL_H} x2={g1.x} y2={g1.y} stroke="#6A4A2A" strokeWidth="2" />
    <line x1={g2.x} y1={g2.y - WALL_H} x2={g2.x} y2={g2.y} stroke="#6A4A2A" strokeWidth="2" />
    <line x1={g1.x} y1={g1.y - WALL_H} x2={g2.x} y2={g2.y - WALL_H} stroke="#7A5A3A" strokeWidth="2.5" />
    {/* Door panels */}
    {!isOpen ? (
      <g>
        <polygon points={`${g1.x},${g1.y - WALL_H + 1.5} ${mid.x},${mid.y - WALL_H + 1.5} ${mid.x},${mid.y - 1} ${g1.x},${g1.y - 1}`}
          fill="#A07840" stroke="#8A6830" strokeWidth="0.6" />
        <polygon points={`${mid.x},${mid.y - WALL_H + 1.5} ${g2.x},${g2.y - WALL_H + 1.5} ${g2.x},${g2.y - 1} ${mid.x},${mid.y - 1}`}
          fill="#907030" stroke="#8A6830" strokeWidth="0.6" />
        {/* Door knobs */}
        <circle cx={g1.x * 0.55 + g2.x * 0.45} cy={(g1.y * 0.55 + g2.y * 0.45) - WALL_H / 2} r="1.3" fill="#D4AA60" stroke="#B08A40" strokeWidth="0.5" />
        <circle cx={g1.x * 0.45 + g2.x * 0.55} cy={(g1.y * 0.45 + g2.y * 0.55) - WALL_H / 2} r="1.3" fill="#D4AA60" stroke="#B08A40" strokeWidth="0.5" />
      </g>
    ) : (
      <g opacity="0.5">
        <line x1={g1.x} y1={g1.y - WALL_H + 1.5} x2={g1.x + 6} y2={g1.y - WALL_H - 4} stroke="#A07840" strokeWidth="1.5" />
        <line x1={g1.x} y1={g1.y - 1} x2={g1.x + 6} y2={g1.y - 6} stroke="#A07840" strokeWidth="1.5" />
        <line x1={g2.x} y1={g2.y - WALL_H + 1.5} x2={g2.x + 6} y2={g2.y - WALL_H - 4} stroke="#907030" strokeWidth="1.5" />
        <line x1={g2.x} y1={g2.y - 1} x2={g2.x + 6} y2={g2.y - 6} stroke="#907030" strokeWidth="1.5" />
      </g>
    )}
  </g>;
}

// ─── All four walls with doors on the correct face ───────────────────
function RoomWalls({ room, colorL, colorR, wallTop, hasNearbyWalker }: {
  room: IsoRoom; colorL: string; colorR: string; wallTop: string; hasNearbyWalker: boolean;
}) {
  const { top, right, bottom, left } = room.corners;
  const doorWall = room.doors[0]?.wall || null;
  const door = room.doors[0] || null;

  const neDoor = doorWall === 'ne' ? door : null;
  const nwDoor = doorWall === 'nw' ? door : null;
  const seDoor = doorWall === 'se' ? door : null;
  const swDoor = doorWall === 'sw' ? door : null;

  return <g>
    {/* Back walls (drawn first, behind everything) */}
    <WallEdge start={top} end={right} colorFace={colorL} colorTop={wallTop} door={neDoor} hasNearbyWalker={hasNearbyWalker} />
    <WallEdge start={top} end={left} colorFace={colorR} colorTop={wallTop} door={nwDoor} hasNearbyWalker={hasNearbyWalker} />
    {/* Front walls */}
    {(seDoor || !swDoor) && <WallEdge start={right} end={bottom} colorFace={colorR} colorTop={wallTop} door={seDoor} hasNearbyWalker={hasNearbyWalker} />}
    {(swDoor || !seDoor) && <WallEdge start={left} end={bottom} colorFace={colorL} colorTop={wallTop} door={swDoor} hasNearbyWalker={hasNearbyWalker} />}
  </g>;
}

// ─── Connection lines between rooms ──────────────────────────────────
export function IsoConnectionLine({ conn, now }: { conn: IsoConnection; now: number }) {
  const from = conn.fromDoor ? { x: conn.fromDoor.screenX, y: conn.fromDoor.screenY } : { x: conn.fromRoom.screenX, y: conn.fromRoom.screenY };
  const to = conn.toDoor ? { x: conn.toDoor.screenX, y: conn.toDoor.screenY } : { x: conn.toRoom.screenX, y: conn.toRoom.screenY };
  const dashOffset = -(now / 80) % 20;

  return (
    <g>
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y}
        stroke="rgba(100,90,70,0.15)" strokeWidth="2.5" strokeDasharray="6,8"
        strokeDashoffset={dashOffset} />
      {(() => {
        const mx = (from.x + to.x * 2) / 3, my = (from.y + to.y * 2) / 3;
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        return <polygon
          points="0,-3 7,0 0,3"
          fill="rgba(100,90,70,0.2)"
          transform={`translate(${mx},${my}) rotate(${angle * 180 / Math.PI})`}
        />;
      })()}
    </g>
  );
}

// ─── Water cooler placed in corridors ────────────────────────────────
export function WaterCooler({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x}, ${y})`}>
      {/* Base */}
      <polygon points="0,-4 6,0 0,4 -6,0" fill="#B0BEC5" stroke="#90A4AE" strokeWidth="0.5" />
      <polygon points="-6,0 -6,3 0,7 0,4" fill="#90A4AE" />
      <polygon points="6,0 6,3 0,7 0,4" fill="#78909C" />
      {/* Water bottle */}
      <rect x="-2.5" y="-12" width="5" height="7" rx="1.5" fill="#80C8E8" stroke="#60A8C8" strokeWidth="0.6" />
      <rect x="-2" y="-11" width="4" height="4" rx="1" fill="#A0D8F0" opacity="0.6" />
      {/* Cup holder */}
      <rect x="4" y="-4" width="3" height="3" rx="0.5" fill="#E0E0E0" stroke="#CCC" strokeWidth="0.4" />
    </g>
  );
}

// ─── Plant pot for corridors ─────────────────────────────────────────
export function CorridorPlant({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x}, ${y})`}>
      {/* Pot */}
      <polygon points="0,2 5,0 0,-2 -5,0" fill="#8B5E3C" />
      <polygon points="-5,0 -5,4 0,6 0,2" fill="#7B4E2C" />
      <polygon points="5,0 5,4 0,6 0,2" fill="#6B3E1C" />
      {/* Foliage */}
      <circle cx="0" cy="-4" r="6" fill="#3A8A3A" />
      <circle cx="-3" cy="-6" r="4.5" fill="#4A9A4A" />
      <circle cx="3" cy="-5" r="4" fill="#2A7A2A" />
      <circle cx="0" cy="-8" r="3" fill="#5AAA5A" />
    </g>
  );
}

// ─── Corridor floor tile (checkerboard pattern) ──────────────────────
export const IsoCorridorTile = React.memo(function IsoCorridorTile({ tile }: { tile: CorridorTile }) {
  const hw = TILE_W / 2 * 0.45;
  const hh = TILE_H / 2 * 0.45;
  const { screenX: cx, screenY: cy } = tile;
  const pts = `${cx},${cy - hh} ${cx + hw},${cy} ${cx},${cy + hh} ${cx - hw},${cy}`;
  // Checkerboard: alternate based on screen position
  const isLight = (Math.round(cx / 10) + Math.round(cy / 10)) % 2 === 0;
  return (
    <g>
      <polygon points={pts} fill={isLight ? '#8A8A96' : '#7A7A86'} stroke="#6A6A76" strokeWidth="0.5" />
    </g>
  );
});

// ─── Floor tiles with checkerboard pattern ───────────────────────────
function FloorTiles({ room, floorColor, floorAltColor }: { room: IsoRoom; floorColor: string; floorAltColor: string }) {
  const tiles: JSX.Element[] = [];
  const ox = room.corners.top.x - tileToScreen(room.tileX, room.tileY, 0, 0).x;
  const oy = room.corners.top.y - tileToScreen(room.tileX, room.tileY, 0, 0).y;

  for (let tx = 0; tx < room.tileW; tx++) {
    for (let ty = 0; ty < room.tileH; ty++) {
      const a = tileToScreen(room.tileX + tx, room.tileY + ty, 0, 0);
      const b = tileToScreen(room.tileX + tx + 1, room.tileY + ty, 0, 0);
      const c = tileToScreen(room.tileX + tx + 1, room.tileY + ty + 1, 0, 0);
      const d = tileToScreen(room.tileX + tx, room.tileY + ty + 1, 0, 0);
      const isLight = (tx + ty) % 2 === 0;
      tiles.push(
        <polygon key={`t${tx}_${ty}`}
          points={`${a.x + ox},${a.y + oy} ${b.x + ox},${b.y + oy} ${c.x + ox},${c.y + oy} ${d.x + ox},${d.y + oy}`}
          fill={isLight ? floorColor : floorAltColor}
          stroke="rgba(0,0,0,0.06)" strokeWidth="0.5" />
      );
    }
  }
  return <>{tiles}</>;
}

// ─── Main room component ─────────────────────────────────────────────
const IsoRoomComponent = React.memo(function IsoRoomComponent({ room, count, now, isHeatmap, isBottleneck, isDragOver, hasNearbyWalker }: IsoRoomProps) {
  const colors = ZONE_COLORS[room.zone.type] || ZONE_COLORS.desk;
  const { top, right, bottom, left } = room.corners;
  const isBusy = room.zone.capacity > 0 && count > room.zone.capacity;
  const floorPoints = `${top.x},${top.y} ${right.x},${right.y} ${bottom.x},${bottom.y} ${left.x},${left.y}`;

  let floorColor = colors.floor;
  let floorAltColor = colors.floorAlt;
  if (isHeatmap && room.zone.capacity > 0 && count > 0) {
    const ratio = count / room.zone.capacity;
    if (ratio >= 0.9) { floorColor = '#E8A0A0'; floorAltColor = '#D89090'; }
    else if (ratio >= 0.6) { floorColor = '#E8D0A0'; floorAltColor = '#D8C090'; }
    else { floorColor = '#A8D8A0'; floorAltColor = '#98C890'; }
  }
  if (isDragOver) { floorColor = '#A8E8A0'; floorAltColor = '#98D890'; }

  return (
    <g>
      {/* Drop shadow */}
      <polygon points={floorPoints} fill="rgba(0,0,0,0.2)" transform="translate(3, 6)" />

      {/* Floor base (clip boundary) */}
      <polygon points={floorPoints} fill={floorColor} />

      {/* Checkerboard floor tiles */}
      <FloorTiles room={room} floorColor={floorColor} floorAltColor={floorAltColor} />

      {/* Floor border */}
      <polygon points={floorPoints}
        fill="none"
        stroke={isDragOver ? '#3FB950' : isBottleneck ? '#D04040' : isBusy ? '#D0A030' : 'rgba(0,0,0,0.15)'}
        strokeWidth={isDragOver ? 2.5 : isBottleneck ? 2 : 1}
      />

      {/* Thick 3D walls */}
      <RoomWalls room={room} colorL={colors.wallL} colorR={colors.wallR} wallTop={colors.wallTop} hasNearbyWalker={hasNearbyWalker} />

      {/* Wall top accent line */}
      <line x1={top.x} y1={top.y - WALL_H - 2} x2={right.x - 1.5} y2={right.y - WALL_H - 2} stroke={colors.accent} strokeWidth="1" strokeOpacity="0.3" />
      <line x1={top.x} y1={top.y - WALL_H - 2} x2={left.x - 1.5} y2={left.y - WALL_H - 2} stroke={colors.accent} strokeWidth="1" strokeOpacity="0.3" />

      {/* Furniture */}
      <RoomFurniture room={room} now={now} />

      {/* Label */}
      <text x={room.screenX} y={room.screenY - room.screenBoundsH * 0.3} textAnchor="middle" fontSize="8"
        fill="rgba(60,50,40,0.7)" fontFamily="'JetBrains Mono', monospace" fontWeight="700"
        stroke="rgba(255,255,255,0.5)" strokeWidth="2" paintOrder="stroke">
        {room.zone.emoji} {room.zone.label}
      </text>

      {/* Population badge */}
      {count > 0 && (
        <g transform={`translate(${right.x + 6}, ${right.y - 2})`}>
          <circle cx="0" cy="0" r="9" fill={isBusy ? '#D0A030' : isBottleneck ? '#D04040' : '#485868'} stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
          <text x="0" y="1" textAnchor="middle" dominantBaseline="middle" fontSize="9" fill="white" fontWeight="bold">{count}</text>
        </g>
      )}

      {isBottleneck && (
        <text x={room.screenX} y={bottom.y + 12} textAnchor="middle" fontSize="8"
          fill="#D04040" fontFamily="monospace" fontWeight="700" opacity={0.6 + Math.sin(now / 400) * 0.3}
          stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" paintOrder="stroke">
          BOTTLENECK
        </text>
      )}
      {isBusy && !isBottleneck && (
        <text x={room.screenX} y={bottom.y + 12} textAnchor="middle" fontSize="7"
          fill="#D0A030" fontFamily="monospace" fontWeight="600" opacity={0.6 + Math.sin(now / 400) * 0.3}
          stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" paintOrder="stroke">
          BUSY
        </text>
      )}
    </g>
  );
});

export default IsoRoomComponent;
