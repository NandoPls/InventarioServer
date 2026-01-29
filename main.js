const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const { autoUpdater } = require('electron-updater');

let mainWindow;
let serverProcess = null;
let hotspotActivo = false;
let hotspotConfig = { nombre: 'InventarioWiFi', password: 'inventario123' };

// ============================================
// AUTO-UPDATER CONFIG
// ============================================
autoUpdater.autoDownload = false; // No descargar automáticamente
autoUpdater.autoInstallOnAppQuit = true;

// Obtener versión actual
const appVersion = require('./package.json').version;

// Obtener IP local (prioriza IP del hotspot)
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    let hotspotIP = null;
    let regularIP = null;

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                // IP típica del hotspot de Windows (192.168.137.x)
                if (iface.address.startsWith('192.168.137.')) {
                    hotspotIP = iface.address;
                } else if (!regularIP) {
                    regularIP = iface.address;
                }
            }
        }
    }

    // Priorizar IP del hotspot si existe
    return hotspotIP || regularIP || 'localhost';
}

// Obtener todas las IPs disponibles
function getAllIPs() {
    const interfaces = os.networkInterfaces();
    const ips = [];

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push({
                    name: name,
                    address: iface.address,
                    isHotspot: iface.address.startsWith('192.168.137.')
                });
            }
        }
    }

    return ips;
}

function createWindow() {
    // Quitar barra de menú (File, Edit, etc.)
    Menu.setApplicationMenu(null);

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
        try {
            // Ejecutar servidor directamente en el proceso de Electron
            const server = require('./server.js');
            serverProcess = true; // Marcar como activo

            // Esperar a que el servidor inicie y determine el puerto
            // Revisar el estado cada 200ms hasta 5 segundos máximo
            let attempts = 0;
            const maxAttempts = 25; // 5 segundos máximo

            const checkStatus = () => {
                attempts++;
                const status = server.serverStatus;

                if (status.running) {
                    // Servidor iniciado correctamente
                    const ip = getLocalIP();
                    const port = status.port;
                    const portSuffix = port === 80 ? '' : `:${port}`;

                    resolve({
                        success: true,
                        ip: ip,
                        port: port,
                        dashboardUrl: `http://${ip}${portSuffix}`,
                        scannerUrl: `http://${ip}${portSuffix}/scanner.html`
                    });
                } else if (status.error) {
                    // Error al iniciar
                    serverProcess = null;
                    resolve({
                        success: false,
                        error: status.error
                    });
                } else if (attempts >= maxAttempts) {
                    // Timeout
                    serverProcess = null;
                    resolve({
                        success: false,
                        error: 'Timeout al iniciar el servidor'
                    });
                } else {
                    // Seguir esperando
                    setTimeout(checkStatus, 200);
                }
            };

            setTimeout(checkStatus, 500); // Primera verificación después de 500ms
        } catch (err) {
            console.error('Failed to start server:', err);
            serverProcess = null;
            resolve({ success: false, error: err.message });
        }
    });
});

// Detener servidor
ipcMain.handle('stop-server', async () => {
    if (serverProcess) {
        // El servidor corre en el mismo proceso, no se puede detener individualmente
        // Solo marcamos como no activo
        serverProcess = null;
        return { success: true, message: 'Para detener completamente, cierra la aplicación' };
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
// HOTSPOT WIFI (Windows 10/11)
// ============================================

// Estado del hotspot
ipcMain.handle('hotspot-status', async () => {
    return {
        activo: hotspotActivo,
        nombre: hotspotConfig.nombre,
        password: hotspotConfig.password,
        ip: getLocalIP(),
        allIPs: getAllIPs(),
        plataforma: process.platform
    };
});

// Abrir configuración de Mobile Hotspot de Windows
ipcMain.handle('hotspot-abrir-config', async () => {
    if (process.platform !== 'win32') {
        return { ok: false, error: 'Solo disponible en Windows' };
    }

    return new Promise((resolve) => {
        // Abrir la configuración de Mobile Hotspot de Windows
        exec('start ms-settings:network-mobilehotspot', (err) => {
            if (err) {
                console.error('Error abriendo configuración:', err.message);
                resolve({ ok: false, error: 'No se pudo abrir la configuración' });
                return;
            }
            resolve({ ok: true });
        });
    });
});

// Mantener compatibilidad con hotspot-crear (ahora abre config)
ipcMain.handle('hotspot-crear', async (event, { nombre, password }) => {
    if (process.platform !== 'win32') {
        return { ok: false, error: 'Solo disponible en Windows' };
    }

    // Abrir configuración de Windows para que el usuario active manualmente
    return new Promise((resolve) => {
        exec('start ms-settings:network-mobilehotspot', (err) => {
            if (err) {
                resolve({ ok: false, error: 'No se pudo abrir la configuración' });
                return;
            }
            resolve({ ok: true, abrioConfig: true });
        });
    });
});

// Detener hotspot (abre config para que el usuario lo desactive)
ipcMain.handle('hotspot-detener', async () => {
    if (process.platform !== 'win32') {
        return { ok: false, error: 'Solo disponible en Windows' };
    }

    return new Promise((resolve) => {
        exec('start ms-settings:network-mobilehotspot', (err) => {
            hotspotActivo = false;
            resolve({ ok: true });
        });
    });
});

// ============================================
// AUTO-UPDATER EVENTS
// ============================================
autoUpdater.on('checking-for-update', () => {
    console.log('Verificando actualizaciones...');
    if (mainWindow) {
        mainWindow.webContents.send('update-status', { status: 'checking' });
    }
});

autoUpdater.on('update-available', (info) => {
    console.log('Actualización disponible:', info.version);
    if (mainWindow) {
        mainWindow.webContents.send('update-status', {
            status: 'available',
            version: info.version,
            currentVersion: appVersion
        });
    }
});

autoUpdater.on('update-not-available', () => {
    console.log('No hay actualizaciones disponibles');
    if (mainWindow) {
        mainWindow.webContents.send('update-status', { status: 'not-available' });
    }
});

autoUpdater.on('download-progress', (progress) => {
    console.log(`Descargando: ${Math.round(progress.percent)}%`);
    if (mainWindow) {
        mainWindow.webContents.send('update-status', {
            status: 'downloading',
            percent: Math.round(progress.percent)
        });
    }
});

autoUpdater.on('update-downloaded', (info) => {
    console.log('Actualización descargada, lista para instalar');
    if (mainWindow) {
        mainWindow.webContents.send('update-status', {
            status: 'downloaded',
            version: info.version
        });
    }
});

autoUpdater.on('error', (err) => {
    console.error('Error en auto-updater:', err.message);
    if (mainWindow) {
        mainWindow.webContents.send('update-status', {
            status: 'error',
            error: err.message
        });
    }
});

// IPC handlers para actualizaciones
ipcMain.handle('check-for-updates', async () => {
    try {
        await autoUpdater.checkForUpdates();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('download-update', async () => {
    try {
        await autoUpdater.downloadUpdate();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('install-update', async () => {
    autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('get-version', async () => {
    return appVersion;
});

// ============================================
// BACKUP DE BASE DE DATOS
// ============================================

// Referencia a la base de datos
let dbModule = null;

async function ensureDbReady() {
    if (!dbModule) {
        dbModule = require('./database');
        if (!dbModule.isReady()) {
            await dbModule.initDatabase();
        }
    }
    return dbModule;
}

ipcMain.handle('backup-database', async () => {
    try {
        const database = await ensureDbReady();

        if (!database.isReady()) {
            return { ok: false, error: 'Base de datos no inicializada' };
        }

        const dbPath = database.obtenerRutaDB();

        // Mostrar diálogo para seleccionar ubicación
        const result = await dialog.showSaveDialog(mainWindow, {
            title: 'Guardar Backup de Base de Datos',
            defaultPath: `inventario-backup-${new Date().toISOString().slice(0, 10)}.db`,
            filters: [
                { name: 'Base de Datos SQLite', extensions: ['db'] },
                { name: 'Todos los archivos', extensions: ['*'] }
            ]
        });

        if (result.canceled || !result.filePath) {
            return { ok: false, canceled: true };
        }

        const backupResult = database.crearBackup(result.filePath);

        if (backupResult.ok) {
            return { ok: true, ruta: result.filePath };
        } else {
            return { ok: false, error: backupResult.error };
        }
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

// Obtener ruta de la base de datos
ipcMain.handle('get-database-path', async () => {
    try {
        const database = await ensureDbReady();
        return database.obtenerRutaDB();
    } catch (err) {
        return null;
    }
});

app.whenReady().then(() => {
    createWindow();

    // Verificar actualizaciones después de 5 segundos
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err => {
            console.log('No se pudo verificar actualizaciones:', err.message);
        });
    }, 5000);
});

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Cleanup al cerrar
app.on('before-quit', () => {
    // Cleanup si es necesario
});
