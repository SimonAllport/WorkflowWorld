// ─── Workflow World TypeScript Types ─────────────────────────────────────

export interface WorkflowDefinition {
  id: string;
  name: string;
  fullName: string;
  versionId: number;
  color: string;
  icon: string;
  zones: ZoneDefinition[];
  connections: FlowConnection[];
  activeInstanceCount: number;
  width?: number;
  height?: number;
}

export interface ZoneDefinition {
  id: string;
  label: string;
  type: ZoneType;
  emoji: string;
  x: number;
  y: number;
  w: number;
  h: number;
  capacity: number;
  k2ActivityName: string;
}

export type ZoneType =
  | "door"
  | "desk"
  | "seats"
  | "office"
  | "room"
  | "machine"
  | "exit-good"
  | "exit-bad"
  | "error";

export interface FlowConnection {
  from: string;
  to: string;
  weight: number;
}

export interface WorkflowInstance {
  id: string;
  processInstanceId: number;
  workflowId: string;
  name: string;
  currentZoneId: string;
  currentActivityName: string;
  state: InstanceState;
  folio: string;
  originator: string;
  startDate: string;
  expectedDuration?: string;
  waitTimeSeconds: number;
  errorMessage?: string;
  destinationUsers: string[];
  availableActions: string[];
  skinColor: string;
  shirtColor: string;
  trait: PersonTrait;
}

export type InstanceState =
  | "walking"
  | "idle"
  | "queuing"
  | "chatting"
  | "sleeping"
  | "error"
  | "completed"
  | "rejected";

export type PersonTrait =
  | "impatient"
  | "relaxed"
  | "social"
  | "anxious"
  | "normal";

export interface ZoneStats {
  zoneId: string;
  population: number;
  capacity: number;
  averageWaitSeconds: number;
  congestionRatio: number;
  isBottleneck: boolean;
  throughputPerHour: number;
}

export interface WorkflowStats {
  workflowId: string;
  totalInstances: number;
  activeInstances: number;
  erroredInstances: number;
  completedInstances: number;
  zoneStats: ZoneStats[];
  bottlenecks: BottleneckInfo[];
}

export interface BottleneckInfo {
  zoneId: string;
  zoneLabel: string;
  severity: "warning" | "critical";
  population: number;
  capacity: number;
  averageWaitSeconds: number;
  detectedAt: string;
}

// ─── Internal types for the animation engine ─────────────────────────────

export interface AnimatedPerson extends WorkflowInstance {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  angle: number;
  speed: number;
  walkCycle: number;
  moveTimer: number;
  waitTime: number;
  seed: number;
  idleAnim: IdleAnimation;
  idleAnimTimer: number;
  chatPartner: string | null;
  emotion: Emotion | null;
  emotionTimer: number;
}

export type IdleAnimation =
  | "phone"
  | "tap-foot"
  | "stretch"
  | "yawn"
  | "coffee"
  | "watch"
  | "fidget"
  | "none";

export type Emotion =
  | "happy"
  | "sad"
  | "nervous"
  | "angry"
  | "jump";

// ─── SignalR event types ─────────────────────────────────────────────────

export interface WorkflowHubEvents {
  AllInstances: (instances: WorkflowInstance[]) => void;
  InstanceCreated: (instance: WorkflowInstance) => void;
  InstanceUpdated: (instance: WorkflowInstance) => void;
  InstanceCompleted: (instanceId: string) => void;
  InstanceErrored: (instance: WorkflowInstance) => void;
  ZoneStatsUpdated: (stats: ZoneStats[]) => void;
  BottleneckDetected: (bottleneck: BottleneckInfo) => void;
  BottleneckResolved: (zoneId: string) => void;
}
