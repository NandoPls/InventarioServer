package com.inventario.scanner

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import okhttp3.*
import java.util.concurrent.TimeUnit

class WebSocketClient(
    private val onMessage: (JsonObject) -> Unit,
    private val onConnected: () -> Unit,
    private val onDisconnected: () -> Unit
) {
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .build()
    private val gson = Gson()

    private var serverUrl: String = ""

    fun connect(serverIP: String) {
        serverUrl = "ws://$serverIP/ws"
        Log.d("WebSocket", "Conectando a $serverUrl")

        val request = Request.Builder()
            .url(serverUrl)
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d("WebSocket", "Conectado")
                onConnected()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                Log.d("WebSocket", "Mensaje: $text")
                try {
                    val json = gson.fromJson(text, JsonObject::class.java)
                    onMessage(json)
                } catch (e: Exception) {
                    Log.e("WebSocket", "Error parsing message", e)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.d("WebSocket", "Cerrando: $reason")
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d("WebSocket", "Cerrado: $reason")
                onDisconnected()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e("WebSocket", "Error: ${t.message}")
                onDisconnected()
            }
        })
    }

    fun send(message: JsonObject) {
        val text = gson.toJson(message)
        Log.d("WebSocket", "Enviando: $text")
        webSocket?.send(text)
    }

    fun disconnect() {
        webSocket?.close(1000, "Usuario desconectado")
        webSocket = null
    }

    fun isConnected(): Boolean {
        return webSocket != null
    }
}
