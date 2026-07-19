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

# --- 1/4 Homebrew ---
if ! command -v brew >/dev/null 2>&1; then
  echo "[1/4] Homebrew não encontrado. Vou instalar."
  echo "      >> Pode pedir a SENHA do seu login do Mac. É normal — digite e pressione Enter."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
  [ -x /usr/local/bin/brew ]    && eval "$(/usr/local/bin/brew shellenv)"
else
  echo "[1/4] Homebrew já instalado. Ok."
fi

# --- 2/4 Ferramentas de linha de comando do Xcode ---
if ! xcode-select -p >/dev/null 2>&1; then
  echo "[2/4] Ferramentas do Xcode não encontradas. Vou pedir a instalação."
  echo "      >> Vai abrir uma janela do sistema. Clique em 'Instalar' e aguarde."
  xcode-select --install
  echo "      Aguardando a instalação terminar..."
  until xcode-select -p >/dev/null 2>&1; do sleep 5; done
else
  echo "[2/4] Ferramentas do Xcode já instaladas. Ok."
fi

# --- 3/4 Rust ---
if ! command -v cargo >/dev/null 2>&1; then
  echo "[3/4] Rust não encontrado. Vou instalar."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  . "$HOME/.cargo/env"
else
  echo "[3/4] Rust já instalado. Ok."
  . "$HOME/.cargo/env" 2>/dev/null || true
fi

# --- 4/4 Node.js ---
if ! command -v node >/dev/null 2>&1; then
  echo "[4/4] Node.js não encontrado. Vou instalar via Homebrew."
  brew install node
else
  echo "[4/4] Node.js já instalado. Ok."
fi

echo ""
echo "Instalando as dependências do projeto..."
npm install

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
