$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

Write-Host "[1/3] Building Equicord (standalone, so the in-app updater checks GitHub releases)..." -ForegroundColor Cyan
Push-Location $Root
pnpm buildStandalone
Pop-Location

Write-Host "[2/3] Installing installer dependencies..." -ForegroundColor Cyan
Push-Location "$Root\installer-src"
if (-not (Test-Path node_modules)) { npm install }

Write-Host "[3/3] Packaging Equicord-Installer.exe..." -ForegroundColor Cyan
npm run dist
Pop-Location

$exe = "$Root\installer-src\release\Equicord-Installer.exe"
if (Test-Path $exe) {
    Write-Host ""
    Write-Host "Done: $exe" -ForegroundColor Green
} else {
    Write-Host "Build failed, exe not found." -ForegroundColor Red
    exit 1
}
