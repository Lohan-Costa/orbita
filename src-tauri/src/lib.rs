mod ffbins;
mod fs_expand;
mod pcm;
mod sidecar;
mod vlc;

use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use sidecar::SidecarManager;

type Sidecar = Arc<SidecarManager>;

/// Evento de progresso reemitido do sidecar para o frontend.
/// `data` é o objeto que o Python colocou em `respond_progress`.
#[derive(Clone, serde::Serialize)]
struct SidecarProgress {
    command: String,
    data: Value,
}

/// Ponte genérica frontend → Python sidecar.
/// O frontend chama: invoke('sidecar_call', { command, params })
///
/// `async` é OBRIGATÓRIO aqui, não cosmético: um `#[tauri::command]` síncrono
/// roda na MAIN THREAD, então um sync de ~10s congelaria o event loop do Tauri —
/// e os eventos de progresso emitidos abaixo só seriam entregues todos de uma
/// vez no final, o que derrota o propósito. O corpo continua bloqueante; o
/// `async` só o move para o runtime assíncrono.
#[tauri::command(async)]
fn sidecar_call(
    app: AppHandle,
    command: String,
    params: Value,
    state: State<Sidecar>,
) -> Result<Value, String> {
    state.call_with_progress(&command, params, &|data| {
        let _ = app.emit(
            "sidecar:progress",
            SidecarProgress {
                command: command.clone(),
                data,
            },
        );
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar = Arc::new(
        SidecarManager::detect(env!("CARGO_MANIFEST_DIR")).with_app_name("Orbita"),
    );

    if let Err(e) = sidecar.start() {
        eprintln!("[Orbita] Aviso: sidecar não iniciado: {}", e);
    }

    tauri::Builder::default()
        .manage(sidecar)
        .manage(vlc::VlcState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            sidecar_call,
            fs_expand::expand_dropped_paths,
            pcm::pcm_window,
            vlc::vlc_available,
            vlc::vlc_open,
            vlc::vlc_set_rect,
            vlc::vlc_set_visible,
            vlc::vlc_play,
            vlc::vlc_pause,
            vlc::vlc_stop,
            vlc::vlc_seek,
            vlc::vlc_time,
            vlc::vlc_preview_open,
            vlc::vlc_preview_close,
            vlc::vlc_preview_set_paused,
            vlc::vlc_preview_seek,
            vlc::vlc_preview_set_rect,
            vlc::vlc_preview_state,
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o app Tauri");
}
