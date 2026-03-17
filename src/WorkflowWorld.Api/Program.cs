using System;
using Microsoft.Owin.Hosting;

namespace WorkflowWorld.Api
{
    class Program
    {
        static void Main(string[] args)
        {
            var url = "http://localhost:9090/";

            try
            {
                using (WebApp.Start<Startup>(url))
                {
                    Console.WriteLine($"WorkflowWorld API running at {url}");
                    if (Console.IsInputRedirected)
                    {
                        // Running in background — block until process is killed
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
