# 0002 — Fronteira: motor agnóstico de NLE vs. adapter do Premiere

**Status:** ativa

**Contexto:** o app precisa produzir saída para mais de um NLE (hoje Adobe
Premiere Pro via `.prproj`; Avid Media Composer via `.aaf` está planejado, não
implementado). A lógica de sincronização — parear câmeras com o som direto,
medir offsets, agrupar tomadas — é a mesma para qualquer NLE; só o formato de
saída muda.

**Decisão:** dentro do sidecar Python, `src-python/sync/` e
`src-python/media/` não conhecem nenhum formato de NLE — produzem um modelo de
domínio (`Daily`, `Take`, `CameraGroup`, offsets em frames). `src-python/prproj/`
é o **adapter** do Premiere: só ele conhece a estrutura do XML, ClassIDs,
tick rate. Um adapter `aaf/` para o Avid entraria no mesmo nível, consumindo o
mesmo modelo de `sync/`.

**Regra:** nenhum tipo específico de NLE (ClassID do Premiere, estrutura de
Group Clip do Avid) vaza para `sync/`. Se `sync/` importar algo de `prproj/`,
a fronteira quebrou.

**Consequência:** testar o motor de sync não exige gerar um `.prproj` de
verdade — os testes em `src-python/tests/` operam no modelo de domínio puro.
