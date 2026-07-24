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

/// Extensões que são SÓ áudio — o gravador de som direto, não uma câmera.
///
/// Aqui a classificação é pela EXTENSÃO porque o Rust não lê metadados; quem
/// decide de verdade é o `probe` (tem fps → câmera), e o usuário por cima dele.
/// Mas o palpite precisa existir ANTES: é ele que faz o diálogo dizer "SOM 1" em
/// vez de chamar o gravador de "CAM B".
const SOUND_EXTENSIONS: &[&str] = &["wav", "aac", "mp3", "aiff"];

#[derive(serde::Serialize)]
pub struct DroppedGroup {
    /// Identidade estável do grupo: caminho da pasta (drop de pasta) ou do
    /// próprio arquivo (drop solto).
    pub group_id: String,
    /// Nome da pasta, para exibição. `None` em drops de arquivo solto.
    pub group_name: Option<String>,
    /// Arquivos do grupo, em ordem natural.
    pub files: Vec<String>,
    /// Quando este grupo saiu de um SPLIT automático, o caminho da pasta que foi
    /// dividida. `None` = a pasta veio inteira, como sempre.
    ///
    /// É o que diz ao frontend "isto foi um PALPITE, pergunte ao usuário". A
    /// heurística nunca decide calada: ela propõe, e a confirmação é da pessoa.
    pub split_from: Option<String>,
    /// Palpite de classificação: `"camera"` ou `"sound"` (ver `SOUND_EXTENSIONS`).
    /// `None` quando não houve split. Quem decide de verdade continua sendo o
    /// `probe` (tem fps → câmera) e, acima dele, o usuário.
    pub kind: Option<String>,
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

/// O ESQUELETO de um nome de arquivo: runs de letras viram `A`, runs de dígitos
/// viram `#`, o resto (separadores) fica.
///
/// É o que distingue "dois CARTÕES da mesma câmera" de "duas CÂMERAS":
///
///   A008_03190217_C001.mp4  →  `A#_#_A#`   ┐ mesma câmera, cartões diferentes
///   A009_03190312_C002.mp4  →  `A#_#_A#`   ┘
///   DJI_0315.mp4            →  `A_#`       ← outra câmera
///
/// A numeração muda de cartão para cartão e de clipe para clipe; a FORMA do nome,
/// não — ela é do equipamento que gravou. Contar arquivos ou comparar prefixos
/// literais não resolveria: dois cartões da mesma câmera têm prefixos diferentes
/// (`A008` vs `A009`) e contagens diferentes.
fn filename_shape(stem: &str) -> String {
    let mut out = String::new();
    let mut chars = stem.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_alphabetic() {
            while chars.peek().is_some_and(|d| d.is_alphabetic()) {
                chars.next();
            }
            out.push('A');
        } else if c.is_ascii_digit() {
            while chars.peek().is_some_and(|d| d.is_ascii_digit()) {
                chars.next();
            }
            out.push('#');
        } else {
            out.push(c);
            chars.next();
        }
    }
    out
}

/// Uma FONTE proposta pela heurística — uma câmera ou um gravador de som.
pub struct SplitGroup {
    /// Nome da subpasta de origem (ou `None` para arquivos soltos na raiz).
    pub name: Option<String>,
    /// A subpasta que dá identidade ao grupo — `None` para os arquivos soltos.
    pub dir: Option<PathBuf>,
    /// `"camera"` ou `"sound"` — palpite por extensão (ver `SOUND_EXTENSIONS`).
    pub kind: &'static str,
    pub files: Vec<PathBuf>,
}

fn is_sound(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SOUND_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Câmera ou som, pelo que a MAIORIA dos arquivos é.
fn dominant_kind(files: &[PathBuf]) -> &'static str {
    let sounds = files.iter().filter(|f| is_sound(f)).count();
    if sounds * 2 > files.len() {
        "sound"
    } else {
        "camera"
    }
}

/// O ESQUELETO dominante de um conjunto de arquivos — o mais frequente.
///
/// Dominante, e não "todos iguais", porque uma pasta de câmera costuma ter um
/// intruso (um `.wav` de referência, um arquivo renomeado à mão) e um único
/// forasteiro não pode inventar uma câmera nova.
fn dominant_shape(files: &[PathBuf]) -> String {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for f in files {
        let stem = f.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let shape = filename_shape(stem);
        match counts.iter_mut().find(|(s, _)| *s == shape) {
            Some((_, n)) => *n += 1,
            None => counts.push((shape, 1)),
        }
    }
    counts
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(s, _)| s)
        .unwrap_or_default()
}

/// Decide se uma pasta arrastada contém MAIS DE UMA câmera — e, se sim, como
/// dividi-la.
///
/// A regra, em ordem:
///   1. Os candidatos são as SUBPASTAS DIRETAS que têm mídia (mais os arquivos
///      soltos na raiz, se houver).
///   2. Candidatos com o mesmo esqueleto de nome são a MESMA câmera e voltam a
///      se juntar — é assim que os cartões `A01/`, `A02/` continuam sendo uma
///      câmera só, que é a regra que este módulo existe para proteger.
///   3. Sobrando um grupo só, não há split.
///
/// Devolve vazio quando NÃO se deve dividir — o chamador segue com o
/// comportamento de sempre (a pasta inteira é uma câmera).
///
/// ⚠️ Esta função olha UM nível. Quem arrasta a pasta da diária inteira precisa da
/// versão RECURSIVA (`plan_split_deep`): `D04/` divide em `01_CAMERAS` e
/// `02_SOM-DIRETO`, e é só descendo em `01_CAMERAS` que a câmera e o drone
/// aparecem.
fn plan_split_level(base: &Path, files: &[PathBuf]) -> Vec<SplitGroup> {
    // Balde por subpasta direta. `None` = arquivo solto na raiz da pasta arrastada.
    let mut buckets: Vec<(Option<String>, Vec<PathBuf>)> = Vec::new();
    for f in files {
        let rel = f.strip_prefix(base).unwrap_or(f);
        let top = if rel.components().count() > 1 {
            rel.components()
                .next()
                .and_then(|c| c.as_os_str().to_str())
                .map(|s| s.to_string())
        } else {
            None
        };
        match buckets.iter_mut().find(|(k, _)| *k == top) {
            Some((_, v)) => v.push(f.clone()),
            None => buckets.push((top, vec![f.clone()])),
        }
    }

    if buckets.len() < 2 {
        return Vec::new();
    }

    // Junta os baldes que compartilham TIPO e esqueleto — cartões da mesma
    // câmera. O tipo entra na chave para que um gravador de som nunca seja
    // fundido com uma câmera, por mais parecidos que os nomes sejam.
    let mut merged: Vec<((&str, String), Option<String>, Vec<PathBuf>)> = Vec::new();
    for (name, group) in buckets {
        let key = (dominant_kind(&group), dominant_shape(&group));
        match merged.iter_mut().find(|(k, _, _)| *k == key) {
            Some((_, _, v)) => v.extend(group),
            None => merged.push((key, name, group)),
        }
    }

    if merged.len() < 2 {
        return Vec::new(); // era uma fonte só, em vários cartões
    }

    merged
        .into_iter()
        .map(|((kind, _), name, files)| SplitGroup {
            dir: name.as_ref().map(|n| base.join(n)),
            name,
            kind,
            files,
        })
        .collect()
}

/// Profundidade máxima da descida. Uma diária real tem 2–3 níveis
/// (`D04/01_CAMERAS/CAM_A/A08/`); o limite existe só para uma árvore patológica
/// não virar recursão infinita.
const MAX_SPLIT_DEPTH: usize = 4;

/// A heurística COMPLETA: divide, e desce em cada pedaço para dividir de novo.
///
/// Arrastar a pasta da diária inteira (`D04_230407/`) tem de achar as duas câmeras
/// E o som direto — e eles estão em níveis diferentes: `01_CAMERAS` e
/// `02_SOM-DIRETO` no primeiro, a câmera e o drone só no segundo. Parar no
/// primeiro nível fazia o drone entrar mudo junto da câmera principal.
///
/// A descida termina sozinha: cartões da mesma câmera compartilham o esqueleto e
/// se juntam de novo, então um nível de cartões nunca divide.
pub fn plan_split(base: &Path, files: &[PathBuf]) -> Vec<SplitGroup> {
    fn descend(base: &Path, files: &[PathBuf], depth: usize) -> Vec<SplitGroup> {
        let level = plan_split_level(base, files);
        if level.len() < 2 || depth >= MAX_SPLIT_DEPTH {
            return level;
        }
        level
            .into_iter()
            .flat_map(|g| {
                // Só há como descer em quem tem pasta própria; os arquivos soltos
                // na raiz já são uma folha.
                let Some(dir) = g.dir.clone() else { return vec![g] };
                let deeper = descend(&dir, &g.files, depth + 1);
                if deeper.len() < 2 { vec![g] } else { deeper }
            })
            .collect()
    }

    descend(base, files, 0)
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

            // Mais de uma câmera aqui dentro? A heurística PROPÕE a divisão; quem
            // confirma é o usuário, no frontend (ver `split_from`).
            let split = plan_split(path, &found);
            if split.len() >= 2 {
                for g in split {
                    groups.push(DroppedGroup {
                        // A identidade é a subpasta — estável entre execuções, e
                        // diferente da do irmão (dois grupos não podem colidir).
                        group_id: g
                            .dir
                            .as_ref()
                            .map(|d| d.to_string_lossy().into_owned())
                            .unwrap_or_else(|| raw.clone()),
                        group_name: g.name.clone().or_else(|| {
                            path.file_name()
                                .and_then(|n| n.to_str())
                                .map(|n| n.trim().to_string())
                        }),
                        files: g
                            .files
                            .iter()
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect(),
                        split_from: Some(raw.clone()),
                        kind: Some(g.kind.to_string()),
                    });
                }
                continue;
            }

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
                split_from: None,
                kind: None,
            });
        } else if is_media(path) {
            groups.push(DroppedGroup {
                group_id: raw.clone(),
                group_name: None,
                files: vec![raw],
                split_from: None,
                kind: None,
            });
        }
    }

    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── A heurística de split ────────────────────────────────────────────────
    //
    // Testada PURA (sem tocar em disco): o que se está guardando é a REGRA, e uma
    // regra que só pode ser exercida montando árvores de arquivos de verdade é uma
    // regra que ninguém vai testar nos casos de borda.

    fn p(paths: &[&str]) -> Vec<PathBuf> {
        paths.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn esqueleto_ignora_a_numeracao_e_guarda_a_forma() {
        // Dois cartões da MESMA câmera: a numeração muda, a forma não.
        assert_eq!(
            filename_shape("A008_03190217_C001"),
            filename_shape("A009_03190312_C002")
        );
        // Outro equipamento, outra forma.
        assert_ne!(filename_shape("A008_03190217_C001"), filename_shape("DJI_0315"));
        assert_eq!(filename_shape("DJI_0315"), "A_#");
        assert_eq!(filename_shape("A008_03190217_C001"), "A#_#_A#");
    }

    /// O caso real que motivou a feature: `01_CAMERAS/` com a câmera principal e
    /// um drone dentro. São DUAS câmeras, e o app criava uma track só.
    #[test]
    fn duas_cameras_na_mesma_pasta_sao_divididas() {
        let base = Path::new("/D04/01_CAMERAS");
        let files = p(&[
            "/D04/01_CAMERAS/CAM_A_Blackmagic-4k/A08/A008_03190217_C001.mp4",
            "/D04/01_CAMERAS/CAM_A_Blackmagic-4k/A08/A008_03190248_C002.mp4",
            "/D04/01_CAMERAS/CAM_A_Blackmagic-4k/A09/A009_03190312_C001.mp4",
            "/D04/01_CAMERAS/CAM_B_DRONE/B01/DCIM/100MEDIA/DJI_0315.mp4",
            "/D04/01_CAMERAS/CAM_B_DRONE/B01/DCIM/100MEDIA/DJI_0317.mp4",
        ]);

        let split = plan_split(base, &files);

        assert_eq!(split.len(), 2, "esperava a câmera e o drone separados");
        assert_eq!(split[0].name.as_deref(), Some("CAM_A_Blackmagic-4k"));
        assert_eq!(split[0].files.len(), 3, "os dois cartões da CAM A, juntos");
        assert_eq!(split[1].name.as_deref(), Some("CAM_B_DRONE"));
        assert_eq!(split[1].files.len(), 2);
    }

    /// ⚠️ A REGRA QUE ESTE MÓDULO EXISTE PARA PROTEGER: cartões NÃO são câmeras.
    /// Sem a junção por esqueleto, os 4 cartões de uma diária virariam 4 tracks.
    #[test]
    fn cartoes_da_mesma_camera_nao_sao_divididos() {
        let base = Path::new("/CAM_A");
        let files = p(&[
            "/CAM_A/A01/A001_03170214_C001.mp4",
            "/CAM_A/A02/A002_03170657_C001.mp4",
            "/CAM_A/A03/A003_03170837_C001.mp4",
            "/CAM_A/A04/A004_03170908_C001.mp4",
        ]);

        assert!(
            plan_split(base, &files).is_empty(),
            "os cartões de uma câmera só viraram câmeras separadas"
        );
    }

    #[test]
    fn uma_subpasta_so_nao_e_split() {
        let base = Path::new("/CAM_A");
        let files = p(&["/CAM_A/A01/x_001_C001.mp4", "/CAM_A/A01/x_002_C002.mp4"]);
        assert!(plan_split(base, &files).is_empty());
    }

    /// Um arquivo renomeado à mão no meio de um cartão não pode inventar uma
    /// câmera nova — por isso o esqueleto é o DOMINANTE, não o unânime.
    #[test]
    fn um_intruso_nao_inventa_uma_camera() {
        let base = Path::new("/CAM_A");
        let files = p(&[
            "/CAM_A/A01/A001_03170214_C001.mp4",
            "/CAM_A/A01/A001_03170215_C002.mp4",
            "/CAM_A/A01/renomeado.mp4",
            "/CAM_A/A02/A002_03170657_C001.mp4",
            "/CAM_A/A02/A002_03170658_C002.mp4",
        ]);
        assert!(plan_split(base, &files).is_empty());
    }

    /// Arquivos soltos na raiz convivendo com uma subpasta: são coisas diferentes
    /// e merecem a pergunta.
    #[test]
    fn arquivos_soltos_na_raiz_contam_como_candidato() {
        let base = Path::new("/DROP");
        let files = p(&[
            "/DROP/DJI_0315.mp4",
            "/DROP/DJI_0316.mp4",
            "/DROP/CAM_A/A008_03190217_C001.mp4",
            "/DROP/CAM_A/A008_03190248_C002.mp4",
        ]);

        let split = plan_split(base, &files);
        assert_eq!(split.len(), 2);
        // O balde da raiz não tem subpasta que lhe dê identidade.
        assert!(split.iter().any(|g| g.name.is_none()));
        assert!(split.iter().any(|g| g.name.as_deref() == Some("CAM_A")));
    }

    /// ⚠️ O caso que o primeiro corte errou: arrastar a DIÁRIA INTEIRA.
    ///
    /// `D04/` divide em `01_CAMERAS` e `02_SOM-DIRETO` no primeiro nível — e a
    /// câmera e o drone só aparecem DESCENDO em `01_CAMERAS`. Parando no primeiro
    /// nível, o drone entrava mudo junto da câmera principal e o usuário nem era
    /// avisado.
    #[test]
    fn arrastar_a_diaria_inteira_encontra_cameras_e_som() {
        let base = Path::new("/D04");
        let files = p(&[
            "/D04/01_CAMERAS/CAM_A_Blackmagic-4k/A08/A008_03190217_C001.mp4",
            "/D04/01_CAMERAS/CAM_A_Blackmagic-4k/A09/A009_03190312_C001.mp4",
            "/D04/01_CAMERAS/CAM_B_DRONE/B01/DCIM/100MEDIA/DJI_0315.mp4",
            "/D04/01_CAMERAS/CAM_B_DRONE/B01/DCIM/100MEDIA/DJI_0317.mp4",
            "/D04/02_SOM-DIRETO/SD04/AMB-T001.WAV",
            "/D04/02_SOM-DIRETO/SD04/AMB-T002.WAV",
        ]);

        let split = plan_split(base, &files);

        let names: Vec<_> = split.iter().map(|g| g.name.as_deref()).collect();
        assert_eq!(
            names,
            vec![
                Some("CAM_A_Blackmagic-4k"),
                Some("CAM_B_DRONE"),
                Some("02_SOM-DIRETO")
            ],
            "a descida tem de achar as DUAS câmeras e o som"
        );
    }

    /// O gravador de som direto não pode ser oferecido como "CAM B".
    #[test]
    fn o_som_direto_e_classificado_como_som() {
        let base = Path::new("/D04");
        let files = p(&[
            "/D04/01_CAMERAS/A008_03190217_C001.mp4",
            "/D04/01_CAMERAS/A008_03190248_C002.mp4",
            "/D04/02_SOM-DIRETO/AMB-T001.WAV",
            "/D04/02_SOM-DIRETO/AMB-T002.WAV",
        ]);

        let split = plan_split(base, &files);

        assert_eq!(split.len(), 2);
        assert_eq!(split[0].kind, "camera");
        assert_eq!(split[1].kind, "sound");
    }

    /// Dois GRAVADORES na mesma pasta são duas fontes — o número de sons diretos
    /// não é fixo, como o de câmeras não é.
    #[test]
    fn dois_gravadores_sao_duas_fontes_de_som() {
        let base = Path::new("/SOM");
        let files = p(&[
            "/SOM/ZOOM_H6/ZOOM0034_Tr1.WAV",
            "/SOM/ZOOM_H6/ZOOM0035_Tr1.WAV",
            "/SOM/SD_MIXPRE/AMB-T001.WAV",
            "/SOM/SD_MIXPRE/AMB-T002.WAV",
        ]);

        let split = plan_split(base, &files);

        assert_eq!(split.len(), 2, "dois gravadores distintos");
        assert!(split.iter().all(|g| g.kind == "sound"));
    }

    /// Um som e uma câmera com nomes de forma PARECIDA não podem se fundir — o
    /// tipo entra na chave de junção justamente para isso.
    #[test]
    fn som_e_camera_nunca_se_fundem_mesmo_com_nomes_iguais() {
        let base = Path::new("/X");
        let files = p(&[
            "/X/VIDEO/T001.mp4",
            "/X/VIDEO/T002.mp4",
            "/X/AUDIO/T001.WAV",
            "/X/AUDIO/T002.WAV",
        ]);

        let split = plan_split(base, &files);

        assert_eq!(split.len(), 2, "mesmo esqueleto, mas tipos diferentes");
        assert_eq!(split.iter().filter(|g| g.kind == "camera").count(), 1);
        assert_eq!(split.iter().filter(|g| g.kind == "sound").count(), 1);
    }

    /// A heurística contra a MÍDIA REAL que a motivou (a D04, com a câmera
    /// principal e um drone na mesma pasta). Os testes puros acima já guardam a
    /// regra; este confirma que a leitura de disco de verdade — cartões, `DCIM/`,
    /// arquivos `._` de volume externo — chega no mesmo resultado.
    ///
    /// Opt-in: a mídia tem dezenas de GB e vive fora do repo.
    #[test]
    fn duas_cameras_na_midia_real_da_d04() {
        let Ok(base) = std::env::var("ORBITA_TEST_MEDIA_D04") else {
            eprintln!("ORBITA_TEST_MEDIA_D04 não definida — pulando");
            return;
        };
        if !std::path::Path::new(&base).exists() {
            eprintln!("ORBITA_TEST_MEDIA_D04 aponta para caminho inexistente — pulando");
            return;
        }

        let groups = expand_dropped_paths(vec![format!("{base}/01_CAMERAS")])
            .expect("expansão falhou");

        assert_eq!(groups.len(), 2, "esperava a câmera e o drone separados");
        // Todo grupo saído de um split carrega de ONDE saiu — é o que faz o
        // frontend perguntar em vez de aceitar o palpite calado.
        assert!(groups.iter().all(|g| g.split_from.is_some()));

        let cam = groups
            .iter()
            .find(|g| g.group_name.as_deref() == Some("CAM_A_Blackmagic-4k"))
            .expect("CAM A não encontrada");
        let drone = groups
            .iter()
            .find(|g| g.group_name.as_deref() == Some("CAM_B_DRONE"))
            .expect("drone não encontrado");

        assert_eq!(cam.files.len(), 26, "os cartões da CAM A vêm juntos");
        assert_eq!(drone.files.len(), 8);
        assert!(groups.iter().all(|g| g.files.iter().all(|f| !f.contains("/._"))));
    }

    /// A DIÁRIA INTEIRA arrastada, contra a mídia real — o caso do print do
    /// usuário, em que o som direto era oferecido como "CAM B" e o drone sumia.
    #[test]
    fn diaria_inteira_na_midia_real_da_d04() {
        let Ok(base) = std::env::var("ORBITA_TEST_MEDIA_D04") else {
            eprintln!("ORBITA_TEST_MEDIA_D04 não definida — pulando");
            return;
        };
        if !std::path::Path::new(&base).exists() {
            eprintln!("ORBITA_TEST_MEDIA_D04 aponta para caminho inexistente — pulando");
            return;
        }

        let groups = expand_dropped_paths(vec![base.clone()]).expect("expansão falhou");

        assert_eq!(groups.len(), 3, "duas câmeras e um gravador");
        let kinds: Vec<_> = groups.iter().map(|g| g.kind.as_deref()).collect();
        assert_eq!(
            kinds,
            vec![Some("camera"), Some("camera"), Some("sound")],
            "o gravador não pode ser classificado como câmera"
        );
        assert_eq!(
            groups.iter().map(|g| g.files.len()).collect::<Vec<_>>(),
            vec![26, 8, 20]
        );
    }

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
