#!/usr/bin/env bash
# Builds and installs the latest cava release (https://github.com/karlstav/cava)
# into /usr/local. Ubuntu's own package is years behind, so this builds from
# source. Does nothing when that release is already installed.
set -euo pipefail

TAG=$(curl -fsSL https://api.github.com/repos/karlstav/cava/releases/latest |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
if [ -z "$TAG" ]; then
    echo "Could not find the latest cava release" >&2
    exit 1
fi

if command -v cava >/dev/null && [ "$(cava -v | awk '{print $2}')" = "$TAG" ]; then
    echo "cava $TAG is already installed"
    exit 0
fi

sudo apt-get install -y build-essential libfftw3-dev libasound2-dev libpulse-dev \
    libtool automake libiniparser-dev libsdl2-2.0-0 libsdl2-dev \
    libpipewire-0.3-dev libjack-jackd2-dev pkgconf git

SRC="${XDG_CACHE_HOME:-$HOME/.cache}/cava-src"
rm -rf "$SRC"
git clone --branch "$TAG" --depth 1 https://github.com/karlstav/cava.git "$SRC"
cd "$SRC"
./autogen.sh
./configure
make -j"$(nproc)"
sudo make install
cava -v
