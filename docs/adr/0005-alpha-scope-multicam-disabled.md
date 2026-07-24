# 0005 — Alpha entrega sequência normal sincronizada; multicam fica desligado

**Status:** ativa (reversível — é uma flag)

**Contexto:** o motor sabe montar uma Multi-Camera Source Sequence adaptativa
(múltiplos canais discretos de áudio, roteamento por câmera) para o Premiere.
Mas o resultado, quando aberto no Premiere, mostra o áudio como **"0 Channel
mapped to N Mono"** em vez de **"Multichannel mapped to N Mono"**: a
sequência toca normalmente como timeline, mas fica muda no monitor de origem
e sem waveform ao dar nest — um defeito sutil o bastante para passar
despercebido até alguém tentar mixar o som a partir dali.

**Decisão:** no Alpha, toda diária/cena exporta como **sequência normal
sincronizada** — as câmeras e o som direto posicionados corretamente na
timeline, sem a estrutura de Multicam Source Sequence. O código do multicam
adaptativo continua no builder, **desligado por uma flag** (`multicam=False`),
para retomar quando a causa do "0 Channel" for encontrada.

**Alternativas consideradas:** entregar o multicam mesmo assim, avisando o
usuário do defeito (descartada — um app cuja premissa é confiabilidade não
pode entregar um resultado que se sabe quebrado, mesmo com aviso).

**Consequência:** o monitor de ângulos ao vivo (trocar de câmera como no
Premiere) não está disponível no Alpha. O usuário confere e corrige o sync na
timeline do Órbita antes de exportar, depois monta manualmente no NLE.
