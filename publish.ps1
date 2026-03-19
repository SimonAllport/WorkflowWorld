##
## WorkflowWorld IIS Publish Script
## Run from the repo root: powershell -File publish.ps1
##

param(
    [string]$OutputDir = ".\publish",
    [string]$IISSiteName = "WorkflowWorld"
)

$ErrorActionPreference = "Stop"

Write-Host "=== Building Frontend ===" -ForegroundColor Cyan
Push-Location src\WorkflowWorld.Client
npm install
npm run build   # outputs to ../../dist/
Pop-Location

Write-Host "=== Building Backend ===" -ForegroundColor Cyan
Push-Location src\WorkflowWorld.Api
dotnet publish -c Release -o "..\..\$OutputDir\bin"
Pop-Location

Write-Host "=== Assembling publish folder ===" -ForegroundColor Cyan

# Copy web.config to publish root
Copy-Item "src\WorkflowWorld.Api\web.config" "$OutputDir\web.config" -Force

# Copy appsettings.json to publish root (IIS reads from app root)
Copy-Item "src\WorkflowWorld.Api\appsettings.json" "$OutputDir\appsettings.json" -Force

# Copy frontend build to publish root (SPA files served directly by IIS)
if (Test-Path "dist") {
    Copy-Item "dist\*" "$OutputDir\" -Recurse -Force
}

# Copy K2 SDK DLLs
if (Test-Path "lib") {
    Copy-Item "lib\*.dll" "$OutputDir\bin\" -Force
}

Write-Host ""
Write-Host "=== Publish complete ===" -ForegroundColor Green
Write-Host "Output: $OutputDir"
Write-Host ""
Write-Host "IIS Setup:" -ForegroundColor Yellow
Write-Host "  1. Create IIS Application Pool:"
Write-Host "     - .NET CLR Version: v4.0"
Write-Host "     - Managed Pipeline: Integrated"
Write-Host "     - Identity: Account with K2 server access"
Write-Host "  2. Create IIS Site/Application:"
Write-Host "     - Physical Path: $(Resolve-Path $OutputDir)"
Write-Host "     - App Pool: (the one above)"
Write-Host "  3. Authentication:"
Write-Host "     - Enable Windows Authentication"
Write-Host "     - Disable Anonymous Authentication"
Write-Host "  4. Ensure URL Rewrite module is installed"
Write-Host ""
