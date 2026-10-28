{
  alsa-lib,
  at-spi2-core,
  autoPatchelfHook,
  dbus,
  expat,
  fetchurl,
  glib,
  lib,
  libgbm,
  libgcc,
  libx11,
  libxcb,
  libxcomposite,
  libxdamage,
  libxext,
  libxfixes,
  libxrandr,
  libxkbcommon,
  makeWrapper,
  nspr,
  nss,
  stdenv,
  udev,
  versionCheckHook,
}:
let
  version = "0.1.3";
  sources = {
    aarch64-linux = {
      arch = "arm64";
      hash = "sha256-Vt+HzLN9RqD2U3Szh5mKCKpz8SP9jADBE5yLTHvUOdU=";
    };
    x86_64-linux = {
      arch = "x64";
      hash = "sha256-Y80PBUfu9iu07OJ/p3m7+eK6hTHMaFQlaLqeeIONxoQ=";
    };
  };
  source = sources.${stdenv.hostPlatform.system};
  # T3 downloads chrome-headless-shell 156.0.8078.70 at runtime. Recheck its
  # ELF dependencies and the browser smoke fixture whenever the T3 pin changes.
  browserLibraries = [
    alsa-lib
    at-spi2-core
    dbus
    expat
    glib
    libgbm
    libgcc
    libx11
    libxcb
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxrandr
    libxkbcommon
    nspr
    nss
    udev
  ];
  browserLibraryVariable = "NIX_LD_LIBRARY_PATH_${
    lib.replaceStrings [ "-" ] [ "_" ] stdenv.hostPlatform.system
  }";
  browserLibraryPath = lib.makeLibraryPath browserLibraries;
  # Introducing a native override would hide generic paths set later by dev
  # shells inside T3 terminals. Extend only the variable nix-ld already uses.
  exportBrowserLibraries = ''
    if [[ -v ${browserLibraryVariable} ]]; then
      libraryVariable=${browserLibraryVariable}
    else
      libraryVariable=NIX_LD_LIBRARY_PATH
      : "''${NIX_LD_LIBRARY_PATH=/run/current-system/sw/share/nix-ld/lib}"
    fi
    case "''${!libraryVariable}" in
      ${browserLibraryPath} | ${browserLibraryPath}:*) ;;
      *) printf -v "$libraryVariable" %s "${browserLibraryPath}''${!libraryVariable:+:''${!libraryVariable}}" ;;
    esac
    export "$libraryVariable"
  '';
in
stdenv.mkDerivation {
  pname = "t3-cli";
  inherit version;

  src = fetchurl {
    url = "https://github.com/pingdotgg/t3code/releases/download/v${version}/t3-${version}-linux-${source.arch}.tar.gz";
    inherit (source) hash;
  };

  nativeBuildInputs = [
    autoPatchelfHook
    makeWrapper
  ];
  buildInputs = [ stdenv.cc.cc.lib ];
  dontBuild = true;
  dontStrip = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/t3" "$out/bin"
    cp -r . "$out/lib/t3/"
    # NixOS uses glibc; do not patch the bundled musl alternative against it.
    rm -r "$out/lib/t3/node_modules/@ff-labs/fff-bin-linux-${source.arch}-musl"
    # Leave the host's loader alone; pinning it could downgrade their glibc.
    makeWrapper "$out/lib/t3/t3" "$out/bin/t3" \
      --run ${lib.escapeShellArg exportBrowserLibraries}
    runHook postInstall
  '';

  # Grow RUNPATH before autoPatchelf changes the interpreter: the opposite order
  # corrupts LOAD segments with patchelf 0.19.2 (NixOS/patchelf#674). Remove once
  # nixpkgs includes upstream fix 59acc3d98b4961cfddf02090d9426ac735603218.
  preFixup = ''
    patchelf --set-rpath ${
      lib.makeLibraryPath [
        stdenv.cc.cc.lib
        libgcc
      ]
    } "$out/lib/t3/t3"
  '';

  doInstallCheck = stdenv.buildPlatform.canExecute stdenv.hostPlatform;
  nativeInstallCheckInputs = [ versionCheckHook ];
  versionCheckProgramArg = "--version";

  meta = {
    description = "Headless T3 Code server and command-line interface";
    homepage = "https://t3.codes";
    license = lib.licenses.mit;
    mainProgram = "t3";
    platforms = builtins.attrNames sources;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
