# Órbita

**Sincronização multicâmera automática para montadores(as).** O Órbita recebe as
mídias de uma diária de filmagem — os clipes de cada câmera e o som direto — e as
sincroniza automaticamente, entregando um projeto pronto para abrir no seu editor
(NLE) com tudo no lugar.

> **Status: Alpha.** Em beta privado com um grupo de testadores. Interface e
> formatos podem mudar.

## O que ele faz

- **Sincroniza diárias inteiras** — várias tomadas, cada uma com seu som direto,
  sem depender de claquete manual.
- **Método híbrido:** usa o *timecode* para parear câmera e som e a *forma de onda*
  do áudio para confirmar o ponto exato. Dá para escolher só timecode, só forma de
  onda, ou o híbrido.
- **Linha do tempo visual** para você **conferir o sync com os próprios olhos**
  antes de exportar, com as waveforms lado a lado.
- **Correção manual** do que o sistema marcar como duvidoso — arrastar, confirmar,
  reverter — direto na timeline.
- **Exporta para o Adobe Premiere Pro** (`.prproj`), com os clipes agrupados e
  sincronizados. Suporte ao **Avid Media Composer** (`.aaf`) e ao **DaVinci
  Resolve** (`.drt`) em desenvolvimento.
- Roda em **macOS e Windows**.

## Organizando a mídia

O painel da esquerda é o seu **bin**: à esquerda a árvore (grupos → câmeras e
som direto → cenas), à direita os arquivos do que estiver selecionado, com
timecode, framerate e duração.

**Arraste as pastas para dentro de um grupo.** Uma pasta = uma fonte, e os
cartões de uma mesma câmera (`A01/`, `A02/`…) são reconhecidos como uma câmera
só — não como quatro.

Quando uma pasta tem **mais de uma fonte dentro** — a câmera principal e um
drone, ou as câmeras e o som direto —, o Órbita percebe pelos padrões de nome
dos arquivos e **pergunta antes de importar**, propondo quem é CAM A, CAM B,
SOM 1… Você confirma, reordena, tira alguma da lista, ou diz que é falso
positivo e é tudo uma fonte só. Se a detecção errar, dá para **criar uma câmera
vazia** no grupo e mandar a seleção para ela pelo menu **"Mover para"**.

Os arquivos aparecem com o ícone na **cor da track** correspondente na timeline
— é o elo entre a lista e o que você vê sincronizado. **Duplo-clique** carrega o
clipe no monitor para conferir.

## Configurações

Na engrenagem ao lado do *Exportar*: onde fica o **cache** (as formas de onda e
os metadados já lidos), quanto ele ocupa, um botão para limpá-lo e o **limite de
tamanho** — passando dele, o que você usou há mais tempo sai para dar lugar ao
novo. Também dali se abre a **pasta de logs**, que é o que anexar ao reportar um
bug.

## Download

Acesse a aba [Releases](../../releases) do repositório.

### macOS

1. Baixe o arquivo `.dmg`, abra-o e arraste o app para a pasta **Applications**.
2. Tente abrir o app — o macOS exibirá **"está danificado e não pode ser aberto"**
   *(isso ocorre porque o app não possui assinatura Apple Developer — é normal em
   software gratuito de código aberto)*.
3. Abra o **Terminal** e execute:
   ```
   xattr -cr "/Applications/Órbita.app"
   ```
4. Abra o app normalmente — o aviso não aparecerá mais.

### Windows

1. Baixe o instalador `.exe` e execute-o.
2. Se o Windows SmartScreen alertar:
   - Clique em **"Mais informações"**
   - Clique em **"Executar mesmo assim"**
3. Siga o instalador — o Órbita fica disponível no menu Iniciar.

## Changelog

Ver [CHANGELOG.md](CHANGELOG.md).

## Requisitos

- **FFmpeg** (leitura de mídia e áudio).
- **VLC** (opcional — habilita o monitor de vídeo embutido).
- Para desenvolvimento: Node.js, Rust e Python 3.

## Rodar

- **Usuários:** ver [Download](#download) acima.
- **Desenvolvimento:** duplo clique em `setup.command` (macOS) ou `setup.bat`
  (Windows) — ele checa o ambiente, instala o que falta e roda em modo dev.

## Licença e contribuições

Software livre sob a licença **[MIT](LICENSE)** — você pode usar, estudar,
auditar, modificar e redistribuir. Qualquer pessoa pode manter a sua própria
versão (fork).

O **Órbita principal é mantido de forma solo**, no ritmo e no roadmap do
mantenedor, e **não aceita pull requests**. Achou um problema ou tem uma ideia?
Abra uma *issue* — o retorno é bem-vindo, mesmo sem PRs.

## Créditos

Idealizado por **Lohan Costa**, edt. Desenvolvido com Claude Code.
