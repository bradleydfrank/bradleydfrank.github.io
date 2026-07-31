#!/bin/sh
# Re-copy the DropletCA runtime from its own repository into this site.
#
# The tool is developed and tested in its own repo; this site hosts a copy at
# /dropletca/. Only the JS and the example image are copied — the markup lives
# in src/pages/dropletca.astro and the styling in src/styles/dropletca.css,
# both of which are adapted to sit inside the site layout and theme.
#
# After running this, if the tool's own css/app.css changed, regenerate
# src/styles/dropletca.css from it (see the header comment in that file).
#
# Usage: ./scripts/sync-dropletca.sh [path-to-dropletCA-repo]

set -e

SRC="${1:-$HOME/code/dropletCA}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/public/tools/dropletca"

if [ ! -f "$SRC/js/geometry.js" ]; then
  echo "Cannot find DropletCA at: $SRC" >&2
  echo "Pass the path as the first argument." >&2
  exit 1
fi

mkdir -p "$DEST/example"
cp "$SRC/js/geometry.js" "$SRC/js/viewer.js" "$SRC/js/app.js" "$DEST/"
cp "$SRC/example/janus-droplets.jpg" "$DEST/example/"

echo "Synced DropletCA runtime from $SRC"
ls -1 "$DEST" "$DEST/example"
