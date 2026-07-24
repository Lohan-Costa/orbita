//! Orbita — resolve os binários embarcados do ffmpeg / ffprobe.
//!
//! Em RELEASE o Tauri põe `ffmpeg`/`ffprobe` (externalBin) AO LADO do executável.
//! Aqui a gente acha por ali; em DEV (o exe é `target/debug/orbita`, sem ffmpeg ao
//! lado) cai-se no nome cru, que o PATH resolve (brew/winget). É o que faz o app
//! rodar numa máquina SEM ffmpeg instalado — a causa do `[Errno 2] ... 'ffmpeg'`
//! que derrubava o sync.
//!
//! Dois consumidores: o `pcm.rs` (playback do transporte) chama estas funções
//! direto; o sidecar Python recebe os caminhos por env (`ORBITA_FFMPEG` /
//! `ORBITA_FFPROBE`), setadas em `sidecar.rs` a partir daqui.

use std::path::PathBuf;

fn next_to_exe(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .ok()?;
    let p = exe.parent()?.join(name);
    p.exists().then_some(p)
}

/// Caminho do ffmpeg: o embarcado ao lado do executável, ou o nome cru (PATH).
pub fn ffmpeg() -> PathBuf {
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    next_to_exe(name).unwrap_or_else(|| PathBuf::from(name))
}

/// Caminho do ffprobe: o embarcado ao lado do executável, ou o nome cru (PATH).
pub fn ffprobe() -> PathBuf {
    let name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
    next_to_exe(name).unwrap_or_else(|| PathBuf::from(name))
}
