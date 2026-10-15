package com.studyisfunny.studyisfunny_app

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.BandwidthInfo
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * شبكة الأجهزة أوفلاين: جسر بين Flutter و Google Nearby Connections.
 * Nearby بيدور على الأجهزة اللي جنبه بالبلوتوث وبيحول لوحده لـ Wi-Fi Direct لو أسرع،
 * و P2P_CLUSTER بيسمح لكل جهاز يتوصل بأكتر من جهاز في نفس الوقت (شبكة مش نجمة).
 * كل المنطق (مين يتوصل بمين، تبادل البيانات، التأكد من المفتاح) في Dart — هنا النقل بس.
 */
class MeshPlugin(private val context: Context, messenger: BinaryMessenger) : MethodChannel.MethodCallHandler, EventChannel.StreamHandler {
    private val client: ConnectionsClient = Nearby.getConnectionsClient(context)
    private val main = Handler(Looper.getMainLooper())
    private var events: EventChannel.EventSink? = null
    private var localName = ""
    private var serviceId = ""

    init {
        MethodChannel(messenger, "sf/mesh").setMethodCallHandler(this)
        EventChannel(messenger, "sf/mesh/events").setStreamHandler(this)
    }

    override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) { events = sink }
    override fun onCancel(arguments: Any?) { events = null }

    private fun emit(vararg pairs: Pair<String, Any?>) {
        val map = hashMapOf<String, Any?>(*pairs)
        main.post { events?.success(map) }
    }

    private val payloadCallback = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            val bytes = payload.asBytes() ?: return
            emit("type" to "payload", "id" to endpointId, "data" to bytes)
        }
        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
    }

    private val lifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            // Nearby بيشفر الاتصال لوحده؛ التأكد إن الجهاز تبعنا بيحصل بعد كده بمفتاح الشبكة (في Dart)
            client.acceptConnection(endpointId, payloadCallback)
            emit("type" to "initiated", "id" to endpointId, "name" to info.endpointName, "incoming" to info.isIncomingConnection)
        }
        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            emit("type" to "result", "id" to endpointId, "ok" to result.status.isSuccess, "code" to result.status.statusCode)
        }
        override fun onDisconnected(endpointId: String) {
            emit("type" to "disconnected", "id" to endpointId)
        }
        override fun onBandwidthChanged(endpointId: String, info: BandwidthInfo) {
            emit("type" to "bandwidth", "id" to endpointId, "quality" to info.quality)
        }
    }

    private val discovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            emit("type" to "found", "id" to endpointId, "name" to info.endpointName)
        }
        override fun onEndpointLost(endpointId: String) {
            emit("type" to "lost", "id" to endpointId)
        }
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "start" -> {
                localName = call.argument<String>("name") ?: "device"
                serviceId = call.argument<String>("serviceId") ?: "com.studyisfunny.mesh"
                startService(call.argument<String>("notice") ?: "")
                startRadio(result)
            }
            "restart" -> {
                client.stopAdvertising()
                client.stopDiscovery()
                startRadio(result)
            }
            "stop" -> {
                client.stopAdvertising()
                client.stopDiscovery()
                client.stopAllEndpoints()
                context.stopService(Intent(context, MeshService::class.java))
                result.success(true)
            }
            "connect" -> {
                val id = call.argument<String>("id") ?: return result.error("args", "id", null)
                client.requestConnection(localName, id, lifecycle)
                    .addOnSuccessListener { result.success(true) }
                    .addOnFailureListener { e -> result.success(false); emit("type" to "error", "where" to "connect", "id" to id, "message" to (e.message ?: "")) }
            }
            "disconnect" -> {
                client.disconnectFromEndpoint(call.argument<String>("id") ?: "")
                result.success(true)
            }
            "send" -> {
                val id = call.argument<String>("id") ?: return result.error("args", "id", null)
                val data = call.argument<ByteArray>("data") ?: return result.error("args", "data", null)
                client.sendPayload(id, Payload.fromBytes(data))
                    .addOnSuccessListener { result.success(true) }
                    .addOnFailureListener { result.success(false) }
            }
            "maxBytes" -> result.success(ConnectionsClient.MAX_BYTES_DATA_SIZE)
            else -> result.notImplemented()
        }
    }

    private fun startRadio(result: MethodChannel.Result) {
        val strategy = Strategy.P2P_CLUSTER
        var pending = 2
        var error: String? = null
        val done = { e: Exception? ->
            if (e != null && !(e.message ?: "").contains("8001")) error = e.message // 8001 = شغال أصلًا
            pending -= 1
            if (pending == 0) {
                if (error == null) result.success(true) else result.error("radio", error, null)
            }
        }
        client.startAdvertising(localName, serviceId, lifecycle, AdvertisingOptions.Builder().setStrategy(strategy).build())
            .addOnSuccessListener { done(null) }
            .addOnFailureListener { e -> done(e) }
        client.startDiscovery(serviceId, discovery, DiscoveryOptions.Builder().setStrategy(strategy).build())
            .addOnSuccessListener { done(null) }
            .addOnFailureListener { e -> done(e) }
    }

    // خدمة في المقدمة: عشان الشبكة تفضل شغالة والشاشة مقفولة أو التطبيق في الخلفية
    private fun startService(notice: String) {
        val intent = Intent(context, MeshService::class.java).putExtra("notice", notice)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        } catch (e: Exception) {
            emit("type" to "error", "where" to "service", "message" to (e.message ?: ""))
        }
    }
}
