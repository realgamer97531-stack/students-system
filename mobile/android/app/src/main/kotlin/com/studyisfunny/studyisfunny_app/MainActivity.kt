package com.studyisfunny.studyisfunny_app

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // شبكة الأجهزة أوفلاين (Nearby Connections)
        MeshPlugin(applicationContext, flutterEngine.dartExecutor.binaryMessenger)
    }
}
