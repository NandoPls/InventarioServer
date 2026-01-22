const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Configurar multer para subida de archivos
const upload = multer({ dest: 'data/uploads/' });

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

// Cargar estado guardado si existe
const estadoPath = path.join(__dirname, 'data', 'estado.json');
if (fs.existsSync(estadoPath)) {
    try {
        const saved = JSON.parse(fs.readFileSync(estadoPath, 'utf8'));
        if (saved.sesionActiva) {
            estado = saved;
            // Asegurar que stockTienda exista (para estados guardados antes de esta feature)
            if (!estado.stockTienda) {
                estado.stockTienda = [];
            }
            console.log('Estado anterior cargado');
        }
    } catch (e) {
        console.log('No se pudo cargar estado anterior');
    }
}

// Guardar estado periódicamente
function guardarEstado() {
    fs.writeFileSync(estadoPath, JSON.stringify(estado, null, 2));
}

setInterval(guardarEstado, 5000);

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

    ws.send(JSON.stringify({
        tipo: 'zona_asignada',
        data: { zonaId, zonaNombre: estado.zonas[zonaId].nombre }
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
    if (!estado.stockTienda || estado.stockTienda.length === 0) {
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
app.get('/api/estado', (req, res) => {
    res.json(getResumen());
});

// Iniciar nueva sesión
app.post('/api/sesion/nueva', (req, res) => {
    estado = {
        sesionActiva: {
            id: uuidv4(),
            fechaInicio: new Date().toISOString(),
            nombre: req.body.nombre || `Inventario ${new Date().toLocaleDateString()}`
        },
        maestro: estado.maestro, // Mantener maestro si ya estaba cargado
        stockTienda: estado.stockTienda, // Mantener stock tienda si ya estaba cargado
        escaneres: {},
        zonas: {},
        todosLosItems: []
    };

    guardarEstado();
    broadcast({ tipo: 'nueva_sesion', data: getResumen() });
    res.json({ ok: true, sesion: estado.sesionActiva });
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

    const ws = XLSX.utils.json_to_sheet(items);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inventario');

    // Ajustar ancho de columnas
    ws['!cols'] = [
        { wch: 12 }, // Zona
        { wch: 15 }, // EAN
        { wch: 12 }, // Código
        { wch: 35 }, // Descripción
        { wch: 10 }, // Cantidad
        { wch: 12 }, // En Maestro
        { wch: 15 }, // Escaneado por
        { wch: 20 }  // Hora
    ];

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
    const item = estado.todosLosItems.find(i => i.id === id);
    if (!item) {
        return res.status(404).json({ error: 'Item no encontrado' });
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

    guardarEstado();
    broadcast({ tipo: 'item_actualizado', data: { item } });
    broadcast({ tipo: 'actualizacion', data: getResumen() });

    res.json({ ok: true, item });
});

// Eliminar item
app.post('/api/item/eliminar', (req, res) => {
    const { id, zonaId } = req.body;

    // Remover de todosLosItems
    const index = estado.todosLosItems.findIndex(i => i.id === id);
    if (index === -1) {
        return res.status(404).json({ error: 'Item no encontrado' });
    }

    estado.todosLosItems.splice(index, 1);

    // Remover de la zona
    if (zonaId && estado.zonas[zonaId]) {
        estado.zonas[zonaId].items = estado.zonas[zonaId].items.filter(i => i.id !== id);
    }

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
        escaneres: {},
        zonas: {},
        todosLosItems: []
    };
    guardarEstado();
    broadcast({ tipo: 'limpiado', data: getResumen() });
    res.json({ ok: true });
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
// INICIAR SERVIDOR
// ============================================

server.listen(PORT, '0.0.0.0', () => {
    const interfaces = require('os').networkInterfaces();
    let ip = 'localhost';

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ip = iface.address;
                break;
            }
        }
    }

    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║          SERVIDOR DE INVENTARIO INICIADO                   ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  Dashboard:  http://localhost:${PORT}                        ║`);
    console.log(`║  En red:     http://${ip}:${PORT}                       ║`);
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  Los escáneres deben estar en la misma red WiFi            ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
});
