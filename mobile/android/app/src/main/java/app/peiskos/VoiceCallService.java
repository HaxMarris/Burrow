package app.peiskos;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/** The ongoing "In a voice room" notification that lets the call keep its microphone in the background. */
public class VoiceCallService extends Service {
    private static final String CHANNEL = "voice";
    private static final String LEAVE = "app.peiskos.LEAVE_VOICE";
    private static final int ID = 1;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && LEAVE.equals(intent.getAction())) {
            if (VoiceCallPlugin.current != null) VoiceCallPlugin.current.leaveTapped();
            stopSelf();
            return START_NOT_STICKY;
        }

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Voice calls", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while you're in a voice room, so the call keeps going with the screen off");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        int immutable = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Intent leave = new Intent(this, VoiceCallService.class).setAction(LEAVE);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_peiskos)
            .setContentTitle(intent != null ? intent.getStringExtra("title") : "In a voice room")
            .setContentText(intent != null ? intent.getStringExtra("text") : "Peiskos")
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, immutable))
            .addAction(0, "Leave", PendingIntent.getService(this, 1, leave, immutable))
            .build();

        try {
            ServiceCompat.startForeground(this, ID, notification, foregroundTypes(true));
        } catch (Exception e) {
            // No microphone permission (joined to listen only): keep the sound going at least.
            try {
                ServiceCompat.startForeground(this, ID, notification, foregroundTypes(false));
            } catch (Exception ignored) {
                stopSelf();
            }
        }
        return START_NOT_STICKY;
    }

    private static int foregroundTypes(boolean microphone) {
        if (Build.VERSION.SDK_INT < 29) return 0;
        int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        if (microphone && Build.VERSION.SDK_INT >= 30) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        return types;
    }

    // Swiping Peiskos away ends the call with it.
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
