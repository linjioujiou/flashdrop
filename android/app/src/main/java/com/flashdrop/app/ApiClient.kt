package com.flashdrop.app

import android.content.Context
import android.content.SharedPreferences
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/** 闪传 API 客户端（对应 docs/API.md v1）。所有方法为阻塞式，请在协程/线程中调用。 */
class ApiClient(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("flashdrop", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .build()

    var baseUrl: String
        get() = prefs.getString("base_url", "https://flashdrop.15178717703lin.workers.dev")!!.trimEnd('/')
        set(v) = prefs.edit().putString("base_url", v.trimEnd('/')).apply()

    var apiKey: String
        get() = prefs.getString("api_key", "") ?: ""
        set(v) = prefs.edit().putString("api_key", v).apply()

    private fun url(path: String) = baseUrl + path

    private fun post(path: String, body: JSONObject): JSONObject {
        val rb = body.toString().toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url(url(path)).post(rb).build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string() ?: ""
            if (!res.isSuccessful) throw IOException("HTTP ${res.code}: $text")
            return JSONObject(text)
        }
    }

    /** 创建中转任务。返回字段见 docs/API.md §3.1。 */
    fun create(fileName: String, fileSize: Long, mime: String, encrypted: Boolean): JSONObject {
        val body = JSONObject()
            .put("fileName", fileName)
            .put("fileSize", fileSize)
            .put("mimeType", mime)
            .put("encrypted", encrypted)
        val req = Request.Builder().url(url("/api/v1/transfers"))
            .apply { if (apiKey.isNotEmpty()) header("X-Api-Key", apiKey) }
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string() ?: ""
            if (!res.isSuccessful) throw IOException("创建失败 HTTP ${res.code}: $text")
            return JSONObject(text)
        }
    }

    /** 上传单个分片（字节区间），返回是否成功。 */
    fun putPart(url: String, data: ByteArray): Boolean {
        val req = Request.Builder().url(url)
            .put(data.toRequestBody("application/octet-stream".toMediaType()))
            .build()
        http.newCall(req).execute().use { return it.isSuccessful }
    }

    /** 合并分片。 */
    fun complete(completeUrl: String, totalParts: Int): Boolean {
        val req = Request.Builder().url(baseUrl + completeUrl)
            .post("""{"totalParts":$totalParts}""".toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { return it.isSuccessful }
    }

    /** 取件码查询：返回 {kind:"relay", transfer:{...}}。 */
    fun lookup(code: String): JSONObject {
        val req = Request.Builder().url(url("/api/v1/transfers?code=" + code)).get().build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string() ?: ""
            if (!res.isSuccessful) throw IOException("查询失败 HTTP ${res.code}")
            return JSONObject(text)
        }
    }

    /** 确认接收，换取一次性下载地址。 */
    fun accept(id: String, code: String): JSONObject {
        val req = Request.Builder().url(url("/api/v1/transfers/$id/accept"))
            .post("""{"code":"$code"}""".toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string() ?: ""
            if (!res.isSuccessful) throw IOException("接收失败 HTTP ${res.code}: $text")
            return JSONObject(text)
        }
    }

    /** 流式下载：把响应体写到 file，返回是否完整成功。 */
    fun download(url: String, file: File): Boolean {
        val req = Request.Builder().url(url).build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) return false
            res.body?.byteStream()?.use { ins ->
                file.outputStream().use { fos ->
                    val buf = ByteArray(256 * 1024)
                    while (true) {
                        val n = ins.read(buf)
                        if (n <= 0) break
                        fos.write(buf, 0, n)
                    }
                }
            } ?: return false
            return true
        }
    }
}
