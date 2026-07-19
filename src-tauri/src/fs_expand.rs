//! Expansão de caminhos arrastados para o app, agrupados por câmera física.
//!
//! **Uma PASTA arrastada = uma câmera física**, e a varredura é RECURSIVA: todos
//! os arquivos de mídia debaixo dela, em qualquer profundidade, são clipes dessa
//! mesma câmera.
//!
//! A recursão não é conveniência — é o modelo. Uma câmera de cinema despeja o
//! material em CARTÕES (`CAM_A/A01/`, `CAM_A/A02/`, …), e cada cartão é só um
//! pedaço do dia daquela câmera, não outra câmera. Lendo um nível só, o app
//! transformava os 4 cartões de uma diária em 4 câmeras — 4 tracks de vídeo onde
//! deveria haver uma.
//!
//! Um ARQUIVO solto arrastado = grupo unitário (comportamento preservado).
//!
//! Só usa `std::fs`/`std::path` — nada específico de SO (o app roda em Windows e
//! macOS, ver CLAUDE.md).

use std::fs;
use std::path::{Path, PathBuf};

/// Extensões consideradas mídia. Espelha o filtro do diálogo de arquivos no
/// frontend (`ClipList.tsx`) — manter os dois em sincronia.
const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mxf", "mov", "avi", "mkv", "r3d", "braw", "wav", "aac", "mp3", "aiff",
];

#[derive(serde::Serialize)]
pub struct DroppedGroup {
    /// Identidade estável do grupo: caminho da pasta (drop de pasta) ou do
    /// próprio arquivo (drop solto).
    pub group_id: String,
    /// Nome da pasta, para exibição. `None` em drops de arquivo solto.
    pub group_name: Option<String>,
    /// Arquivos do grupo, em ordem natural.
    pub files: Vec<String>,
}

fn is_media(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MEDIA_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Chave de ordenação natural: runs de dígitos comparam como números.
/// Sem isso, "CAM10" viria antes de "CAM2" (ordem textual).
fn natural_key(name: &str) -> Vec<NaturalPart> {
    let mut parts = Vec::new();
    let mut chars = name.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            let mut num = String::new();
            while let Some(&d) = chars.peek() {
                if d.is_ascii_digit() {
                    num.push(d);
                    chars.next();
                } else {
                    break;
                }
            }
            // Números longos demais para u64 caem em texto (ordem estável mesmo assim).
            match num.parse::<u64>() {
                Ok(n) => parts.push(NaturalPart::Num(n)),
                Err(_) => parts.push(NaturalPart::Text(num)),
            }
        } else {
            let mut text = String::new();
            while let Some(&d) = chars.peek() {
                if d.is_ascii_digit() {
                    break;
                }
                text.push(d.to_ascii_lowercase());
                chars.next();
            }
            parts.push(NaturalPart::Text(text));
        }
    }
    parts
}

#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum NaturalPart {
    // Ordem do derive: Num < Text quando os tipos diferem — consistente e estável.
    Num(u64),
    Text(String),
}

/// Todos os arquivos de mídia debaixo de `dir`, em qualquer profundidade.
///
/// Ignora os `._arquivo` de resource fork do macOS, que aparecem em volumes
/// externos e não são mídia real (num volume assim, os 13 clipes de um cartão
/// viram 26 entradas se ninguém filtrar).
fn collect_media(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("não foi possível listar '{}': {}", dir.display(), e))?;

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with("._") || name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_media(&path, out)?;
        } else if is_media(&path) {
            out.push(path);
        }
    }
    Ok(())
}

/// Expande os caminhos arrastados em grupos de câmera.
#[tauri::command]
pub fn expand_dropped_paths(paths: Vec<String>) -> Result<Vec<DroppedGroup>, String> {
    let mut groups = Vec::new();

    for raw in paths {
        let path = Path::new(&raw);
        let meta = fs::metadata(path)
            .map_err(|e| format!("não foi possível ler '{}': {}", raw, e))?;

        if meta.is_dir() {
            let mut found: Vec<PathBuf> = Vec::new();
            collect_media(path, &mut found)?;

            if found.is_empty() {
                continue;
            }

            // Ordem de gravação. Os cartões vêm ANTES do nome do arquivo na chave
            // (`A01/…C001` < `A02/…C001`): dentro de um cartão a numeração
            // reinicia, então ordenar só pelo nome do arquivo embaralharia os
            // cartões entre si.
            found.sort_by_key(|p| {
                let rel = p.strip_prefix(path).unwrap_or(p);
                rel.components()
                    .filter_map(|c| c.as_os_str().to_str())
                    .flat_map(natural_key)
                    .collect::<Vec<_>>()
            });

            groups.push(DroppedGroup {
                group_id: raw.clone(),
                group_name: path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.trim().to_string()),
                files: found
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
            });
        } else if is_media(path) {
            groups.push(DroppedGroup {
                group_id: raw.clone(),
                group_name: None,
                files: vec![raw],
            });
        }
    }

    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_flat_camera_folders() {
        // Mídia de exemplo do repo (gitignorada — 18 GB, só na máquina de dev).
        // Caminho relativo ao crate, não à pasta pessoal de quem roda: `tauri
        // dev`/`cargo test` sempre define `CARGO_MANIFEST_DIR` como `src-tauri/`.
        let base = format!(
            "{}/../midias-projetos-exemplo/MIDIA MULTCAM",
            env!("CARGO_MANIFEST_DIR")
        );
        if !std::path::Path::new(&base).exists() {
            eprintln!("mídia de exemplo ausente ({base}) — pulando");
            return;
        }
        let groups = expand_dropped_paths(vec![
            format!("{base}/CAM A "),
            format!("{base}/CAM B"),
            format!("{base}/SOM DIRETO/20240531_ZOOM0034_Tr12.WAV"),
        ])
        .expect("expansão falhou");

        assert_eq!(groups.len(), 3, "esperava 3 grupos (2 pastas + 1 arquivo)");

        assert_eq!(groups[0].group_name.as_deref(), Some("CAM A"));
        assert_eq!(groups[0].files.len(), 2);

        assert_eq!(groups[1].group_name.as_deref(), Some("CAM B"));
        assert_eq!(groups[1].files.len(), 11);
        // ordem natural: 2774 antes de 2784, e "._" do macOS fora
        assert!(groups[1].files[0].ends_with("PANA2774.mov"));
        assert!(groups[1].files.iter().all(|f| !f.contains("/._")));

        // arquivo solto = grupo unitário sem nome
        assert_eq!(groups[2].group_name, None);
        assert_eq!(groups[2].files.len(), 1);
    }

    /// O caso que motivou a recursão: uma câmera de cinema despeja o dia em
    /// CARTÕES (A01…A04). Os quatro são a MESMA câmera — arrastar a pasta dela
    /// tem que dar UM grupo com todos os clipes, e não quatro câmeras.
    #[test]
    fn a_camera_folder_with_cards_is_one_camera() {
        // Mídia real de uma diária, fora do repo — não há como sintetizar 4
        // cartões de câmera de cinema. Sem a variável (o caso comum, inclusive em
        // CI), pula: não é possível provar isto contra mídia sintética.
        let Ok(base) = std::env::var("ORBITA_TEST_MEDIA_ROOT") else {
            eprintln!("ORBITA_TEST_MEDIA_ROOT não definida — pulando");
            return;
        };
        if !std::path::Path::new(&base).exists() {
            eprintln!("ORBITA_TEST_MEDIA_ROOT aponta para um caminho inexistente — pulando");
            return;
        }
        let groups = expand_dropped_paths(vec![
            format!("{base}/01_CAMERAS/CAM_A_Blackmagic-4k"),
            format!("{base}/02_SOM-DIRETO/SD02"),
        ])
        .expect("expansão falhou");

        assert_eq!(groups.len(), 2, "uma câmera e um gravador");

        let cam = &groups[0];
        assert_eq!(cam.group_name.as_deref(), Some("CAM_A_Blackmagic-4k"));
        assert_eq!(cam.files.len(), 26, "os 4 cartões somam 26 clipes");
        assert!(cam.files.iter().all(|f| !f.contains("/._")));

        // Ordem de gravação: os cartões em sequência, e dentro de cada um a
        // numeração dos arquivos. Sem isso, o C001 do A02 viria antes do C013 do
        // A01 (a numeração reinicia a cada cartão).
        assert!(cam.files[0].ends_with("A01/A001_03170214_C001.mp4"));
        assert!(cam.files[12].ends_with("A01/A001_03170454_C013.mp4"));
        assert!(cam.files[13].ends_with("A02/A002_03170657_C001.mp4"));
        assert!(cam.files[25].ends_with("A04/A004_03170917_C003.mp4"));

        assert_eq!(groups[1].files.len(), 24, "os 24 sons diretos");
    }
}
