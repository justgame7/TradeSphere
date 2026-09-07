package com.cryptoscreener.ichimoku;

import android.graphics.Color;
import android.os.Bundle;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Draw the web content edge-to-edge behind the status/navigation bars
        // on every supported Android version, not just the ones (API 35+)
        // where the OS forces it - so behavior is consistent across devices.
        // Both bars are made transparent so the app's own dark background
        // (and the safe-area-inset padding already used in the CSS) shows
        // through instead of the platform's default white/light bar color.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);

        WindowInsetsControllerCompat controller =
            new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        // Light (white) icons/text on both bars, since they now sit directly
        // on the app's dark background instead of an opaque light bar.
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);
    }
}
