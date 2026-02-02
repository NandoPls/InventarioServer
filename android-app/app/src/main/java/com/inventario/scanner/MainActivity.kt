package com.inventario.scanner

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.*
import android.util.Log
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.gson.JsonObject
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import com.inventario.scanner.databinding.ActivityMainBinding
import kotlinx.coroutines.*
import okhttp3.MediaType.Companion.toMediaType
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.sqrt

class MainActivity : AppCompatActivity(), SensorEventListener {

    private lateinit var binding: ActivityMainBinding
    private var webSocket: WebSocketClient? = null

    private var serverIP: String = ""
    private var userName: String = ""
    private var visitorId: String = ""
    private var currentZona: Zona? = null
    private var zonas: MutableList<Zona> = mutableListOf()
    private var scanCount: Int = 0

    private lateinit var cameraExecutor: ExecutorService
    private var lastScanTime: Long = 0
    private val SCAN_DELAY = 1500L

    // Sensor para detectar estabilidad
    private lateinit var sensorManager: SensorManager
    private var accelerometer: Sensor? = null
    private var isStable: Boolean = false
    private var lastAcceleration: Float = 0f
    private var stableCount: Int = 0
    private val STABILITY_THRESHOLD = 0.4f  // Umbral de movimiento (más sensible)
    private val STABILITY_SAMPLES = 15      // Muestras estables necesarias (~0.5s más)
    private var stableStartTime: Long = 0
    private val STABILITY_HOLD_TIME = 500L  // Tiempo adicional de estabilidad (ms)

    // Control de cámara
    private var isCameraEnabled: Boolean = true
    private var cameraProvider: ProcessCameraProvider? = null

    // Sonidos
    private var toneGenerator: ToneGenerator? = null

    private val prefs by lazy { getSharedPreferences("inventario", Context.MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        cameraExecutor = Executors.newSingleThreadExecutor()

        // Inicializar sensor de movimiento
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        accelerometer = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

        // Inicializar generador de tonos
        try {
            toneGenerator = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 100)
        } catch (e: Exception) {
            Log.e("Sound", "Error inicializando ToneGenerator", e)
        }

        setupListeners()
        loadSavedData()
        startConnection()
    }

    override fun onResume() {
        super.onResume()
        accelerometer?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL)
        }
    }

    override fun onPause() {
        super.onPause()
        sensorManager.unregisterListener(this)
    }

    // SensorEventListener
    override fun onSensorChanged(event: SensorEvent?) {
        if (!isCameraEnabled) return  // No procesar si la cámara está apagada

        event?.let {
            if (it.sensor.type == Sensor.TYPE_ACCELEROMETER) {
                val x = it.values[0]
                val y = it.values[1]
                val z = it.values[2]

                val currentAcceleration = sqrt(x * x + y * y + z * z)
                val delta = abs(currentAcceleration - lastAcceleration)
                lastAcceleration = currentAcceleration

                if (delta < STABILITY_THRESHOLD) {
                    stableCount++

                    // Primera vez que alcanza las muestras necesarias
                    if (stableCount == STABILITY_SAMPLES) {
                        stableStartTime = System.currentTimeMillis()
                    }

                    // Verificar si pasó el tiempo adicional de estabilidad
                    if (stableCount >= STABILITY_SAMPLES && !isStable) {
                        val elapsedStableTime = System.currentTimeMillis() - stableStartTime
                        if (elapsedStableTime >= STABILITY_HOLD_TIME) {
                            isStable = true
                            runOnUiThread {
                                binding.tvStabilityStatus.visibility = View.GONE
                                binding.scanLine.setBackgroundColor(0xFF00FF00.toInt()) // Verde cuando estable
                            }
                        } else {
                            // Mostrar progreso
                            runOnUiThread {
                                binding.tvStabilityStatus.text = "Mantenga estable..."
                            }
                        }
                    }
                } else {
                    stableCount = 0
                    stableStartTime = 0
                    if (isStable) {
                        isStable = false
                        runOnUiThread {
                            binding.tvStabilityStatus.visibility = View.VISIBLE
                            binding.tvStabilityStatus.text = "Estabiliza la cámara..."
                            binding.scanLine.setBackgroundColor(0xFFFF0000.toInt()) // Rojo cuando inestable
                        }
                    }
                }
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        // No necesitamos hacer nada aquí
    }

    // Sonido de éxito (código encontrado en maestra)
    private fun playSuccessSound() {
        try {
            toneGenerator?.startTone(ToneGenerator.TONE_PROP_ACK, 150)
        } catch (e: Exception) {
            Log.e("Sound", "Error reproduciendo sonido", e)
        }
    }

    // Sonido de advertencia (código NO encontrado en maestra)
    private fun playWarningSound() {
        try {
            toneGenerator?.startTone(ToneGenerator.TONE_PROP_NACK, 300)
        } catch (e: Exception) {
            Log.e("Sound", "Error reproduciendo sonido", e)
        }
    }

    private fun setupListeners() {
        // Botón conectar manual
        binding.btnConnect.setOnClickListener {
            val ip = binding.etServerIP.text.toString().trim()
            if (ip.isNotEmpty()) {
                connectToServer(ip)
            }
        }

        // Login
        binding.btnLogin.setOnClickListener {
            val name = binding.etUserName.text.toString().trim()
            if (name.isNotEmpty()) {
                userName = name
                prefs.edit().putString("userName", userName).apply()
                registerUser()
            }
        }

        // Crear zona
        binding.btnCreateZona.setOnClickListener {
            val zoneName = binding.etNewZona.text.toString().trim()
            if (zoneName.isNotEmpty()) {
                createZona(zoneName)
                binding.etNewZona.text?.clear()
                hideKeyboard()
            }
        }

        // Enviar EAN manual
        binding.btnSendEAN.setOnClickListener {
            val ean = binding.etEAN.text.toString().trim()
            if (ean.isNotEmpty()) {
                sendScan(ean)
                binding.etEAN.text?.clear()
            }
        }

        binding.etEAN.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                binding.btnSendEAN.performClick()
                true
            } else false
        }

        // Cambiar zona
        binding.zonaBar.setOnClickListener {
            showScreen("zonas")
        }

        // Encender/apagar cámara
        binding.btnToggleCamera.setOnClickListener {
            toggleCamera()
        }
    }

    private fun toggleCamera() {
        if (isCameraEnabled) {
            // Apagar cámara
            isCameraEnabled = false
            cameraProvider?.unbindAll()
            binding.cameraOffOverlay.visibility = View.VISIBLE
            binding.scanLine.visibility = View.GONE
            binding.tvStabilityStatus.visibility = View.GONE
            binding.btnToggleCamera.text = "ENCENDER CÁMARA"
        } else {
            // Encender cámara
            isCameraEnabled = true
            binding.cameraOffOverlay.visibility = View.GONE
            binding.scanLine.visibility = View.VISIBLE
            binding.btnToggleCamera.text = "APAGAR CÁMARA"
            startCamera()
        }
    }

    private fun loadSavedData() {
        serverIP = prefs.getString("serverIP", "") ?: ""
        userName = prefs.getString("userName", "") ?: ""
        binding.etServerIP.setText(serverIP)
        binding.etUserName.setText(userName)
    }

    private fun startConnection() {
        CoroutineScope(Dispatchers.Main).launch {
            // Obtener IP del dispositivo
            val networkInfo = NetworkUtils.getDeviceIP(this@MainActivity)

            if (networkInfo != null) {
                binding.tvDeviceIP.text = "Tu IP: ${networkInfo.ip}"
                binding.tvConnectionStatus.text = "Buscando servidor en ${networkInfo.subnet}*"

                // Si hay IP guardada, probar primero
                if (serverIP.isNotEmpty()) {
                    binding.tvConnectionStatus.text = "Conectando a $serverIP..."
                    if (NetworkUtils.testConnection(serverIP)) {
                        connectToServer(serverIP)
                        return@launch
                    }
                }

                // Buscar servidor en la red
                val foundServer = NetworkUtils.findServer(networkInfo.subnet) { progress ->
                    binding.tvConnectionStatus.text = "Buscando servidor... $progress%"
                }

                if (foundServer != null) {
                    serverIP = foundServer
                    prefs.edit().putString("serverIP", serverIP).apply()
                    binding.etServerIP.setText(serverIP)
                    connectToServer(serverIP)
                } else {
                    binding.tvConnectionStatus.text = "Servidor no encontrado"
                    binding.progressConnect.visibility = View.GONE
                    binding.btnConnect.visibility = View.VISIBLE
                }
            } else {
                binding.tvConnectionStatus.text = "No hay conexión WiFi"
                binding.tvDeviceIP.text = ""
                binding.progressConnect.visibility = View.GONE
                binding.btnConnect.visibility = View.VISIBLE
            }
        }
    }

    private fun connectToServer(ip: String) {
        serverIP = if (ip.contains(":")) ip else "$ip:8080"
        prefs.edit().putString("serverIP", serverIP).apply()

        webSocket = WebSocketClient(
            onMessage = { handleMessage(it) },
            onConnected = {
                runOnUiThread {
                    binding.tvConnectionStatus.text = "Conectado a $serverIP"
                    binding.progressConnect.visibility = View.GONE

                    if (userName.isNotEmpty()) {
                        registerUser()
                    } else {
                        showScreen("login")
                    }
                }
            },
            onDisconnected = {
                runOnUiThread {
                    Toast.makeText(this, "Desconectado del servidor", Toast.LENGTH_SHORT).show()
                }
            }
        )

        webSocket?.connect(serverIP)
    }

    private fun handleMessage(json: JsonObject) {
        runOnUiThread {
            val tipo = json.get("tipo")?.asString
            Log.d("WS", "Mensaje recibido: $tipo")

            when (tipo) {
                "estado_inicial" -> {
                    // Servidor conectado, mostrar login o registrar si ya hay nombre
                    Log.d("WS", "Estado inicial recibido")
                    if (userName.isNotEmpty()) {
                        registerUser()
                    } else {
                        showScreen("login")
                    }
                }

                "registrado" -> {
                    // Registro exitoso, pedir zonas
                    val data = json.getAsJsonObject("data")
                    visitorId = data?.get("id")?.asString ?: ""
                    Log.d("WS", "Registrado con ID: $visitorId")
                    requestZonas()
                }

                "lista_zonas" -> {
                    val data = json.getAsJsonObject("data")
                    val zonasArray = data?.getAsJsonArray("zonas")
                    zonas.clear()
                    zonasArray?.forEach { z ->
                        val obj = z.asJsonObject
                        zonas.add(Zona(
                            id = obj.get("id").asString,
                            nombre = obj.get("nombre").asString,
                            items = obj.get("totalItems")?.asInt ?: 0
                        ))
                    }
                    Log.d("WS", "Zonas recibidas: ${zonas.size}")
                    updateZonasList()

                    // Solo mostrar pantalla de zonas si no hay zona seleccionada
                    if (currentZona == null) {
                        showScreen("zonas")
                    }
                }

                "zona_creada" -> {
                    val data = json.getAsJsonObject("data")
                    val zonaId = data?.get("zonaId")?.asString ?: return@runOnUiThread
                    val nombre = data.get("nombre")?.asString ?: "Nueva zona"
                    val newZona = Zona(
                        id = zonaId,
                        nombre = nombre,
                        items = 0
                    )
                    zonas.add(newZona)
                    updateZonasList()
                    selectZona(newZona)
                }

                "zona_asignada" -> {
                    val data = json.getAsJsonObject("data")
                    Log.d("WS", "Zona asignada: ${data?.get("zonaId")?.asString}")
                    showScreen("scanner")
                    startCamera()
                }

                "escaneo_ok" -> {
                    scanCount++
                    binding.tvScanCount.text = scanCount.toString()

                    val data = json.getAsJsonObject("data")
                    val item = data?.getAsJsonObject("item")
                    val existeEnMaestro = item?.get("existeEnMaestro")?.asBoolean ?: false

                    binding.tvLastEAN.text = item?.get("ean")?.asString ?: "-"
                    binding.tvLastDesc.text = item?.get("descripcion")?.asString ?: "Producto escaneado"
                    binding.tvLastQty.text = "x${item?.get("cantidad")?.asInt ?: 1}"
                    binding.lastScanContainer.visibility = View.VISIBLE

                    // Sonido según si existe en maestra
                    if (existeEnMaestro) {
                        playSuccessSound()
                        binding.tvLastDesc.setTextColor(ContextCompat.getColor(this, R.color.text_secondary))
                    } else {
                        playWarningSound()
                        binding.tvLastDesc.setTextColor(ContextCompat.getColor(this, R.color.warning))
                    }

                    vibrate()
                }

                "error" -> {
                    val error = json.get("mensaje")?.asString ?: "Error desconocido"
                    Toast.makeText(this, error, Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun registerUser() {
        val msg = JsonObject().apply {
            addProperty("tipo", "registrar_escaner")
            add("data", JsonObject().apply {
                addProperty("nombre", userName)
            })
        }
        Log.d("WS", "Enviando registro: $userName")
        webSocket?.send(msg)
    }

    private fun requestZonas() {
        val msg = JsonObject().apply {
            addProperty("tipo", "obtener_zonas")
        }
        webSocket?.send(msg)
    }

    private fun createZona(nombre: String) {
        // Crear zona via HTTP POST
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val client = okhttp3.OkHttpClient()
                val json = JsonObject().apply {
                    addProperty("nombre", nombre)
                    addProperty("auditorNombre", userName)
                    addProperty("auditorNombreNormalizado", userName.lowercase().trim())
                }
                val body = okhttp3.RequestBody.Companion.create(
                    "application/json".toMediaType(),
                    json.toString()
                )
                val request = okhttp3.Request.Builder()
                    .url("http://$serverIP/api/zona/crear")
                    .post(body)
                    .build()

                val response = client.newCall(request).execute()
                Log.d("HTTP", "Crear zona response: ${response.code}")

                if (response.isSuccessful) {
                    // El servidor enviará zona_creada via WebSocket
                    // También pedimos actualizar la lista
                    withContext(Dispatchers.Main) {
                        requestZonas()
                    }
                } else {
                    withContext(Dispatchers.Main) {
                        Toast.makeText(this@MainActivity, "Error al crear zona", Toast.LENGTH_SHORT).show()
                    }
                }
            } catch (e: Exception) {
                Log.e("HTTP", "Error creando zona", e)
                withContext(Dispatchers.Main) {
                    Toast.makeText(this@MainActivity, "Error: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun selectZona(zona: Zona) {
        currentZona = zona
        binding.tvCurrentZona.text = zona.nombre
        scanCount = zona.items
        binding.tvScanCount.text = scanCount.toString()

        val msg = JsonObject().apply {
            addProperty("tipo", "asignar_zona")
            add("data", JsonObject().apply {
                addProperty("escanerId", visitorId)
                addProperty("zonaId", zona.id)
            })
        }
        Log.d("WS", "Seleccionando zona: ${zona.nombre} con escanerId: $visitorId")
        webSocket?.send(msg)
    }

    private fun sendScan(ean: String) {
        if (currentZona == null) {
            Toast.makeText(this, "Selecciona una zona primero", Toast.LENGTH_SHORT).show()
            return
        }

        val msg = JsonObject().apply {
            addProperty("tipo", "escanear")
            add("data", JsonObject().apply {
                addProperty("escanerId", visitorId)
                addProperty("ean", ean)
            })
        }
        Log.d("WS", "Escaneando: $ean")
        webSocket?.send(msg)
    }

    private fun updateZonasList() {
        binding.rvZonas.layoutManager = LinearLayoutManager(this)
        binding.rvZonas.adapter = ZonasAdapter(zonas) { zona ->
            selectZona(zona)
        }
    }

    private fun showScreen(screen: String) {
        binding.screenConnect.visibility = if (screen == "connect") View.VISIBLE else View.GONE
        binding.screenLogin.visibility = if (screen == "login") View.VISIBLE else View.GONE
        binding.screenZonas.visibility = if (screen == "zonas") View.VISIBLE else View.GONE
        binding.screenScanner.visibility = if (screen == "scanner") View.VISIBLE else View.GONE

        if (screen == "zonas") {
            binding.tvWelcome.text = "Hola, $userName"
        }
        if (screen == "scanner") {
            binding.tvScannerUser.text = userName
        }
    }

    private fun startCamera() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), 100)
            return
        }

        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            cameraProvider = cameraProviderFuture.get()

            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(binding.cameraPreview.surfaceProvider)
            }

            val imageAnalyzer = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also {
                    it.setAnalyzer(cameraExecutor, BarcodeAnalyzer { barcode ->
                        runOnUiThread {
                            val now = System.currentTimeMillis()
                            // Solo escanear si la cámara está activa, estable y pasó el delay
                            if (isCameraEnabled && isStable && now - lastScanTime > SCAN_DELAY) {
                                lastScanTime = now
                                sendScan(barcode)
                            }
                        }
                    })
                }

            try {
                cameraProvider?.unbindAll()
                cameraProvider?.bindToLifecycle(
                    this,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    imageAnalyzer
                )
            } catch (e: Exception) {
                Log.e("Camera", "Error starting camera", e)
            }

        }, ContextCompat.getMainExecutor(this))
    }

    private fun vibrate() {
        val vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator.vibrate(VibrationEffect.createOneShot(50, VibrationEffect.DEFAULT_AMPLITUDE))
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(50)
        }
    }

    private fun hideKeyboard() {
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(binding.root.windowToken, 0)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 100 && grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
        webSocket?.disconnect()
        toneGenerator?.release()
        toneGenerator = null
    }
}

data class Zona(
    val id: String,
    val nombre: String,
    val items: Int
)
