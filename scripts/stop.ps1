# Stop the fir-flow API server previously started by scripts/start.ps1.
# Only the PID recorded in this project's data/server.pid is touched.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "data/server.pid"
if (-not (Test-Path $pidFile)) { Write-Host "no pid file; server not started from this project"; exit 0 }
$serverPid = [int](Get-Content $pidFile)
$proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
if ($proc) {
  Stop-Process -Id $serverPid
  Write-Host "stopped server pid $serverPid"
} else {
  Write-Host "process $serverPid not running"
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $root "data/server.port") -Force -ErrorAction SilentlyContinue
