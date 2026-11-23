# Monitoramento BP — aplicativo Android (APK)

Ícone na tela inicial (brasão da Branco Peres) → **abre direto no monitoramento** (`#!/details/analytic-map-v4`), em tela cheia, sem abas, sem barra de endereço e **sem pedir login depois do primeiro acesso**.

**Arquivo:** `MonitoramentoBP.apk` · 117 KB · pacote `br.com.bperes.monitoramento` · **v1.1 (versionCode 2)** · minSdk 21 / target 34 · assinado v1+v2 com o mesmo keystore da v1.0.

> **v1.1 (22/11):** ícone do aplicativo trocado pelo brasão Branco Peres em todas as densidades
> (`mipmap-mdpi`…`xxxhdpi`, 48/72/96/144/192 px). Como a assinatura é a mesma, dá para instalar
> **por cima** da versão anterior sem perder a sessão salva. Se o launcher continuar mostrando o
> ícone antigo, é só cache dele: reinicie o aparelho ou desinstale/instale de novo.

---

## 1. Instalar (sem Play Store, sem Android Studio)

**Do telefone/tablet, sem computador:**
1. Transfira o `MonitoramentoBP.apk` para o aparelho (WhatsApp, e-mail, Drive, cabo USB).
2. Abra o arquivo. O Android vai reclamar: escolha **"Permitir instalar apps desconhecidos"** para o app que você usou (Chrome, Files etc.).
3. Instalar → abrir.

**Pelo computador, com ADB** (mais rápido se for instalar em vários aparelhos):

```bash
adb install -r MonitoramentoBP.apk
```

**Em vários aparelhos de uma vez:** use o MDM da fazenda/cabine (Hexnode, Scalefusion, Wallboard...) distribuindo o mesmo APK, ou o `adb install` em script. Não precisa de root nem de desenvolvedor habilitado depois de instalado.

## 2. Primeiro uso

1. Toque no ícone **Monitoramento BP**.
2. Vai aparecer o login do portal: digite usuário e senha **uma vez**.
3. Das próximas vezes, cai direto no mapa.

Se em algum dia o login reaparecer, é a sessão que expirou **no servidor da Solinftec** (a validade é decisão deles). Digite de novo e siga. Não é falha do app.

## 3. O menu ⚙ (canto inferior direito, quase invisível)

Toque no ⚙ (ou aperte o botão de volume para baixo, em aparelhos com botão físico):

| Opção | Para que serve |
|---|---|
| **Recarregar o mapa** | Atualiza a tela sem sair do app |
| **Layout de computador / do celular** | O padrão é desktop, porque o portal não tem versão mobile. Só mude se quiser testar |
| **Tela sempre acesa** | Ligado por padrão — feito para tablet de cabine que não pode apagar |
| **Trocar de usuário / limpar sessão** | Apaga cookies e localStorage do app (desloga). Use ao trocar de operador |
| **Sobre** | Versão e URL de destino |

## 4. Por que não precisa logar de novo

O portal guarda o token da sessão no `localStorage` da página. No app, isso fica no **armazenamento do WebView do app**, que é persistente: enquanto o app estiver instalado, o token continua lá e o próprio portal se reautentica ao abrir (`loginWithToken()`).

Consequências práticas:

- **Nada no app guarda sua senha.** Não existe campo salvo, existe só a sessão que o portal emitiu.
- **Desinstalar o app apaga a sessão** (e com ela o login). Atualizar por cima (`adb install -r`) mantém.
- O app tem `allowBackup="false"`: a sessão não sai por backup do Android.
- Permissões do APK: apenas `INTERNET` e `ACCESS_NETWORK_STATE`. Sem armazenamento externo, sem localização, sem câmera, sem contatos.

## 5. Limitações honestas

1. **Não é o app oficial da Solinftec.** É uma casca sobre a tela do portal, para uso interno da sua operação. Não está na Play Store e não deve ser distribuído publicamente.
2. **Rendimento do mapa.** A tela é Mapbox GL (WebGL) dentro de um WebView. Em tablet razoável (4 GB+ RAM, Android 8+) roda bem; em aparelho muito simples pode engasgar. Se travar: diminua as camadas ligadas (Interpolação, Trilha, NDVI) no painel de filtros.
3. **Recomendado Android 7 ou superior.** O `minSdk` é 21, mas o layout desktop e o WebGL dependem de um WebView do Chrome atualizado (vem pela Play Store). Em Android 5/6 antigos o mapa pode não aparecer.
4. **Exportações e links externos** (PDF/Excel do relatório, WhatsApp, Maps) abrem no navegador do aparelho, não dentro do app. O app é feito para **olhar o monitoramento**, não para trabalhar nos relatórios.
5. **Bloqueio de rotação/intenção:** a tela está em `fullSensor` (acompanha a rotação). Para tablet fixo em paisagem, troque `android:screenOrientation` no manifest para `landscape` e rebuildar.
6. **Atualizações exigem o mesmo keystore.** Sem o `keystore/monitoramento-release.jks` você não consegue instalar uma versão nova por cima — teria que desinstalar (e logar de novo). Guarde esse arquivo.

## 6. Personalizar (uma linha)

A tela de destino está no topo de `MainActivity.java`:

```java
private static final String HOME_URL =
    "https://branco-peres-cana.saas-solinftec.com/#!/details/analytic-map-v4";
```

Variações úteis:

| Destino | URL |
|---|---|
| Monitoramento com um equipamento já aberto | `.../#!/details/analytic-map-v4?equipment=57831` |
| Monitoramento clássico (v1) | `.../#!/details/map` |
| Conectividade | `.../#!/details/connectivity` |

**Monit+** (o monitoramento standalone da Solinftec) não tem URL fixa: o portal monta
`https://monitplus.saas-solinftec.com/?token=<token>&locale=...&unitSGPA=...` na hora, a partir da sua
sessão. Por isso, para usá-lo **dentro do app**, abra o mapa e toque no atalho **Monit+** do cabeçalho do
portal — este APK já deixa esse domínio abrir dentro do app, sem jogar você para o Chrome.

Depois de editar, rebuildar (item 7).

## 7. Reconstruir o APK

```bash
cd apk
./build.sh          # gera out/MonitoramentoBP.apk
```

O script não usa Gradle nem Android Studio. Dependências (todas baixadas de fontes oficiais):

| Peça | Origem | Serve para |
|---|---|---|
| `aapt2`, `zipalign` **linux-arm64** | [Commit451/android-arm-build-tools](https://android-arm-build-tools.commit451.com/) | compilar recursos e alinhar (o Google só publica x86_64) |
| `android.jar` API 34 | `dl.google.com/android/repository/platform-34-ext7_r03.zip` | compilar e linkar |
| `r8.jar` 8.13.25 | `dl.google.com/dl/android/maven2/com/android/tools/r8/...` | virar `.class` em `classes.dex` |
| `apksigner.jar` | build-tools 34 do Google | assinar v1+v2 |
| OpenJDK 21 | `apt` | `javac`, `jar`, `keytool` |

Nota: o D8 que vem no build-tools 34 (R8 8.2.2-dev) dá NullPointerException em classes anônimas; o script já usa um R8 mais novo por causa disso. Em x86_64 funciona o mesmo fluxo, só trocando o `aapt2`.

## 8. Contrato e segurança

Mesma nota da versão desktop: o app **não burla nada** — usa a sessão que o portal concede ao seu login, no dispositivo de quem tem o login. Antes de distribuir para terceiros ou de usar os dados fora do portal (integração, BI próprio), confirme o contrato com a Solinftec. E se você compartilhou a senha por mensagem/e-mail para montar isso, troque-a no portal (Perfil → Alterar senha): o app continua funcionando, só pede o login uma vez a mais.

## 9. Conteúdo do pacote

```
MonitoramentoBP.apk                     <- instalar no aparelho
keystore/monitoramento-release.jks      <- guardar (senha: só no seu cofre de senhas)
apk/AndroidManifest.xml
apk/src/br/com/bperes/monitoramento/MainActivity.java
apk/res/                                    (ícones 5 densidades, fab, strings)
apk/build.sh                                (compila sem Android Studio)
apk/ic_launcher-512.png
```
