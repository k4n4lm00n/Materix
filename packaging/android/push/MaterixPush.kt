package org.materix.app

// UnifiedPush ↔ WebView bridge for background notifications on Google-less
// Android (LineageOS/GrapheneOS/etc — no FCM). Materix runs entirely inside a
// WebView (matrix-js-sdk), so a push that arrives while the process is dead
// can't be handled in JS. This tiny native surface:
//   • registers with a UnifiedPush distributor (e.g. the ntfy app),
//   • forwards the endpoint + incoming pushes into JS (window CustomEvents)
//     while the WebView is alive, so matrix-js-sdk syncs and posts the rich,
//     decrypted notification, and
//   • posts a plain "new message" system notification when the WebView is
//     dead, so the user is still woken and can open the app to sync.
//
// This file is committed under packaging/android/ and copied into the
// (gitignored, regenerated) gen/android tree by scripts/apply-android-push.sh.

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference
import org.unifiedpush.android.connector.UnifiedPush

object MaterixPush {
    const val PREFS = "materix_push"
    const val KEY_ENDPOINT = "endpoint"
    const val CHANNEL_ID = "materix.background"
    private const val PERM_REQUEST_CODE = 4711

    // WeakReference so a backgrounded/destroyed activity's WebView can be GC'd;
    // a null referent means the app isn't running and push must fall back to a
    // native notification.
    @Volatile
    private var webViewRef: WeakReference<WebView>? = null

    /** Wire the JS bridge onto a freshly created WebView (from MainActivity). */
    fun attach(activity: Activity, webView: WebView) {
        webViewRef = WeakReference(webView)
        webView.addJavascriptInterface(MaterixPushBridge(activity), "MaterixPushNative")
    }

    /** True when a live WebView can handle the push in JS (app is running). */
    fun hasLiveWebView(): Boolean = webViewRef?.get() != null

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun endpoint(context: Context): String? = prefs(context).getString(KEY_ENDPOINT, null)

    fun saveEndpoint(context: Context, endpoint: String?) {
        val e = prefs(context).edit()
        if (endpoint.isNullOrEmpty()) e.remove(KEY_ENDPOINT) else e.putString(KEY_ENDPOINT, endpoint)
        e.apply()
    }

    /**
     * Fire `window.dispatchEvent(new CustomEvent(name, { detail }))` in the
     * WebView if it's alive. `detail` is delivered as a JS string; for
     * structured data pass JSON text and JSON.parse it on the JS side. Both
     * arguments are quoted with JSONObject.quote so arbitrary payloads are
     * injection-safe.
     */
    fun dispatchToJs(name: String, detail: String) {
        val wv = webViewRef?.get() ?: return
        val js = "window.dispatchEvent(new CustomEvent(" +
            JSONObject.quote(name) + ", { detail: " + JSONObject.quote(detail) + " }));"
        wv.post {
            try {
                wv.evaluateJavascript(js, null)
            } catch (_: Throwable) {
            }
        }
    }

    /** Post a minimal "new message" notification — the dead-process fallback. */
    @SuppressLint("MissingPermission")
    fun notifyGeneric(context: Context, title: String, body: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Background messages",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply { description = "New messages received while Materix was closed" },
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(context)
        }
        builder
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(context.applicationInfo.icon)
            .setAutoCancel(true)
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launch ->
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
            builder.setContentIntent(PendingIntent.getActivity(context, 0, launch, flags))
        }
        nm.notify(1, builder.build())
    }

    // request code exposed for MaterixPushBridge
    internal fun permRequestCode() = PERM_REQUEST_CODE
}

/** Methods exposed to JS as `window.MaterixPushNative.*`. Runs on a binder thread. */
@Suppress("unused")
class MaterixPushBridge(activity: Activity) {
    private val activityRef = WeakReference(activity)
    private val appContext: Context = activity.applicationContext

    /** Presence probe — JS uses this to detect the native bridge exists. */
    @JavascriptInterface
    fun ping(): Boolean = true

    /** JSON array of installed distributors: [{ "id": <pkg>, "name": <label> }]. */
    @JavascriptInterface
    fun getDistributors(): String {
        val arr = JSONArray()
        for (id in UnifiedPush.getDistributors(appContext)) {
            val name = try {
                val pm = appContext.packageManager
                pm.getApplicationLabel(pm.getApplicationInfo(id, 0)).toString()
            } catch (_: Throwable) {
                id
            }
            arr.put(JSONObject().put("id", id).put("name", name))
        }
        return arr.toString()
    }

    @JavascriptInterface
    fun getSavedDistributor(): String = UnifiedPush.getSavedDistributor(appContext) ?: ""

    @JavascriptInterface
    fun getAckDistributor(): String = UnifiedPush.getAckDistributor(appContext) ?: ""

    @JavascriptInterface
    fun saveDistributor(id: String) = UnifiedPush.saveDistributor(appContext, id)

    /** Register with the saved distributor; it replies via the receiver. */
    @JavascriptInterface
    fun register() = UnifiedPush.registerApp(appContext)

    @JavascriptInterface
    fun unregister() {
        UnifiedPush.unregisterApp(appContext)
        MaterixPush.saveEndpoint(appContext, null)
    }

    /** The last endpoint the distributor gave us (may pre-date this launch). */
    @JavascriptInterface
    fun getEndpoint(): String = MaterixPush.endpoint(appContext) ?: ""

    @JavascriptInterface
    fun hasNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < 33) return true
        return appContext.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    @JavascriptInterface
    fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return
        val act = activityRef.get() ?: return
        act.runOnUiThread {
            try {
                act.requestPermissions(
                    arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                    MaterixPush.permRequestCode(),
                )
            } catch (_: Throwable) {
            }
        }
    }

    // --- Top-level system Back (Element-style) -----------------------------

    /**
     * Send the task to the background (Android home screen) WITHOUT finishing
     * the activity: the process and warm WebView survive, so the next launcher
     * tap resumes instantly instead of cold-reloading the frontend. Called by
     * src/ui/androidBack.ts when a system Back press has nothing left to close
     * in-app (the room list is the top level).
     */
    @JavascriptInterface
    fun moveTaskToBack() {
        val act = activityRef.get() ?: return
        act.runOnUiThread {
            try {
                act.moveTaskToBack(true)
            } catch (_: Throwable) {
            }
        }
    }

    // --- Foreground "keep sync alive" service (opt-in) ---------------------
    // Prevents Android from reclaiming the backgrounded process (and its warm,
    // already-decrypted state). See MaterixSyncService.kt.

    /** Whether a foreground keep-alive service can run on this OS version. */
    @JavascriptInterface
    fun isForegroundSyncSupported(): Boolean = MaterixSyncService.isSupported()

    @JavascriptInterface
    fun isForegroundSyncRunning(): Boolean = MaterixSyncService.isRunning()

    @JavascriptInterface
    fun startForegroundSync() {
        try {
            MaterixSyncService.start(appContext)
        } catch (_: Throwable) {
        }
    }

    @JavascriptInterface
    fun stopForegroundSync() {
        try {
            MaterixSyncService.stop(appContext)
        } catch (_: Throwable) {
        }
    }

    // --- Battery-optimization exemption -----------------------------------
    // Complements the foreground service: lets the OS schedule the app's
    // network more aggressively while the device is idle.

    @JavascriptInterface
    fun isIgnoringBatteryOptimizations(): Boolean {
        if (Build.VERSION.SDK_INT < 23) return true
        return try {
            val pm = appContext.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            pm.isIgnoringBatteryOptimizations(appContext.packageName)
        } catch (_: Throwable) {
            false
        }
    }

    /**
     * Open the system dialog asking the user to exempt Materix from battery
     * optimization. No-op below API 23 (always exempt) or if already exempt.
     */
    @SuppressLint("BatteryLife")
    @JavascriptInterface
    fun requestIgnoreBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < 23 || isIgnoringBatteryOptimizations()) return
        val act = activityRef.get() ?: return
        act.runOnUiThread {
            try {
                val intent = android.content.Intent(
                    android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    android.net.Uri.parse("package:" + appContext.packageName),
                )
                act.startActivity(intent)
            } catch (_: Throwable) {
                // Some ROMs restrict this action — fall back to the settings screen.
                try {
                    act.startActivity(
                        android.content.Intent(
                            android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS,
                        ),
                    )
                } catch (_: Throwable) {
                }
            }
        }
    }
}
