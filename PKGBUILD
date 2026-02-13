# Maintainer: Cindy <cindy@example.com>
pkgname=rosereader
pkgver=1.0.0
pkgrel=1
pkgdesc="E-book reader with infinite scroll, supporting EPUB, PDF, and TXT"
arch=('x86_64')
url="https://github.com/cindy/rosereader"
license=('MIT')
depends=('electron' 'nodejs')
makedepends=('npm')
source=()
sha256sums=()

build() {
    cd "$srcdir/.."

    export npm_config_cache="${srcdir}/npm-cache"
    export ELECTRON_BUILDER_CACHE="${srcdir}/electron-builder-cache"
    mkdir -p "$npm_config_cache" "$ELECTRON_BUILDER_CACHE"

    export CFLAGS+=" -march=znver4 -mtune=znver4 -O3 -pipe -fomit-frame-pointer"
    export CXXFLAGS+=" -march=znver4 -mtune=znver4 -O3 -pipe -fomit-frame-pointer"
    export LDFLAGS+=" -Wl,-O1,--as-needed"

    npm ci --prefer-offline
    npm run pack
}

package() {
    cd "$srcdir/.."

    install -dm755 "$pkgdir/usr/lib/rosereader"
    cp -r dist/linux-unpacked/* "$pkgdir/usr/lib/rosereader/"

    install -dm755 "$pkgdir/usr/bin"
    ln -s /usr/lib/rosereader/rosereader "$pkgdir/usr/bin/rosereader"

    install -Dm644 /dev/stdin "$pkgdir/usr/share/applications/rosereader.desktop" <<EOF
[Desktop Entry]
Name=RoseReader
Comment=E-book reader with infinite scroll
Exec=rosereader
Icon=rosereader
Terminal=false
Type=Application
Categories=Office;Viewer;
MimeType=application/epub+zip;application/pdf;text/plain;
EOF
}
