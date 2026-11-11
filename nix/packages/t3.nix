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
  vulkan-loader,
}:
let
  version = "0.1.8";
  sources = {
    aarch64-linux = {
      arch = "arm64";
      hash = "sha256-K/+/YI7vc2xcNeNDGn5SYdDJCeM9io/rg+8mo3R8+PQ=";
    };
    x86_64-linux = {
      arch = "x64";
      hash = "sha256-ucSdwAwj+7xZYb2v8tiOVW2WyNvWOMRQHik3xwZQqeU=";
    };
  };
  source = sources.${stdenv.hostPlatform.system};
  # T3 downloads chrome-headless-shell 157.0.8103.38 at runtime. Recheck its
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
  buildInputs = [
    stdenv.cc.cc.lib
    vulkan-loader
  ];
  dontBuild = true;
  dontStrip = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/t3" "$out/bin"
    cp -r . "$out/lib/t3/"
    # NixOS uses glibc; do not patch the bundled musl alternatives against it.
    rm -r \
      "$out/lib/t3/node_modules/@ff-labs/fff-bin-linux-${source.arch}-musl" \
      "$out/lib/t3/node_modules/@koromix/koffi-linux-${source.arch}/musl_${source.arch}"
    ${lib.optionalString stdenv.hostPlatform.isx86_64 ''
      rm -r "$out/lib/t3/node_modules/@yuuang/ffi-rs-linux-x64-musl"
    ''}
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
