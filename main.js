const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const os = require('os');

let mainWindow;
let serverProcess = null;
let hotspotActivo = false;
let hotspotConfig = { nombre: 'InventarioWiFi', password: 'inventario123' };

// Obtener IP local
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 500,
        height: 700,
        resizable: false,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        },
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#0f172a'
    });

    mainWindow.loadFile('gui/index.html');

    // Abrir links externos en el navegador
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

// Iniciar servidor
ipcMain.handle('start-server', async () => {
    if (serverProcess) {
        return { success: false, error: 'El servidor ya está corriendo' };
    }

    return new Promise((resolve) => {
        const serverPath = path.join(__dirname, 'server.js');
        serverProcess = spawn('node', [serverPath], {
            cwd: __dirname,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let started = false;

        serverProcess.stdout.on('data', (data) => {
            const output = data.toString();
            console.log('Server:', output);

            if (!started && output.includes('SERVIDOR DE INVENTARIO INICIADO')) {
                started = true;
                const ip = getLocalIP();
                resolve({
                    success: true,
                    ip: ip,
                    dashboardUrl: `http://${ip}:3000`,
                    scannerUrl: `http://${ip}:3000/scanner.html`
                });
            }

            // Enviar output a la ventana
            if (mainWindow) {
                mainWindow.webContents.send('server-log', output);
            }
        });

        serverProcess.stderr.on('data', (data) => {
            console.error('Server Error:', data.toString());
            if (!started) {
                resolve({ success: false, error: data.toString() });
            }
        });

        serverProcess.on('error', (err) => {
            console.error('Failed to start server:', err);
            serverProcess = null;
            if (!started) {
                resolve({ success: false, error: err.message });
            }
        });

        serverProcess.on('close', (code) => {
            console.log('Server closed with code:', code);
            serverProcess = null;
            if (mainWindow) {
                mainWindow.webContents.send('server-stopped');
            }
        });

        // Timeout por si no inicia
        setTimeout(() => {
            if (!started) {
                const ip = getLocalIP();
                resolve({
                    success: true,
                    ip: ip,
                    dashboardUrl: `http://${ip}:3000`,
                    scannerUrl: `http://${ip}:3000/scanner.html`
                });
            }
        }, 3000);
    });
});

// Detener servidor
ipcMain.handle('stop-server', async () => {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
        return { success: true };
    }
    return { success: false, error: 'El servidor no está corriendo' };
});

// Obtener IP
ipcMain.handle('get-ip', async () => {
    return getLocalIP();
});

// Abrir URL en navegador
ipcMain.handle('open-url', async (event, url) => {
    shell.openExternal(url);
});

// Verificar estado del servidor
ipcMain.handle('server-status', async () => {
    return { running: serverProcess !== null };
});

// ============================================
// HOTSPOT WIFI (Solo Windows)
// ============================================

// Estado del hotspot
ipcMain.handle('hotspot-status', async () => {
    return {
        activo: hotspotActivo,
        nombre: hotspotConfig.nombre,
        password: hotspotConfig.password,
        ip: getLocalIP(),
        plataforma: process.platform
    };
});

// Crear hotspot
ipcMain.handle('hotspot-crear', async (event, { nombre, password }) => {
    if (process.platform !== 'win32') {
        return { ok: false, error: 'Solo disponible en Windows' };
    }

    if (!nombre || password.length < 8) {
        return { ok: false, error: 'Contraseña mínimo 8 caracteres' };
    }

    hotspotConfig.nombre = nombre;
    hotspotConfig.password = password;

    return new Promise((resolve) => {
        // Detener hotspot existente
        exec('netsh wlan stop hostednetwork', (err) => {
            // Configurar nuevo hotspot
            const cmd = `netsh wlan set hostednetwork mode=allow ssid="${nombre}" key="${password}"`;
            exec(cmd, (err) => {
                if (err) {
                    console.error('Error configurando hotspot:', err.message);
                    resolve({
                        ok: false,
                        error: 'No se pudo configurar. Ejecuta como Administrador.'
                    });
                    return;
                }

                // Iniciar hotspot
                exec('netsh wlan start hostednetwork', (err, stdout) => {
                    if (err) {
                        console.error('Error iniciando hotspot:', err.message);
                        resolve({
                            ok: false,
                            error: 'Tu adaptador WiFi puede no soportar modo AP.'
                        });
                        return;
                    }

                    hotspotActivo = true;
                    console.log(`Hotspot "${nombre}" creado`);
                    resolve({ ok: true });
                });
            });
        });
    });
});

// Detener hotspot
ipcMain.handle('hotspot-detener', async () => {
    if (process.platform !== 'win32') {
        return { ok: false, error: 'Solo disponible en Windows' };
    }

    return new Promise((resolve) => {
        exec('netsh wlan stop hostednetwork', (err) => {
            hotspotActivo = false;
            resolve({ ok: true });
        });
    });
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (serverProcess) {
        serverProcess.kill();
    }
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Cleanup al cerrar
app.on('before-quit', () => {
    if (serverProcess) {
        serverProcess.kill();
    }
    // Detener hotspot si estaba activo
    if (hotspotActivo && process.platform === 'win32') {
        exec('netsh wlan stop hostednetwork');
    }
});
