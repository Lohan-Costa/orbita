//! Orbita — extração de uma JANELA de PCM de um arquivo de mídia.
//!
//! É o que alimenta o transporte: em vez de mandar cada track para um `<audio>`
//! (que começa a soar quando o buffer DELE fica pronto, com a latência DELE — e a
//! diferença entre essas latências vira um atraso permanente entre as tracks), o
//! frontend pede aqui o trecho que vai tocar, monta um buffer por track e dispara
//! todos no MESMO relógio da Web Audio. Sample-accurate por construção.
//!
//! `-ss` ANTES do `-i` é busca rápida — e, no ffmpeg moderno, EXATA À AMOSTRA
//! (medido contra o arquivo inteiro, com este material: deslocamento zero,
//! correlação 1,0000, tanto no AAC dentro de mp4 quanto no WAV). Isso é
//! load-bearing: se a janela não começasse na amostra pedida, cada track ganharia
//! o seu próprio erro de partida e o bug do atraso voltaria por outra porta.
//!
//! O formato de saída é fixo — f32 intercalado, estéreo, 48 kHz — porque o
//! frontend precisa saber a forma do buffer sem negociar nada. O som direto tem 5
//! canais; o downmix para estéreo é o que o `<audio>` do WebView já fazia.

use std::path::PathBuf;
use std::process::Command;

/// Taxa de amostragem de TODA janela. O `AudioContext` é criado nesta taxa.
pub const RATE: u32 = 48_000;
/// Canais de TODA janela. Multicanal (o som direto) é misturado para estéreo.
pub const CHANNELS: u32 = 2;

/// Extrai `dur_sec` segundos de áudio a partir de `start_sec`, como f32
/// intercalado (L,R,L,R…) a 48 kHz.
///
/// Devolve os bytes CRUS: uma janela de 15 s tem ~5,7 MB, e passá-los como JSON
/// (array de números, ou base64) custaria mais que a extração inteira.
/// `tauri::ipc::Response` os entrega como `ArrayBuffer` do outro lado.
///
/// Fora do fim do arquivo o ffmpeg simplesmente devolve menos amostras (ou
/// nenhuma) — quem chama trata isso como silêncio, que é o que é.
#[tauri::command(async)]
pub fn pcm_window(
    path: String,
    start_sec: f64,
    dur_sec: f64,
) -> Result<tauri::ipc::Response, String> {
    let file = PathBuf::from(&path);
    if !file.is_file() {
        return Err(format!("arquivo não encontrado: {}", path));
    }
    if !(dur_sec.is_finite() && dur_sec > 0.0) || !start_sec.is_finite() {
        return Err(format!("janela inválida: start={start_sec} dur={dur_sec}"));
    }

    let mut cmd = Command::new(crate::ffbins::ffmpeg());
    cmd.arg("-v")
        .arg("error")
        .arg("-ss")
        .arg(format!("{:.6}", start_sec.max(0.0)))
        .arg("-t")
        .arg(format!("{:.6}", dur_sec))
        .arg("-i")
        .arg(&file)
        .arg("-vn")
        .arg("-ac")
        .arg(CHANNELS.to_string())
        .arg("-ar")
        .arg(RATE.to_string())
        .arg("-f")
        .arg("f32le")
        .arg("pipe:1");

    // Sem isto, cada extração pisca um console no Windows — e há uma por janela.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("ffmpeg não pôde ser executado ({e}) — binário embarcado ausente e fora do PATH?"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err.chars().rev().take(400).collect::<Vec<_>>()
            .into_iter().rev().collect();
        return Err(format!("ffmpeg falhou em '{}': {}", path, tail.trim()));
    }

    Ok(tauri::ipc::Response::new(out.stdout))
}
