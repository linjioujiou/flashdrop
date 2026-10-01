package com.flashdrop.app

import android.content.Context
import java.util.Locale

/** 轻量偏好存储：服务器地址 / API 密钥。 */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("flashdrop", Context.MODE_PRIVATE)
    var baseUrl: String
        get() = sp.getString("base_url", "https://flashdrop.15178717703lin.workers.dev")!!.trimEnd('/')
        set(v) = sp.edit().putString("base_url", v.trimEnd('/')).apply()
    var apiKey: String
        get() = sp.getString("api_key", "") ?: ""
        set(v) = sp.edit().putString("api_key", v).apply()

    companion object {
        fun fmtBytes(n: Long): String {
            if (n < 1024) return "$n B"
            val units = arrayOf("KB", "MB", "GB", "TB")
            var v = n.toDouble(); var i = -1
            do { v /= 1024; i++ } while (v >= 1024 && i < units.size - 1)
            return String.format(Locale.US, "%.1f %s", v, units[i])
        }
    }
}
