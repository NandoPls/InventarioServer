/**
 * Script para generar iconos en todos los formatos
 * Ejecutar: npm run icons
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');

console.log('Generando iconos para todas las plataformas...\n');

// Verificar que existe el SVG
const svgPath = path.join(buildDir, 'icon.svg');
if (!fs.existsSync(svgPath)) {
    console.error('Error: No se encontró build/icon.svg');
    process.exit(1);
}

// Instalar dependencia si no existe
try {
    require.resolve('sharp');
} catch (e) {
    console.log('Instalando sharp para procesamiento de imágenes...');
    execSync('npm install sharp --save-dev', { stdio: 'inherit' });
}

const sharp = require('sharp');

async function generateIcons() {
    const icoSizes = [16, 32, 48, 256];
    const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];

    // Generar PNGs de diferentes tamaños
    console.log('Generando PNGs...');
    for (const size of sizes) {
        await sharp(svgPath)
            .resize(size, size)
            .png()
            .toFile(path.join(buildDir, `icon_${size}.png`));
    }

    // PNG principal (512x512)
    await sharp(svgPath)
        .resize(512, 512)
        .png()
        .toFile(path.join(buildDir, 'icon.png'));

    console.log('✓ icon.png generado');

    // Generar ICO para Windows usando dynamic import (ESM module)
    console.log('Generando ICO para Windows...');
    const pngToIco = (await import('png-to-ico')).default;
    const icoPngs = icoSizes.map(size => path.join(buildDir, `icon_${size}.png`));
    const icoBuffer = await pngToIco(icoPngs);
    fs.writeFileSync(path.join(buildDir, 'icon.ico'), icoBuffer);
    console.log('✓ icon.ico generado');

    console.log('\nPara generar icon.icns (macOS):');
    console.log('  1. Ve a https://cloudconvert.com/png-to-icns');
    console.log('  2. Sube build/icon.png');
    console.log('  3. Descarga y guarda como build/icon.icns\n');

    // Limpiar PNGs temporales
    for (const size of sizes) {
        const tempFile = path.join(buildDir, `icon_${size}.png`);
        if (size !== 512 && fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
    }

    console.log('✓ Iconos base generados en build/');
}

generateIcons().catch(console.error);
