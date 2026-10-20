package com.studyisfunny.studyisfunny_app

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress

/**
 * الاتصال بالواي فاي اللي برنامج الكمبيوتر بيعمله (من غير راوتر ولا نت).
 *  - بيدور على اسم الشبكة (من مفتاح الشبكة) وأول ما يلاقيها بيدخلها كشبكة "محلية" للتطبيق بس
 *    (WifiNetworkSpecifier) — نت الموبايل (الداتا) بيفضل شغال عادي للرفع
 *  - Dart (lan_transport) مش بيعرف يبعت على الشبكة دي لأنها مش الشبكة الأساسية، فهنا بنرد على
 *    رسايل اكتشاف الكمبيوتر بسوكيت مربوط بالشبكة دي: {"t":"!","adv":...,"tcp":بورت Dart}
 *    والكمبيوتر بيفتح الاتصال (TCP) على سيرفر Dart — والرد على اتصال جاي بيرجع من نفس الشبكة لوحده
 */
class PcWifiLink(private val context: Context, private val emit: (Map<String, Any?>) -> Unit) {
    private val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val main = Handler(Looper.getMainLooper())

    private var ssid = ""
    private var password = ""
    @Volatile private var advert = ""
    @Volatile private var tcpPort = 0
    private var active = false
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var network: Network? = null
    private var socket: DatagramSocket? = null
    private var state = "off"
    private var nextAutoRequest = 0L
    private var lastScan = 0L
    private var lastLegacy = 0L

    private val ticker = Runnable { tick() }

    fun join(ssid: String, password: String, advert: String, tcpPort: Int, force: Boolean) {
        this.advert = advert
        this.tcpPort = tcpPort
        if (active && ssid == this.ssid && password == this.password) {
            if (force && network == null) { nextAutoRequest = 0; request(true) }
            return
        }
        leave()
        this.ssid = ssid
        this.password = password
        active = true
        nextAutoRequest = 0
        if (force) request(true)
        tick()
    }

    fun leave() {
        active = false
        main.removeCallbacks(ticker)
        callback?.let { try { cm.unregisterNetworkCallback(it) } catch (e: Exception) {} }
        callback = null
        detach()
        setState("off")
    }

    // "name" = الحالة (Dart بيقرا الأحداث كـ MeshEvent)
    fun status(): Map<String, Any?> = mapOf("type" to "pcwifi", "name" to state, "ssid" to ssid)

    private fun setState(s: String) {
        if (s == state) return
        state = s
        emit(status())
    }

    private fun tick() {
        if (!active) return
        if (network == null) {
            val existing = findExisting()
            when {
                existing != null -> attach(existing)
                callback != null -> {} // طلب شغال — مستنيين
                ssidVisible() -> request(false)
                else -> setState("searching")
            }
        } else {
            announce()
        }
        main.postDelayed(ticker, 8000)
    }

    /** الموبايل داخل شبكة الكمبيوتر أصلًا (دخلها يدوي أو أندرويد قديم) */
    private fun findExisting(): Network? {
        return try {
            cm.allNetworks.firstOrNull { n ->
                val caps = cm.getNetworkCapabilities(n)
                val props = cm.getLinkProperties(n)
                caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
                    props != null && props.linkAddresses.any { a -> a.address is Inet4Address && a.address.hostAddress?.startsWith("192.168.137.") == true }
            }
        } catch (e: Exception) { null }
    }

    @SuppressLint("MissingPermission")
    private fun ssidVisible(): Boolean {
        return try {
            val now = System.currentTimeMillis()
            if (now - lastScan > 30000) {
                lastScan = now
                @Suppress("DEPRECATION") wifi.startScan()
            }
            wifi.scanResults.any { r ->
                @Suppress("DEPRECATION") val name = r.SSID
                name == ssid
            }
        } catch (e: Exception) { false }
    }

    private fun request(manual: Boolean) {
        val now = System.currentTimeMillis()
        if (!manual && now < nextAutoRequest) return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            legacyJoin()
            return
        }
        if (callback != null) return
        try {
            val spec = WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa2Passphrase(password).build()
            val req = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .setNetworkSpecifier(spec)
                .build()
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(n: Network) { main.post { if (active) attach(n) } }
                override fun onLost(n: Network) { main.post { if (network == n) { detach(); setState("searching") } } }
                override fun onUnavailable() {
                    main.post {
                        callback = null
                        // اتلغى أو ملقاش الشبكة: منسألش تاني على طول (الرسالة بتضايق)
                        nextAutoRequest = System.currentTimeMillis() + 3 * 60 * 1000
                        if (active) setState("searching")
                    }
                }
            }
            callback = cb
            setState("connecting")
            cm.requestNetwork(req, cb, 60000)
        } catch (e: Exception) {
            callback = null
            nextAutoRequest = now + 60 * 1000
            emit(mapOf("type" to "pcwifi", "name" to "error", "ssid" to ssid, "message" to (e.message ?: "")))
        }
    }

    @Suppress("DEPRECATION")
    @SuppressLint("MissingPermission")
    private fun legacyJoin() {
        val now = System.currentTimeMillis()
        if (now - lastLegacy < 60000) return
        lastLegacy = now
        try {
            if (!wifi.isWifiEnabled) wifi.isWifiEnabled = true
            val quoted = "\"$ssid\""
            val id = wifi.configuredNetworks?.firstOrNull { it.SSID == quoted }?.networkId
                ?: wifi.addNetwork(WifiConfiguration().apply { SSID = quoted; preSharedKey = "\"$password\"" })
            if (id >= 0) { wifi.enableNetwork(id, true); setState("connecting") }
        } catch (e: Exception) {}
    }

    private fun attach(n: Network) {
        if (network == n && socket != null) return
        detach()
        network = n
        val s = try {
            DatagramSocket(null).apply {
                reuseAddress = true
                broadcast = true
                try { bind(InetSocketAddress(47821)) } catch (e: Exception) { /* Dart ماسك البورت */ }
                if (!isBound) bind(InetSocketAddress(0))
                n.bindSocket(this)
            }
        } catch (e: Exception) {
            emit(mapOf("type" to "pcwifi", "name" to "error", "ssid" to ssid, "message" to (e.message ?: "")))
            null
        }
        socket = s
        setState("connected")
        if (s == null) return
        Thread({ receiveLoop(s) }, "sf-pc-wifi").apply { isDaemon = true; start() }
        announce()
    }

    private fun detach() {
        network = null
        try { socket?.close() } catch (e: Exception) {}
        socket = null
    }

    private fun message(t: String) = JSONObject().put("t", t).put("adv", advert).put("tcp", tcpPort).toString().toByteArray(Charsets.UTF_8)

    /** بنعرّف الكمبيوتر بنفسنا (لو الفايروول بتاعه سايبها تعدي) — الأساس إننا بنرد على اكتشافه */
    private fun announce() {
        val s = socket ?: return
        if (tcpPort == 0) return
        Thread {
            try {
                val data = message("?")
                s.send(DatagramPacket(data, data.size, InetAddress.getByName("192.168.137.1"), 47821))
                s.send(DatagramPacket(data, data.size, InetAddress.getByName("192.168.137.255"), 47821))
            } catch (e: Exception) {}
        }.start()
    }

    private fun receiveLoop(s: DatagramSocket) {
        val buf = ByteArray(4096)
        while (!s.isClosed) {
            try {
                val packet = DatagramPacket(buf, buf.size)
                s.receive(packet)
                val msg = JSONObject(String(packet.data, 0, packet.length, Charsets.UTF_8))
                if (msg.optString("t") != "?" || msg.optString("adv") == advert || tcpPort == 0) continue
                val reply = message("!")
                s.send(DatagramPacket(reply, reply.size, packet.address, packet.port))
            } catch (e: Exception) {
                if (s.isClosed) break
            }
        }
    }
}
