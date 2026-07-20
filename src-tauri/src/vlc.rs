//! Orbita — Player de vídeo do monitor (libVLC numa view nativa).
//!
//! O VLC toca o VÍDEO, e só o vídeo: a instância é criada com `--no-audio`, de
//! modo que o áudio da câmera é impossível de sair. Quem toca é o SOM DIRETO, no
//! WebView (ver `src/lib/transport.ts`) — e é justamente por ver a câmera e ouvir
//! a referência que o monitor serve para conferir o sync, em vez de ser só um
//! preview. Silenciar aqui, na criação da instância, torna isso estrutural: não
//! depende de ninguém lembrar de chamar um `mute`.
//!
//! libVLC é carregado em runtime via dlopen (libloading): sem dependência de
//! build, e com ausência graciosa — se o VLC.app não estiver instalado,
//! `vlc_available()` devolve false e a UI mostra o monitor vazio em vez de
//! quebrar.
//!
//! A view nativa fica ACIMA do WKWebView, o que tem uma consequência de layout:
//! nada em HTML consegue desenhar por cima dela. O frontend reporta o retângulo
//! da tela do monitor (`vlc_set_rect`) e a esconde (`vlc_set_visible`) quando
//! algo precisaria cobri-la.
//!
//! WINDOWS: ainda não implementado. libVLC lá usa `libvlc_media_player_set_hwnd`
//! com uma janela filha, em vez de `set_nsobject` com uma NSView — mesma forma,
//! outra API de janela. Os comandos existem e falham com erro claro, para o app
//! seguir rodando sem monitor (ver CLAUDE.md: o app DEVE rodar nos dois SOs).

#![allow(clippy::missing_safety_doc)]

use std::sync::{Arc, Mutex};

pub struct VlcState {
    #[cfg(target_os = "macos")]
    inner: Arc<Mutex<Option<macos::VlcInner>>>,
}

impl VlcState {
    pub fn new() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            inner: Arc::new(Mutex::new(None)),
        }
    }
}

#[cfg(not(target_os = "macos"))]
const UNSUPPORTED: &str = "O monitor de vídeo ainda só funciona no macOS.";

// ── Comandos Tauri ────────────────────────────────────────────────────────────

/// Há libVLC utilizável? Se não, o app roda igual — só sem monitor.
#[tauri::command]
pub fn vlc_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::available()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Abre um arquivo no monitor, posiciona a view e pausa em `start_ms`.
///
/// Chamado a cada troca do arquivo NO AR — o que acontece ao mudar de ângulo e
/// ao cruzar a fronteira entre dois pedaços da mesma câmera.
#[tauri::command]
pub fn vlc_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, VlcState>,
    path: String,
    start_ms: i64,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::open(&app, state.inner.clone(), path, start_ms, x, y, w, h)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, path, start_ms, x, y, w, h);
        Err(UNSUPPORTED.into())
    }
}

#[tauri::command]
pub fn vlc_set_rect(
    app: tauri::AppHandle,
    state: tauri::State<'_, VlcState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::set_rect(&app, state.inner.clone(), x, y, w, h)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, x, y, w, h);
        Ok(())
    }
}

#[tauri::command]
pub fn vlc_set_visible(
    app: tauri::AppHandle,
    state: tauri::State<'_, VlcState>,
    visible: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::set_visible(&app, state.inner.clone(), visible)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, visible);
        Ok(())
    }
}

#[tauri::command]
pub fn vlc_play(state: tauri::State<'_, VlcState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::set_paused(&state.inner, false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        Ok(())
    }
}

#[tauri::command]
pub fn vlc_pause(state: tauri::State<'_, VlcState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::set_paused(&state.inner, true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        Ok(())
    }
}

/// Fecha a mídia e esconde a view (usado quando o ângulo não tem vídeo ali).
#[tauri::command]
pub fn vlc_stop(app: tauri::AppHandle, state: tauri::State<'_, VlcState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::stop(&app, state.inner.clone())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state);
        Ok(())
    }
}

/// Posição DENTRO do arquivo aberto, em ms.
#[tauri::command]
pub fn vlc_seek(state: tauri::State<'_, VlcState>, ms: i64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::seek(&state.inner, ms)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, ms);
        Ok(())
    }
}

/// Posição atual do VLC, em ms (-1 = sem player). Serve à correção de deriva:
/// o relógio é o som direto, e o vídeo é reposto quando se afasta demais.
#[tauri::command]
pub fn vlc_time(state: tauri::State<'_, VlcState>) -> i64 {
    #[cfg(target_os = "macos")]
    {
        macos::time(&state.inner)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        -1
    }
}

// ── Implementação macOS ───────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::os::raw::c_double;
    use std::path::Path;

    use cocoa::base::{id, nil, NO, YES};
    use cocoa::foundation::{NSPoint, NSRect, NSSize};
    use libloading::{Library, Symbol};
    use objc::{class, msg_send, sel, sel_impl};
    use tauri::Manager;

    const CORE_DYLIB: &str = "/Applications/VLC.app/Contents/MacOS/lib/libvlccore.dylib";
    const VLC_DYLIB: &str = "/Applications/VLC.app/Contents/MacOS/lib/libvlc.dylib";
    const VLC_PLUGINS: &str = "/Applications/VLC.app/Contents/MacOS/plugins";

    type Inst = *mut c_void;
    type Media = *mut c_void;
    type Player = *mut c_void;

    // Subconjunto mínimo da libVLC 3.x.
    type FnNew = unsafe extern "C" fn(c_int, *const *const c_char) -> Inst;
    type FnMediaNewPath = unsafe extern "C" fn(Inst, *const c_char) -> Media;
    type FnMediaRelease = unsafe extern "C" fn(Media);
    type FnMpNew = unsafe extern "C" fn(Inst) -> Player;
    type FnMpSetMedia = unsafe extern "C" fn(Player, Media);
    type FnMpSetNsobject = unsafe extern "C" fn(Player, *mut c_void);
    type FnMpPlay = unsafe extern "C" fn(Player) -> c_int;
    type FnMpSetPause = unsafe extern "C" fn(Player, c_int);
    type FnMpStop = unsafe extern "C" fn(Player);
    type FnMpSetTime = unsafe extern "C" fn(Player, i64);
    type FnMpGetTime = unsafe extern "C" fn(Player) -> i64;

    pub struct VlcInner {
        // As libs precisam continuar vivas: os ponteiros de função abaixo só
        // valem enquanto elas estiverem carregadas.
        _core: Library,
        _lib: Library,
        inst: Inst,
        mp: Player,
        view: id, // NSView (retida pelo addSubview do contentView)
        media_new_path: FnMediaNewPath,
        media_release: FnMediaRelease,
        mp_set_media: FnMpSetMedia,
        mp_play: FnMpPlay,
        mp_set_pause: FnMpSetPause,
        mp_stop: FnMpStop,
        mp_set_time: FnMpSetTime,
        mp_get_time: FnMpGetTime,
    }

    // libVLC é thread-safe para play/seek; toda operação de NSView é roteada para
    // a main thread (AppKit exige). Send para caber no Mutex do estado do Tauri.
    unsafe impl Send for VlcInner {}

    pub fn available() -> bool {
        Path::new(VLC_DYLIB).exists() && Path::new(CORE_DYLIB).exists()
    }

    pub fn open(
        app: &tauri::AppHandle,
        inner: Arc<Mutex<Option<VlcInner>>>,
        path: String,
        start_ms: i64,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Result<(), String> {
        let app2 = app.clone();
        run_main(app, move || unsafe {
            let mut guard = inner.lock().map_err(|_| "lock VLC".to_string())?;
            if guard.is_none() {
                *guard = Some(init_vlc(&app2)?);
            }
            let v = guard.as_mut().unwrap();

            set_view_frame(&app2, v.view, x, y, w, h)?;
            let _: () = msg_send![v.view, setHidden: NO];

            let cpath = CString::new(path.clone()).map_err(|_| "path inválido".to_string())?;
            let media: Media = (v.media_new_path)(v.inst, cpath.as_ptr());
            if media.is_null() {
                return Err(format!("libVLC não abriu: {}", path));
            }
            (v.mp_set_media)(v.mp, media);
            (v.media_release)(media);

            // set_time só vale depois que o player começou a decodificar; por isso
            // o play breve. Fica PAUSADO: quem manda tocar é o transporte, quando
            // o som direto estiver tocando.
            (v.mp_play)(v.mp);
            (v.mp_set_pause)(v.mp, 1);
            (v.mp_set_time)(v.mp, start_ms.max(0));
            Ok(())
        })
    }

    pub fn set_rect(
        app: &tauri::AppHandle,
        inner: Arc<Mutex<Option<VlcInner>>>,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Result<(), String> {
        let app2 = app.clone();
        run_main(app, move || unsafe {
            let guard = inner.lock().map_err(|_| "lock VLC".to_string())?;
            if let Some(v) = guard.as_ref() {
                set_view_frame(&app2, v.view, x, y, w, h)?;
            }
            Ok(())
        })
    }

    pub fn set_visible(
        app: &tauri::AppHandle,
        inner: Arc<Mutex<Option<VlcInner>>>,
        visible: bool,
    ) -> Result<(), String> {
        run_main(app, move || unsafe {
            let guard = inner.lock().map_err(|_| "lock VLC".to_string())?;
            if let Some(v) = guard.as_ref() {
                let hidden = if visible { NO } else { YES };
                let _: () = msg_send![v.view, setHidden: hidden];
            }
            Ok(())
        })
    }

    pub fn stop(app: &tauri::AppHandle, inner: Arc<Mutex<Option<VlcInner>>>) -> Result<(), String> {
        run_main(app, move || unsafe {
            let guard = inner.lock().map_err(|_| "lock VLC".to_string())?;
            if let Some(v) = guard.as_ref() {
                (v.mp_stop)(v.mp);
                let _: () = msg_send![v.view, setHidden: YES];
            }
            Ok(())
        })
    }

    pub fn set_paused(inner: &Arc<Mutex<Option<VlcInner>>>, paused: bool) -> Result<(), String> {
        let guard = inner.lock().map_err(|_| "lock VLC".to_string())?;
        if let Some(v) = guard.as_ref() {
            unsafe { (v.mp_set_pause)(v.mp, if paused { 1 } else { 0 }) };
        }
        Ok(())
    }

    pub fn seek(inner: &Arc<Mutex<Option<VlcInner>>>, ms: i64) -> Result<(), String> {
        let guard = inner.lock().map_err(|_| "lock VLC".to_string())?;
        if let Some(v) = guard.as_ref() {
            unsafe { (v.mp_set_time)(v.mp, ms.max(0)) };
        }
        Ok(())
    }

    pub fn time(inner: &Arc<Mutex<Option<VlcInner>>>) -> i64 {
        let guard = match inner.lock() {
            Ok(g) => g,
            Err(_) => return -1,
        };
        match guard.as_ref() {
            Some(v) => unsafe { (v.mp_get_time)(v.mp) },
            None => -1,
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    /// PRECONDIÇÃO: main thread (cria NSView).
    unsafe fn init_vlc(app: &tauri::AppHandle) -> Result<VlcInner, String> {
        std::env::set_var("VLC_PLUGIN_PATH", VLC_PLUGINS);

        // O core entra primeiro com RTLD_GLOBAL: a libvlc referencia
        // `@rpath/libvlccore.dylib` sem rpath, e o dyld só resolve isso se o core
        // já estiver carregado sob esse install name.
        use libloading::os::unix::{Library as UnixLib, RTLD_GLOBAL, RTLD_NOW};
        let core: Library = UnixLib::open(Some(CORE_DYLIB), RTLD_NOW | RTLD_GLOBAL)
            .map_err(|e| format!("libvlccore: {}", e))?
            .into();
        let lib = Library::new(VLC_DYLIB).map_err(|e| format!("libvlc: {}", e))?;

        macro_rules! sym {
            ($t:ty, $name:expr) => {{
                let s: Symbol<$t> = lib
                    .get($name)
                    .map_err(|e| format!("símbolo {}: {}", String::from_utf8_lossy($name), e))?;
                *s
            }};
        }
        let f_new: FnNew = sym!(FnNew, b"libvlc_new\0");
        let media_new_path: FnMediaNewPath = sym!(FnMediaNewPath, b"libvlc_media_new_path\0");
        let media_release: FnMediaRelease = sym!(FnMediaRelease, b"libvlc_media_release\0");
        let mp_new: FnMpNew = sym!(FnMpNew, b"libvlc_media_player_new\0");
        let mp_set_media: FnMpSetMedia = sym!(FnMpSetMedia, b"libvlc_media_player_set_media\0");
        let mp_set_nsobject: FnMpSetNsobject =
            sym!(FnMpSetNsobject, b"libvlc_media_player_set_nsobject\0");
        let mp_play: FnMpPlay = sym!(FnMpPlay, b"libvlc_media_player_play\0");
        let mp_set_pause: FnMpSetPause = sym!(FnMpSetPause, b"libvlc_media_player_set_pause\0");
        let mp_stop: FnMpStop = sym!(FnMpStop, b"libvlc_media_player_stop\0");
        let mp_set_time: FnMpSetTime = sym!(FnMpSetTime, b"libvlc_media_player_set_time\0");
        let mp_get_time: FnMpGetTime = sym!(FnMpGetTime, b"libvlc_media_player_get_time\0");

        // `--no-audio`: o áudio da câmera fica IMPOSSÍVEL de sair, não apenas
        // desligado. Quem toca é o som direto, no WebView — ver o cabeçalho.
        let no_audio = CString::new("--no-audio").unwrap();
        let argv: [*const c_char; 1] = [no_audio.as_ptr()];
        let inst: Inst = f_new(1, argv.as_ptr());
        if inst.is_null() {
            return Err("libvlc_new falhou (plugins?)".into());
        }
        let mp: Player = mp_new(inst);
        if mp.is_null() {
            return Err("libvlc_media_player_new falhou".into());
        }

        let view = create_view(app)?;
        mp_set_nsobject(mp, view as *mut c_void);

        Ok(VlcInner {
            _core: core,
            _lib: lib,
            inst,
            mp,
            view,
            media_new_path,
            media_release,
            mp_set_media,
            mp_play,
            mp_set_pause,
            mp_stop,
            mp_set_time,
            mp_get_time,
        })
    }

    /// NSView anexada ao contentView, ACIMA do webview.
    unsafe fn create_view(app: &tauri::AppHandle) -> Result<id, String> {
        let win = app
            .get_webview_window("main")
            .ok_or_else(|| "janela 'main' não encontrada".to_string())?;
        let ns_window = win.ns_window().map_err(|e| e.to_string())? as id;
        if ns_window == nil {
            return Err("ns_window nulo".into());
        }
        let content: id = msg_send![ns_window, contentView];
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(16.0, 9.0));
        let view: id = msg_send![class!(NSView), alloc];
        let view: id = msg_send![view, initWithFrame: frame];
        let _: () = msg_send![view, setWantsLayer: YES];
        let _: () = msg_send![view, setHidden: YES];
        // NSWindowAbove = 1 → acima do WKWebView.
        let above: std::os::raw::c_long = 1;
        let _: () = msg_send![content, addSubview: view positioned: above relativeTo: nil];
        Ok(view)
    }

    /// Posiciona a view a partir de um rect em CSS px (= pontos do AppKit),
    /// convertendo a origem top-left (web) para bottom-left (AppKit). Main thread.
    unsafe fn set_view_frame(
        app: &tauri::AppHandle,
        view: id,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    ) -> Result<(), String> {
        let win = app
            .get_webview_window("main")
            .ok_or_else(|| "janela 'main' não encontrada".to_string())?;
        let ns_window = win.ns_window().map_err(|e| e.to_string())? as id;
        let content: id = msg_send![ns_window, contentView];
        let cframe: NSRect = msg_send![content, frame];
        let content_h: c_double = cframe.size.height;
        let ns_y = content_h - (y + h);
        let frame = NSRect::new(NSPoint::new(x, ns_y), NSSize::new(w, h));
        let _: () = msg_send![view, setFrame: frame];
        Ok(())
    }

    /// Executa na main thread e espera o resultado (AppKit exige main thread).
    fn run_main<F>(app: &tauri::AppHandle, f: F) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String> + Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())?
    }
}
