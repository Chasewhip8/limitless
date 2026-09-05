{ pkgs }:
let
  version = "0.0.0-dev-19134";
  sources = {
    x86_64-linux = {
      platform = "linux-x64";
      hash = "sha256-KzEf6/jB9O6eOL/1wHV4gDcNnUfG4tbdmNUzzRV3a+k=";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      hash = "sha256-50Z2Mk7GFeKuGRewteiRlJfIxGTpsPhpk2Jw2kA1XiE=";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
      hash = "sha256-83xotul+L4BM/tJuE5c/jhimjG5Kdd32qSaAbe024UE=";
    };
    x86_64-darwin = {
      platform = "darwin-x64";
      hash = "sha256-JEF0m6iN2yn1lc+FXNzXpc9fKS4odl2FZnmbxv49tH4=";
    };
  };
  source =
    sources.${pkgs.stdenv.hostPlatform.system}
      or (throw "OpenCode 2 is unsupported on ${pkgs.stdenv.hostPlatform.system}");
in
pkgs.stdenv.mkDerivation {
  pname = "opencode2";
  inherit version;

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@opencode-ai/cli-${source.platform}/-/cli-${source.platform}-${version}.tgz";
    inherit (source) hash;
  };
  sourceRoot = "package";

  nativeBuildInputs = [
    pkgs.makeWrapper
  ]
  ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
  buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.stdenv.cc.cc.lib ];

  dontBuild = true;
  dontStrip = true;

  installPhase = ''
    runHook preInstall

    install -Dm755 bin/opencode2 $out/bin/opencode2
    wrapProgram $out/bin/opencode2 --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ripgrep ]}

    runHook postInstall
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [ pkgs.versionCheckHook ];
  versionCheckProgramArg = "--version";

  meta = {
    description = "OpenCode 2 beta CLI";
    homepage = "https://opencode.ai";
    downloadPage = "https://www.npmjs.com/package/@opencode-ai/cli?activeTab=versions";
    license = pkgs.lib.licenses.mit;
    sourceProvenance = [ pkgs.lib.sourceTypes.binaryNativeCode ];
    mainProgram = "opencode2";
    platforms = builtins.attrNames sources;
  };
}
