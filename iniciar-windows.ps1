# =============================================
# SERVIDOR DE INVENTARIO - WINDOWS (PowerShell)
# Ejecutar como Administrador
# =============================================

$Host.UI.RawUI.WindowTitle = "Servidor de Inventario"

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║       SERVIDOR DE INVENTARIO - WINDOWS                     ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Verificar permisos de administrador
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "[!] Este script necesita permisos de administrador." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "    Click derecho > Ejecutar con PowerShell como administrador"
    Write-Host ""
    Read-Host "Presiona Enter para salir"
    exit
}

# Ir al directorio del script
Set-Location $PSScriptRoot

# Verificar Node.js
try {
    $nodeVersion = node --version
    Write-Host "[OK] Node.js instalado: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Node.js no está instalado." -ForegroundColor Red
    Write-Host "        Descárgalo de: https://nodejs.org"
    Read-Host "Presiona Enter para salir"
    exit
}

# Instalar dependencias si es necesario
if (-not (Test-Path "node_modules")) {
    Write-Host "[*] Instalando dependencias..." -ForegroundColor Yellow
    npm install
}

Write-Host ""
Write-Host "¿Deseas crear un Hotspot WiFi?" -ForegroundColor Yellow
Write-Host ""
Write-Host "  [1] Si, crear hotspot automaticamente"
Write-Host "  [2] No, ya tengo WiFi"
Write-Host ""
$opcion = Read-Host "Selecciona (1 o 2)"

$hotspotCreado = $false

if ($opcion -eq "1") {
    Write-Host ""
    Write-Host "[*] Configurando Mobile Hotspot..." -ForegroundColor Cyan

    try {
        # Usar la API de Windows para Mobile Hotspot (Windows 10+)
        [Windows.System.Profile.AnalyticsInfo, Windows.System.Profile, ContentType=WindowsRuntime] | Out-Null
        Add-Type -AssemblyName System.Runtime.WindowsRuntime

        # Acceder al tetering manager
        $connectionProfile = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType=WindowsRuntime]::GetInternetConnectionProfile()

        if ($connectionProfile -eq $null) {
            Write-Host "[!] No hay conexión a Internet activa." -ForegroundColor Yellow
            Write-Host "    El hotspot necesita compartir alguna conexión."
            Write-Host ""
            Write-Host "    Alternativa: Usa 'Zona con cobertura inalambrica movil' en Configuración"
        } else {
            # Intentar con netsh como fallback
            Write-Host "[*] Intentando crear hotspot con netsh..." -ForegroundColor Cyan

            netsh wlan stop hostednetwork 2>$null
            $result = netsh wlan set hostednetwork mode=allow ssid=InventarioWiFi key=inventario123 2>&1

            if ($LASTEXITCODE -eq 0) {
                netsh wlan start hostednetwork
                if ($LASTEXITCODE -eq 0) {
                    $hotspotCreado = $true
                    Write-Host "[OK] Hotspot creado: InventarioWiFi" -ForegroundColor Green
                    Write-Host "     Contraseña: inventario123" -ForegroundColor Green
                }
            }

            if (-not $hotspotCreado) {
                Write-Host ""
                Write-Host "[!] No se pudo crear hotspot automaticamente." -ForegroundColor Yellow
                Write-Host ""
                Write-Host "    Crealo manualmente:" -ForegroundColor Cyan
                Write-Host "    1. Configuracion > Red e Internet > Zona con cobertura inalambrica movil"
                Write-Host "    2. Activa el interruptor"
                Write-Host "    3. Red: InventarioWiFi | Clave: inventario123"
                Write-Host ""
                Write-Host "    Presiona Enter cuando el hotspot esté activo..."
                Read-Host
            }
        }
    } catch {
        Write-Host "[!] Error configurando hotspot: $_" -ForegroundColor Red
    }
}

# Obtener IP
Write-Host ""
Write-Host "[*] Obteniendo dirección IP..." -ForegroundColor Cyan

$IP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch "Loopback" -and $_.IPAddress -notmatch "^169\." } | Select-Object -First 1).IPAddress

if (-not $IP) {
    $IP = "localhost"
}

# Matar procesos anteriores
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Clear-Host
Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║          SERVIDOR DE INVENTARIO ACTIVO                     ║" -ForegroundColor Green
Write-Host "╠════════════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║                                                            ║" -ForegroundColor Green
Write-Host "║  Dashboard:  http://${IP}:3000                             " -ForegroundColor White
Write-Host "║  Escaner:    http://${IP}:3000/scanner.html                " -ForegroundColor White
Write-Host "║                                                            ║" -ForegroundColor Green
if ($hotspotCreado -or $opcion -eq "1") {
Write-Host "╠════════════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║  WiFi: InventarioWiFi  |  Clave: inventario123             ║" -ForegroundColor Yellow
}
Write-Host "╠════════════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║  Presiona Ctrl+C para detener                              ║" -ForegroundColor Green
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

# Iniciar servidor
try {
    node server.js
} finally {
    # Cleanup
    if ($hotspotCreado) {
        Write-Host ""
        Write-Host "[*] Deteniendo hotspot..." -ForegroundColor Yellow
        netsh wlan stop hostednetwork 2>$null
    }
    Write-Host "[*] Servidor detenido." -ForegroundColor Yellow
}
