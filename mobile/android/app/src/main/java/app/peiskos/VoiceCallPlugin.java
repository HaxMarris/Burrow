package app.peiskos;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;

/**
 * Keeps a voice call going while Peiskos is in the background or the screen is off. Android stops
 * an app's microphone soon after it leaves the screen unless it shows an ongoing notification, so
 * the page calls start() when you join a fire and stop() when you leave.
 */
@CapacitorPlugin(
    name = "VoiceCall",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        // Without it, Bluetooth headsets play the call but their microphone isn't used.
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class VoiceCallPlugin extends Plugin {
    static VoiceCallPlugin current;

    @Override
    public void load() {
        current = this;
    }

    @PluginMethod
    public void start(PluginCall call) {
        List<String> ask = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") == PermissionState.PROMPT) ask.add("notifications");
        if (Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") == PermissionState.PROMPT) ask.add("bluetooth");
        if (!ask.isEmpty()) {
            requestPermissionForAliases(ask.toArray(new String[0]), call, "afterPermissions");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void afterPermissions(PluginCall call) {
        // Answered either way: the call works without them, just without the notification or headset mic.
        startService(call);
    }

    private void startService(PluginCall call) {
        Intent intent = new Intent(getContext(), VoiceCallService.class);
        intent.putExtra("title", call.getString("title", "In a voice room"));
        intent.putExtra("text", call.getString("text", "Peiskos"));
        try {
            ContextCompat.startForegroundService(getContext(), intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't keep the call going in the background", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), VoiceCallService.class));
        call.resolve();
    }

    /** "Leave" was tapped on the notification. */
    void leaveTapped() {
        notifyListeners("leave", null);
    }
}
