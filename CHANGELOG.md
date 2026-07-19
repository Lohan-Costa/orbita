# Changelog

Todas as mudanças notáveis do Órbita, por versão. Formato livre — o objetivo é
dizer o que mudou pra quem usa, não narrar o processo de desenvolvimento (isso
fica no histórico de commits).

## v0.1.2 — 2026-07-19

### Corrigido

- **Windows: "Sincronizar" derrubava o sidecar** ("Sidecar encerrou sem resposta
  ao comando 'sync'"), sob rajada de eventos de progresso durante o sync. Escrita
  no stdout do sidecar agora tenta de novo antes de desistir.
- **Windows: janela de terminal preta e vazia** aparecia atrás do app ao abrir.

## v0.1.1 — 2026-07-19

### Corrigido

- **Windows: app não conseguia ler nenhuma mídia adicionada** (todo clipe
  aparecia como "Erro ao ler", com erro de pipe fechado). O sidecar Python
  embutido no instalador não era localizado corretamente no Windows.

## v0.1.0 — 2026-07-19

Primeira versão pública, em fase Alpha.

- Sincronização automática de diárias multicâmera por timecode, forma de onda,
  ou híbrido.
- Linha do tempo visual para conferir o sync antes de exportar.
- Correção manual de clipes marcados como duvidosos.
- Exportação para Adobe Premiere Pro (`.prproj`).
- macOS e Windows.
