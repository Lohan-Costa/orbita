//! Orbita — extração de UM quadro exato de uma mídia, para o still do monitor.
//!
//! POR QUE NO RUST (e não no sidecar Python, onde vive o `proxy.window`): o sidecar
//! é SERIAL — um comando por vez. O still de scrub é frequente e curto; se ficasse
//! no sidecar, enfileiraria ATRÁS do transcode do proxy (segundos), congelando o
//! scrub justo enquanto cacheia. Aqui, como o `pcm.rs`, roda direto e devolve os
//! bytes por `ipc::Response` (ArrayBuffer), fora daquele mutex.
//!
//! `-ss` ANTES do `-i` = busca rápida e exata ao frame — o pedido é "o quadro EM
//! `sec`", que é o momento do sync-check (a claquete no ponto do pico do som). O
//! teto é Full HD respeitando o aspect ratio, ESPELHANDO `media/proxy.py`
//! (full/half/quarter). Saída MJPEG (um JPEG) — pequeno; o `<img>`/canvas pinta.

use std::path::PathBuf;
use std::process::Command;

/// Teto (largura, altura) por nível. Espelha `RES_CAPS` em `media/proxy.py` —
/// se um mudar, mudar o outro.
fn cap(resolution: &str) -> (u32, u32) {
    match resolution {
        "full" => (1920, 1080),
        "quarter" => (480, 270),
        _ => (960, 540), // "half" — o default
    }
}

/// Filtro `-vf`: cabe no teto sem esticar, preserva o aspect ratio, dimensões
/// pares. A vírgula dentro de `min()` é escapada (`\,`) porque no filtergraph a
/// vírgula separa filtros.
fn scale_filter(resolution: &str) -> String {
    let (w, h) = cap(resolution);
    format!(
        "scale=w='min({w}\\,iw)':h='min({h}\\,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
    )
}

/// Um quadro exato de `path` em `sec`, como bytes de um JPEG.
#[tauri::command(async)]
pub fn monitor_frame(
    path: String,
    sec: f64,
    resolution: String,
) -> Result<tauri::ipc::Response, String> {
    let file = PathBuf::from(&path);
    if !file.is_file() {
        return Err(format!("arquivo não encontrado: {}", path));
    }
    if !sec.is_finite() {
        return Err(format!("tempo inválido: {sec}"));
    }

    let mut cmd = Command::new(crate::ffbins::ffmpeg());
    cmd.arg("-v")
        .arg("error")
        .arg("-ss")
        .arg(format!("{:.6}", sec.max(0.0)))
        .arg("-i")
        .arg(&file)
        .arg("-frames:v")
        .arg("1")
        .arg("-vf")
        .arg(scale_filter(&resolution))
        .arg("-c:v")
        .arg("mjpeg")
        .arg("-f")
        .arg("image2pipe")
        .arg("pipe:1");

    // Sem isto, cada extração pisca um console no Windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("ffmpeg não pôde ser executado ({e})"))?;

    if !out.status.success() || out.stdout.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err
            .chars()
            .rev()
            .take(400)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(format!(
            "ffmpeg falhou ao extrair frame de '{}': {}",
            path,
            tail.trim()
        ));
    }

    Ok(tauri::ipc::Response::new(out.stdout))
}
