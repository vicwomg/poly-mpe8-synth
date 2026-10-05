package com.vicwomg.polympe8synth;

import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
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
    @CapacitorPlugin(name = "ScreenPlugin")
    public static class ScreenPlugin extends Plugin {
        @PluginMethod
        public void setKeepScreenOn(PluginCall call) {
            boolean enabled = call.getBoolean("enabled", true);
            getActivity().runOnUiThread(() -> {
                if (enabled) {
                    getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
                call.resolve();
            });
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
    public void onResume() {
        super.onResume();
        enableImmersiveMode();
        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().onResume();
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        if (this.bridge != null && this.bridge.getWebView() != null) {
            this.bridge.getWebView().onPause();
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            enableImmersiveMode();
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
