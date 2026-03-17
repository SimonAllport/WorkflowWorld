import { useEffect, useRef, useCallback, useState } from "react";
import type {
  WorkflowInstance,
  ZoneStats,
  BottleneckInfo,
} from "../types/workflow";

/**
 * Minimal SignalR 2 client for browser.
 * Uses the SignalR 2 long-polling transport (simplest, most compatible).
 * The server auto-generates a JS proxy at /signalr/hubs but we use the
 * raw protocol here to avoid loading jQuery.
 */

interface SignalR2Connection {
  connectionId: string;
  connectionToken: string;
  state: "disconnected" | "connecting" | "connected" | "error";
  stop: () => void;
}

interface UseWorkflowHubOptions {
  /** Base URL for the API (e.g. "http://localhost:9090" or "" for same origin) */
  hubUrl?: string;
  /** Workflow ID to subscribe to */
  workflowId: string | null;
  /** Callbacks for different event types */
  onAllInstances?: (instances: WorkflowInstance[]) => void;
  onInstanceCreated?: (instance: WorkflowInstance) => void;
  onInstanceUpdated?: (instance: WorkflowInstance) => void;
  onInstanceCompleted?: (instanceId: string) => void;
  onInstanceErrored?: (instance: WorkflowInstance) => void;
  onZoneStatsUpdated?: (stats: ZoneStats[]) => void;
  onBottleneckDetected?: (bottleneck: BottleneckInfo) => void;
  onBottleneckResolved?: (zoneId: string) => void;
}

// SignalR 2 protocol helpers
const PROTOCOL_VERSION = "1.5";

function buildUrl(base: string, path: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return `${base}${path}?${qs}`;
}

export function useWorkflowHub(options: UseWorkflowHubOptions) {
  const {
    hubUrl = "",
    workflowId,
    onAllInstances,
    onInstanceCreated,
    onInstanceUpdated,
    onInstanceCompleted,
    onInstanceErrored,
    onZoneStatsUpdated,
    onBottleneckDetected,
    onBottleneckResolved,
  } = options;

  const [connectionState, setConnectionState] = useState<
    "disconnected" | "connecting" | "connected" | "error"
  >("disconnected");

  const connRef = useRef<SignalR2Connection | null>(null);
  const callbacksRef = useRef(options);
  callbacksRef.current = options;
  const currentWorkflowRef = useRef<string | null>(null);

  // Dispatch a SignalR 2 server message to the right callback
  const dispatchMessage = useCallback(
    (hubName: string, method: string, args: unknown[]) => {
      if (hubName.toLowerCase() !== "workflowhub") return;
      const cb = callbacksRef.current;
      switch (method) {
        case "AllInstances":
          cb.onAllInstances?.(args[0] as WorkflowInstance[]);
          break;
        case "InstanceCreated":
          cb.onInstanceCreated?.(args[0] as WorkflowInstance);
          break;
        case "InstanceUpdated":
          cb.onInstanceUpdated?.(args[0] as WorkflowInstance);
          break;
        case "InstanceCompleted":
          cb.onInstanceCompleted?.(args[0] as string);
          break;
        case "InstanceErrored":
          cb.onInstanceErrored?.(args[0] as WorkflowInstance);
          break;
        case "ZoneStatsUpdated":
          cb.onZoneStatsUpdated?.(args[0] as ZoneStats[]);
          break;
        case "BottleneckDetected":
          cb.onBottleneckDetected?.(args[0] as BottleneckInfo);
          break;
        case "BottleneckResolved":
          cb.onBottleneckResolved?.(args[0] as string);
          break;
      }
    },
    []
  );

  // Invoke a hub method via SignalR 2 send endpoint
  const invokeHub = useCallback(
    async (method: string, ...args: unknown[]) => {
      const conn = connRef.current;
      if (!conn || conn.state !== "connected") return;

      const data = JSON.stringify({
        H: "WorkflowHub",
        M: method,
        A: args,
        I: 0,
      });

      await fetch(
        buildUrl(`${hubUrl}/signalr`, "/send", {
          transport: "longPolling",
          connectionToken: conn.connectionToken,
          connectionData: JSON.stringify([{ name: "WorkflowHub" }]),
        }),
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `data=${encodeURIComponent(data)}`,
        }
      );
    },
    [hubUrl]
  );

  // Connect using SignalR 2 long-polling protocol
  useEffect(() => {
    let stopped = false;
    let pollAbort: AbortController | null = null;

    const connectionData = JSON.stringify([{ name: "WorkflowHub" }]);

    async function connect() {
      setConnectionState("connecting");

      try {
        // Step 1: Negotiate
        const negResp = await fetch(
          buildUrl(`${hubUrl}/signalr`, "/negotiate", {
            clientProtocol: PROTOCOL_VERSION,
            connectionData,
          })
        );
        if (!negResp.ok) throw new Error(`Negotiate failed: ${negResp.status}`);
        const neg = await negResp.json();

        if (stopped) return;

        const conn: SignalR2Connection = {
          connectionId: neg.ConnectionId,
          connectionToken: neg.ConnectionToken,
          state: "connecting",
          stop: () => {
            stopped = true;
            pollAbort?.abort();
          },
        };
        connRef.current = conn;

        // Step 2: Connect (start long polling)
        const connectResp = await fetch(
          buildUrl(`${hubUrl}/signalr`, "/connect", {
            transport: "longPolling",
            connectionToken: neg.ConnectionToken,
            connectionData,
            clientProtocol: PROTOCOL_VERSION,
          })
        );
        if (!connectResp.ok)
          throw new Error(`Connect failed: ${connectResp.status}`);
        await connectResp.json(); // initial response

        if (stopped) return;

        // Step 3: Start
        const startResp = await fetch(
          buildUrl(`${hubUrl}/signalr`, "/start", {
            transport: "longPolling",
            connectionToken: neg.ConnectionToken,
            connectionData,
            clientProtocol: PROTOCOL_VERSION,
          })
        );
        if (!startResp.ok)
          throw new Error(`Start failed: ${startResp.status}`);

        if (stopped) return;

        conn.state = "connected";
        setConnectionState("connected");
        console.log("[WorkflowHub] Connected via long-polling");

        // Step 4: Poll loop
        let messageId: string | null = null;

        while (!stopped) {
          try {
            pollAbort = new AbortController();
            const params: Record<string, string> = {
              transport: "longPolling",
              connectionToken: neg.ConnectionToken,
              connectionData,
              clientProtocol: PROTOCOL_VERSION,
            };
            if (messageId) params.messageId = messageId;

            const pollResp = await fetch(
              buildUrl(`${hubUrl}/signalr`, "/poll", params),
              { signal: pollAbort.signal }
            );

            if (stopped) break;
            if (!pollResp.ok) {
              console.warn("[WorkflowHub] Poll error:", pollResp.status);
              break;
            }

            const data = await pollResp.json();
            if (data.C) messageId = data.C;

            // Process messages
            if (data.M && Array.isArray(data.M)) {
              for (const msg of data.M) {
                if (msg.H && msg.M && msg.A) {
                  dispatchMessage(msg.H, msg.M, msg.A);
                }
              }
            }
          } catch (err) {
            if (stopped) break;
            if ((err as Error).name === "AbortError") break;
            console.warn("[WorkflowHub] Poll error:", err);
            await new Promise((r) => setTimeout(r, 2000));
          }
        }

        // Abort / disconnect
        if (conn.state === "connected") {
          fetch(
            buildUrl(`${hubUrl}/signalr`, "/abort", {
              transport: "longPolling",
              connectionToken: neg.ConnectionToken,
              connectionData,
            }),
            { method: "POST" }
          ).catch(() => {});
        }

        conn.state = "disconnected";
        setConnectionState("disconnected");
      } catch (err) {
        console.error("[WorkflowHub] Connection failed:", err);
        setConnectionState("error");
      }
    }

    connect();

    return () => {
      stopped = true;
      pollAbort?.abort();
      connRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubUrl]);

  // Subscribe/unsubscribe when workflow changes
  useEffect(() => {
    if (connectionState !== "connected") return;

    if (currentWorkflowRef.current) {
      invokeHub("UnsubscribeFromWorkflow", currentWorkflowRef.current);
    }

    if (workflowId) {
      invokeHub("SubscribeToWorkflow", workflowId);
      currentWorkflowRef.current = workflowId;
    } else {
      currentWorkflowRef.current = null;
    }
  }, [workflowId, connectionState, invokeHub]);

  // REST action helpers
  const repairInstance = useCallback(
    async (processInstanceId: number, comment?: string) => {
      const resp = await fetch(
        `${hubUrl}/api/instances/${processInstanceId}/repair`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ comment }),
        }
      );
      return resp.ok;
    },
    [hubUrl]
  );

  const redirectInstance = useCallback(
    async (
      processInstanceId: number,
      targetUser: string,
      comment?: string
    ) => {
      const resp = await fetch(
        `${hubUrl}/api/instances/${processInstanceId}/redirect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ targetUser, comment }),
        }
      );
      return resp.ok;
    },
    [hubUrl]
  );

  const goToActivity = useCallback(
    async (
      processInstanceId: number,
      targetActivity: string,
      comment?: string
    ) => {
      const resp = await fetch(
        `${hubUrl}/api/instances/${processInstanceId}/goto`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ targetActivityName: targetActivity, comment }),
        }
      );
      return resp.ok;
    },
    [hubUrl]
  );

  const stopInstance = useCallback(
    async (processInstanceId: number) => {
      const resp = await fetch(
        `${hubUrl}/api/instances/${processInstanceId}/stop`,
        {
          method: "POST",
          credentials: "include",
        }
      );
      return resp.ok;
    },
    [hubUrl]
  );

  return {
    connectionState,
    repairInstance,
    redirectInstance,
    goToActivity,
    stopInstance,
  };
}
