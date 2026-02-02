package com.inventario.scanner

import android.content.Context
import android.net.wifi.WifiManager
import kotlinx.coroutines.*
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.URL
import java.util.Collections

object NetworkUtils {

    data class NetworkInfo(
        val ip: String,
        val subnet: String
    )

    /**
     * Obtiene la IP del dispositivo de la red WiFi actual
     */
    fun getDeviceIP(context: Context): NetworkInfo? {
        // Método 1: WifiManager
        try {
            val wifiManager = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val wifiInfo = wifiManager.connectionInfo
            val ipInt = wifiInfo.ipAddress

            if (ipInt != 0) {
                val ip = String.format(
                    "%d.%d.%d.%d",
                    ipInt and 0xff,
                    ipInt shr 8 and 0xff,
                    ipInt shr 16 and 0xff,
                    ipInt shr 24 and 0xff
                )

                if (ip != "0.0.0.0") {
                    val parts = ip.split(".")
                    if (parts.size == 4) {
                        val subnet = "${parts[0]}.${parts[1]}.${parts[2]}."
                        return NetworkInfo(ip, subnet)
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }

        // Método 2: NetworkInterface
        try {
            val interfaces = Collections.list(NetworkInterface.getNetworkInterfaces())
            for (networkInterface in interfaces) {
                if (!networkInterface.isUp || networkInterface.isLoopback) continue

                val addresses = Collections.list(networkInterface.inetAddresses)
                for (address in addresses) {
                    if (address.isLoopbackAddress) continue

                    val ip = address.hostAddress ?: continue
                    if (ip.contains(":")) continue // Skip IPv6

                    if (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) {
                        val parts = ip.split(".")
                        if (parts.size == 4) {
                            val subnet = "${parts[0]}.${parts[1]}.${parts[2]}."
                            return NetworkInfo(ip, subnet)
                        }
                    }
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }

        return null
    }

    /**
     * Busca el servidor en la red local
     */
    suspend fun findServer(subnet: String, onProgress: (Int) -> Unit): String? = withContext(Dispatchers.IO) {
        val jobs = mutableListOf<Deferred<String?>>()

        // Escanear todas las IPs del subnet (1-254)
        for (i in 1..254) {
            val ip = "$subnet$i"
            jobs.add(async {
                if (checkServer(ip)) ip else null
            })

            // Actualizar progreso cada 10 IPs
            if (i % 10 == 0) {
                withContext(Dispatchers.Main) {
                    onProgress((i * 100) / 254)
                }
            }
        }

        // Esperar resultados
        for (job in jobs) {
            val result = job.await()
            if (result != null) {
                // Cancelar los demás jobs
                jobs.forEach { it.cancel() }
                return@withContext "$result:8080"
            }
        }

        return@withContext null
    }

    /**
     * Verifica si hay un servidor en la IP dada
     */
    private fun checkServer(ip: String): Boolean {
        return try {
            val url = URL("http://$ip:8080/api/ping")
            val connection = url.openConnection() as HttpURLConnection
            connection.connectTimeout = 500
            connection.readTimeout = 500
            connection.requestMethod = "GET"

            val responseCode = connection.responseCode
            connection.disconnect()

            responseCode == 200
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Prueba conexión a un servidor específico
     */
    suspend fun testConnection(serverIP: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val ip = if (serverIP.contains(":")) serverIP else "$serverIP:8080"
            val url = URL("http://$ip/api/ping")
            val connection = url.openConnection() as HttpURLConnection
            connection.connectTimeout = 3000
            connection.readTimeout = 3000
            connection.requestMethod = "GET"

            val responseCode = connection.responseCode
            connection.disconnect()

            responseCode == 200
        } catch (e: Exception) {
            false
        }
    }
}
