/**
 * Crea iconos para el build en GitHub Actions
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

// Verificar si ya existen iconos válidos
const icoExists = fs.existsSync(icoPath) && fs.statSync(icoPath).size > 10000;
const pngExists = fs.existsSync(pngPath) && fs.statSync(pngPath).size > 1000;

if (icoExists && pngExists) {
    console.log('✓ Iconos ya existen, saltando generación');
    process.exit(0);
}

// Si no existen, generarlos desde el SVG
const svgPath = path.join(buildDir, 'icon.svg');
if (!fs.existsSync(svgPath)) {
    console.error('Error: No se encontró build/icon.svg');
    process.exit(1);
}

async function generateIcons() {
    // Instalar sharp si no existe
    try {
        require.resolve('sharp');
    } catch (e) {
        console.log('Instalando sharp...');
        require('child_process').execSync('npm install sharp --save-dev', { stdio: 'inherit' });
    }

    const sharp = require('sharp');
    const icoSizes = [16, 32, 48, 256];

    // Generar PNGs para ICO
    console.log('Generando PNGs...');
    const pngBuffers = [];
    for (const size of icoSizes) {
        const buffer = await sharp(svgPath)
            .resize(size, size)
            .png()
            .toBuffer();
        pngBuffers.push(buffer);

        // Guardar PNG temporal para png-to-ico
        fs.writeFileSync(path.join(buildDir, `icon_${size}.png`), buffer);
    }

    // PNG principal 512x512
    await sharp(svgPath)
        .resize(512, 512)
        .png()
        .toFile(pngPath);
    console.log('✓ icon.png generado');

    // Generar ICO
    console.log('Generando ICO...');
    const pngToIco = (await import('png-to-ico')).default;
    const icoPngs = icoSizes.map(size => path.join(buildDir, `icon_${size}.png`));
    const icoBuffer = await pngToIco(icoPngs);
    fs.writeFileSync(icoPath, icoBuffer);
    console.log('✓ icon.ico generado');

    // Limpiar PNGs temporales
    for (const size of icoSizes) {
        const tempFile = path.join(buildDir, `icon_${size}.png`);
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
    }

    // Para ICNS en macOS, usamos el PNG (electron-builder lo convierte)
    if (!fs.existsSync(icnsPath)) {
        // Crear un archivo placeholder o copiar el PNG
        fs.copyFileSync(pngPath, icnsPath);
        console.log('✓ icon.icns placeholder creado');
    }

    console.log('✓ Iconos generados correctamente');
}

generateIcons().catch(err => {
    console.error('Error generando iconos:', err);
    process.exit(1);
});
