#!/usr/bin/env sh
# telar - inicia o espelhamento de tela (Linux / macOS)
# Primeira execucao se vira sozinha: se nao houver Node, baixa uma copia portatil
# para bin/ e usa ela. Nada e instalado no sistema, nada precisa de sudo.
set -e
cd "$(dirname "$0")"

NODE_VERSION=v22.20.0
NODE=""

have_node() {
  command -v node >/dev/null 2>&1 || return 1
  MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
  [ "$MAJOR" -ge 16 ] 2>/dev/null || return 1
  return 0
}

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else return 1
  fi
}

install_node() {
  case "$(uname -s)" in
    Linux)  PLAT=linux ;;
    Darwin) PLAT=darwin ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)   ARCH=x64 ;;
    aarch64|arm64)  ARCH=arm64 ;;
    armv7l)         ARCH=armv7l ;;
    *) return 1 ;;
  esac

  PKG="node-$NODE_VERSION-$PLAT-$ARCH"
  echo ""
  echo "  Node.js nao encontrado no sistema."
  echo "  Baixando uma copia portatil para bin/ (~30 MB, so' desta vez)..."
  echo ""

  mkdir -p bin
  fetch "https://nodejs.org/dist/$NODE_VERSION/$PKG.tar.gz" bin/node.tar.gz || return 1
  tar -xzf bin/node.tar.gz -C bin || return 1
  rm -f bin/node.tar.gz
  rm -rf bin/node
  mv "bin/$PKG" bin/node || return 1
  [ -x bin/node/bin/node ] || return 1
  echo "  Node portatil pronto em bin/node"
  return 0
}

if have_node; then
  NODE=node
elif [ -x bin/node/bin/node ]; then
  NODE=./bin/node/bin/node
elif install_node; then
  NODE=./bin/node/bin/node
else
  echo ""
  echo "  Nao consegui preparar o Node.js automaticamente."
  echo ""
  echo "  Instale na mao com um destes e rode de novo:"
  echo "    Debian/Ubuntu : sudo apt install nodejs"
  echo "    Fedora        : sudo dnf install nodejs"
  echo "    Arch          : sudo pacman -S nodejs"
  echo "    macOS         : brew install node"
  echo "    Qualquer um   : https://nodejs.org"
  echo ""
  exit 1
fi

exec "$NODE" run.js "$@"
