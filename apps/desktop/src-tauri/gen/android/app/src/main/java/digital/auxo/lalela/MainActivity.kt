package digital.auxo.lalela

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  // Back button / gesture. wry's default handler FINISHES the activity once the
  // WebView has no history (our SPA keeps its views in React state, so that is
  // almost always). Finishing tears the Rust runtime down inside a live process,
  // which aborts with "FORTIFY: pthread_mutex_lock called on a destroyed mutex"
  // (a native crash that Play vitals counts) and would kill a running recording.
  // Instead: walk WebView history if there is any, else send the task to the
  // background like Home does. The process (and any recording + its foreground
  // service) keeps running; reopening Lalela resumes where the user left off.
  override val handleBackNavigation: Boolean = false
  private var webView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val wv = webView
        if (wv != null && wv.canGoBack()) {
          wv.goBack()
        } else {
          moveTaskToBack(true)
        }
      }
    })
    // RECORD_AUDIO is a runtime ("dangerous") permission on Android 6+ (API 23+),
    // so the manifest entry alone is not enough — it must be granted at run time
    // before cpal's AAudio input stream can open (Phase 2 mic capture). Request it
    // up front so the grant is settled by the time the user taps record. Denial is
    // handled gracefully downstream: the cpal stream fails to open and the
    // recording view shows its mic-error banner (the same path as a desktop mic
    // failure) — no crash. minSdk is 26, so the version guard is defensive.
    //
    // POST_NOTIFICATIONS (Android 13+, also "dangerous") is requested in the SAME
    // prompt so the "Lalela is recording" foreground-service notification can show.
    // It is NOT load-bearing: if the user denies it, the foreground service still
    // runs and mic capture still survives screen-off — only the notification is
    // suppressed. So we never block recording on it.
    val wanted = mutableListOf<String>()
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      wanted.add(Manifest.permission.RECORD_AUDIO)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      wanted.add(Manifest.permission.POST_NOTIFICATIONS)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && wanted.isNotEmpty()) {
      ActivityCompat.requestPermissions(this, wanted.toTypedArray(), 0)
    }
  }
}
