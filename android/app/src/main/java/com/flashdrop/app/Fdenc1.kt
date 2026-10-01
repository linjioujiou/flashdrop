package com.flashdrop.app

import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * FDENC1 端到端加密容器（与 Web 端互通，见 docs/API.md §5）。
 *
 * 布局：数据帧（AAD = 块序号 1..N，帧内明文 4MB，Web 发送的末块补零到整块）在前，
 * 元数据帧（AAD = 0，JSON {n:文件名, m:MIME, s:真实大小}）在最后，随后 6 字节魔数 "FDENC1"。
 * 每帧：[4字节小端 帧长][12字节 IV][密文 = 明文 + 16字节 GCM 标签]，帧长不含 IV。
 * 接收端按元数据里的真实大小裁剪掉末块补零。
 */
object Fdenc1 {
    val MAGIC = "FDENC1".toByteArray(Charsets.US_ASCII)
    const val CHUNK = 4 * 1024 * 1024

    fun newKey(): SecretKey {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return SecretKeySpec(bytes, "AES")
    }

    fun keyToB64(key: SecretKey): String =
        android.util.Base64.encodeToString(key.encoded, android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE).trimEnd('=')

    fun keyFromB64(s: String): SecretKey {
        val norm = s.replace('-', '+').replace('_', '/')
        val padded = norm + "=".repeat((4 - norm.length % 4) % 4)
        return SecretKeySpec(android.util.Base64.decode(padded, android.util.Base64.DEFAULT), "AES")
    }

    private fun aad(idx: Int): ByteArray = ByteArray(4).also {
        it[0] = (idx and 0xFF).toByte()
        it[1] = ((idx shr 8) and 0xFF).toByte()
        it[2] = ((idx shr 16) and 0xFF).toByte()
        it[3] = ((idx shr 24) and 0xFF).toByte()
    }

    private fun frame(plain: ByteArray, idx: Int, key: SecretKey): ByteArray {
        val iv = ByteArray(12)
        SecureRandom().nextBytes(iv)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        c.updateAAD(aad(idx))
        val ct = c.doFinal(plain)
        val f = ByteArray(4 + 12 + ct.size)
        f[0] = (ct.size and 0xFF).toByte()
        f[1] = ((ct.size shr 8) and 0xFF).toByte()
        f[2] = ((ct.size shr 16) and 0xFF).toByte()
        f[3] = ((ct.size shr 24) and 0xFF).toByte()
        System.arraycopy(iv, 0, f, 4, 12)
        System.arraycopy(ct, 0, f, 16, ct.size)
        return f
    }

    private fun readLeInt(din: DataInputStream): Int {
        val b1 = din.readByte().toInt() and 0xFF
        val b2 = din.readByte().toInt() and 0xFF
        val b3 = din.readByte().toInt() and 0xFF
        val b4 = din.readByte().toInt() and 0xFF
        return (b4 shl 24) or (b3 shl 16) or (b2 shl 8) or b1
    }

    /** 把文件加密为 FDENC1 容器写到 out，返回密钥（base64url，分享时用）。 */
    fun encryptToContainer(input: File, name: String, mime: String, out: File): SecretKey {
        val key = newKey()
        val metaPlain = JSONObject().put("n", name).put("m", mime).put("s", input.length()).toString().toByteArray()
        DataOutputStream(out.outputStream()).use { dos ->
            dos.write(MAGIC)
            input.inputStream().use { ins ->
                val buf = ByteArray(CHUNK)
                var idx = 1
                while (true) {
                    var read = 0
                    while (read < CHUNK) {
                        val r = ins.read(buf, read, CHUNK - read)
                        if (r <= 0) break
                        read += r
                    }
                    if (read <= 0) break
                    val plain = if (read == CHUNK) buf else buf.copyOf(read)
                    dos.write(frame(plain, idx, key))
                    idx++
                }
                dos.write(frame(metaPlain, 0, key)) // 元数据帧（AAD 0）在最后
            }
            dos.write(MAGIC) // 魔数在容器末尾
        }
        return key
    }

    /** 解密容器到 out 文件（自动裁剪补零），返回元数据 JSON（含原文件名/大小）。 */
    fun decryptContainer(container: File, key: SecretKey, out: File): JSONObject {
        DataInputStream(container.inputStream()).use { din ->
            val head = ByteArray(MAGIC.size)
            din.readFully(head)
            if (!head.contentEquals(MAGIC)) throw IllegalArgumentException("不是有效的加密容器")
            val bodyEnd = container.length().toInt() - MAGIC.size // 末尾 6 字节为魔数
            FileOutputStream(out).use { fos ->
                var idx = 1
                var meta: JSONObject? = null
                var off = MAGIC.size
                while (off < bodyEnd) {
                    val len = readLeInt(din)
                    val iv = ByteArray(12).also { din.readFully(it) }
                    val ct = ByteArray(len).also { din.readFully(it) }
                    off += 4 + 12 + len
                    val isMeta = off == bodyEnd
                    val c = Cipher.getInstance("AES/GCM/NoPadding")
                    c.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv))
                    c.updateAAD(aad(if (isMeta) 0 else idx))
                    val plain = c.doFinal(ct)
                    if (isMeta) {
                        meta = JSONObject(String(plain, Charsets.UTF_8))
                        break
                    }
                    fos.write(plain)
                    idx++
                }
                val m = meta ?: throw IllegalArgumentException("容器缺少元数据帧")
                RandomAccessFile(out, "rw").use { raf -> raf.setLength(m.getLong("s")) }
                return m
            }
        }
    }
}
