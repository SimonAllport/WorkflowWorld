using System;
using System.Web.Http;
using Microsoft.AspNet.SignalR;
using Newtonsoft.Json.Converters;
using Newtonsoft.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Owin;
using Microsoft.Owin.Cors;
using Owin;
using WorkflowWorld.Api.Configuration;
using WorkflowWorld.Api.Infrastructure;
using WorkflowWorld.Api.Services;

[assembly: OwinStartup(typeof(WorkflowWorld.Api.Startup))]

namespace WorkflowWorld.Api
{
    public class Startup
    {
        public static IServiceProvider ServiceProvider { get; private set; } = null!;

        public void Configuration(IAppBuilder app)
        {
            // Load configuration
            var config = new ConfigurationBuilder()
                .SetBasePath(AppDomain.CurrentDomain.BaseDirectory)
                .AddJsonFile("appsettings.json", optional: false, reloadOnChange: true)
                .Build();

            // Set up DI
            var services = new ServiceCollection();
            services.Configure<K2Settings>(config.GetSection(K2Settings.SectionName));
            services.AddLogging(builder => builder.AddConsole());
            services.AddScoped<IK2ManagementService, K2ManagementService>();
            services.AddSingleton<WorkflowPollingService>();
            services.AddTransient<Controllers.WorkflowsController>();

            ServiceProvider = services.BuildServiceProvider();

            // Enable CORS
            app.UseCors(CorsOptions.AllowAll);

            // Configure SignalR
            var hubConfig = new HubConfiguration
            {
                EnableDetailedErrors = true,
                EnableJSONP = false
            };
            app.MapSignalR(hubConfig);

            // Configure Web API
            var httpConfig = new HttpConfiguration();
            httpConfig.MapHttpAttributeRoutes();
            httpConfig.DependencyResolver = new ServiceProviderDependencyResolver(ServiceProvider);

            // Use camelCase JSON and string enums to match frontend TypeScript types
            httpConfig.Formatters.JsonFormatter.SerializerSettings.ContractResolver =
                new CamelCasePropertyNamesContractResolver();
            httpConfig.Formatters.JsonFormatter.SerializerSettings.Converters.Add(
                new StringEnumConverter { CamelCaseText = true });

            app.UseWebApi(httpConfig);

            // Start the polling service
            var pollingService = ServiceProvider.GetRequiredService<WorkflowPollingService>();
            pollingService.Start();

            var logger = ServiceProvider.GetRequiredService<ILogger<Startup>>();
            logger.LogInformation("WorkflowWorld API started");
        }
    }
}
