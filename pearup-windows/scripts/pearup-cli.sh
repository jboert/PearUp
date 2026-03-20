#!/bin/bash
# PearUp CLI — talks to the running daemon via Unix socket
# Requires Node.js on the system. The tray app runs the daemon.
DIR="$(dirname "$(readlink -f "$0")")"
APPDIR="$DIR/resources/app.asar.unpacked"
if [ ! -f "$APPDIR/cli.js" ]; then
  APPDIR="$DIR/resources/app"
fi
if command -v node &> /dev/null; then
  export NODE_PATH="$DIR/resources/app.asar.unpacked/node_modules:$DIR/resources/app/node_modules"
  exec node "$APPDIR/cli.js" "$@"
else
  echo "Node.js required for PearUp CLI. Install: sudo zypper install nodejs20" >&2
  echo "The tray app (pearup-tray) works without Node.js." >&2
  exit 1
fi
