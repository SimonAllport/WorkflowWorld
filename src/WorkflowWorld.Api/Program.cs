using System;
using Microsoft.Owin.Hosting;

namespace WorkflowWorld.Api
{
    class Program
    {
        /// <summary>
        /// Self-host entry point for development.
        /// When deployed to IIS, the OwinStartup attribute on Startup.cs
        /// is used instead and this Main is never called.
        /// </summary>
        static void Main(string[] args)
        {
            var port = args.Length > 0 ? args[0] : "9090";
            var url = $"http://localhost:{port}/";

            try
            {
                using (WebApp.Start<Startup>(url))
                {
                    Console.WriteLine($"WorkflowWorld API running at {url}");
                    if (Console.IsInputRedirected)
                    {
                        Console.WriteLine("Running in background mode (Ctrl+C to stop)...");
                        System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite);
                    }
                    else
                    {
                        Console.WriteLine("Press Enter to stop...");
                        Console.ReadLine();
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Failed to start: {ex}");
                if (!Console.IsInputRedirected) Console.ReadLine();
            }
        }
    }
}
