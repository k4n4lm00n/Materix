#!/usr/bin/env bash
# Inject the UnifiedPush background-push native layer into the (gitignored,
# regenerated) src-tauri/gen/android tree. Run AFTER `tauri android init` and
# BEFORE `tauri android build`. Idempotent — safe to run more than once.
#
# What it does:
#   1. copies the committed Kotlin (receiver + WebView bridge) into the app,
#   2. adds the UnifiedPush connector dependency (JitPack) + repo,
#   3. adds POST_NOTIFICATIONS/WAKE_LOCK perms, distributor <queries>, and the
#      <receiver> to the merged AndroidManifest,
#   4. adds the onWebViewCreate() hook to MainActivity so the JS bridge attaches,
#   5. makes system Back NEVER close the app: disables wry's default Back
#      handling and forwards every Back press to the WebView as a JS
#      "android-back" event (handled by src/ui/androidBack.ts, which closes
#      UI or — at the top level — backgrounds the task via the bridge's
#      moveTaskToBack, keeping the activity alive, Element-style).
#
# See packaging/android/push/*.kt and docs/push-notifications.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
gen="$here/src-tauri/gen/android"
app="$gen/app"
pkgdir="$app/src/main/java/org/materix/app"

test -d "$app" || { echo "::error::gen/android not found — run 'tauri android init' first"; exit 1; }

# 1. Kotlin sources ---------------------------------------------------------
mkdir -p "$pkgdir"
cp "$here/packaging/android/push/MaterixPush.kt" "$pkgdir/MaterixPush.kt"
cp "$here/packaging/android/push/MaterixUnifiedPushReceiver.kt" "$pkgdir/MaterixUnifiedPushReceiver.kt"
cp "$here/packaging/android/push/MaterixSyncService.kt" "$pkgdir/MaterixSyncService.kt"
echo "apply-android-push: copied Kotlin sources -> $pkgdir"

# 2. connector dependency + JitPack repo ------------------------------------
python3 - "$app/build.gradle.kts" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
if 'android-connector' not in s:
    s = s.replace(
        'dependencies {',
        'dependencies {\n'
        '    // UnifiedPush connector — background push via a distributor (ntfy) on\n'
        '    // Google-less Android. See scripts/apply-android-push.sh.\n'
        '    implementation("com.github.UnifiedPush:android-connector:2.4.0")',
        1)
    open(p, 'w').write(s)
    print("apply-android-push: added connector dependency")
else:
    print("apply-android-push: connector dependency already present")
PY

python3 - "$gen/build.gradle.kts" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
if 'jitpack.io' not in s:
    s, n = re.subn(
        r'(allprojects \{\s*\n\s*repositories \{\s*\n\s*google\(\)\s*\n\s*mavenCentral\(\))',
        r'\1\n        maven { url = uri("https://jitpack.io") }',
        s, count=1)
    assert n == 1, "could not find allprojects.repositories block to add JitPack"
    open(p, 'w').write(s)
    print("apply-android-push: added JitPack repository")
else:
    print("apply-android-push: JitPack repository already present")
PY

# 3. AndroidManifest: permissions, queries, receiver ------------------------
python3 - "$app/src/main/AndroidManifest.xml" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
changed = False
if 'POST_NOTIFICATIONS' not in s:
    s = s.replace(
        '<uses-permission android:name="android.permission.INTERNET" />',
        '<uses-permission android:name="android.permission.INTERNET" />\n'
        '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n'
        '    <uses-permission android:name="android.permission.WAKE_LOCK" />\n'
        '    <!-- Opt-in foreground "keep sync alive" service (MaterixSyncService). -->\n'
        '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />\n'
        '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />\n'
        '    <!-- Optional battery-optimization exemption (user-granted via system dialog). -->\n'
        '    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />\n'
        '    <!-- Discover UnifiedPush distributors on Android 11+ (package visibility). -->\n'
        '    <queries>\n'
        '        <intent>\n'
        '            <action android:name="org.unifiedpush.android.distributor.REGISTER" />\n'
        '        </intent>\n'
        '    </queries>',
        1)
    changed = True
# Guard on the unique service attribute, not the bare class name — the
# permission comment above also mentions "MaterixSyncService".
if 'android:name=".MaterixSyncService"' not in s:
    s = s.replace(
        '</application>',
        '        <service\n'
        '            android:name=".MaterixSyncService"\n'
        '            android:exported="false"\n'
        '            android:foregroundServiceType="dataSync" />\n'
        '    </application>',
        1)
    changed = True
if 'MaterixUnifiedPushReceiver' not in s:
    s = s.replace(
        '</application>',
        '        <receiver\n'
        '            android:name=".MaterixUnifiedPushReceiver"\n'
        '            android:exported="true">\n'
        '            <intent-filter>\n'
        '                <action android:name="org.unifiedpush.android.connector.MESSAGE" />\n'
        '                <action android:name="org.unifiedpush.android.connector.NEW_ENDPOINT" />\n'
        '                <action android:name="org.unifiedpush.android.connector.REGISTRATION_FAILED" />\n'
        '                <action android:name="org.unifiedpush.android.connector.UNREGISTERED" />\n'
        '            </intent-filter>\n'
        '        </receiver>\n'
        '    </application>',
        1)
    changed = True
open(p, 'w').write(s)
print("apply-android-push: AndroidManifest " + ("patched" if changed else "already patched"))
PY

# 4. MainActivity: onWebViewCreate hook -------------------------------------
MA="$(find "$gen" -name MainActivity.kt | head -1)"
test -n "$MA" || { echo "::error::MainActivity.kt not found"; exit 1; }
python3 - "$MA" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
if 'onWebViewCreate' in s:
    print("apply-android-push: MainActivity onWebViewCreate already present"); sys.exit(0)
s, n = re.subn(
    r'(class MainActivity : TauriActivity\(\) \{\n)',
    r'\1'
    '  // Attach the UnifiedPush ↔ JS bridge as soon as the WebView exists.\n'
    '  override fun onWebViewCreate(webView: android.webkit.WebView) {\n'
    '    super.onWebViewCreate(webView)\n'
    '    materixWebView = webView\n'
    '    MaterixPush.attach(this, webView)\n'
    '  }\n\n',
    s, count=1)
assert n == 1, "could not find MainActivity class body to add onWebViewCreate"
open(p, 'w').write(s)
print("apply-android-push: MainActivity onWebViewCreate hook added")
PY

# 5. MainActivity: system Back must never close the app ----------------------
# wry's WryActivity installs its own OnBackPressedCallback (WebView
# history.back, else finish()) unless `handleBackNavigation` is false. Disable
# it and register an always-enabled callback that forwards Back into the page
# as an "android-back" event; src/ui/androidBack.ts closes menus/panes or, at
# the top level, backgrounds the task (moveTaskToBack — activity stays alive).
# The only way to actually close Materix is the app switcher.
python3 - "$MA" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
if 'android-back' in s:
    print("apply-android-push: MainActivity back handler already present"); sys.exit(0)
# Step 4 must have injected the webView capture; a stale gen tree from an
# older script version would leave materixWebView never assigned.
assert 'materixWebView = webView' in s, \
    "onWebViewCreate hook lacks the webView capture — delete src-tauri/gen/android and re-run 'tauri android init'"
s, n = re.subn(
    r'(class MainActivity : TauriActivity\(\) \{\n)',
    r'\1'
    '  // System Back never closes Materix: wry\'s default Back handling\n'
    '  // (WebView history back / activity finish) is disabled and every press\n'
    '  // is forwarded to the page instead (see src/ui/androidBack.ts).\n'
    '  override val handleBackNavigation: Boolean = false\n'
    '  private var materixWebView: android.webkit.WebView? = null\n\n',
    s, count=1)
assert n == 1, "could not find MainActivity class body to add back-handling fields"
s, n = re.subn(
    r'(super\.onCreate\([^\n)]*\)\s*\n)',
    r'\1'
    '    onBackPressedDispatcher.addCallback(\n'
    '      this,\n'
    '      object : androidx.activity.OnBackPressedCallback(true) {\n'
    '        override fun handleOnBackPressed() {\n'
    '          materixWebView?.evaluateJavascript(\n'
    '            "window.dispatchEvent(new Event(\'android-back\'))", null)\n'
    '        }\n'
    '      })\n',
    s, count=1)
assert n == 1, "could not find super.onCreate() to register the back callback"
open(p, 'w').write(s)
print("apply-android-push: MainActivity back-to-JS handler added")
PY

echo "apply-android-push: done"
