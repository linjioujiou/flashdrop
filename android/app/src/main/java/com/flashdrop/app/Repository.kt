package com.flashdrop.app

import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import java.io.File
import java.io.IOException
import java.security.SecureRandom

/** 发送/接收业务流程：分片上传（含 E2E）、下载解密、保存到系统下载目录。 */
class Repository(context: Context) {
    private val appContext = context.applicationContext
    private val api = ApiClient(context)

    data class SendResult(val id: String, val fullCode: String, val keyB64: String?)
    data class RecvResult(val savedName: String)

    private fun copyUriToFile(uri: Uri, out: File): Long {
        appContext.contentResolver.openInputStream(uri)?.use { ins ->
            out.outputStream().use { fos -> ins.copyTo(fos, 1024 * 1024) }
        } ?: throw IOException("无法读取所选文件")
        return out.length()
    }

    /** 发送：E2E 时先加密出容器，再按 8MB 分片上传。onProgress(pct 0-100, msg)。 */
    fun send(uri: Uri, name: String, mime: String, e2e: Boolean, onProgress: (Int, String) -> Unit): SendResult {
        val cache = File(appContext.cacheDir, "upload").apply { mkdirs() }
        val plain = File(cache, "plain.tmp")
        var container: File? = null
        try {
            onProgress(2, "读取文件…")
            copyUriToFile(uri, plain)

            var upload = plain
            var declaredName = name
            var keyB64: String? = null
            if (e2e) {
                onProgress(5, "端到端加密中…")
                container = File(cache, "container.tmp")
                val sk = Fdenc1.encryptToContainer(plain, name, mime, container)
                keyB64 = Fdenc1.keyToB64(sk)
                upload = container
                declaredName = "encrypted.fdenc"
            }

            val created = api.create(declaredName, upload.length(), "application/octet-stream", e2e)
            val id = created.getString("id")
            val claimCode = created.getString("claimCode")
            val totalParts = 1 + (upload.length() - 1) / (8 * 1024 * 1024)

            var part = 1
            var offset = 0L
            val partSize = 8L * 1024 * 1024
            upload.inputStream().use { ins ->
                while (offset < upload.length()) {
                    val size = minOf(partSize, upload.length() - offset).toInt()
                    val data = ByteArray(size)
                    var read = 0
                    while (read < size) {
                        val r = ins.read(data, read, size - read)
                        if (r <= 0) break
                        read += r
                    }
                    var ok = false
                    var attempt = 0
                    while (!ok && attempt < 2) {
                        ok = api.putPart(created.getString("partUrl").replace("{n}", "$part"), data.copyOf(read))
                        attempt++
                    }
                    if (!ok) throw IOException("分片 $part 上传失败")
                    offset += read
                    part++
                    onProgress((5 + 90 * offset / upload.length()).toInt(), "上传中…")
                }
            }

            if (!api.complete(created.getString("completeUrl"), totalParts.toInt())) {
                throw IOException("合并分片失败")
            }
            onProgress(98, "完成")

            val fullCode = claimCode + (keyB64?.let { "-$it" } ?: "")
            return SendResult(id, fullCode, keyB64)
        } finally {
            plain.delete()
            container?.delete()
        }
    }

    /** 接收：查询 → 确认 → 下载 →（E2E）解密 → 保存到系统下载目录。 */
    fun receive(rawInput: String, onProgress: (Int, String) -> Unit): RecvResult {
        val input = rawInput.trim()
        // 输入可以是：6 位码、完整取件码（CODE-KEY）、或分享链接
        val linkRegex = Regex("(?:/r/|#k=)([A-Z0-9]{4,10})(?:-([A-Za-z0-9_-]{10,80}))?", RegexOption.IGNORE_CASE)
        val code: String
        var keyB64: String? = null
        val linkMatch = linkRegex.find(input)
        if (input.contains("#k=")) {
            code = linkMatch?.groupValues?.get(1)?.uppercase() ?: input.substringBefore('-').uppercase()
            keyB64 = input.substringAfter("#k=", "").substringBefore('&').ifEmpty { null }
        } else if (linkMatch != null && input.contains("/r/")) {
            code = linkMatch.groupValues[1].uppercase()
            keyB64 = linkMatch.groupValues.getOrNull(2)?.ifEmpty { null }
        } else if (input.contains('-')) {
            code = input.substringBefore('-').uppercase()
            keyB64 = input.substringAfter('-')
        } else {
            code = input.uppercase()
        }

        onProgress(5, "查询任务…")
        val lookup = api.lookup(code)
        val t = lookup.getJSONObject("transfer")
        val encrypted = t.optBoolean("encrypted", false)
        if (encrypted && keyB64 == null) {
            throw IOException("该文件已端到端加密：请使用完整取件码或含密钥的分享链接")
        }
        val id = t.getString("id")

        onProgress(15, "确认接收…")
        val acc = api.accept(id, code)
        val fileName = acc.optString("fileName", "file")

        val cache = File(appContext.cacheDir, "download").apply { mkdirs() }
        val cipherFile = File(cache, "cipher.tmp")
        try {
            onProgress(20, "下载中…")
            if (!api.download(acc.getString("downloadUrl"), cipherFile)) throw IOException("下载失败")

            var outFile = cipherFile
            var finalName = fileName
            if (encrypted) {
                onProgress(75, "解密中…")
                if (keyB64 == null) throw IOException("缺少解密密钥")
                val k = Fdenc1.keyFromB64(keyB64)
                val plain = File(cache, "plain.tmp")
                val meta = Fdenc1.decryptContainer(cipherFile, k, plain)
                outFile = plain
                finalName = meta.optString("n", fileName).ifEmpty { fileName }
                onProgress(92, "解密完成，正在保存…")
            } else {
                onProgress(92, "正在保存…")
            }

            val savedName = saveToDownloads(appContext, outFile, finalName, t.optString("mimeType", acc.optString("mimeType", "application/octet-stream")))
            return RecvResult(savedName)
        } finally {
            cipherFile.delete()
            // 保留解密产物已被复制进媒体库，临时文件清理
            if (encrypted) File(cache, "plain.tmp").delete()
        }
    }
}

/** 把文件保存到系统「下载」目录（MediaStore），返回最终文件名。 */
fun saveToDownloads(context: Context, src: File, name: String, mime: String): String {
    val resolver = context.contentResolver
    val values = android.content.ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, name)
        put(MediaStore.Downloads.MIME_TYPE, mime)
        put(MediaStore.Downloads.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS)
    }
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: throw IOException("无法创建下载条目")
    resolver.openOutputStream(uri)?.use { os -> src.inputStream().use { ins -> ins.copyTo(os, 1024 * 1024) } }
        ?: throw IOException("无法写入下载目录")
    return name
}

