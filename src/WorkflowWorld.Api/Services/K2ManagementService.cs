using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SourceCode.Workflow.Management;
using SourceCode.Workflow.Management.Criteria;
using SourceCode.Hosting.Client.BaseAPI;
using WorkflowWorld.Api.Configuration;
using WorkflowWorld.Api.Models;

namespace WorkflowWorld.Api.Services
{
    public class K2ManagementService : IK2ManagementService, IDisposable
    {
        private readonly K2Settings _settings;
        private readonly ILogger<K2ManagementService> _logger;

        // Cache for workflow definitions (rarely changes)
        private static List<WorkflowDefinition>? _definitionsCache;
        private static DateTime _definitionsCacheTime = DateTime.MinValue;
        private static readonly TimeSpan DefinitionsCacheDuration = TimeSpan.FromMinutes(30);
        private static readonly object _cacheLock = new();

        // Cache for error profiles (rarely changes)
        private static List<int>? _errorProfileIdsCache;
        private static DateTime _errorProfilesCacheTime = DateTime.MinValue;
        private static readonly TimeSpan ErrorProfilesCacheDuration = TimeSpan.FromMinutes(10);

        private static readonly string[] SkinColors = { "#FDDCB5", "#F5C69E", "#E8A872", "#C68642", "#8D5524", "#6B3A1F" };
        private static readonly string[] ShirtColors = {
            "#4A90D9", "#E74C3C", "#27AE60", "#F5A623", "#9B59B6", "#1ABC9C",
            "#E67E22", "#3498DB", "#2ECC71", "#E91E63", "#00BCD4", "#FF5722"
        };
        private static readonly string[] Traits = { "impatient", "relaxed", "social", "anxious", "normal" };

        public K2ManagementService(IOptions<K2Settings> settings, ILogger<K2ManagementService> logger)
        {
            _settings = settings.Value;
            _logger = logger;
        }

        // ─── Connection helper ───────────────────────────────────────────────

        private WorkflowManagementServer OpenConnection()
        {
            var server = new WorkflowManagementServer();

            var connStr = new SCConnectionStringBuilder
            {
                Host = _settings.ServerHost,
                Port = (uint)_settings.ServerPort,
                Integrated = true,
                IsPrimaryLogin = true
            };

            server.CreateConnection();
            server.Connection.Open(connStr.ToString());
            return server;
        }

        private static void CloseConnection(WorkflowManagementServer? server)
        {
            try
            {
                if (server?.Connection != null)
                    server.Connection.Close();
            }
            catch { /* swallow close errors */ }
        }

        /// <summary>
        /// Wraps the repeated OpenConnection/try/catch/finally/CloseConnection pattern.
        /// </summary>
        private async Task<T> WithConnection<T>(Func<WorkflowManagementServer, T> action, T fallback, string errorContext)
        {
            return await Task.Run(() =>
            {
                WorkflowManagementServer? server = null;
                try
                {
                    server = OpenConnection();
                    return action(server);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, errorContext);
                    return fallback;
                }
                finally
                {
                    CloseConnection(server);
                }
            });
        }

        // ─── Workflow Definitions ────────────────────────────────────────────

        public async Task<List<WorkflowDefinition>> GetWorkflowDefinitionsAsync()
        {
            // Return cached definitions if still fresh
            lock (_cacheLock)
            {
                if (_definitionsCache != null && DateTime.UtcNow - _definitionsCacheTime < DefinitionsCacheDuration)
                    return _definitionsCache;
            }

            var definitions = await Task.Run(() =>
            {
                var result = new List<WorkflowDefinition>();
                WorkflowManagementServer? server = null;

                try
                {
                    server = OpenConnection();
                    var processSets = server.GetProcSets();

                    // Batch: get all instance counts using a single GetProcessInstancesAll call
                    var allInstances = server.GetProcessInstancesAll(new ProcessInstanceCriteriaFilter());
                    var instanceCounts = new Dictionary<int, int>();
                    foreach (ProcessInstance inst in allInstances)
                    {
                        if (!instanceCounts.ContainsKey(inst.ProcSetID))
                            instanceCounts[inst.ProcSetID] = 0;
                        instanceCounts[inst.ProcSetID]++;
                    }

                    foreach (ProcessSet ps in processSets)
                    {
                        instanceCounts.TryGetValue(ps.ProcSetID, out var instanceCount);

                        result.Add(new WorkflowDefinition
                        {
                            Id = SanitiseId(ps.FullName),
                            Name = !string.IsNullOrEmpty(ps.DisplayName) ? ps.DisplayName : ps.FullName.Split('\\').LastOrDefault() ?? ps.FullName,
                            FullName = ps.FullName,
                            VersionId = ps.ProcSetID,
                            Color = GetDeterministicColor(ps.FullName),
                            Icon = GetWorkflowIcon(ps.FullName),
                            ActiveInstanceCount = instanceCount,
                        });
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error retrieving workflow definitions from K2");
                }
                finally
                {
                    CloseConnection(server);
                }

                return result;
            });

            // Update cache
            lock (_cacheLock)
            {
                _definitionsCache = definitions;
                _definitionsCacheTime = DateTime.UtcNow;
            }

            return definitions;
        }

        public async Task<WorkflowDefinition?> GetWorkflowDefinitionAsync(string workflowId)
        {
            // Use cached definitions to find the basic definition, avoiding a full re-fetch
            var all = await GetWorkflowDefinitionsAsync();
            var def = all.FirstOrDefault(d => d.Id == workflowId);
            if (def == null) return null;

            await Task.Run(() =>
            {
                WorkflowManagementServer? server = null;
                try
                {
                    server = OpenConnection();
                    var activityNames = new HashSet<string>();
                    var displayNameMap = new Dictionary<string, string>(); // activityName → displayName

                    var ipcActivityNames = new HashSet<string>();

                    // 1. Try GetProcessActivities (gives us DisplayName) and detect IPC activities
                    int procID = 0;
                    try
                    {
                        var processes = server.GetProcesses(def.VersionId);
                        if (processes.Count > 0)
                        {
                            var proc = processes[0];
                            procID = proc.ProcID;
                            var userName = Environment.UserName;
                            var activities = server.GetProcessActivities(userName, proc.ProcID);
                            if (activities != null)
                            {
                                foreach (Activity act in activities)
                                {
                                    if (!string.IsNullOrEmpty(act.Name))
                                    {
                                        activityNames.Add(act.Name);
                                        if (!string.IsNullOrEmpty(act.DisplayName))
                                            displayNameMap[act.Name] = act.DisplayName;
                                    }
                                }
                            }
                        }
                    }
                    catch { }

                    // 1b. Detect IPC/subworkflow activities via activity events
                    if (procID > 0)
                    {
                        try
                        {
                            var procActivities = server.GetProcActivities(procID);
                            foreach (Activity act in procActivities)
                            {
                                try
                                {
                                    var events = server.GetActivityEvents(act.ID);
                                    var isIpc = false;
                                    foreach (Event evt in events)
                                    {
                                        if (evt.EventType == EventTypes.IPCEvent)
                                        {
                                            isIpc = true;
                                            var actName = act.Name;
                                            if (!string.IsNullOrEmpty(actName))
                                            {
                                                ipcActivityNames.Add(actName);
                                                activityNames.Add(actName);
                                                if (!string.IsNullOrEmpty(act.DisplayName) && !displayNameMap.ContainsKey(actName))
                                                    displayNameMap[actName] = act.DisplayName;
                                            }
                                            break;
                                        }
                                    }
                                }
                                catch { /* Skip if we can't read events for this activity */ }
                            }
                        }
                        catch (Exception ex)
                        {
                            _logger.LogDebug(ex, "Could not detect IPC activities for workflow {Id}", workflowId);
                        }
                    }

                    // 2. Discover from worklist items
                    try
                    {
                        var wlFilter = new WorklistCriteriaFilter();
                        wlFilter.AddRegularFilter(
                            WorklistFields.ProcessFullName,
                            Comparison.Equals,
                            def.FullName);

                        var worklistItems = server.GetWorklistItems(wlFilter);
                        foreach (WorklistItem item in worklistItems)
                        {
                            if (!string.IsNullOrEmpty(item.ActivityName))
                            {
                                activityNames.Add(item.ActivityName);
                                if (!string.IsNullOrEmpty(item.ActivityDisplayName) && !displayNameMap.ContainsKey(item.ActivityName))
                                    displayNameMap[item.ActivityName] = item.ActivityDisplayName;
                            }
                        }
                    }
                    catch { }

                    // 3. Discover from error logs
                    try
                    {
                        var errorProfiles = server.GetErrorProfiles();
                        foreach (ErrorProfile ep in errorProfiles)
                        {
                            var errLogs = server.GetErrorLogs(ep.ID);
                            foreach (ErrorLog err in errLogs)
                            {
                                if (err.ProcessName == def.FullName && !string.IsNullOrEmpty(err.ErrorItemName))
                                    activityNames.Add(err.ErrorItemName);
                            }
                        }
                    }
                    catch { }

                    // Count active instances
                    var procFilter = new ProcessInstanceCriteriaFilter();
                    procFilter.AddRegularFilter(
                        ProcessInstanceFields.ProcessFullName,
                        Comparison.Equals,
                        def.FullName);

                    var instances = server.GetProcessInstancesAll(procFilter);

                    def.Zones = LayoutActivitiesAsZones(activityNames.ToList(), def.FullName, displayNameMap, ipcActivityNames.ToList());
                    def.Connections = InferConnections(def.Zones);
                    def.ActiveInstanceCount = instances.Count;
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error enriching workflow definition {Id}", workflowId);
                }
                finally
                {
                    CloseConnection(server);
                }
            });

            return def;
        }

        // ─── Instances ───────────────────────────────────────────────────────

        public async Task<List<WorkflowInstance>> GetInstancesAsync(string workflowId)
        {
            var def = await GetWorkflowDefinitionAsync(workflowId);
            if (def == null) return new List<WorkflowInstance>();

            return await Task.Run(() =>
            {
                var instances = new List<WorkflowInstance>();
                WorkflowManagementServer? server = null;

                try
                {
                    server = OpenConnection();

                    // Build procInstID → activityName and procInstID → destinations from worklist items
                    var activityMap = new Dictionary<int, string>();
                    var destinationMap = new Dictionary<int, List<string>>();
                    var actionsMap = new Dictionary<int, List<string>>();
                    try
                    {
                        var wlFilter = new WorklistCriteriaFilter();
                        wlFilter.AddRegularFilter(
                            WorklistFields.ProcessFullName,
                            Comparison.Equals,
                            def.FullName);

                        var worklistItems = server.GetWorklistItems(wlFilter);
                        var eventActionsCache = new Dictionary<int, List<string>>();

                        foreach (WorklistItem item in worklistItems)
                        {
                            if (!activityMap.ContainsKey(item.ProcInstID) && !string.IsNullOrEmpty(item.ActivityName))
                                activityMap[item.ProcInstID] = item.ActivityName;

                            // Collect destination users
                            if (!string.IsNullOrEmpty(item.Destination))
                            {
                                if (!destinationMap.ContainsKey(item.ProcInstID))
                                    destinationMap[item.ProcInstID] = new List<string>();
                                var dest = item.Destination;
                                var parts = dest.Split('\\');
                                var username = parts.Length > 1 ? parts[1] : dest;
                                if (!destinationMap[item.ProcInstID].Contains(username))
                                    destinationMap[item.ProcInstID].Add(username);
                            }

                            // Collect available actions from event
                            if (item.EventID > 0 && !actionsMap.ContainsKey(item.ProcInstID))
                            {
                                if (!eventActionsCache.ContainsKey(item.EventID))
                                {
                                    try
                                    {
                                        var eventActions = server.GetEventActions(item.EventID);
                                        var actionNames = new List<string>();
                                        foreach (EventAction ea in eventActions)
                                        {
                                            if (!string.IsNullOrEmpty(ea.Name))
                                                actionNames.Add(ea.Name);
                                        }
                                        eventActionsCache[item.EventID] = actionNames;
                                    }
                                    catch { eventActionsCache[item.EventID] = new List<string>(); }
                                }
                                actionsMap[item.ProcInstID] = eventActionsCache[item.EventID];
                            }
                        }
                    }
                    catch { }

                    // Get process instances
                    var procFilter = new ProcessInstanceCriteriaFilter();
                    procFilter.AddRegularFilter(
                        ProcessInstanceFields.ProcessFullName,
                        Comparison.Equals,
                        def.FullName);

                    var processes = server.GetProcessInstancesAll(procFilter);
                    foreach (ProcessInstance proc in processes)
                    {
                        activityMap.TryGetValue(proc.ID, out var activityName);

                        // Fallback: if worklist didn't have this instance and there's no teleporter zone,
                        // try per-instance worklist query (skip if workflow has teleporter — IPC detection handles it)
                        var hasTeleporter = def.Zones.Any(z => z.Type == "teleporter");
                        if (string.IsNullOrEmpty(activityName) && !hasTeleporter)
                        {
                            try
                            {
                                var instFilter = new WorklistCriteriaFilter();
                                instFilter.AddRegularFilter(
                                    (WorklistFields)12, // WorklistFields.ProcInstID
                                    Comparison.Equals,
                                    proc.ID);
                                var instWorklistItems = server.GetWorklistItems(instFilter);
                                foreach (WorklistItem wlItem in instWorklistItems)
                                {
                                    if (!string.IsNullOrEmpty(wlItem.ActivityName))
                                    {
                                        activityName = wlItem.ActivityName;
                                        if (!string.IsNullOrEmpty(wlItem.Destination))
                                        {
                                            if (!destinationMap.ContainsKey(proc.ID))
                                                destinationMap[proc.ID] = new List<string>();
                                            var parts = wlItem.Destination.Split('\\');
                                            var username = parts.Length > 1 ? parts[1] : wlItem.Destination;
                                            if (!destinationMap[proc.ID].Contains(username))
                                                destinationMap[proc.ID].Add(username);
                                        }
                                        break;
                                    }
                                }
                            }
                            catch { }
                        }

                        var waitSeconds = (int)(DateTime.Now - proc.StartDate).TotalSeconds;
                        var state = MapInstanceState(proc.Status, waitSeconds);

                        // Detect IPC-waiting instances: no worklist item but active
                        var isWaitingOnIpc = false;
                        var zoneId = "entrance";
                        if (state == InstanceState.Error)
                        {
                            zoneId = "error-corner";
                        }
                        else if (string.IsNullOrEmpty(activityName) && state != InstanceState.Completed)
                        {
                            // No worklist item but active — likely waiting on IPC/subworkflow
                            var teleporterZone = def.Zones.FirstOrDefault(z => z.Type == "teleporter");
                            if (teleporterZone != null)
                            {
                                zoneId = teleporterZone.Id;
                                activityName = teleporterZone.K2ActivityName;
                                isWaitingOnIpc = true;
                            }
                        }
                        else
                        {
                            zoneId = FindZoneForActivity(def.Zones, activityName);
                        }

                        instances.Add(new WorkflowInstance
                        {
                            Id = $"inst-{proc.ID}",
                            ProcessInstanceId = proc.ID,
                            WorkflowId = workflowId,
                            Name = ExtractDisplayName(proc.Folio, proc.Originator),
                            CurrentZoneId = zoneId,
                            CurrentActivityName = activityName ?? "Unknown",
                            State = state,
                            IsWaitingOnIPC = isWaitingOnIpc,
                            Folio = proc.Folio ?? "",
                            Originator = proc.Originator ?? "",
                            StartDate = proc.StartDate,
                            WaitTimeSeconds = waitSeconds,
                            SkinColor = GetDeterministicSkin(proc.ID),
                            ShirtColor = GetDeterministicShirt(proc.ID),
                            Trait = GetDeterministicTrait(proc.ID),
                            DestinationUsers = destinationMap.ContainsKey(proc.ID) ? destinationMap[proc.ID] : new List<string>(),
                            AvailableActions = actionsMap.ContainsKey(proc.ID) ? actionsMap[proc.ID] : new List<string>(),
                        });
                    }

                    // Get errored instances (use cached error profile IDs)
                    try
                    {
                        if (_errorProfileIdsCache == null || DateTime.UtcNow - _errorProfilesCacheTime > ErrorProfilesCacheDuration)
                        {
                            var eps = server.GetErrorProfiles();
                            _errorProfileIdsCache = new List<int>();
                            foreach (ErrorProfile ep2 in eps)
                                _errorProfileIdsCache.Add(ep2.ID);
                            _errorProfilesCacheTime = DateTime.UtcNow;
                        }
                        foreach (var epId in _errorProfileIdsCache)
                        {
                            var errLogs = server.GetErrorLogs(epId);
                            foreach (ErrorLog error in errLogs)
                            {
                                if (error.ProcessName != def.FullName) continue;

                                var existing = instances.FirstOrDefault(i => i.ProcessInstanceId == error.ProcInstID);
                                if (existing != null)
                                {
                                    existing.State = InstanceState.Error;
                                    existing.ErrorMessage = error.Description;
                                    existing.CurrentZoneId = "error-corner";
                                    continue;
                                }

                                instances.Add(new WorkflowInstance
                                {
                                    Id = $"inst-{error.ProcInstID}",
                                    ProcessInstanceId = error.ProcInstID,
                                    WorkflowId = workflowId,
                                    Name = $"Error-{error.ID}",
                                    CurrentZoneId = "error-corner",
                                    CurrentActivityName = error.ErrorItemName ?? "Unknown",
                                    State = InstanceState.Error,
                                    Folio = "",
                                    Originator = "",
                                    StartDate = error.ErrorDate,
                                    WaitTimeSeconds = (int)(DateTime.Now - error.ErrorDate).TotalSeconds,
                                    ErrorMessage = error.Description,
                                    SkinColor = GetDeterministicSkin(error.ProcInstID),
                                    ShirtColor = GetDeterministicShirt(error.ProcInstID),
                                    Trait = "anxious",
                                });
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Error querying error logs for workflow {Id}", workflowId);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Error retrieving instances for workflow {Id}", workflowId);
                }
                finally
                {
                    CloseConnection(server);
                }

                return instances.Take(_settings.MaxInstancesPerWorkflow).ToList();
            });
        }

        // ─── Stats ───────────────────────────────────────────────────────────

        public async Task<WorkflowStats> GetWorkflowStatsAsync(string workflowId)
        {
            var instances = await GetInstancesAsync(workflowId);
            var def = await GetWorkflowDefinitionAsync(workflowId);
            if (def == null) return new WorkflowStats { WorkflowId = workflowId };

            var zoneStats = def.Zones.Select(zone =>
            {
                var zoneInstances = instances.Where(i => i.CurrentZoneId == zone.Id).ToList();
                var population = zoneInstances.Count;
                var avgWait = zoneInstances.Count > 0
                    ? zoneInstances.Average(i => i.WaitTimeSeconds) : 0;
                var congestion = zone.Capacity > 0 ? (double)population / zone.Capacity : 0;
                var isBottleneck = congestion >= _settings.BottleneckThreshold
                    && avgWait >= _settings.BottleneckMinWaitSeconds;

                return new ZoneStats
                {
                    ZoneId = zone.Id, Population = population, Capacity = zone.Capacity,
                    AverageWaitSeconds = avgWait, CongestionRatio = congestion, IsBottleneck = isBottleneck,
                };
            }).ToList();

            var bottlenecks = zoneStats
                .Where(z => z.IsBottleneck)
                .Select(z => new BottleneckInfo
                {
                    ZoneId = z.ZoneId,
                    ZoneLabel = def.Zones.First(zone => zone.Id == z.ZoneId).Label,
                    Severity = z.CongestionRatio > 1.5 ? BottleneckSeverity.Critical : BottleneckSeverity.Warning,
                    Population = z.Population, Capacity = z.Capacity, AverageWaitSeconds = z.AverageWaitSeconds,
                }).ToList();

            return new WorkflowStats
            {
                WorkflowId = workflowId,
                TotalInstances = instances.Count,
                ActiveInstances = instances.Count(i => i.State == InstanceState.Walking || i.State == InstanceState.Idle || i.State == InstanceState.Queuing),
                ErroredInstances = instances.Count(i => i.State == InstanceState.Error),
                CompletedInstances = instances.Count(i => i.State == InstanceState.Completed),
                ZoneStats = zoneStats, Bottlenecks = bottlenecks,
            };
        }

        /// <summary>
        /// Computes stats from already-fetched instances, avoiding a redundant GetInstancesAsync call.
        /// </summary>
        public async Task<WorkflowStats> GetWorkflowStatsFromInstancesAsync(string workflowId, List<WorkflowInstance> instances)
        {
            var def = await GetWorkflowDefinitionAsync(workflowId);
            if (def == null) return new WorkflowStats { WorkflowId = workflowId };

            var zoneStats = def.Zones.Select(zone =>
            {
                var zoneInstances = instances.Where(i => i.CurrentZoneId == zone.Id).ToList();
                var population = zoneInstances.Count;
                var avgWait = zoneInstances.Count > 0
                    ? zoneInstances.Average(i => i.WaitTimeSeconds) : 0;
                var congestion = zone.Capacity > 0 ? (double)population / zone.Capacity : 0;
                var isBottleneck = congestion >= _settings.BottleneckThreshold
                    && avgWait >= _settings.BottleneckMinWaitSeconds;

                return new ZoneStats
                {
                    ZoneId = zone.Id, Population = population, Capacity = zone.Capacity,
                    AverageWaitSeconds = avgWait, CongestionRatio = congestion, IsBottleneck = isBottleneck,
                };
            }).ToList();

            var bottlenecks = zoneStats
                .Where(z => z.IsBottleneck)
                .Select(z => new BottleneckInfo
                {
                    ZoneId = z.ZoneId,
                    ZoneLabel = def.Zones.First(zone => zone.Id == z.ZoneId).Label,
                    Severity = z.CongestionRatio > 1.5 ? BottleneckSeverity.Critical : BottleneckSeverity.Warning,
                    Population = z.Population, Capacity = z.Capacity, AverageWaitSeconds = z.AverageWaitSeconds,
                }).ToList();

            return new WorkflowStats
            {
                WorkflowId = workflowId,
                TotalInstances = instances.Count,
                ActiveInstances = instances.Count(i => i.State == InstanceState.Walking || i.State == InstanceState.Idle || i.State == InstanceState.Queuing),
                ErroredInstances = instances.Count(i => i.State == InstanceState.Error),
                CompletedInstances = instances.Count(i => i.State == InstanceState.Completed),
                ZoneStats = zoneStats, Bottlenecks = bottlenecks,
            };
        }

        // ─── Actions ─────────────────────────────────────────────────────────

        public async Task<bool> RepairInstanceAsync(int processInstanceId, string? comment = null)
        {
            return await WithConnection(server =>
            {
                var errorProfiles = server.GetErrorProfiles();
                foreach (ErrorProfile ep in errorProfiles)
                {
                    var errors = server.GetErrorLogs(ep.ID);
                    foreach (ErrorLog error in errors)
                    {
                        if (error.ProcInstID == processInstanceId)
                        {
                            server.RetryError(error.ProcInstID, error.ID, comment ?? "Repaired via Workflow World");
                            _logger.LogInformation("Repaired instance {Id}, error {ErrorId}", processInstanceId, error.ID);
                            return true;
                        }
                    }
                }
                return false;
            }, false, $"Error repairing instance {processInstanceId}");
        }

        public async Task<bool> RedirectInstanceAsync(int processInstanceId, string targetUser, string? comment = null)
        {
            return await WithConnection(server =>
            {
                var wlFilter = new WorklistCriteriaFilter();
                wlFilter.AddRegularFilter(
                    (WorklistFields)12, // WorklistFields.ProcInstID
                    Comparison.Equals,
                    processInstanceId);

                var worklistItems = server.GetWorklistItems(wlFilter);
                var redirected = false;

                foreach (WorklistItem item in worklistItems)
                {
                    server.RedirectWorklistItem(
                        item.Actioner.Name,
                        targetUser,
                        processInstanceId,
                        item.ActInstDestID,
                        item.ID);
                    redirected = true;
                }

                if (redirected)
                    _logger.LogInformation("Redirected instance {Id} to {User}", processInstanceId, targetUser);

                return redirected;
            }, false, $"Error redirecting instance {processInstanceId}");
        }

        public async Task<bool> GoToActivityAsync(int processInstanceId, string targetActivityName, string? comment = null)
        {
            return await WithConnection(server =>
            {
                server.GotoActivity(processInstanceId, targetActivityName);
                _logger.LogInformation("Moved instance {Id} to activity {Activity}", processInstanceId, targetActivityName);
                return true;
            }, false, $"Error moving instance {processInstanceId} to {targetActivityName}");
        }

        public async Task<bool> StopInstanceAsync(int processInstanceId)
        {
            return await WithConnection(server =>
            {
                server.StopProcessInstances(processInstanceId);
                _logger.LogInformation("Stopped instance {Id}", processInstanceId);
                return true;
            }, false, $"Error stopping instance {processInstanceId}");
        }

        // ─── Layout Engine ───────────────────────────────────────────────────

        private List<ZoneDefinition> LayoutActivitiesAsZones(List<string> activityNames, string workflowFullName, Dictionary<string, string>? displayNames = null, List<string>? ipcActivityNames = null)
        {
            var zones = new List<ZoneDefinition>();
            const double startX = 70;
            const double spacingX = 200, spacingY = 180;
            const double width = 950, height = 520;

            zones.Add(new ZoneDefinition
            {
                Id = "entrance", Label = "Entrance", Type = "door", Emoji = "🚪",
                X = startX, Y = 260, W = 70, H = 55, Capacity = 99, K2ActivityName = ""
            });

            int col = 1, row = 0;
            foreach (var actName in activityNames.OrderBy(a => a))
            {
                var friendlyName = displayNames != null && displayNames.TryGetValue(actName, out var dn) && !string.IsNullOrEmpty(dn)
                    ? dn : actName;
                var isIpc = ipcActivityNames != null && ipcActivityNames.Contains(actName);
                zones.Add(new ZoneDefinition
                {
                    Id = SanitiseId(actName),
                    Label = TruncateLabel(friendlyName, 22),
                    Type = isIpc ? "teleporter" : GuessZoneType(actName),
                    Emoji = isIpc ? "🌀" : GuessEmoji(actName),
                    X = startX + col * spacingX,
                    Y = 140 + row * spacingY,
                    W = 140, H = 90,
                    Capacity = _settings.DefaultZoneCapacity,
                    K2ActivityName = actName
                });
                row++;
                if (row >= 2) { row = 0; col++; }
            }

            var exitX = Math.Min(startX + (col + 1) * spacingX, width - 80);
            zones.Add(new ZoneDefinition
            {
                Id = "completed-exit", Label = "Completed", Type = "exit-good", Emoji = "🎉",
                X = exitX, Y = 160, W = 110, H = 70, Capacity = 99, K2ActivityName = ""
            });

            zones.Add(new ZoneDefinition
            {
                Id = "error-corner", Label = "Errors", Type = "error", Emoji = "🚨",
                X = width - 70, Y = height - 50, W = 90, H = 55, Capacity = 99, K2ActivityName = ""
            });

            return zones;
        }

        private static List<FlowConnection> InferConnections(List<ZoneDefinition> zones)
        {
            var connections = new List<FlowConnection>();
            var actZones = zones.Where(z =>
                z.Type != "door" && z.Type != "exit-good" && z.Type != "exit-bad" && z.Type != "error" && z.Type != "teleporter").ToList();
            var teleporterZones = zones.Where(z => z.Type == "teleporter").ToList();
            var entrance = zones.FirstOrDefault(z => z.Type == "door");
            var exit = zones.FirstOrDefault(z => z.Type == "exit-good");
            var error = zones.FirstOrDefault(z => z.Type == "error");

            if (entrance != null)
                foreach (var zone in actZones.Take(2))
                    connections.Add(new FlowConnection { From = entrance.Id, To = zone.Id, Weight = 0.5 });

            for (int i = 0; i < actZones.Count - 1; i++)
            {
                connections.Add(new FlowConnection { From = actZones[i].Id, To = actZones[i + 1].Id, Weight = 0.6 });
                if (error != null)
                    connections.Add(new FlowConnection { From = actZones[i].Id, To = error.Id, Weight = 0.1 });
            }

            if (exit != null && actZones.Count > 0)
                connections.Add(new FlowConnection { From = actZones.Last().Id, To = exit.Id, Weight = 0.8 });

            // Connect teleporter (IPC) zones: from preceding activity zones and to following ones
            foreach (var tp in teleporterZones)
            {
                if (entrance != null)
                    connections.Add(new FlowConnection { From = entrance.Id, To = tp.Id, Weight = 0.3 });
                foreach (var az in actZones)
                    connections.Add(new FlowConnection { From = az.Id, To = tp.Id, Weight = 0.2 });
                if (exit != null)
                    connections.Add(new FlowConnection { From = tp.Id, To = exit.Id, Weight = 0.5 });
                if (error != null)
                    connections.Add(new FlowConnection { From = tp.Id, To = error.Id, Weight = 0.1 });
            }

            return connections;
        }

        // ─── State Mapping ───────────────────────────────────────────────────

        private static InstanceState MapInstanceState(string status, int waitSeconds)
        {
            switch (status)
            {
                case "Stopped":
                case "Error":
                    return InstanceState.Error;
                case "Complete":
                case "Deleted":
                    return InstanceState.Completed;
                default:
                    if (waitSeconds > 86400) return InstanceState.Sleeping;
                    if (waitSeconds > 3600) return InstanceState.Idle;
                    return InstanceState.Idle;
            }
        }

        // ─── Helpers ─────────────────────────────────────────────────────────

        private static string SanitiseId(string name) =>
            name.ToLowerInvariant().Replace("\\", "-").Replace("/", "-").Replace(" ", "-").Replace(".", "-");

        private static string TruncateLabel(string name, int max) =>
            name.Length <= max ? name : name.Substring(0, max - 1) + "…";

        private static string ExtractDisplayName(string? folio, string? originator)
        {
            var user = "Unknown";
            if (!string.IsNullOrEmpty(originator))
            {
                var parts = originator.Split('\\');
                user = parts.Length > 1 ? parts[1] : originator;
            }

            if (!string.IsNullOrEmpty(folio))
                return $"{folio} ({user})";

            return user;
        }

        private static string FindZoneForActivity(List<ZoneDefinition> zones, string? activityName)
        {
            if (string.IsNullOrEmpty(activityName)) return "entrance";
            var zone = zones.FirstOrDefault(z =>
                z.K2ActivityName.Equals(activityName, StringComparison.OrdinalIgnoreCase));
            return zone?.Id ?? "entrance";
        }

        private static string GetDeterministicSkin(int id) => SkinColors[Math.Abs(id * 7) % SkinColors.Length];
        private static string GetDeterministicShirt(int id) => ShirtColors[Math.Abs(id * 13) % ShirtColors.Length];
        private static string GetDeterministicTrait(int id) => Traits[Math.Abs(id * 17) % Traits.Length];
        private static string GetDeterministicColor(string name) =>
            ShirtColors[Math.Abs(name.GetHashCode()) % ShirtColors.Length];

        private static string GuessZoneType(string activityName)
        {
            var lower = activityName.ToLower();
            if (lower.Contains("approv") || lower.Contains("review") || lower.Contains("sign")) return "office";
            if (lower.Contains("submit") || lower.Contains("form") || lower.Contains("enter")) return "desk";
            if (lower.Contains("wait") || lower.Contains("pending")) return "seats";
            if (lower.Contains("auto") || lower.Contains("system") || lower.Contains("integrat")) return "machine";
            return "desk";
        }

        private static string GuessEmoji(string activityName)
        {
            var lower = activityName.ToLower();
            if (lower.Contains("approv")) return "✅";
            if (lower.Contains("review")) return "🔍";
            if (lower.Contains("sign")) return "✍️";
            if (lower.Contains("submit") || lower.Contains("form")) return "📝";
            if (lower.Contains("email") || lower.Contains("notify")) return "📧";
            if (lower.Contains("manager") || lower.Contains("boss")) return "👔";
            if (lower.Contains("hr") || lower.Contains("human")) return "📋";
            if (lower.Contains("finance") || lower.Contains("pay")) return "💰";
            if (lower.Contains("it") || lower.Contains("system") || lower.Contains("tech")) return "💻";
            if (lower.Contains("train")) return "📚";
            if (lower.Contains("wait")) return "🪑";
            return "📋";
        }

        private static string GetWorkflowIcon(string name)
        {
            var lower = name.ToLower();
            if (lower.Contains("leave") || lower.Contains("holiday")) return "🏖️";
            if (lower.Contains("expense") || lower.Contains("claim")) return "💰";
            if (lower.Contains("onboard") || lower.Contains("hire")) return "🎓";
            if (lower.Contains("purchase") || lower.Contains("order")) return "🛒";
            if (lower.Contains("invoice")) return "🧾";
            if (lower.Contains("contract")) return "📜";
            if (lower.Contains("incident") || lower.Contains("ticket")) return "🎫";
            return "📋";
        }

        public void Dispose() { }
    }
}
