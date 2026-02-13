# Maintainer: Cindy <cindy@example.com>
pkgname=rosereader
pkgver=1.0.0
pkgrel=4
pkgdesc="E-book reader with infinite scroll, supporting EPUB, PDF, and TXT"
arch=('x86_64')
url="https://github.com/CamelliaV/rosereader"
license=('MIT')
depends=('electron')
makedepends=('npm')
source=()
sha256sums=()

build() {
    cd "$srcdir/.."

    export npm_config_cache="${srcdir}/npm-cache"
    export ELECTRON_BUILDER_CACHE="${srcdir}/electron-builder-cache"
    mkdir -p "$npm_config_cache" "$ELECTRON_BUILDER_CACHE"

    # Use system electron at runtime; avoid bundling/downloading Electron via npm.
    npm ci --omit=dev --prefer-offline
}

package() {
    cd "$srcdir/.."

    install -dm755 "$pkgdir/usr/lib/rosereader"
    cp -r index.html main.js package.json package-lock.json node_modules build icon.svg "$pkgdir/usr/lib/rosereader/"

    install -Dm755 /dev/stdin "$pkgdir/usr/bin/rosereader" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${ROSE_DATA_DIR:=${XDG_CONFIG_HOME:-$HOME/.config}/RoseReader}"
export ROSE_DATA_DIR
exec electron /usr/lib/rosereader "$@"
EOF

    install -Dm644 rosereader.desktop "$pkgdir/usr/share/applications/rosereader.desktop"
    install -Dm644 build/icon.png "$pkgdir/usr/share/pixmaps/rosereader.png"
}
