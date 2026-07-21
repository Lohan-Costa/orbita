//! Orbita — Sidecar Manager
//! Adaptado do RELINKER/src-tauri/src/sidecar.rs
//!
//! Gerencia o processo Python sidecar via protocolo JSON por stdin/stdout.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

static CMD_COUNTER: AtomicU64 = AtomicU64::new(1);
const SIDECAR_TIMEOUT: Duration = Duration::from_secs(300);

struct SidecarState {
    child:   Child,
    stdin:   ChildStdin,
    rx:      mpsc::Receiver<String>,
    _reader: std::thread::JoinHandle<()>,
}

pub struct SidecarManager {
    state:    Mutex<Option<SidecarState>>,
    prog:     String,
    args:     Vec<String>,
    app_name: Option<String>,
}

impl SidecarManager {
    pub fn new(prog: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            state: Mutex::new(None),
            prog:  prog.into(),
            args,
            app_name: None,
        }
    }

    pub fn with_app_name(mut self, name: impl Into<String>) -> Self {
        self.app_name = Some(name.into());
        self
    }

    /// Detecta o caminho do sidecar Python.
    ///
    /// Ordem: 1) binário no bundle  2) venv em dev  3) python3 do PATH
    /// Onde está o sidecar.
    ///
    /// ⚠️ A ORDEM depende do perfil de build, e isso é LOAD-BEARING.
    ///
    /// Em RELEASE o binário empacotado vem primeiro: é o único que existe no app
    /// instalado, e é o que o `externalBin` do Tauri põe ao lado do executável.
    ///
    /// Em DEV o VENV vem primeiro — e a razão é uma armadilha que já custou caro:
    /// no `tauri dev` o executável é `target/debug/orbita`, e `target/debug/`
    /// costuma ter um `orbita-python` sobrando de algum `build_sidecar.py`
    /// anterior. Com o bundle em primeiro lugar, esse binário VELHO ganhava do
    /// `main.py` vivo, e TODA mudança no Python era silenciosamente ignorada em
    /// dev — o app rodava código de semanas atrás sem nenhum aviso. O sintoma é
    /// enganoso: comandos ANTIGOS continuam funcionando (estão no binário velho)
    /// e só os NOVOS falham, o que parece bug do código novo.
    pub fn detect(manifest_dir: &str) -> Self {
        let base = std::path::Path::new(manifest_dir);

        // O venv de desenvolvimento: src-python/.venv/bin/python + src-python/main.py
        let src_python = base.parent().unwrap_or(base).join("src-python");
        #[cfg(target_os = "windows")]
        let venv_python = src_python.join(".venv").join("Scripts").join("python.exe");
        #[cfg(not(target_os = "windows"))]
        let venv_python = src_python.join(".venv").join("bin").join("python");
        let main_py = src_python.join("main.py");

        let venv = || {
            if venv_python.exists() && main_py.exists() {
                Some(Self::new(
                    venv_python.to_string_lossy().to_string(),
                    vec![main_py.to_string_lossy().to_string()],
                ))
            } else {
                None
            }
        };

        let bundled = || {
            let exe = std::env::current_exe().and_then(std::fs::canonicalize).ok()?;
            let dir = exe.parent()?;
            let bin_name = if cfg!(target_os = "windows") {
                "orbita-python.exe"
            } else {
                "orbita-python"
            };
            let bin = dir.join(bin_name);
            bin.exists()
                .then(|| Self::new(bin.to_string_lossy().to_string(), vec![]))
        };

        let found = if cfg!(debug_assertions) {
            venv().or_else(bundled)
        } else {
            bundled().or_else(venv)
        };

        // Fallback: python3 do PATH. No Windows sem Python real instalado isto
        // costuma ser o stub da Microsoft Store, que abre a loja e morre — daí o
        // cuidado acima para nunca chegar aqui à toa.
        found.unwrap_or_else(|| {
            Self::new(
                "python3".to_string(),
                vec![src_python.join("main.py").to_string_lossy().to_string()],
            )
        })
    }

    pub fn start(&self) -> Result<(), String> {
        let mut cmd = Command::new(&self.prog);
        for arg in &self.args {
            cmd.arg(arg);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // O sidecar é um binário PyInstaller "console" (não --windowed) — sem isto,
        // o Windows abre uma janela de terminal preta e vazia atrás do app, porque
        // todo processo console ganha uma por padrão a menos que o pai peça pra não.
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        if let Some(name) = &self.app_name {
            cmd.env("ORBITA_APP_NAME", name);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Falha ao iniciar sidecar '{}': {}", self.prog, e))?;

        let stdin = child.stdin.take().ok_or("Falha ao capturar stdin")?;
        let stdout_raw = child.stdout.take().ok_or("Falha ao capturar stdout")?;

        let (tx, rx) = mpsc::channel::<String>();
        let reader_thread = std::thread::spawn(move || {
            let reader = BufReader::new(stdout_raw);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let mut guard = self.state.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Ok(());
        }
        *guard = Some(SidecarState { child, stdin, rx, _reader: reader_thread });
        Ok(())
    }

    pub fn call_with_progress(
        &self,
        command: &str,
        params: Value,
        on_progress: &dyn Fn(Value),
    ) -> Result<Value, String> {
        let mut guard = self.state.lock().map_err(|e| e.to_string())?;
        let state = guard.as_mut().ok_or("Sidecar não está rodando")?;

        let id  = CMD_COUNTER.fetch_add(1, Ordering::SeqCst).to_string();
        let msg = json!({ "id": id, "command": command, "params": params });

        let mut line = serde_json::to_string(&msg)
            .map_err(|e| format!("Falha ao serializar: {}", e))?;
        line.push('\n');

        state
            .stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("Falha ao escrever no stdin: {}", e))?;
        state
            .stdin
            .flush()
            .map_err(|e| format!("Falha ao flush stdin: {}", e))?;

        loop {
            let response_line = match state.rx.recv_timeout(SIDECAR_TIMEOUT) {
                Ok(l) => l,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "Sidecar não respondeu ao comando '{}' em {}s.",
                        command,
                        SIDECAR_TIMEOUT.as_secs()
                    ));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(format!(
                        "Sidecar encerrou sem resposta ao comando '{}'. Verifique os logs.",
                        command
                    ));
                }
            };

            let response: Value = serde_json::from_str(response_line.trim()).map_err(|e| {
                format!(
                    "Resposta inválida do sidecar: {} | {}",
                    e,
                    &response_line[..response_line.len().min(200)]
                )
            })?;

            if response.get("event").and_then(|v| v.as_str()) == Some("progress") {
                on_progress(response.get("data").cloned().unwrap_or(Value::Null));
                continue;
            }

            return match response.get("ok").and_then(|v| v.as_bool()) {
                Some(true) => Ok(response["data"].clone()),
                Some(false) => {
                    let err    = response["error"].as_str().unwrap_or("Erro desconhecido");
                    let detail = response["detail"].as_str().unwrap_or("");
                    if detail.is_empty() {
                        Err(err.to_string())
                    } else {
                        Err(format!("{}: {}", err, detail))
                    }
                }
                None => Err(format!(
                    "Resposta sem campo 'ok': {}",
                    response_line.trim()
                )),
            };
        }
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.state.lock() {
            if let Some(mut state) = guard.take() {
                let _ = state.child.kill();
                let _ = state.child.wait();
            }
        }
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop();
    }
}
