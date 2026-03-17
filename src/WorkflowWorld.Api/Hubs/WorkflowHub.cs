using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.AspNet.SignalR;

namespace WorkflowWorld.Api.Hubs
{
    /// <summary>
    /// SignalR 2 hub for real-time workflow instance updates.
    /// </summary>
    public class WorkflowHub : Hub
    {
        private static readonly ConcurrentDictionary<string, HashSet<string>> _subscriptions = new();

        public Task SubscribeToWorkflow(string workflowId)
        {
            var groupName = $"workflow-{workflowId}";
            Groups.Add(Context.ConnectionId, groupName);

            _subscriptions.AddOrUpdate(
                workflowId,
                _ => new HashSet<string> { Context.ConnectionId },
                (_, set) => { set.Add(Context.ConnectionId); return set; });

            return Task.CompletedTask;
        }

        public Task UnsubscribeFromWorkflow(string workflowId)
        {
            var groupName = $"workflow-{workflowId}";
            Groups.Remove(Context.ConnectionId, groupName);

            if (_subscriptions.TryGetValue(workflowId, out var set))
            {
                set.Remove(Context.ConnectionId);
                if (set.Count == 0) _subscriptions.TryRemove(workflowId, out _);
            }

            return Task.CompletedTask;
        }

        public static bool HasSubscribers(string workflowId)
        {
            return _subscriptions.TryGetValue(workflowId, out var set) && set.Count > 0;
        }

        public override Task OnDisconnected(bool stopCalled)
        {
            foreach (var kvp in _subscriptions)
            {
                kvp.Value.Remove(Context.ConnectionId);
                if (kvp.Value.Count == 0) _subscriptions.TryRemove(kvp.Key, out _);
            }

            return base.OnDisconnected(stopCalled);
        }
    }
}
