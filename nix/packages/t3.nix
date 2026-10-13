{
  autoPatchelfHook,
  fetchurl,
  lib,
  stdenv,
  versionCheckHook,
}:
let
  version = "0.0.46-nightly.20261012.3021";
  sources = {
    aarch64-linux = {
      arch = "arm64";
      hash = "sha256-S3UXtJq8bnbYl+8aJxoeA7NSM9zHh84+gijNz62MzuQ=";
    };
    x86_64-linux = {
      arch = "x64";
      hash = "sha256-jNmKnxsOVzHvxfKZw/8PKLON+g8NitGueSmjQBIC6Ic=";
    };
  };
  source = sources.${stdenv.hostPlatform.system};
in
stdenv.mkDerivation {
  pname = "t3-cli";
  inherit version;

  src = fetchurl {
    url = "https://github.com/pingdotgg/t3code/releases/download/v${version}/t3-${version}-linux-${source.arch}.tar.gz";
    inherit (source) hash;
  };

  nativeBuildInputs = [ autoPatchelfHook ];
  buildInputs = [ stdenv.cc.cc.lib ];
  dontBuild = true;
  dontStrip = true;

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/t3" "$out/bin"
    cp -r . "$out/lib/t3/"
    # NixOS uses glibc; do not patch the bundled musl alternative against it.
    rm -r "$out/lib/t3/node_modules/@ff-labs/fff-bin-linux-${source.arch}-musl"
    # The executable resolves its native addons and web client beside itself.
    ln -s "$out/lib/t3/t3" "$out/bin/t3"
    runHook postInstall
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
