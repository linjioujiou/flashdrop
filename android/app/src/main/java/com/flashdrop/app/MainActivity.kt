package com.flashdrop.app

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.View
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.progressindicator.LinearProgressIndicator
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var repository: Repository
    private lateinit var prefs: Prefs

    private lateinit var panelSend: View
    private lateinit var panelRecv: View
    private var pickedUri: Uri? = null
    private var pickedName: String = ""
    private var pickedSize: Long = 0
    private var pickedMime: String = "application/octet-stream"
    private var lastKey: String? = null
    private var lastId: String? = null

    private lateinit var fileChip: TextView
    private lateinit var sendProgress: LinearProgressIndicator
    private lateinit var sendStatus: TextView
    private lateinit var resultCard: View
    private lateinit var resultCode: TextView

    private lateinit var recvInput: TextInputEditText
    private lateinit var recvProgress: LinearProgressIndicator
    private lateinit var recvStatus: TextView
    private lateinit var recvDone: TextView

    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            pickedUri = uri
            val cursor = contentResolver.query(uri, null, null, null, null)
            cursor?.use {
                if (it.moveToFirst()) {
                    val nameIdx = it.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeIdx = it.getColumnIndex(OpenableColumns.SIZE)
                    pickedName = if (nameIdx >= 0) it.getString(nameIdx) else "file"
                    pickedSize = if (sizeIdx >= 0) it.getLong(sizeIdx) else 0L
                }
            }
            pickedMime = contentResolver.getType(uri) ?: "application/octet-stream"
            fileChip.text = "$pickedName · ${Prefs.fmtBytes(pickedSize)}"
        }
    }

    @SuppressLint("SetTextI18n")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        repository = Repository(this)

        panelSend = findViewById(R.id.panel_send)
        panelRecv = findViewById(R.id.panel_recv)

        fileChip = findViewById(R.id.file_chip)
        sendProgress = findViewById(R.id.send_progress)
        sendStatus = findViewById(R.id.send_status)
        resultCard = findViewById(R.id.result_card)
        resultCode = findViewById(R.id.result_code)
        recvInput = findViewById(R.id.code_input)
        recvProgress = findViewById(R.id.recv_progress)
        recvStatus = findViewById(R.id.recv_status)
        recvDone = findViewById(R.id.recv_done)

        findViewById<MaterialButton>(R.id.btn_pick).setOnClickListener { pickFile.launch(arrayOf("*/*")) }
        findViewById<MaterialButton>(R.id.btn_send).setOnClickListener { startSend() }
        findViewById<MaterialButton>(R.id.btn_recv).setOnClickListener { startRecv() }
        findViewById<ImageButton>(R.id.btn_settings).setOnClickListener { showSettings() }
        findViewById<BottomNavigationView>(R.id.bottom_nav).setOnItemSelectedListener { item ->
            panelSend.visibility = if (item.itemId == R.id.nav_send) View.VISIBLE else View.GONE
            panelRecv.visibility = if (item.itemId == R.id.nav_recv) View.VISIBLE else View.GONE
            true
        }

        // 处理系统分享的取件链接/取件码
        val shared = intent?.takeIf { it.action == Intent.ACTION_SEND }?.getStringExtra(Intent.EXTRA_TEXT)
        if (!shared.isNullOrEmpty()) handleIncoming(shared)
    }

    private fun handleIncoming(text: String) {
        // 从分享文本中提取取件码或完整链接（/r/CODE#k=KEY）
        val regex = Regex("(?:/r/|#k=|code=)([A-Z0-9]{4,10})(?:-([A-Za-z0-9_-]{10,80}))?", RegexOption.IGNORE_CASE)
        val m = regex.find(text) ?: return
        findViewById<BottomNavigationView>(R.id.bottom_nav).selectedItemId = R.id.nav_recv
        val parts = StringBuilder(m.groupValues[1].uppercase())
        if (m.groupValues[2].isNotEmpty()) parts.append('-').append(m.groupValues[2])
        if (text.contains("#k=") && m.groupValues[2].isEmpty()) {
            val fk = text.substringAfter("#k=", "")
            if (fk.isNotEmpty()) parts.append('-').append(fk.substringBefore('&'))
        }
        recvInput.setText(parts)
    }

    private fun showSettings() {
        val view = layoutInflater.inflate(R.layout.dialog_settings, null)
        val urlInput = view.findViewById<TextInputEditText>(R.id.url_input)
        val keyInput = view.findViewById<TextInputEditText>(R.id.key_input)
        urlInput.setText(prefs.baseUrl)
        keyInput.setText(prefs.apiKey)
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.settings)
            .setView(view)
            .setPositiveButton("保存") { _, _ ->
                if (!urlInput.text.isNullOrEmpty()) prefs.baseUrl = urlInput.text.toString()
                prefs.apiKey = keyInput.text?.toString() ?: ""
            }
            .setNegativeButton("取消", null)
            .show()
    }

    @SuppressLint("SetTextI18n")
    private fun startSend() {
        val uri = pickedUri ?: return
        val e2e = findViewById<MaterialSwitch>(R.id.e2e_switch).isChecked
        val btn = findViewById<MaterialButton>(R.id.btn_send)
        btn.isEnabled = false
        sendProgress.visibility = View.VISIBLE
        sendProgress.progress = 0
        sendStatus.visibility = View.VISIBLE
        sendStatus.text = "准备中…"
        lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) { repository.send(uri, pickedName, pickedMime, e2e) { pct, msg ->
                    runOnUiThread {
                        sendProgress.progress = pct
                        sendStatus.text = msg
                    }
                } }
                lastId = result.id
                lastKey = result.keyB64
                resultCode.text = result.fullCode
                resultCard.visibility = View.VISIBLE
                sendStatus.text = "上传完成，等待对方接收"
                Toast.makeText(this@MainActivity, "上传完成", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                sendStatus.text = e.message
                Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
            } finally {
                btn.isEnabled = true
            }
        }
    }

    @SuppressLint("SetTextI18n")
    private fun startRecv() {
        val input = recvInput.text?.toString()?.trim()?.uppercase() ?: ""
        if (input.length < 4) {
            Toast.makeText(this, "请输入取件码", Toast.LENGTH_SHORT).show()
            return
        }
        val btn = findViewById<MaterialButton>(R.id.btn_recv)
        btn.isEnabled = false
        recvProgress.visibility = View.VISIBLE
        recvProgress.progress = 0
        recvStatus.visibility = View.VISIBLE
        recvStatus.text = "查询中…"
        recvDone.visibility = View.GONE
        lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    repository.receive(input) { pct, msg ->
                        runOnUiThread {
                            recvProgress.progress = pct
                            recvStatus.text = msg
                        }
                    }
                }
                recvDone.text = "已保存：${result.savedName}（系统下载目录）"
                recvDone.visibility = View.VISIBLE
                Toast.makeText(this@MainActivity, "接收完成，云端副本已删除", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                recvStatus.text = e.message
                Toast.makeText(this@MainActivity, e.message, Toast.LENGTH_LONG).show()
            } finally {
                btn.isEnabled = true
            }
        }
    }
}
