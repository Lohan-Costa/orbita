# 0001 — Stack: Tauri v2 (shell) + sidecar Python (domínio) + React 19 (UI)

**Status:** ativa

**Contexto:** o app precisa rodar em macOS e Windows, processar mídia
(vídeo/áudio) de forma pesada, e gerar formatos binários/XML complexos
(`.prproj`, futuramente `.aaf`). A interface é uma ferramenta de trabalho, não
um produto de design.

**Decisão:** três camadas, cada uma no que faz melhor.
- **Rust/Tauri v2** (`src-tauri/`) — só o shell nativo: janela, diálogos de
  arquivo, embutir o VLC como fallback de vídeo, e a ponte de IPC
  (`sidecar_call`) com o processo Python. Não tem lógica de domínio.
- **Sidecar Python** (`src-python/`) — toda a lógica pesada: timecode,
  correlação de forma de onda, agrupamento multicâmera, geração do `.prproj`.
  Conversa com o Rust via JSON linha a linha em stdin/stdout.
- **React 19 + TypeScript + Vite** (`src/`) — UI.

**Alternativas consideradas:** Electron (bundle maior, sem ganho de Rust para
o shell); lógica de domínio em Rust (descartada — o ecossistema Python de
processamento de mídia/áudio, scipy incluso, já resolvia o problema, e reescrever
em Rust não pagava o custo); app web (sem acesso nativo ao sistema de arquivos).

**Consequência:** um sync de ~10s roda no processo Python sem travar a janela
— o comando Rust é `async` de propósito, para não bloquear a main thread e
ainda entregar eventos de progresso ao vivo.
