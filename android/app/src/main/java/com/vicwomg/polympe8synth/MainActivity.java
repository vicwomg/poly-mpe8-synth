package com.vicwomg.polympe8synth;

import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.Display;
import android.view.OrientationEventListener;
import android.view.Surface;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebSettings;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

public class MainActivity extends BridgeActivity {
    private static final String PREFS_NAME = "synth_orientation_prefs";
    private static final String KEY_LAST_ORIENTATION = "last_screen_orientation";
    private static final long WAKE_SETTLE_DELAY_MS = 800L;
    private static final long ROTATION_DEBOUNCE_MS = 250L;

    private int lastKnownOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    private int pendingOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    private long pendingOrientationStartMs = 0L;
    private int wakeSuppressedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    private boolean needsWakeBaselineCapture = false;
    private boolean isActivityResumed = false;
    private boolean needsAudioRecoveryOnWake = false;
    private long lastWakeOrResumeTimeMs = 0L;
    private OrientationEventListener orientationEventListener;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Runnable pendingAudioWakeRunnable = null;
    private Runnable settledAudioWakeRunnable = null;

    @CapacitorPlugin(name = "ScreenPlugin")
    public static class ScreenPlugin extends Plugin {
        @PluginMethod
        public void setKeepScreenOn(PluginCall call) {
            boolean enabled = call.getBoolean("enabled", true);
            androidx.appcompat.app.AppCompatActivity activity = getActivity();
            if (activity != null) {
                activity.runOnUiThread(() -> {
                    if (activity.getWindow() != null) {
                        if (enabled) {
                            activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        } else {
                            activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        }
                    }
                    call.resolve();
                });
            } else {
                call.resolve();
            }
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Enforce dark mode application-wide so dialogs & pickers never fall back to light theme
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES);

        // Transition from system splash screen to dark post-splash theme
        SplashScreen.installSplashScreen(this);

        registerPlugin(ScreenPlugin.class);
        super.onCreate(savedInstanceState);

        // Keep screen awake while synthesizer is active
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Restore and lock the last active orientation so screen sleep/wake never resets to portrait
        initOrientationPreservation(savedInstanceState);

        // Ensure black backgrounds across window, system bars, and camera cutouts
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.BLACK));
        getWindow().setStatusBarColor(Color.BLACK);
        getWindow().setNavigationBarColor(Color.BLACK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setStatusBarContrastEnforced(false);
            getWindow().setNavigationBarContrastEnforced(false);
        }

        // Enable true edge-to-edge layout across the entire physical display
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        // Allow app to render edge-to-edge through display cutouts / notches
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        // Hide OS status bar and navigation menus for maximum screen real estate
        enableImmersiveMode();

        // Configure WebView performance flags for real-time audio synthesis
        if (this.bridge != null && this.bridge.getWebView() != null) {
            android.webkit.WebView webView = this.bridge.getWebView();
            webView.setBackgroundColor(Color.BLACK);
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
            WebSettings settings = webView.getSettings();
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setCacheMode(WebSettings.LOAD_DEFAULT);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
        }
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (isValidExplicitOrientation(lastKnownOrientation)) {
            outState.putInt(KEY_LAST_ORIENTATION, lastKnownOrientation);
        }
    }

    @Override
    public void onResume() {
        // Unpause WebView and JS timers BEFORE super.onResume() dispatches Capacitor resume events
        if (this.bridge != null && this.bridge.getWebView() != null) {
            android.webkit.WebView webView = this.bridge.getWebView();
            webView.onResume();
            webView.resumeTimers();
        }

        super.onResume();
        isActivityResumed = true;
        lastWakeOrResumeTimeMs = SystemClock.elapsedRealtime();
        pendingOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        needsWakeBaselineCapture = true;

        // Enforce pre-sleep orientation immediately upon wake/resume
        if (isValidExplicitOrientation(lastKnownOrientation)) {
            setRequestedOrientation(lastKnownOrientation);
        }

        if (orientationEventListener != null && orientationEventListener.canDetectOrientation()) {
            orientationEventListener.enable();
        }

        enableImmersiveMode();
        scheduleAudioWakeRecovery(0);
    }

    @Override
    public void onPause() {
        isActivityResumed = false;
        needsAudioRecoveryOnWake = true;
        pendingOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        cancelScheduledAudioWakeRecovery();

        // Notify JS synth engine to silence voices and mark AudioContext for clean reinit before WebView pauses
        dispatchJsAudioEvent("native-audio-sleep", "pause");

        // Lock current orientation before the OS lock screen (portrait) takes over
        if (isValidExplicitOrientation(lastKnownOrientation)) {
            persistOrientation(lastKnownOrientation);
            setRequestedOrientation(lastKnownOrientation);
        }

        if (orientationEventListener != null) {
            orientationEventListener.disable();
        }

        super.onPause();
        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().onPause();
        }
    }

    @Override
    public void onDestroy() {
        cancelScheduledAudioWakeRecovery();
        if (orientationEventListener != null) {
            orientationEventListener.disable();
        }
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            lastWakeOrResumeTimeMs = SystemClock.elapsedRealtime();
            needsWakeBaselineCapture = true;
            if (this.bridge != null && this.bridge.getWebView() != null) {
                android.webkit.WebView webView = this.bridge.getWebView();
                webView.onResume();
                webView.resumeTimers();
            }
            if (isValidExplicitOrientation(lastKnownOrientation)) {
                setRequestedOrientation(lastKnownOrientation);
            }
            enableImmersiveMode();
            scheduleAudioWakeRecovery(0);
        } else {
            pendingOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
            if (!isDeviceInteractiveAndUnlocked()) {
                needsAudioRecoveryOnWake = true;
            }
            if (isValidExplicitOrientation(lastKnownOrientation)) {
                setRequestedOrientation(lastKnownOrientation);
            }
        }
    }

    private void cancelScheduledAudioWakeRecovery() {
        if (pendingAudioWakeRunnable != null) {
            mainHandler.removeCallbacks(pendingAudioWakeRunnable);
            pendingAudioWakeRunnable = null;
        }
        if (settledAudioWakeRunnable != null) {
            mainHandler.removeCallbacks(settledAudioWakeRunnable);
            settledAudioWakeRunnable = null;
        }
    }

    private void scheduleAudioWakeRecovery(int attempt) {
        if (!needsAudioRecoveryOnWake) return;

        if (pendingAudioWakeRunnable != null) {
            mainHandler.removeCallbacks(pendingAudioWakeRunnable);
            pendingAudioWakeRunnable = null;
        }

        pendingAudioWakeRunnable = () -> {
            pendingAudioWakeRunnable = null;
            if (!isActivityResumed) return;

            if (hasWindowFocus() && isDeviceInteractiveAndUnlocked()) {
                // Wait 160ms after focus + unlock so orientation lock and AudioFlinger fast-track handoff settle
                if (settledAudioWakeRunnable != null) {
                    mainHandler.removeCallbacks(settledAudioWakeRunnable);
                }
                settledAudioWakeRunnable = () -> {
                    settledAudioWakeRunnable = null;
                    if (isActivityResumed && hasWindowFocus() && isDeviceInteractiveAndUnlocked()) {
                        needsAudioRecoveryOnWake = false;
                        dispatchJsAudioEvent("native-audio-wake", "native-settled");
                    } else if (isActivityResumed) {
                        scheduleAudioWakeRecovery(0);
                    }
                };
                mainHandler.postDelayed(settledAudioWakeRunnable, 160L);
            } else if (attempt < 40) {
                scheduleAudioWakeRecovery(attempt + 1);
            }
        };

        mainHandler.postDelayed(pendingAudioWakeRunnable, attempt == 0 ? 80L : 120L);
    }

    private void dispatchJsAudioEvent(String eventName, String phase) {
        if (this.bridge == null || this.bridge.getWebView() == null) return;
        android.webkit.WebView webView = this.bridge.getWebView();
        String js = "window.dispatchEvent(new CustomEvent('" + eventName + "', { detail: { phase: '" + phase + "' } }));";
        webView.post(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {}
        });
    }

    private void initOrientationPreservation(Bundle savedInstanceState) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        int restored = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        if (savedInstanceState != null && savedInstanceState.containsKey(KEY_LAST_ORIENTATION)) {
            restored = savedInstanceState.getInt(KEY_LAST_ORIENTATION, ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
        if (!isValidExplicitOrientation(restored)) {
            restored = prefs.getInt(KEY_LAST_ORIENTATION, ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
        if (!isValidExplicitOrientation(restored)) {
            restored = getCurrentDisplayOrientation();
        }

        lastKnownOrientation = restored;
        persistOrientation(lastKnownOrientation);
        setRequestedOrientation(lastKnownOrientation);

        orientationEventListener = new OrientationEventListener(this, SensorManager.SENSOR_DELAY_NORMAL) {
            @Override
            public void onOrientationChanged(int degrees) {
                handlePhysicalOrientationChanged(degrees);
            }
        };
        if (orientationEventListener.canDetectOrientation()) {
            orientationEventListener.enable();
        }
    }

    private void handlePhysicalOrientationChanged(int degrees) {
        if (!isActivityResumed || !hasWindowFocus() || !isDeviceInteractiveAndUnlocked()) {
            pendingOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
            return;
        }

        long now = SystemClock.elapsedRealtime();
        if (now - lastWakeOrResumeTimeMs < WAKE_SETTLE_DELAY_MS) {
            pendingOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
            return;
        }

        if (!isSystemAutoRotateEnabled()) {
            pendingOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
            return;
        }

        int candidate = mapDegreesToOrientation(degrees);

        if (needsWakeBaselineCapture) {
            needsWakeBaselineCapture = false;
            if (candidate != ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED && candidate != lastKnownOrientation) {
                // Device was held in a different orientation (e.g. portrait) while unlocking the lock screen;
                // suppress switching until the device moves out of that unlock posture
                wakeSuppressedOrientation = candidate;
            } else {
                wakeSuppressedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
            }
        }

        if (wakeSuppressedOrientation != ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED) {
            if (candidate == wakeSuppressedOrientation) {
                pendingOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
                return;
            } else {
                wakeSuppressedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
            }
        }

        if (candidate == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED || candidate == lastKnownOrientation) {
            pendingOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
            return;
        }

        if (candidate != pendingOrientation) {
            pendingOrientation = candidate;
            pendingOrientationStartMs = now;
            return;
        }

        if (now - pendingOrientationStartMs >= ROTATION_DEBOUNCE_MS) {
            lastKnownOrientation = candidate;
            pendingOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
            persistOrientation(lastKnownOrientation);
            setRequestedOrientation(lastKnownOrientation);
        }
    }

    private int mapDegreesToOrientation(int degrees) {
        if (degrees == OrientationEventListener.ORIENTATION_UNKNOWN) {
            return ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        }
        // Strict +/- 25 degree zones around cardinal angles so shallow stand tilts never reset rotation
        if (degrees >= 335 || degrees <= 25) {
            return ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        } else if (degrees >= 65 && degrees <= 115) {
            return ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE;
        } else if (degrees >= 245 && degrees <= 295) {
            return ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
        }
        return ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    }

    private int getCurrentDisplayOrientation() {
        int rotation = Surface.ROTATION_0;
        try {
            Display display = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                display = getDisplay();
            }
            if (display == null) {
                display = getWindowManager().getDefaultDisplay();
            }
            if (display != null) {
                rotation = display.getRotation();
            }
        } catch (Exception ignored) {}

        switch (rotation) {
            case Surface.ROTATION_90:
                return ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
            case Surface.ROTATION_270:
                return ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE;
            case Surface.ROTATION_180:
                return ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
            case Surface.ROTATION_0:
            default:
                return ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        }
    }

    private boolean isValidExplicitOrientation(int orientation) {
        return orientation == ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            || orientation == ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            || orientation == ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
            || orientation == ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT;
    }

    private void persistOrientation(int orientation) {
        if (!isValidExplicitOrientation(orientation)) return;
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putInt(KEY_LAST_ORIENTATION, orientation)
            .apply();
    }

    private boolean isDeviceInteractiveAndUnlocked() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isInteractive()) {
                return false;
            }
            KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null && km.isKeyguardLocked()) {
                return false;
            }
        } catch (Exception ignored) {}
        return true;
    }

    private boolean isSystemAutoRotateEnabled() {
        try {
            return Settings.System.getInt(
                getContentResolver(),
                Settings.System.ACCELEROMETER_ROTATION,
                1
            ) == 1;
        } catch (Exception e) {
            return true;
        }
    }

    private void enableImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                );
            }
        }
        View decorView = getWindow().getDecorView();
        decorView.setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }
}
