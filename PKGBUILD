# Maintainer: Cindy <cindy@example.com>
pkgname=rosereader
pkgver=1.0.0
pkgrel=2
pkgdesc="E-book reader with infinite scroll, supporting EPUB, PDF, and TXT"
arch=('x86_64')
url="https://github.com/CamelliaV/rosereader"
license=('MIT')
depends=('glibc' 'gtk3' 'nss' 'libxss')
makedepends=('npm')
source=()
sha256sums=()

build() {
    cd "$srcdir/.."

    export npm_config_cache="${srcdir}/npm-cache"
    export ELECTRON_BUILDER_CACHE="${srcdir}/electron-builder-cache"
    mkdir -p "$npm_config_cache" "$ELECTRON_BUILDER_CACHE"

    npm ci --prefer-offline
    npm run pack
}

package() {
    cd "$srcdir/.."

    install -dm755 "$pkgdir/usr/lib/rosereader"
    cp -r dist/linux-unpacked/* "$pkgdir/usr/lib/rosereader/"

    install -Dm755 /dev/stdin "$pkgdir/usr/bin/rosereader" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${ROSE_DATA_DIR:=${XDG_CONFIG_HOME:-$HOME/.config}/RoseReader}"
export ROSE_DATA_DIR
exec /usr/lib/rosereader/rosereader "$@"
EOF

    install -Dm644 rosereader.desktop "$pkgdir/usr/share/applications/rosereader.desktop"
    install -Dm644 build/icon.png "$pkgdir/usr/share/pixmaps/rosereader.png"
}
