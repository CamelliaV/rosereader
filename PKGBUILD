# Maintainer: CamelliaV <cameliascript@gmail.com>
pkgname=rosereader
pkgver=1.1.0
pkgrel=1
pkgdesc="E-book reader with infinite scroll, supporting EPUB, PDF, TXT, and Markdown"
arch=('x86_64')
url="https://github.com/CamelliaV/rosereader"
license=('MIT')
depends=('electron')
makedepends=('npm')
source=()
sha256sums=()

package() {
    cd "$srcdir/.."
    umask 022

    local appdir="$pkgdir/usr/lib/rosereader"
    install -dm755 "$appdir"
    install -Dm644 index.html "$appdir/index.html"
    install -Dm644 main.js "$appdir/main.js"
    install -Dm644 search-index.js "$appdir/search-index.js"
    install -Dm644 package.json "$appdir/package.json"
    install -Dm644 package-lock.json "$appdir/package-lock.json"
    install -Dm644 icon.svg "$appdir/icon.svg"

    npm ci --omit=dev --prefer-offline --cache "${srcdir}/npm-cache" --prefix "$appdir"
    find "$appdir" -type d -exec chmod 755 {} +
    find "$appdir" -type f -exec chmod 644 {} +

    install -Dm755 /dev/stdin "$pkgdir/usr/bin/rosereader" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: "${ROSE_DATA_DIR:=${XDG_CONFIG_HOME:-$HOME/.config}/RoseReader}"
export ROSE_DATA_DIR
exec electron /usr/lib/rosereader "$@"
EOF

    install -Dm644 rosereader.desktop "$pkgdir/usr/share/applications/rosereader.desktop"
    install -Dm644 icon.svg "$pkgdir/usr/share/icons/hicolor/scalable/apps/rosereader.svg"
}
