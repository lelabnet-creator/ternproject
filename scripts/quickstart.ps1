#Requires -Version 7.0
<#
    TERN — quick start for Windows.

      irm https://raw.githubusercontent.com/tern-status/tern/main/scripts/quickstart.ps1 | iex

    Brings up a complete local instance: clone, secret, database, migrations,
    demo tenant, dev server. Safe to re-run — every step checks before it acts.
#>

$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:TERN_REPO) { $env:TERN_REPO } else { 'https://github.com/tern-status/tern.git' }
$Dir     = if ($env:TERN_DIR)  { $env:TERN_DIR }  else { 'tern' }

function Say  { param($m) Write-Host '==> ' -ForegroundColor Cyan -NoNewline; Write-Host $m }
function Note { param($m) Write-Host "    $m" -ForegroundColor DarkGray }
function Die  { param($m) Write-Host "==> $m" -ForegroundColor Red; exit 1 }

# --- prerequisites -----------------------------------------------------------
# Reported together so a missing toolchain costs one message, not three runs.
$missing = @('git', 'docker', 'node') | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
if ($missing) { Die "Manquant : $($missing -join ', ') — installez-les puis relancez." }

docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Die 'Docker Compose v2 est requis, et Docker Desktop doit tourner.' }

$nodeMajor = [int](node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 22) { Die "Node 22+ requis, trouvé $(node -v)." }

# --- clone -------------------------------------------------------------------
if ((Test-Path package.json) -and (Test-Path packages/db)) {
  Say 'Dépôt déjà présent, on reste ici.'
} elseif (Test-Path $Dir) {
  Say "$Dir existe déjà, on l'utilise."
  Set-Location $Dir
} else {
  Say "Clonage de $RepoUrl"
  git clone --depth 1 $RepoUrl $Dir
  if ($LASTEXITCODE -ne 0) { Die 'Le clonage a échoué.' }
  Set-Location $Dir
}

# --- secret ------------------------------------------------------------------
if (Test-Path .env) {
  Say '.env déjà présent, laissé tel quel.'
} else {
  Say 'Création de .env avec un APP_SECRET neuf'
  Copy-Item .env.example .env

  # 32 bytes from the OS CSPRNG — not Get-Random, which is not cryptographic.
  $bytes = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $secret = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''

  # UTF8NoBOM: a BOM on the first line would land inside the first key name and
  # the app would never see the variable it is looking for.
  (Get-Content .env) -replace '^APP_SECRET=.*', "APP_SECRET=$secret" |
    Set-Content .env -Encoding utf8NoBOM
  Note 'secret généré localement, jamais transmis'
}

# --- database ----------------------------------------------------------------
# `--wait` honours the healthcheck the compose file declares; without it the
# migration runs before Postgres accepts connections.
Say 'Démarrage de PostgreSQL, TimescaleDB et MailHog'
docker compose up -d --wait
if ($LASTEXITCODE -ne 0) {
  docker compose up -d
  if ($LASTEXITCODE -ne 0) { Die 'Docker Compose a échoué.' }
  Say 'Attente de la base'
  $i = 0
  while ($true) {
    docker compose exec -T db pg_isready -U tern -d tern -q *> $null
    if ($LASTEXITCODE -eq 0) { break }
    if (++$i -ge 60) { Die "La base n'a pas répondu en 60 s. Voir : docker compose logs db" }
    Start-Sleep -Seconds 1
  }
}

# --- application -------------------------------------------------------------
Say 'Installation des dépendances'
corepack enable *> $null
pnpm install
if ($LASTEXITCODE -ne 0) { Die 'pnpm install a échoué.' }

Say 'Migrations'
pnpm db:migrate
if ($LASTEXITCODE -ne 0) { Die 'La migration a échoué.' }

Say 'Données de démonstration (environ deux minutes)'
pnpm db:seed
if ($LASTEXITCODE -ne 0) { Die 'Le seed a échoué.' }

Write-Host ''
Write-Host 'Prêt.' -ForegroundColor Green
Write-Host '    Page publique    http://localhost:5173/s/acme'
Write-Host '    Administration   http://localhost:5173/app/acme'
Write-Host '    Boîte mail       http://localhost:8025'
Write-Host ''

Say 'Lancement (Ctrl+C pour arrêter)'
pnpm dev
