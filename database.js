const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Variables globales
let db = null;
let DB_PATH = '';

// Determinar ruta de la base de datos
function getDbPath() {
    if (__dirname.includes('.asar')) {
        const dataDir = path.join(os.homedir(), '.inventario-server', 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        return path.join(dataDir, 'inventario.db');
    }
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    return path.join(dataDir, 'inventario.db');
}

// Guardar base de datos a archivo
function saveDatabase() {
    if (db && DB_PATH) {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    }
}

// Auto-guardar cada 5 segundos
setInterval(saveDatabase, 5000);

// Inicializar base de datos
async function initDatabase() {
    const SQL = await initSqlJs();
    DB_PATH = getDbPath();

    // Cargar base de datos existente o crear nueva
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
        console.log('Base de datos cargada desde:', DB_PATH);
    } else {
        db = new SQL.Database();
        console.log('Nueva base de datos creada');
    }

    // Crear tablas
    db.run(`
        -- Tabla de usuarios
        CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            nombre TEXT NOT NULL,
            rol TEXT DEFAULT 'auditor' CHECK(rol IN ('admin', 'auditor')),
            activo INTEGER DEFAULT 1,
            creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    db.run(`
        -- Tabla de tiendas
        CREATE TABLE IF NOT EXISTS tiendas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            numero_almacen TEXT UNIQUE NOT NULL,
            nombre TEXT NOT NULL,
            activa INTEGER DEFAULT 1,
            creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    db.run(`
        -- Tabla de histórico de inventarios
        CREATE TABLE IF NOT EXISTS historico (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
            tienda_id INTEGER,
            nombre_tienda TEXT NOT NULL,
            numero_almacen TEXT,
            nombre_sesion TEXT,
            detalles_sesion TEXT,
            total_items_escaneados INTEGER DEFAULT 0,
            total_eans_unicos INTEGER DEFAULT 0,
            total_zonas INTEGER DEFAULT 0,
            total_faltantes INTEGER DEFAULT 0,
            costo_faltantes REAL DEFAULT 0,
            detalle_faltantes TEXT,
            total_sobrantes INTEGER DEFAULT 0,
            costo_sobrantes REAL DEFAULT 0,
            detalle_sobrantes TEXT,
            costo_general REAL DEFAULT 0,
            creado_por TEXT,
            notas TEXT,
            creado_en DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Agregar columna detalles_sesion si no existe (para bases de datos existentes)
    try {
        db.run(`ALTER TABLE historico ADD COLUMN detalles_sesion TEXT`);
    } catch (e) {
        // La columna ya existe, ignorar
    }

    // Tabla para estado de sesión activa (persistencia)
    db.run(`
        CREATE TABLE IF NOT EXISTS estado_sesion (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            datos TEXT NOT NULL,
            actualizado_en DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Agregar columna detalle_items para guardar todos los items escaneados
    try {
        db.run(`ALTER TABLE historico ADD COLUMN detalle_items TEXT`);
    } catch (e) {
        // La columna ya existe, ignorar
    }

    // Insertar datos por defecto
    try {
        db.run(`INSERT OR IGNORE INTO usuarios (username, password, nombre, rol) VALUES ('Andrespachacama', '123456', 'Andrés Pachacama', 'admin')`);
        db.run(`INSERT OR IGNORE INTO usuarios (username, password, nombre, rol) VALUES ('auditor', '123456', 'Auditor Demo', 'auditor')`);

        // Tiendas
        const tiendas = [
            ['1002', 'Manquehue'],
            ['1003', 'Mall sport - Salomon'],
            ['1005', 'Mall sport - Wilson'],
            ['1006', 'BeCycling - Padre hurtado'],
            ['1008', 'Viña del mar'],
            ['1012', 'Mall plaza trebol - Salomon'],
            ['1014', 'Easton'],
            ['1017', 'Costanera Center - Salomon'],
            ['1024', 'Puerto montt'],
            ['1029', 'Parque Arauco'],
            ['1030', 'Mall sport - Arena']
        ];

        tiendas.forEach(([numero, nombre]) => {
            db.run(`INSERT OR IGNORE INTO tiendas (numero_almacen, nombre) VALUES (?, ?)`, [numero, nombre]);
        });
    } catch (e) {
        // Ignorar errores de datos duplicados
    }

    saveDatabase();
    console.log('Base de datos inicializada correctamente');
    return db;
}

// Helper para ejecutar queries
function runQuery(sql, params = []) {
    if (!db) throw new Error('Base de datos no inicializada');
    db.run(sql, params);
    saveDatabase();
}

function getOne(sql, params = []) {
    if (!db) return null;
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
    }
    stmt.free();
    return null;
}

function getAll(sql, params = []) {
    if (!db) return [];
    const results = [];
    const stmt = db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
        results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
}

function getLastInsertId() {
    if (!db) return 0;
    const result = db.exec('SELECT last_insert_rowid() as id');
    return result[0]?.values[0]?.[0] || 0;
}

// ============================================
// FUNCIONES DE TIENDAS
// ============================================

function obtenerTiendas() {
    return getAll('SELECT * FROM tiendas WHERE activa = 1 ORDER BY numero_almacen');
}

function obtenerTodasLasTiendas() {
    return getAll('SELECT * FROM tiendas ORDER BY numero_almacen');
}

function obtenerTiendaPorId(id) {
    return getOne('SELECT * FROM tiendas WHERE id = ?', [id]);
}

function crearTienda(numero_almacen, nombre) {
    try {
        runQuery('INSERT INTO tiendas (numero_almacen, nombre) VALUES (?, ?)', [numero_almacen, nombre]);
        return { ok: true, id: getLastInsertId() };
    } catch (e) {
        if (e.message.includes('UNIQUE constraint')) {
            return { ok: false, error: 'Ya existe una tienda con ese número de almacén' };
        }
        return { ok: false, error: e.message };
    }
}

function actualizarTienda(id, datos) {
    try {
        const campos = [];
        const valores = [];

        if (datos.numero_almacen) { campos.push('numero_almacen = ?'); valores.push(datos.numero_almacen); }
        if (datos.nombre) { campos.push('nombre = ?'); valores.push(datos.nombre); }
        if (datos.activa !== undefined) { campos.push('activa = ?'); valores.push(datos.activa ? 1 : 0); }

        if (campos.length === 0) return { ok: false, error: 'Sin campos para actualizar' };

        valores.push(id);
        runQuery(`UPDATE tiendas SET ${campos.join(', ')} WHERE id = ?`, valores);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function eliminarTienda(id) {
    try {
        runQuery('DELETE FROM tiendas WHERE id = ?', [id]);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ============================================
// FUNCIONES DE USUARIOS
// ============================================

function verificarCredenciales(username, password) {
    return getOne('SELECT * FROM usuarios WHERE username = ? AND password = ? AND activo = 1', [username, password]);
}

function obtenerUsuarios() {
    return getAll('SELECT id, username, nombre, rol, activo, creado_en FROM usuarios ORDER BY creado_en DESC');
}

function crearUsuario(username, password, nombre, rol = 'auditor') {
    try {
        runQuery('INSERT INTO usuarios (username, password, nombre, rol) VALUES (?, ?, ?, ?)', [username, password, nombre, rol]);
        return { ok: true, id: getLastInsertId() };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function actualizarUsuario(id, datos) {
    try {
        const campos = [];
        const valores = [];

        if (datos.nombre) { campos.push('nombre = ?'); valores.push(datos.nombre); }
        if (datos.password) { campos.push('password = ?'); valores.push(datos.password); }
        if (datos.rol) { campos.push('rol = ?'); valores.push(datos.rol); }
        if (datos.activo !== undefined) { campos.push('activo = ?'); valores.push(datos.activo ? 1 : 0); }

        if (campos.length === 0) return { ok: false, error: 'Sin campos para actualizar' };

        valores.push(id);
        runQuery(`UPDATE usuarios SET ${campos.join(', ')} WHERE id = ?`, valores);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function eliminarUsuario(id) {
    try {
        const user = getOne('SELECT username FROM usuarios WHERE id = ?', [id]);
        if (user && user.username === 'Andrespachacama') {
            return { ok: false, error: 'No se puede eliminar al administrador principal' };
        }
        runQuery('DELETE FROM usuarios WHERE id = ?', [id]);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ============================================
// FUNCIONES DE HISTÓRICO
// ============================================

function guardarHistorico(datos) {
    try {
        runQuery(`
            INSERT INTO historico (
                fecha, tienda_id, nombre_tienda, numero_almacen, nombre_sesion, detalles_sesion,
                total_items_escaneados, total_eans_unicos, total_zonas,
                total_faltantes, costo_faltantes, detalle_faltantes,
                total_sobrantes, costo_sobrantes, detalle_sobrantes,
                costo_general, creado_por, notas, detalle_items
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            datos.fecha || new Date().toISOString(),
            datos.tienda_id || null,
            datos.nombre_tienda,
            datos.numero_almacen || null,
            datos.nombre_sesion || null,
            datos.detalles_sesion || null,
            datos.total_items_escaneados || 0,
            datos.total_eans_unicos || 0,
            datos.total_zonas || 0,
            datos.total_faltantes || 0,
            datos.costo_faltantes || 0,
            JSON.stringify(datos.detalle_faltantes || []),
            datos.total_sobrantes || 0,
            datos.costo_sobrantes || 0,
            JSON.stringify(datos.detalle_sobrantes || []),
            datos.costo_general || 0,
            datos.creado_por || null,
            datos.notas || null,
            JSON.stringify(datos.detalle_items || [])
        ]);
        return { ok: true, id: getLastInsertId() };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function obtenerHistorico(limite = 100) {
    const registros = getAll('SELECT * FROM historico ORDER BY fecha DESC LIMIT ?', [limite]);
    return registros.map(r => ({
        ...r,
        detalle_faltantes: r.detalle_faltantes ? JSON.parse(r.detalle_faltantes) : [],
        detalle_sobrantes: r.detalle_sobrantes ? JSON.parse(r.detalle_sobrantes) : []
    }));
}

function obtenerHistoricoPorId(id) {
    const registro = getOne('SELECT * FROM historico WHERE id = ?', [id]);
    if (!registro) return null;
    return {
        ...registro,
        detalle_faltantes: registro.detalle_faltantes ? JSON.parse(registro.detalle_faltantes) : [],
        detalle_sobrantes: registro.detalle_sobrantes ? JSON.parse(registro.detalle_sobrantes) : [],
        detalle_items: registro.detalle_items ? JSON.parse(registro.detalle_items) : []
    };
}

function actualizarHistorico(id, datos) {
    try {
        const campos = [];
        const valores = [];

        if (datos.nombre_tienda) { campos.push('nombre_tienda = ?'); valores.push(datos.nombre_tienda); }
        if (datos.nombre_sesion !== undefined) { campos.push('nombre_sesion = ?'); valores.push(datos.nombre_sesion); }
        if (datos.notas !== undefined) { campos.push('notas = ?'); valores.push(datos.notas); }

        if (campos.length === 0) return { ok: false, error: 'Sin campos para actualizar' };

        valores.push(id);
        runQuery(`UPDATE historico SET ${campos.join(', ')} WHERE id = ?`, valores);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function eliminarHistorico(id) {
    try {
        runQuery('DELETE FROM historico WHERE id = ?', [id]);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ============================================
// BACKUP
// ============================================

function obtenerRutaDB() {
    return DB_PATH;
}

function crearBackup(rutaDestino) {
    try {
        if (!db) return { ok: false, error: 'Base de datos no inicializada' };
        saveDatabase(); // Guardar antes de backup
        fs.copyFileSync(DB_PATH, rutaDestino);
        return { ok: true, ruta: rutaDestino };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function isReady() {
    return db !== null;
}

// ============================================
// FUNCIONES DE ESTADO DE SESIÓN
// ============================================

function guardarEstadoSesion(estado) {
    try {
        if (!db) return { ok: false, error: 'Base de datos no inicializada' };

        const datos = JSON.stringify(estado);

        // Usar REPLACE para insertar o actualizar (siempre id=1)
        db.run(`
            INSERT OR REPLACE INTO estado_sesion (id, datos, actualizado_en)
            VALUES (1, ?, datetime('now'))
        `, [datos]);

        saveDatabase();
        return { ok: true };
    } catch (e) {
        console.error('Error guardando estado en DB:', e.message);
        return { ok: false, error: e.message };
    }
}

function cargarEstadoSesion() {
    try {
        if (!db) return null;

        const row = getOne('SELECT datos FROM estado_sesion WHERE id = 1');
        if (row && row.datos) {
            return JSON.parse(row.datos);
        }
        return null;
    } catch (e) {
        console.error('Error cargando estado de DB:', e.message);
        return null;
    }
}

function limpiarEstadoSesion() {
    try {
        if (!db) return { ok: false, error: 'Base de datos no inicializada' };

        db.run('DELETE FROM estado_sesion WHERE id = 1');
        saveDatabase();
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

module.exports = {
    initDatabase,
    isReady,
    // Tiendas
    obtenerTiendas,
    obtenerTodasLasTiendas,
    obtenerTiendaPorId,
    crearTienda,
    actualizarTienda,
    eliminarTienda,
    // Usuarios
    verificarCredenciales,
    obtenerUsuarios,
    crearUsuario,
    actualizarUsuario,
    eliminarUsuario,
    // Histórico
    guardarHistorico,
    obtenerHistorico,
    obtenerHistoricoPorId,
    actualizarHistorico,
    eliminarHistorico,
    // Backup
    obtenerRutaDB,
    crearBackup,
    // Estado de sesión
    guardarEstadoSesion,
    cargarEstadoSesion,
    limpiarEstadoSesion
};
