#!/bin/sh
# `security` falso para los tests: nunca toca el llavero real.
# Uso: fake-security.sh find-generic-password -s faro -a <cuenta> -w
# Responde con $FAKE_SECRET_<cuenta> (guiones y dos puntos como _) o sale con 44 (no encontrado).
[ -n "$FAKE_SECURITY_LOG" ] && printf '%s\n' "$*" >> "$FAKE_SECURITY_LOG"
account=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-a" ]; then account="$2"; shift; fi
  shift
done
var="FAKE_SECRET_$(printf '%s' "$account" | tr ':-' '__')"
value=$(printenv "$var") || exit 44
printf '%s\n' "$value"
