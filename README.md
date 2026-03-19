# WorkflowWorld

A real-time K2 workflow visualization platform that brings your workflow instances to life as animated characters in an isometric office world.

## What it does

- **Live visualization** of K2 workflow instances as animated people walking between rooms in an isometric office floor plan
- **Each activity** in a workflow becomes a room — instances move between rooms as they progress through the workflow
- **Real-time updates** via SignalR — new instances appear, completed ones leave, errors trigger ambulance animations
- **IPC/Subworkflow detection** — Call Subworkflow activities show as Star Trek-style teleporter rooms with beam effects
- **Interactive actions** — right-click instances to Retry, Redirect, GoTo Activity, or Stop (with taxi departure animation)
- **Bottleneck detection** — highlights zones where instances are piling up
- **469+ workflows** supported from K2 server with automatic activity discovery

## Tech Stack

- **Backend:** .NET Framework 4.8, OWIN self-host, SignalR 2, K2 Management API
- **Frontend:** React 18, TypeScript, Vite, SVG-based isometric engine
- **Protocol:** SignalR 2 long-polling for real-time push, REST for actions

## Disclaimer

This project is a **fun experiment / proof of concept** and is **not intended for production use**. It was built as a creative way to visualize K2 workflow data. Use at your own risk. No warranties or guarantees are provided.

## Running

Both servers must run simultaneously:

```bash
# Backend (.NET)
cd src/WorkflowWorld.Api
dotnet run

# Frontend (React/Vite)
cd src/WorkflowWorld.Client
npm install
npm run dev
```

Backend runs on http://localhost:9090, frontend on http://localhost:5173. Requires Windows Authentication and access to a K2 server.
