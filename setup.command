#!/bin/bash
# setup.command — macOS
# Duplo clique no Finder abre este arquivo no Terminal.
# Verifica o que falta, instala só o que falta e roda o Órbita em modo desenvolvedor.

set -u

cd "$(dirname "$0")"

echo "=================================================="
echo "  Preparando o ambiente do Órbita (macOS)"
echo "=================================================="
echo ""

# --- 1/7 Homebrew ---
if ! command -v brew >/dev/null 2>&1; then
  echo "[1/7] Homebrew não encontrado. Vou instalar."
  echo "      >> Pode pedir a SENHA do seu login do Mac. É normal — digite e pressione Enter."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
  [ -x /usr/local/bin/brew ]    && eval "$(/usr/local/bin/brew shellenv)"
else
  echo "[1/7] Homebrew já instalado. Ok."
fi

# --- 2/7 Ferramentas de linha de comando do Xcode ---
if ! xcode-select -p >/dev/null 2>&1; then
  echo "[2/7] Ferramentas do Xcode não encontradas. Vou pedir a instalação."
  echo "      >> Vai abrir uma janela do sistema. Clique em 'Instalar' e aguarde."
  xcode-select --install
  echo "      Aguardando a instalação terminar..."
  until xcode-select -p >/dev/null 2>&1; do sleep 5; done
else
  echo "[2/7] Ferramentas do Xcode já instaladas. Ok."
fi

# --- 3/7 Rust ---
if ! command -v cargo >/dev/null 2>&1; then
  echo "[3/7] Rust não encontrado. Vou instalar."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  . "$HOME/.cargo/env"
else
  echo "[3/7] Rust já instalado. Ok."
  . "$HOME/.cargo/env" 2>/dev/null || true
fi

# --- 4/7 Node.js ---
if ! command -v node >/dev/null 2>&1; then
  echo "[4/7] Node.js não encontrado. Vou instalar via Homebrew."
  brew install node
else
  echo "[4/7] Node.js já instalado. Ok."
fi

# --- 5/7 Python (necessário para construir o sidecar) ---
if ! command -v python3 >/dev/null 2>&1; then
  echo "[5/7] Python não encontrado. Vou instalar via Homebrew."
  brew install python
else
  echo "[5/7] Python já instalado. Ok."
fi

# --- 6/7 VLC (motor de vídeo do monitor) ---
# Aqui o VLC pesa MENOS que no Windows: o WKWebView decodifica ProRes
# nativamente via AVFoundation, então o material comum já toca sem ele. Serve
# ao que o WebView não toca mesmo (MXF, XDCAM). Falhar não aborta — o app roda
# igual, só sem monitor nesses formatos.
# (O ffmpeg NÃO é instalado no sistema: ele é EMBARCADO, baixado no passo 7/7.)
if [ -f "/Applications/VLC.app/Contents/MacOS/lib/libvlc.dylib" ]; then
  echo "[6/7] VLC já instalado. Ok."
else
  echo "[6/7] VLC não encontrado. Vou instalar (monitor de formatos que o WebView não toca)."
  brew install --cask vlc || echo "      (Não consegui instalar o VLC — seguindo. O app roda; o monitor avisa se precisar dele.)"
fi

echo ""
echo "Instalando as dependências do projeto..."
npm install

# --- 7/7 Sidecar Python ---
# src-tauri/binaries/ é gitignored: o binário do sidecar NUNCA vem do repo, e o
# `tauri dev` falha com "resource path ... doesn't exist" sem ele. Em CI isso é
# um passo explícito (.github/workflows/release.yml); aqui tem que ser também,
# senão toda máquina nova quebra no primeiro build.
echo ""
echo "[7/7] Verificando o sidecar Python..."
TRIPLE="$(rustc -vV | awk '/^host:/ {print $2}')"
if [ -z "$TRIPLE" ]; then
  echo "[ERRO] Não consegui descobrir o alvo do Rust. O Rust foi instalado agora?"
  echo "Feche esta janela e rode o setup.command de novo."
  read -n 1 -s -r -p "Pressione qualquer tecla para fechar..."
  exit 1
fi
if [ -f "src-tauri/binaries/orbita-python-$TRIPLE" ]; then
  echo "      Sidecar já construído. Ok."
else
  echo "      Sidecar não encontrado. Vou construir (demora alguns minutos)."
  python3 -m pip install -r src-python/requirements-build.txt
  if ! python3 src-python/build_sidecar.py "$TRIPLE"; then
    echo "[ERRO] Falha ao construir o sidecar Python."
    read -n 1 -s -r -p "Pressione qualquer tecla para fechar..."
    exit 1
  fi
fi
# ffmpeg/ffprobe EMBARCADOS: também em binaries/ (o externalBin do Tauri exige os
# arquivos no build). Baixados, nunca instalados no sistema — é o que faz o app
# rodar sem ffmpeg na máquina do usuário.
echo "      Verificando ffmpeg/ffprobe embarcados..."
if ! python3 src-python/fetch_ffmpeg.py "$TRIPLE"; then
  echo "[ERRO] Falha ao baixar o ffmpeg/ffprobe embarcados."
  read -n 1 -s -r -p "Pressione qualquer tecla para fechar..."
  exit 1
fi

echo ""
echo "=================================================="
echo "  Tudo pronto! Iniciando o Órbita em modo desenvolvedor."
echo "  Para PARAR o app, pressione Ctrl + C nesta janela."
echo "=================================================="
echo ""
npm run tauri dev

echo ""
echo "O app foi encerrado. Pode fechar esta janela."
read -n 1 -s -r -p "Pressione qualquer tecla para fechar..."
echo ""
