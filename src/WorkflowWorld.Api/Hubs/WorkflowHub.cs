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

        public async Task SubscribeToWorkflow(string workflowId)
        {
            var groupName = $"workflow-{workflowId}";
            await Groups.Add(Context.ConnectionId, groupName);

            _subscriptions.AddOrUpdate(
                workflowId,
                _ => new HashSet<string> { Context.ConnectionId },
                (_, set) => { set.Add(Context.ConnectionId); return set; });

            System.Console.WriteLine($"[WorkflowHub] {Context.ConnectionId} subscribed to {workflowId}. Subscribers: {(_subscriptions.TryGetValue(workflowId, out var s) ? s.Count : 0)}");

            // Send immediate confirmation back to caller to verify transport works
            Clients.Caller.Pong("subscribed:" + workflowId);
            // Also try sending directly to this connection via All (bypasses groups)
            Clients.Client(Context.ConnectionId).Pong("direct:" + workflowId);
        }

        public async Task UnsubscribeFromWorkflow(string workflowId)
        {
            var groupName = $"workflow-{workflowId}";
            await Groups.Remove(Context.ConnectionId, groupName);

            if (_subscriptions.TryGetValue(workflowId, out var set))
            {
                set.Remove(Context.ConnectionId);
                if (set.Count == 0) _subscriptions.TryRemove(workflowId, out _);
            }

        }

        public static bool HasSubscribers(string workflowId)
        {
            return _subscriptions.TryGetValue(workflowId, out var set) && set.Count > 0;
        }

        /// <summary>
        /// Get connection IDs subscribed to a workflow (for direct messaging instead of groups).
        /// </summary>
        public static IList<string> GetSubscriberConnectionIds(string workflowId)
        {
            if (_subscriptions.TryGetValue(workflowId, out var set))
                return new List<string>(set);
            return new List<string>();
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
