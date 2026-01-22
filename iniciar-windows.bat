@echo off
chcp 65001 >nul
title Servidor de Inventario

echo.
echo ╔════════════════════════════════════════════════════════════╗
echo ║       SERVIDOR DE INVENTARIO - WINDOWS                     ║
echo ╚════════════════════════════════════════════════════════════╝
echo.

:: Verificar si se ejecuta como administrador
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] Este script necesita permisos de administrador para crear el hotspot.
    echo.
    echo     Click derecho en este archivo ^> "Ejecutar como administrador"
    echo.
    pause
    exit /b 1
)

:: Ir al directorio del script
cd /d "%~dp0"

:: Verificar Node.js
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo [ERROR] Node.js no está instalado.
    echo         Descárgalo de: https://nodejs.org
    pause
    exit /b 1
)

:: Verificar dependencias
if not exist "node_modules" (
    echo [*] Instalando dependencias...
    call npm install
)

echo.
echo ¿Deseas crear un Hotspot WiFi para que los teléfonos se conecten?
echo.
echo   [1] Si, crear hotspot "InventarioWiFi" (contraseña: inventario123)
echo   [2] No, ya tengo WiFi o lo configuraré manualmente
echo.
set /p opcion="Selecciona opción (1 o 2): "

if "%opcion%"=="1" (
    echo.
    echo [*] Configurando Hotspot WiFi...

    :: Detener hotspot existente
    netsh wlan stop hostednetwork >nul 2>&1

    :: Configurar nuevo hotspot
    netsh wlan set hostednetwork mode=allow ssid=InventarioWiFi key=inventario123 >nul 2>&1

    if %errorLevel% neq 0 (
        echo.
        echo [!] No se pudo crear el hotspot con netsh.
        echo     Tu versión de Windows puede requerir usar "Zona con cobertura inalámbrica móvil"
        echo.
        echo     Pasos manuales:
        echo     1. Configuración ^> Red e Internet ^> Zona con cobertura inalámbrica móvil
        echo     2. Activar "Compartir mi conexión a Internet..."
        echo     3. Nombre de red: InventarioWiFi
        echo     4. Contraseña: inventario123
        echo.
        goto :start_server
    )

    :: Iniciar hotspot
    netsh wlan start hostednetwork

    if %errorLevel% equ 0 (
        echo [OK] Hotspot "InventarioWiFi" creado
        echo      Contraseña: inventario123
    ) else (
        echo [!] Error al iniciar hotspot. Verifica que el adaptador WiFi soporte modo AP.
    )
)

:start_server
echo.
echo [*] Iniciando servidor...
echo.

:: Obtener IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4" ^| findstr /v "127.0.0.1"') do (
    set IP=%%a
    goto :found_ip
)
set IP=localhost
:found_ip
:: Limpiar espacios
set IP=%IP: =%

:: Matar proceso anterior si existe
taskkill /f /im node.exe >nul 2>&1

timeout /t 2 >nul

cls
echo.
echo ╔════════════════════════════════════════════════════════════╗
echo ║          SERVIDOR DE INVENTARIO ACTIVO                     ║
echo ╠════════════════════════════════════════════════════════════╣
echo ║                                                            ║
echo ║  Dashboard:  http://%IP%:3000
echo ║  Escáner:    http://%IP%:3000/scanner.html
echo ║                                                            ║
echo ╠════════════════════════════════════════════════════════════╣
echo ║  Red WiFi: InventarioWiFi                                  ║
echo ║  Contraseña: inventario123                                 ║
echo ╠════════════════════════════════════════════════════════════╣
echo ║  Presiona Ctrl+C para detener el servidor                  ║
echo ╚════════════════════════════════════════════════════════════╝
echo.

:: Iniciar servidor con auto-reinicio para actualizaciones
:server_loop
node server.js
set EXIT_CODE=%errorlevel%

:: Si el servidor terminó con código 0, es una actualización - reiniciar
if %EXIT_CODE% equ 0 (
    echo.
    echo [*] Reiniciando servidor tras actualización...
    timeout /t 3 >nul
    goto :server_loop
)

:: Si llegamos aquí, el servidor se detuvo con error o Ctrl+C
echo.
echo [*] Servidor detenido.

:: Detener hotspot si estaba activo
if "%opcion%"=="1" (
    netsh wlan stop hostednetwork >nul 2>&1
)

pause
