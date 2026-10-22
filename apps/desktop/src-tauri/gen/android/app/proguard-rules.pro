# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# The recording foreground service is started/stopped from Rust (android.rs) via
# JNI, which resolves the class + its static start(Context)/stop(Context) methods
# reflectively by name. R8 can't see those call sites, so keep the class and the
# JNI-invoked members intact in the minified release build.
-keep class digital.auxo.lalela.RecordingService { *; }

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Tauri/wry JNI entry points. Methods like TauriActivity.getPluginManager() are
# invoked ONLY from native code (JNI GetMethodID) — R8 sees no Java caller and
# strips them, which crashes at launch with NoSuchMethodError on release builds.
# Keep every class in the app package (all ours + tauri/wry codegen; tiny cost).
# NOTE: do NOT rely on the generated proguard-wry.pro for this — the tauri CLI
# regenerates that file on every build, clobbering any appended rules.
-keep class digital.auxo.lalela.** { *; }