#!/usr/bin/env sh
# screenshared - desinstalador (Linux / macOS)
# Apaga o que o programa baixou e criou. Nada foi instalado no sistema:
# sem pacote, sem systemd, sem sudo.
cd "$(dirname "$0")"

echo ""
echo "  screenshared - desinstalar"
echo ""
echo "  Vai apagar desta pasta:"
echo ""

ACHOU=0
if [ -f bin/cloudflared ]; then
  SZ=$(du -h bin/cloudflared 2>/dev/null | cut -f1)
  echo "    bin/cloudflared               ($SZ)"
  ACHOU=1
fi
if [ -d bin/node ]; then
  echo "    bin/node/                     (copia portatil do Node)"
  ACHOU=1
fi
if [ -d bin ] && [ ! -f bin/cloudflared ] && [ ! -d bin/node ]; then
  echo "    bin/"
  ACHOU=1
fi
if [ -f screenshared.config.json ]; then
  echo "    screenshared.config.json      (App ID do Discord, convite, texto)"
  ACHOU=1
fi
if [ -f tunnel.log ]; then
  echo "    tunnel.log"
  ACHOU=1
fi

if [ "$ACHOU" = "0" ]; then
  echo "    nada. Ja esta limpo."
  echo ""
  exit 0
fi

echo ""
echo "  O codigo em si (server.js, run.js, public/) NAO sera apagado."
echo "  Para sumir de vez, apague esta pasta depois."
echo ""
printf "  Confirma? [s/N] "
read RESP
case "$RESP" in
  s|S|sim|SIM) ;;
  *) echo ""; echo "  Cancelado, nada foi apagado."; echo ""; exit 0 ;;
esac

echo ""
if pgrep -f "bin/cloudflared" >/dev/null 2>&1; then
  echo "  Encerrando cloudflared..."
  pkill -f "bin/cloudflared" >/dev/null 2>&1 || true
  sleep 1
fi

if [ -d bin ]; then
  rm -rf bin && echo "  - bin/ apagado" || echo "  x nao consegui apagar bin/"
fi
if [ -f screenshared.config.json ]; then
  rm -f screenshared.config.json && echo "  - screenshared.config.json apagado"
fi
if [ -f tunnel.log ]; then
  rm -f tunnel.log && echo "  - tunnel.log apagado"
fi

echo ""
echo "  Pronto. Sobrou so o codigo; apague a pasta se quiser remover tudo."
echo ""
