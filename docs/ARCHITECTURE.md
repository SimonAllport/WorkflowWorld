# Workflow World — Architecture

## Overview

A real-time visualisation of K2 workflow instances as animated characters
moving through an office floor plan. Built as a .NET 8 Web API + React SPA.

## Stack

| Layer       | Technology                          |
|-------------|-------------------------------------|
| Frontend    | React 18 + TypeScript + Vite        |
| Realtime    | SignalR (WebSocket)                  |
| Backend API | .NET 8 Web API (C#)                 |
| K2 SDK      | SourceCode.Workflow.Management.dll   |
|             | SourceCode.HostClientAPI.dll         |
| Auth        | Windows Auth (NTLM/Kerberos)        |
| Hosting     | IIS / Kestrel behind reverse proxy  |

## Data Flow

```
┌──────────────┐     SignalR/WS      ┌──────────────────┐
│  React SPA   │◄────────────────────►│  .NET 8 Web API  │
│              │     REST /api/*      │                  │
│  - SVG world │────────────────────► │  - Controllers   │
│  - Characters│                      │  - SignalR Hub   │
│  - Heatmap   │                      │  - K2 Service    │
│  - Timeline  │                      │  - Polling Svc   │
└──────────────┘                      └────────┬─────────┘
                                               │
                                    SourceCode.Workflow
                                     .Management API
                                               │
                                      ┌────────▼─────────┐
                                      │   K2 Server      │
                                      │                  │
                                      │  - Process Defs  │
                                      │  - Instances     │
                                      │  - Worklist      │
                                      │  - Error Log     │
                                      └──────────────────┘
```

## K2 → Workflow World Mapping

| K2 Concept              | Workflow World         | Notes                        |
|--------------------------|------------------------|------------------------------|
| Process Definition       | Floor plan / workflow  | Activities become zones      |
| Activity                 | Zone (room/desk/area)  | Position auto-laid out       |
| Process Instance         | Person character       | Unique look per instance     |
| Instance Status: Active  | Walking / Idle state   |                              |
| Instance Status: Error   | Error state (red !)    | Pulsing, stuck in corner     |
| Instance Status: Complete| Completed (sparkles)   | Respawns as new instance     |
| Worklist Item            | Person at task zone    | Waiting for human action     |
| Worklist Item Age        | Sleep state / wait time| Falls asleep if too long     |
| Activity Instance Count  | Zone population        | Drives heatmap + bottleneck  |
| Error Log Entry          | Error zone character   | Can be repaired via API      |

## API Endpoints

### REST

```
GET  /api/workflows                    → List of workflow definitions
GET  /api/workflows/{id}               → Single workflow with activities
GET  /api/workflows/{id}/instances     → Active instances for a workflow
GET  /api/workflows/{id}/stats         → Zone counts, avg wait, throughput
POST /api/instances/{id}/repair        → Retry errored instance
POST /api/instances/{id}/redirect      → Redirect worklist item
POST /api/instances/{id}/goto          → GoToActivity
POST /api/instances/{id}/stop          → Stop instance
```

### SignalR Hub: `/hubs/workflow`

```
Client → Server:
  SubscribeToWorkflow(workflowId)
  UnsubscribeFromWorkflow(workflowId)

Server → Client:
  InstanceUpdated(instanceData)
  InstanceCreated(instanceData)
  InstanceCompleted(instanceId)
  InstanceErrored(instanceData)
  ZoneStatsUpdated(zoneStats)
  BottleneckDetected(zoneId, severity)
  BottleneckResolved(zoneId)
```

## Key Design Decisions

1. **Polling K2 on the server, pushing via SignalR** — K2 Management API
   doesn't support webhooks, so we poll every 5s on the server and push
   diffs to connected clients via SignalR.

2. **Auto-layout for zones** — Activities are positioned automatically
   using a left-to-right flow layout based on the process definition's
   activity order and connections.

3. **Character identity** — Each process instance gets a deterministic
   character appearance (skin, shirt, trait) derived from a hash of its
   process instance ID, so the same instance always looks the same.

4. **Bottleneck detection** — Server-side calculation comparing zone
   population vs capacity threshold, combined with average dwell time.
   Pushed as events, not polled.

5. **Windows Auth** — The API runs under the user's Windows identity so
   K2 connections inherit their permissions. No separate auth layer needed.

## Project Structure

```
WorkflowWorld/
├── WorkflowWorld.sln
├── src/
│   ├── WorkflowWorld.Api/
│   │   ├── Program.cs
│   │   ├── appsettings.json
│   │   ├── Controllers/
│   │   │   └── WorkflowsController.cs
│   │   ├── Hubs/
│   │   │   └── WorkflowHub.cs
│   │   ├── Services/
│   │   │   ├── IK2ManagementService.cs
│   │   │   ├── K2ManagementService.cs
│   │   │   └── WorkflowPollingService.cs
│   │   ├── Models/
│   │   │   ├── WorkflowDefinition.cs
│   │   │   ├── WorkflowInstance.cs
│   │   │   ├── ZoneStats.cs
│   │   │   └── BottleneckInfo.cs
│   │   └── Configuration/
│   │       └── K2Settings.cs
│   └── WorkflowWorld.Client/
│       ├── package.json
│       ├── vite.config.ts
│       ├── index.html
│       └── src/
│           ├── App.tsx
│           ├── components/
│           │   ├── WorkflowWorld.tsx    (main canvas)
│           │   ├── PersonSprite.tsx
│           │   ├── HeatZone.tsx
│           │   ├── FlowArrow.tsx
│           │   ├── BottleneckTimeline.tsx
│           │   └── DetailPanel.tsx
│           ├── hooks/
│           │   └── useWorkflowHub.ts   (SignalR connection)
│           ├── services/
│           │   └── workflowApi.ts      (REST client)
│           ├── types/
│           │   └── workflow.ts
│           └── utils/
│               ├── characterGen.ts     (deterministic looks)
│               └── layoutEngine.ts     (auto-position zones)
├── docs/
│   └── ARCHITECTURE.md
└── README.md
```
