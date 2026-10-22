package digital.auxo.lalela

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service that keeps mic capture alive while Lalela is recording,
 * even when the screen is off or the app is backgrounded.
 *
 * WHY THIS EXISTS: Android revokes microphone access from backgrounded apps
 * (Android 9+), and OEM power managers (notably Xiaomi/HyperOS) cache/freeze the
 * process seconds after screen-off. Both stop cpal's AAudio capture dead — the
 * transcript ends the moment the screen turns off. A started foreground service
 * with `foregroundServiceType="microphone"` grants "while-in-use" mic access to
 * the whole process, and a PARTIAL_WAKE_LOCK keeps the CPU from suspending, so
 * the capture thread keeps running until the user stops.
 *
 * The service owns no audio itself — the cpal stream lives in the Rust process
 * (recording.rs). This service is a lifetime anchor: Rust starts it before
 * opening the mic and stops it after the stream closes (both stop paths + the
 * start error path), via a tiny JNI bridge (android.rs) that calls [start]/[stop].
 */
class RecordingService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      ServiceCompat.startForeground(
        this,
        NOTIF_ID,
        buildNotification(),
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        else 0,
      )
      acquireWakeLock()
      Log.i(TAG, "recording foreground service started (mic FGS + wake lock held)")
    } catch (e: Exception) {
      // startForeground with the microphone type throws if RECORD_AUDIO isn't
      // granted (Android 14+). Capture then falls back to foreground-only — the
      // cpal stream in Rust still runs; we just can't survive screen-off. Never
      // crash the process over it.
      Log.w(TAG, "could not start recording foreground service: ${e.message}")
      stopSelf()
    }
    // NOT sticky: the service's life is bound to a live recording that Rust
    // controls explicitly. If the process is ever killed the recording is gone,
    // so there is nothing to restart — a zombie mic FGS + wake lock would be worse.
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    releaseWakeLock()
    Log.i(TAG, "recording foreground service stopped (wake lock released)")
    super.onDestroy()
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
      setReferenceCounted(false)
      // No timeout: a meeting can run for hours. We always release in onDestroy,
      // which the Rust stop paths guarantee is reached.
      acquire()
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  private fun buildNotification(): Notification {
    createChannel()
    // Tap the notification to bring Lalela back to the front.
    val openIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val contentIntent = PendingIntent.getActivity(
      this,
      0,
      openIntent ?: Intent(),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Lalela is recording")
      .setContentText("Recording continues while your screen is off.")
      .setSmallIcon(applicationInfo.icon)
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  private fun createChannel() {
    // minSdk is 26, so a channel is always required. LOW importance = no sound
    // or heads-up; it's an ongoing status, not an alert.
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Recording",
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Shown while Lalela is recording a meeting."
      setShowBadge(false)
    }
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(channel)
  }

  companion object {
    private const val TAG = "LalelaRec"
    private const val CHANNEL_ID = "lalela_recording"
    private const val NOTIF_ID = 1001
    private const val WAKE_LOCK_TAG = "lalela:recording"
    const val ACTION_STOP = "digital.auxo.lalela.STOP_RECORDING"

    /**
     * Start the recording foreground service. Called from Rust (android.rs) via
     * JNI when a capture begins. Uses [ContextCompat.startForegroundService] so
     * the OS honours the 5-second startForeground deadline enforced on 8.0+.
     */
    @JvmStatic
    fun start(context: Context) {
      val intent = Intent(context, RecordingService::class.java)
      ContextCompat.startForegroundService(context, intent)
    }

    /** Stop the service (and release the wake lock). Called from Rust on every
     *  stop path (user stop, cloud stop, and the start error path). */
    @JvmStatic
    fun stop(context: Context) {
      context.stopService(Intent(context, RecordingService::class.java))
    }
  }
}
