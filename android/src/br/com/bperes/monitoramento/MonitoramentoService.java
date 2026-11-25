package br.com.bperes.monitoramento;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Serviço de primeiro plano (Sentinela COA) para manter a recepção de alertas
 * e a síntese de voz (TextToSpeech) ativas mesmo quando o operador minimiza
 * o aplicativo ou bloqueia a tela do celular.
 */
public class MonitoramentoService extends Service {

    public static final String ACAO_INICIAR = "br.com.bperes.monitoramento.ACAO_SENTINELA_INICIAR";
    public static final String ACAO_PARAR = "br.com.bperes.monitoramento.ACAO_SENTINELA_PARAR";

    private static final String CANAL_ID = "bp_coa_sentinela";
    private static final int NOTIF_ID = 2041;
    private static final String PREFS = "monitoramento";
    private static final String PREF_SEGUNDO_PLANO = "segundo_plano";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public void onCreate() {
        super.onCreate();
        criarCanalNotificacao();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACAO_PARAR.equals(intent.getAction())) {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            prefs.edit().putBoolean(PREF_SEGUNDO_PLANO, false).apply();
            pararLocks();
            if (Build.VERSION.SDK_INT >= 24) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
            stopSelf();
            return START_NOT_STICKY;
        }

        Notification notificacao = construirNotificacao();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, notificacao, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIF_ID, notificacao);
            }
        } catch (Exception ignored) {
            try {
                startForeground(NOTIF_ID, notificacao);
            } catch (Exception ignoredFallback) {
            }
        }

        adquirirLocks();
        return START_STICKY;
    }

    private void adquirirLocks() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MonitoramentoBP::SentinelaCoa");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire();
            }
        } catch (Exception ignored) {
        }

        try {
            if (wifiLock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    int modoWifi = Build.VERSION.SDK_INT >= 29
                            ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                            : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    wifiLock = wm.createWifiLock(modoWifi, "MonitoramentoBP::WifiCoa");
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) {
                wifiLock.acquire();
            }
        } catch (Exception ignored) {
        }
    }

    private void pararLocks() {
        if (wakeLock != null) {
            try {
                if (wakeLock.isHeld()) wakeLock.release();
            } catch (Exception ignored) {
            }
            wakeLock = null;
        }
        if (wifiLock != null) {
            try {
                if (wifiLock.isHeld()) wifiLock.release();
            } catch (Exception ignored) {
            }
            wifiLock = null;
        }
    }

    private void criarCanalNotificacao() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel canal = new NotificationChannel(
                CANAL_ID,
                "Sentinela COA em 2º plano",
                NotificationManager.IMPORTANCE_LOW
        );
        canal.setDescription("Mantém os alertas por voz ativos com tela bloqueada ou em segundo plano.");
        canal.setShowBadge(false);
        nm.createNotificationChannel(canal);
    }

    private Notification construirNotificacao() {
        int flagsPi = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);

        Intent abrirIntent = new Intent(this, MainActivity.class);
        abrirIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent piAbrir = PendingIntent.getActivity(this, 1, abrirIntent, flagsPi);

        Intent pararIntent = new Intent(this, MonitoramentoService.class);
        pararIntent.setAction(ACAO_PARAR);
        PendingIntent piParar = PendingIntent.getService(this, 2, pararIntent, flagsPi);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CANAL_ID)
                : new Notification.Builder(this);

        b.setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Monitoramento BP · Sentinela COA")
                .setContentText("Voz e alertas ativos em 2º plano")
                .setContentIntent(piAbrir)
                .setOngoing(true)
                .setOnlyAlertOnce(true);

        if (Build.VERSION.SDK_INT >= 21) {
            b.setCategory(Notification.CATEGORY_SERVICE)
                    .setVisibility(Notification.VISIBILITY_PUBLIC);
        }

        if (Build.VERSION.SDK_INT >= 20) {
            Notification.Action acaoParar = new Notification.Action.Builder(
                    android.R.drawable.ic_media_pause,
                    "Pausar 2º plano",
                    piParar
            ).build();
            b.addAction(acaoParar);
        } else {
            b.addAction(android.R.drawable.ic_media_pause, "Pausar 2º plano", piParar);
        }

        return b.build();
    }

    @Override
    public void onDestroy() {
        pararLocks();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
