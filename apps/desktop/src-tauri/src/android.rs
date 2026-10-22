//! Android-only: JNI bridge to the `RecordingService` foreground service.
//!
//! Recording lives in Rust (`recording.rs`), but Android only lets a *foreground
//! service* hold the mic while the app is backgrounded / the screen is off, and
//! only a wake lock keeps the CPU from suspending mid-capture. That service is
//! Kotlin (`RecordingService.kt`); this module is the thin bridge that starts and
//! stops it around a capture.
//!
//! We use JNI directly rather than a Tauri mobile plugin: the `JavaVM` and the
//! Android `Context` (Activity) are already published by the wry/tao runtime into
//! tao's context store (`main_android_context()`), so calling two static Kotlin
//! methods is far less machinery than registering a whole plugin. (`ndk_context`
//! looks like the obvious choice but is NEVER initialised under Tauri/wry — cpal's
//! AAudio backend is pure-C and doesn't need it — so it panics "not initialized".)
//!
//! Every call is best-effort: a JNI failure is logged and swallowed so a bridge
//! hiccup can never crash a recording (worst case falls back to foreground-only,
//! exactly the pre-service behaviour).

use jni::errors::Error as JniError;
use jni::objects::{JClass, JObject, JValue};
use jni::JavaVM;

/// Dotted (ClassLoader.loadClass) name of the Kotlin service.
const SERVICE_CLASS: &str = "digital.auxo.lalela.RecordingService";

/// Call a `static void <method>(Context)` on `RecordingService`, passing the
/// live Activity the wry/tao runtime published into tao's context store.
fn call_service(method: &str) -> Result<(), String> {
    let ctx = tao::platform::android::prelude::main_android_context()
        .ok_or_else(|| "no android context (runtime not ready)".to_string())?;
    // SAFETY: `main_android_context()` returns the process-wide `JavaVM` +
    // Activity `jobject` the wry runtime installed and keeps alive for the
    // lifetime of the activity; we only borrow them for this call. Runs on
    // both a JVM thread (start, from the IPC thread) and a plain Rust thread
    // (stop, from spawn_blocking) — `attach_current_thread` handles both:
    // already-attached threads get a no-detach nested guard, so the runtime's
    // JVM threads are never detached out from under it.
    let vm = unsafe { JavaVM::from_raw(ctx.java_vm.cast()) }.map_err(|e| format!("jni vm: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("jni attach: {e}"))?;

    let res = (|| -> Result<(), JniError> {
        let context = unsafe { JObject::from_raw(ctx.context_jobject.cast()) };
        // Resolve the class through the ACTIVITY's ClassLoader, not `FindClass`.
        // `stop()` runs on a spawn_blocking thread that jni freshly attaches to
        // the JVM; `FindClass` on a natively-attached thread uses the *system*
        // loader and can't see app classes ("ClassNotFoundException"). Loading
        // via the context's loader works from any thread (and on the JVM IPC
        // thread too, so start + stop share one path).
        let loader = env
            .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
            .l()?;
        let name = env.new_string(SERVICE_CLASS)?;
        let class = env
            .call_method(
                &loader,
                "loadClass",
                "(Ljava/lang/String;)Ljava/lang/Class;",
                &[JValue::Object(&name)],
            )?
            .l()?;
        let class = JClass::from(class);
        env.call_static_method(
            &class,
            method,
            "(Landroid/content/Context;)V",
            &[JValue::Object(&context)],
        )?;
        Ok(())
    })();

    // Never leave a Java exception pending on the thread — an uncleared one
    // becomes a fatal uncaught exception the next time control returns to the
    // JVM (this is what crashed the stop path before the ClassLoader fix).
    if res.is_err() {
        let _ = env.exception_clear();
    }
    res.map_err(|e| format!("jni call {method}: {e}"))
}

/// Start the mic foreground service (+ wake lock) before opening the mic stream.
/// Idempotent on the Kotlin side; safe to call even if already running.
pub fn start_recording_service() {
    if let Err(e) = call_service("start") {
        log::warn!("android: failed to start recording foreground service: {e}");
    }
}

/// Stop the mic foreground service (+ release the wake lock) after the stream
/// closes. Called on every capture-end path: user stop, cloud-mode stop, and the
/// start-time mic-open error path.
pub fn stop_recording_service() {
    if let Err(e) = call_service("stop") {
        log::warn!("android: failed to stop recording foreground service: {e}");
    }
}
