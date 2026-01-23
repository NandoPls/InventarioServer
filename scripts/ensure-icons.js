/**
 * Crea iconos PNG de 256x256 para el build
 */

const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');
const pngPath = path.join(buildDir, 'icon.png');
const icoPath = path.join(buildDir, 'icon.ico');
const icnsPath = path.join(buildDir, 'icon.icns');

// Crear carpeta build si no existe
if (!fs.existsSync(buildDir)) {
    fs.mkdirSync(buildDir, { recursive: true });
}

// PNG 256x256 azul con gradiente (válido para electron-builder)
// Este es un PNG real de 256x256 con un diseño simple
const png256 = Buffer.from(`
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
QmCC
`.replace(/\s/g, ''), 'base64');

// Escribir iconos
fs.writeFileSync(pngPath, png256);
fs.writeFileSync(icoPath, png256);
fs.writeFileSync(icnsPath, png256);

console.log('✓ Iconos 256x256 creados');
