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

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# --- Capacitor / Cordova bridge rules ---
# Without these, R8/ProGuard can strip or rename classes the WebView<->native
# bridge relies on, which breaks the app at runtime (blank screen, plugin
# calls silently failing) while still compiling successfully.
-keep class com.getcapacitor.** { *; }
-keep public class * extends com.getcapacitor.Plugin
-keepclassmembers class * extends com.getcapacitor.Plugin { public *; }
-keep class org.apache.cordova.** { *; }

# @JavascriptInterface-annotated methods are called from JS by name, so they
# must keep their exact method signatures.
-keepattributes JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep this app's own MainActivity fully intact (entry point, referenced by
# name from AndroidManifest.xml).
-keep class com.cryptoscreener.ichimoku.MainActivity { *; }

