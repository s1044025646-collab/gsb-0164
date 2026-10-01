# Start the fir-flow API server bound to 127.0.0.1 on an OS-assigned port.
# Manages ONLY processes started from this project; PID file lives under data/.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$pidFile = Join-Path $root "data/server.pid"
$portFile = Join-Path $root "data/server.port"
New-Item -ItemType Directory -Force -Path (Join-Path $root "data") | Out-Null

if (Test-Path $pidFile) {
  $existing = [int](Get-Content $pidFile)
  $alive = Get-Process -Id $existing -ErrorAction SilentlyContinue
  if ($alive) { throw "server already running (pid $existing)" }
  Remove-Item $pidFile -Force
}

$p = Start-Process -FilePath "node" `
  -ArgumentList '--experimental-sqlite','--experimental-strip-types','src/server.ts' `
  -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $root "data/srv.out") `
  -RedirectStandardError (Join-Path $root "data/srv.err")

Set-Content -Path $pidFile -Value $p.Id
$port = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 200
  $line = Get-Content (Join-Path $root "data/srv.out") -ErrorAction SilentlyContinue | Select-String '127.0.0.1:(\d+)'
  if ($line) { $port = $line.Matches[0].Groups[1].Value; break }
}
if (-not $port) { throw "server did not report a port; see data/srv.err" }
Set-Content -Path $portFile -Value $port
Write-Host "fir-flow server pid=$($p.Id) url=http://127.0.0.1:$port"
