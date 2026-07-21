# 0008 — O sidecar vem do venv em DEBUG e do bundle em RELEASE

**Status:** ativa

**Contexto:** o `SidecarManager::detect()` procura o processo Python em três
lugares, em ordem: o binário empacotado ao lado do executável, o venv de
desenvolvimento (`src-python/.venv` + `main.py`), e por fim o `python3` do PATH.

Com o bundle SEMPRE em primeiro lugar, o `tauri dev` caía numa armadilha
silenciosa: no modo dev o executável é `target/debug/orbita`, e `target/debug/`
guarda o `orbita-python` de qualquer execução anterior do `build_sidecar.py`.
Esse binário VELHO ganhava do `main.py` vivo — o app rodava Python de semanas
atrás sem nenhum aviso.

O sintoma engana: comandos ANTIGOS continuam funcionando (estão no binário
velho), e só os NOVOS falham — o que joga a suspeita no código novo em vez do
binário obsoleto.

**Decisão:** a ordem depende do perfil de build.

- **Release** — bundle primeiro. É o único que existe no app instalado, e é onde
  o `externalBin` do Tauri põe o sidecar.
- **Debug** (`cfg!(debug_assertions)`) — venv primeiro. Em desenvolvimento, o
  código vivo é a fonte de verdade; o binário empacotado é resíduo de build.

O `python3` do PATH segue como último recurso nos dois casos — e existe o
cuidado de nunca chegar nele à toa, porque num Windows sem Python instalado ele
costuma ser o stub da Microsoft Store, que abre a loja e encerra.

**Alternativas consideradas:** apagar o binário obsoleto de `target/debug`
(descartada — resolve uma vez e volta a acontecer no próximo
`build_sidecar.py`; a armadilha é silenciosa demais para depender de
disciplina); comparar mtime do binário com o do `main.py` (descartada —
complexidade sem ganho: em dev a resposta certa é sempre o código vivo).

**Consequência:** o comportamento do app instalado é idêntico ao de antes. Se um
comando novo do sidecar "não existir" em desenvolvimento, a primeira coisa a
checar é qual executável está no ar:

```sh
strings src-tauri/target/debug/orbita-python | grep -c <comando_novo>
```
