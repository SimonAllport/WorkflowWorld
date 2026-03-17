using System;
using System.Collections.Generic;
using System.Web.Http.Dependencies;
using Microsoft.Extensions.DependencyInjection;

namespace WorkflowWorld.Api.Infrastructure
{
    /// <summary>
    /// Bridges Microsoft.Extensions.DependencyInjection to Web API 2's IDependencyResolver.
    /// </summary>
    public class ServiceProviderDependencyResolver : IDependencyResolver
    {
        private readonly IServiceProvider _provider;

        public ServiceProviderDependencyResolver(IServiceProvider provider)
        {
            _provider = provider;
        }

        public IDependencyScope BeginScope()
        {
            return new ServiceProviderDependencyScope(_provider.CreateScope());
        }

        public object? GetService(Type serviceType)
        {
            return _provider.GetService(serviceType);
        }

        public IEnumerable<object> GetServices(Type serviceType)
        {
            return _provider.GetServices(serviceType);
        }

        public void Dispose() { }
    }

    public class ServiceProviderDependencyScope : IDependencyScope
    {
        private readonly IServiceScope _scope;

        public ServiceProviderDependencyScope(IServiceScope scope)
        {
            _scope = scope;
        }

        public object? GetService(Type serviceType)
        {
            return _scope.ServiceProvider.GetService(serviceType);
        }

        public IEnumerable<object> GetServices(Type serviceType)
        {
            return _scope.ServiceProvider.GetServices(serviceType);
        }

        public void Dispose() => _scope.Dispose();
    }
}
