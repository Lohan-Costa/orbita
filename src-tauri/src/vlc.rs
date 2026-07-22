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
//! build, e com ausência graciosa — se o VLC não estiver instalado,
//! `vlc_available()` devolve false e a UI mostra o monitor vazio em vez de
//! quebrar.
//!
//! A view nativa fica ACIMA do WebView, o que tem uma consequência de layout:
//! nada em HTML consegue desenhar por cima dela. O frontend reporta o retângulo
//! da tela do monitor (`vlc_set_rect`) e a esconde (`vlc_set_visible`) quando
//! algo precisaria cobri-la.
//!
//! Duas plataformas, duas APIs de janela nativa, mesma forma:
//! - **macOS**: `libvlc_media_player_set_nsobject` numa NSView anexada ao
//!   contentView da janela (módulo `macos`, abaixo).
//! - **Windows**: `libvlc_media_player_set_hwnd` numa HWND filha da janela
//!   principal (módulo `windows_impl`, abaixo). Coordenada é mais simples aqui:
//!   sem a inversão de eixo Y do AppKit, o retângulo do frontend (top-left, CSS
//!   px) mapeia direto pra `SetWindowPos`.

#![allow(clippy::missing_safety_doc)]

use std::sync::{Arc, Mutex};

pub struct VlcState {
    #[cfg(target_os = "macos")]
    inner: Arc<Mutex<Option<macos::VlcInner>>>,
    #[cfg(target_os = "windows")]
    inner: Arc<Mutex<Option<windows_impl::VlcInner>>>,
    // Segundo player, DEDICADO à prévia do bin: instância própria (COM áudio, ao
    // contrário do monitor `--no-audio`) e janela própria. Só no Windows — no
    // macOS o WKWebView decodifica ProRes, então a prévia via `<video>` já toca.
    #[cfg(target_os = "windows")]
    preview: Arc<Mutex<Option<windows_impl::VlcInner>>>,
}

impl VlcState {
    pub fn new() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            inner: Arc::new(Mutex::new(None)),
            #[cfg(target_os = "windows")]
            inner: Arc::new(Mutex::new(None)),
            #[cfg(target_os = "windows")]
            preview: Arc::new(Mutex::new(None)),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const UNSUPPORTED: &str = "O monitor de vídeo não funciona neste sistema.";

// ── Comandos Tauri ────────────────────────────────────────────────────────────

/// Há libVLC utilizável? Se não, o app roda igual — só sem monitor.
#[tauri::command]
pub fn vlc_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::available()
    }
    #[cfg(target_os = "windows")]
    {
        windows_impl::available()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    #[cfg(target_os = "windows")]
    {
        // Monitor: SEM áudio (é teste de sync, quem soa é o som direto) e sem
        // autoplay (quem manda tocar é o transporte).
        windows_impl::open(&app, state.inner.clone(), path, start_ms, x, y, w, h, false, false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    #[cfg(target_os = "windows")]
    {
        windows_impl::set_rect(&app, state.inner.clone(), x, y, w, h)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    #[cfg(target_os = "windows")]
    {
        windows_impl::set_visible(&app, state.inner.clone(), visible)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    #[cfg(target_os = "windows")]
    {
        windows_impl::set_paused(&state.inner, false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    #[cfg(target_os = "windows")]
    {
        windows_impl::set_paused(&state.inner, true)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    #[cfg(target_os = "windows")]
    {
        windows_impl::stop(&app, state.inner.clone())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    #[cfg(target_os = "windows")]
    {
        windows_impl::seek(&state.inner, ms)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    #[cfg(target_os = "windows")]
    {
        windows_impl::time(&state.inner)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = state;
        -1
    }
}

// ── Comandos da PRÉVIA (segundo player, com áudio) ─────────────────────────────
//
// Só engatam no Windows. `vlc_preview_open` devolve `true` quando de fato assumiu
// — no macOS devolve `false` e o frontend mantém o `<video>`/aviso (lá o ProRes
// já toca pelo WebView, então isto raramente é exercido).

/// Abre um arquivo na prévia, COM áudio e tocando. `true` = a prévia VLC assumiu.
#[tauri::command]
pub fn vlc_preview_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, VlcState>,
    path: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::open(&app, state.preview.clone(), path, 0, x, y, w, h, true, true)?;
        Ok(true)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state, path, x, y, w, h);
        Ok(false)
    }
}

#[tauri::command]
pub fn vlc_preview_close(
    app: tauri::AppHandle,
    state: tauri::State<'_, VlcState>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::stop(&app, state.preview.clone())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state);
        Ok(())
    }
}

#[tauri::command]
pub fn vlc_preview_set_paused(
    state: tauri::State<'_, VlcState>,
    paused: bool,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::set_paused(&state.preview, paused)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, paused);
        Ok(())
    }
}

#[tauri::command]
pub fn vlc_preview_seek(state: tauri::State<'_, VlcState>, ms: i64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::seek(&state.preview, ms)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (state, ms);
        Ok(())
    }
}

#[tauri::command]
pub fn vlc_preview_set_rect(
    app: tauri::AppHandle,
    state: tauri::State<'_, VlcState>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::set_rect(&app, state.preview.clone(), x, y, w, h)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state, x, y, w, h);
        Ok(())
    }
}

/// Posição e duração da prévia, em ms (`[tempo, duração]`; -1 quando indisponível).
/// Uma chamada só, para a barra de controle poder pintar posição e total.
#[tauri::command]
pub fn vlc_preview_state(state: tauri::State<'_, VlcState>) -> (i64, i64) {
    #[cfg(target_os = "windows")]
    {
        (
            windows_impl::time(&state.preview),
            windows_impl::duration(&state.preview),
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        (-1, -1)
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

// ── Implementação Windows ─────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::*;
    use std::ffi::{c_char, c_int, c_void, CString};
    use std::path::{Path, PathBuf};

    use libloading::{Library, Symbol};
    use tauri::Manager;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, RegisterClassExW, SetWindowPos, ShowWindow, HMENU,
        HWND_TOP, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOW, WNDCLASSEXW, WS_CHILD,
        WS_CLIPSIBLINGS,
    };

    type Inst = *mut c_void;
    type Media = *mut c_void;
    type Player = *mut c_void;

    // Mesmo subconjunto da libVLC 3.x do módulo macOS, trocando só a função que
    // entrega a superfície de desenho: `set_hwnd` em vez de `set_nsobject`.
    type FnNew = unsafe extern "C" fn(c_int, *const *const c_char) -> Inst;
    type FnMediaNewPath = unsafe extern "C" fn(Inst, *const c_char) -> Media;
    type FnMediaRelease = unsafe extern "C" fn(Media);
    type FnMpNew = unsafe extern "C" fn(Inst) -> Player;
    type FnMpSetMedia = unsafe extern "C" fn(Player, Media);
    type FnMpSetHwnd = unsafe extern "C" fn(Player, *mut c_void);
    type FnMpPlay = unsafe extern "C" fn(Player) -> c_int;
    type FnMpSetPause = unsafe extern "C" fn(Player, c_int);
    type FnMpStop = unsafe extern "C" fn(Player);
    type FnMpSetTime = unsafe extern "C" fn(Player, i64);
    type FnMpGetTime = unsafe extern "C" fn(Player) -> i64;
    type FnMpGetLength = unsafe extern "C" fn(Player) -> i64;

    pub struct VlcInner {
        // As libs precisam continuar vivas: os ponteiros de função abaixo só
        // valem enquanto elas estiverem carregadas.
        _core: Library,
        _lib: Library,
        inst: Inst,
        mp: Player,
        hwnd: HWND, // janela filha (retida pela janela principal como parent)
        media_new_path: FnMediaNewPath,
        media_release: FnMediaRelease,
        mp_set_media: FnMpSetMedia,
        mp_play: FnMpPlay,
        mp_set_pause: FnMpSetPause,
        mp_stop: FnMpStop,
        mp_set_time: FnMpSetTime,
        mp_get_time: FnMpGetTime,
        mp_get_length: FnMpGetLength,
    }

    // libVLC é thread-safe para play/seek; toda operação de HWND é roteada para
    // a main thread (janelas só podem ser manipuladas pela thread que as criou).
    unsafe impl Send for VlcInner {}

    /// `C:\Program Files\VideoLAN\VLC` (ou a versão 32-bit), se o VLC estiver
    /// instalado ali. Sem instalador custom não há outro lugar razoável a checar.
    fn vlc_dir() -> Option<PathBuf> {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(pf) = std::env::var(var) {
                let dir = Path::new(&pf).join("VideoLAN").join("VLC");
                if dir.join("libvlc.dll").is_file() && dir.join("libvlccore.dll").is_file() {
                    return Some(dir);
                }
            }
        }
        None
    }

    pub fn available() -> bool {
        vlc_dir().is_some()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open(
        app: &tauri::AppHandle,
        inner: Arc<Mutex<Option<VlcInner>>>,
        path: String,
        start_ms: i64,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        audio: bool,
        autoplay: bool,
    ) -> Result<(), String> {
        let app2 = app.clone();
        run_main(app, move || unsafe {
            let mut guard = inner.lock().map_err(|_| "lock VLC".to_string())?;
            if guard.is_none() {
                *guard = Some(init_vlc(&app2, audio)?);
            }
            let v = guard.as_mut().unwrap();

            set_window_rect(v.hwnd, x, y, w, h);
            let _ = ShowWindow(v.hwnd, SW_SHOW);
            bring_to_top(v.hwnd);

            let cpath = CString::new(path.clone()).map_err(|_| "path inválido".to_string())?;
            let media: Media = (v.media_new_path)(v.inst, cpath.as_ptr());
            if media.is_null() {
                return Err(format!("libVLC não abriu: {}", path));
            }
            (v.mp_set_media)(v.mp, media);
            (v.media_release)(media);

            // set_time só vale depois que o player começou a decodificar; por isso
            // o play sempre acontece. No MONITOR fica pausado logo em seguida (quem
            // manda tocar é o transporte); na PRÉVIA segue tocando (autoplay).
            (v.mp_play)(v.mp);
            if !autoplay {
                (v.mp_set_pause)(v.mp, 1);
            }
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
        run_main(app, move || unsafe {
            let guard = inner.lock().map_err(|_| "lock VLC".to_string())?;
            if let Some(v) = guard.as_ref() {
                set_window_rect(v.hwnd, x, y, w, h);
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
                let _ = ShowWindow(v.hwnd, if visible { SW_SHOW } else { SW_HIDE });
                if visible {
                    bring_to_top(v.hwnd);
                }
            }
            Ok(())
        })
    }

    pub fn stop(app: &tauri::AppHandle, inner: Arc<Mutex<Option<VlcInner>>>) -> Result<(), String> {
        run_main(app, move || unsafe {
            let guard = inner.lock().map_err(|_| "lock VLC".to_string())?;
            if let Some(v) = guard.as_ref() {
                (v.mp_stop)(v.mp);
                let _ = ShowWindow(v.hwnd, SW_HIDE);
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

    /// Duração total do arquivo aberto, em ms (-1 se ainda desconhecida ou sem
    /// player). Só a prévia usa — é o total da barra de progresso.
    pub fn duration(inner: &Arc<Mutex<Option<VlcInner>>>) -> i64 {
        let guard = match inner.lock() {
            Ok(g) => g,
            Err(_) => return -1,
        };
        match guard.as_ref() {
            Some(v) => unsafe { (v.mp_get_length)(v.mp) },
            None => -1,
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    /// PRECONDIÇÃO: main thread (cria a janela filha). `audio=false` cria a
    /// instância com `--no-audio` (monitor); `true` a deixa soar (prévia).
    unsafe fn init_vlc(app: &tauri::AppHandle, audio: bool) -> Result<VlcInner, String> {
        let dir = vlc_dir().ok_or_else(|| "VLC não encontrado".to_string())?;
        std::env::set_var("VLC_PLUGIN_PATH", dir.join("plugins"));

        // libvlc.dll depende de libvlccore.dll no MESMO diretório, mas a ordem
        // de busca padrão do Windows não inclui a pasta do DLL sendo carregado
        // (só a do .exe, a do sistema e o PATH) — o mesmo problema do rpath que
        // o RTLD_GLOBAL resolve no módulo macOS. A saída é análoga: carregar o
        // core primeiro pelo caminho absoluto. O loader do Windows resolve a
        // dependência de um DLL por NOME contra os módulos JÁ carregados no
        // processo antes de procurar em disco — com o core já carregado, o
        // libvlc.dll o encontra sem precisar de busca nenhuma.
        let core =
            Library::new(dir.join("libvlccore.dll")).map_err(|e| format!("libvlccore: {}", e))?;
        let lib = Library::new(dir.join("libvlc.dll")).map_err(|e| format!("libvlc: {}", e))?;

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
        let mp_set_hwnd: FnMpSetHwnd = sym!(FnMpSetHwnd, b"libvlc_media_player_set_hwnd\0");
        let mp_play: FnMpPlay = sym!(FnMpPlay, b"libvlc_media_player_play\0");
        let mp_set_pause: FnMpSetPause = sym!(FnMpSetPause, b"libvlc_media_player_set_pause\0");
        let mp_stop: FnMpStop = sym!(FnMpStop, b"libvlc_media_player_stop\0");
        let mp_set_time: FnMpSetTime = sym!(FnMpSetTime, b"libvlc_media_player_set_time\0");
        let mp_get_time: FnMpGetTime = sym!(FnMpGetTime, b"libvlc_media_player_get_time\0");
        let mp_get_length: FnMpGetLength =
            sym!(FnMpGetLength, b"libvlc_media_player_get_length\0");

        // MONITOR (`audio=false`): `--no-audio` torna o áudio da câmera IMPOSSÍVEL
        // de sair, não só desligado — quem toca é o som direto, no WebView (ver o
        // cabeçalho). PRÉVIA (`audio=true`): a instância soa, porque a prévia é
        // "olhar o arquivo" com som.
        let no_audio = CString::new("--no-audio").unwrap();
        let argv: [*const c_char; 1] = [no_audio.as_ptr()];
        let inst: Inst = if audio {
            f_new(0, std::ptr::null())
        } else {
            f_new(1, argv.as_ptr())
        };
        if inst.is_null() {
            return Err("libvlc_new falhou (plugins?)".into());
        }
        let mp: Player = mp_new(inst);
        if mp.is_null() {
            return Err("libvlc_media_player_new falhou".into());
        }

        let hwnd = create_child_window(app)?;
        mp_set_hwnd(mp, hwnd.0 as *mut c_void);

        Ok(VlcInner {
            _core: core,
            _lib: lib,
            inst,
            mp,
            hwnd,
            media_new_path,
            media_release,
            mp_set_media,
            mp_play,
            mp_set_pause,
            mp_stop,
            mp_set_time,
            mp_get_time,
            mp_get_length,
        })
    }

    /// HWND filha da janela principal, ACIMA do WebView (webviews do WebView2
    /// são janelas-filha próprias, mas a nossa é criada DEPOIS — a ordem de
    /// criação já a coloca no topo do Z-order entre as filhas). Criada oculta;
    /// `vlc_open`/`vlc_set_visible` decidem quando aparecer.
    unsafe fn create_child_window(app: &tauri::AppHandle) -> Result<HWND, String> {
        let win = app
            .get_webview_window("main")
            .ok_or_else(|| "janela 'main' não encontrada".to_string())?;
        let parent = win.hwnd().map_err(|e| e.to_string())?;

        let hinstance: HINSTANCE = GetModuleHandleW(None)
            .map(|h| HINSTANCE(h.0))
            .map_err(|e| e.to_string())?;

        let class_name = wide("OrbitaVlcHost");
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance,
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        // Falha (ex.: classe já registrada num hot-reload de dev) não é fatal —
        // `CreateWindowExW` funciona igual com a classe já existente.
        let _ = RegisterClassExW(&wc);

        // WS_CLIPSIBLINGS: quando a nossa janela estiver ACIMA do WebView2 no
        // Z-order, ela recorta a superfície dele na sua área — sem isso, mesmo no
        // topo o webview pode repintar por cima. Ver `bring_to_top`.
        let hwnd = CreateWindowExW(
            Default::default(),
            PCWSTR(class_name.as_ptr()),
            PCWSTR::null(),
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            16,
            9,
            Some(parent),
            None::<HMENU>,
            Some(hinstance),
            None,
        )
        .map_err(|e| e.to_string())?;

        Ok(hwnd)
    }

    /// Traz a janela do VLC ao TOPO do Z-order entre as filhas do main window —
    /// ACIMA do HWND do WebView2. O webview é criado ANTES da nossa janela, mas
    /// se reafirma no topo a cada relayout; sem trazer a nossa de volta, o VLC
    /// desenha ATRÁS dele e a tela fica preta mesmo com a janela visível e
    /// tocando. É o análogo Windows do `addSubview positioned:above` do macOS.
    unsafe fn bring_to_top(hwnd: HWND) {
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }

    unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// Retângulo em CSS px do frontend = px da janela filha: sem a inversão de
    /// eixo Y que o AppKit exige (coordenada do Win32 já é top-left).
    unsafe fn set_window_rect(hwnd: HWND, x: f64, y: f64, w: f64, h: f64) {
        // HWND_TOP (em vez de SWP_NOZORDER): cada reposicionamento vem de um
        // relayout — exatamente quando o WebView2 se reafirma no topo. Posicionar
        // e reafirmar o topo no mesmo movimento mantém o VLC visível.
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            x.round() as i32,
            y.round() as i32,
            w.round().max(1.0) as i32,
            h.round().max(1.0) as i32,
            SWP_NOACTIVATE,
        );
    }

    fn wide(s: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Executa na main thread e espera o resultado (a janela só aceita
    /// mensagens da thread que a criou).
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
