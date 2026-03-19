import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { getWorkflows, getWorkflow, getInstances, getStats, repairInstance, redirectInstance, goToActivity } from './services/workflowApi';
import { useWorkflowHub } from './hooks/useWorkflowHub';
import { computeIsoLayout, pointInDiamond, randomPositionInRoom, tileToScreen, screenToTile } from './iso/isoEngine';
import type { IsoLayout, IsoRoom, DoorPosition } from './iso/isoEngine';
import IsoRoomComponent, { IsoConnectionLine, IsoCorridorTile, WaterCooler, CorridorPlant } from './iso/IsoRoom';
import type {
  WorkflowDefinition, WorkflowInstance, WorkflowStats, ZoneDefinition, ZoneStats, BottleneckInfo,
} from './types/workflow';

// ─── Animation types ─────────────────────────────────────────────────────
type PersonTrait = 'impatient' | 'relaxed' | 'social' | 'anxious' | 'normal';
type IdleAnim = 'phone' | 'tap-foot' | 'stretch' | 'yawn' | 'coffee' | 'watch' | 'fidget' | 'none';
type Emotion = 'happy' | 'sad' | 'nervous' | 'angry' | 'jump' | null;
type PersonState = 'walking' | 'idle' | 'queuing' | 'chatting' | 'sleeping' | 'error' | 'completed' | 'rejected';

interface AnimPerson {
  id: string;
  processInstanceId: number;
  name: string;
  zoneId: string;
  activityName: string;
  state: PersonState;
  folio: string;
  originator: string;
  waitTimeSeconds: number;
  errorMessage?: string;
  destinationUsers: string[];
  availableActions: string[];
  skin: string;
  shirt: string;
  trait: PersonTrait;
  x: number; y: number;
  targetX: number; targetY: number;
  angle: number;
  speed: number;
  walkCycle: number;
  moveTimer: number;
  waitTime: number;
  seed: number;
  idleAnim: IdleAnim;
  idleAnimTimer: number;
  chatPartner: string | null;
  emotion: Emotion;
  emotionTimer: number;
  // Multi-step walk: current pos → current room door → corridor waypoints → dest room door → inside door → final pos
  walkPhase: 'to-door' | 'corridor' | 'enter-room' | 'to-position' | null;
  walkFinalX: number;    // ultimate destination position inside the target room
  walkFinalY: number;
  walkDestZoneId: string | null; // destination zone id during multi-step walk
  corridorWaypoints: { x: number; y: number }[]; // waypoints along corridor to avoid cutting through rooms
  corridorWaypointIdx: number; // current waypoint index
  // Corridor behavior
  inCorridor: boolean;           // person is hanging out in the corridor
  corridorActivity: 'walking-ipad' | 'water-cooler' | 'strolling' | null;
  // Exit animation
  exitTimer: number;      // counts up from 0 when completed; at ~120 starts fading
  exitOpacity: number;    // 1 → 0 fade out
  exitConfetti: boolean;  // whether confetti burst is active
  // Ambulance animation
  ambulanceActive: boolean;
  ambulancePhase: 'driving-to' | 'loading' | 'driving-away' | 'done';
  ambulanceX: number;
  ambulanceY: number;
  ambulanceTargetX: number;
  ambulanceTargetY: number;
  ambulanceTimer: number;
  ambulanceWaypoints: { x: number; y: number }[];
  ambulanceWaypointIdx: number;
  prevState: PersonState | null;  // state before error, to detect transitions
  // Taxi animation (stop instance)
  taxiActive: boolean;
  taxiPhase: 'driving-to' | 'waving' | 'driving-away' | 'done';
  taxiX: number;
  taxiY: number;
  taxiTimer: number;
  taxiWaypoints: { x: number; y: number }[];
  taxiWaypointIdx: number;
  // Last action taken (shown as speech bubble when transitioning)
  lastAction: string | null;
  lastActionTimer: number;
  wavingBye: boolean;
  wavingByeTimer: number;
  // Umbrella drop animation
  umbrellaActive: boolean;
  umbrellaY: number;       // current Y during float-down
  umbrellaTargetY: number; // target Y to land at
}

// ─── Constants ───────────────────────────────────────────────────────────
const IDLE_ANIMS: IdleAnim[] = ['phone', 'tap-foot', 'stretch', 'yawn', 'coffee', 'watch', 'fidget', 'none'];

function seededRand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// ─── Day/Night cycle ────────────────────────────────────────────────────
// Returns 0-1 values for time-of-day lighting
function getDayPhase(date: Date) {
  const h = date.getHours() + date.getMinutes() / 60;
  // sunProgress: 0 = midnight, 0.5 = noon, 1 = midnight
  const sunProgress = (h % 24) / 24;

  // brightness: peaks at noon, lowest at midnight
  // Using a smooth cosine curve
  const brightness = 0.5 - 0.5 * Math.cos(sunProgress * Math.PI * 2 - Math.PI);

  // warmth: warm at sunrise/sunset, neutral midday, cool at night
  const distFromNoon = Math.abs(h - 12);
  const warmth = distFromNoon > 3 && distFromNoon < 9 ? (1 - Math.abs(distFromNoon - 6) / 3) : 0;

  const isNight = h < 6 || h >= 21;
  const isDawn = h >= 6 && h < 9;
  const isDusk = h >= 17 && h < 21;
  const isDay = h >= 9 && h < 17;

  return { brightness, warmth, isNight, isDawn, isDusk, isDay, hour: h };
}

function getDayOverlayColor(phase: ReturnType<typeof getDayPhase>): string {
  if (phase.isNight) return 'rgba(10, 15, 40, 0.35)';
  if (phase.isDawn) return `rgba(255, 180, 80, ${0.08 + phase.warmth * 0.07})`;
  if (phase.isDusk) return `rgba(255, 120, 60, ${0.06 + phase.warmth * 0.08})`;
  return 'rgba(255, 255, 255, 0.02)'; // daytime — very subtle bright
}

function getSkyGradient(phase: ReturnType<typeof getDayPhase>): [string, string] {
  if (phase.isNight) return ['#0a0f28', '#141830'];
  if (phase.isDawn) return ['#1a1520', '#2d1f35'];
  if (phase.isDusk) return ['#1a1218', '#201520'];
  return ['#0D1117', '#161B22']; // daytime default
}

// How tired a character looks based on wait time (hours in the system)
function getTiredness(waitTimeSeconds: number): number {
  const hours = waitTimeSeconds / 3600;
  if (hours < 2) return 0;
  if (hours < 8) return (hours - 2) / 6; // 0 to 1 over 2-8 hours
  return 1; // maxed out after 8 hours
}

// ─── Convert K2 instance to animated person ──────────────────────────────
function instanceToPerson(inst: WorkflowInstance, zones: ZoneDefinition[], layout?: IsoLayout | null): AnimPerson {
  const zone = zones.find(z => z.id === inst.currentZoneId);
  const room = layout?.rooms.find(r => r.zone.id === inst.currentZoneId);
  let bx: number, by: number, sx: number, sy: number;
  if (room) {
    const pos = randomPositionInRoom(room, seededRand(inst.processInstanceId));
    bx = pos.x; by = pos.y; sx = 0; sy = 0;
  } else {
    bx = zone ? zone.x : 70;
    by = zone ? zone.y : 260;
    const boundsW = zone ? zone.w : 40;
    const boundsH = zone ? zone.h : 40;
    sx = boundsW * 0.15 * (seededRand(inst.processInstanceId) * 2 - 1);
    sy = boundsH * 0.1 * (seededRand(inst.processInstanceId + 1) * 2 - 1);
  }
  const traits: PersonTrait[] = ['impatient', 'relaxed', 'social', 'anxious', 'normal'];

  let state: PersonState = 'idle';
  if (inst.state === 'error') state = 'error';
  else if (inst.state === 'completed') state = 'completed';
  else if (inst.state === 'sleeping') state = 'sleeping';
  else if (inst.state === 'rejected') state = 'rejected';
  else if (inst.waitTimeSeconds > 86400) state = 'sleeping';
  else if (inst.waitTimeSeconds > 3600) state = 'idle';

  return {
    id: inst.id,
    processInstanceId: inst.processInstanceId,
    name: inst.name,
    zoneId: inst.currentZoneId,
    activityName: inst.currentActivityName,
    state,
    folio: inst.folio,
    originator: inst.originator,
    waitTimeSeconds: inst.waitTimeSeconds,
    errorMessage: inst.errorMessage,
    destinationUsers: inst.destinationUsers || [],
    availableActions: inst.availableActions || [],
    skin: inst.skinColor,
    shirt: inst.shirtColor,
    trait: (inst.trait as PersonTrait) || traits[Math.abs(inst.processInstanceId * 17) % 5],
    x: bx + sx, y: by + sy,
    targetX: bx + sx, targetY: by + sy,
    angle: seededRand(inst.processInstanceId + 2) * Math.PI * 2,
    speed: inst.trait === 'impatient' ? 0.55 : inst.trait === 'relaxed' ? 0.25 : 0.35,
    walkCycle: seededRand(inst.processInstanceId + 3) * 100,
    moveTimer: 40 + seededRand(inst.processInstanceId + 4) * 120,
    waitTime: inst.waitTimeSeconds,
    seed: seededRand(inst.processInstanceId + 5),
    idleAnim: 'none',
    idleAnimTimer: 0,
    chatPartner: null,
    emotion: state === 'completed' ? 'jump' : null,
    emotionTimer: state === 'completed' ? 80 : 0,
    exitTimer: state === 'completed' ? 1 : 0,
    exitOpacity: 1,
    exitConfetti: state === 'completed',
    ambulanceActive: false,
    ambulancePhase: 'done',
    ambulanceX: 0,
    ambulanceY: 0,
    ambulanceTargetX: 0,
    ambulanceTargetY: 0,
    ambulanceTimer: 0,
    ambulanceWaypoints: [],
    ambulanceWaypointIdx: 0,
    prevState: null,
    lastAction: null,
    lastActionTimer: 0,
    walkPhase: null,
    walkFinalX: 0,
    walkFinalY: 0,
    inCorridor: false,
    corridorActivity: null,
    walkDestZoneId: null,
    corridorWaypoints: [],
    corridorWaypointIdx: 0,
    taxiActive: false,
    taxiPhase: 'done',
    taxiX: 0,
    taxiY: 0,
    taxiTimer: 0,
    taxiWaypoints: [],
    taxiWaypointIdx: 0,
    wavingBye: false,
    wavingByeTimer: 0,
    umbrellaActive: false,
    umbrellaY: 0,
    umbrellaTargetY: 0,
  };
}

// ─── Compute corridor waypoints between two doors ────────────────────────
// Full path: inside room → door → OUTSIDE door → corridor center → along corridor → OUTSIDE dest door → dest door → inside dest room
// The outside points ensure characters visually pass through the door gap, not through walls
function computeCorridorWaypoints(
  fromDoor: DoorPosition,
  toDoor: DoorPosition,
  layout: IsoLayout
): { x: number; y: number }[] {
  if (layout.corridors.length === 0) {
    return [
      { x: fromDoor.outsideX, y: fromDoor.outsideY },
      { x: toDoor.outsideX, y: toDoor.outsideY },
      { x: toDoor.screenX, y: toDoor.screenY },
    ];
  }

  const ox = layout.offsetX, oy = layout.offsetY;
  const corridorTY = layout.corridorCenterTileY;

  // Convert outside-door positions to tile space for corridor routing
  const fromTile = screenToTile(fromDoor.outsideX, fromDoor.outsideY, ox, oy);
  const toTile = screenToTile(toDoor.outsideX, toDoor.outsideY, ox, oy);

  const waypoints: { x: number; y: number }[] = [];

  // 1. Step outside the source door
  waypoints.push({ x: fromDoor.outsideX, y: fromDoor.outsideY });

  // 2. Walk to corridor center (same tileX as source, corridor tileY)
  const fromDistToCorr = Math.abs(fromTile.ty - corridorTY);
  if (fromDistToCorr > 0.5) {
    const wp1Screen = tileToScreen(fromTile.tx, corridorTY, ox, oy);
    waypoints.push(wp1Screen);
  }

  // 3. Walk along corridor to align with destination door
  const toDistToCorr = Math.abs(toTile.ty - corridorTY);
  if (Math.abs(fromTile.tx - toTile.tx) > 0.5) {
    const wp2Screen = tileToScreen(toTile.tx, corridorTY, ox, oy);
    waypoints.push(wp2Screen);
  }

  // 4. Walk from corridor to just outside destination door
  if (toDistToCorr > 0.5) {
    waypoints.push({ x: toDoor.outsideX, y: toDoor.outsideY });
  }

  // 5. Step through destination door
  waypoints.push({ x: toDoor.screenX, y: toDoor.screenY });

  return waypoints;
}

// ─── Get position inside room diamond using layout ───────────────────────
function getPositionInRoom(room: IsoRoom, seed?: number): { x: number; y: number } {
  return randomPositionInRoom(room, seed ?? Math.random());
}

// ─── Compute vehicle route from corridor entrance to a door ──────────────
// Vehicles enter from the left side of the corridor, drive along it, then branch to the door
function computeVehicleRoute(
  targetDoor: DoorPosition,
  layout: IsoLayout,
  reverse = false // if true, route goes from door to exit (driving away)
): { x: number; y: number }[] {
  const ox = layout.offsetX, oy = layout.offsetY;
  const corridorTY = layout.corridorCenterTileY;

  // Find leftmost corridor tile for entrance point
  let minTX = Infinity;
  for (const c of layout.corridors) {
    const t = screenToTile(c.screenX, c.screenY, ox, oy);
    minTX = Math.min(minTX, t.tx);
  }

  // Entrance point: far left of corridor, slightly off-screen
  const entranceScreen = tileToScreen(minTX - 3, corridorTY, ox, oy);

  // Door's outside point in tile space
  const doorTile = screenToTile(targetDoor.outsideX, targetDoor.outsideY, ox, oy);

  // Waypoints: entrance → corridor at door's tileX → outside door
  const corridorAtDoor = tileToScreen(doorTile.tx, corridorTY, ox, oy);

  const route = [
    entranceScreen,
    corridorAtDoor,
    { x: targetDoor.outsideX, y: targetDoor.outsideY },
  ];

  return reverse ? [...route].reverse() : route;
}

// ─── Shared merge logic for updating a person from K2 instance data ──────
function mergePersonWithInstance(existing: AnimPerson, inst: WorkflowInstance, wf: WorkflowDefinition, layout?: IsoLayout | null): AnimPerson {
  // Detect transition TO error → trigger ambulance
  if (inst.state === 'error' && existing.state !== 'error' && !existing.ambulanceActive) {
    // Compute ambulance route: corridor entrance → person's door
    const personRoom = layout?.rooms.find(r => r.zone.id === existing.zoneId);
    const personDoor = personRoom?.doors[0];
    let ambWaypoints: { x: number; y: number }[] = [];
    let startX: number, startY: number;

    if (personDoor && layout) {
      ambWaypoints = computeVehicleRoute(personDoor, layout);
      startX = ambWaypoints[0].x;
      startY = ambWaypoints[0].y;
    } else {
      startX = (wf.width || 950) + 40;
      startY = existing.y;
    }

    return {
      ...existing, waitTimeSeconds: inst.waitTimeSeconds, errorMessage: inst.errorMessage,
      destinationUsers: inst.destinationUsers || [], availableActions: inst.availableActions || [],
      ambulanceActive: true, ambulancePhase: 'driving-to' as const,
      ambulanceX: startX, ambulanceY: startY,
      ambulanceTargetX: personDoor ? personDoor.outsideX : existing.x,
      ambulanceTargetY: personDoor ? personDoor.outsideY : existing.y,
      ambulanceWaypoints: ambWaypoints, ambulanceWaypointIdx: 0,
      ambulanceTimer: 0, prevState: existing.state,
    };
  }
  // Zone changed → walk to new zone via doors (3-step walk)
  if (existing.zoneId !== inst.currentZoneId) {
    console.log(`[Merge] ${existing.id}: zone change ${existing.zoneId} → ${inst.currentZoneId}, state=${inst.state}, walkPhase=${existing.walkPhase}`);
  }
  // Skip if already walking to this zone
  const alreadyWalking = existing.state === 'walking' && existing.walkDestZoneId === inst.currentZoneId;
  if (existing.zoneId !== inst.currentZoneId && inst.state !== 'error' && !alreadyWalking) {
    const zone = wf.zones.find(z => z.id === inst.currentZoneId);
    if (zone) {
      const prevActions = existing.availableActions || [];
      const actionTaken = prevActions.length === 1 ? prevActions[0] : prevActions.length > 1 ? 'Actioned' : null;

      // Target position: use room diamond if available, else zone center
      const destRoom = layout?.rooms.find(r => r.zone.id === inst.currentZoneId);
      let finalX: number, finalY: number;
      if (destRoom) {
        const pos = getPositionInRoom(destRoom, Math.random());
        finalX = pos.x;
        finalY = pos.y;
      } else {
        finalX = zone.x + (Math.random() - 0.5) * zone.w * 0.15;
        finalY = zone.y + (Math.random() - 0.5) * zone.h * 0.1;
      }

      // Try to find the current room's door for multi-step walking
      const currentRoom = layout?.rooms.find(r => r.zone.id === existing.zoneId);
      const currentDoor = currentRoom?.doors[0];

      if (currentDoor && layout) {
        // Compute corridor waypoints to avoid walking through rooms
        const destDoor = destRoom?.doors[0];
        const waypoints = destDoor
          ? computeCorridorWaypoints(currentDoor, destDoor, layout)
          : [];

        // Start multi-step walk: first go to current room's door
        return {
          ...existing,
          walkPhase: 'to-door' as const,
          walkDestZoneId: inst.currentZoneId,
          walkFinalX: finalX,
          walkFinalY: finalY,
          corridorWaypoints: waypoints,
          corridorWaypointIdx: 0,
          targetX: currentDoor.screenX,
          targetY: currentDoor.screenY,
          state: 'walking' as PersonState, chatPartner: null,
          destinationUsers: inst.destinationUsers || [], availableActions: inst.availableActions || [],
          lastAction: actionTaken, lastActionTimer: actionTaken ? 200 : 0,
          emotion: 'happy' as Emotion, emotionTimer: 80,
        };
      }

      // Fallback: direct walk (no layout available)
      return {
        ...existing, zoneId: inst.currentZoneId,
        walkPhase: null, walkDestZoneId: null, walkFinalX: 0, walkFinalY: 0,
        targetX: finalX,
        targetY: finalY,
        state: 'walking' as PersonState, chatPartner: null,
        destinationUsers: inst.destinationUsers || [], availableActions: inst.availableActions || [],
        lastAction: actionTaken, lastActionTimer: actionTaken ? 200 : 0,
        emotion: 'happy' as Emotion, emotionTimer: 80,
      };
    }
  }
  // Just update metadata
  return {
    ...existing, waitTimeSeconds: inst.waitTimeSeconds, errorMessage: inst.errorMessage,
    destinationUsers: inst.destinationUsers || [], availableActions: inst.availableActions || [],
  };
}

// ─── Simulation step ─────────────────────────────────────────────────────
function simulate(people: AnimPerson[], zones: ZoneDefinition[], dt: number, layout?: IsoLayout | null): AnimPerson[] {
  // Pre-build lookups to avoid O(n*z) zone.find() calls in the hot path
  const zoneMap = new Map<string, ZoneDefinition>();
  let errorZone: ZoneDefinition | undefined;
  for (const z of zones) {
    zoneMap.set(z.id, z);
    if (z.type === 'error') errorZone = z;
  }
  const byZone: Record<string, AnimPerson[]> = {};
  people.forEach(p => { if (!byZone[p.zoneId]) byZone[p.zoneId] = []; byZone[p.zoneId].push(p); });

  const result = people.filter(p => p.exitOpacity > 0.01).map(orig => {
    const p = { ...orig };
    p.walkCycle += dt * 0.04;
    p.moveTimer -= dt;
    if (p.emotionTimer > 0) p.emotionTimer -= dt;
    if (p.lastActionTimer > 0) p.lastActionTimer -= dt;

    // Umbrella float-down animation
    if (p.umbrellaActive) {
      const dy = p.umbrellaTargetY - p.umbrellaY;
      if (Math.abs(dy) > 1) {
        p.umbrellaY += dy * 0.03 * dt; // gentle float
        p.y = p.umbrellaY;
        p.x += Math.sin(Date.now() / 300 + p.seed * 10) * 0.3 * dt; // gentle sway
      } else {
        p.umbrellaActive = false;
        p.y = p.umbrellaTargetY;
        p.state = 'idle';
        p.emotion = 'happy';
        p.emotionTimer = 60;
        p.moveTimer = 60;
      }
      return p; // skip other movement while floating
    }

    // ─── Completed exit animation ────────────────────────────
    if (p.state === 'completed') {
      p.exitTimer += dt;
      // Phase 1 (0-60): celebrate in place with jump
      if (p.exitTimer < 60) {
        p.emotion = 'jump';
        p.emotionTimer = 20;
        p.exitConfetti = true;
      }
      // Phase 2 (60-120): drift upward and wave
      else if (p.exitTimer < 120) {
        p.y -= dt * 0.3;
        p.exitConfetti = true;
        p.emotion = 'happy';
        p.emotionTimer = 20;
      }
      // Phase 3 (120+): fade out
      else {
        p.y -= dt * 0.2;
        p.exitOpacity = Math.max(0, p.exitOpacity - dt * 0.008);
        p.exitConfetti = false;
      }
      return p;
    }

    // ─── Waving bye timer decay ────────────────────────────────
    if (p.wavingBye && p.wavingByeTimer > 0) {
      p.wavingByeTimer -= dt;
      if (p.wavingByeTimer <= 0) { p.wavingBye = false; }
    }

    // ─── Taxi animation (stop instance) ─────────────────────────
    if (p.taxiActive && p.taxiPhase !== 'done') {
      p.taxiTimer += dt;
      const taxiSpeed = 1.5 * dt;

      if (p.taxiPhase === 'driving-to') {
        // Taxi follows waypoints to reach the door
        const wp = p.taxiWaypoints[p.taxiWaypointIdx];
        if (wp) {
          const dx = wp.x - p.taxiX;
          const dy = wp.y - p.taxiY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 8) {
            p.taxiX += (dx / dist) * taxiSpeed;
            p.taxiY += (dy / dist) * taxiSpeed;
          } else {
            // Reached this waypoint, advance to next
            if (p.taxiWaypointIdx < p.taxiWaypoints.length - 1) {
              p.taxiWaypointIdx++;
            }
          }
        }
        // Check if BOTH taxi arrived at final waypoint AND person arrived at door
        const lastWp = p.taxiWaypoints[p.taxiWaypoints.length - 1];
        const taxiAtDest = lastWp ? Math.sqrt((lastWp.x - p.taxiX) ** 2 + (lastWp.y - p.taxiY) ** 2) <= 8 : true;
        const personDx = p.targetX - p.x;
        const personDy = p.targetY - p.y;
        const personDist = Math.sqrt(personDx * personDx + personDy * personDy);
        if (taxiAtDest && personDist <= 5) {
          p.taxiPhase = 'waving';
          p.taxiTimer = 0;
          p.state = 'idle';
          p.emotion = 'happy';
          p.emotionTimer = 100;
        }
        // Person still walks during driving-to phase (handled by walking logic below)
      } else if (p.taxiPhase === 'waving') {
        if (p.taxiTimer > 80) {
          // Compute exit route (reverse of arrival)
          p.taxiPhase = 'driving-away';
          p.taxiTimer = 0;
          p.taxiWaypointIdx = 0;
          // Reverse the waypoints for driving away
          p.taxiWaypoints = [...p.taxiWaypoints].reverse();
        }
        return p;
      } else if (p.taxiPhase === 'driving-away') {
        // Taxi follows waypoints back out, person rides along
        const wp = p.taxiWaypoints[p.taxiWaypointIdx];
        if (wp) {
          const dx = wp.x - p.taxiX;
          const dy = wp.y - p.taxiY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 8) {
            p.taxiX += (dx / dist) * taxiSpeed * 1.5;
            p.taxiY += (dy / dist) * taxiSpeed * 1.5;
          } else if (p.taxiWaypointIdx < p.taxiWaypoints.length - 1) {
            p.taxiWaypointIdx++;
          } else {
            // Reached exit — done
            p.taxiPhase = 'done';
            p.taxiActive = false;
            p.exitOpacity = 0;
          }
        } else {
          p.taxiPhase = 'done';
          p.taxiActive = false;
          p.exitOpacity = 0;
        }
        p.x = p.taxiX;
        p.y = p.taxiY;
        p.exitOpacity = Math.max(0.1, 1 - p.taxiTimer / 80);
        return p;
      }
      // During 'driving-to', let the walking logic below also run so person walks to door
    }

    // ─── Ambulance animation ─────────────────────────────────
    if (p.ambulanceActive && p.ambulancePhase !== 'done') {
      p.ambulanceTimer += dt;
      const ambSpeed = 1.2 * dt;

      if (p.ambulancePhase === 'driving-to') {
        // Ambulance follows waypoints to reach the person's door
        const wp = p.ambulanceWaypoints[p.ambulanceWaypointIdx];
        if (wp) {
          const dx = wp.x - p.ambulanceX;
          const dy = wp.y - p.ambulanceY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 8) {
            p.ambulanceX += (dx / dist) * ambSpeed;
            p.ambulanceY += (dy / dist) * ambSpeed;
          } else if (p.ambulanceWaypointIdx < p.ambulanceWaypoints.length - 1) {
            p.ambulanceWaypointIdx++;
          } else {
            // Arrived at person's door — loading phase
            p.ambulancePhase = 'loading';
            p.ambulanceTimer = 0;
            p.emotion = 'nervous';
            p.emotionTimer = 40;
            // Move person to the door
            const personRoom = layout?.rooms.find(r => r.zone.id === p.zoneId);
            const personDoor = personRoom?.doors[0];
            if (personDoor) {
              p.x = personDoor.screenX;
              p.y = personDoor.screenY;
            }
          }
        }
      } else if (p.ambulancePhase === 'loading') {
        // Brief pause while "loading" the person
        if (p.ambulanceTimer > 40) {
          // Compute route to error room's door
          const errorRoom = layout?.rooms.find(r => r.zone.id === 'error-corner');
          const errorDoor = errorRoom?.doors[0];
          if (errorDoor && layout) {
            const route = computeVehicleRoute(errorDoor, layout);
            // We're already at the person's door, so route from current pos to error door
            // Reverse the entrance route (we go from here along corridor to error door)
            const personRoom = layout.rooms.find(r => r.zone.id === p.zoneId);
            const personDoor = personRoom?.doors[0];
            if (personDoor) {
              // Build route: person door outside → corridor → error door outside
              const doorTile = screenToTile(personDoor.outsideX, personDoor.outsideY, layout.offsetX, layout.offsetY);
              const errDoorTile = screenToTile(errorDoor.outsideX, errorDoor.outsideY, layout.offsetX, layout.offsetY);
              const corridorTY = layout.corridorCenterTileY;
              const wp1 = tileToScreen(doorTile.tx, corridorTY, layout.offsetX, layout.offsetY);
              const wp2 = tileToScreen(errDoorTile.tx, corridorTY, layout.offsetX, layout.offsetY);
              p.ambulanceWaypoints = [
                wp1,
                wp2,
                { x: errorDoor.outsideX, y: errorDoor.outsideY },
              ];
            } else {
              p.ambulanceWaypoints = [{ x: errorDoor.outsideX, y: errorDoor.outsideY }];
            }
            p.ambulanceTargetX = errorDoor.outsideX;
            p.ambulanceTargetY = errorDoor.outsideY;
          } else {
            const errorZone = zoneMap.get('error-corner');
            if (errorZone) {
              p.ambulanceTargetX = errorZone.x;
              p.ambulanceTargetY = errorZone.y;
            }
            p.ambulanceWaypoints = [{ x: p.ambulanceTargetX, y: p.ambulanceTargetY }];
          }
          p.ambulanceWaypointIdx = 0;
          p.ambulancePhase = 'driving-away';
          p.ambulanceTimer = 0;
        }
      } else if (p.ambulancePhase === 'driving-away') {
        // Ambulance follows waypoints to error room door
        const wp = p.ambulanceWaypoints[p.ambulanceWaypointIdx];
        p.x = p.ambulanceX;
        p.y = p.ambulanceY;
        let ambArrived = false;
        if (wp) {
          const dx = wp.x - p.ambulanceX;
          const dy = wp.y - p.ambulanceY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 8) {
            p.ambulanceX += (dx / dist) * ambSpeed;
            p.ambulanceY += (dy / dist) * ambSpeed;
          } else if (p.ambulanceWaypointIdx < p.ambulanceWaypoints.length - 1) {
            p.ambulanceWaypointIdx++;
          } else {
            ambArrived = true;
          }
        } else {
          ambArrived = true;
        }
        if (ambArrived) {
          // Arrived outside error room door — now walk through door into room
          p.ambulancePhase = 'done';
          p.ambulanceActive = false;
          p.zoneId = 'error-corner';
          p.x = p.ambulanceTargetX;
          p.y = p.ambulanceTargetY;
          const errorRoom = layout?.rooms.find(r => r.zone.id === 'error-corner');
          const errDoor = errorRoom?.doors[0];
          if (errorRoom && errDoor) {
            const finalPos = getPositionInRoom(errorRoom, Math.random());
            p.state = 'walking';
            // Walk: outside → door → center → final position
            // Use corridor waypoints with just [door, center] as targets
            p.walkPhase = 'corridor';
            p.corridorWaypoints = [
              { x: errDoor.screenX, y: errDoor.screenY },  // through the door
            ];
            p.corridorWaypointIdx = 0;
            p.targetX = errDoor.screenX;
            p.targetY = errDoor.screenY;
            p.walkDestZoneId = 'error-corner';
            p.walkFinalX = finalPos.x;
            p.walkFinalY = finalPos.y;
            p.inCorridor = false;
          } else {
            p.targetX = p.x;
            p.targetY = p.y;
            p.state = 'error';
          }
          p.emotion = 'angry';
          p.emotionTimer = 60;
        }
      }
      return p;
    }

    // Error/completed/rejected — don't wander, just stay in place
    const st = p.state as string;
    if (st === 'error' || st === 'completed' || st === 'rejected') {
      if (p.exitConfetti) {
        p.exitTimer += dt * 0.5;
        if (p.exitTimer > 120) p.exitOpacity = Math.max(0, p.exitOpacity - dt * 0.008);
      }
      return p;
    }

    // Idle animation cycling
    if (p.state === 'idle' || p.state === 'queuing') {
      p.idleAnimTimer -= dt;
      if (p.idleAnimTimer <= 0) {
        if (p.trait === 'impatient') p.idleAnim = (['tap-foot', 'watch', 'fidget', 'phone'] as IdleAnim[])[Math.floor(Math.random() * 4)];
        else if (p.trait === 'relaxed') p.idleAnim = (['coffee', 'phone', 'stretch', 'none'] as IdleAnim[])[Math.floor(Math.random() * 4)];
        else if (p.trait === 'anxious') p.idleAnim = (['fidget', 'watch', 'none', 'phone'] as IdleAnim[])[Math.floor(Math.random() * 4)];
        else p.idleAnim = IDLE_ANIMS[Math.floor(Math.random() * IDLE_ANIMS.length)];
        p.idleAnimTimer = 80 + Math.random() * 200;
      }
    }

    // Social chatting
    if ((p.state === 'idle' || p.state === 'queuing') && !p.chatPartner && p.trait === 'social') {
      const neighbors = (byZone[p.zoneId] || []).filter(o => o.id !== p.id && (o.state === 'idle' || o.state === 'queuing' || o.state === 'chatting'));
      if (neighbors.length > 0 && Math.random() < 0.008 * dt) {
        const partner = neighbors[Math.floor(Math.random() * neighbors.length)];
        if (Math.sqrt((partner.x - p.x) ** 2 + (partner.y - p.y) ** 2) < 50) {
          p.state = 'chatting'; p.chatPartner = partner.id; p.moveTimer = 100 + Math.random() * 200;
        }
      }
    }
    if (p.state === 'chatting' && p.moveTimer <= 0) {
      p.state = 'idle'; p.chatPartner = null; p.moveTimer = 40 + Math.random() * 80;
    }

    // Walking (with multi-step door-to-door phases)
    if (p.state === 'walking') {
      const dx = p.targetX - p.x, dy = p.targetY - p.y, dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 2) { p.angle = Math.atan2(dy, dx); p.x += (dx / dist) * p.speed * dt; p.y += (dy / dist) * p.speed * dt; }
      else {
        // Arrived at current target — check walk phase
        if (p.walkPhase === 'to-door' && p.walkDestZoneId && layout) {
          // Arrived at current room's door → follow corridor waypoints
          if (p.corridorWaypoints.length > 0) {
            p.walkPhase = 'corridor';
            p.inCorridor = true;
            p.corridorActivity = (['walking-ipad', 'strolling', 'strolling'] as const)[Math.floor(Math.random() * 3)];
            p.corridorWaypointIdx = 0;
            p.targetX = p.corridorWaypoints[0].x;
            p.targetY = p.corridorWaypoints[0].y;
          } else {
            // No waypoints — go directly to final pos
            p.walkPhase = 'to-position';
            p.zoneId = p.walkDestZoneId;
            p.targetX = p.walkFinalX;
            p.targetY = p.walkFinalY;
          }
        } else if (p.walkPhase === 'corridor' && p.walkDestZoneId && layout) {
          // Following corridor waypoints
          const nextIdx = p.corridorWaypointIdx + 1;
          if (nextIdx < p.corridorWaypoints.length) {
            // More waypoints to follow
            p.corridorWaypointIdx = nextIdx;
            p.targetX = p.corridorWaypoints[nextIdx].x;
            p.targetY = p.corridorWaypoints[nextIdx].y;
          } else {
            // All waypoints done → enter destination room
            const destRoom = layout.rooms.find(r => r.zone.id === p.walkDestZoneId);
            p.walkPhase = 'enter-room';
            p.zoneId = p.walkDestZoneId;
            p.inCorridor = false;
            p.corridorActivity = null;
            p.corridorWaypoints = [];
            p.corridorWaypointIdx = 0;
            // Target is the room center (guaranteed inside the diamond)
            p.targetX = destRoom ? destRoom.screenX : p.walkFinalX;
            p.targetY = destRoom ? destRoom.screenY : p.walkFinalY;
          }
        } else if (p.walkPhase === 'enter-room') {
          // Arrived at room center → now walk to final position within the room
          p.walkPhase = 'to-position';
          p.targetX = p.walkFinalX;
          p.targetY = p.walkFinalY;
        } else if (p.walkPhase === 'to-position') {
          // Arrived at final position inside room
          p.walkPhase = null;
          p.walkDestZoneId = null;
          p.state = 'idle';
          p.moveTimer = 60 + Math.random() * 150;
        } else {
          // Simple walk (no phases) — arrived, become idle
          const zone = zoneMap.get(p.zoneId);
          if (zone) {
            p.state = 'idle';
            p.moveTimer = 60 + Math.random() * 150;
          }
        }
      }
    }

    // Idle wander within zone (skip error/completed/rejected — they stay put)
    // People only go to corridors when K2 moves them between tasks (handled by walk phases)
    if ((p.state === 'idle' || p.state === 'queuing') && p.moveTimer <= 0) {
      p.inCorridor = false;
      p.corridorActivity = null;
      const zone = zoneMap.get(p.zoneId);
      if (zone && zone.type !== 'error' && zone.type !== 'exit-good' && zone.type !== 'exit-bad') {
        // Use room diamond for wander target to stay within walls
        const room = layout?.rooms.find(r => r.zone.id === p.zoneId);
        if (room) {
          const pos = getPositionInRoom(room, Math.random());
          p.targetX = pos.x;
          p.targetY = pos.y;
        } else {
          const wanderR = Math.min(zone.w, zone.h) * 0.12;
          p.targetX = zone.x + (Math.random() * 2 - 1) * wanderR;
          p.targetY = zone.y + (Math.random() * 2 - 1) * wanderR * 0.5;
        }
        p.state = 'walking';
        p.walkPhase = null;
        p.walkDestZoneId = null;
      } else {
        p.moveTimer = 60 + Math.random() * 120;
      }
    }

    // Sleep from long idle (only visual — real state comes from API)
    if ((p.state === 'idle' || p.state === 'queuing') && p.trait !== 'impatient') {
      p.waitTime += dt * 0.08;
      if (p.waitTime > 250 && Math.random() < 0.004 * dt) {
        p.state = 'sleeping'; p.moveTimer = 200 + Math.random() * 400; p.idleAnim = 'none';
      }
    } else if (p.state === 'walking') p.waitTime = Math.max(0, p.waitTime - dt * 0.1);

    if (p.state === 'sleeping' && Math.random() < 0.01 * dt) {
      p.state = 'idle'; p.moveTimer = 30 + Math.random() * 60; p.emotion = 'happy'; p.emotionTimer = 40;
    }

    // Anxious near error zone
    if (p.trait === 'anxious' && !p.emotion) {
      if (errorZone && Math.sqrt((p.x - errorZone.x) ** 2 + (p.y - errorZone.y) ** 2) < 80 && Math.random() < 0.005 * dt) {
        p.emotion = 'nervous'; p.emotionTimer = 60;
      }
    }

    return p;
  });

  // Post-process: trigger nearby people waving when someone is in taxi waving phase
  const wavers = result.filter(p => p.taxiActive && p.taxiPhase === 'waving' && p.taxiTimer < 5);
  if (wavers.length > 0) {
    for (const waver of wavers) {
      for (const p of result) {
        if (p.id === waver.id || p.wavingBye || p.taxiActive) continue;
        const st = p.state as string;
        if (st === 'error' || st === 'completed') continue;
        const dist = Math.sqrt((p.x - waver.x) ** 2 + (p.y - waver.y) ** 2);
        if (dist < 100) { p.wavingBye = true; p.wavingByeTimer = 80; }
      }
    }
  }

  return result;
}

// ─── PersonSprite SVG ────────────────────────────────────────────────────
function PersonSprite({ p, now, isSelected, showNames, onClick, onDragStart, onContextMenu }: {
  p: AnimPerson; now: number; isSelected: boolean; showNames: boolean; onClick: () => void; onDragStart?: () => void; onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const { x, y, skin, shirt, state, name, angle, walkCycle, trait, idleAnim, emotion, emotionTimer } = p;
  const isErr = state === 'error', isSleep = state === 'sleeping', isWalk = state === 'walking';
  const isDone = state === 'completed', isRejected = state === 'rejected', isChat = state === 'chatting';
  const isWalkingToError = isWalk && p.zoneId === 'error-corner';
  const tiredness = getTiredness(p.waitTimeSeconds);
  const bob = isWalk ? Math.sin(walkCycle * 8) * 1.8 : 0;
  const jumpY = emotion === 'jump' && emotionTimer > 0 ? -Math.abs(Math.sin(now / 120)) * 8 : 0;
  const slumpY = isRejected ? 3 : isErr ? 2 + Math.sin(now / 600) * 1.5 : 0;
  const fidgetX = trait === 'impatient' && (state === 'idle' || state === 'queuing') ? Math.sin(now / 100 + p.seed) * 1.5 : 0;
  const paceX = trait === 'anxious' && state === 'idle' ? Math.sin(now / 400 + p.seed) * 8 : 0;
  // Anxious wobble when walking to error zone
  const anxiousWobble = isWalkingToError ? Math.sin(now / 80 + p.seed) * 2 : 0;
  // Sick sway when in error state
  const sickSway = isErr ? Math.sin(now / 500 + p.seed) * 3 : 0;

  let emotionEmoji: string | null = null;
  if (emotion === 'happy') emotionEmoji = '😊';
  if (emotion === 'sad') emotionEmoji = '😞';
  if (emotion === 'nervous') emotionEmoji = '😰';
  if (emotion === 'angry') emotionEmoji = '😤';
  // Walking to error → anxious face
  if (isWalkingToError) emotionEmoji = '😰';
  // In error state → sick face
  if (isErr) emotionEmoji = '🤢';

  return (
    <g transform={`translate(${x + fidgetX + paceX + anxiousWobble + sickSway}, ${y + bob + jumpY + slumpY}) scale(0.55)`}
      onClick={e => { e.stopPropagation(); onClick(); }}
      onMouseDown={e => { if (e.button === 0 && onDragStart) { e.preventDefault(); e.stopPropagation(); onDragStart(); } }}
      onContextMenu={e => { if (onContextMenu) { e.preventDefault(); e.stopPropagation(); onContextMenu(e); } }}
      style={{ cursor: onDragStart ? 'grab' : 'pointer' }} opacity={p.exitOpacity}>
      {isSelected && <circle cx="0" cy="0" r="26" fill="none" stroke="#FFD700" strokeWidth="2" strokeDasharray="5,3" opacity="0.8">
        <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="4s" repeatCount="indefinite" /></circle>}
      {/* Hide person body when inside ambulance */}
      {p.ambulanceActive && p.ambulancePhase === 'driving-away' ? null : <>
      {/* Ground shadow */}
      <ellipse cx="0" cy={isSleep ? 10 : 22} rx={isSleep ? 18 : 14} ry={isSleep ? 6 : 6} fill="rgba(0,0,0,0.22)" />
      {isSleep ? (
        <g>
          {/* Sleeping — lying down chibi */}
          <ellipse cx="0" cy="4" rx="18" ry="9" fill={shirt} stroke="rgba(0,0,0,0.12)" strokeWidth="0.8" />
          <circle cx="-14" cy="0" r="11" fill={skin} stroke="rgba(0,0,0,0.1)" strokeWidth="0.8" />
          {/* Hair cap while sleeping */}
          <ellipse cx="-14" cy="-6" rx="10" ry="5" fill={['#3A2A1A', '#5A3A1A', '#1A1410', '#8A6A3A', '#6A4A2A', '#1A1A2A'][Math.floor(p.seed * 6) % 6]} />
          {/* Closed eyes — curved lines */}
          <path d="M-18,-1 Q-15,1 -12,-1" fill="none" stroke="#2A1A0A" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M-18,3 Q-15,5 -12,3" fill="none" stroke="#2A1A0A" strokeWidth="1.8" strokeLinecap="round" />
          {/* Peaceful smile */}
          <path d="M-16,5 Q-14,7 -12,5" fill="none" stroke="#2A1A0A" strokeWidth="1" strokeLinecap="round" />
          {/* Blush */}
          <circle cx="-19" cy="4" r="2.5" fill="#E8A0A0" opacity="0.35" />
          <circle cx="-9" cy="4" r="2.5" fill="#E8A0A0" opacity="0.35" />
          <text x="10" y="-10" fontSize="9" fill="#8070B0" fontWeight="bold" opacity={0.3 + Math.sin(now / 700) * 0.7}>z</text>
          <text x="18" y="-19" fontSize="12" fill="#8070B0" fontWeight="bold" opacity={0.3 + Math.sin(now / 700 + 1.2) * 0.7}>Z</text>
          <text x="26" y="-30" fontSize="15" fill="#8070B0" fontWeight="bold" opacity={0.3 + Math.sin(now / 700 + 2.4) * 0.7}>Z</text>
        </g>
      ) : (
        <g>
          {/* ═══ CHIBI CHARACTER — all solid filled shapes ═══ */}

          {/* ── Legs — solid rounded rects with isometric shoes ── */}
          {(() => {
            const legW = 5, legH = 10, shoeW = 5.5, shoeH = 3;
            const walkL = isWalk ? Math.sin(walkCycle * 8) * 6 : 0;
            const walkR = isWalk ? -Math.sin(walkCycle * 8) * 6 : 0;
            const tapR = idleAnim === 'tap-foot' && state === 'idle' ? Math.sin(now / 100) * 3 : 0;
            return <g>
              {/* Left leg */}
              <rect x={-5 + walkL - legW / 2} y="13" width={legW} height={legH} rx="2.5" fill="#3A3A4A" />
              <ellipse cx={-5 + walkL} cy={13 + legH} rx={shoeW} ry={shoeH} fill="#2A2020" />
              <ellipse cx={-5 + walkL + 1} cy={13 + legH - 0.5} rx={shoeW - 1.5} ry={shoeH - 1} fill="#3A3030" />
              {/* Right leg */}
              <rect x={5 + walkR + tapR - legW / 2} y="13" width={legW} height={legH} rx="2.5" fill="#3A3A4A" />
              <ellipse cx={5 + walkR + tapR} cy={13 + legH} rx={shoeW} ry={shoeH} fill="#2A2020" />
              <ellipse cx={5 + walkR + tapR + 1} cy={13 + legH - 0.5} rx={shoeW - 1.5} ry={shoeH - 1} fill="#3A3030" />
            </g>;
          })()}

          {/* ── Body — solid rounded isometric shape with shading ── */}
          <rect x="-10" y="-3" width="20" height="18" rx="8" fill={shirt} />
          {/* Body shade (right side darker for depth) */}
          <path d="M2,-3 Q10,-3 10,5 L10,7 Q10,15 2,15 Z" fill="rgba(0,0,0,0.08)" />

          {/* ── Arms — solid pill shapes, no strokes ── */}
          {(() => {
            const armW = 4.5, armH = 10, armR = armW / 2;
            if (idleAnim === 'phone' && state === 'idle') {
              return <g>
                <ellipse cx="13" cy="-2" rx={armR} ry={armH / 2} fill={skin} transform="rotate(-30, 13, -2)" />
                <rect x="13" y="-15" width="7" height="11" rx="2" fill="#333" />
                <rect x="14" y="-14" width="5" height="9" rx="1" fill="#5588CC" opacity="0.7" />
                <ellipse cx="-13" cy="5" rx={armR} ry={armH / 2} fill={skin} />
              </g>;
            }
            if (idleAnim === 'coffee' && state === 'idle') {
              return <g>
                <ellipse cx="14" cy="-1" rx={armR} ry={armH / 2} fill={skin} transform="rotate(-25, 14, -1)" />
                <rect x="14" y="-13" width="7" height="10" rx="2.5" fill="#8B5E3C" />
                <rect x="14" y="-13" width="7" height="3" rx="2" fill="#7B4E2C" />
                <path d={`M16,${-14 - Math.sin(now / 300) * 2.5} Q18,${-19 - Math.sin(now / 300) * 2.5} 20,${-15 - Math.sin(now / 300) * 2.5}`} fill="none" stroke="rgba(200,200,200,0.4)" strokeWidth="1.2" />
                <ellipse cx="-13" cy="5" rx={armR} ry={armH / 2} fill={skin} />
              </g>;
            }
            if (idleAnim === 'watch' && state === 'idle') {
              return <g>
                <ellipse cx="-14" cy="-1" rx={armR} ry={armH / 2} fill={skin} transform="rotate(25, -14, -1)" />
                <circle cx="-17" cy="-8" r="4.5" fill="#333" />
                <circle cx="-17" cy="-8" r="3.5" fill="#444" />
                <ellipse cx="13" cy="5" rx={armR} ry={armH / 2} fill={skin} />
              </g>;
            }
            if (idleAnim === 'stretch' && state === 'idle') {
              const s = Math.sin(now / 500) * 3;
              return <g>
                <ellipse cx={-13 - s} cy={-8 - Math.abs(s)} rx={armR} ry={armH / 2} fill={skin} transform={`rotate(${30 + s * 3}, ${-13 - s}, ${-8 - Math.abs(s)})`} />
                <ellipse cx={13 + s} cy={-8 - Math.abs(s)} rx={armR} ry={armH / 2} fill={skin} transform={`rotate(${-30 - s * 3}, ${13 + s}, ${-8 - Math.abs(s)})`} />
              </g>;
            }
            if (isWalk) {
              const sw = Math.sin(walkCycle * 6);
              return <g>
                <ellipse cx={-12 - sw * 3} cy={3 + Math.abs(sw) * 2} rx={armR} ry={armH / 2 - 1} fill={skin} transform={`rotate(${sw * 15}, ${-12 - sw * 3}, ${3 + Math.abs(sw) * 2})`} />
                <ellipse cx={12 + sw * 3} cy={3 - Math.abs(sw) * 2} rx={armR} ry={armH / 2 - 1} fill={skin} transform={`rotate(${-sw * 15}, ${12 + sw * 3}, ${3 - Math.abs(sw) * 2})`} />
              </g>;
            }
            // Default idle arms — hanging at sides
            return <g>
              <ellipse cx="-12" cy="4" rx={armR} ry={armH / 2} fill={skin} />
              <ellipse cx="12" cy="4" rx={armR} ry={armH / 2} fill={skin} />
            </g>;
          })()}

          {/* ═══ BIG CHIBI HEAD ═══ */}
          {(() => {
            const hair = ['#3A2A1A', '#5A3A1A', '#1A1410', '#8A6A3A', '#6A4A2A', '#1A1A2A'][Math.floor(p.seed * 6) % 6];
            return <>
          {/* Head — massive solid circle */}
          <circle cx="0" cy="-14" r="14" fill={isErr ? '#A8D878' : skin} />
          {/* Head shading — subtle darker crescent on right */}
          <path d="M8,-26 A14,14 0 0,1 8,-2 A12,12 0 0,0 8,-26" fill="rgba(0,0,0,0.06)" />
          {isErr && <circle cx="0" cy="-14" r="14" fill="#6A9A3A" opacity={0.2 + Math.sin(now / 400) * 0.1} />}

          {/* Hair — solid dome cap */}
          <path d={`M-13,-17 Q-14,-27 -6,-29 Q0,-31 6,-29 Q14,-27 13,-17`} fill={hair} />
          {/* Hair side volume */}
          <ellipse cx="-11.5" cy="-20" rx="4.5" ry="6.5" fill={hair} />
          <ellipse cx="11.5" cy="-20" rx="4.5" ry="6.5" fill={hair} />
          {/* Hair highlight */}
          <ellipse cx="-3" cy="-26" rx="4" ry="2" fill="rgba(255,255,255,0.1)" />
            </>;
          })()}

          {/* ── FACE ── */}
          {isErr ? (
            <g>
              {/* Sick: big droopy oval eyes */}
              <ellipse cx="-5" cy="-15" rx="4.5" ry="4" fill="white" stroke="rgba(0,0,0,0.08)" strokeWidth="0.5" />
              <ellipse cx="5" cy="-15" rx="4.5" ry="4" fill="white" stroke="rgba(0,0,0,0.08)" strokeWidth="0.5" />
              <ellipse cx="-5" cy="-14" rx="2.8" ry="1.5" fill="#3A2A1A" />
              <ellipse cx="5" cy="-14" rx="2.8" ry="1.5" fill="#3A2A1A" />
              {/* Bags */}
              <path d="M-9,-11.5 Q-5,-10 -1,-11.5" fill="none" stroke="#7A9A5A" strokeWidth="0.9" opacity="0.5" />
              <path d="M1,-11.5 Q5,-10 9,-11.5" fill="none" stroke="#7A9A5A" strokeWidth="0.9" opacity="0.5" />
              {/* Queasy mouth */}
              <path d={`M-5,-7 Q-2.5,${-8.5 + Math.sin(now / 300) * 1} 0,-7 Q2.5,${-5.5 + Math.sin(now / 300) * 1} 5,-7`} fill="none" stroke="#5A7A3A" strokeWidth="1.5" strokeLinecap="round" />
              {/* Sweat */}
              <circle cx="-12" cy={-18 + Math.sin(now / 250) * 2} r="2" fill="#80C8F0" opacity={0.5 + Math.sin(now / 200) * 0.3} />
            </g>
          ) : isWalkingToError ? (
            <g>
              {/* Anxious: wide eyes, tiny pupils */}
              <ellipse cx="-5" cy="-15" rx="4.5" ry="4.5" fill="white" stroke="rgba(0,0,0,0.08)" strokeWidth="0.5" />
              <ellipse cx="5" cy="-15" rx="4.5" ry="4.5" fill="white" stroke="rgba(0,0,0,0.08)" strokeWidth="0.5" />
              <circle cx="-5" cy="-14.5" r="2.2" fill="#3A2A1A" /><circle cx="5" cy="-14.5" r="2.2" fill="#3A2A1A" />
              <circle cx="-4.3" cy="-15.3" r="1" fill="white" /><circle cx="5.7" cy="-15.3" r="1" fill="white" />
              {/* Worried brows */}
              <line x1="-9" y1="-20" x2="-3" y2="-19.5" stroke="#3A2A1A" strokeWidth="1.3" strokeLinecap="round" />
              <line x1="3" y1="-19.5" x2="9" y2="-20" stroke="#3A2A1A" strokeWidth="1.3" strokeLinecap="round" />
              <path d={`M-4,-8 Q0,${-10 + Math.sin(now / 150) * 1} 4,-8`} fill="none" stroke="#3A2A1A" strokeWidth="1.3" strokeLinecap="round" />
            </g>
          ) : idleAnim === 'yawn' && state === 'idle' ? (
            <g>
              {/* Yawn: closed eyes, open mouth */}
              <path d="M-8,-15 Q-5,-13 -2,-15" fill="none" stroke="#2A1A0A" strokeWidth="2" strokeLinecap="round" />
              <path d="M2,-15 Q5,-13 8,-15" fill="none" stroke="#2A1A0A" strokeWidth="2" strokeLinecap="round" />
              <ellipse cx="0" cy="-7.5" rx="3.5" ry="4.5" fill="#3A2A1A" opacity="0.4" />
            </g>
          ) : (
            <g>
              {/* ── Normal eyes — BIG ovals with white sclera ── */}
              {tiredness > 0.5 ? (
                <g>
                  <ellipse cx="-5" cy="-15" rx="4.5" ry="4" fill="white" stroke="rgba(0,0,0,0.08)" strokeWidth="0.5" />
                  <ellipse cx="5" cy="-15" rx="4.5" ry="4" fill="white" stroke="rgba(0,0,0,0.08)" strokeWidth="0.5" />
                  <ellipse cx="-5" cy="-14" rx="3" ry={2 - tiredness * 0.7} fill="#3A2A1A" />
                  <ellipse cx="5" cy="-14" rx="3" ry={2 - tiredness * 0.7} fill="#3A2A1A" />
                  {/* Dark circles */}
                  <path d="M-9,-11.5 Q-5,-10 -1,-11.5" fill="none" stroke="#888" strokeWidth="0.9" opacity={tiredness * 0.5} />
                  <path d="M1,-11.5 Q5,-10 9,-11.5" fill="none" stroke="#888" strokeWidth="0.9" opacity={tiredness * 0.5} />
                </g>
              ) : (
                <g>
                  {/* White sclera — big ovals */}
                  <ellipse cx="-5" cy="-15" rx="4.8" ry="4.5" fill="white" stroke="rgba(0,0,0,0.08)" strokeWidth="0.5" />
                  <ellipse cx="5" cy="-15" rx="4.8" ry="4.5" fill="white" stroke="rgba(0,0,0,0.08)" strokeWidth="0.5" />
                  {/* Iris — large dark circles */}
                  <circle cx={-5 + (isWalk ? Math.cos(angle) * 1 : 0)} cy={-14.5 + (isWalk ? Math.sin(angle) * 0.5 : 0)} r="2.8" fill="#2A1A0A" />
                  <circle cx={5 + (isWalk ? Math.cos(angle) * 1 : 0)} cy={-14.5 + (isWalk ? Math.sin(angle) * 0.5 : 0)} r="2.8" fill="#2A1A0A" />
                  {/* Highlight sparkle — big and visible */}
                  <circle cx="-4" cy="-16" r="1.3" fill="white" />
                  <circle cx="6" cy="-16" r="1.3" fill="white" />
                  <circle cx="-3.5" cy="-14.5" r="0.6" fill="white" opacity="0.6" />
                  <circle cx="6.5" cy="-14.5" r="0.6" fill="white" opacity="0.6" />
                </g>
              )}
              {tiredness > 0.7 && !isWalk && (
                <text x="14" y="-22" fontSize="10" opacity={0.4 + Math.sin(now / 800 + p.seed * 10) * 0.3}>💤</text>
              )}
            </g>
          )}

          {/* ── Mouth ── */}
          {!isErr && !isWalkingToError && !(idleAnim === 'yawn' && state === 'idle') && (
            isRejected || emotion === 'sad' ? <path d="M-3.5,-7 Q0,-9.5 3.5,-7" fill="none" stroke="#2A1A0A" strokeWidth="1.5" strokeLinecap="round" /> :
            isDone || emotion === 'happy' || emotion === 'jump' ? <path d="M-5,-7.5 Q0,-3.5 5,-7.5" fill="none" stroke="#2A1A0A" strokeWidth="1.5" strokeLinecap="round" /> :
            emotion === 'angry' ? <line x1="-4" y1="-7" x2="4" y2="-7" stroke="#2A1A0A" strokeWidth="1.8" strokeLinecap="round" /> :
            tiredness > 0.5 ? <path d="M-3,-7.5 Q0,-8 3,-7.5" fill="none" stroke="#2A1A0A" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" /> :
            <path d="M-2.5,-8 Q0,-6 2.5,-8" fill="none" stroke="#2A1A0A" strokeWidth="1.2" strokeLinecap="round" />
          )}
          {/* Blush cheeks — rosy circles */}
          {(isDone || emotion === 'happy' || emotion === 'jump') && (
            <g opacity="0.3"><ellipse cx="-9" cy="-10" rx="3" ry="2" fill="#E8A0A0" /><ellipse cx="9" cy="-10" rx="3" ry="2" fill="#E8A0A0" /></g>
          )}
          {/* Error: sick stink lines + "help!" speech bubble */}
          {isErr && <g>
            <path d={`M${-10 + Math.sin(now / 400) * 1.3},${-3} Q${-13},${-8 + Math.sin(now / 350) * 1.3} ${-9 + Math.sin(now / 450) * 1.3},${-12}`} fill="none" stroke="#9ACD68" strokeWidth="1" opacity={0.4 + Math.sin(now / 300) * 0.2} />
            <path d={`M${10 + Math.sin(now / 380) * 1.3},${-2} Q${13},${-7 + Math.sin(now / 320) * 1.3} ${9 + Math.sin(now / 420) * 1.3},${-11}`} fill="none" stroke="#9ACD68" strokeWidth="1" opacity={0.3 + Math.sin(now / 280 + 1) * 0.2} />
            <path d={`M${-8 + Math.sin(now / 360) * 0.7},${0} Q${-10},${-4 + Math.sin(now / 310) * 1.3} ${-6.5},${-8}`} fill="none" stroke="#9ACD68" strokeWidth="0.8" opacity={0.3 + Math.sin(now / 260 + 2) * 0.2} />
            {/* Speech bubble: "help!" */}
            <g transform="translate(13, -26)" opacity={0.7 + Math.sin(now / 500) * 0.3}>
              <rect x="-2" y="-8" width="30" height="14" rx="4" fill="rgba(248,81,73,0.9)" />
              <polygon points="2,6 7,6 4,10" fill="rgba(248,81,73,0.9)" />
              <text x="13" y="1" textAnchor="middle" fontSize="8" fill="white" fontWeight="700" fontFamily="monospace">help!</text>
            </g>
          </g>}
          {/* Completed: confetti burst */}
          {isDone && p.exitConfetti && Array.from({ length: 12 }, (_, i) => {
            const confettiAngle = (i / 12) * Math.PI * 2 + p.seed * 6;
            const t = p.exitTimer * 0.03;
            const dist = 10 + t * (18 + seededRand(p.seed + i) * 12);
            const gravity = t * t * 0.6;
            const cx = Math.cos(confettiAngle) * dist;
            const cy = Math.sin(confettiAngle) * dist + gravity - 5;
            const size = 1.3 + seededRand(p.seed + i + 0.5) * 2;
            const spin = now / 150 + i * 2;
            const colors = ['#FFD700', '#FF6B9D', '#00D4FF', '#7CFF6B', '#FF8A4C', '#D77BFF', '#FF4081', '#40C4FF', '#69F0AE', '#FFD54F', '#E040FB', '#FFAB40'];
            return <rect key={i} x={cx - size / 2} y={cy - size / 2} width={size} height={size * 1.5}
              rx="0.5" fill={colors[i % colors.length]}
              opacity={Math.max(0, 0.9 - t * 0.15)}
              transform={`rotate(${spin * 30 + i * 30}, ${cx}, ${cy})`} />;
          })}
          {/* Completed: wave goodbye arm */}
          {isDone && p.exitTimer > 30 && p.exitTimer < 100 && (
            <line x1="7" y1="-3" x2={11 + Math.sin(now / 80) * 4} y2={-12 + Math.cos(now / 80) * 3}
              stroke={skin} strokeWidth="3" strokeLinecap="round" />
          )}
          {/* Completed: bye text */}
          {isDone && p.exitTimer > 50 && p.exitTimer < 110 && (
            <text x="0" y="-28" textAnchor="middle" fontSize="9" fill="#3FB950"
              opacity={Math.min(1, (p.exitTimer - 50) / 20) * Math.max(0, 1 - (p.exitTimer - 90) / 20)}
              fontWeight="700" fontFamily="monospace">bye!</text>
          )}
          {isChat && <g transform="translate(11, -22)"><rect x="-2" y="-5" width="14" height="10" rx="3" fill="rgba(255,255,255,0.85)" />
            <polygon points="0,5 4,5 1,9" fill="rgba(255,255,255,0.85)" />
            <text x="5" y="2" textAnchor="middle" fontSize="7">{['💬', '📎', '🤔', '👋', '☕', '😄'][Math.floor(p.seed * 6) % 6]}</text></g>}
          {emotionEmoji && emotionTimer > 0 && <text x="0" y="-22" textAnchor="middle" fontSize="12" opacity={Math.min(1, emotionTimer / 30)}>{emotionEmoji}</text>}
          {trait === 'impatient' && state === 'queuing' && <text x="12" y="-3" fontSize="8" opacity={0.4 + Math.sin(now / 200) * 0.4}>&#x23F0;</text>}
          {/* "Waiting for..." speech bubble when instance has destination users */}
          {!isErr && !isDone && !isChat && !isSleep && p.destinationUsers.length > 0 && (state === 'idle' || state === 'queuing') && (() => {
            const first = p.destinationUsers[0];
            const extra = p.destinationUsers.length - 1;
            const label = `📞 ${first}${extra > 0 ? ` +${extra}` : ''}`;
            const bubbleW = Math.max(label.length * 4.5, 44);
            return (
              <g transform="translate(0, -28)" opacity={0.7 + Math.sin(now / 600 + p.seed * 5) * 0.2}>
                <rect x={-bubbleW / 2} y="-8" width={bubbleW} height="14" rx="4" fill="rgba(88,166,255,0.85)" />
                <polygon points="-2,6 2,6 0,9" fill="rgba(88,166,255,0.85)" />
                <text x="0" y="1" textAnchor="middle" fontSize="6" fill="white" fontWeight="600" fontFamily="monospace">{label}</text>
              </g>
            );
          })()}
          {/* Corridor activity indicators */}
          {p.inCorridor && p.corridorActivity === 'walking-ipad' && (
            <g transform="translate(8, -4)">
              {/* iPad/tablet */}
              <rect x="-3" y="-5" width="6" height="8" rx="1" fill="#333" stroke="#555" strokeWidth="0.4" />
              <rect x="-2.5" y="-4.5" width="5" height="6.5" rx="0.5" fill="#4A90D9" opacity="0.4" />
              {/* Typing dots */}
              <circle cx="-1" cy={-1 + Math.sin(now / 200) * 0.5} r="0.5" fill="white" opacity="0.6" />
              <circle cx="0.5" cy={-1 + Math.sin(now / 200 + 1) * 0.5} r="0.5" fill="white" opacity="0.6" />
              <circle cx="2" cy={-1 + Math.sin(now / 200 + 2) * 0.5} r="0.5" fill="white" opacity="0.6" />
            </g>
          )}
          {p.inCorridor && p.corridorActivity === 'water-cooler' && isChat && (
            <g transform="translate(0, -26)">
              <rect x="-20" y="-6" width="40" height="12" rx="4" fill="rgba(26,188,156,0.85)" />
              <polygon points="-2,6 2,6 0,9" fill="rgba(26,188,156,0.85)" />
              <text x="0" y="2" textAnchor="middle" fontSize="5.5" fill="white" fontWeight="600" fontFamily="monospace">🚰 Water cooler</text>
            </g>
          )}
          {/* Action taken speech bubble */}
          {p.lastAction && p.lastActionTimer > 0 && (() => {
            const label = `✅ ${p.lastAction}`;
            const bubbleW = Math.max(label.length * 4.8, 48);
            const fadeIn = Math.min(1, (200 - p.lastActionTimer) / 20);
            const fadeOut = Math.min(1, p.lastActionTimer / 30);
            return (
              <g transform={`translate(0, ${-30 - (1 - fadeIn) * 10})`} opacity={Math.min(fadeIn, fadeOut) * 0.95}>
                <rect x={-bubbleW / 2} y="-8" width={bubbleW} height="14" rx="4" fill="rgba(39,185,80,0.9)" />
                <polygon points="-2,6 2,6 0,9" fill="rgba(39,185,80,0.9)" />
                <text x="0" y="1" textAnchor="middle" fontSize="6" fill="white" fontWeight="700" fontFamily="monospace">{label}</text>
              </g>
            );
          })()}
        </g>
      )}
      {(isSelected || showNames) && !isSleep && (
        <g transform="translate(0, -36)"><rect x={-name.length * 2.4} y="-7" width={name.length * 4.8} height="12" rx="3" fill="rgba(40,35,30,0.8)" />
        <text x="0" y="0" textAnchor="middle" fontSize="8" fill="#E8E0D0" fontFamily="monospace" fontWeight="500">{name}</text></g>
      )}
      </>}

      {/* Umbrella float-down */}
      {p.umbrellaActive && (
        <g transform={`translate(0, ${-12 + Math.sin(now / 300) * 2})`}>
          {/* Umbrella canopy */}
          <path d={`M0,-20 Q-14,-20 -14,-10 Q-14,-4 0,-4 Q14,-4 14,-10 Q14,-20 0,-20`}
            fill="rgba(231,76,60,0.85)" stroke="#C0392B" strokeWidth="0.8" />
          {/* Umbrella handle */}
          <line x1="0" y1="-4" x2="0" y2="2" stroke="#8B6914" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M0,2 Q2,5 0,5" fill="none" stroke="#8B6914" strokeWidth="1.2" strokeLinecap="round" />
          {/* Gentle sway lines */}
          <line x1="-8" y1="-2" x2="-12" y2="2" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />
          <line x1="8" y1="-2" x2="12" y2="2" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />
        </g>
      )}

      {/* Waving goodbye bubble */}
      {p.wavingBye && p.wavingByeTimer > 0 && (
        <g transform="translate(0, -24)" opacity={Math.min(1, p.wavingByeTimer / 20)}>
          <rect x="-14" y="-8" width="28" height="13" rx="4" fill="rgba(155,142,196,0.85)" />
          <polygon points="-2,5 2,5 0,8" fill="rgba(155,142,196,0.85)" />
          <text x="0" y="1" textAnchor="middle" fontSize="6" fill="white" fontWeight="600" fontFamily="monospace">👋 bye!</text>
        </g>
      )}

      {/* Taxi — isometric 3D */}
      {p.taxiActive && p.taxiPhase !== 'done' && (() => {
        const tx = p.taxiX - x, ty = p.taxiY - y;
        const bounce = Math.sin(now / 50) * 0.4;
        return (
          <g transform={`translate(${tx}, ${ty + bounce - 4})`}>
            {/* Shadow */}
            <ellipse cx="0" cy="8" rx="14" ry="5" fill="rgba(0,0,0,0.15)" />
            {/* Isometric body — top face */}
            <polygon points="-14,-2 0,-8 14,-2 0,4" fill="#F5C518" />
            {/* Right face */}
            <polygon points="0,4 14,-2 14,4 0,10" fill="#D4A80F" />
            {/* Left face */}
            <polygon points="0,4 -14,-2 -14,4 0,10" fill="#C99A0E" />
            {/* Cabin — top */}
            <polygon points="-8,-4 0,-8 8,-4 0,0" fill="#E8D060" />
            {/* Cabin windows — right */}
            <polygon points="0,0 8,-4 8,-1 0,3" fill="rgba(100,180,255,0.5)" />
            {/* Cabin windows — left */}
            <polygon points="0,0 -8,-4 -8,-1 0,3" fill="rgba(80,160,245,0.4)" />
            {/* Roof sign */}
            <rect x="-4" y="-10" width="8" height="3" rx="1" fill="white" stroke="#D4A80F" strokeWidth="0.3" />
            <text x="0" y="-8" textAnchor="middle" fontSize="2.5" fill="#333" fontWeight="bold">TAXI</text>
            {/* Wheels */}
            <ellipse cx="-8" cy="8" rx="2.5" ry="1.5" fill="#333" />
            <ellipse cx="8" cy="8" rx="2.5" ry="1.5" fill="#333" />
            {/* Headlights */}
            <circle cx="12" cy="0" r="1" fill="#FFE082" />
            <circle cx="-12" cy="0" r="1" fill="#FF4444" opacity="0.6" />
            {/* Honk when arriving */}
            {p.taxiPhase === 'driving-to' && (
              <text x="0" y="-14" textAnchor="middle" fontSize="6" fill="#F5C518" fontWeight="700"
                opacity={0.5 + Math.sin(now / 150) * 0.5}>BEEP!</text>
            )}
          </g>
        );
      })()}

      {/* Ambulance — isometric 3D */}
      {p.ambulanceActive && p.ambulancePhase !== 'done' && (() => {
        const ax = p.ambulanceX - x, ay = p.ambulanceY - y;
        const bounce = Math.sin(now / 60) * 0.4;
        const flashRed = Math.sin(now / 80) > 0;
        return (
          <g transform={`translate(${ax}, ${ay + bounce - 4})`}>
            {/* Shadow */}
            <ellipse cx="0" cy="10" rx="16" ry="6" fill="rgba(0,0,0,0.15)" />
            {/* Isometric body — top face (white) */}
            <polygon points="-16,-3 0,-10 16,-3 0,4" fill="#F0F0F0" />
            {/* Right face */}
            <polygon points="0,4 16,-3 16,5 0,12" fill="#D8D8D8" />
            {/* Left face */}
            <polygon points="0,4 -16,-3 -16,5 0,12" fill="#C8C8C8" />
            {/* Red stripe — top */}
            <polygon points="-14,-2 0,-8 14,-2 0,4" fill="#E74C3C" opacity="0.3" />
            {/* Red cross on top */}
            <polygon points="-2,-5 2,-5 2,-3 -2,-3" fill="#E74C3C" />
            <polygon points="-1,-6 1,-6 1,-2 -1,-2" fill="#E74C3C" />
            {/* Red stripe — right face */}
            <polygon points="0,3 16,-4 16,-1 0,6" fill="#E74C3C" opacity="0.4" />
            {/* Red stripe — left face */}
            <polygon points="0,3 -16,-4 -16,-1 0,6" fill="#E74C3C" opacity="0.35" />
            {/* Cabin windows */}
            <polygon points="0,1 10,-4 10,-1 0,4" fill="rgba(100,180,255,0.4)" />
            <polygon points="0,1 -10,-4 -10,-1 0,4" fill="rgba(80,160,245,0.35)" />
            {/* Wheels */}
            <ellipse cx="-9" cy="10" rx="3" ry="1.5" fill="#333" />
            <ellipse cx="9" cy="10" rx="3" ry="1.5" fill="#333" />
            {/* Flashing lights on roof */}
            <circle cx="-3" cy="-9" r="2" fill={flashRed ? '#FF0000' : '#FF000033'} />
            <circle cx="3" cy="-9" r="2" fill={flashRed ? '#0066FF33' : '#0066FF'} />
            {/* Siren glow */}
            {flashRed && <circle cx="-3" cy="-9" r="5" fill="#FF0000" opacity="0.15" />}
            {!flashRed && <circle cx="3" cy="-9" r="5" fill="#0066FF" opacity="0.15" />}
            {/* Siren text */}
            <text x="0" y="-16" textAnchor="middle" fontSize="5" fill="#F85149" fontWeight="700"
              opacity={0.5 + Math.sin(now / 120) * 0.5}>
              {flashRed ? 'WEE-WOO' : 'NEE-NAW'}
            </text>
          </g>
        );
      })()}
    </g>
  );
}

// ─── Timeline Chart ──────────────────────────────────────────────────────
function Timeline({ history, zones, width: cw }: { history: Record<string, number>[]; zones: ZoneDefinition[]; width: number }) {
  if (history.length < 2) return null;
  const h = 70;
  const trackZones = zones.filter(z => z.capacity < 99);
  const colors = ['#58A6FF', '#F5A623', '#3FB950', '#F85149', '#9B8EC4', '#1ABC9C', '#E67E22', '#E91E63'];
  return (
    <div style={{ margin: '0 20px 12px' }}>
      <div style={{ fontSize: 10, color: '#E6EDF3', marginBottom: 6, fontFamily: 'monospace' }}>Zone congestion over time</div>
      <svg width="100%" height={h + 20} viewBox={`0 0 ${cw} ${h + 20}`} style={{ background: 'rgba(255,255,255,0.01)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.04)' }}>
        {[0, 0.25, 0.5, 0.75, 1].map(t => <line key={t} x1="35" y1={10 + (1 - t) * h} x2={cw - 5} y2={10 + (1 - t) * h} stroke="rgba(255,255,255,0.04)" strokeWidth="0.5" />)}
        {trackZones.map((zone, zi) => {
          const color = colors[zi % colors.length];
          const pts = history.map((snap, i) => {
            const x = 35 + (i / Math.max(history.length - 1, 1)) * (cw - 45);
            const y = 10 + (1 - Math.min((snap[zone.id] || 0) / zone.capacity, 1.5) / 1.5) * h;
            return `${x},${y}`;
          }).join(' ');
          return <polyline key={zone.id} points={pts} fill="none" stroke={color} strokeWidth="1.5" opacity="0.7" />;
        })}
        <line x1="35" y1={10 + (1 - 1 / 1.5) * h} x2={cw - 5} y2={10 + (1 - 1 / 1.5) * h} stroke="#F85149" strokeWidth="0.8" strokeDasharray="4,3" opacity="0.4" />
      </svg>
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────
export default function App() {
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [activeWfId, setActiveWfId] = useState<string | null>(null);
  const [activeWf, setActiveWf] = useState<WorkflowDefinition | null>(null);
  const [people, setPeople] = useState<AnimPerson[]>([]);
  const [stats, setStats] = useState<WorkflowStats | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [redirectMode, setRedirectMode] = useState(false);
  const [redirectUser, setRedirectUser] = useState('');
  // Right-click context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; personId: string } | null>(null);
  const [speed, setSpeed] = useState(1);
  const [showNames, setShowNames] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [connState, setConnState] = useState<string>('loading');
  const [history, setHistory] = useState<Record<string, number>[]>([]);

  // Drag & drop state for GoTo Activity
  const [dragPerson, setDragPerson] = useState<string | null>(null);
  // Pan & zoom (arrow keys + keyboard zoom)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dragOrigin, setDragOrigin] = useState<{ x: number; y: number; zoneId: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Arrow-key pan & +/- zoom
  useEffect(() => {
    const PAN_STEP = 40;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case 'ArrowLeft':  e.preventDefault(); setPan(p => ({ ...p, x: p.x + PAN_STEP })); break;
        case 'ArrowRight': e.preventDefault(); setPan(p => ({ ...p, x: p.x - PAN_STEP })); break;
        case 'ArrowUp':    e.preventDefault(); setPan(p => ({ ...p, y: p.y + PAN_STEP })); break;
        case 'ArrowDown':  e.preventDefault(); setPan(p => ({ ...p, y: p.y - PAN_STEP })); break;
        case '+': case '=': e.preventDefault(); setZoom(z => Math.min(3, z * 1.15)); break;
        case '-': case '_': e.preventDefault(); setZoom(z => Math.max(0.3, z / 1.15)); break;
        case '0':          e.preventDefault(); setZoom(1); setPan({ x: 0, y: 0 }); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Isometric layout — stored as state, set when workflow loads
  const [isoLayout, setIsoLayout] = useState<IsoLayout | null>(null);

  const frameRef = useRef<number>(0);
  const timeRef = useRef(Date.now());
  const histTick = useRef(0);
  const activeWfRef = useRef<WorkflowDefinition | null>(null);
  activeWfRef.current = activeWf;
  const isoLayoutRef = useRef<IsoLayout | null>(null);
  isoLayoutRef.current = isoLayout;

  // ─── Merge helper: update or add an instance into animation state ──
  const mergeInstance = useCallback((inst: WorkflowInstance) => {
    const wf = activeWfRef.current;
    if (!wf) return;
    setPeople(prev => {
      const existing = prev.find(p => p.id === inst.id);
      if (existing) {
        return prev.map(p => p.id !== inst.id ? p : mergePersonWithInstance(p, inst, wf, isoLayoutRef.current));
      }
      // New instance
      const newPerson = instanceToPerson(inst, wf.zones, isoLayoutRef.current);
      if (inst.state === 'error' && prev.length > 0) {
        newPerson.ambulanceActive = true;
        newPerson.ambulancePhase = 'driving-to';
        newPerson.ambulanceX = (wf.width || 950) + 40;
        newPerson.ambulanceY = newPerson.y;
      } else if (inst.state === 'error') {
        newPerson.emotion = 'angry';
      }
      return [...prev, newPerson];
    });
  }, []);

  // ─── SignalR 2 real-time connection ────────────────────────────────
  const { connectionState: signalRState } = useWorkflowHub({
    hubUrl: "http://localhost:9090",
    workflowId: activeWfId,
    onAllInstances: useCallback((instances: WorkflowInstance[]) => {
      const wf = activeWfRef.current;
      if (!wf) return;
      setPeople(prev => {
        const prevMap = new Map(prev.map(p => [p.id, p]));
        return instances.map(inst => {
          const existing = prevMap.get(inst.id);
          if (existing) return mergePersonWithInstance(existing, inst, wf, isoLayoutRef.current);
          return instanceToPerson(inst, wf.zones, isoLayoutRef.current);
        });
      });
      console.log(`[SignalR] AllInstances: ${instances.length} instances`);
    }, []),
    onInstanceCreated: useCallback((inst: WorkflowInstance) => {
      console.log(`[SignalR] InstanceCreated: ${inst.id}`);
      mergeInstance(inst);
    }, [mergeInstance]),
    onInstanceUpdated: useCallback((inst: WorkflowInstance) => {
      console.log(`[SignalR] InstanceUpdated: ${inst.id} zone=${inst.currentZoneId} state=${inst.state}`);
      mergeInstance(inst);
    }, [mergeInstance]),
    onInstanceCompleted: useCallback((instanceId: string) => {
      console.log(`[SignalR] InstanceCompleted: ${instanceId}`);
      setPeople(prev => prev.map(p => p.id !== instanceId ? p : {
        ...p, state: 'completed' as PersonState, emotion: 'jump' as Emotion, emotionTimer: 80,
        exitTimer: 1, exitConfetti: true,
      }));
    }, []),
    onInstanceErrored: useCallback((inst: WorkflowInstance) => {
      console.log(`[SignalR] InstanceErrored: ${inst.id}`);
      mergeInstance(inst);
    }, [mergeInstance]),
    onZoneStatsUpdated: useCallback((zoneStats: ZoneStats[]) => {
      setStats(prev => prev ? { ...prev, zoneStats } : prev);
    }, []),
    onBottleneckDetected: useCallback((bottleneck: BottleneckInfo) => {
      console.log(`[SignalR] Bottleneck: ${bottleneck.zoneId}`);
      setStats(prev => prev ? {
        ...prev,
        bottlenecks: [...(prev.bottlenecks || []).filter(b => b.zoneId !== bottleneck.zoneId), bottleneck],
      } : prev);
    }, []),
    onBottleneckResolved: useCallback((zoneId: string) => {
      setStats(prev => prev ? {
        ...prev,
        bottlenecks: (prev.bottlenecks || []).filter(b => b.zoneId !== zoneId),
      } : prev);
    }, []),
  });

  // ─── Load workflows on mount ────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const wfs = await getWorkflows();
        setWorkflows(wfs);
        const active = wfs.filter(w => w.activeInstanceCount > 0);
        if (active.length > 0) setActiveWfId(active[0].id);
        else if (wfs.length > 0) setActiveWfId(wfs[0].id);
        setConnState('connected');
      } catch (err) {
        console.error('Failed to load workflows:', err);
        setConnState('error');
      }
    })();
  }, []);

  // ─── Load workflow detail + instances when selection changes ─────
  useEffect(() => {
    if (!activeWfId) return;
    let cancelled = false;
    (async () => {
      try {
        const [wf, insts] = await Promise.all([getWorkflow(activeWfId), getInstances(activeWfId)]);
        if (cancelled) return;
        // Compute isometric layout and patch zone positions
        const layout = computeIsoLayout(wf.zones);
        setIsoLayout(layout);
        const roomMap = new Map(layout.rooms.map(r => [r.zone.id, r]));
        const patchedWf = { ...wf, width: layout.totalWidth, height: layout.totalHeight, zones: wf.zones.map(z => {
          const room = roomMap.get(z.id);
          if (!room) return z;
          return { ...z, x: room.screenX, y: room.screenY, w: room.screenBoundsW * 0.6, h: room.screenBoundsH * 0.6 };
        }) };
        setActiveWf(patchedWf);
        setPeople(insts.map(i => {
          const p = instanceToPerson(i, patchedWf.zones, layout);
          // On initial load, error instances go straight to error-corner (no ambulance)
          if (i.state === 'error') p.emotion = 'angry';
          return p;
        }));
        setHistory([]);
        const st = await getStats(activeWfId);
        if (!cancelled) setStats(st);
      } catch (err) { console.error('Failed to load workflow:', err); }
    })();
    return () => { cancelled = true; };
  }, [activeWfId]);

  // ─── Fallback poll only when SignalR is disconnected ───────────────
  useEffect(() => {
    if (!activeWfId || !activeWf) return;
    // If SignalR is connected, skip polling — data comes via push
    if (signalRState === 'connected') return;
    console.log('[Fallback] SignalR not connected, polling every 10s');
    const interval = setInterval(async () => {
      try {
        const [insts, st] = await Promise.all([getInstances(activeWfId), getStats(activeWfId)]);
        const wf = activeWfRef.current;
        if (!wf) return;
        setPeople(prev => {
          const prevMap = new Map(prev.map(p => [p.id, p]));
          return insts.map(inst => {
            const existing = prevMap.get(inst.id);
            if (existing) return mergePersonWithInstance(existing, inst, wf, isoLayoutRef.current);
            const newPerson = instanceToPerson(inst, wf.zones, isoLayoutRef.current);
            if (inst.state === 'error') newPerson.emotion = 'angry';
            return newPerson;
          });
        });
        setStats(st);
      } catch { /* silent */ }
    }, 10000);
    return () => clearInterval(interval);
  }, [activeWfId, activeWf, signalRState]);

  // ─── Animation loop ─────────────────────────────────────────────
  useEffect(() => {
    let running = true;
    const tick = () => {
      if (!running) return;
      const t = Date.now();
      const dt = Math.min((t - timeRef.current) / 16, 4) * speed;
      timeRef.current = t;
      setNow(t);

      if (activeWf) {
        setPeople(prev => simulate(prev, activeWf.zones, dt, isoLayoutRef.current));
      }

      // Record history
      histTick.current += 1;
      if (histTick.current % 120 === 0 && activeWf) {
        setPeople(curr => {
          const snap: Record<string, number> = {};
          activeWf.zones.forEach(z => { snap[z.id] = curr.filter(p => p.zoneId === z.id).length; });
          setHistory(h => [...h.slice(-80), snap]);
          return curr;
        });
      }

      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(frameRef.current); };
  }, [speed, activeWf]);

  // ─── Derived data ───────────────────────────────────────────────
  const zoneCounts = useMemo(() => {
    const c: Record<string, number> = {};
    people.forEach(p => { c[p.zoneId] = (c[p.zoneId] || 0) + 1; });
    return c;
  }, [people]);

  const bottleneckIds = useMemo(() => {
    if (!stats) return new Set<string>();
    return new Set(stats.bottlenecks.map(b => b.zoneId));
  }, [stats]);

  const personStats = useMemo(() => {
    const s = { total: 0, walking: 0, idle: 0, chatting: 0, sleeping: 0, error: 0, completed: 0, rejected: 0 };
    people.forEach(p => {
      s.total++;
      if (p.state === 'walking') s.walking++;
      else if (p.state === 'idle' || p.state === 'queuing') s.idle++;
      else if (p.state === 'chatting') s.chatting++;
      else if (p.state === 'sleeping') s.sleeping++;
      else if (p.state === 'error') s.error++;
      else if (p.state === 'completed') s.completed++;
      else if (p.state === 'rejected') s.rejected++;
    });
    return s;
  }, [people]);

  const selectedPerson = selected ? people.find(p => p.id === selected) : null;
  const contentWidth = activeWf?.width || 950;
  const contentHeight = activeWf?.height || 520;

  // ─── Loading state ──────────────────────────────────────────────
  if (connState === 'loading') {
    return <div style={{ width: '100%', height: '100vh', background: '#0D1117', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#E6EDF3', fontFamily: 'monospace', fontSize: 14 }}>Connecting to K2...</div>;
  }

  if (connState === 'error') {
    return <div style={{ width: '100%', height: '100vh', background: '#0D1117', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#F85149', fontFamily: 'monospace', fontSize: 14, flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 28 }}>🚨</span>Failed to connect to API<br />
      <span style={{ color: '#E6EDF3', fontSize: 11 }}>Check the .NET backend is running and K2 is reachable</span>
    </div>;
  }

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column' as const, overflow: 'hidden', background: 'linear-gradient(160deg, #2A3040 0%, #343E4E 40%, #2A3040 100%)', fontFamily: "'JetBrains Mono', 'SF Mono', monospace", color: '#D0D8E0' }}>
      {/* Header */}
      <div style={{ padding: '14px 24px', borderBottom: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(0,0,0,0.25)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 40 }}>🏢</span>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700, color: '#E6EDF3', letterSpacing: '-0.02em' }}>Workflow World</div>
            <div style={{ fontSize: 13, color: '#E6EDF3', letterSpacing: '0.08em', textTransform: 'uppercase' as const, marginTop: 2 }}>
              K2 {signalRState === 'connected' ? '⚡ Live' : signalRState === 'connecting' ? '🔄 Connecting' : '📡 Polling'} · {people.length} instances{bottleneckIds.size > 0 ? ` · ${bottleneckIds.size} bottleneck${bottleneckIds.size > 1 ? 's' : ''}` : ''}
            </div>
          </div>
          {bottleneckIds.size > 0 && <div style={{ padding: '5px 14px', borderRadius: 14, fontSize: 12, fontWeight: 700, background: 'rgba(248,81,73,0.15)', color: '#F85149', border: '1px solid rgba(248,81,73,0.3)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 14 }}>🔥</span> {bottleneckIds.size} Bottleneck{bottleneckIds.size > 1 ? 's' : ''}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <select
            value={activeWfId || ''}
            onChange={e => { setActiveWfId(e.target.value); setSelected(null); setZoom(1); setPan({ x: 0, y: 0 }); }}
            style={{ padding: '8px 14px', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', border: '1px solid rgba(255,255,255,0.12)', background: '#161B22', color: '#C9D1D9', cursor: 'pointer', maxWidth: 450, outline: 'none' }}
          >
            {workflows.filter(w => w.activeInstanceCount > 0).map(w => (
              <option key={w.id} value={w.id}>{w.icon} {w.name} ({w.activeInstanceCount})</option>
            ))}
          </select>
          <span style={{ fontSize: 10, color: '#E6EDF3' }}>{workflows.filter(w => w.activeInstanceCount > 0).length} / {workflows.length} workflows</span>
        </div>
      </div>

      {/* Stats + Controls */}
      <div style={{ padding: '8px 24px', display: 'flex', gap: 16, alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.15)', flexWrap: 'wrap' as const, flexShrink: 0 }}>
        {[
          { l: 'Total', v: personStats.total, c: '#C9D1D9' }, { l: 'Active', v: personStats.walking + personStats.idle, c: '#58A6FF' },
          { l: 'Chat', v: personStats.chatting, c: '#1ABC9C' }, { l: 'Sleep', v: personStats.sleeping, c: '#9B8EC4' },
          { l: 'Error', v: personStats.error, c: '#F85149' }, { l: 'Done', v: personStats.completed, c: '#3FB950' },
        ].map(s => (
          <div key={s.l} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: s.c }} />
            <span style={{ fontSize: 13, color: '#E6EDF3' }}>{s.l}</span>
            <span style={{ fontSize: 15, fontWeight: 700, color: s.c }}>{s.v}</span>
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13, color: '#E6EDF3' }}>Speed</span>
          {[0.5, 1, 2, 4].map(s => (
            <button key={s} onClick={() => setSpeed(s)} style={{ padding: '4px 10px', borderRadius: 5, fontSize: 13, fontFamily: 'inherit', border: speed === s ? '1px solid rgba(88,166,255,0.4)' : '1px solid rgba(255,255,255,0.08)', background: speed === s ? 'rgba(88,166,255,0.12)' : 'transparent', color: speed === s ? '#58A6FF' : '#C9D1D9', cursor: 'pointer' }}>{s}x</button>
          ))}
        </div>
        {[{ k: 'heatmap', l: 'Heatmap', v: showHeatmap, s: setShowHeatmap }, { k: 'names', l: 'Names', v: showNames, s: setShowNames }].map(b => (
          <button key={b.k} onClick={() => b.s((v: boolean) => !v)} style={{ padding: '4px 12px', borderRadius: 5, fontSize: 13, fontFamily: 'inherit', border: b.v ? '1px solid rgba(88,166,255,0.4)' : '1px solid rgba(255,255,255,0.08)', background: b.v ? 'rgba(88,166,255,0.12)' : 'transparent', color: b.v ? '#58A6FF' : '#C9D1D9', cursor: 'pointer' }}>{b.l}</button>
        ))}
        <span style={{ color: '#E6EDF3', fontSize: 11 }}>|</span>
        <button onClick={() => setZoom(z => Math.min(3, z * 1.15))} style={{ padding: '3px 8px', borderRadius: 4, fontSize: 14, border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#E6EDF3', cursor: 'pointer' }}>+</button>
        <span style={{ fontSize: 11, color: '#E6EDF3', minWidth: 35, textAlign: 'center' as const }}>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.max(0.3, z / 1.15))} style={{ padding: '3px 8px', borderRadius: 4, fontSize: 14, border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#E6EDF3', cursor: 'pointer' }}>−</button>
        <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} style={{ padding: '3px 8px', borderRadius: 4, fontSize: 11, border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#E6EDF3', cursor: 'pointer' }}>Reset</button>
      </div>

      {/* Canvas */}
      {activeWf && (() => {
        const dayPhase = getDayPhase(new Date());
        const overlayColor = getDayOverlayColor(dayPhase);
        const [skyTop, skyBottom] = getSkyGradient(dayPhase);
        const timeLabel = `${Math.floor(dayPhase.hour)}:${String(Math.floor((dayPhase.hour % 1) * 60)).padStart(2, '0')}`;
        const periodLabel = dayPhase.isNight ? '🌙 Night' : dayPhase.isDawn ? '🌅 Dawn' : dayPhase.isDusk ? '🌇 Dusk' : '☀️ Day';

        return (
        <div style={{ flex: 1, minHeight: 0, padding: '10px 16px', overflow: 'hidden', display: 'flex', flexDirection: 'column' as const }}>
          {/* Time indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, paddingLeft: 4, flexShrink: 0 }}>
            <span style={{ fontSize: 12 }}>{periodLabel}</span>
            <span style={{ fontSize: 11, color: '#E6EDF3', fontFamily: 'monospace' }}>{timeLabel}</span>
            {dayPhase.isNight && <span style={{ fontSize: 10, color: '#9B8EC4' }}>Overnight instances will look tired</span>}
          </div>
          <div style={{ flex: 1, minHeight: 0, position: 'relative' as const, borderRadius: 10, border: '1px solid rgba(255,255,255,0.05)', overflow: 'hidden' }}>
          <svg ref={svgRef}
            viewBox={`${-pan.x / zoom} ${-pan.y / zoom} ${contentWidth / zoom} ${contentHeight / zoom}`}
            preserveAspectRatio="xMidYMid slice"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: 'rgba(255,255,255,0.01)', cursor: dragPerson ? 'grabbing' : 'default' }}
            onClick={() => { if (!dragPerson) setSelected(null); }}
            onMouseMove={e => {
              if (dragPerson && svgRef.current) {
                const svg = svgRef.current;
                const pt = svg.createSVGPoint();
                pt.x = e.clientX; pt.y = e.clientY;
                const svgPt = pt.matrixTransform(svg.getScreenCTM()!.inverse());
                setDragPos({ x: svgPt.x, y: svgPt.y });
              }
            }}
            onMouseUp={async () => {
              if (!dragPerson || !dragPos || !dragOrigin || !activeWf) { setDragPerson(null); setDragPos(null); setDragOrigin(null); return; }
              // Check if dropped on a zone (use isometric diamond test if available)
              let dropZone: ZoneDefinition | undefined;
              if (isoLayout) {
                const hitRoom = isoLayout.rooms.find(r =>
                  r.zone.type !== 'door' && r.zone.type !== 'error' &&
                  pointInDiamond(dragPos.x, dragPos.y, r)
                );
                dropZone = hitRoom?.zone;
              } else {
                dropZone = activeWf.zones.find(z =>
                  z.type !== 'door' && z.type !== 'error' &&
                  dragPos.x >= z.x - z.w / 2 && dragPos.x <= z.x + z.w / 2 &&
                  dragPos.y >= z.y - z.h / 2 && dragPos.y <= z.y + z.h / 2
                );
              }
              const personId = dragPerson;
              const origZone = dragOrigin.zoneId;
              const origX = dragOrigin.x;
              const origY = dragOrigin.y;
              setDragPerson(null); setDragPos(null); setDragOrigin(null);

              if (dropZone && dropZone.id !== origZone) {
                // Dropped on a different zone → walk through doors to new zone
                const destRoom = isoLayout?.rooms.find(r => r.zone.id === dropZone.id);
                const currentRoom = isoLayout?.rooms.find(r => r.zone.id === origZone);
                const currentDoor = currentRoom?.doors[0];
                const destDoor = destRoom?.doors[0];

                // Final position inside destination room diamond
                let finalX: number, finalY: number;
                if (destRoom) {
                  const pos = getPositionInRoom(destRoom, Math.random());
                  finalX = pos.x; finalY = pos.y;
                } else {
                  finalX = dropZone.x + (Math.random() - 0.5) * dropZone.w * 0.1;
                  finalY = dropZone.y + (Math.random() - 0.5) * dropZone.h * 0.05;
                }

                // Snap person back inside their room first (drag may have pulled them out)
                const snapX = currentDoor ? currentDoor.screenX : origX;
                const snapY = currentDoor ? currentDoor.screenY : origY;

                if (currentDoor && isoLayout) {
                  const waypoints = destDoor
                    ? computeCorridorWaypoints(currentDoor, destDoor, isoLayout)
                    : [];
                  setPeople(prev => prev.map(p => p.id !== personId ? p : {
                    ...p, x: origX, y: origY,
                    walkPhase: 'to-door' as const,
                    walkDestZoneId: dropZone.id,
                    walkFinalX: finalX, walkFinalY: finalY,
                    corridorWaypoints: waypoints, corridorWaypointIdx: 0,
                    targetX: currentDoor.screenX, targetY: currentDoor.screenY,
                    state: 'walking' as PersonState,
                    emotion: 'happy' as Emotion, emotionTimer: 80,
                    lastAction: `GoTo → ${dropZone.label}`, lastActionTimer: 200,
                  }));
                } else {
                  setPeople(prev => prev.map(p => p.id !== personId ? p : {
                    ...p, x: origX, y: origY,
                    targetX: finalX, targetY: finalY,
                    zoneId: dropZone.id,
                    state: 'walking' as PersonState,
                    emotion: 'happy' as Emotion, emotionTimer: 80,
                    lastAction: `GoTo → ${dropZone.label}`, lastActionTimer: 200,
                  }));
                }
                // Call the GoTo Activity API — if it fails, walk back through doors
                try {
                  const person = people.find(p => p.id === personId);
                  if (person) {
                    const k2ActivityName = dropZone.k2ActivityName || dropZone.label;
                    const ok = await goToActivity(person.processInstanceId, k2ActivityName);
                    if (!ok) {
                      // API rejected — walk back through doors
                      const failCurrentRoom = isoLayout?.rooms.find(r => r.zone.id === dropZone.id);
                      const failDoor = failCurrentRoom?.doors[0];
                      const failOrigRoom = isoLayout?.rooms.find(r => r.zone.id === origZone);
                      const failOrigDoor = failOrigRoom?.doors[0];
                      if (failDoor && failOrigDoor && isoLayout) {
                        const wp = computeCorridorWaypoints(failDoor, failOrigDoor, isoLayout);
                        setPeople(prev => prev.map(p => p.id !== personId ? p : {
                          ...p, umbrellaActive: false,
                          walkPhase: 'to-door' as const, walkDestZoneId: origZone,
                          walkFinalX: origX, walkFinalY: origY,
                          corridorWaypoints: wp, corridorWaypointIdx: 0,
                          targetX: failDoor.screenX, targetY: failDoor.screenY,
                          state: 'walking' as PersonState, emotion: 'sad' as Emotion, emotionTimer: 60,
                        }));
                      } else {
                        setPeople(prev => prev.map(p => p.id !== personId ? p : {
                          ...p, umbrellaActive: false, zoneId: origZone,
                          targetX: origX, targetY: origY,
                          state: 'walking' as PersonState, emotion: 'sad' as Emotion, emotionTimer: 60,
                        }));
                      }
                    }
                  }
                } catch (err) {
                  console.error('GoTo failed:', err);
                  setPeople(prev => prev.map(p => p.id !== personId ? p : {
                    ...p, umbrellaActive: false, zoneId: origZone,
                    targetX: origX, targetY: origY,
                    state: 'walking' as PersonState, emotion: 'sad' as Emotion, emotionTimer: 60,
                  }));
                }
              } else {
                // Dropped nowhere useful → snap back to original position (inside room)
                setPeople(prev => prev.map(p => p.id !== personId ? p : {
                  ...p, x: origX, y: origY,
                  targetX: origX, targetY: origY,
                  state: 'idle' as PersonState,
                  emotion: 'sad' as Emotion, emotionTimer: 40,
                }));
              }
            }}
            onMouseLeave={() => {
              if (dragPerson) {
                // Dragged outside SVG → snap back to original position (inside room)
                const ox = dragOrigin?.x ?? 0;
                const oy = dragOrigin?.y ?? 0;
                setPeople(prev => prev.map(p => p.id !== dragPerson ? p : {
                  ...p, x: ox, y: oy, targetX: ox, targetY: oy,
                  state: 'idle' as PersonState,
                }));
                setDragPerson(null); setDragPos(null); setDragOrigin(null);
              }
            }}>
            <defs>
              <pattern id="floor" width="30" height="30" patternUnits="userSpaceOnUse">
                <rect x="0" y="0" width="30" height="30" fill="#5A6070" />
                <rect x="0" y="0" width="14" height="14" rx="1" fill="rgba(255,255,255,0.04)" />
                <rect x="15" y="15" width="14" height="14" rx="1" fill="rgba(255,255,255,0.04)" />
              </pattern>
              <linearGradient id="skyGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={skyTop} />
                <stop offset="100%" stopColor={skyBottom} />
              </linearGradient>
              {/* Window glow for dawn/dusk */}
              {(dayPhase.isDawn || dayPhase.isDusk) && (
                <radialGradient id="sunGlow" cx="0.5" cy="0" r="0.8">
                  <stop offset="0%" stopColor={dayPhase.isDawn ? 'rgba(255,200,100,0.08)' : 'rgba(255,120,60,0.06)'} />
                  <stop offset="100%" stopColor="rgba(0,0,0,0)" />
                </radialGradient>
              )}
            </defs>

            {/* Base floor */}
            <rect width={contentWidth} height={contentHeight} fill="url(#floor)" rx="10" />

            {/* Day/night overlay */}
            <rect width={contentWidth} height={contentHeight} fill={overlayColor} rx="10" style={{ pointerEvents: 'none' }} />

            {/* Dawn/dusk warm glow */}
            {(dayPhase.isDawn || dayPhase.isDusk) && (
              <rect width={contentWidth} height={contentHeight} fill="url(#sunGlow)" rx="10" style={{ pointerEvents: 'none' }} />
            )}

            {/* Night stars */}
            {dayPhase.isNight && Array.from({ length: 15 }, (_, i) => (
              <circle key={`star-${i}`}
                cx={seededRand(i * 7.1) * contentWidth}
                cy={seededRand(i * 3.3) * contentHeight * 0.4}
                r={0.8 + seededRand(i * 5.7) * 1.2}
                fill="white"
                opacity={0.15 + Math.sin(now / (600 + i * 100) + i) * 0.1} />
            ))}

            {/* Night: subtle blue light pools under zones */}
            {dayPhase.isNight && activeWf.zones.map(z => (
              <ellipse key={`glow-${z.id}`} cx={z.x} cy={z.y} rx={z.w * 0.4} ry={z.h * 0.3}
                fill="rgba(88,166,255,0.03)" style={{ pointerEvents: 'none' }} />
            ))}

            {/* Flow lines */}
            {activeWf.connections.map((c, i) => {
              const from = activeWf.zones.find(z => z.id === c.from);
              const to = activeWf.zones.find(z => z.id === c.to);
              if (!from || !to) return null;
              return <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="rgba(255,255,255,0.03)" strokeWidth="1.5" strokeDasharray="6,8" />;
            })}

            {/* Corridor tiles between rooms */}
            {isoLayout && isoLayout.corridors.map((tile, i) => (
              <IsoCorridorTile key={`corr-${i}`} tile={tile} />
            ))}
            {/* Water coolers and plants in corridor */}
            {isoLayout && isoLayout.corridors.length > 0 && (() => {
              const items: JSX.Element[] = [];
              const corr = isoLayout.corridors;
              // Place water coolers at regular intervals
              for (let i = Math.floor(corr.length * 0.2); i < corr.length; i += Math.max(8, Math.floor(corr.length / 4))) {
                items.push(<WaterCooler key={`wc-${i}`} x={corr[i].screenX + 8} y={corr[i].screenY - 6} />);
              }
              // Place plants at different intervals
              for (let i = Math.floor(corr.length * 0.1); i < corr.length; i += Math.max(12, Math.floor(corr.length / 3))) {
                items.push(<CorridorPlant key={`pl-${i}`} x={corr[i].screenX - 8} y={corr[i].screenY - 4} />);
              }
              return items;
            })()}

            {/* Connection lines between rooms */}
            {isoLayout && isoLayout.connections.map((conn, i) => (
              <IsoConnectionLine key={`conn-${i}`} conn={conn} now={now} />
            ))}

            {/* Isometric Rooms */}
            {isoLayout && isoLayout.rooms
              .slice().sort((a, b) => (a.tileX + a.tileY) - (b.tileX + b.tileY))
              .map(room => (
              <IsoRoomComponent key={room.zone.id} room={room}
                count={zoneCounts[room.zone.id] || 0} now={now}
                isHeatmap={showHeatmap} isBottleneck={bottleneckIds.has(room.zone.id)}
                isDragOver={!!(dragPerson && dragPos && pointInDiamond(dragPos.x, dragPos.y, room))}
                hasNearbyWalker={(() => {
                  const door = room.doors[0];
                  if (!door) return false;
                  return people.some(p => p.state === 'walking' && (
                    (Math.abs(p.x - door.screenX) < 35 && Math.abs(p.y - door.screenY) < 25) ||
                    (Math.abs(p.x - door.outsideX) < 35 && Math.abs(p.y - door.outsideY) < 25)
                  ));
                })()} />
            ))}

            {/* People */}
            {/* Drag line from origin */}
            {dragPerson && dragPos && dragOrigin && (
              <line x1={dragOrigin.x} y1={dragOrigin.y} x2={dragPos.x} y2={dragPos.y}
                stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeDasharray="4,4" />
            )}

            {[...people].sort((a, b) => (a.state === 'walking' ? 1 : 0) - (b.state === 'walking' ? 1 : 0)).map(p => (
              <PersonSprite key={p.id} p={dragPerson === p.id ? { ...p, x: dragPos?.x ?? p.x, y: dragPos?.y ?? p.y } : p}
                now={now} isSelected={selected === p.id} showNames={showNames}
                onClick={() => { if (!dragPerson) setSelected(p.id); }}
                onDragStart={p.state !== 'error' && p.state !== 'completed' && !p.ambulanceActive && !p.umbrellaActive ? () => {
                  setDragPerson(p.id);
                  setDragOrigin({ x: p.x, y: p.y, zoneId: p.zoneId });
                  setDragPos({ x: p.x, y: p.y });
                } : undefined}
                onContextMenu={e => {
                  setCtxMenu({ x: e.clientX, y: e.clientY, personId: p.id });
                }}
              />
            ))}
          </svg>
          </div>
        </div>
        );
      })()}

      {/* Timeline */}
      {showHeatmap && activeWf && <Timeline history={history} zones={activeWf.zones} width={activeWf.width || 950} />}

      {/* Modal */}
      {/* Right-click context menu */}
      {ctxMenu && (() => {
        const person = people.find(p => p.id === ctxMenu.personId);
        if (!person) return null;
        const isErr = person.state === 'error';
        const menuItems: { label: string; icon: string; action: () => void; color?: string }[] = [
          { label: 'View Details', icon: '👤', action: () => { setSelected(person.id); setCtxMenu(null); } },
        ];
        if (isErr) {
          menuItems.push({ label: 'Retry Error', icon: '🔄', color: '#F85149', action: async () => {
            setCtxMenu(null);
            const wf = activeWf!;
            const personId = person.id;
            setPeople(prev => prev.map(p => p.id !== personId ? p : { ...p, state: 'idle' as PersonState, emotion: 'happy' as Emotion, emotionTimer: 120 }));
            const ok = await repairInstance(person.processInstanceId, 'Retried via Workflow World');
            if (!ok) setPeople(prev => prev.map(p => p.id !== personId ? p : { ...p, state: 'error' as PersonState, emotion: 'sad' as Emotion, emotionTimer: 80 }));
          }});
        }
        if (!isErr && person.destinationUsers.length > 0) {
          menuItems.push({ label: 'Redirect...', icon: '↪', color: '#F5A623', action: () => { setSelected(person.id); setRedirectMode(true); setRedirectUser(''); setCtxMenu(null); } });
        }
        if (!isErr && person.state !== 'completed') {
          menuItems.push({ label: 'GoTo Activity (drag)', icon: '🪂', action: () => { setCtxMenu(null); } });
        }
        // Stop instance — taxi parks near door, person walks out and gets in
        menuItems.push({ label: 'Stop Instance', icon: '🚕', color: '#FF6B6B', action: async () => {
          const personId = person.id;
          const procId = person.processInstanceId;
          const personZoneId = person.zoneId;
          setCtxMenu(null);
          // Find room door position for taxi to park at
          const room = isoLayout?.rooms.find(r => r.zone.id === personZoneId);
          const door = room?.doors[0];
          const doorX = door ? door.screenX : person.x;
          const doorY = door ? door.screenY : person.y;

          // Compute taxi route along corridors
          let taxiRoute: { x: number; y: number }[] = [];
          if (door && isoLayout) {
            taxiRoute = computeVehicleRoute(door, isoLayout);
          } else {
            taxiRoute = [{ x: doorX - 180, y: doorY + 5 }, { x: doorX, y: doorY }];
          }
          const taxiStartX = taxiRoute.length > 0 ? taxiRoute[0].x : doorX - 180;
          const taxiStartY = taxiRoute.length > 0 ? taxiRoute[0].y : doorY + 5;

          setPeople(prev => {
            const updated = prev.map(p => {
              if (p.id === personId) {
                return {
                  ...p,
                  taxiActive: true,
                  taxiPhase: 'driving-to' as const,
                  taxiX: taxiStartX,
                  taxiY: taxiStartY,
                  taxiTimer: 0,
                  taxiWaypoints: taxiRoute,
                  taxiWaypointIdx: 0,
                  // Person starts walking to the door
                  state: 'walking' as PersonState,
                  targetX: doorX,
                  targetY: doorY,
                  walkPhase: null,
                  walkDestZoneId: null,
                  lastAction: 'Leaving...',
                  lastActionTimer: 200,
                  emotion: 'happy' as Emotion,
                  emotionTimer: 150,
                };
              }
              return p;
            });
            return updated;
          });
          // Call the Stop API
          try {
            const { stopInstance } = await import('./services/workflowApi');
            await stopInstance(procId);
          } catch (err) { console.error('Stop failed:', err); }
        }});
        return (
          <div onClick={() => setCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setCtxMenu(null); }}
            style={{ position: 'fixed', inset: 0, zIndex: 2000 }}>
            <div style={{
              position: 'fixed', left: ctxMenu.x, top: ctxMenu.y,
              background: 'rgba(22,27,34,0.98)', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 10, padding: '6px 0', minWidth: 180,
              boxShadow: '0 8px 30px rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)',
            }} onClick={e => e.stopPropagation()}>
              {/* Person header */}
              <div style={{ padding: '8px 14px 6px', borderBottom: '1px solid rgba(255,255,255,0.06)', marginBottom: 4 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#E6EDF3' }}>{person.name}</div>
                <div style={{ fontSize: 10, color: '#8B949E', marginTop: 2 }}>{person.activityName} · {person.state}</div>
              </div>
              {menuItems.map((item, i) => (
                <div key={i} onClick={item.action}
                  style={{
                    padding: '8px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
                    fontSize: 12, color: item.color || '#E6EDF3', fontFamily: 'inherit',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <span style={{ fontSize: 13, width: 18, textAlign: 'center' }}>{item.icon}</span>
                  {item.label}
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {selectedPerson && activeWf && (
        <div onClick={() => setSelected(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 520, margin: '0 20px', padding: '24px', background: selectedPerson.state === 'error' ? '#1a1215' : '#161B22', borderRadius: 14, border: selectedPerson.state === 'error' ? '1px solid rgba(248,81,73,0.3)' : '1px solid rgba(255,255,255,0.1)', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
              <svg width="56" height="56" viewBox="-15 -15 30 30">
                <circle cx="0" cy="0" r="13" fill={selectedPerson.state === 'error' ? '#9ACD68' : selectedPerson.shirt} opacity="0.2" />
                <ellipse cx="0" cy="2" rx="6.5" ry="7" fill={selectedPerson.shirt} />
                <circle cx="0" cy="-6" r="5.5" fill={selectedPerson.state === 'error' ? '#9ACD68' : selectedPerson.skin} />
                {selectedPerson.state === 'error' ? (
                  <g>
                    <ellipse cx="-2.5" cy="-6.5" rx="1.3" ry="0.6" fill="#333" />
                    <ellipse cx="2.5" cy="-6.5" rx="1.3" ry="0.6" fill="#333" />
                    <path d="M-2.5,-3 Q0,-4 2.5,-3" fill="none" stroke="#5A7A4A" strokeWidth="0.8" />
                  </g>
                ) : (
                  <g><circle cx="-2.5" cy="-7" r="1" fill="#333" /><circle cx="2.5" cy="-7" r="1" fill="#333" /></g>
                )}
              </svg>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#E6EDF3' }}>{selectedPerson.name}</div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>
                  {activeWf.zones.find(z => z.id === selectedPerson.zoneId)?.label || selectedPerson.zoneId} · {selectedPerson.activityName}
                </div>
              </div>
              <div style={{ padding: '5px 14px', borderRadius: 14, fontSize: 12, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em',
                background: ({ error: '#F8514920', completed: '#3FB95020', sleeping: '#9B8EC420', walking: '#58A6FF20', chatting: '#1ABC9C20' } as Record<string, string>)[selectedPerson.state] || '#F5A62320',
                color: ({ error: '#F85149', completed: '#3FB950', sleeping: '#C4B8E8', walking: '#58A6FF', chatting: '#1ABC9C' } as Record<string, string>)[selectedPerson.state] || '#FFD080',
              }}>{selectedPerson.state === 'error' ? '🤢 Error' : selectedPerson.state}</div>
            </div>

            {/* Info grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', padding: '12px 14px', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)', marginBottom: 16, fontSize: 12 }}>
              <div><span style={{ color: '#E6EDF3' }}>Originator: </span><span style={{ color: '#C9D1D9' }}>{selectedPerson.originator}</span></div>
              <div><span style={{ color: '#E6EDF3' }}>Folio: </span><span style={{ color: '#C9D1D9' }}>{selectedPerson.folio || '—'}</span></div>
              <div><span style={{ color: '#E6EDF3' }}>Instance ID: </span><span style={{ color: '#C9D1D9' }}>{selectedPerson.processInstanceId}</span></div>
              <div><span style={{ color: '#E6EDF3' }}>Wait: </span><span style={{ color: '#C9D1D9' }}>{selectedPerson.waitTimeSeconds > 3600 ? `${Math.floor(selectedPerson.waitTimeSeconds / 3600)}h ${Math.floor((selectedPerson.waitTimeSeconds % 3600) / 60)}m` : `${Math.floor(selectedPerson.waitTimeSeconds / 60)}m`}</span></div>
              <div><span style={{ color: '#E6EDF3' }}>Trait: </span><span style={{ color: '#C9D1D9' }}>{selectedPerson.trait}</span></div>
              <div><span style={{ color: '#E6EDF3' }}>Activity: </span><span style={{ color: '#C9D1D9' }}>{selectedPerson.activityName}</span></div>
            </div>

            {/* Destination users */}
            {selectedPerson.destinationUsers.length > 0 && (
              <div style={{ padding: '12px 14px', background: 'rgba(88,166,255,0.06)', borderRadius: 8, border: '1px solid rgba(88,166,255,0.15)', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 14 }}>📞</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#58A6FF' }}>Assigned To ({selectedPerson.destinationUsers.length})</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6 }}>
                  {selectedPerson.destinationUsers.map((user, i) => (
                    <div key={i} style={{ padding: '4px 10px', borderRadius: 12, fontSize: 11, background: 'rgba(88,166,255,0.12)', color: '#58A6FF', border: '1px solid rgba(88,166,255,0.2)', fontFamily: 'monospace', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ fontSize: 10 }}>👤</span> {user}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedPerson.availableActions.length > 0 && (
              <div style={{ padding: '12px 14px', background: 'rgba(39,174,96,0.06)', borderRadius: 8, border: '1px solid rgba(39,174,96,0.15)', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 14 }}>⚡</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#3FB950' }}>Available Actions</span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6 }}>
                  {selectedPerson.availableActions.map((action, i) => (
                    <div key={i} style={{ padding: '4px 10px', borderRadius: 12, fontSize: 11, background: 'rgba(39,174,96,0.12)', color: '#3FB950', border: '1px solid rgba(39,174,96,0.2)', fontFamily: 'monospace' }}>
                      {action}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Error detail section */}
            {selectedPerson.state === 'error' && (
              <div style={{ padding: '14px 16px', background: 'rgba(248,81,73,0.08)', borderRadius: 8, border: '1px solid rgba(248,81,73,0.15)', marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 16 }}>🚨</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#F85149' }}>Error Details</span>
                </div>
                <div style={{ fontSize: 12, color: '#C9D1D9', lineHeight: 1.6, wordBreak: 'break-word' as const, fontFamily: 'monospace', background: 'rgba(0,0,0,0.35)', padding: '10px 12px', borderRadius: 6, maxHeight: 150, overflowY: 'auto' as const }}>
                  {selectedPerson.errorMessage || 'No error message available — the instance is in a stopped or error state.'}
                </div>
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              {selectedPerson.state === 'error' && (
                <button onClick={async () => {
                  const personId = selectedPerson.id;
                  const procId = selectedPerson.processInstanceId;
                  const personZoneId = selectedPerson.zoneId;
                  const wf = activeWf!;
                  const errorZone = wf.zones.find(z => z.type === 'error');

                  // 1. Close modal immediately
                  setSelected(null);

                  // 2. Start walking out of error-corner toward entrance hopefully
                  const entrance = wf.zones.find(z => z.type === 'door');
                  const midZone = wf.zones.find(z => z.type === 'desk') || entrance;
                  const walkTarget = midZone || entrance;
                  const walkRoom = isoLayout?.rooms.find(r => r.zone.id === walkTarget?.id);
                  // Walk through doors: current room door → corridor → dest room door → inside
                  const currentRoom = isoLayout?.rooms.find(r => r.zone.id === personZoneId);
                  const currentDoor = currentRoom?.doors[0];
                  const destDoor = walkRoom?.doors[0];
                  let wtx: number, wty: number;
                  if (walkRoom) {
                    const pos = getPositionInRoom(walkRoom, Math.random());
                    wtx = pos.x; wty = pos.y;
                  } else {
                    wtx = walkTarget ? walkTarget.x + (Math.random() - 0.5) * 30 : 0;
                    wty = walkTarget ? walkTarget.y + Math.random() * 20 : 0;
                  }
                  if (currentDoor && isoLayout) {
                    const waypoints = destDoor
                      ? computeCorridorWaypoints(currentDoor, destDoor, isoLayout)
                      : [];
                    setPeople(prev => prev.map(p => p.id !== personId ? p : {
                      ...p, state: 'walking' as PersonState, emotion: 'happy' as Emotion, emotionTimer: 120,
                      walkPhase: 'to-door' as const,
                      walkDestZoneId: walkTarget ? walkTarget.id : p.zoneId,
                      walkFinalX: wtx || p.x,
                      walkFinalY: wty || p.y,
                      targetX: currentDoor.screenX,
                      targetY: currentDoor.screenY,
                      corridorWaypoints: waypoints,
                      corridorWaypointIdx: 0,
                    }));
                  } else {
                    setPeople(prev => prev.map(p => p.id !== personId ? p : {
                      ...p, state: 'walking' as PersonState, emotion: 'happy' as Emotion, emotionTimer: 120,
                      zoneId: walkTarget ? walkTarget.id : p.zoneId,
                      targetX: wtx || p.x,
                      targetY: wty || p.y,
                    }));
                  }

                  // 3. Send retry to K2
                  const ok = await repairInstance(procId, 'Retried via Workflow World');
                  if (!ok) {
                    // API call failed — go straight back to error
                    setPeople(prev => prev.map(p => p.id !== personId ? p : {
                      ...p, state: 'error' as PersonState, emotion: 'sad' as Emotion, emotionTimer: 80,
                    }));
                    return;
                  }

                  // 4. Wait for K2 to process the retry
                  await new Promise(r => setTimeout(r, 3000));

                  // 5. Re-fetch to check actual state
                  try {
                    const insts = await getInstances(activeWfId!);
                    const updated = insts.find(i => i.id === personId);
                    if (updated && updated.state !== 'error') {
                      // SUCCESS — walk through doors to new zone with celebration
                      const destRoom2 = isoLayout?.rooms.find(r => r.zone.id === updated.currentZoneId);
                      const currRoom2 = isoLayout?.rooms.find(r => r.zone.id === personZoneId);
                      const currDoor2 = currRoom2?.doors[0];
                      const destDoor2 = destRoom2?.doors[0];
                      let tx2: number, ty2: number;
                      if (destRoom2) {
                        const pos = getPositionInRoom(destRoom2, Math.random());
                        tx2 = pos.x; ty2 = pos.y;
                      } else {
                        const zone = wf.zones.find(z => z.id === updated.currentZoneId) || wf.zones.find(z => z.type === 'door');
                        tx2 = zone ? zone.x : 0;
                        ty2 = zone ? zone.y : 0;
                      }
                      if (currDoor2 && isoLayout) {
                        const wp2 = destDoor2
                          ? computeCorridorWaypoints(currDoor2, destDoor2, isoLayout)
                          : [];
                        setPeople(prev => prev.map(p => p.id !== personId ? p : {
                          ...p, state: 'walking' as PersonState, emotion: 'jump' as Emotion, emotionTimer: 80,
                          walkPhase: 'to-door' as const,
                          walkDestZoneId: updated.currentZoneId,
                          walkFinalX: tx2 || p.x,
                          walkFinalY: ty2 || p.y,
                          targetX: currDoor2.screenX,
                          targetY: currDoor2.screenY,
                          corridorWaypoints: wp2,
                          corridorWaypointIdx: 0,
                        }));
                      } else {
                        setPeople(prev => prev.map(p => p.id !== personId ? p : {
                          ...p, state: 'walking' as PersonState, emotion: 'jump' as Emotion, emotionTimer: 80,
                          zoneId: updated.currentZoneId,
                          targetX: tx2 || p.x,
                          targetY: ty2 || p.y,
                        }));
                      }
                    } else {
                      // STILL IN ERROR — ambulance drives them back to error-corner
                      const errRoom = isoLayout?.rooms.find(r => r.zone.id === 'error-corner');
                      const errDoor2 = errRoom?.doors[0];
                      let ambRoute2: { x: number; y: number }[] = [];
                      let ambStart2x = (wf.width || 950) + 40, ambStart2y = 0;
                      if (errDoor2 && isoLayout) {
                        ambRoute2 = computeVehicleRoute(errDoor2, isoLayout);
                        ambStart2x = ambRoute2[0]?.x ?? ambStart2x;
                        ambStart2y = ambRoute2[0]?.y ?? 0;
                      }
                      setPeople(prev => prev.map(p => p.id !== personId ? p : {
                        ...p, emotion: 'sad' as Emotion, emotionTimer: 100,
                        ambulanceActive: true, ambulancePhase: 'driving-to' as const,
                        ambulanceX: ambStart2x, ambulanceY: ambStart2y,
                        ambulanceTargetX: errDoor2 ? errDoor2.outsideX : (errorZone ? errorZone.x : 880),
                        ambulanceTargetY: errDoor2 ? errDoor2.outsideY : (errorZone ? errorZone.y : 470),
                        ambulanceWaypoints: ambRoute2, ambulanceWaypointIdx: 0,
                        ambulanceTimer: 0, prevState: p.state,
                      }));
                    }
                  } catch {
                    // Network error — ambulance back to error
                    setPeople(prev => prev.map(p => p.id !== personId ? p : {
                      ...p, state: 'error' as PersonState, emotion: 'sad' as Emotion, emotionTimer: 80,
                    }));
                  }
                }} style={{ padding: '10px 24px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', fontWeight: 600, border: '1px solid rgba(248,81,73,0.4)', background: 'rgba(248,81,73,0.15)', color: '#F85149', cursor: 'pointer', transition: 'all 0.2s' }}>
                  🔄 Retry Error
                </button>
              )}
              {/* Redirect button — only for non-error instances with destination users */}
              {selectedPerson.state !== 'error' && selectedPerson.destinationUsers.length > 0 && !redirectMode && (
                <button onClick={() => { setRedirectMode(true); setRedirectUser(''); }} style={{ padding: '10px 24px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', fontWeight: 600, border: '1px solid rgba(245,166,35,0.4)', background: 'rgba(245,166,35,0.15)', color: '#F5A623', cursor: 'pointer', transition: 'all 0.2s' }}>
                  ↪ Redirect
                </button>
              )}
              {/* Redirect inline form */}
              {redirectMode && (() => {
                const doRedirect = async () => {
                  if (!redirectUser.trim()) return;
                  const personId = selectedPerson.id;
                  const ok = await redirectInstance(selectedPerson.processInstanceId, redirectUser.trim());
                  if (ok) {
                    setPeople(prev => prev.map(p => p.id !== personId ? p : {
                      ...p, lastAction: `Redirected → ${redirectUser.trim().split('\\').pop()}`,
                      lastActionTimer: 200, emotion: 'happy' as Emotion, emotionTimer: 80,
                    }));
                    setRedirectMode(false); setRedirectUser(''); setSelected(null);
                  }
                };
                return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                  <input type="text" placeholder="DOMAIN\username" value={redirectUser}
                    onChange={e => setRedirectUser(e.target.value)} autoFocus
                    style={{ padding: '8px 12px', borderRadius: 6, fontSize: 12, fontFamily: 'monospace', border: '1px solid rgba(245,166,35,0.3)', background: 'rgba(0,0,0,0.3)', color: '#E6EDF3', outline: 'none', flex: 1, minWidth: 140 }}
                    onKeyDown={e => { if (e.key === 'Enter') doRedirect(); if (e.key === 'Escape') { setRedirectMode(false); setRedirectUser(''); } }}
                  />
                  <button onClick={doRedirect} style={{ padding: '8px 14px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', fontWeight: 600, border: '1px solid rgba(39,185,80,0.4)', background: 'rgba(39,185,80,0.15)', color: '#3FB950', cursor: 'pointer', whiteSpace: 'nowrap' as const }}>
                    ✓ Send
                  </button>
                  <button onClick={() => { setRedirectMode(false); setRedirectUser(''); }} style={{ padding: '8px 10px', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#E6EDF3', cursor: 'pointer' }}>
                    ✕
                  </button>
                </div>);
              })()}
              <button onClick={() => { setSelected(null); setRedirectMode(false); }} style={{ padding: '10px 20px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)', color: '#999', cursor: 'pointer' }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
