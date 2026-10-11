#!/bin/sh
# Fixed entrypoint; document-controlled commands/configuration are never evaluated.
set -eu
umask 077
ulimit -f 32768
ulimit -n 128
export HOME=/work TECTONIC_CACHE_DIR=/opt/cache SOURCE_DATE_EPOCH=946684800 TZ=UTC LC_ALL=C
export TECTONIC_UNTRUSTED_MODE=1
export FONTCONFIG_FILE=/opt/fonts.conf
mkdir -p /work/out /work/export /work/font-cache
entrypoint="$1"
basename="${entrypoint##*/}"
stem="${basename%.tex}"
set +e
timeout -s KILL 60 tectonic -X compile --bundle /opt/bundle.zip --only-cached --untrusted --synctex --keep-logs --outdir /work/out "/source/$entrypoint" > /work/compiler.log 2>&1
status=$?
set -e
head -c 524288 /work/compiler.log > /work/export/compiler.log
printf '%s\n' "$status" > /work/export/status
if [ "$status" -eq 0 ] && [ -f "/work/out/$stem.pdf" ] && [ ! -L "/work/out/$stem.pdf" ] && [ -f "/work/out/$stem.synctex.gz" ] && [ ! -L "/work/out/$stem.synctex.gz" ]; then
  cp "/work/out/$stem.pdf" /work/export/result.pdf
  cp "/work/out/$stem.synctex.gz" /work/export/result.synctex.gz
  set +e
  timeout -s KILL 5 qpdf --json --json-key=pages --json-key=qpdf --json-stream-data=none /work/export/result.pdf > /work/export/pages.json 2>> /work/export/compiler.log
  inspection_status=$?
  set -e
  if [ "$inspection_status" -ne 0 ] && [ "$inspection_status" -ne 3 ]; then
    status=70
    printf '%s\n' "$status" > /work/export/status
  fi
fi
cd /work/export
set -- compiler.log status
for artifact in result.pdf result.synctex.gz pages.json; do
  if [ -f "$artifact" ] && [ ! -L "$artifact" ]; then set -- "$@" "$artifact"; fi
done
tar -cf - "$@"
exit "$status"
