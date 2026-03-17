using System.Collections.Generic;
using System.Threading.Tasks;
using WorkflowWorld.Api.Models;

namespace WorkflowWorld.Api.Services
{
    public interface IK2ManagementService
    {
        Task<List<WorkflowDefinition>> GetWorkflowDefinitionsAsync();
        Task<WorkflowDefinition?> GetWorkflowDefinitionAsync(string workflowId);
        Task<List<WorkflowInstance>> GetInstancesAsync(string workflowId);
        Task<WorkflowStats> GetWorkflowStatsAsync(string workflowId);
        Task<WorkflowStats> GetWorkflowStatsFromInstancesAsync(string workflowId, List<WorkflowInstance> instances);
        Task<bool> RepairInstanceAsync(int processInstanceId, string? comment = null);
        Task<bool> RedirectInstanceAsync(int processInstanceId, string targetUser, string? comment = null);
        Task<bool> GoToActivityAsync(int processInstanceId, string targetActivityName, string? comment = null);
        Task<bool> StopInstanceAsync(int processInstanceId);
    }
}
