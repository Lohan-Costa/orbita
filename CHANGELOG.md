# Changelog

Todas as mudanças notáveis do Órbita, por versão. Formato livre — o objetivo é
dizer o que mudou pra quem usa, não narrar o processo de desenvolvimento (isso
fica no histórico de commits).

## v0.1.8 — 2026-07-24

### Adicionado

- **Aviso de atualização disponível.** A versão no rodapé agora avisa sozinha:
  fica **vermelha** (com um ícone e um tooltip) quando existe uma versão mais
  nova publicada no GitHub, e vira um link direto para a página de download;
  fica **amarela** se não foi possível checar (por exemplo, sem internet).
- **Resolução de reprodução (Full/½/¼).** Um seletor no próprio monitor, ao
  lado dos botões de ângulo, deixa escolher a nitidez do vídeo em tempo real —
  útil para aliviar a carga em máquinas mais lentas ou mídia muito pesada.

### Melhorado

- Texto do aviso de fase Alpha atualizado, com um link direto para o
  repositório no GitHub (roadmap e atualizações).

### Corrigido

- A prévia de um clipe (duplo-clique no painel de mídia) podia ficar "grudada"
  por cima do monitor sincronizado ao navegar na timeline depois de
  sincronizar. Agora um clique na timeline devolve o monitor ao vídeo
  sincronizado normalmente.
- Trocar a resolução de reprodução reiniciava o vídeo da prévia do zero.
  Agora ele continua de onde estava.

## v0.1.7 — 2026-07-22

O monitor de vídeo foi reescrito: **não precisa mais do VLC**.

### Melhorado

- **Monitor mais fiel, e sem VLC.** Para formatos que o navegador interno não
  decodifica (ProRes, MXF, XDCAM…), o Órbita agora gera internamente uma prévia
  leve em vez de recorrer ao VLC. Com isso: o seek pausado ficou **exato ao
  frame** — a claquete bate no ponto certo do som (o VLC podia mostrar um quadro
  anterior e fazer o sync *correto* parecer errado); tudo acontece dentro da
  janela do app (sem a tela preta/sobreposição que dava no Windows); e **você não
  precisa mais instalar o VLC**.
- **Prévia de clipe com som.** Duplo-clique num arquivo que o app não decodifica
  nativamente agora toca com imagem e som, com os controles normais — também sem
  VLC. (Clipes longos levam alguns segundos preparando na primeira vez; depois é
  instantâneo.)

## v0.1.6 — 2026-07-21

Correção: **sincronizar não exige mais o ffmpeg instalado**.

### Corrigido

- **"Erro ao sincronizar: [Errno 2] ... 'ffmpeg'".** Em máquinas que não tinham
  o ffmpeg instalado por fora, o sync falhava — o app dependia de uma ferramenta
  externa que a maioria dos usuários não tem. Agora o ffmpeg (e o ffprobe) vêm
  **embarcados no app**: nada precisa ser instalado à parte. Vale para o
  sincronismo e para a reprodução de áudio no monitor.

## v0.1.5 — 2026-07-21

Correção focada no **Windows**: o monitor de vídeo, que ficava preto com
material ProRes, agora funciona. No macOS nada muda.

### Corrigido

- **Monitor preto no Windows com ProRes.** No Windows o monitor não conseguia
  mostrar vídeo ProRes — a tela ficava preta (às vezes só com o áudio tocando),
  porque o navegador embutido do Windows não decodifica esse formato da Apple.
  Agora o Órbita usa o VLC como motor de vídeo nesses casos, como já fazia no
  macOS. (No macOS o ProRes continua tocando direto, sem mudança.)
- **Prévia de clipe tocava só o áudio, com a tela preta.** Ao dar duplo-clique
  num arquivo que o navegador embutido não decodifica, a prévia chegava a tocar
  o som sobre uma tela preta e só depois carregar a imagem. Agora o motor de
  vídeo é um só de cada vez — ou a prévia toca com imagem e som, ou entrega
  direto ao VLC, sem esse "play duplo".

## v0.1.4 — 2026-07-20

Primeira versão com mudanças de **funcionalidade** desde o Alpha inicial (a
0.1.1–0.1.3 foram só correções do Windows). O painel de mídia foi remodelado e
ganhou organização de câmeras; a timeline ganhou o "fechar lacunas"; e há uma
janela de Configurações.

### Novo

- **Detecção automática de múltiplas fontes numa pasta só.** Ao importar uma
  pasta que contém, por exemplo, a câmera principal *e* um drone — ou as
  câmeras *e* o som direto —, o Órbita percebe pelos padrões de nome dos
  arquivos e **pergunta antes de importar**, propondo quem é CAM A, CAM B,
  SOM 1… Você confirma, reordena, tira alguma da lista, ou diz que foi falso
  positivo e é tudo uma fonte só. Cartões da mesma câmera (`A01/`, `A02/`…)
  continuam sendo reconhecidos como uma câmera só.
- **Criar câmera vazia e mover clipes entre câmeras.** Se a detecção errar — ou
  se a mídia veio misturada —, dá para criar uma câmera nova no grupo e mandar a
  seleção para ela pelo menu "Mover para".
- **Botão "Fechar lacunas"** na timeline: encosta as tomadas umas nas outras,
  sem buracos e sem sobrepor. **A tomada anda inteira** (câmeras + som direto
  juntos), então o sincronismo não muda. A setinha ao lado abre o menu onde
  outras formas de arrumar vão entrar.
- **Janela de Configurações** (engrenagem, ao lado do Exportar):
  - local do cache, com o caminho atual à vista;
  - quanto o cache está ocupando, e um botão para limpá-lo;
  - **limite de tamanho** — passando dele, os itens usados há mais tempo são
    apagados para dar lugar aos novos;
  - botão para abrir a pasta de logs (é o que anexar ao reportar um bug).
- **Prévia de clipe no monitor:** duplo-clique num arquivo do painel de mídia
  carrega ele no monitor, com som e controles, sem mexer no que está
  sincronizado.

### Melhorado

- **Painel de mídia remodelado.** Árvore e lista de arquivos agora leem como um
  painel só; a árvore ganhou título e hierarquia visível; os arquivos ganharam
  ícone de câmera/microfone **na cor da track correspondente**, criando o elo
  entre o que está na lista e o que está na timeline.
- **Seleção de arquivos como num gerenciador de arquivos:** clique simples
  seleciona um, `Cmd`/`Ctrl`+clique alterna, `Shift`+clique pega o intervalo.
  (Antes todo clique acumulava.)
- **Renomear é no duplo-clique**, e o clique simples só seleciona — antes o
  nome era um campo de texto sempre aberto.
- **Feedback de processamento em toda fase pesada.** Um painel no centro da
  timeline mostra o que está acontecendo (lendo metadados, iniciando o motor,
  sincronizando, gerando formas de onda) com contador e barra. Antes o app podia
  passar minutos lendo dezenas de GB em silêncio, parecendo travado.
- **Ações da seleção** (re-sincronizar, criar cena, confirmar, reverter) saíram
  da barra da timeline e foram para a barra de baixo, junto de
  Sincronizar/Exportar — liberando espaço para as informações da timeline.
- Colunas do painel de mídia com rolagem horizontal; a coluna FPS mostra só o
  número.

### Corrigido

- **Sincronizar podia rodar com um conjunto PARCIAL de arquivos, em silêncio.**
  Se você clicasse em "Sincronizar" enquanto os metadados ainda estavam sendo
  lidos, só os arquivos já lidos entravam — sem nenhum aviso. Agora o botão
  espera a leitura terminar.
- **"Fechar lacunas" apagava a confirmação** de clipes sem som direto que você
  já tinha revisado.
- **Limpar o cache** agia no local antigo quando você tinha acabado de escolher
  um novo sem salvar. Agora o botão espera o "Salvar".
- **O resumo do sync** ("N tomadas sincronizadas…") ficava escondido enquanto as
  formas de onda eram geradas — que pode levar minutos.
- Mover clipes de vídeo para uma fonte de som (e vice-versa) não é mais
  oferecido, porque reclassificava os clipes sem avisar.
- A prévia do monitor não aparecia em formatos que usam o VLC como motor.
- O contador de leitura de metadados contava o projeto inteiro em vez do lote
  que estava entrando — a barra nascia quase cheia e parecia travada.
- Barra da timeline não quebra mais linha quando há muita informação.

## v0.1.3 — 2026-07-19

### Corrigido

- **Windows: sidecar podia derrubar o processo com nomes de arquivo/cena com
  emoji, caracteres asiáticos ou cirílicos** (o Windows usa um codepage que não
  cobre todo o Unicode; a comunicação com o sidecar agora força UTF-8).
- **Suíte de testes automatizados agora passa também no Windows** (só afetava
  os testes em si, não o app).

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
