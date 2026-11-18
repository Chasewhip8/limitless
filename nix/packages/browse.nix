{
  fetchurl,
  lib,
  makeWrapper,
  stdenv,
  versionCheckHook,
}:
let
  version = "0.1.5";
  # Linux uses the static musl builds, which need no ELF patching. The macOS
  # builds keep Anomaly's code signature, so they are installed unmodified.
  targets = {
    x86_64-linux = {
      target = "linux-x64-musl";
      hash = "sha256-R7NP2YkSwJco1The86pxL4b1/j3+6G6tOO1kWinZXRk=";
    };
    aarch64-linux = {
      target = "linux-arm64-musl";
      hash = "sha256-l/f5WijB0OirZCx4uNYQqxEtgFim+93zYFY2jXCrMyg=";
    };
    x86_64-darwin = {
      target = "darwin-x64";
      hash = "sha256-/PiaQKnbNIYY7cqRT+hLooS0jH7PWCmeF0gFYHJjtYk=";
    };
    aarch64-darwin = {
      target = "darwin-arm64";
      hash = "sha256-1jsw2bidBQcKMxDS2AQ14Gq5zDUha4AazGj5aeFCAr8=";
    };
  };
  source = targets.${stdenv.hostPlatform.system};
in
stdenv.mkDerivation {
  pname = "browse";
  inherit version;

  src = fetchurl {
    url = "https://registry.npmjs.org/@opencode/browse-${source.target}/-/browse-${source.target}-${version}.tgz";
    inherit (source) hash;
  };

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;
  dontStrip = true;

  # Nix owns the version, so self-updates stay off. The relay inherits this
  # variable from whichever browse command starts it.
  installPhase = ''
    runHook preInstall
    install -Dm755 bin/browse "$out/libexec/browse/browse"
    install -Dm644 LICENSE "$out/share/licenses/browse/LICENSE"
    makeWrapper "$out/libexec/browse/browse" "$out/bin/browse" \
      --set-default OPENCODE_BROWSER_AUTO_UPDATE off
    runHook postInstall
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [ versionCheckHook ];
  versionCheckProgramArg = "--version";

  meta = {
    description = "MCP server and relay that let agents drive a browser through the browse extension";
    homepage = "https://opencode.ai/product/browse";
    downloadPage = "https://www.npmjs.com/package/@opencode/browse?activeTab=versions";
    license = lib.licenses.mit;
    mainProgram = "browse";
    platforms = builtins.attrNames targets;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
