using System;
using System.Collections.Generic;

namespace WorkflowWorld.Api.Models
{
    // ─── Workflow Definition (floor plan) ────────────────────────────────────

    public class WorkflowDefinition
    {
        public string Id { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public string FullName { get; set; } = string.Empty;
        public int VersionId { get; set; }
        public string Color { get; set; } = "#4A90D9";
        public string Icon { get; set; } = "📋";
        public List<ZoneDefinition> Zones { get; set; } = new List<ZoneDefinition>();
        public List<FlowConnection> Connections { get; set; } = new List<FlowConnection>();
        public int ActiveInstanceCount { get; set; }
    }

    public class ZoneDefinition
    {
        public string Id { get; set; } = string.Empty;
        public string Label { get; set; } = string.Empty;
        public string Type { get; set; } = "desk";
        public string Emoji { get; set; } = "📋";
        public double X { get; set; }
        public double Y { get; set; }
        public double W { get; set; } = 130;
        public double H { get; set; } = 90;
        public int Capacity { get; set; } = 5;
        public string K2ActivityName { get; set; } = string.Empty;
    }

    public class FlowConnection
    {
        public string From { get; set; } = string.Empty;
        public string To { get; set; } = string.Empty;
        public double Weight { get; set; } = 1.0;
    }

    // ─── Instance (person character) ─────────────────────────────────────────

    public class WorkflowInstance
    {
        public string Id { get; set; } = string.Empty;
        public int ProcessInstanceId { get; set; }
        public string WorkflowId { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public string CurrentZoneId { get; set; } = string.Empty;
        public string CurrentActivityName { get; set; } = string.Empty;
        public InstanceState State { get; set; } = InstanceState.Idle;
        public string Folio { get; set; } = string.Empty;
        public string Originator { get; set; } = string.Empty;
        public DateTime StartDate { get; set; }
        public DateTime? ExpectedDuration { get; set; }
        public int WaitTimeSeconds { get; set; }
        public string? ErrorMessage { get; set; }

        // Current destination users (who the task is assigned to)
        public List<string> DestinationUsers { get; set; } = new List<string>();

        // Available actions on the worklist item (e.g. Approve, Reject)
        public List<string> AvailableActions { get; set; } = new List<string>();

        // Character appearance (deterministic from instance ID)
        public string SkinColor { get; set; } = "#FDDCB5";
        public string ShirtColor { get; set; } = "#4A90D9";
        public string Trait { get; set; } = "normal";
    }

    public enum InstanceState
    {
        Walking,
        Idle,
        Queuing,
        Chatting,
        Sleeping,
        Error,
        Completed,
        Rejected
    }

    // ─── Zone Stats ──────────────────────────────────────────────────────────

    public class ZoneStats
    {
        public string ZoneId { get; set; } = string.Empty;
        public int Population { get; set; }
        public int Capacity { get; set; }
        public double AverageWaitSeconds { get; set; }
        public double CongestionRatio { get; set; }
        public bool IsBottleneck { get; set; }
        public int ThroughputPerHour { get; set; }
    }

    public class WorkflowStats
    {
        public string WorkflowId { get; set; } = string.Empty;
        public int TotalInstances { get; set; }
        public int ActiveInstances { get; set; }
        public int ErroredInstances { get; set; }
        public int CompletedInstances { get; set; }
        public List<ZoneStats> ZoneStats { get; set; } = new List<ZoneStats>();
        public List<BottleneckInfo> Bottlenecks { get; set; } = new List<BottleneckInfo>();
    }

    // ─── Bottleneck ──────────────────────────────────────────────────────────

    public class BottleneckInfo
    {
        public string ZoneId { get; set; } = string.Empty;
        public string ZoneLabel { get; set; } = string.Empty;
        public BottleneckSeverity Severity { get; set; }
        public int Population { get; set; }
        public int Capacity { get; set; }
        public double AverageWaitSeconds { get; set; }
        public DateTime DetectedAt { get; set; } = DateTime.UtcNow;
    }

    public enum BottleneckSeverity
    {
        Warning,
        Critical
    }

    // ─── Action requests ─────────────────────────────────────────────────────

    public class RepairRequest
    {
        public string? Comment { get; set; }
    }

    public class RedirectRequest
    {
        public string TargetUser { get; set; } = string.Empty;
        public string? Comment { get; set; }
    }

    public class GoToActivityRequest
    {
        public string TargetActivityName { get; set; } = string.Empty;
        public string? Comment { get; set; }
    }
}
