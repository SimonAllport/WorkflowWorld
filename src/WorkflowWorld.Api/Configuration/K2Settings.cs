namespace WorkflowWorld.Api.Configuration;

public class K2Settings
{
    public const string SectionName = "K2";

    /// <summary>
    /// K2 server hostname (e.g. "k2server.yourdomain.com")
    /// </summary>
    public string ServerHost { get; set; } = "localhost";

    /// <summary>
    /// K2 server port (default 5252 for K2 Five)
    /// </summary>
    public int ServerPort { get; set; } = 5252;

    /// <summary>
    /// Polling interval in seconds for checking instance updates
    /// </summary>
    public int PollingIntervalSeconds { get; set; } = 5;

    /// <summary>
    /// Maximum number of instances to track per workflow
    /// </summary>
    public int MaxInstancesPerWorkflow { get; set; } = 200;

    /// <summary>
    /// Bottleneck detection: zone population / capacity ratio threshold
    /// </summary>
    public double BottleneckThreshold { get; set; } = 0.9;

    /// <summary>
    /// Bottleneck detection: minimum average wait time (seconds) to flag
    /// </summary>
    public int BottleneckMinWaitSeconds { get; set; } = 300;

    /// <summary>
    /// Zone capacity defaults when not explicitly configured
    /// </summary>
    public int DefaultZoneCapacity { get; set; } = 5;
}
