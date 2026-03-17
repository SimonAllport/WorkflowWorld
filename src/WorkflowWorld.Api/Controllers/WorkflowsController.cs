using System.Threading.Tasks;
using System.Web.Http;
using WorkflowWorld.Api.Models;
using WorkflowWorld.Api.Services;

namespace WorkflowWorld.Api.Controllers
{
    [RoutePrefix("api/workflows")]
    public class WorkflowsController : ApiController
    {
        private readonly IK2ManagementService _k2Service;

        public WorkflowsController(IK2ManagementService k2Service)
        {
            _k2Service = k2Service;
        }

        [HttpGet]
        [Route("")]
        public async Task<IHttpActionResult> GetWorkflows()
        {
            var workflows = await _k2Service.GetWorkflowDefinitionsAsync();
            return Ok(workflows);
        }

        [HttpGet]
        [Route("{id}")]
        public async Task<IHttpActionResult> GetWorkflow(string id)
        {
            var workflow = await _k2Service.GetWorkflowDefinitionAsync(id);
            if (workflow == null) return NotFound();
            return Ok(workflow);
        }

        [HttpGet]
        [Route("{id}/instances")]
        public async Task<IHttpActionResult> GetInstances(string id)
        {
            var instances = await _k2Service.GetInstancesAsync(id);
            return Ok(instances);
        }

        [HttpGet]
        [Route("{id}/stats")]
        public async Task<IHttpActionResult> GetStats(string id)
        {
            var stats = await _k2Service.GetWorkflowStatsAsync(id);
            return Ok(stats);
        }

        [HttpPost]
        [Route("~/api/instances/{processInstanceId:int}/repair")]
        public async Task<IHttpActionResult> RepairInstance(int processInstanceId, [FromBody] RepairRequest? request)
        {
            var result = await _k2Service.RepairInstanceAsync(processInstanceId, request?.Comment);
            if (!result) return NotFound();
            return Ok(new { success = true, message = "Instance repaired successfully" });
        }

        [HttpPost]
        [Route("~/api/instances/{processInstanceId:int}/redirect")]
        public async Task<IHttpActionResult> RedirectInstance(int processInstanceId, [FromBody] RedirectRequest request)
        {
            if (string.IsNullOrEmpty(request?.TargetUser))
                return BadRequest("TargetUser is required");

            var result = await _k2Service.RedirectInstanceAsync(
                processInstanceId, request.TargetUser, request.Comment);
            if (!result) return NotFound();
            return Ok(new { success = true, message = $"Instance redirected to {request.TargetUser}" });
        }

        [HttpPost]
        [Route("~/api/instances/{processInstanceId:int}/goto")]
        public async Task<IHttpActionResult> GoToActivity(int processInstanceId, [FromBody] GoToActivityRequest request)
        {
            if (string.IsNullOrEmpty(request?.TargetActivityName))
                return BadRequest("TargetActivityName is required");

            var result = await _k2Service.GoToActivityAsync(
                processInstanceId, request.TargetActivityName, request.Comment);
            if (!result) return NotFound();
            return Ok(new { success = true, message = $"Instance moved to {request.TargetActivityName}" });
        }

        [HttpPost]
        [Route("~/api/instances/{processInstanceId:int}/stop")]
        public async Task<IHttpActionResult> StopInstance(int processInstanceId)
        {
            var result = await _k2Service.StopInstanceAsync(processInstanceId);
            if (!result) return NotFound();
            return Ok(new { success = true, message = "Instance stopped" });
        }
    }
}
