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
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.security.MessageDigest
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
        // The app is alive now: retire the dead-process generic notification
        // (stable id 1). The live JS path re-posts the rich grouped block.
        try {
            val nm = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.cancel(1)
        } catch (_: Throwable) {
        }
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

    /**
     * Post a minimal "new message" notification — the dead-process fallback.
     * When the gateway payload carried `counts.unread` we upgrade the text to
     * "N new messages" and set the count badge. Standalone (no group): the
     * account is unknown in this path (all accounts share one UnifiedPush
     * endpoint), so it cannot join the per-account live group. Stable id 1 —
     * each push REPLACES it — and retired on app open (attach()).
     */
    @SuppressLint("MissingPermission")
    fun notifyGeneric(context: Context, title: String, body: String, unread: Int? = null) {
        if (!canPost(context)) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureChannel(nm, CHANNEL_ID)
        val text = if (unread != null && unread > 1) "$unread new messages" else body
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(context, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(context)
        }
        builder
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(context.applicationInfo.icon)
            .setAutoCancel(true)
        if (unread != null && unread > 0) builder.setNumber(unread)
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launch ->
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
            builder.setContentIntent(PendingIntent.getActivity(context, 0, launch, flags))
        }
        nm.notify(1, builder.build())
    }

    // --- Grouped in-app notifier (live path) -------------------------------
    // STATELESS renderer: JS (src/ui/notifications.ts + notifyGrouping.ts) owns
    // the running "since last viewed" tally and hands us the COMPLETE desired
    // state — child (room) + account summary — on every post. We only render.

    /** Deterministic positive-ish 32-bit id from a string (first 4 bytes of
     * SHA-256). Avoids String.hashCode() collisions across the ids we post. */
    fun stableId(key: String): Int {
        val d = MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
        return ((d[0].toInt() and 0xFF) shl 24) or
            ((d[1].toInt() and 0xFF) shl 16) or
            ((d[2].toInt() and 0xFF) shl 8) or
            (d[3].toInt() and 0xFF)
    }

    /**
     * Post/replace a room's child notification and its per-account group
     * summary. Payload (JSON from JS):
     *   { accountKey, accountLabel, roomId, channelId?, title, body,
     *     roomLines: [..], roomCount, accountLines: [..], totalCount }
     */
    @SuppressLint("MissingPermission")
    fun notifyMessage(context: Context, json: String) {
        if (!canPost(context)) return
        val o = try {
            JSONObject(json)
        } catch (_: Throwable) {
            return
        }
        val accountKey = o.optString("accountKey")
        val roomId = o.optString("roomId")
        if (accountKey.isEmpty() || roomId.isEmpty()) return

        val channelId = o.optString("channelId").takeIf { it.isNotEmpty() } ?: CHANNEL_ID
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureChannel(nm, channelId)

        val groupKey = "acct.$accountKey"
        val childId = stableId("room.$accountKey.$roomId")
        val summaryId = stableId("acct.$accountKey")
        val icon = context.applicationInfo.icon

        val title = o.optString("title")
        val body = o.optString("body")
        val roomLines = jsonStrings(o.optJSONArray("roomLines"))
        val roomCount = o.optInt("roomCount", roomLines.size)

        val childStyle = NotificationCompat.InboxStyle()
        for (l in roomLines) childStyle.addLine(l)
        val child = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(childStyle)
            .setGroup(groupKey)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false) // re-alert on every message (messenger default)
            .setNumber(roomCount)
            .setContentIntent(roomIntent(context, accountKey, roomId, childId))
            .build()

        nm.notify(childId, child)
        nm.notify(summaryId, buildSummary(context, o, channelId, summaryId, icon))
    }

    /**
     * A room was viewed: cancel its child; if the account has nothing left
     * cancel the summary, otherwise re-post it with the recomputed remainder.
     * Payload: { accountKey, accountLabel, roomId, remainingTotal,
     *            accountLines: [..], channelId? }
     */
    @SuppressLint("MissingPermission")
    fun clearRoom(context: Context, json: String) {
        val o = try {
            JSONObject(json)
        } catch (_: Throwable) {
            return
        }
        val accountKey = o.optString("accountKey")
        val roomId = o.optString("roomId")
        if (accountKey.isEmpty() || roomId.isEmpty()) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(stableId("room.$accountKey.$roomId"))

        val summaryId = stableId("acct.$accountKey")
        val remainingTotal = o.optInt("remainingTotal", 0)
        if (remainingTotal <= 0) {
            nm.cancel(summaryId)
            return
        }
        if (!canPost(context)) return
        val channelId = o.optString("channelId").takeIf { it.isNotEmpty() } ?: CHANNEL_ID
        ensureChannel(nm, channelId)
        nm.notify(summaryId, buildSummary(context, o, channelId, summaryId, context.applicationInfo.icon))
    }

    /** Cancel a whole account's group summary (e.g. sign-out). Children clear
     * individually via clearRoom; JS drives that per room. */
    fun clearAccount(context: Context, accountKey: String) {
        if (accountKey.isEmpty()) return
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(stableId("acct.$accountKey"))
    }

    /** Build the per-account group-summary from the shared payload fields
     * (accountLabel, totalCount, accountLines). */
    private fun buildSummary(
        context: Context,
        o: JSONObject,
        channelId: String,
        summaryId: Int,
        icon: Int,
    ): Notification {
        val accountKey = o.optString("accountKey")
        val accountLabel = o.optString("accountLabel").takeIf { it.isNotEmpty() } ?: "Materix"
        // notifyMessage payloads carry "totalCount"; clearRoom re-post payloads
        // carry "remainingTotal" — accept either so the summary badge is correct
        // in both paths (both mean "messages still pending for this account").
        val totalCount = o.optInt("totalCount", o.optInt("remainingTotal", 0))
        val accountLines = jsonStrings(o.optJSONArray("accountLines"))
        val countText = "$totalCount new messages"
        val style = NotificationCompat.InboxStyle().setSummaryText(countText)
        for (l in accountLines) style.addLine(l)
        return NotificationCompat.Builder(context, channelId)
            .setSmallIcon(icon)
            .setContentTitle(accountLabel)
            .setContentText(countText)
            .setSubText(accountLabel)
            .setStyle(style)
            .setGroup("acct.$accountKey")
            .setGroupSummary(true)
            .setNumber(totalCount)
            .setOnlyAlertOnce(true) // summary updates never double-alert
            .setAutoCancel(true)
            .setContentIntent(launchIntent(context, summaryId))
            .build()
    }

    /** Launch intent carrying the room deep-link extras (MainActivity.onNewIntent). */
    private fun roomIntent(
        context: Context,
        accountKey: String,
        roomId: String,
        requestCode: Int,
    ): PendingIntent? {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: return null
        launch.putExtra("materix.roomId", roomId)
        launch.putExtra("materix.accountKey", accountKey)
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        return PendingIntent.getActivity(context, requestCode, launch, flags)
    }

    /** Plain launch intent (summary tap → open the app). */
    private fun launchIntent(context: Context, requestCode: Int): PendingIntent? {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: return null
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        return PendingIntent.getActivity(context, requestCode, launch, flags)
    }

    /** POST_NOTIFICATIONS gate (API 33+). */
    private fun canPost(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    /** Idempotently create a high-importance channel (no-op pre-26). */
    private fun ensureChannel(nm: NotificationManager, channelId: String) {
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(channelId) == null) {
            nm.createNotificationChannel(
                NotificationChannel(
                    channelId,
                    "Background messages",
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply { description = "New messages received while Materix was closed" },
            )
        }
    }

    private fun jsonStrings(arr: JSONArray?): List<String> {
        if (arr == null) return emptyList()
        val out = ArrayList<String>(arr.length())
        for (i in 0 until arr.length()) {
            val s = arr.optString(i, "")
            if (s.isNotEmpty()) out.add(s)
        }
        return out
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

    // --- Grouped notifications (see src/ui/notifications.ts) ----------------
    // Strings only across the JS bridge; the payloads are JSON (parsed natively).

    @JavascriptInterface
    fun notifyMessage(json: String) {
        try {
            MaterixPush.notifyMessage(appContext, json)
        } catch (_: Throwable) {
        }
    }

    @JavascriptInterface
    fun clearRoom(json: String) {
        try {
            MaterixPush.clearRoom(appContext, json)
        } catch (_: Throwable) {
        }
    }

    @JavascriptInterface
    fun clearAccount(accountKey: String) {
        try {
            MaterixPush.clearAccount(appContext, accountKey)
        } catch (_: Throwable) {
        }
    }

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
