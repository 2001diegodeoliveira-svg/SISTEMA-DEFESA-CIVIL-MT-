# Inicia o sistema completo em modo PRODUÇÃO no PC local:
#   1) servidor Node (PostgreSQL + 2FA obrigatório)
#   2) túnel Cloudflare expondo http://localhost:3000
#
# Uso:  .\iniciar.ps1
# Para o servidor próprio, a rede precisa permitir TCP/7844 (usamos HTTP/2;
# QUIC/UDP estava sendo descartado na rede e derrubava a conexão).

$ErrorActionPreference = 'Stop'
$Raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cloudflared = Join-Path $env:USERPROFILE 'cloudflared\cloudflared.exe'
$Logs = Join-Path $Raiz 'logs'
New-Item -ItemType Directory -Path $Logs -Force | Out-Null

if (-not (Test-Path $Cloudflared)) {
  throw "cloudflared nao encontrado em $Cloudflared"
}

# --- encerra execucoes anteriores -------------------------------------------
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*iniciar-producao*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2

# --- 1) API ------------------------------------------------------------------
Start-Process -FilePath 'node' -ArgumentList 'iniciar-producao.js' `
  -WorkingDirectory $Raiz -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $Logs 'api-out.log') `
  -RedirectStandardError  (Join-Path $Logs 'api-err.log')

$pronto = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  try {
    if ((Invoke-WebRequest -Uri 'http://localhost:3000/api/' -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { $pronto = $true; break }
  } catch {}
}
if (-not $pronto) { throw "A API nao subiu. Veja logs\api-err.log" }
Write-Host 'API ativa em http://localhost:3000'

# --- 2) tunel ----------------------------------------------------------------
Remove-Item (Join-Path $Logs 'tunnel.log') -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $Cloudflared `
  -ArgumentList 'tunnel','--protocol','http2','--url','http://localhost:3000','--no-autoupdate' `
  -WorkingDirectory $Raiz -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $Logs 'tunnel.log') `
  -RedirectStandardError  (Join-Path $Logs 'tunnel-err.log')

$url = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 2
  $log = Join-Path $Logs 'tunnel-err.log'
  if (Test-Path $log) {
    $m = [regex]::Matches((Get-Content $log -Raw), 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($m.Count -gt 0) { $url = $m[$m.Count - 1].Value; break }
  }
}
if (-not $url) { throw 'Nao foi possivel obter a URL do tunel. Veja logs\tunnel-err.log' }

Write-Host ''
Write-Host "TUNEL ATIVO: $url" -ForegroundColor Green
Write-Host ''
Write-Host 'ATENCAO: o quick tunnel troca de dominio a cada reinicio.'
Write-Host 'Atualize CORS_ORIGIN no arquivo .env.producao e reinicie a API.'
