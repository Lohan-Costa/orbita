# Architecture Decision Records

Registros curtos das decisões não-óbvias do Órbita — o suficiente para quem for
ler ou modificar o código entender o "por quê", sem a narrativa completa de
tentativa-e-erro do desenvolvimento (essa fica nas notas privadas do
mantenedor).

Cada arquivo é curto de propósito: contexto, decisão, consequência. Se uma
decisão mudar, adicione um novo ADR referenciando o antigo — não edite o
histórico.

- [0001 — Stack: Tauri v2 + Rust + React 19](0001-stack.md)
- [0002 — Fronteira core/ (agnóstico de NLE) vs. adapters/](0002-core-adapters-boundary.md)
- [0003 — Sync engine: timecode + correlação de forma de onda em duas etapas](0003-sync-engine-hybrid-two-stage.md)
- [0004 — Opções de export são flags independentes, nunca variantes nomeadas](0004-export-options-flags.md)
- [0005 — Alpha entrega sequência normal sincronizada, multicam desligado](0005-alpha-scope-multicam-disabled.md)
- [0006 — O cache em disco é LRU por último uso, não por escrita](0006-cache-lru-por-ultimo-uso.md)
- [0007 — Detectar múltiplas fontes numa pasta pelo esqueleto do nome](0007-deteccao-de-fontes-por-esqueleto-de-nome.md)
- [0008 — O sidecar vem do venv em debug e do bundle em release](0008-sidecar-venv-em-debug-bundle-em-release.md)
