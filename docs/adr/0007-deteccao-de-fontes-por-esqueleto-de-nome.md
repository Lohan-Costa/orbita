# 0007 — Detectar múltiplas fontes numa pasta pelo ESQUELETO do nome dos arquivos

**Status:** ativa

**Contexto:** o modelo do app é "uma pasta arrastada = uma fonte", com varredura
recursiva — porque uma câmera de cinema despeja o dia em CARTÕES
(`CAM_A/A01/`, `CAM_A/A02/`, …) e os quatro cartões são a mesma câmera, não
quatro. Lendo um nível só, os cartões de uma diária viravam quatro tracks.

Mas o material real quebra a premissa na direção oposta: uma pasta `01_CAMERAS/`
costuma conter a câmera principal E um drone; a pasta da diária inteira contém
as câmeras E o som direto. Tratados como uma fonte só, eles colapsam numa track
e o usuário nem é avisado.

O sinal óbvio — contar arquivos, ou comparar prefixos de nome — não serve: dois
cartões da MESMA câmera têm prefixos diferentes (`A008_` vs `A009_`) e
contagens diferentes.

**Decisão:** o discriminador é o **esqueleto do nome do arquivo**: runs de letras
viram `A`, runs de dígitos viram `#`, separadores ficam.

```
A008_03190217_C001.mp4  ->  A#_#_A#   ┐ mesma câmera, cartões diferentes
A009_03190312_C002.mp4  ->  A#_#_A#   ┘
DJI_0315.mp4            ->  A_#       <- outro equipamento
```

A numeração muda de cartão para cartão e de clipe para clipe; a FORMA do nome é
do equipamento que gravou. Os candidatos são as subpastas diretas com mídia, e
as que compartilham esqueleto **voltam a se juntar** — é assim que a regra dos
cartões continua valendo. A busca é recursiva (a diária inteira divide em
câmeras e som, e só descendo aparecem as duas câmeras). O TIPO (câmera/som, por
extensão) entra na chave de junção, para um gravador nunca se fundir com uma
câmera por semelhança de nome.

**A heurística PROPÕE, nunca decide:** todo grupo saído de um split carrega
`split_from`, e a UI abre um diálogo de confirmação com três saídas — aceitar (a
ordem da lista define CAM A, CAM B…), tirar uma da lista, ou "é tudo uma fonte
só" (falso positivo). Material real inclui GoPro, RED com um arquivo por
subpasta e câmera renomeada à mão; importar em silêncio significaria descobrir o
erro só na timeline, com as tracks já erradas.

**Alternativas consideradas:** contagem de arquivos e prefixo literal
(descartadas — ver acima); pedir ao usuário que arraste cada câmera
separadamente (descartada — é justamente o trabalho manual que o app existe para
evitar); classificar lendo metadados de cada arquivo (descartada nesta camada —
o Rust não lê metadados, e a decisão precisa acontecer ANTES do probe).

**Consequência:** o esqueleto é calculado do NOME, então material com nomes
totalmente irregulares (arquivos renomeados à mão, um a um) não divide — e o
recurso passa a ser o manual: criar câmera vazia e mover os clipes pelo menu
"Mover para". O caminho automático e o manual foram entregues juntos de
propósito.
