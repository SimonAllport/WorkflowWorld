import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { getWorkflows, getWorkflow, getInstances, getStats, repairInstance, redirectInstance, goToActivity } from './services/workflowApi';
import { useWorkflowHub } from './hooks/useWorkflowHub';
import { computeIsoLayout, pointInDiamond } from './iso/isoEngine';
import type { IsoLayout } from './iso/isoEngine';
import IsoRoomComponent, { IsoConnectionLine } from './iso/IsoRoom';
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
  prevState: PersonState | null;  // state before error, to detect transitions
  // Last action taken (shown as speech bubble when transitioning)
  lastAction: string | null;
  lastActionTimer: number;
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
function instanceToPerson(inst: WorkflowInstance, zones: ZoneDefinition[]): AnimPerson {
  const zone = zones.find(z => z.id === inst.currentZoneId);
  const bx = zone ? zone.x : 70;
  const by = zone ? zone.y : 260;
  const boundsW = zone ? zone.w : 40;
  const boundsH = zone ? zone.h : 40;
  const sx = (boundsW / 2 - 5) * (seededRand(inst.processInstanceId) * 2 - 1);
  const sy = (boundsH / 2 - 5) * seededRand(inst.processInstanceId + 1);
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
    prevState: null,
    lastAction: null,
    lastActionTimer: 0,
    umbrellaActive: false,
    umbrellaY: 0,
    umbrellaTargetY: 0,
  };
}

// ─── Shared merge logic for updating a person from K2 instance data ──────
function mergePersonWithInstance(existing: AnimPerson, inst: WorkflowInstance, wf: WorkflowDefinition): AnimPerson {
  // Detect transition TO error → trigger ambulance
  if (inst.state === 'error' && existing.state !== 'error' && !existing.ambulanceActive) {
    const startX = (wf.width || 950) + 40;
    const errorZone = wf.zones.find(z => z.type === 'error');
    return {
      ...existing, waitTimeSeconds: inst.waitTimeSeconds, errorMessage: inst.errorMessage,
      destinationUsers: inst.destinationUsers || [], availableActions: inst.availableActions || [],
      ambulanceActive: true, ambulancePhase: 'driving-to' as const,
      ambulanceX: startX, ambulanceY: existing.y,
      ambulanceTargetX: errorZone ? errorZone.x + (Math.random() - 0.5) * 20 : 880,
      ambulanceTargetY: errorZone ? errorZone.y + Math.random() * 10 : 470,
      ambulanceTimer: 0, prevState: existing.state,
    };
  }
  // Zone changed → walk to new zone, infer action taken
  if (existing.zoneId !== inst.currentZoneId && inst.state !== 'error') {
    const zone = wf.zones.find(z => z.id === inst.currentZoneId);
    if (zone) {
      const prevActions = existing.availableActions || [];
      const actionTaken = prevActions.length === 1 ? prevActions[0] : prevActions.length > 1 ? 'Actioned' : null;
      return {
        ...existing, zoneId: inst.currentZoneId,
        targetX: zone.x + (zone.w / 2 - 14) * (Math.random() * 2 - 1),
        targetY: zone.y + 6 + (zone.h / 2 - 12) * Math.random(),
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
function simulate(people: AnimPerson[], zones: ZoneDefinition[], dt: number): AnimPerson[] {
  // Pre-build lookups to avoid O(n*z) zone.find() calls in the hot path
  const zoneMap = new Map<string, ZoneDefinition>();
  let errorZone: ZoneDefinition | undefined;
  for (const z of zones) {
    zoneMap.set(z.id, z);
    if (z.type === 'error') errorZone = z;
  }
  const byZone: Record<string, AnimPerson[]> = {};
  people.forEach(p => { if (!byZone[p.zoneId]) byZone[p.zoneId] = []; byZone[p.zoneId].push(p); });

  return people.filter(p => p.exitOpacity > 0.01).map(orig => {
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

    // ─── Ambulance animation ─────────────────────────────────
    if (p.ambulanceActive && p.ambulancePhase !== 'done') {
      p.ambulanceTimer += dt;
      const ambSpeed = 1.2 * dt;

      if (p.ambulancePhase === 'driving-to') {
        // Drive ambulance toward the person
        const dx = p.x - p.ambulanceX;
        const dy = p.y - p.ambulanceY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 8) {
          p.ambulanceX += (dx / dist) * ambSpeed;
          p.ambulanceY += (dy / dist) * ambSpeed;
        } else {
          // Arrived at person — loading phase
          p.ambulancePhase = 'loading';
          p.ambulanceTimer = 0;
          p.emotion = 'nervous';
          p.emotionTimer = 40;
        }
      } else if (p.ambulancePhase === 'loading') {
        // Brief pause while "loading" the person
        if (p.ambulanceTimer > 40) {
          // Find the error corner zone
          const errorZone = zoneMap.get('error-corner');
          if (errorZone) {
            p.ambulanceTargetX = errorZone.x + (Math.random() - 0.5) * 20;
            p.ambulanceTargetY = errorZone.y + Math.random() * 10;
          }
          p.ambulancePhase = 'driving-away';
          p.ambulanceTimer = 0;
        }
      } else if (p.ambulancePhase === 'driving-away') {
        // Drive ambulance (with person inside) to error corner
        const dx = p.ambulanceTargetX - p.ambulanceX;
        const dy = p.ambulanceTargetY - p.ambulanceY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Person rides along
        p.x = p.ambulanceX;
        p.y = p.ambulanceY;
        if (dist > 8) {
          p.ambulanceX += (dx / dist) * ambSpeed;
          p.ambulanceY += (dy / dist) * ambSpeed;
        } else {
          // Arrived at error corner
          p.ambulancePhase = 'done';
          p.ambulanceActive = false;
          p.zoneId = 'error-corner';
          p.x = p.ambulanceTargetX;
          p.y = p.ambulanceTargetY;
          p.targetX = p.x;
          p.targetY = p.y;
          p.state = 'error';
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

    // Walking
    if (p.state === 'walking') {
      const dx = p.targetX - p.x, dy = p.targetY - p.y, dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 2) { p.angle = Math.atan2(dy, dx); p.x += (dx / dist) * p.speed * dt; p.y += (dy / dist) * p.speed * dt; }
      else {
        // Arrived — wander within zone
        const zone = zoneMap.get(p.zoneId);
        if (zone) {
          p.state = 'idle';
          p.moveTimer = 60 + Math.random() * 150;
        }
      }
    }

    // Idle wander within zone (skip error/completed/rejected — they stay put)
    if ((p.state === 'idle' || p.state === 'queuing') && p.moveTimer <= 0) {
      const zone = zoneMap.get(p.zoneId);
      if (zone && zone.type !== 'error' && zone.type !== 'exit-good' && zone.type !== 'exit-bad') {
        const wanderR = Math.min(zone.w, zone.h) * 0.3; // stay within 30% of zone bounds
        p.targetX = zone.x + (Math.random() * 2 - 1) * wanderR;
        p.targetY = zone.y + (Math.random() * 2 - 1) * wanderR * 0.5; // less vertical movement in iso
        p.state = 'walking';
      } else {
        p.moveTimer = 60 + Math.random() * 120; // just reset timer, don't wander
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
}

// ─── PersonSprite SVG ────────────────────────────────────────────────────
function PersonSprite({ p, now, isSelected, showNames, onClick, onDragStart }: {
  p: AnimPerson; now: number; isSelected: boolean; showNames: boolean; onClick: () => void; onDragStart?: () => void;
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
    <g transform={`translate(${x + fidgetX + paceX + anxiousWobble + sickSway}, ${y + bob + jumpY + slumpY})`}
      onClick={e => { e.stopPropagation(); onClick(); }}
      onMouseDown={e => { if (e.button === 0 && onDragStart) { e.preventDefault(); e.stopPropagation(); onDragStart(); } }}
      style={{ cursor: onDragStart ? 'grab' : 'pointer' }} opacity={p.exitOpacity}>
      {isSelected && <circle cx="0" cy="2" r="15" fill="none" stroke="#FFD700" strokeWidth="1.5" strokeDasharray="3,2" opacity="0.8">
        <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="4s" repeatCount="indefinite" /></circle>}
      {/* Hide person body when inside ambulance */}
      {p.ambulanceActive && p.ambulancePhase === 'driving-away' ? null : <>
      <ellipse cx="0" cy={isSleep ? 6 : 10} rx={isSleep ? 11 : 7} ry={isSleep ? 3.5 : 3} fill="rgba(0,0,0,0.18)" />
      {isSleep ? (
        <g>
          <ellipse cx="0" cy="2" rx="10" ry="5.5" fill={shirt} />
          <circle cx="-7" cy="1" r="4.5" fill={skin} />
          <line x1="-9" y1="0" x2="-6" y2="0" stroke="#333" strokeWidth="1" strokeLinecap="round" />
          <line x1="-9" y1="2" x2="-6" y2="2" stroke="#333" strokeWidth="1" strokeLinecap="round" />
          <text x="6" y="-5" fontSize="6" fill="#9B8EC4" fontWeight="bold" opacity={0.3 + Math.sin(now / 700) * 0.7}>z</text>
          <text x="11" y="-11" fontSize="8" fill="#9B8EC4" fontWeight="bold" opacity={0.3 + Math.sin(now / 700 + 1.2) * 0.7}>Z</text>
          <text x="15" y="-17" fontSize="10" fill="#9B8EC4" fontWeight="bold" opacity={0.3 + Math.sin(now / 700 + 2.4) * 0.7}>Z</text>
        </g>
      ) : (
        <g>
          <ellipse cx="0" cy="2" rx="6.5" ry="7" fill={shirt} />
          {idleAnim === 'phone' && state === 'idle' ? (
            <g><line x1="5" y1="-1" x2="8" y2="-5" stroke={skin} strokeWidth="2.5" strokeLinecap="round" />
            <rect x="6" y="-8" width="4" height="6" rx="1" fill="#444" /><rect x="6.5" y="-7.5" width="3" height="4.5" rx="0.5" fill="#6AF" opacity="0.6" /></g>
          ) : idleAnim === 'coffee' && state === 'idle' ? (
            <g><line x1="5" y1="0" x2="9" y2="-4" stroke={skin} strokeWidth="2.5" strokeLinecap="round" />
            <rect x="7" y="-7" width="4" height="5" rx="1" fill="#8B5E3C" />
            <path d={`M8,${-8 - Math.sin(now / 300) * 2} Q9,${-12 - Math.sin(now / 300) * 2} 10,${-9 - Math.sin(now / 300) * 2}`} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="0.8" /></g>
          ) : idleAnim === 'watch' && state === 'idle' ? (
            <g><line x1="-5" y1="0" x2="-9" y2="-5" stroke={skin} strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="-9" cy="-6" r="2.5" fill="#333" stroke="#888" strokeWidth="0.5" /></g>
          ) : idleAnim === 'stretch' && state === 'idle' ? (
            <g><line x1="-5" y1="-2" x2={-8 - Math.sin(now / 500) * 2} y2="-10" stroke={skin} strokeWidth="2.5" strokeLinecap="round" />
            <line x1="5" y1="-2" x2={8 + Math.sin(now / 500) * 2} y2="-10" stroke={skin} strokeWidth="2.5" strokeLinecap="round" /></g>
          ) : isWalk ? (
            <g><line x1={-4 - Math.sin(walkCycle * 6) * 2} y1="0" x2={-6 - Math.sin(walkCycle * 6) * 4} y2="4" stroke={skin} strokeWidth="2" strokeLinecap="round" />
            <line x1={4 + Math.sin(walkCycle * 6) * 2} y1="0" x2={6 + Math.sin(walkCycle * 6) * 4} y2="4" stroke={skin} strokeWidth="2" strokeLinecap="round" /></g>
          ) : null}
          {isWalk ? (
            <g><line x1={-2 + Math.sin(walkCycle * 8) * 3} y1="7" x2={-2 + Math.sin(walkCycle * 8) * 5} y2="12" stroke={shirt} strokeWidth="2.5" strokeLinecap="round" opacity="0.7" />
            <line x1={2 - Math.sin(walkCycle * 8) * 3} y1="7" x2={2 - Math.sin(walkCycle * 8) * 5} y2="12" stroke={shirt} strokeWidth="2.5" strokeLinecap="round" opacity="0.7" /></g>
          ) : idleAnim === 'tap-foot' && state === 'idle' ? (
            <g><line x1="-2" y1="7" x2="-2" y2="12" stroke={shirt} strokeWidth="2.5" strokeLinecap="round" opacity="0.7" />
            <line x1="2" y1="7" x2={2 + Math.sin(now / 100) * 2} y2="12" stroke={shirt} strokeWidth="2.5" strokeLinecap="round" opacity="0.7" /></g>
          ) : (
            <g><line x1="-2.5" y1="7" x2="-2.5" y2="12" stroke={shirt} strokeWidth="2.5" strokeLinecap="round" opacity="0.7" />
            <line x1="2.5" y1="7" x2="2.5" y2="12" stroke={shirt} strokeWidth="2.5" strokeLinecap="round" opacity="0.7" /></g>
          )}
          {/* Head — green tint when sick/error */}
          <circle cx="0" cy="-6" r="5.5" fill={isErr ? '#9ACD68' : isWalkingToError ? skin : skin} />
          {isErr && <circle cx="0" cy="-6" r="5.5" fill="#5A8A3A" opacity={0.3 + Math.sin(now / 400) * 0.15} />}
          <ellipse cx="0" cy="-10.5" rx="4" ry="2" fill={shirt} opacity="0.5" />
          {isErr ? (
            /* Sick face: droopy eyes, wavy mouth, sweat drops */
            <g>
              {/* Droopy half-closed eyes */}
              <ellipse cx="-2.5" cy="-6.5" rx="1.3" ry="0.6" fill="#333" />
              <ellipse cx="2.5" cy="-6.5" rx="1.3" ry="0.6" fill="#333" />
              {/* Bags under eyes */}
              <path d="M-3.8,-5.5 Q-2.5,-4.8 -1.2,-5.5" fill="none" stroke="#6B8A5A" strokeWidth="0.5" opacity="0.6" />
              <path d="M1.2,-5.5 Q2.5,-4.8 3.8,-5.5" fill="none" stroke="#6B8A5A" strokeWidth="0.5" opacity="0.6" />
              {/* Queasy wavy mouth */}
              <path d={`M-2.5,-3 Q-1,${-3.8 + Math.sin(now / 300) * 0.5} 0,-3 Q1,${-2.2 + Math.sin(now / 300) * 0.5} 2.5,-3`} fill="none" stroke="#5A7A4A" strokeWidth="0.8" strokeLinecap="round" />
              {/* Sweat drops */}
              <circle cx="-5" cy={-8 + Math.sin(now / 250) * 1.5} r="1" fill="#7BC8F6" opacity={0.5 + Math.sin(now / 200) * 0.3} />
              <circle cx="5.5" cy={-6 + Math.sin(now / 300 + 1) * 1.5} r="0.8" fill="#7BC8F6" opacity={0.4 + Math.sin(now / 250 + 1) * 0.3} />
            </g>
          ) : isWalkingToError ? (
            /* Anxious face walking to error: wide worried eyes, frown */
            <g>
              {/* Wide worried eyes */}
              <circle cx="-2.5" cy="-7" r="1.5" fill="white" /><circle cx="2.5" cy="-7" r="1.5" fill="white" />
              <circle cx="-2.5" cy="-6.8" r="0.9" fill="#333" /><circle cx="2.5" cy="-6.8" r="0.9" fill="#333" />
              {/* Worried eyebrows */}
              <line x1="-4" y1="-9" x2="-1.5" y2="-8.5" stroke="#333" strokeWidth="0.8" strokeLinecap="round" />
              <line x1="1.5" y1="-8.5" x2="4" y2="-9" stroke="#333" strokeWidth="0.8" strokeLinecap="round" />
              {/* Wobbly frown */}
              <path d={`M-2,-3 Q0,${-4.5 + Math.sin(now / 150) * 0.5} 2,-3`} fill="none" stroke="#333" strokeWidth="0.8" strokeLinecap="round" />
            </g>
          ) : idleAnim === 'yawn' && state === 'idle' ? (
            <g><line x1="-3" y1="-7" x2="-1" y2="-7" stroke="#333" strokeWidth="1" strokeLinecap="round" />
            <line x1="1" y1="-7" x2="3" y2="-7" stroke="#333" strokeWidth="1" strokeLinecap="round" />
            <ellipse cx="0" cy="-3.5" rx="2" ry="2.5" fill="#333" opacity="0.4" /></g>
          ) : (
            <g>
              {/* Eyes — droop when tired */}
              {tiredness > 0.5 ? (
                /* Tired: half-closed droopy eyes */
                <g>
                  <ellipse cx="-2.5" cy="-6.8" rx="1.3" ry={0.9 - tiredness * 0.3} fill="#333" />
                  <ellipse cx="2.5" cy="-6.8" rx="1.3" ry={0.9 - tiredness * 0.3} fill="#333" />
                  {/* Dark circles under eyes */}
                  <path d="M-3.8,-5.5 Q-2.5,-4.8 -1.2,-5.5" fill="none" stroke="#666" strokeWidth="0.5" opacity={tiredness * 0.6} />
                  <path d="M1.2,-5.5 Q2.5,-4.8 3.8,-5.5" fill="none" stroke="#666" strokeWidth="0.5" opacity={tiredness * 0.6} />
                </g>
              ) : (
                /* Normal eyes */
                <g>
                  <circle cx="-2.5" cy="-7" r="1.2" fill="#333" /><circle cx="2.5" cy="-7" r="1.2" fill="#333" />
                  {isWalk && <><circle cx={-2.5 + Math.cos(angle) * 0.5} cy={-7 + Math.sin(angle) * 0.3} r="0.5" fill="white" />
                  <circle cx={2.5 + Math.cos(angle) * 0.5} cy={-7 + Math.sin(angle) * 0.3} r="0.5" fill="white" /></>}
                </g>
              )}
              {/* Tiredness indicators */}
              {tiredness > 0.7 && !isWalk && (
                <text x="8" y="-10" fontSize="7" opacity={0.4 + Math.sin(now / 800 + p.seed * 10) * 0.3}>💤</text>
              )}
            </g>
          )}
          {/* Mouth for non-error/non-anxious-walk states */}
          {!isErr && !isWalkingToError && (
            isRejected || emotion === 'sad' ? <path d="M-2,-3 Q0,-4.5 2,-3" fill="none" stroke="#333" strokeWidth="0.8" strokeLinecap="round" /> :
            isDone || emotion === 'happy' || emotion === 'jump' ? <path d="M-2.5,-3.5 Q0,-1 2.5,-3.5" fill="none" stroke="#333" strokeWidth="0.8" strokeLinecap="round" /> :
            emotion === 'angry' ? <line x1="-2" y1="-3" x2="2" y2="-3" stroke="#333" strokeWidth="1" strokeLinecap="round" /> :
            tiredness > 0.5 ? <path d="M-2,-3.5 Q0,-4 2,-3.5" fill="none" stroke="#333" strokeWidth="0.7" strokeLinecap="round" opacity="0.6" /> :
            !(idleAnim === 'yawn' && state === 'idle') ? <circle cx="0" cy="-3.5" r="0.8" fill="#333" opacity="0.5" /> : null
          )}
          {/* Error: sick stink lines + "help!" speech bubble */}
          {isErr && <g>
            <path d={`M${-8 + Math.sin(now / 400) * 1},${-2} Q${-10},${-6 + Math.sin(now / 350) * 1} ${-7 + Math.sin(now / 450) * 1},${-9}`} fill="none" stroke="#9ACD68" strokeWidth="0.8" opacity={0.4 + Math.sin(now / 300) * 0.2} />
            <path d={`M${8 + Math.sin(now / 380) * 1},${-1} Q${10},${-5 + Math.sin(now / 320) * 1} ${7 + Math.sin(now / 420) * 1},${-8}`} fill="none" stroke="#9ACD68" strokeWidth="0.8" opacity={0.3 + Math.sin(now / 280 + 1) * 0.2} />
            <path d={`M${-6 + Math.sin(now / 360) * 0.5},${0} Q${-8},${-3 + Math.sin(now / 310) * 1} ${-5},${-6}`} fill="none" stroke="#9ACD68" strokeWidth="0.6" opacity={0.3 + Math.sin(now / 260 + 2) * 0.2} />
            {/* Speech bubble: "help!" */}
            <g transform="translate(10, -20)" opacity={0.7 + Math.sin(now / 500) * 0.3}>
              <rect x="-2" y="-8" width="28" height="13" rx="4" fill="rgba(248,81,73,0.9)" />
              <polygon points="2,5 6,5 3,9" fill="rgba(248,81,73,0.9)" />
              <text x="12" y="1" textAnchor="middle" fontSize="7" fill="white" fontWeight="700" fontFamily="monospace">help!</text>
            </g>
          </g>}
          {/* Completed: confetti burst */}
          {isDone && p.exitConfetti && Array.from({ length: 12 }, (_, i) => {
            const confettiAngle = (i / 12) * Math.PI * 2 + p.seed * 6;
            const t = p.exitTimer * 0.03;
            const dist = 8 + t * (15 + seededRand(p.seed + i) * 10);
            const gravity = t * t * 0.5;
            const cx = Math.cos(confettiAngle) * dist;
            const cy = Math.sin(confettiAngle) * dist + gravity - 4;
            const size = 1 + seededRand(p.seed + i + 0.5) * 1.5;
            const spin = now / 150 + i * 2;
            const colors = ['#FFD700', '#FF6B9D', '#00D4FF', '#7CFF6B', '#FF8A4C', '#D77BFF', '#FF4081', '#40C4FF', '#69F0AE', '#FFD54F', '#E040FB', '#FFAB40'];
            return <rect key={i} x={cx - size / 2} y={cy - size / 2} width={size} height={size * 1.5}
              rx="0.5" fill={colors[i % colors.length]}
              opacity={Math.max(0, 0.9 - t * 0.15)}
              transform={`rotate(${spin * 30 + i * 30}, ${cx}, ${cy})`} />;
          })}
          {/* Completed: wave goodbye arm */}
          {isDone && p.exitTimer > 30 && p.exitTimer < 100 && (
            <line x1="5" y1="-2" x2={8 + Math.sin(now / 80) * 3} y2={-9 + Math.cos(now / 80) * 2}
              stroke={skin} strokeWidth="2.5" strokeLinecap="round" />
          )}
          {/* Completed: bye text */}
          {isDone && p.exitTimer > 50 && p.exitTimer < 110 && (
            <text x="0" y="-22" textAnchor="middle" fontSize="8" fill="#3FB950"
              opacity={Math.min(1, (p.exitTimer - 50) / 20) * Math.max(0, 1 - (p.exitTimer - 90) / 20)}
              fontWeight="700" fontFamily="monospace">👋 bye!</text>
          )}
          {isChat && <g transform="translate(8, -16)"><rect x="-2" y="-5" width="12" height="9" rx="3" fill="rgba(255,255,255,0.85)" />
            <polygon points="0,4 3,4 1,7" fill="rgba(255,255,255,0.85)" />
            <text x="4" y="1" textAnchor="middle" fontSize="6">{['💬', '😄', '📎', '🤔', '👋', '☕'][Math.floor(p.seed * 6) % 6]}</text></g>}
          {emotionEmoji && emotionTimer > 0 && <text x="0" y="-17" textAnchor="middle" fontSize="10" opacity={Math.min(1, emotionTimer / 30)}>{emotionEmoji}</text>}
          {trait === 'impatient' && state === 'queuing' && <text x="9" y="-2" fontSize="7" opacity={0.4 + Math.sin(now / 200) * 0.4}>⏰</text>}
          {/* "Waiting for..." speech bubble when instance has destination users */}
          {!isErr && !isDone && !isChat && !isSleep && p.destinationUsers.length > 0 && (state === 'idle' || state === 'queuing') && (() => {
            const first = p.destinationUsers[0];
            const extra = p.destinationUsers.length - 1;
            const label = `📞 ${first}${extra > 0 ? ` +${extra}` : ''}`;
            const bubbleW = Math.max(label.length * 4.2, 40);
            return (
              <g transform="translate(0, -22)" opacity={0.7 + Math.sin(now / 600 + p.seed * 5) * 0.2}>
                <rect x={-bubbleW / 2} y="-8" width={bubbleW} height="13" rx="4" fill="rgba(88,166,255,0.85)" />
                <polygon points="-2,5 2,5 0,8" fill="rgba(88,166,255,0.85)" />
                <text x="0" y="1" textAnchor="middle" fontSize="5.5" fill="white" fontWeight="600" fontFamily="monospace">{label}</text>
              </g>
            );
          })()}
          {/* Action taken speech bubble */}
          {p.lastAction && p.lastActionTimer > 0 && (() => {
            const label = `✅ ${p.lastAction}`;
            const bubbleW = Math.max(label.length * 4.5, 45);
            const fadeIn = Math.min(1, (200 - p.lastActionTimer) / 20);
            const fadeOut = Math.min(1, p.lastActionTimer / 30);
            return (
              <g transform={`translate(0, ${-24 - (1 - fadeIn) * 8})`} opacity={Math.min(fadeIn, fadeOut) * 0.95}>
                <rect x={-bubbleW / 2} y="-8" width={bubbleW} height="13" rx="4" fill="rgba(39,185,80,0.9)" />
                <polygon points="-2,5 2,5 0,8" fill="rgba(39,185,80,0.9)" />
                <text x="0" y="1" textAnchor="middle" fontSize="5.5" fill="white" fontWeight="700" fontFamily="monospace">{label}</text>
              </g>
            );
          })()}
        </g>
      )}
      {(isSelected || showNames) && !isSleep && (
        <g transform="translate(0, -18)"><rect x={-name.length * 2.2} y="-7" width={name.length * 4.4} height="11" rx="3" fill="rgba(0,0,0,0.7)" />
        <text x="0" y="0" textAnchor="middle" fontSize="7" fill="#DDD" fontFamily="monospace" fontWeight="500">{name}</text></g>
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

      {/* Ambulance */}
      {p.ambulanceActive && p.ambulancePhase !== 'done' && (() => {
        const ax = p.ambulanceX - x, ay = p.ambulanceY - y;
        // Determine if ambulance faces left or right
        let facingLeft = false;
        if (p.ambulancePhase === 'driving-to') {
          facingLeft = x < p.ambulanceX;
        } else if (p.ambulancePhase === 'driving-away') {
          facingLeft = p.ambulanceTargetX < p.ambulanceX;
        }
        const bounce = Math.sin(now / 60) * 0.8;
        return (
          <g transform={`translate(${ax}, ${ay + bounce})`}>
            {/* Ambulance body */}
            <g transform={facingLeft ? 'scale(-1,1)' : ''}>
              <rect x="-18" y="-8" width="36" height="16" rx="4" fill="white" stroke="#CCC" strokeWidth="0.8" />
              {/* Red stripe */}
              <rect x="-18" y="-2" width="36" height="4" fill="#E74C3C" opacity="0.8" rx="0" />
              {/* Red cross */}
              <rect x="-3" y="-6" width="6" height="2" rx="0.5" fill="#E74C3C" />
              <rect x="-1" y="-7" width="2" height="4" rx="0.5" fill="#E74C3C" />
              {/* Wheels */}
              <circle cx="-12" cy="8" r="2.5" fill="#444" />
              <circle cx="12" cy="8" r="2.5" fill="#444" />
              {/* Windshield */}
              <rect x="12" y="-6" width="5" height="12" rx="2" fill="rgba(100,180,255,0.3)" />
              {/* Flashing lights */}
              <circle cx="-16" cy="-8" r="2.5" fill={Math.sin(now / 80) > 0 ? '#FF0000' : '#FF000033'}>
                {Math.sin(now / 80) > 0 && <animate attributeName="opacity" values="1;0.3;1" dur="0.3s" repeatCount="indefinite" />}
              </circle>
              <circle cx="-12" cy="-8" r="2.5" fill={Math.sin(now / 80) < 0 ? '#0066FF' : '#0066FF33'}>
                {Math.sin(now / 80) < 0 && <animate attributeName="opacity" values="1;0.3;1" dur="0.3s" repeatCount="indefinite" />}
              </circle>
            </g>
            {/* Siren text */}
            <text x="0" y="-16" textAnchor="middle" fontSize="7" fill="#F85149" fontWeight="700"
              opacity={0.5 + Math.sin(now / 120) * 0.5}>
              {Math.sin(now / 200) > 0 ? '🚑 WEE-WOO' : '🚨 WEE-WOO'}
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
  const [speed, setSpeed] = useState(1);
  const [showNames, setShowNames] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [connState, setConnState] = useState<string>('loading');
  const [history, setHistory] = useState<Record<string, number>[]>([]);

  // Drag & drop state for GoTo Activity
  const [dragPerson, setDragPerson] = useState<string | null>(null);
  // Pan & zoom
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dragOrigin, setDragOrigin] = useState<{ x: number; y: number; zoneId: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Isometric layout — stored as state, set when workflow loads
  const [isoLayout, setIsoLayout] = useState<IsoLayout | null>(null);

  const frameRef = useRef<number>(0);
  const timeRef = useRef(Date.now());
  const histTick = useRef(0);
  const activeWfRef = useRef<WorkflowDefinition | null>(null);
  activeWfRef.current = activeWf;

  // ─── Merge helper: update or add an instance into animation state ──
  const mergeInstance = useCallback((inst: WorkflowInstance) => {
    const wf = activeWfRef.current;
    if (!wf) return;
    setPeople(prev => {
      const existing = prev.find(p => p.id === inst.id);
      if (existing) {
        return prev.map(p => p.id !== inst.id ? p : mergePersonWithInstance(p, inst, wf));
      }
      // New instance
      const newPerson = instanceToPerson(inst, wf.zones);
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
    workflowId: activeWfId,
    onAllInstances: useCallback((instances: WorkflowInstance[]) => {
      const wf = activeWfRef.current;
      if (!wf) return;
      setPeople(prev => {
        const prevMap = new Map(prev.map(p => [p.id, p]));
        return instances.map(inst => {
          const existing = prevMap.get(inst.id);
          if (existing) return mergePersonWithInstance(existing, inst, wf);
          return instanceToPerson(inst, wf.zones);
        });
      });
      console.log(`[SignalR] AllInstances: ${instances.length} instances`);
    }, []),
    onInstanceCreated: useCallback((inst: WorkflowInstance) => {
      console.log(`[SignalR] InstanceCreated: ${inst.id}`);
      mergeInstance(inst);
    }, [mergeInstance]),
    onInstanceUpdated: useCallback((inst: WorkflowInstance) => {
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
          const p = instanceToPerson(i, patchedWf.zones);
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
            if (existing) return mergePersonWithInstance(existing, inst, wf);
            const newPerson = instanceToPerson(inst, wf.zones);
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
        setPeople(prev => simulate(prev, activeWf.zones, dt));
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
  const wfWidth = activeWf?.width || 950;
  const wfHeight = activeWf?.height || 520;

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
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column' as const, overflow: 'hidden', background: 'linear-gradient(160deg, #0D1117 0%, #161B22 40%, #0D1117 100%)', fontFamily: "'JetBrains Mono', 'SF Mono', monospace", color: '#C9D1D9' }}>
      {/* Header */}
      <div style={{ padding: '14px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(0,0,0,0.35)', flexShrink: 0 }}>
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
      <div style={{ padding: '8px 24px', display: 'flex', gap: 16, alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.15)', flexWrap: 'wrap' as const, flexShrink: 0 }}>
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
        <button onClick={() => setZoom(z => Math.min(3, z * 1.3))} style={{ padding: '3px 8px', borderRadius: 4, fontSize: 14, border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#E6EDF3', cursor: 'pointer' }}>+</button>
        <span style={{ fontSize: 11, color: '#E6EDF3', minWidth: 35, textAlign: 'center' as const }}>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.max(0.3, z / 1.3))} style={{ padding: '3px 8px', borderRadius: 4, fontSize: 14, border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#E6EDF3', cursor: 'pointer' }}>−</button>
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
        <div style={{ flex: 1, padding: '10px 16px', overflow: 'hidden', display: 'flex', flexDirection: 'column' as const }}>
          {/* Time indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, paddingLeft: 4, flexShrink: 0 }}>
            <span style={{ fontSize: 12 }}>{periodLabel}</span>
            <span style={{ fontSize: 11, color: '#E6EDF3', fontFamily: 'monospace' }}>{timeLabel}</span>
            {dayPhase.isNight && <span style={{ fontSize: 10, color: '#9B8EC4' }}>Overnight instances will look tired</span>}
          </div>
          <svg ref={svgRef} width="100%" height="100%" viewBox={`${-pan.x / zoom} ${-pan.y / zoom} ${wfWidth / zoom} ${wfHeight / zoom}`}
            preserveAspectRatio="xMidYMid meet"
            style={{ flex: 1, background: 'rgba(255,255,255,0.01)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.05)', cursor: isPanning ? 'move' : dragPerson ? 'grabbing' : 'default' }}
            onClick={() => { if (!dragPerson && !isPanning) setSelected(null); }}
            onWheel={e => {
              e.preventDefault();
              const delta = e.deltaY > 0 ? 0.9 : 1.1;
              const newZoom = Math.max(0.3, Math.min(3, zoom * delta));
              // Zoom toward mouse position
              if (svgRef.current) {
                const rect = svgRef.current.getBoundingClientRect();
                const mx = (e.clientX - rect.left) / rect.width;
                const my = (e.clientY - rect.top) / rect.height;
                const oldW = wfWidth / zoom, newW = wfWidth / newZoom;
                const oldH = wfHeight / zoom, newH = wfHeight / newZoom;
                setPan(prev => ({
                  x: prev.x + (oldW - newW) * mx * newZoom,
                  y: prev.y + (oldH - newH) * my * newZoom,
                }));
              }
              setZoom(newZoom);
            }}
            onMouseDown={e => {
              if (e.button === 1 || (e.button === 0 && e.altKey)) {
                e.preventDefault();
                setIsPanning(true);
                panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
              }
            }}
            onMouseMove={e => {
              if (isPanning && svgRef.current) {
                const rect = svgRef.current.getBoundingClientRect();
                const scaleX = wfWidth / zoom / rect.width;
                const scaleY = wfHeight / zoom / rect.height;
                setPan({
                  x: panStart.current.panX + (e.clientX - panStart.current.x) * scaleX * zoom,
                  y: panStart.current.panY + (e.clientY - panStart.current.y) * scaleY * zoom,
                });
                return;
              }
              if (dragPerson && svgRef.current) {
                const svg = svgRef.current;
                const pt = svg.createSVGPoint();
                pt.x = e.clientX; pt.y = e.clientY;
                const svgPt = pt.matrixTransform(svg.getScreenCTM()!.inverse());
                setDragPos({ x: svgPt.x, y: svgPt.y });
              }
            }}
            onMouseUp={async () => {
              if (isPanning) { setIsPanning(false); return; }
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
              setDragPerson(null); setDragPos(null); setDragOrigin(null);

              if (dropZone && dropZone.id !== origZone) {
                // Dropped on a different zone → umbrella float down + GoTo Activity
                const targetY = dropZone.y + 6 + (dropZone.h / 2 - 12) * Math.random();
                const targetX = dropZone.x + (dropZone.w / 2 - 14) * (Math.random() * 2 - 1);
                setPeople(prev => prev.map(p => p.id !== personId ? p : {
                  ...p, x: targetX, y: dragPos!.y - 80, // start above drop point
                  targetX, targetY,
                  zoneId: dropZone.id,
                  umbrellaActive: true,
                  umbrellaY: dragPos!.y - 80,
                  umbrellaTargetY: targetY,
                  state: 'idle' as PersonState,
                  lastAction: `GoTo → ${dropZone.label}`,
                  lastActionTimer: 200,
                }));
                // Call the GoTo Activity API
                try {
                  const person = people.find(p => p.id === personId);
                  if (person) {
                    const k2ActivityName = dropZone.k2ActivityName || dropZone.label;
                    await goToActivity(person.processInstanceId, k2ActivityName);
                  }
                } catch (err) { console.error('GoTo failed:', err); }
              } else {
                // Dropped nowhere useful → walk back to original position
                setPeople(prev => prev.map(p => p.id !== personId ? p : {
                  ...p,
                  targetX: dragOrigin.x, targetY: dragOrigin.y,
                  state: 'walking' as PersonState,
                  emotion: 'sad' as Emotion, emotionTimer: 40,
                }));
              }
            }}
            onMouseLeave={() => {
              if (dragPerson) {
                // Dragged outside SVG → walk back
                setPeople(prev => prev.map(p => p.id !== dragPerson ? p : {
                  ...p, targetX: dragOrigin?.x ?? p.x, targetY: dragOrigin?.y ?? p.y,
                  state: 'walking' as PersonState,
                }));
                setDragPerson(null); setDragPos(null); setDragOrigin(null);
              }
            }}>
            <defs>
              <pattern id="floor" width="30" height="30" patternUnits="userSpaceOnUse">
                <rect x="0" y="0" width="14" height="14" rx="1" fill="rgba(255,255,255,0.012)" />
                <rect x="15" y="15" width="14" height="14" rx="1" fill="rgba(255,255,255,0.012)" />
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
            <rect width={wfWidth} height={wfHeight} fill="url(#floor)" rx="10" />

            {/* Day/night overlay */}
            <rect width={wfWidth} height={wfHeight} fill={overlayColor} rx="10" style={{ pointerEvents: 'none' }} />

            {/* Dawn/dusk warm glow */}
            {(dayPhase.isDawn || dayPhase.isDusk) && (
              <rect width={wfWidth} height={wfHeight} fill="url(#sunGlow)" rx="10" style={{ pointerEvents: 'none' }} />
            )}

            {/* Night stars */}
            {dayPhase.isNight && Array.from({ length: 15 }, (_, i) => (
              <circle key={`star-${i}`}
                cx={seededRand(i * 7.1) * wfWidth}
                cy={seededRand(i * 3.3) * wfHeight * 0.4}
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
                isDragOver={!!(dragPerson && dragPos && pointInDiamond(dragPos.x, dragPos.y, room))} />
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
              />
            ))}
          </svg>
        </div>
        );
      })()}

      {/* Timeline */}
      {showHeatmap && activeWf && <Timeline history={history} zones={activeWf.zones} width={wfWidth} />}

      {/* Modal */}
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
                  const wf = activeWf!;
                  const errorZone = wf.zones.find(z => z.type === 'error');

                  // 1. Close modal immediately
                  setSelected(null);

                  // 2. Start walking out of error-corner toward entrance hopefully
                  const entrance = wf.zones.find(z => z.type === 'door');
                  const midZone = wf.zones.find(z => z.type === 'desk') || entrance;
                  const walkTarget = midZone || entrance;
                  setPeople(prev => prev.map(p => p.id !== personId ? p : {
                    ...p, state: 'walking' as PersonState, emotion: 'happy' as Emotion, emotionTimer: 120,
                    zoneId: walkTarget ? walkTarget.id : p.zoneId,
                    targetX: walkTarget ? walkTarget.x + (Math.random() - 0.5) * 30 : p.x,
                    targetY: walkTarget ? walkTarget.y + Math.random() * 20 : p.y,
                  }));

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
                      // SUCCESS — walk to new zone with celebration
                      const zone = wf.zones.find(z => z.id === updated.currentZoneId) || wf.zones.find(z => z.type === 'door');
                      setPeople(prev => prev.map(p => p.id !== personId ? p : {
                        ...p, state: 'walking' as PersonState, emotion: 'jump' as Emotion, emotionTimer: 80,
                        zoneId: updated.currentZoneId,
                        targetX: zone ? zone.x + (zone.w / 2 - 14) * (Math.random() * 2 - 1) : p.x,
                        targetY: zone ? zone.y + 6 + (zone.h / 2 - 12) * Math.random() : p.y,
                      }));
                    } else {
                      // STILL IN ERROR — ambulance drives them back to error-corner
                      setPeople(prev => prev.map(p => p.id !== personId ? p : {
                        ...p, emotion: 'sad' as Emotion, emotionTimer: 100,
                        ambulanceActive: true, ambulancePhase: 'driving-to' as const,
                        ambulanceX: (wf.width || 950) + 40, ambulanceY: p.y,
                        ambulanceTargetX: errorZone ? errorZone.x : 880,
                        ambulanceTargetY: errorZone ? errorZone.y : 470,
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
