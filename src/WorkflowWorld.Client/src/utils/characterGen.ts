import type { WorkflowInstance, AnimatedPerson, PersonTrait } from "../types/workflow";
import type { ZoneDefinition } from "../types/workflow";

/**
 * Convert a K2 WorkflowInstance from the API into an AnimatedPerson
 * for the visualisation engine. Character appearance is deterministic
 * based on the process instance ID so the same instance always looks
 * the same across refreshes.
 */
export function instanceToPerson(
  instance: WorkflowInstance,
  zones: ZoneDefinition[]
): AnimatedPerson {
  const zone = zones.find((z) => z.id === instance.currentZoneId);
  const baseX = zone ? zone.x : 70;
  const baseY = zone ? zone.y : 260;
  const spreadX = zone ? (zone.w / 2 - 14) * (seededRandom(instance.processInstanceId) * 2 - 1) : 0;
  const spreadY = zone ? 6 + (zone.h / 2 - 12) * seededRandom(instance.processInstanceId + 1) : 0;

  const speed = getTraitSpeed(instance.trait);

  return {
    ...instance,
    x: baseX + spreadX,
    y: baseY + spreadY,
    targetX: baseX + spreadX,
    targetY: baseY + spreadY,
    angle: seededRandom(instance.processInstanceId + 2) * Math.PI * 2,
    speed,
    walkCycle: seededRandom(instance.processInstanceId + 3) * 100,
    moveTimer: 40 + seededRandom(instance.processInstanceId + 4) * 120,
    waitTime: instance.waitTimeSeconds,
    seed: seededRandom(instance.processInstanceId + 5),
    idleAnim: "none",
    idleAnimTimer: 0,
    chatPartner: null,
    emotion: null,
    emotionTimer: 0,
  };
}

/**
 * Update an existing AnimatedPerson with new data from the API
 * without resetting their animation state
 */
export function updatePerson(
  existing: AnimatedPerson,
  updated: WorkflowInstance,
  zones: ZoneDefinition[]
): AnimatedPerson {
  const zoneChanged = existing.currentZoneId !== updated.currentZoneId;
  const stateChanged = existing.state !== updated.state;

  const person = { ...existing, ...updated };

  if (zoneChanged) {
    // Move to new zone — set walking target
    const newZone = zones.find((z) => z.id === updated.currentZoneId);
    if (newZone) {
      person.targetX = newZone.x + (newZone.w / 2 - 14) * (Math.random() * 2 - 1);
      person.targetY = newZone.y + 6 + (newZone.h / 2 - 12) * Math.random();
      person.state = "walking";
    }
  }

  if (stateChanged) {
    // Trigger emotion based on state change
    if (updated.state === "completed") {
      person.emotion = "jump";
      person.emotionTimer = 80;
    } else if (updated.state === "error") {
      person.emotion = "angry";
      person.emotionTimer = 60;
    } else if (updated.state === "rejected") {
      person.emotion = "sad";
      person.emotionTimer = 100;
    }
  }

  return person;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function getTraitSpeed(trait: PersonTrait): number {
  switch (trait) {
    case "impatient": return 0.55 + Math.random() * 0.1;
    case "relaxed":   return 0.25 + Math.random() * 0.1;
    case "anxious":   return 0.4 + Math.random() * 0.1;
    default:          return 0.35 + Math.random() * 0.15;
  }
}

/**
 * Simple seeded random number generator (0-1 range)
 * Ensures the same instance ID always produces the same values
 */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}
