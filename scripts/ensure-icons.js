/**
 * Asegura que existan los iconos antes de compilar
 * Si no existen, crea placeholders básicos
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

// Si ya existen todos los iconos, salir
if (fs.existsSync(pngPath) && fs.existsSync(icoPath) && fs.existsSync(icnsPath)) {
    console.log('✓ Todos los iconos existen');
    process.exit(0);
}

// PNG mínimo azul de 16x16 (válido)
const minimalPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVR42mNkYGD4z0ABYBw1YNSAUQNGDRg1YNSAUQNGDRg1YNSAoWYAAJXvAv9CQczlAAAAAElFTkSuQmCC',
    'base64'
);

// Crear iconos si no existen
if (!fs.existsSync(pngPath)) {
    fs.writeFileSync(pngPath, minimalPng);
    console.log('✓ icon.png creado');
}

if (!fs.existsSync(icoPath)) {
    fs.writeFileSync(icoPath, minimalPng);
    console.log('✓ icon.ico creado');
}

if (!fs.existsSync(icnsPath)) {
    fs.writeFileSync(icnsPath, minimalPng);
    console.log('✓ icon.icns creado');
}

console.log('✓ Iconos listos (placeholders)');
