using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNet.SignalR;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using WorkflowWorld.Api.Configuration;
using WorkflowWorld.Api.Hubs;
using WorkflowWorld.Api.Models;

namespace WorkflowWorld.Api.Services
{
    /// <summary>
    /// Timer-based service that polls K2 for instance changes and pushes
    /// updates to connected clients via SignalR.
    /// </summary>
    public class WorkflowPollingService : IDisposable
    {
        private readonly IServiceProvider _services;
        private readonly K2Settings _settings;
        private readonly ILogger<WorkflowPollingService> _logger;
        private Timer? _timer;

        private readonly Dictionary<string, Dictionary<string, WorkflowInstance>> _previousInstances = new();
        private readonly Dictionary<string, List<BottleneckInfo>> _previousBottlenecks = new();

        public WorkflowPollingService(
            IServiceProvider services,
            IOptions<K2Settings> settings,
            ILogger<WorkflowPollingService> logger)
        {
            _services = services;
            _settings = settings.Value;
            _logger = logger;
        }

        public void Start()
        {
            _logger.LogInformation(
                "Workflow polling service started. Interval: {Interval}s",
                _settings.PollingIntervalSeconds);

            _timer = new Timer(
                _ => Task.Run(async () =>
                {
                    try { await PollAndPushUpdates(); }
                    catch (Exception ex) { _logger.LogError(ex, "Error during workflow polling cycle"); }
                }),
                null,
                TimeSpan.FromSeconds(5),
                TimeSpan.FromSeconds(_settings.PollingIntervalSeconds));
        }

        private async Task PollAndPushUpdates()
        {
            using var scope = _services.CreateScope();
            var k2Service = scope.ServiceProvider.GetRequiredService<IK2ManagementService>();
            var hubContext = GlobalHost.ConnectionManager.GetHubContext<WorkflowHub>();

            var workflows = await k2Service.GetWorkflowDefinitionsAsync();

            foreach (var wf in workflows)
            {
                var groupName = $"workflow-{wf.Id}";

                if (!WorkflowHub.HasSubscribers(wf.Id)) continue;

                try
                {
                    var currentInstances = await k2Service.GetInstancesAsync(wf.Id);
                    var currentMap = currentInstances.ToDictionary(i => i.Id);

                    // Use already-fetched instances to compute stats, avoiding redundant K2 calls
                    var stats = await k2Service.GetWorkflowStatsFromInstancesAsync(wf.Id, currentInstances);

                    if (_previousInstances.TryGetValue(wf.Id, out var prevMap))
                    {
                        foreach (var kvp in currentMap)
                        {
                            if (!prevMap.ContainsKey(kvp.Key))
                                hubContext.Clients.Group(groupName).InstanceCreated(kvp.Value);
                        }

                        foreach (var kvp in prevMap)
                        {
                            if (!currentMap.ContainsKey(kvp.Key))
                                hubContext.Clients.Group(groupName).InstanceCompleted(kvp.Key);
                        }

                        foreach (var kvp in currentMap)
                        {
                            if (prevMap.TryGetValue(kvp.Key, out var prev))
                            {
                                if (prev.CurrentZoneId != kvp.Value.CurrentZoneId ||
                                    prev.State != kvp.Value.State)
                                {
                                    hubContext.Clients.Group(groupName).InstanceUpdated(kvp.Value);
                                }

                                if (prev.State != InstanceState.Error &&
                                    kvp.Value.State == InstanceState.Error)
                                {
                                    hubContext.Clients.Group(groupName).InstanceErrored(kvp.Value);
                                }
                            }
                        }
                    }
                    else
                    {
                        hubContext.Clients.Group(groupName).AllInstances(currentInstances);
                    }

                    hubContext.Clients.Group(groupName).ZoneStatsUpdated(stats.ZoneStats);

                    var prevBottleneckIds = _previousBottlenecks.ContainsKey(wf.Id)
                        ? new HashSet<string>(_previousBottlenecks[wf.Id].Select(b => b.ZoneId))
                        : new HashSet<string>();
                    var currentBottleneckIds = new HashSet<string>(stats.Bottlenecks.Select(b => b.ZoneId));

                    foreach (var bn in stats.Bottlenecks.Where(b => !prevBottleneckIds.Contains(b.ZoneId)))
                    {
                        hubContext.Clients.Group(groupName).BottleneckDetected(bn);
                        _logger.LogWarning(
                            "Bottleneck detected: {Zone} in {Workflow} ({Pop}/{Cap})",
                            bn.ZoneLabel, wf.Name, bn.Population, bn.Capacity);
                    }

                    foreach (var zoneId in prevBottleneckIds.Except(currentBottleneckIds))
                    {
                        hubContext.Clients.Group(groupName).BottleneckResolved(zoneId);
                        _logger.LogInformation("Bottleneck resolved: {Zone} in {Workflow}", zoneId, wf.Name);
                    }

                    _previousInstances[wf.Id] = currentMap;
                    _previousBottlenecks[wf.Id] = stats.Bottlenecks;
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error polling workflow {Id}", wf.Id);
                }
            }
        }

        public void Dispose()
        {
            _timer?.Dispose();
        }
    }
}
