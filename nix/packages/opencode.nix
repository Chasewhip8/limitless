{ pkgs }:
let
  version = "2.0.29";
  sources = {
    x86_64-linux = {
      platform = "linux-x64";
      hash = "sha256-FLWmY4oaCTrJ1IRZnIRLEMKbRF0EhEtoLMxmjOJlMKI=";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      hash = "sha256-CvOeddvfrMIPj1Me81+03MC0TAgIQgNRhhQnLyMig64=";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
      hash = "sha256-5PeaFufm/9fx4EB+EPV2hbudvGcO0rwlxbjdoU9pLhU=";
    };
    x86_64-darwin = {
      platform = "darwin-x64";
      hash = "sha256-sLmQ86KPn353cUahl/QlV17q+2cZGzsV8hWS11tYMK0=";
    };
  };
  source =
    sources.${pkgs.stdenv.hostPlatform.system}
      or (throw "OpenCode 2 is unsupported on ${pkgs.stdenv.hostPlatform.system}");
in
pkgs.stdenv.mkDerivation {
  pname = "opencode";
  inherit version;

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@opencode/cli-${source.platform}/-/cli-${source.platform}-${version}.tgz";
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

    install -Dm755 bin/opencode $out/bin/opencode
    wrapProgram $out/bin/opencode --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ripgrep ]}

    runHook postInstall
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [ pkgs.versionCheckHook ];
  versionCheckProgramArg = "--version";

  meta = {
    description = "OpenCode 2 CLI";
    homepage = "https://opencode.ai";
    downloadPage = "https://www.npmjs.com/package/@opencode/cli?activeTab=versions";
    license = pkgs.lib.licenses.mit;
    sourceProvenance = [ pkgs.lib.sourceTypes.binaryNativeCode ];
    mainProgram = "opencode";
    platforms = builtins.attrNames sources;
  };
}
