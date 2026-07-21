# 0003 — Motor de sync: timecode + correlação de forma de onda, em duas etapas

**Status:** ativa

**Contexto:** sincronizar câmera e som direto por timecode sozinho falha
sempre que os relógios dos aparelhos não estão amarrados (comum em produção
real — um gravador rejamado no meio do dia, uma câmera com o relógio
dessincronizado). Por forma de onda sozinho é preciso, mas caro: ler o áudio
inteiro de cada arquivo para correlacionar tudo contra tudo não escala para
uma diária de dezenas de clipes.

**Decisão:**
- **Correlação em duas etapas:** um envelope de onset em taxa baixa faz a
  busca global (rápida, aproximada); uma janela curta de PCM em taxa mais
  alta, centrada na estimativa da primeira etapa, refina o resultado à
  amostra. As taxas exatas de cada etapa vivem em `sync/waveform.py`
  (`_COARSE_RATE_*`, `_FINE_RATE`) — não duplicar os números aqui, eles já
  mudaram desde a primeira versão deste motor.
- **Híbrido por padrão:** o timecode propõe o pareamento e a posição; a forma
  de onda confirma. Quando os relógios concordam entre várias âncoras
  próximas, a posição do timecode é aceita sem forma de onda (ver
  `sync/tcmatch.py`). Quando não há acordo suficiente, o clipe fica
  sinalizado para revisão manual no NLE — nunca posicionado às cegas.

**Alternativas consideradas:** correlação simples de amplitude (falsos picos
por bias de DC do envelope); só timecode (falha com relógios soltos); só
forma de onda no arquivo inteiro (caro demais numa diária real).

**Consequência:** o app nunca promete 100% de acerto automático — clipes
ambíguos são marcados, não adivinhados. É o usuário, olhando a timeline, quem
resolve o que o motor não teve confiança para decidir sozinho.
