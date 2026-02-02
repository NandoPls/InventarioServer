const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const os = require('os');
const dgram = require('dgram');  // Para UDP discovery

// Base de datos SQLite (se inicializa de forma asíncrona)
const database = require('./database');
let dbReady = false;

// Inicializar base de datos
database.initDatabase().then(() => {
    dbReady = true;
    console.log('Base de datos lista');
    // Cargar estado de sesión anterior
    cargarEstadoDesdeDB();
}).catch(err => {
    console.error('Error inicializando base de datos:', err);
});

// Determinar carpeta de datos (fuera del ASAR en producción)
function getDataDir() {
    // Si estamos en un ASAR, usar carpeta en el home del usuario
    if (__dirname.includes('.asar')) {
        const dataDir = path.join(os.homedir(), '.inventario-server', 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        return dataDir;
    }
    // En desarrollo, usar carpeta local
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    return dataDir;
}

const DATA_DIR = getDataDir();

// ============================================
// SISTEMA DE AUTO-UPDATE (solo en modo desarrollo)
// ============================================
let updateDisponible = false;
let versionLocal = '';
let versionRemota = '';
const esProduccion = __dirname.includes('.asar');

function verificarActualizaciones() {
    // No verificar actualizaciones git en modo producción (ASAR)
    if (esProduccion) return;

    exec('git fetch origin main', { cwd: __dirname }, (err) => {
        if (err) {
            console.log('Error al verificar actualizaciones:', err.message);
            return;
        }

        // Obtener commit local
        exec('git rev-parse HEAD', { cwd: __dirname }, (err, localCommit) => {
            if (err) return;
            versionLocal = localCommit.trim().substring(0, 7);

            // Obtener commit remoto
            exec('git rev-parse origin/main', { cwd: __dirname }, (err, remoteCommit) => {
                if (err) return;
                versionRemota = remoteCommit.trim().substring(0, 7);

                const hayUpdate = localCommit.trim() !== remoteCommit.trim();

                if (hayUpdate && !updateDisponible) {
                    console.log(`Nueva versión disponible: ${versionRemota} (actual: ${versionLocal})`);
                    updateDisponible = true;
                    // Notificar a todos los clientes
                    broadcast({
                        tipo: 'update_disponible',
                        data: { versionLocal, versionRemota }
                    });
                } else if (!hayUpdate && updateDisponible) {
                    updateDisponible = false;
                }
            });
        });
    });
}

// Solo verificar actualizaciones en modo desarrollo
if (!esProduccion) {
    setInterval(verificarActualizaciones, 2 * 60 * 1000);
    setTimeout(verificarActualizaciones, 10000);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Puertos a intentar (en orden de preferencia)
const PORTS_TO_TRY = [80, 8080, 3000];
let PORT = 3000; // Puerto por defecto, se actualizará

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configurar multer para subida de archivos
const uploadsDir = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
const upload = multer({ dest: uploadsDir });

// ============================================
// ESTADO GLOBAL
// ============================================

let estado = {
    sesionActiva: null,
    maestro: [],
    stockTienda: [],    // Stock esperado: { ean, codigo, descripcion, cantidad, costo }
    escaneres: {},      // { id: { nombre, zonaActual, items: [], conectado } }
    zonas: {},          // { zonaId: { nombre, escaner, items: [], cerrada } }
    todosLosItems: []   // Todos los items escaneados
};

// Cargar estado desde base de datos (se ejecuta después de que db esté lista)
function cargarEstadoDesdeDB() {
    try {
        const saved = database.cargarEstadoSesion();
        if (saved) {
            estado = {
                sesionActiva: saved.sesionActiva || null,
                maestro: saved.maestro || [],
                stockTienda: saved.stockTienda || [],
                escaneres: saved.escaneres || {},
                zonas: saved.zonas || {},
                todosLosItems: saved.todosLosItems || []
            };

            console.log('╔════════════════════════════════════════════════════════════╗');
            console.log('║  ESTADO ANTERIOR CARGADO DESDE DB                          ║');
            console.log('╠════════════════════════════════════════════════════════════╣');
            console.log(`║  Sesión activa: ${estado.sesionActiva ? estado.sesionActiva.nombre : 'Ninguna'}`);
            console.log(`║  Maestro: ${estado.maestro.length} productos`);
            console.log(`║  Stock Tienda: ${estado.stockTienda.length} items`);
            console.log(`║  Zonas: ${Object.keys(estado.zonas).length}`);
            console.log(`║  Items escaneados: ${estado.todosLosItems.length}`);
            console.log('╚════════════════════════════════════════════════════════════╝');
        } else {
            console.log('Sin estado previo en DB, iniciando limpio');
        }
    } catch (e) {
        console.log('No se pudo cargar estado anterior:', e.message);
    }
}

// Guardar estado en base de datos
function guardarEstado() {
    try {
        if (!database.isReady()) return;

        // Crear copia limpia del estado (sin WebSockets)
        const escaneresLimpios = {};
        for (const [id, esc] of Object.entries(estado.escaneres)) {
            escaneresLimpios[id] = {
                id: esc.id,
                nombre: esc.nombre,
                nombreNormalizado: esc.nombreNormalizado,
                zonaActual: esc.zonaActual,
                items: esc.items || [],
                conectado: false
            };
        }

        const zonasLimpias = {};
        for (const [id, zona] of Object.entries(estado.zonas)) {
            zonasLimpias[id] = {
                id: zona.id,
                nombre: zona.nombre,
                escaner: zona.escaner,
                creadoPor: zona.creadoPor,
                creadoPorNombre: zona.creadoPorNombre,
                creadoPorNombreNormalizado: zona.creadoPorNombreNormalizado,
                items: zona.items || [],
                cerrada: zona.cerrada,
                fechaInicio: zona.fechaInicio
            };
        }

        const estadoParaGuardar = {
            sesionActiva: estado.sesionActiva,
            maestro: estado.maestro || [],
            stockTienda: estado.stockTienda || [],
            escaneres: escaneresLimpios,
            zonas: zonasLimpias,
            todosLosItems: estado.todosLosItems || []
        };

        const result = database.guardarEstadoSesion(estadoParaGuardar);

        // Log solo si hay datos significativos
        const tieneData = estado.todosLosItems.length || Object.keys(estado.zonas).length;
        if (tieneData && result.ok) {
            console.log(`[DB] Estado guardado: items=${estado.todosLosItems.length}, zonas=${Object.keys(estado.zonas).length}`);
        }
    } catch (e) {
        console.error('Error guardando estado en DB:', e.message);
    }
}

// Guardar estado cada 5 segundos
setInterval(guardarEstado, 5000);

// Guardar estado al cerrar
process.on('exit', guardarEstado);
process.on('SIGINT', () => { guardarEstado(); process.exit(0); });
process.on('SIGTERM', () => { guardarEstado(); process.exit(0); });

// ============================================
// WEBSOCKET - Comunicación en tiempo real
// ============================================

const clientes = new Set();

wss.on('connection', (ws) => {
    clientes.add(ws);
    console.log('Cliente conectado. Total:', clientes.size);

    // Enviar estado actual al nuevo cliente
    ws.send(JSON.stringify({
        tipo: 'estado_inicial',
        data: getResumen()
    }));

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message);
            handleMensajeWS(ws, msg);
        } catch (e) {
            console.error('Error procesando mensaje:', e);
        }
    });

    ws.on('close', () => {
        clientes.delete(ws);
        console.log('Cliente desconectado. Total:', clientes.size);

        // Marcar escáner como desconectado
        if (ws.escanerId && estado.escaneres[ws.escanerId]) {
            estado.escaneres[ws.escanerId].conectado = false;
            console.log(`Escáner ${estado.escaneres[ws.escanerId].nombre} desconectado`);
            broadcast({
                tipo: 'escaner_desconectado',
                data: { id: ws.escanerId, nombre: estado.escaneres[ws.escanerId].nombre }
            });
        }
    });
});

function broadcast(mensaje) {
    const data = JSON.stringify(mensaje);
    clientes.forEach(cliente => {
        if (cliente.readyState === WebSocket.OPEN) {
            cliente.send(data);
        }
    });
}

// Enviar lista de zonas personalizada a cada escáner conectado
function enviarZonasPersonalizadas() {
    clientes.forEach(cliente => {
        if (cliente.readyState === WebSocket.OPEN && cliente.escanerId) {
            const zonasUsuario = getListaZonasUsuario(cliente.escanerId);
            cliente.send(JSON.stringify({
                tipo: 'lista_zonas',
                data: { zonas: zonasUsuario }
            }));
        }
    });
}

function handleMensajeWS(ws, msg) {
    switch (msg.tipo) {
        case 'registrar_escaner':
            registrarEscaner(ws, msg.data);
            break;
        case 'asignar_zona':
            asignarZona(ws, msg.data);
            break;
        case 'escanear':
            procesarEscaneo(ws, msg.data);
            break;
        case 'obtener_estado':
            ws.send(JSON.stringify({ tipo: 'estado', data: getResumen() }));
            break;
        case 'obtener_zonas':
            // Solo enviar las zonas del usuario actual
            const zonasUsuario = getListaZonasUsuario(ws.escanerId);
            ws.send(JSON.stringify({ tipo: 'lista_zonas', data: { zonas: zonasUsuario } }));
            break;
    }
}

function getListaZonas() {
    return Object.values(estado.zonas).map(z => ({
        id: z.id,
        nombre: z.nombre,
        totalItems: z.items.reduce((sum, i) => sum + i.cantidad, 0),
        eansUnicos: z.items.length,
        escaner: z.escaner ? estado.escaneres[z.escaner]?.nombre : null,
        creadoPor: z.creadoPor
    }));
}

// Obtener zonas de un usuario específico (por nombre de usuario normalizado)
function getListaZonasUsuario(escanerId) {
    if (!escanerId) return [];

    // Obtener el nombre del escáner
    const escaner = estado.escaneres[escanerId];
    if (!escaner) return [];

    // Usar nombre normalizado para comparar
    const nombreNormalizado = escaner.nombreNormalizado || normalizarNombre(escaner.nombre);

    return Object.values(estado.zonas)
        .filter(z => {
            const zonaNombreNorm = z.creadoPorNombreNormalizado || normalizarNombre(z.creadoPorNombre || '');
            return zonaNombreNorm === nombreNormalizado;
        })
        .map(z => ({
            id: z.id,
            nombre: z.nombre,
            totalItems: z.items.reduce((sum, i) => sum + i.cantidad, 0),
            eansUnicos: z.items.length
        }));
}

// ============================================
// LÓGICA DE NEGOCIO
// ============================================

// Normalizar nombre de usuario (para comparaciones)
function normalizarNombre(nombre) {
    return nombre.toLowerCase().trim();
}

// Capitalizar nombre (para mostrar)
function capitalizarNombre(nombre) {
    return nombre.trim().split(' ').map(p =>
        p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
    ).join(' ');
}

function registrarEscaner(ws, data) {
    const { nombre } = data;
    const id = uuidv4();

    // Normalizar el nombre para consistencia
    const nombreNormalizado = normalizarNombre(nombre);
    const nombreDisplay = capitalizarNombre(nombre);

    estado.escaneres[id] = {
        id,
        nombre: nombreDisplay,           // Nombre para mostrar (capitalizado)
        nombreNormalizado: nombreNormalizado,  // Nombre para comparar (minúsculas)
        zonaActual: null,
        items: [],
        conectado: true,
        ws: ws
    };

    // Asociar ws con escaner
    ws.escanerId = id;

    ws.send(JSON.stringify({
        tipo: 'registrado',
        data: { id, nombre }
    }));

    broadcast({
        tipo: 'escaner_conectado',
        data: { id, nombre }
    });

    guardarEstado();
}

function asignarZona(ws, data) {
    const { escanerId, zonaId, zonaNombre } = data;
    const escaner = estado.escaneres[escanerId];

    if (!escaner) {
        ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Escáner no registrado' }));
        return;
    }

    // Liberar zona anterior si tenía una
    if (escaner.zonaActual && estado.zonas[escaner.zonaActual]) {
        estado.zonas[escaner.zonaActual].escaner = null;
    }

    // Obtener nombres del usuario (display y normalizado)
    const nombreUsuario = escaner.nombre;
    const nombreNormalizado = escaner.nombreNormalizado || normalizarNombre(nombreUsuario);

    // Crear zona si no existe
    if (!estado.zonas[zonaId]) {
        estado.zonas[zonaId] = {
            id: zonaId,
            nombre: zonaNombre || `Zona ${zonaId}`,
            escaner: escanerId,
            creadoPor: escanerId,
            creadoPorNombre: nombreUsuario,  // Nombre para mostrar
            creadoPorNombreNormalizado: nombreNormalizado,  // Nombre para comparar
            items: [],
            cerrada: false,
            fechaInicio: new Date().toISOString()
        };
    } else {
        // Solo permitir asignar si es el mismo usuario (comparar nombres normalizados)
        const zonaNombreNorm = estado.zonas[zonaId].creadoPorNombreNormalizado || normalizarNombre(estado.zonas[zonaId].creadoPorNombre || '');
        if (zonaNombreNorm !== nombreNormalizado) {
            ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Esta zona pertenece a otro auditor' }));
            return;
        }
        estado.zonas[zonaId].escaner = escanerId;
        // Actualizar nombre si se proporciona uno nuevo
        if (zonaNombre) {
            estado.zonas[zonaId].nombre = zonaNombre;
        }
    }

    escaner.zonaActual = zonaId;

    const zona = estado.zonas[zonaId];
    const totalItemsZona = zona.items ? zona.items.reduce((sum, i) => sum + i.cantidad, 0) : 0;
    ws.send(JSON.stringify({
        tipo: 'zona_asignada',
        data: {
            zonaId,
            zonaNombre: zona.nombre,
            totalItems: totalItemsZona
        }
    }));

    // Enviar lista de zonas personalizada a cada escáner
    enviarZonasPersonalizadas();

    // Enviar lista completa al dashboard
    broadcast({
        tipo: 'lista_zonas_dashboard',
        data: { zonas: getListaZonas() }
    });

    broadcast({
        tipo: 'actualizacion',
        data: getResumen()
    });

    guardarEstado();
}

function procesarEscaneo(ws, data) {
    const { escanerId, ean } = data;
    const escaner = estado.escaneres[escanerId];

    if (!escaner) {
        ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Escáner no registrado' }));
        return;
    }

    if (!escaner.zonaActual) {
        ws.send(JSON.stringify({ tipo: 'error', mensaje: 'Primero escanea una zona' }));
        return;
    }

    const zona = estado.zonas[escaner.zonaActual];
    const producto = estado.maestro.find(p => p.ean === ean);

    // Buscar si ya existe el item en esta zona
    let item = zona.items.find(i => i.ean === ean);

    if (item) {
        item.cantidad++;
        item.ultimoEscaneo = new Date().toISOString();
    } else {
        item = {
            id: uuidv4(),
            ean,
            codigo: producto?.codigo || '',
            descripcion: producto?.descripcion || 'NO ENCONTRADO EN MAESTRO',
            cantidad: 1,
            existeEnMaestro: !!producto,
            zonaId: zona.id,
            zonaNombre: zona.nombre,
            escaner: escaner.nombre,
            primerEscaneo: new Date().toISOString(),
            ultimoEscaneo: new Date().toISOString()
        };
        zona.items.unshift(item);
        estado.todosLosItems.unshift(item);
    }

    // También actualizar en items del escaner
    let itemEscaner = escaner.items.find(i => i.ean === ean);
    if (itemEscaner) {
        itemEscaner.cantidad++;
    } else {
        escaner.items.unshift({ ...item });
    }

    ws.send(JSON.stringify({
        tipo: 'escaneo_ok',
        data: {
            item,
            totalZona: zona.items.reduce((sum, i) => sum + i.cantidad, 0),
            totalEscaner: escaner.items.reduce((sum, i) => sum + i.cantidad, 0)
        }
    }));

    broadcast({
        tipo: 'nuevo_escaneo',
        data: {
            item,
            escaner: escaner.nombre,
            zona: zona.nombre,
            resumen: getResumen()
        }
    });

    guardarEstado();
}

// Calcular comparación de inventario (faltantes/sobrantes)
function getComparacion() {
    console.log(`[Comparación] Stock Tienda: ${estado.stockTienda?.length || 0} items, Escaneados: ${estado.todosLosItems?.length || 0} items`);

    if (!estado.stockTienda || estado.stockTienda.length === 0) {
        console.log('[Comparación] No hay stock tienda cargado, retornando vacío');
        return {
            tieneStock: false,
            totalEsperado: 0,
            totalEscaneado: 0,
            progreso: 0,
            faltantes: [],
            sobrantes: [],
            costoFaltante: 0,
            costoSobrante: 0,
            diferenciaCosto: 0,
            eansEsperados: 0,
            eansEscaneados: 0
        };
    }

    // Crear mapa del maestro para buscar costo y descripción
    const maestroMap = {};
    estado.maestro.forEach(item => {
        maestroMap[item.ean] = item;
    });

    // Crear mapa de stock esperado
    const stockMap = {};
    estado.stockTienda.forEach(item => {
        const productoMaestro = maestroMap[item.ean] || {};
        if (!stockMap[item.ean]) {
            stockMap[item.ean] = {
                ean: item.ean,
                codigo: productoMaestro.codigo || '',
                descripcion: productoMaestro.descripcion || 'NO EN MAESTRO',
                costo: productoMaestro.costo || 0,
                cantidadEsperada: item.cantidad
            };
        } else {
            stockMap[item.ean].cantidadEsperada += item.cantidad;
        }
    });

    // Crear mapa de items escaneados
    const escaneadoMap = {};
    estado.todosLosItems.forEach(item => {
        if (!escaneadoMap[item.ean]) {
            escaneadoMap[item.ean] = { ...item, cantidadEscaneada: item.cantidad };
        } else {
            escaneadoMap[item.ean].cantidadEscaneada += item.cantidad;
        }
    });

    const faltantes = [];
    const sobrantes = [];
    let costoFaltante = 0;
    let costoSobrante = 0;
    let totalEsperado = 0;
    let totalEscaneado = 0;

    // Revisar items del stock esperado
    Object.keys(stockMap).forEach(ean => {
        const esperado = stockMap[ean];
        const escaneado = escaneadoMap[ean];
        const cantidadEsperada = esperado.cantidadEsperada;
        const cantidadEscaneada = escaneado ? escaneado.cantidadEscaneada : 0;
        const diferencia = cantidadEscaneada - cantidadEsperada;

        totalEsperado += cantidadEsperada;

        if (diferencia < 0) {
            // Faltante
            const faltante = Math.abs(diferencia);
            const costoUnit = esperado.costo || 0;
            faltantes.push({
                ean,
                codigo: esperado.codigo,
                descripcion: esperado.descripcion,
                cantidadEsperada,
                cantidadEscaneada,
                diferencia: faltante,
                costoUnitario: costoUnit,
                costoTotal: faltante * costoUnit
            });
            costoFaltante += faltante * costoUnit;
        } else if (diferencia > 0) {
            // Sobrante
            const costoUnit = esperado.costo || 0;
            sobrantes.push({
                ean,
                codigo: esperado.codigo,
                descripcion: esperado.descripcion,
                cantidadEsperada,
                cantidadEscaneada,
                diferencia,
                costoUnitario: costoUnit,
                costoTotal: diferencia * costoUnit
            });
            costoSobrante += diferencia * costoUnit;
        }
    });

    // Revisar items escaneados que no están en el stock esperado
    Object.keys(escaneadoMap).forEach(ean => {
        if (!stockMap[ean]) {
            const escaneado = escaneadoMap[ean];
            const productoMaestro = maestroMap[ean] || {};
            const costoUnit = productoMaestro.costo || 0;
            sobrantes.push({
                ean,
                codigo: productoMaestro.codigo || escaneado.codigo || '',
                descripcion: productoMaestro.descripcion || escaneado.descripcion || 'NO EN STOCK',
                cantidadEsperada: 0,
                cantidadEscaneada: escaneado.cantidadEscaneada,
                diferencia: escaneado.cantidadEscaneada,
                costoUnitario: costoUnit,
                costoTotal: escaneado.cantidadEscaneada * costoUnit
            });
            costoSobrante += escaneado.cantidadEscaneada * costoUnit;
        }
    });

    // Total escaneado
    estado.todosLosItems.forEach(item => {
        totalEscaneado += item.cantidad;
    });

    // Calcular progreso
    const progreso = totalEsperado > 0 ? Math.round((totalEscaneado / totalEsperado) * 100) : 0;

    // Ordenar por costo total
    faltantes.sort((a, b) => b.costoTotal - a.costoTotal);
    sobrantes.sort((a, b) => b.costoTotal - a.costoTotal);

    console.log(`[Comparación] Resultado: ${faltantes.length} faltantes, ${sobrantes.length} sobrantes`);

    return {
        tieneStock: true,
        totalEsperado,
        totalEscaneado,
        progreso: Math.min(progreso, 999), // Cap at 999%
        faltantes,
        sobrantes,
        totalFaltantes: faltantes.length,
        totalSobrantes: sobrantes.length,
        costoFaltante,
        costoSobrante,
        diferenciaCosto: costoSobrante - costoFaltante,
        eansEsperados: Object.keys(stockMap).length,
        eansEscaneados: Object.keys(escaneadoMap).length
    };
}

function getResumen() {
    const zonasArray = Object.values(estado.zonas).map(z => ({
        id: z.id,
        nombre: z.nombre,
        escaner: z.escaner ? estado.escaneres[z.escaner]?.nombre : null,
        totalItems: z.items.reduce((sum, i) => sum + i.cantidad, 0),
        eansUnicos: z.items.length,
        activa: !!z.escaner && !z.cerrada
    }));

    const escaneresArray = Object.values(estado.escaneres).map(e => ({
        id: e.id,
        nombre: e.nombre,
        zonaActual: e.zonaActual,
        zonaNombre: e.zonaActual ? estado.zonas[e.zonaActual]?.nombre : null,
        totalItems: e.items.reduce((sum, i) => sum + i.cantidad, 0),
        conectado: e.conectado
    }));

    const totalItems = estado.todosLosItems.reduce((sum, i) => sum + i.cantidad, 0);
    const eansUnicos = new Set(estado.todosLosItems.map(i => i.ean)).size;
    const sinMaestro = estado.todosLosItems.filter(i => !i.existeEnMaestro).length;

    // Contar auditores únicos por nombre normalizado
    const auditoresUnicos = new Set(
        Object.values(estado.escaneres).map(e => e.nombreNormalizado || normalizarNombre(e.nombre))
    ).size;

    // Obtener comparación
    const comparacion = getComparacion();

    return {
        sesionActiva: estado.sesionActiva,
        totalItems,
        eansUnicos,
        sinMaestro,
        totalZonas: zonasArray.length,
        zonasActivas: zonasArray.filter(z => z.activa).length,
        zonas: zonasArray,
        escaneres: escaneresArray,
        auditoresUnicos,
        maestroCargado: estado.maestro.length,
        stockTiendaCargado: estado.stockTienda.length,
        comparacion,
        ultimosEscaneos: estado.todosLosItems.slice(0, 20)
    };
}

// ============================================
// API REST
// ============================================

// Obtener estado/resumen
// Endpoint rápido para discovery de la app Android
app.get('/api/ping', (req, res) => {
    res.json({
        ok: true,
        type: 'INVENTARIO_SERVER',
        name: 'Inventario QLQ',
        port: PORT
    });
});

// ============================================
// SESIÓN GUI (para compartir entre Electron y Dashboard)
// ============================================
let guiSession = null;

app.post('/api/gui-session', (req, res) => {
    const { usuario, timestamp } = req.body;
    console.log('[GUI-SESSION] POST recibido:', usuario ? usuario.nombre : 'sin usuario');
    if (usuario) {
        guiSession = { usuario, timestamp: timestamp || Date.now() };
        console.log('[GUI-SESSION] Sesión guardada:', guiSession.usuario.nombre);
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: 'Usuario requerido' });
    }
});

app.get('/api/gui-session', (req, res) => {
    console.log('[GUI-SESSION] GET - sesión actual:', guiSession ? guiSession.usuario.nombre : 'ninguna');
    if (guiSession) {
        // Verificar si no expiró (7 días)
        const diasExpiracion = 7;
        const now = Date.now();
        if (now - guiSession.timestamp < diasExpiracion * 24 * 60 * 60 * 1000) {
            res.json(guiSession);
        } else {
            guiSession = null;
            res.json(null);
        }
    } else {
        res.json(null);
    }
});

app.delete('/api/gui-session', (req, res) => {
    guiSession = null;
    res.json({ ok: true });
});

app.get('/api/estado', (req, res) => {
    res.json(getResumen());
});

// Debug - ver estado de datos cargados
app.get('/api/debug', (req, res) => {
    const comparacion = getComparacion();
    res.json({
        maestro: estado.maestro.length,
        stockTienda: estado.stockTienda.length,
        itemsEscaneados: estado.todosLosItems.length,
        zonas: Object.keys(estado.zonas).length,
        sesionActiva: estado.sesionActiva ? estado.sesionActiva.nombre : null,
        comparacion: {
            tieneStock: comparacion.tieneStock,
            totalFaltantes: comparacion.faltantes?.length || 0,
            totalSobrantes: comparacion.sobrantes?.length || 0,
            costoFaltante: comparacion.costoFaltante,
            costoSobrante: comparacion.costoSobrante
        }
    });
});

// Obtener todos los items (para el dashboard)
app.get('/api/items', (req, res) => {
    res.json(estado.todosLosItems);
});

// Iniciar nueva sesión
app.post('/api/sesion/nueva', (req, res) => {
    estado = {
        sesionActiva: {
            id: uuidv4(),
            fechaInicio: new Date().toISOString(),
            nombre: req.body.nombre || `Inventario ${new Date().toLocaleDateString()}`,
            detalles: req.body.detalles || null,
            tienda_id: req.body.tienda_id || null,
            tienda_nombre: req.body.tienda_nombre || null,
            tienda_numero: req.body.tienda_numero || null
        },
        maestro: estado.maestro,         // Mantener maestro
        stockTienda: estado.stockTienda, // Mantener stock tienda
        escaneres: estado.escaneres,     // Mantener escaneres conectados
        zonas: {},                        // Limpiar zonas
        todosLosItems: []                 // Limpiar items escaneados
    };

    guardarEstado();
    broadcast({ tipo: 'nueva_sesion', data: getResumen() });
    res.json({ ok: true, sesion: estado.sesionActiva });
});

// Obtener auditores conectados
app.get('/api/auditores', (req, res) => {
    const auditores = Object.values(estado.escaneres).map(esc => {
        const zona = esc.zonaActual ? estado.zonas[esc.zonaActual] : null;
        return {
            id: esc.id,
            nombre: esc.nombre,
            conectado: esc.conectado || false,
            zonaActual: zona ? zona.nombre : null,
            itemsEscaneados: esc.items ? esc.items.reduce((sum, i) => sum + i.cantidad, 0) : 0
        };
    });
    res.json(auditores);
});

// Finalizar sesión
app.post('/api/sesion/finalizar', (req, res) => {
    if (estado.sesionActiva) {
        estado.sesionActiva.fechaFin = new Date().toISOString();
    }
    guardarEstado();
    broadcast({ tipo: 'sesion_finalizada', data: getResumen() });
    res.json({ ok: true });
});

// Cargar maestro desde Excel
app.post('/api/maestro/cargar', upload.single('archivo'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se recibió archivo' });
        }

        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet);

        estado.maestro = data.map(row => {
            // Buscar columnas por nombre (flexible)
            const ean = row.EAN || row.ean || row.CODIGO_BARRAS || row['Código de Barras'] || row.UPC || Object.values(row)[0] || '';
            const codigo = row.CODIGO || row.Codigo || row.codigo || row.SKU || row.sku || Object.values(row)[1] || '';
            const descripcion = row.DESCRIPCION || row.Descripcion || row.descripcion || row.NOMBRE || row.Nombre || Object.values(row)[2] || '';
            const costo = parseFloat(row.COSTO || row.Costo || row.costo || row.PRECIO || row.Precio || Object.values(row)[3] || 0) || 0;

            return {
                ean: String(ean).trim(),
                codigo: String(codigo).trim(),
                descripcion: String(descripcion).trim(),
                costo: costo
            };
        }).filter(p => p.ean);

        // Eliminar archivo temporal
        fs.unlinkSync(req.file.path);

        guardarEstado();
        broadcast({ tipo: 'maestro_cargado', data: { cantidad: estado.maestro.length } });

        res.json({ ok: true, cantidad: estado.maestro.length });
    } catch (error) {
        console.error('Error cargando maestro:', error);
        res.status(500).json({ error: 'Error procesando archivo' });
    }
});

// Obtener maestro
app.get('/api/maestro', (req, res) => {
    res.json({ cantidad: estado.maestro.length, productos: estado.maestro.slice(0, 100) });
});

// Buscar producto en maestro por EAN
app.get('/api/maestro/buscar/:ean', (req, res) => {
    const ean = req.params.ean;
    const producto = estado.maestro.find(p => p.ean === ean);
    if (producto) {
        res.json({ encontrado: true, producto });
    } else {
        res.json({ encontrado: false });
    }
});

// Cargar Stock Tienda desde Excel
app.post('/api/stock-tienda/cargar', upload.single('archivo'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No se recibió archivo' });
        }

        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet);

        estado.stockTienda = data.map(row => {
            const ean = row.EAN || row.ean || row.CODIGO_BARRAS || row['Código de Barras'] || Object.values(row)[0] || '';
            const cantidad = parseFloat(row.CANTIDAD || row.Cantidad || row.cantidad || row.STOCK || row.Stock || Object.values(row)[1] || 0) || 0;

            return {
                ean: String(ean).trim(),
                cantidad: cantidad
            };
        }).filter(p => p.ean);

        fs.unlinkSync(req.file.path);

        guardarEstado();
        broadcast({ tipo: 'stock_tienda_cargado', data: { cantidad: estado.stockTienda.length } });
        broadcast({ tipo: 'actualizacion', data: getResumen() });

        res.json({ ok: true, cantidad: estado.stockTienda.length });
    } catch (error) {
        console.error('Error cargando stock tienda:', error);
        res.status(500).json({ error: 'Error procesando archivo' });
    }
});

// Obtener stock tienda
app.get('/api/stock-tienda', (req, res) => {
    res.json({ cantidad: estado.stockTienda.length, productos: estado.stockTienda.slice(0, 100) });
});

// Obtener análisis de faltantes/sobrantes
app.get('/api/comparacion', (req, res) => {
    res.json(getComparacion());
});

// Exportar a Excel
app.get('/api/exportar', (req, res) => {
    const wb = XLSX.utils.book_new();

    // Obtener comparación (faltantes/sobrantes)
    const comparacion = getComparacion();

    // HOJA 1: Detalle de items escaneados
    const items = estado.todosLosItems.map(i => ({
        'Zona': i.zonaNombre,
        'EAN': i.ean,
        'Código': i.codigo,
        'Descripción': i.descripcion,
        'Cantidad': i.cantidad,
        'En Maestro': i.existeEnMaestro ? 'SI' : 'NO',
        'Escaneado por': i.escaner,
        'Hora': new Date(i.ultimoEscaneo).toLocaleString()
    }));

    if (items.length > 0) {
        const ws = XLSX.utils.json_to_sheet(items);
        ws['!cols'] = [
            { wch: 12 }, { wch: 15 }, { wch: 12 }, { wch: 35 },
            { wch: 10 }, { wch: 12 }, { wch: 15 }, { wch: 20 }
        ];
        XLSX.utils.book_append_sheet(wb, ws, 'Detalle Escaneado');
    }

    // HOJA 2: Faltantes (items en stock que no se escanearon o se escanearon menos)
    if (comparacion.faltantes && comparacion.faltantes.length > 0) {
        const faltantesData = comparacion.faltantes.map(f => ({
            'EAN': f.ean,
            'Código': f.codigo || '',
            'Descripción': f.descripcion || '',
            'Stock Esperado': f.cantidadEsperada,
            'Cantidad Escaneada': f.cantidadEscaneada,
            'Faltante': f.diferencia,
            'Costo Unitario': f.costoUnitario || 0,
            'Costo Total Faltante': f.costoTotal || 0
        }));
        const wsFaltantes = XLSX.utils.json_to_sheet(faltantesData);
        wsFaltantes['!cols'] = [
            { wch: 15 }, { wch: 12 }, { wch: 35 }, { wch: 14 },
            { wch: 16 }, { wch: 10 }, { wch: 14 }, { wch: 16 }
        ];
        XLSX.utils.book_append_sheet(wb, wsFaltantes, 'Faltantes');
    }

    // HOJA 3: Sobrantes (items escaneados de más o no esperados)
    if (comparacion.sobrantes && comparacion.sobrantes.length > 0) {
        const sobrantesData = comparacion.sobrantes.map(s => ({
            'EAN': s.ean,
            'Código': s.codigo || '',
            'Descripción': s.descripcion || '',
            'Stock Esperado': s.cantidadEsperada,
            'Cantidad Escaneada': s.cantidadEscaneada,
            'Sobrante': s.diferencia,
            'Costo Unitario': s.costoUnitario || 0,
            'Costo Total Sobrante': s.costoTotal || 0
        }));
        const wsSobrantes = XLSX.utils.json_to_sheet(sobrantesData);
        wsSobrantes['!cols'] = [
            { wch: 15 }, { wch: 12 }, { wch: 35 }, { wch: 14 },
            { wch: 16 }, { wch: 10 }, { wch: 14 }, { wch: 16 }
        ];
        XLSX.utils.book_append_sheet(wb, wsSobrantes, 'Sobrantes');
    }

    // HOJA 4: Resumen general
    const resumenData = [
        { 'Concepto': 'Total Items Esperados (Stock)', 'Valor': comparacion.totalEsperado || 0 },
        { 'Concepto': 'Total Items Escaneados', 'Valor': comparacion.totalEscaneado || 0 },
        { 'Concepto': 'Progreso (%)', 'Valor': comparacion.progreso || 0 },
        { 'Concepto': '', 'Valor': '' },
        { 'Concepto': 'Total Faltantes (cantidad)', 'Valor': comparacion.faltantes?.length || 0 },
        { 'Concepto': 'Costo Total Faltantes', 'Valor': comparacion.costoFaltante || 0 },
        { 'Concepto': '', 'Valor': '' },
        { 'Concepto': 'Total Sobrantes (cantidad)', 'Valor': comparacion.sobrantes?.length || 0 },
        { 'Concepto': 'Costo Total Sobrantes', 'Valor': comparacion.costoSobrante || 0 },
        { 'Concepto': '', 'Valor': '' },
        { 'Concepto': 'Diferencia Neta', 'Valor': comparacion.diferenciaCosto || 0 }
    ];
    const wsResumen = XLSX.utils.json_to_sheet(resumenData);
    wsResumen['!cols'] = [{ wch: 30 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

    // Si no hay ninguna hoja, crear una vacía con mensaje
    if (wb.SheetNames.length === 0) {
        const wsVacio = XLSX.utils.json_to_sheet([{ 'Mensaje': 'No hay datos para exportar. Carga Stock Tienda y/o escanea items.' }]);
        XLSX.utils.book_append_sheet(wb, wsVacio, 'Sin Datos');
    }

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const filename = `inventario_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

// Editar item
app.post('/api/item/editar', (req, res) => {
    const { id, descripcion, cantidad, zonaId } = req.body;

    // Buscar item en todosLosItems
    const itemIndex = estado.todosLosItems.findIndex(i => i.id === id);
    if (itemIndex === -1) {
        return res.status(404).json({ error: 'Item no encontrado' });
    }

    const item = estado.todosLosItems[itemIndex];

    // Si la cantidad es 0 o menor, eliminar el item
    if (cantidad !== undefined && cantidad <= 0) {
        // Eliminar de todosLosItems
        estado.todosLosItems.splice(itemIndex, 1);

        // Eliminar de la zona
        if (estado.zonas[item.zonaId]) {
            estado.zonas[item.zonaId].items = estado.zonas[item.zonaId].items.filter(i => i.id !== id);
        }

        // Eliminar de escaneres
        Object.values(estado.escaneres).forEach(escaner => {
            escaner.items = escaner.items.filter(i => i.id !== id);
        });

        guardarEstado();
        broadcast({ tipo: 'item_eliminado', data: { id } });
        broadcast({ tipo: 'actualizacion', data: getResumen() });

        return res.json({ ok: true, eliminado: true });
    }

    // Si cambió de zona, mover el item
    if (zonaId && zonaId !== item.zonaId) {
        // Remover de zona anterior
        if (estado.zonas[item.zonaId]) {
            estado.zonas[item.zonaId].items = estado.zonas[item.zonaId].items.filter(i => i.id !== id);
        }
        // Agregar a nueva zona
        if (estado.zonas[zonaId]) {
            estado.zonas[zonaId].items.push(item);
        }
        item.zonaId = zonaId;
        item.zonaNombre = estado.zonas[zonaId]?.nombre || zonaId;
    }

    // Actualizar datos
    if (descripcion !== undefined) item.descripcion = descripcion;
    if (cantidad !== undefined) item.cantidad = cantidad;

    // También actualizar en la zona
    if (estado.zonas[item.zonaId]) {
        const zonaItem = estado.zonas[item.zonaId].items.find(i => i.id === id);
        if (zonaItem) {
            if (descripcion !== undefined) zonaItem.descripcion = descripcion;
            if (cantidad !== undefined) zonaItem.cantidad = cantidad;
        }
    }

    // También actualizar en escaneres (si existe)
    Object.values(estado.escaneres).forEach(escaner => {
        const escanerItem = escaner.items.find(i => i.id === id || i.ean === item.ean);
        if (escanerItem) {
            if (descripcion !== undefined) escanerItem.descripcion = descripcion;
            if (cantidad !== undefined) escanerItem.cantidad = cantidad;
        }
    });

    guardarEstado();
    broadcast({ tipo: 'item_actualizado', data: { item } });
    broadcast({ tipo: 'actualizacion', data: getResumen() });

    res.json({ ok: true, item });
});

// Agregar item manualmente (desde dashboard)
app.post('/api/item/agregar', (req, res) => {
    const { ean, descripcion, cantidad, zonaId } = req.body;

    if (!ean || !zonaId) {
        return res.status(400).json({ error: 'EAN y zona son requeridos' });
    }

    // Verificar que la zona existe
    if (!estado.zonas[zonaId]) {
        return res.status(404).json({ error: 'Zona no encontrada' });
    }

    const zona = estado.zonas[zonaId];
    const producto = estado.maestro.find(p => p.ean === ean);

    // Buscar si ya existe el item en esta zona
    let itemZona = zona.items.find(i => i.ean === ean);

    if (itemZona) {
        // Si existe en la zona, incrementar cantidad
        itemZona.cantidad += (cantidad || 1);
        itemZona.ultimoEscaneo = new Date().toISOString();

        // También actualizar en todosLosItems
        const itemGlobal = estado.todosLosItems.find(i => i.id === itemZona.id);
        if (itemGlobal) {
            itemGlobal.cantidad = itemZona.cantidad;
            itemGlobal.ultimoEscaneo = itemZona.ultimoEscaneo;
        }
    } else {
        // Crear nuevo item
        const nuevoItem = {
            id: uuidv4(),
            ean,
            codigo: producto?.codigo || '',
            descripcion: descripcion || producto?.descripcion || 'AGREGADO MANUALMENTE',
            cantidad: cantidad || 1,
            existeEnMaestro: !!producto,
            zonaId: zona.id,
            zonaNombre: zona.nombre,
            escaner: 'Dashboard',
            primerEscaneo: new Date().toISOString(),
            ultimoEscaneo: new Date().toISOString()
        };
        zona.items.unshift(nuevoItem);
        estado.todosLosItems.unshift(nuevoItem);
        itemZona = nuevoItem;
    }

    guardarEstado();
    broadcast({ tipo: 'item_agregado', data: { item: itemZona } });
    broadcast({ tipo: 'actualizacion', data: getResumen() });

    res.json({ ok: true, item: itemZona });
});

// Eliminar item
app.post('/api/item/eliminar', (req, res) => {
    const { id } = req.body;

    // Buscar item en todosLosItems para obtener su zonaId
    const index = estado.todosLosItems.findIndex(i => i.id === id);
    if (index === -1) {
        return res.status(404).json({ error: 'Item no encontrado' });
    }

    const item = estado.todosLosItems[index];
    const zonaIdDelItem = item.zonaId;

    // Remover de todosLosItems
    estado.todosLosItems.splice(index, 1);

    // Remover de la zona usando el zonaId del propio item
    if (zonaIdDelItem && estado.zonas[zonaIdDelItem]) {
        estado.zonas[zonaIdDelItem].items = estado.zonas[zonaIdDelItem].items.filter(i => i.id !== id);
    }

    // También buscar y eliminar de escaneres por si acaso
    Object.values(estado.escaneres).forEach(escaner => {
        escaner.items = escaner.items.filter(i => i.id !== id);
    });

    guardarEstado();
    broadcast({ tipo: 'item_eliminado', data: { id } });
    broadcast({ tipo: 'actualizacion', data: getResumen() });

    res.json({ ok: true });
});

// Limpiar todo
app.post('/api/limpiar', (req, res) => {
    estado = {
        sesionActiva: null,
        maestro: [],
        stockTienda: [],
        escaneres: {},
        zonas: {},
        todosLosItems: []
    };
    guardarEstado();
    broadcast({ tipo: 'limpiado', data: getResumen() });
    res.json({ ok: true });
});

// Crear zona manualmente (desde dashboard)
app.post('/api/zona/crear', (req, res) => {
    const { zonaId, nombre, auditorNombre, auditorNombreNormalizado } = req.body;

    if (!nombre) {
        return res.status(400).json({ error: 'Nombre de zona requerido' });
    }

    const id = zonaId || 'zona_' + Date.now();

    if (estado.zonas[id]) {
        return res.status(400).json({ error: 'Ya existe una zona con ese ID' });
    }

    // Si se especificó un auditor, asignar a ese auditor
    // Si no, la zona queda sin dueño (solo accesible desde dashboard)
    const nombreDueno = auditorNombre || 'Dashboard';
    const nombreNormDueno = auditorNombreNormalizado || 'dashboard';

    estado.zonas[id] = {
        id: id,
        nombre: nombre,
        escaner: null,
        creadoPor: 'Dashboard',
        creadoPorNombre: nombreDueno,
        creadoPorNombreNormalizado: nombreNormDueno,
        items: [],
        cerrada: false,
        fechaInicio: new Date().toISOString()
    };

    guardarEstado();

    // Notificar a todos, incluyendo al auditor asignado
    broadcast({ tipo: 'zona_creada', data: { zonaId: id, nombre, auditor: nombreDueno } });
    enviarZonasPersonalizadas(); // Actualizar lista de zonas de cada auditor
    broadcast({ tipo: 'actualizacion', data: getResumen() });

    res.json({ ok: true, zonaId: id });
});

// Editar zona (nombre)
app.post('/api/zona/editar', (req, res) => {
    const { zonaId, nuevoNombre } = req.body;

    if (!estado.zonas[zonaId]) {
        return res.status(404).json({ error: 'Zona no encontrada' });
    }

    estado.zonas[zonaId].nombre = nuevoNombre;

    // Actualizar nombre en todos los items de esa zona
    estado.todosLosItems.forEach(item => {
        if (item.zonaId === zonaId) {
            item.zonaNombre = nuevoNombre;
        }
    });

    guardarEstado();
    broadcast({ tipo: 'zona_actualizada', data: { zonaId, nuevoNombre } });
    broadcast({ tipo: 'actualizacion', data: getResumen() });
    enviarZonasPersonalizadas();

    res.json({ ok: true });
});

// Eliminar zona
app.post('/api/zona/eliminar', (req, res) => {
    const { zonaId } = req.body;

    if (!estado.zonas[zonaId]) {
        return res.status(404).json({ error: 'Zona no encontrada' });
    }

    // Eliminar items de la zona de todosLosItems
    estado.todosLosItems = estado.todosLosItems.filter(i => i.zonaId !== zonaId);

    // Liberar escáner si estaba en esa zona
    Object.values(estado.escaneres).forEach(esc => {
        if (esc.zonaActual === zonaId) {
            esc.zonaActual = null;
        }
    });

    // Eliminar la zona
    delete estado.zonas[zonaId];

    guardarEstado();
    broadcast({ tipo: 'zona_eliminada', data: { zonaId } });
    broadcast({ tipo: 'actualizacion', data: getResumen() });
    enviarZonasPersonalizadas();

    res.json({ ok: true });
});

// ============================================
// ENDPOINTS DE ACTUALIZACIÓN
// ============================================

// Verificar si hay actualizaciones
app.get('/api/update/check', (req, res) => {
    verificarActualizaciones();
    res.json({
        updateDisponible,
        versionLocal,
        versionRemota
    });
});

// Ejecutar actualización
app.post('/api/update/aplicar', (req, res) => {
    console.log('Iniciando actualización...');

    exec('git pull origin main', { cwd: __dirname }, (err, stdout, stderr) => {
        if (err) {
            console.error('Error al actualizar:', err.message);
            return res.status(500).json({ error: 'Error al actualizar: ' + err.message });
        }

        console.log('Actualización completada:', stdout);

        // Notificar a todos que se va a reiniciar
        broadcast({
            tipo: 'reiniciando',
            data: { mensaje: 'Servidor actualizándose, reconectando en 5 segundos...' }
        });

        res.json({ ok: true, mensaje: 'Actualización aplicada, reiniciando servidor...' });

        // Reiniciar el servidor después de 2 segundos
        setTimeout(() => {
            console.log('Reiniciando servidor...');
            process.exit(0); // El script de inicio debe reiniciar el proceso
        }, 2000);
    });
});

// ============================================
// API DE TIENDAS
// ============================================

// Middleware para verificar que la DB esté lista
function checkDbReady(req, res, next) {
    if (!dbReady) {
        return res.status(503).json({ error: 'Base de datos inicializándose, intente en unos segundos' });
    }
    next();
}

// Obtener tiendas activas
app.get('/api/tiendas', checkDbReady, (req, res) => {
    const tiendas = database.obtenerTiendas();
    res.json(tiendas);
});

// Obtener todas las tiendas (incluyendo inactivas)
app.get('/api/tiendas/todas', (req, res) => {
    const tiendas = database.obtenerTodasLasTiendas();
    res.json(tiendas);
});

// Obtener tienda por ID
app.get('/api/tiendas/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const tienda = database.obtenerTiendaPorId(id);
    if (tienda) {
        res.json(tienda);
    } else {
        res.status(404).json({ error: 'Tienda no encontrada' });
    }
});

// Crear tienda
app.post('/api/tiendas', (req, res) => {
    const { numero_almacen, nombre } = req.body;

    if (!numero_almacen || !nombre) {
        return res.status(400).json({ error: 'Número de almacén y nombre son requeridos' });
    }

    const result = database.crearTienda(numero_almacen, nombre);
    if (result.ok) {
        res.json({ ok: true, id: result.id });
    } else {
        res.status(400).json({ error: result.error });
    }
});

// Actualizar tienda
app.put('/api/tiendas/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const result = database.actualizarTienda(id, req.body);

    if (result.ok) {
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: result.error });
    }
});

// Eliminar tienda
app.delete('/api/tiendas/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const result = database.eliminarTienda(id);

    if (result.ok) {
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: result.error });
    }
});

// ============================================
// API DE USUARIOS
// ============================================

// Login
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
    }

    const usuario = database.verificarCredenciales(username, password);
    if (usuario) {
        res.json({
            ok: true,
            usuario: {
                id: usuario.id,
                username: usuario.username,
                nombre: usuario.nombre,
                rol: usuario.rol
            }
        });
    } else {
        res.status(401).json({ error: 'Credenciales inválidas' });
    }
});

// Obtener usuarios (solo admin)
app.get('/api/usuarios', (req, res) => {
    const usuarios = database.obtenerUsuarios();
    res.json(usuarios);
});

// Crear usuario (solo admin)
app.post('/api/usuarios', (req, res) => {
    const { username, password, nombre, rol } = req.body;

    if (!username || !password || !nombre) {
        return res.status(400).json({ error: 'Faltan datos requeridos' });
    }

    const result = database.crearUsuario(username, password, nombre, rol);
    if (result.ok) {
        res.json({ ok: true, id: result.id });
    } else {
        res.status(400).json({ error: result.error });
    }
});

// Actualizar usuario (solo admin)
app.put('/api/usuarios/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const result = database.actualizarUsuario(id, req.body);

    if (result.ok) {
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: result.error });
    }
});

// Eliminar usuario (solo admin)
app.delete('/api/usuarios/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const result = database.eliminarUsuario(id);

    if (result.ok) {
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: result.error });
    }
});

// ============================================
// API DE HISTÓRICO
// ============================================

// Obtener histórico
app.get('/api/historico', (req, res) => {
    const limite = parseInt(req.query.limite) || 100;
    const historico = database.obtenerHistorico(limite);
    res.json(historico);
});

// Obtener registro específico del histórico
app.get('/api/historico/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const registro = database.obtenerHistoricoPorId(id);

    if (registro) {
        res.json(registro);
    } else {
        res.status(404).json({ error: 'Registro no encontrado' });
    }
});

// Guardar en histórico (guardar resultado de inventario actual)
app.post('/api/historico', (req, res) => {
    const { tienda_id, nombre_tienda, numero_almacen, notas, creado_por } = req.body;

    if (!nombre_tienda) {
        return res.status(400).json({ error: 'Nombre de tienda requerido' });
    }

    // Obtener datos actuales del inventario
    const comparacion = getComparacion();
    const resumen = getResumen();

    // Preparar detalle de items (todos los items escaneados)
    const detalleItems = estado.todosLosItems.map(item => ({
        zona: item.zonaNombre,
        ean: item.ean,
        codigo: item.codigo,
        descripcion: item.descripcion,
        cantidad: item.cantidad,
        existeEnMaestro: item.existeEnMaestro,
        escaner: item.escaner,
        ultimoEscaneo: item.ultimoEscaneo
    }));

    const datos = {
        fecha: new Date().toISOString(),
        tienda_id: tienda_id || null,
        nombre_tienda,
        numero_almacen: numero_almacen || null,
        nombre_sesion: estado.sesionActiva?.nombre || null,
        detalles_sesion: estado.sesionActiva?.detalles || null,
        total_items_escaneados: resumen.totalItems,
        total_eans_unicos: resumen.eansUnicos,
        total_zonas: resumen.totalZonas,
        total_faltantes: comparacion.totalFaltantes || 0,
        costo_faltantes: comparacion.costoFaltante || 0,
        detalle_faltantes: comparacion.faltantes || [],
        total_sobrantes: comparacion.totalSobrantes || 0,
        costo_sobrantes: comparacion.costoSobrante || 0,
        detalle_sobrantes: comparacion.sobrantes || [],
        costo_general: comparacion.diferenciaCosto || 0,
        creado_por,
        notas,
        detalle_items: detalleItems
    };

    const result = database.guardarHistorico(datos);

    if (result.ok) {
        broadcast({ tipo: 'historico_guardado', data: { id: result.id } });
        res.json({ ok: true, id: result.id });
    } else {
        res.status(500).json({ error: result.error });
    }
});

// Actualizar registro del histórico (solo admin)
app.put('/api/historico/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const result = database.actualizarHistorico(id, req.body);

    if (result.ok) {
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: result.error });
    }
});

// Eliminar registro del histórico (solo admin)
app.delete('/api/historico/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const result = database.eliminarHistorico(id);

    if (result.ok) {
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: result.error });
    }
});

// Exportar registro del histórico a Excel
app.get('/api/historico/:id/exportar', (req, res) => {
    const id = parseInt(req.params.id);
    const registro = database.obtenerHistoricoPorId(id);

    if (!registro) {
        return res.status(404).json({ error: 'Registro no encontrado' });
    }

    // Crear workbook
    const wb = XLSX.utils.book_new();

    // HOJA 1: Resumen
    const resumen = [
        { Campo: 'Fecha', Valor: new Date(registro.fecha).toLocaleString() },
        { Campo: 'Tienda', Valor: registro.nombre_tienda },
        { Campo: 'Número Almacén', Valor: registro.numero_almacen || '-' },
        { Campo: 'Sesión', Valor: registro.nombre_sesion || '-' },
        { Campo: 'Detalles', Valor: registro.detalles_sesion || '-' },
        { Campo: '', Valor: '' },
        { Campo: 'Total Items Escaneados', Valor: registro.total_items_escaneados },
        { Campo: 'Total EANs Únicos', Valor: registro.total_eans_unicos },
        { Campo: 'Total Zonas', Valor: registro.total_zonas },
        { Campo: '', Valor: '' },
        { Campo: 'Total Faltantes', Valor: registro.total_faltantes },
        { Campo: 'Costo Faltantes', Valor: registro.costo_faltantes },
        { Campo: 'Total Sobrantes', Valor: registro.total_sobrantes },
        { Campo: 'Costo Sobrantes', Valor: registro.costo_sobrantes },
        { Campo: 'Diferencia General', Valor: registro.costo_general },
        { Campo: '', Valor: '' },
        { Campo: 'Creado Por', Valor: registro.creado_por || '-' },
        { Campo: 'Notas', Valor: registro.notas || '-' }
    ];
    const wsResumen = XLSX.utils.json_to_sheet(resumen);
    wsResumen['!cols'] = [{ wch: 25 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');

    // HOJA 2: Faltantes
    const faltantes = registro.detalle_faltantes || [];
    if (faltantes.length > 0) {
        const faltantesData = faltantes.map(f => ({
            'EAN': f.ean,
            'Código': f.codigo || '',
            'Descripción': f.descripcion || '',
            'Cantidad Esperada': f.cantidadEsperada,
            'Cantidad Escaneada': f.cantidadEscaneada,
            'Diferencia': f.diferencia,
            'Costo Unitario': f.costoUnitario || 0,
            'Costo Total': f.costoTotal || 0
        }));
        const wsFaltantes = XLSX.utils.json_to_sheet(faltantesData);
        wsFaltantes['!cols'] = [
            { wch: 15 }, { wch: 12 }, { wch: 35 }, { wch: 15 },
            { wch: 15 }, { wch: 12 }, { wch: 14 }, { wch: 14 }
        ];
        XLSX.utils.book_append_sheet(wb, wsFaltantes, 'Faltantes');
    }

    // HOJA 3: Sobrantes
    const sobrantes = registro.detalle_sobrantes || [];
    if (sobrantes.length > 0) {
        const sobrantesData = sobrantes.map(s => ({
            'EAN': s.ean,
            'Código': s.codigo || '',
            'Descripción': s.descripcion || '',
            'Cantidad Esperada': s.cantidadEsperada,
            'Cantidad Escaneada': s.cantidadEscaneada,
            'Diferencia': s.diferencia,
            'Costo Unitario': s.costoUnitario || 0,
            'Costo Total': s.costoTotal || 0
        }));
        const wsSobrantes = XLSX.utils.json_to_sheet(sobrantesData);
        wsSobrantes['!cols'] = [
            { wch: 15 }, { wch: 12 }, { wch: 35 }, { wch: 15 },
            { wch: 15 }, { wch: 12 }, { wch: 14 }, { wch: 14 }
        ];
        XLSX.utils.book_append_sheet(wb, wsSobrantes, 'Sobrantes');
    }

    // HOJA 4: Detalle completo de items escaneados
    const items = registro.detalle_items || [];
    if (items.length > 0) {
        const itemsData = items.map(i => ({
            'Zona': i.zona || '',
            'EAN': i.ean,
            'Código': i.codigo || '',
            'Descripción': i.descripcion || '',
            'Cantidad': i.cantidad,
            'En Maestro': i.existeEnMaestro ? 'SI' : 'NO',
            'Escaneado por': i.escaner || '',
            'Hora': i.ultimoEscaneo ? new Date(i.ultimoEscaneo).toLocaleString() : ''
        }));
        const wsItems = XLSX.utils.json_to_sheet(itemsData);
        wsItems['!cols'] = [
            { wch: 12 }, // Zona
            { wch: 15 }, // EAN
            { wch: 12 }, // Código
            { wch: 35 }, // Descripción
            { wch: 10 }, // Cantidad
            { wch: 12 }, // En Maestro
            { wch: 15 }, // Escaneado por
            { wch: 20 }  // Hora
        ];
        XLSX.utils.book_append_sheet(wb, wsItems, 'Detalle');
    }

    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const fechaStr = new Date(registro.fecha).toISOString().slice(0, 10);
    const tiendaStr = registro.nombre_tienda.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `historico_${tiendaStr}_${fechaStr}.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
});

// ============================================
// INICIAR SERVIDOR CON FALLBACK DE PUERTOS
// ============================================

function getLocalIP() {
    const interfaces = require('os').networkInterfaces();
    let hotspotIP = null;
    let wifiIP = null;
    let anyLocalIP = null;

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                const addr = iface.address;

                // Ignorar IPs de VPN (Tailscale usa 100.x.x.x)
                if (addr.startsWith('100.')) continue;

                // Prioridad 1: Hotspot de Windows
                if (addr.startsWith('192.168.137.')) {
                    hotspotIP = addr;
                }
                // Prioridad 2: Red local típica (WiFi/Ethernet)
                else if (addr.startsWith('192.168.') || addr.startsWith('10.') || addr.startsWith('172.')) {
                    if (!wifiIP) wifiIP = addr;
                }
                // Prioridad 3: Cualquier otra IP local
                else if (!anyLocalIP) {
                    anyLocalIP = addr;
                }
            }
        }
    }

    return hotspotIP || wifiIP || anyLocalIP || 'localhost';
}

// Variable global para almacenar el estado del servidor
let serverStatus = {
    running: false,
    port: null,
    ip: null,
    error: null
};

// Función para probar si un puerto está disponible
function tryListenOnPort(port) {
    return new Promise((resolve) => {
        const testServer = require('http').createServer();

        testServer.once('error', (err) => {
            testServer.close();
            resolve({ success: false, error: err.code });
        });

        testServer.once('listening', () => {
            testServer.close();
            resolve({ success: true });
        });

        testServer.listen(port, '0.0.0.0');
    });
}

// Función asíncrona para encontrar puerto disponible e iniciar
async function startServerWithFallback() {
    for (let i = 0; i < PORTS_TO_TRY.length; i++) {
        const port = PORTS_TO_TRY[i];
        console.log(`Probando puerto ${port}...`);

        const result = await tryListenOnPort(port);

        if (result.success) {
            // Puerto disponible, iniciar el servidor real
            PORT = port;

            server.listen(port, '0.0.0.0', () => {
                const ip = getLocalIP();

                serverStatus.running = true;
                serverStatus.port = port;
                serverStatus.ip = ip;
                serverStatus.error = null;

                const portDisplay = port === 80 ? '' : `:${port}`;

                console.log('');
                console.log('╔════════════════════════════════════════════════════════════╗');
                console.log('║          SERVIDOR DE INVENTARIO INICIADO                   ║');
                console.log('╠════════════════════════════════════════════════════════════╣');
                console.log(`║  Puerto:     ${port}                                            ║`);
                console.log(`║  Dashboard:  http://localhost${portDisplay}                         ║`);
                console.log(`║  En red:     http://${ip}${portDisplay}                      ║`);
                console.log('╠════════════════════════════════════════════════════════════╣');
                console.log('║  Los escáneres deben estar en la misma red WiFi            ║');
                console.log('║  La app Android encontrará el servidor automáticamente     ║');
                console.log('╚════════════════════════════════════════════════════════════╝');
                console.log('');

                // Iniciar servidor UDP para discovery automático
                iniciarUDPDiscovery(ip, port);
            });

            return; // Éxito, salir
        } else {
            if (result.error === 'EACCES') {
                console.log(`  → Puerto ${port}: Requiere permisos de administrador`);
            } else if (result.error === 'EADDRINUSE') {
                console.log(`  → Puerto ${port}: Ya está en uso`);
            } else {
                console.log(`  → Puerto ${port}: Error (${result.error})`);
            }
        }
    }

    // Ningún puerto funcionó
    serverStatus.running = false;
    serverStatus.error = 'No se pudo iniciar en ningún puerto (80, 8080, 3000). Ejecuta como Administrador o cierra otras aplicaciones.';

    console.error('');
    console.error('╔════════════════════════════════════════════════════════════╗');
    console.error('║  ERROR: No se pudo iniciar el servidor                     ║');
    console.error('║  Puertos 80, 8080, 3000 no disponibles.                    ║');
    console.error('║  Ejecuta como Administrador o cierra otras apps.           ║');
    console.error('╚════════════════════════════════════════════════════════════╝');
    console.error('');
}

// ============================================
// UDP DISCOVERY - Para que la app encuentre el servidor automáticamente
// ============================================
const UDP_DISCOVERY_PORT = 41234;
const DISCOVERY_MESSAGE = 'INVENTARIO_DISCOVERY';

function iniciarUDPDiscovery(serverIP, serverPort) {
    try {
        const udpServer = dgram.createSocket('udp4');

        udpServer.on('message', (msg, rinfo) => {
            const message = msg.toString().trim();

            if (message === DISCOVERY_MESSAGE) {
                console.log(`[Discovery] Solicitud desde ${rinfo.address}:${rinfo.port}`);

                // Responder con la información del servidor
                const response = JSON.stringify({
                    type: 'INVENTARIO_SERVER',
                    ip: serverIP,
                    port: serverPort,
                    name: 'Inventario QLQ Server'
                });

                udpServer.send(response, rinfo.port, rinfo.address, (err) => {
                    if (err) {
                        console.log('[Discovery] Error enviando respuesta:', err.message);
                    } else {
                        console.log(`[Discovery] Respondido a ${rinfo.address}`);
                    }
                });
            }
        });

        udpServer.on('error', (err) => {
            console.log('[Discovery] Error UDP:', err.message);
            udpServer.close();
        });

        udpServer.bind(UDP_DISCOVERY_PORT, '0.0.0.0', () => {
            console.log(`[Discovery] Escuchando en UDP puerto ${UDP_DISCOVERY_PORT}`);
        });

    } catch (err) {
        console.log('[Discovery] No se pudo iniciar:', err.message);
    }
}

// Exportar estado del servidor
module.exports = { serverStatus, guardarEstado };

// Iniciar servidor
startServerWithFallback();
