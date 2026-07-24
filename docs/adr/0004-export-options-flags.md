# 0004 — Opções de export são flags independentes, nunca variantes nomeadas

**Status:** ativa

**Contexto:** o export para o NLE tem várias escolhas independentes do
usuário — incluir o áudio original da câmera ou não, tirar os gaps ou não,
gerar clipes merged ou não, e mais no futuro. A primeira versão do builder
tentou nomear cada COMBINAÇÃO (`sem_merged`, `sem_merged_sem_gap`,
`com_merged`, `com_merged_sem_gap`...). Duas opções já davam 4 nomes; cinco
opções dariam 32 — e cada combinação nova viraria código novo.

**Decisão:** cada preferência de export é um **flag independente** em
`ExportOptions` (no adapter — nunca no modelo de domínio `Daily`/`Take`).
`ExportOptions` muda quando o usuário mexe num toggle da UI; o modelo de
domínio muda quando a mídia ou o sync mudam. As duas coisas não se misturam:
um toggle de saída não invalida o sync nem exige ressincronizar.

**Alternativas consideradas:** nomear cada combinação (descartada — explosão
combinatória, ver acima).

**Consequência:** um flag novo é um campo novo em `ExportOptions` e um `if`
no builder — nunca um caminho de código paralelo.
