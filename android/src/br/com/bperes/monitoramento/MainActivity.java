package br.com.bperes.monitoramento;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.webkit.JavascriptInterface;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;
import android.graphics.Color;
import android.net.Uri;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayDeque;

/**
 * Monitoramento Branco Peres.
 *
 * Casca de aplicativo sobre a tela de monitoramento do portal Solinftec
 * (analytic-map-v4). Toda a autenticação continua sendo do portal: o token fica no
 * localStorage do WebView, que é persistente entre execuções. Você loga uma vez e
 * o app abre direto no mapa.
 *
 * Nada aqui armazena senha, e nada aqui burla controle de acesso do fornecedor.
 */
public class MainActivity extends Activity {

    /**
     * Tela de destino: o PWA Branco Peres no Netlify, que abre direto no mapa de
     * monitoramento do portal e acrescenta a Central de Alertas (velocidade, RPM,
     * troca de turno, motor ocioso) com pop-up, voz e histórico.
     * A autenticação continua sendo feita pela função serverless do PWA.
     * Para voltar ao portal puro, troque por:
     *   https://branco-peres-cana.saas-solinftec.com/#!/details/analytic-map-v4
     */
    private static final String HOME_URL =
            "https://sgpa-solinftec-bpa.netlify.app/";

    /** Hosts que pertencem ao portal (navegacao permanece dentro do app). */
    private static final String[] ALLOWED_HOSTS = {
            "branco-peres-cana.saas-solinftec.com",
            "solinftec-frontends.saas-solinftec.com",
            // Monit+: o portal abre https://monitplus.saas-solinftec.com/?token=...
            // via window.open no header. Mantendo aqui, o atalho funciona dentro do app.
            "monitplus.saas-solinftec.com",
            "api-br.saas-solinftec.com",
            "api-usa.saas-solinftec.com",
            "data-analytics.saas-solinftec.com",
            "sgpa-solinftec-bpa.netlify.app",
            "api.mapbox.com",
            "events.mapbox.com",
            "tiles.mapbox.com"
    };

    private static final String TRUSTED_PWA_HOST = "sgpa-solinftec-bpa.netlify.app";

    /**
     * User agent de desktop: o portal e uma aplicacao de cabine/escritorio e nao
     * tem layout mobile. Sem isto a tela de mapa quebra em telas pequenas.
     */
    private static final String UA_DESKTOP =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/122.0.0.0 Safari/537.36";
    private static final String UA_MOBILE = null; // deixa o WebView usar o padrao

    private static final String PREFS = "monitoramento";
    private static final String PREF_UA_DESKTOP = "ua_desktop";
    private static final String PREF_TELA_acesa = "tela_acesa";

    private WebView web;
    private volatile TextToSpeech tts;
    private volatile boolean vozPronta = false;
    private volatile boolean origemAppConfiavel = true;
    private final Object travaVoz = new Object();
    private final ArrayDeque<FalaPendente> filaVozPendente = new ArrayDeque<>();
    private boolean inicializandoVoz;
    private boolean drenandoVoz;
    private ProgressBar barra;
    private TextView engrenagem;
    private SharedPreferences prefs;
    private long ultimoBack = 0L;

    private static final class FalaPendente {
        final String texto;
        final double volume;
        final double taxa;
        final String nomeVoz;

        FalaPendente(String texto, double volume, double taxa, String nomeVoz) {
            this.texto = texto;
            this.volume = volume;
            this.taxa = taxa;
            this.nomeVoz = nomeVoz;
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        FrameLayout raiz = new FrameLayout(this);
        raiz.setBackgroundColor(Color.parseColor("#101010"));

        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        raiz.addView(web);

        barra = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        FrameLayout.LayoutParams lpBarra = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
        lpBarra.topMargin = 0;
        barra.setLayoutParams(lpBarra);
        barra.setMax(100);
        raiz.addView(barra);

        engrenagem = new TextView(this);
        engrenagem.setText("⚙");
        engrenagem.setTextSize(20f);
        engrenagem.setTextColor(Color.WHITE);
        engrenagem.setGravity(android.view.Gravity.CENTER);
        engrenagem.setBackgroundResource(R.drawable.fab_bg);
        FrameLayout.LayoutParams lpFab = new FrameLayout.LayoutParams(dp(44), dp(44));
        lpFab.gravity = android.view.Gravity.BOTTOM | android.view.Gravity.END;
        lpFab.rightMargin = dp(14);
        lpFab.bottomMargin = dp(14);
        engrenagem.setLayoutParams(lpFab);
        engrenagem.setAlpha(0.35f);
        engrenagem.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                engrenagem.setAlpha(1f);
                mostrarMenu();
            }
        });
        raiz.addView(engrenagem);

        setContentView(raiz);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                     // guarda a sessão (token)
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);     // alarmes sonoros do mapa
        // Popups (target=_blank) sao carregados na propria janela: sem um handler de
        // nova janela, habilitar multiplas janelas deixaria o clique morto.
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setTextZoom(100);
        s.setSupportZoom(false);                          // pinch fica com o Mapbox
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        aplicarUserAgent();

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (android.os.Build.VERSION.SDK_INT >= 21) {
            cm.setAcceptThirdPartyCookies(web, true);     // iframe do mapa e outro dominio
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String urlAtual, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, urlAtual, favicon);
                Uri u = urlAtual == null ? null : Uri.parse(urlAtual);
                origemAppConfiavel = u != null && TRUSTED_PWA_HOST.equalsIgnoreCase(u.getHost());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u.getHost() != null && ehDoPortal(u.getHost())) {
                    return false; // segue dentro do app
                }
                try {                                  // links externos vao para o navegador
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    view.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            toast("Sem conexão com o portal. Toque em ⚙ para tentar de novo.");
                        }
                    }, 400);
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int novoProgresso) {
                barra.setProgress(novoProgresso);
                barra.setVisibility(novoProgresso < 100 ? View.VISIBLE : View.GONE);
            }
        });

        if (prefs.getBoolean(PREF_TELA_acesa, true)) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }

        // Deep link (QR code / "abrir com") chega aqui.
        Intent i = getIntent();
        String url = HOME_URL;
        if (i != null && i.getData() != null && ehDoPortalHost(i.getData().getHost())) {
            url = i.getData().toString();
        }
        Uri destinoInicial = Uri.parse(url);
        origemAppConfiavel = destinoInicial != null && TRUSTED_PWA_HOST.equalsIgnoreCase(destinoInicial.getHost());
        // Ponte de voz: o WebView não implementa speechSynthesis, então a Central de
        // Alertas chama window.AndroidTTS.falar(...) / .parar() / .vibrar(ms).
        web.addJavascriptInterface(new PonteVoz(), "AndroidTTS");
        iniciarVoz();
        web.loadUrl(url);
    }

    private void notificarFimFala() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != null && origemAppConfiavel) {
                    web.evaluateJavascript("window.dispatchEvent(new Event('bperes-tts-fim'))", null);
                }
            }
        });
    }

    /** Prepara o motor de voz do aparelho (Google TTS / Samsung, etc.) em pt-BR. */
    private void iniciarVoz() {
        synchronized (travaVoz) {
            if (tts != null || inicializandoVoz) return;
            inicializandoVoz = true;
        }
        try {
            tts = new TextToSpeech(getApplicationContext(), new TextToSpeech.OnInitListener() {
                @Override
                public void onInit(int status) {
                    synchronized (travaVoz) {
                        inicializandoVoz = false;
                    }
                    if (status != TextToSpeech.SUCCESS) {
                        synchronized (travaVoz) {
                            tts = null;
                            vozPronta = false;
                        }
                        return;
                    }
                    try {
                        int r = tts.setLanguage(new Locale("pt", "BR"));
                        if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                            tts.setLanguage(Locale.getDefault());
                        }
                        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                            @Override
                            public void onStart(String utteranceId) {
                            }

                            @Override
                            public void onDone(String utteranceId) {
                                notificarFimFala();
                            }

                            @Override
                            public void onError(String utteranceId) {
                                notificarFimFala();
                            }
                        });
                    } catch (Exception ignored) {
                    }
                    drenarFalasPendentes();
                }
            });
        } catch (Exception ignored) {
            synchronized (travaVoz) {
                tts = null;
                vozPronta = false;
                inicializandoVoz = false;
            }
        }
    }

    private void drenarFalasPendentes() {
        synchronized (travaVoz) {
            if (tts == null) return;
            vozPronta = true;
            drenandoVoz = true;
        }
        while (true) {
            FalaPendente pendente;
            synchronized (travaVoz) {
                pendente = filaVozPendente.pollFirst();
                if (pendente == null) {
                    drenandoVoz = false;
                    return;
                }
            }
            falarPronto(pendente.texto, pendente.volume, pendente.taxa, pendente.nomeVoz);
        }
    }

    private static double limitar(double v, double min, double max) {
        if (Double.isNaN(v) || v <= 0) return min;
        return Math.max(min, Math.min(max, v));
    }

    /** Mantém compatibilidade interna com falas que não selecionam voz. */
    private void falar(final String texto, final double volume, final double taxa) {
        falar(texto, volume, taxa, null);
    }

    /** Fala com a voz pedida; se o motor ainda estiver acordando, guarda a frase e a voz. */
    private void falar(final String texto, final double volume, final double taxa, final String nomeVoz) {
        if (texto == null || texto.trim().isEmpty()) return;
        boolean enfileirada = false;
        boolean iniciar = false;
        synchronized (travaVoz) {
            if (tts == null || !vozPronta || drenandoVoz) {
                filaVozPendente.addLast(new FalaPendente(texto, volume, taxa, nomeVoz));
                enfileirada = true;
                iniciar = tts == null && !inicializandoVoz;
            }
        }
        if (enfileirada) {
            if (iniciar) iniciarVoz();
            return;
        }
        falarPronto(texto, volume, taxa, nomeVoz);
    }

    private void falarPronto(final String texto, final double volume, final double taxa, final String nomeVoz) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 21) {
                        Voice escolhida = null;
                        if (nomeVoz != null && !nomeVoz.trim().isEmpty()) {
                            Set<Voice> disponiveis = tts.getVoices();
                            if (disponiveis != null) {
                                for (Voice voz : disponiveis) {
                                    if (nomeVoz.equals(voz.getName())) { escolhida = voz; break; }
                                }
                            }
                        }
                        if (escolhida != null) tts.setVoice(escolhida);
                        else tts.setLanguage(new Locale("pt", "BR"));
                    }
                    tts.setSpeechRate((float) limitar(taxa, 0.6, 1.6) * 1.05f);
                    tts.setPitch(1.0f);
                    if (Build.VERSION.SDK_INT >= 21) {
                        Bundle p = new Bundle();
                        p.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME,
                                (float) limitar(volume, 0.2, 1.0));
                        tts.speak(texto, TextToSpeech.QUEUE_ADD, p, "bp-alerta-" + System.currentTimeMillis());
                    } else {
                        tts.speak(texto, TextToSpeech.QUEUE_ADD, null);
                    }
                } catch (Exception ignored) {
                }
            }
        });
    }

    /**
     * Objetos expostos ao JavaScript da Central de Alertas.
     * Só fala, cala e vibra: nenhum dado do aparelho é lido por aqui.
     */
    public class PonteVoz {
        @JavascriptInterface
        public boolean temVoz() {
            return origemAppConfiavel && vozPronta && tts != null;
        }

        @JavascriptInterface
        public void falar(String texto, double volume, double taxa) {
            if (!origemAppConfiavel) return;
            MainActivity.this.falar(texto, volume, taxa);
        }

        @JavascriptInterface
        public void falarComVoz(String texto, double volume, double taxa, String nomeVoz) {
            if (!origemAppConfiavel) return;
            MainActivity.this.falar(texto, volume, taxa, nomeVoz);
        }

        @JavascriptInterface
        public String vozes() {
            JSONArray lista = new JSONArray();
            if (!origemAppConfiavel || Build.VERSION.SDK_INT < 21 || !vozPronta || tts == null) return lista.toString();
            try {
                Set<Voice> disponiveis = tts.getVoices();
                if (disponiveis != null) for (Voice voz : disponiveis) {
                    JSONObject item = new JSONObject();
                    item.put("id", voz.getName());
                    item.put("name", voz.getName());
                    item.put("lang", voz.getLocale() == null ? "" : voz.getLocale().toLanguageTag());
                    lista.put(item);
                }
            } catch (Exception ignored) {
            }
            return lista.toString();
        }

        @JavascriptInterface
        public void gerenciarVozes() {
            if (!origemAppConfiavel) return;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        startActivity(new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA));
                    } catch (Exception ignored) {
                        toast("Não foi possível abrir a tela de vozes do Android.");
                    }
                }
            });
        }

        @JavascriptInterface
        public void parar() {
            if (!origemAppConfiavel) return;
            synchronized (travaVoz) {
                filaVozPendente.clear();
            }
            final TextToSpeech t = tts;
            if (t != null) runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try { t.stop(); } catch (Exception ignored) { }
                }
            });
        }

        @JavascriptInterface
        public void vibrar(int ms) {
            if (!origemAppConfiavel) return;
            final int dur = Math.max(20, Math.min(1200, ms));
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Vibrator v;
                        if (Build.VERSION.SDK_INT >= 31) {
                            VibratorManager mgr = (VibratorManager)
                                    getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                            v = mgr == null ? null : mgr.getDefaultVibrator();
                        } else {
                            v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                        }
                        if (v == null || !v.hasVibrator()) return;
                        if (Build.VERSION.SDK_INT >= 26) {
                            v.vibrate(VibrationEffect.createOneShot(dur, VibrationEffect.DEFAULT_AMPLITUDE));
                        } else {
                            v.vibrate(dur);
                        }
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        @JavascriptInterface
        public String versao() {
            return "AndroidTTS 1.3";
        }
    }

    private boolean ehDoPortalHost(String host) {
        return host != null && ehDoPortal(host);
    }

    private boolean ehDoPortal(String host) {
        for (String h : ALLOWED_HOSTS) {
            if (host.equals(h) || host.endsWith("." + h)) return true;
        }
        return false;
    }

    private void aplicarUserAgent() {
        if (prefs.getBoolean(PREF_UA_DESKTOP, true)) {
            web.getSettings().setUserAgentString(UA_DESKTOP);
        } else {
            web.getSettings().setUserAgentString(UA_MOBILE);
        }
    }

    private void mostrarMenu() {
        final String[] opcoes = new String[]{
                "Recarregar o mapa",
                prefs.getBoolean(PREF_UA_DESKTOP, true)
                        ? "Usar layout do celular (desligar modo desktop)"
                        : "Usar layout de computador (desktop)",
                prefs.getBoolean(PREF_TELA_acesa, true)
                        ? "Desligar tela sempre acesa"
                        : "Ligar tela sempre acesa",
                "Trocar de usuário / limpar sessão",
                "Sobre"
        };
        new AlertDialog.Builder(this)
                .setTitle("Monitoramento BP")
                .setItems(opcoes, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int qual) {
                        switch (qual) {
                            case 0:
                                web.reload();
                                break;
                            case 1:
                                boolean agora = !prefs.getBoolean(PREF_UA_DESKTOP, true);
                                prefs.edit().putBoolean(PREF_UA_DESKTOP, agora).apply();
                                aplicarUserAgent();
                                web.reload();
                                toast(agora ? "Layout desktop ativado." : "Layout celular ativado.");
                                break;
                            case 2:
                                boolean acesa = !prefs.getBoolean(PREF_TELA_acesa, true);
                                prefs.edit().putBoolean(PREF_TELA_acesa, acesa).apply();
                                if (acesa) {
                                    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                                } else {
                                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                                }
                                break;
                            case 3:
                                limparSessao();
                                break;
                            case 4:
                                sobre();
                                break;
                            default:
                                break;
                        }
                    }
                })
                .setNegativeButton("Fechar", null)
                .show();
    }

    /** Apaga cookies e localStorage do WebView: volta a pedir login. */
    private void limparSessao() {
        new AlertDialog.Builder(this)
                .setTitle("Limpar sessão")
                .setMessage("Isso desloga o app. Você terá que digitar usuário e senha de novo na próxima abertura.")
                .setPositiveButton("Limpar", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int i) {
                        CookieManager.getInstance().removeAllCookies(null);
                        CookieManager.getInstance().flush();
                        WebStorage.getInstance().deleteAllData();
                        web.clearHistory();
                        web.loadUrl(HOME_URL);
                        toast("Sessão limpa.");
                    }
                })
                .setNegativeButton("Cancelar", null)
                .show();
    }

    private void sobre() {
        String versao = "1.0";
        try {
            versao = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
        }
        new AlertDialog.Builder(this)
                .setTitle("Sobre")
                .setMessage("Monitoramento BP v" + versao
                        + "\n\nCasca de aplicativo sobre a tela do portal Solinftec."
                        + "\n\nA conta, os dados e a validade da sessão são controlados pelo portal."
                        + "\n\nLogin: fica salvo neste app (localStorage do WebView)."
                        + "\n\nDestino:\n" + HOME_URL)
                .setPositiveButton("OK", null)
                .show();
    }

    private void toast(final String texto) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, texto, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /** Voltar navega dentro do portal; no primeiro nivel, dois toques saem. */
    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        long agora = System.currentTimeMillis();
        if (agora - ultimoBack < 2200) {
            finish();
            return;
        }
        ultimoBack = agora;
        toast("Toque de novo em VOLTAR para sair do app.");
    }

    @Override
    public boolean onKeyDown(int codigo, KeyEvent evento) {
        if (codigo == KeyEvent.KEYCODE_VOLUME_DOWN || codigo == KeyEvent.KEYCODE_MENU) {
            engrenagem.setAlpha(1f);
            mostrarMenu();
            return true;
        }
        return super.onKeyDown(codigo, evento);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.onResume();
            web.postDelayed(new Runnable() {
                @Override
                public void run() {
                    if (web != null) web.evaluateJavascript(
                            "window.dispatchEvent(new Event('bperes-vozes-atualizadas'))", null);
                }
            }, 500);
        }
    }

    @Override
    protected void onDestroy() {
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (Exception ignored) {
            }
            tts = null;
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private int dp(int valor) {
        return Math.round(valor * getResources().getDisplayMetrics().density);
    }
}
