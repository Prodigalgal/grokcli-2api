#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/node"
[ -d node_modules ] || npm ci
npm run build
exec npm start
