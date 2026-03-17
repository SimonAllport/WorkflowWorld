# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WorkflowWorld is a real-time K2 workflow visualization platform. The backend polls K2 servers for workflow instances and pushes state changes to a React SPA via SignalR. Workflow activities are rendered as "zones" on a floor plan, and process instances appear as animated characters.

## Build & Run Commands

### Backend (.NET 8)
```bash
cd src/WorkflowWorld.Api
dotnet restore
dotnet run                                    # Dev server on https://localhost:5001
dotnet publish -c Release -o ../../publish    # Production build
```

### Frontend (React/Vite/TypeScript)
```bash
cd src/WorkflowWorld.Client
npm install
npm run dev      # Dev server on http://localhost:5173
npm run build    # Production build to dist/
```

Both servers must run simultaneously in development. CORS is pre-configured for the Vite dev server.

## Architecture

```
React SPA (5173) ←SignalR/REST→ .NET 8 API (5001) ←K2 SDK→ K2 Server (5252)
```

**Backend key paths:**
- `Program.cs` — DI, auth (Windows/Negotiate), SignalR hub registration, SPA fallback
- `Services/WorkflowPollingService.cs` — Background service polling K2 every N seconds, computes diffs, pushes via SignalR. Skips workflows with no subscribers.
- `Services/K2ManagementService.cs` — K2 SDK wrapper. Contains the auto-layout engine (2-column grid) and deterministic character generation (hashes instance ID → appearance).
- `Hubs/WorkflowHub.cs` — SignalR hub with Subscribe/Unsubscribe per workflow. Events: `AllInstances`, `InstanceCreated/Updated/Completed/Errored`, `ZoneStatsUpdated`, `BottleneckDetected/Resolved`.
- `Models/WorkflowModels.cs` — All shared DTOs in a single file.

**Frontend key paths:**
- `hooks/useWorkflowHub.ts` — SignalR lifecycle, reconnection, subscription management, action methods (repair, redirect, goto, stop).
- `utils/characterGen.ts` — Converts API instances to animated persons with deterministic appearance via seeded random. Handles zone transitions and emotion triggers.
- `types/workflow.ts` — TypeScript interfaces mirroring backend models.

## Key Design Decisions

- **Server-side polling with change detection**: K2 has no webhooks, so the backend polls and only pushes diffs to clients.
- **Deterministic character identity**: Same instance ID always produces the same character appearance (skin, shirt, trait) via hash-based seeding.
- **Subscription-based optimization**: Polling skips workflows with zero connected clients.
- **Bottleneck detection**: Triggers when `(population/capacity >= 0.9) AND (avg wait >= 300s)`.
- **K2 SDK DLLs** live in `lib/` (not NuGet) — these must be obtained from a K2 server installation.
- **Windows Authentication** throughout — the API inherits the caller's K2 permissions.

## Configuration

K2 connection and behavior settings are in `src/WorkflowWorld.Api/appsettings.json` under the `K2` section (host, port, polling interval, thresholds). The `K2Settings.cs` POCO binds these values.
