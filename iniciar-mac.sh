#!/bin/bash

# =============================================
# SERVIDOR DE INVENTARIO - MAC
# =============================================

clear
echo "╔════════════════════════════════════════════════════════════╗"
echo "║       SERVIDOR DE INVENTARIO - CONFIGURACIÓN               ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Directorio del script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Verificar Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js no está instalado${NC}"
    echo "Instálalo desde: https://nodejs.org"
    exit 1
fi

# Verificar dependencias
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Instalando dependencias...${NC}"
    npm install
fi

# Función para obtener IP
get_ip() {
    # Intentar obtener IP de diferentes interfaces
    IP=$(ipconfig getifaddr en0 2>/dev/null)
    if [ -z "$IP" ]; then
        IP=$(ipconfig getifaddr en1 2>/dev/null)
    fi
    if [ -z "$IP" ]; then
        IP=$(ipconfig getifaddr bridge100 2>/dev/null)  # IP cuando hay hotspot activo
    fi
    echo "$IP"
}

# Verificar si hay hotspot activo
check_hotspot() {
    # Verificar si Internet Sharing está activo
    if pgrep -x "InternetSharing" > /dev/null 2>&1; then
        return 0
    fi
    # Verificar interfaz bridge100 (creada por Internet Sharing)
    if ifconfig bridge100 &> /dev/null; then
        return 0
    fi
    return 1
}

echo ""
echo -e "${BLUE}Verificando conexión de red...${NC}"
echo ""

IP=$(get_ip)

if check_hotspot; then
    echo -e "${GREEN}✓ Hotspot WiFi detectado${NC}"
    # Obtener IP del hotspot
    HOTSPOT_IP=$(ipconfig getifaddr bridge100 2>/dev/null)
    if [ -n "$HOTSPOT_IP" ]; then
        IP=$HOTSPOT_IP
    fi
elif [ -n "$IP" ]; then
    echo -e "${GREEN}✓ Conectado a red WiFi${NC}"
else
    echo -e "${YELLOW}⚠ No hay conexión de red${NC}"
    echo ""
    echo "Para crear un Hotspot WiFi en Mac:"
    echo ""
    echo "  1. Abre Preferencias del Sistema > Compartir"
    echo "  2. Selecciona 'Compartir Internet'"
    echo "  3. Compartir desde: tu conexión (Ethernet, USB iPhone, etc.)"
    echo "  4. A equipos que usen: Wi-Fi"
    echo "  5. Click en 'Opciones de Wi-Fi' para configurar nombre y contraseña"
    echo "  6. Activa la casilla 'Compartir Internet'"
    echo ""
    echo -e "${YELLOW}¿Deseas intentar crear el hotspot automáticamente? (requiere contraseña)${NC}"
    echo "Esto creará una red llamada 'InventarioWiFi'"
    echo ""
    read -p "Crear hotspot? (s/n): " respuesta

    if [ "$respuesta" = "s" ] || [ "$respuesta" = "S" ]; then
        echo ""
        echo "Creando hotspot WiFi..."

        # Crear archivo de configuración temporal
        PLIST="/Library/Preferences/SystemConfiguration/com.apple.nat.plist"

        # Necesitamos sudo para esto
        sudo bash -c "cat > /tmp/internet_sharing.plist << 'EOF'
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
    <key>NAT</key>
    <dict>
        <key>AirPort</key>
        <dict>
            <key>40BitEncrypt</key>
            <integer>0</integer>
            <key>Channel</key>
            <integer>6</integer>
            <key>Enabled</key>
            <integer>1</integer>
            <key>NetworkName</key>
            <string>InventarioWiFi</string>
            <key>NetworkPassword</key>
            <data>aW52ZW50YXJpbzEyMw==</data>
            <key>WPAKey</key>
            <string>inventario123</string>
        </dict>
        <key>Enabled</key>
        <integer>1</integer>
        <key>PrimaryInterface</key>
        <dict>
            <key>Device</key>
            <string>en0</string>
            <key>Enabled</key>
            <integer>0</integer>
        </dict>
    </dict>
</dict>
</plist>
EOF"

        echo ""
        echo -e "${YELLOW}Nota: La creación automática de hotspot en Mac es limitada.${NC}"
        echo "Es más confiable hacerlo manualmente desde Preferencias del Sistema."
        echo ""
        echo "Continuando sin hotspot..."
    fi

    IP="localhost"
fi

# Matar proceso anterior si existe
pkill -f "node server.js" 2>/dev/null
sleep 1

echo ""
echo -e "${BLUE}Iniciando servidor...${NC}"
echo ""

# Iniciar servidor
node server.js &
SERVER_PID=$!

sleep 2

# Verificar que el servidor inició
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo -e "${RED}Error: El servidor no pudo iniciar${NC}"
    exit 1
fi

# Obtener IP actualizada
IP=$(get_ip)
if [ -z "$IP" ]; then
    IP="localhost"
fi

clear
echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║          SERVIDOR DE INVENTARIO ACTIVO                     ║"
echo "╠════════════════════════════════════════════════════════════╣"
echo "║                                                            ║"
echo -e "║  ${GREEN}Dashboard:${NC}  http://$IP:3000                         "
echo -e "║  ${GREEN}Escáner:${NC}    http://$IP:3000/scanner.html            "
echo "║                                                            ║"
echo "╠════════════════════════════════════════════════════════════╣"
echo "║  Los teléfonos deben conectarse a la misma red WiFi       ║"
echo "║  y abrir la dirección del Escáner en su navegador         ║"
echo "╠════════════════════════════════════════════════════════════╣"
echo "║  Presiona Ctrl+C para detener el servidor                 ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Manejar Ctrl+C
trap "echo ''; echo 'Deteniendo servidor...'; kill $SERVER_PID 2>/dev/null; exit 0" INT

# Mantener el script corriendo
wait $SERVER_PID
