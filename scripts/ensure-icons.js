/**
 * Asegura que existan los iconos antes de compilar
 * Si no existen, genera PNG desde SVG y crea placeholders
 */

const fs = require('fs');
const path = require('path');

const buildDir = path.join(__dirname, '..', 'build');
const svgPath = path.join(buildDir, 'icon.svg');
const pngPath = path.join(buildDir, 'icon.png');
const icoPath = path.join(buildDir, 'icon.ico');
const icnsPath = path.join(buildDir, 'icon.icns');

async function ensureIcons() {
    // Crear carpeta build si no existe
    if (!fs.existsSync(buildDir)) {
        fs.mkdirSync(buildDir, { recursive: true });
    }

    // Si ya existe PNG, usarlo como base
    if (fs.existsSync(pngPath)) {
        console.log('✓ icon.png existe');

        // Copiar PNG como ICO si no existe (electron-builder lo aceptará)
        if (!fs.existsSync(icoPath)) {
            fs.copyFileSync(pngPath, icoPath);
            console.log('✓ icon.ico creado desde PNG');
        }

        // Copiar PNG como ICNS si no existe
        if (!fs.existsSync(icnsPath)) {
            fs.copyFileSync(pngPath, icnsPath);
            console.log('✓ icon.icns creado desde PNG');
        }

        return;
    }

    // Si existe SVG, convertirlo a PNG
    if (fs.existsSync(svgPath)) {
        try {
            const sharp = require('sharp');

            await sharp(svgPath)
                .resize(512, 512)
                .png()
                .toFile(pngPath);

            console.log('✓ icon.png generado desde SVG');

            // Crear copias para otras plataformas
            fs.copyFileSync(pngPath, icoPath);
            fs.copyFileSync(pngPath, icnsPath);
            console.log('✓ Iconos para todas las plataformas creados');

        } catch (e) {
            console.log('Sharp no disponible, creando placeholder...');
            createPlaceholder();
        }
    } else {
        console.log('No se encontró icon.svg, creando placeholder...');
        createPlaceholder();
    }
}

function createPlaceholder() {
    // Crear un PNG mínimo de 1x1 pixel (placeholder)
    // electron-builder generará un icono por defecto
    const minimalPng = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE, 0x00, 0x00, 0x00,
        0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0x60, 0x60, 0x60, 0x00,
        0x00, 0x00, 0x04, 0x00, 0x01, 0x27, 0x34, 0x27, 0x0A, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82
    ]);

    fs.writeFileSync(pngPath, minimalPng);
    fs.writeFileSync(icoPath, minimalPng);
    fs.writeFileSync(icnsPath, minimalPng);

    console.log('⚠ Iconos placeholder creados (se usará icono por defecto)');
}

ensureIcons().catch(console.error);
