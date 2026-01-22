// ============================================
// CONEXIÓN WEBSOCKET
// ============================================

let ws;
let reconectarIntento = 0;

function conectarWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket conectado');
        reconectarIntento = 0;
        actualizarEstadoConexion(true);
    };

    ws.onmessage = (event) => {
        const mensaje = JSON.parse(event.data);
        handleMensaje(mensaje);
    };

    ws.onclose = () => {
        console.log('WebSocket desconectado');
        actualizarEstadoConexion(false);

        // Reconectar después de un delay
        const delay = Math.min(1000 * Math.pow(2, reconectarIntento), 10000);
        reconectarIntento++;
        setTimeout(conectarWebSocket, delay);
    };

    ws.onerror = (error) => {
        console.error('Error WebSocket:', error);
    };
}

function actualizarEstadoConexion(conectado) {
    const status = document.getElementById('connectionStatus');
    if (conectado) {
        status.textContent = '● Conectado';
        status.classList.remove('disconnected');
    } else {
        status.textContent = '● Desconectado';
        status.classList.add('disconnected');
    }
}

// ============================================
// MANEJO DE MENSAJES
// ============================================

function handleMensaje(mensaje) {
    console.log('Mensaje recibido:', mensaje.tipo);

    switch (mensaje.tipo) {
        case 'estado_inicial':
        case 'estado':
        case 'actualizacion':
            actualizarDashboard(mensaje.data);
            break;
        case 'nuevo_escaneo':
            agregarEscaneo(mensaje.data);
            actualizarDashboard(mensaje.data.resumen);
            break;
        case 'nueva_sesion':
            actualizarDashboard(mensaje.data);
            mostrarNotificacion('Nueva sesión iniciada');
            break;
        case 'maestro_cargado':
            mostrarNotificacion(`Maestro cargado: ${mensaje.data.cantidad} productos`);
            cargarEstado();
            break;
        case 'escaner_conectado':
            mostrarNotificacion(`${mensaje.data.nombre} se conectó`);
            break;
    }
}

// ============================================
// ACTUALIZAR UI
// ============================================

function actualizarDashboard(data) {
    // Stats
    document.getElementById('totalItems').textContent = data.totalItems || 0;
    document.getElementById('eansUnicos').textContent = data.eansUnicos || 0;
    document.getElementById('zonasActivas').textContent = data.zonasActivas || 0;
    document.getElementById('escaneresActivos').textContent = data.escaneres?.length || 0;
    document.getElementById('sinMaestro').textContent = data.sinMaestro || 0;
    document.getElementById('maestroCargado').textContent = data.maestroCargado || 0;
    document.getElementById('contadorEscaneos').textContent = data.totalItems || 0;

    // Colorear card de sin maestro
    const sinMaestroCard = document.getElementById('sinMaestroCard');
    if (data.sinMaestro > 0) {
        sinMaestroCard.classList.remove('green');
        sinMaestroCard.classList.add('red');
    } else {
        sinMaestroCard.classList.remove('red');
        sinMaestroCard.classList.add('green');
    }

    // Zonas
    actualizarZonas(data.zonas || [], data.escaneres || []);

    // Últimos escaneos
    if (data.ultimosEscaneos) {
        actualizarEscaneos(data.ultimosEscaneos);
    }
}

function actualizarZonas(zonas, escaneres) {
    const container = document.getElementById('zonasLista');

    if (zonas.length === 0 && escaneres.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <p>No hay zonas activas</p>
                <small>Las zonas aparecerán cuando los escáneres se conecten</small>
            </div>
        `;
        return;
    }

    // Combinar información de zonas y escáneres
    let html = '';

    // Mostrar escáneres conectados
    escaneres.forEach(escaner => {
        const zona = zonas.find(z => z.id === escaner.zonaActual);
        html += `
            <div class="zona-card ${escaner.zonaActual ? 'activa' : ''}">
                <div class="zona-card-header">
                    <span class="zona-nombre">${escaner.zonaActual ? `Zona ${escaner.zonaActual}` : 'Sin zona'}</span>
                    <span class="zona-status ${escaner.zonaActual ? 'activa' : ''}">${escaner.zonaActual ? 'Activa' : 'Esperando'}</span>
                </div>
                <div class="zona-escaner">
                    👤 <strong>${escaner.nombre}</strong>
                </div>
                <div class="zona-stats">
                    <span>📦 ${zona?.totalItems || 0} items</span>
                    <span>🏷️ ${zona?.eansUnicos || 0} EANs</span>
                </div>
            </div>
        `;
    });

    // Mostrar zonas sin escáner asignado
    zonas.filter(z => !z.escaner).forEach(zona => {
        html += `
            <div class="zona-card">
                <div class="zona-card-header">
                    <span class="zona-nombre">Zona ${zona.id}</span>
                    <span class="zona-status">Libre</span>
                </div>
                <div class="zona-escaner">
                    Sin asignar
                </div>
                <div class="zona-stats">
                    <span>📦 ${zona.totalItems} items</span>
                    <span>🏷️ ${zona.eansUnicos} EANs</span>
                </div>
            </div>
        `;
    });

    container.innerHTML = html || `
        <div class="empty-state">
            <p>No hay actividad</p>
        </div>
    `;
}

function actualizarEscaneos(escaneos) {
    const container = document.getElementById('escaneos');

    if (escaneos.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <p>Sin escaneos aún</p>
                <small>Los escaneos aparecerán en tiempo real</small>
            </div>
        `;
        return;
    }

    container.innerHTML = escaneos.map(item => `
        <div class="escaneo-item ${!item.existeEnMaestro ? 'no-maestro' : ''}">
            <span class="escaneo-hora">${formatearHora(item.ultimoEscaneo)}</span>
            <div class="escaneo-info">
                <span class="escaneo-ean">${item.ean}</span>
                <span class="escaneo-desc">${item.descripcion}</span>
            </div>
            <span class="escaneo-zona">
                <strong>${item.zonaNombre || 'Zona ' + item.zonaId}</strong><br>
                ${item.escaner || ''}
            </span>
            <span class="escaneo-cantidad">x${item.cantidad}</span>
        </div>
    `).join('');
}

function agregarEscaneo(data) {
    const container = document.getElementById('escaneos');
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) {
        container.innerHTML = '';
    }

    const item = data.item;
    const html = `
        <div class="escaneo-item ${!item.existeEnMaestro ? 'no-maestro' : ''}">
            <span class="escaneo-hora">${formatearHora(item.ultimoEscaneo)}</span>
            <div class="escaneo-info">
                <span class="escaneo-ean">${item.ean}</span>
                <span class="escaneo-desc">${item.descripcion}</span>
            </div>
            <span class="escaneo-zona">
                <strong>${data.zona}</strong><br>
                ${data.escaner}
            </span>
            <span class="escaneo-cantidad">x${item.cantidad}</span>
        </div>
    `;

    container.insertAdjacentHTML('afterbegin', html);

    // Limitar a 50 items visibles
    while (container.children.length > 50) {
        container.removeChild(container.lastChild);
    }
}

// ============================================
// ACCIONES
// ============================================

async function cargarEstado() {
    try {
        const response = await fetch('/api/estado');
        const data = await response.json();
        actualizarDashboard(data);
    } catch (error) {
        console.error('Error cargando estado:', error);
    }
}

function mostrarModalNuevaSesion() {
    document.getElementById('modalNuevaSesion').classList.add('active');
}

function mostrarModalCargarMaestro() {
    document.getElementById('modalMaestro').classList.add('active');
}

function cerrarModales() {
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
}

async function iniciarNuevaSesion() {
    const nombre = document.getElementById('nombreSesion').value;

    try {
        const response = await fetch('/api/sesion/nueva', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nombre })
        });

        if (response.ok) {
            cerrarModales();
            document.getElementById('nombreSesion').value = '';
        }
    } catch (error) {
        console.error('Error iniciando sesión:', error);
        alert('Error al iniciar sesión');
    }
}

async function cargarMaestro() {
    const input = document.getElementById('archivoMaestro');
    const file = input.files[0];

    if (!file) {
        alert('Selecciona un archivo');
        return;
    }

    const formData = new FormData();
    formData.append('archivo', file);

    try {
        const response = await fetch('/api/maestro/cargar', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();

        if (response.ok) {
            cerrarModales();
            input.value = '';
            alert(`Maestro cargado: ${result.cantidad} productos`);
        } else {
            alert(result.error || 'Error al cargar archivo');
        }
    } catch (error) {
        console.error('Error cargando maestro:', error);
        alert('Error al cargar archivo');
    }
}

function exportarExcel() {
    window.location.href = '/api/exportar';
}

// ============================================
// UTILIDADES
// ============================================

function formatearHora(fecha) {
    if (!fecha) return '';
    const d = new Date(fecha);
    return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function mostrarNotificacion(mensaje) {
    // Simple notificación por consola, se podría mejorar con toast
    console.log('Notificación:', mensaje);
}

// Cerrar modales con Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        cerrarModales();
    }
});

// Cerrar modales al hacer click fuera
document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            cerrarModales();
        }
    });
});

// ============================================
// INICIALIZACIÓN
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    conectarWebSocket();
    cargarEstado();
});
