#!/usr/bin/env sh
# telar - inicia o espelhamento de tela (Linux / macOS)
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js nao encontrado."
  echo ""
  echo "  Instale com um destes:"
  echo "    Debian/Ubuntu : sudo apt install nodejs"
  echo "    Fedora        : sudo dnf install nodejs"
  echo "    Arch          : sudo pacman -S nodejs"
  echo "    macOS         : brew install node"
  echo "    Qualquer um   : https://nodejs.org"
  echo ""
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 16 ]; then
  echo ""
  echo "  Node.js $(node -v) e muito antigo. Precisa da versao 16 ou mais nova."
  echo ""
  exit 1
fi

exec node run.js "$@"
