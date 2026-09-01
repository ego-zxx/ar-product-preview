#!/usr/bin/env bash
# Regenerate the LAN dev certificate for the machine's current IP.
#
# Chrome on Android rejects a certificate outright — with no clickable bypass —
# unless it carries a subjectAltName matching the address being visited. DHCP
# hands out a new IP often enough that this needs to be one command.
set -euo pipefail
IP="$(ipconfig getifaddr en0 2>/dev/null || hostname -I | awk '{print $1}')"
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=$IP" \
  -addext "subjectAltName=IP:$IP,IP:127.0.0.1,DNS:localhost" 2>/dev/null
echo "certificate now valid for https://$IP:5173"
echo "set the admin's \"Link the QR points to\" field to that address"
