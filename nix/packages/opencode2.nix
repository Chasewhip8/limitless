{ pkgs }:
let
  version = "2.0.5";
  sources = {
    x86_64-linux = {
      platform = "linux-x64";
      hash = "sha256-k9SpjmJzSXBXls4LdZw83oBctIxeIQ1WMsLt689cTTA=";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      hash = "sha256-hZFVwuiIkdfKCCrVEmLPf9S3mBn4qktGQ5pYJFrulOg=";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
      hash = "sha256-ZevVkknFMAmPvfT7fbYlatZxU9Th49kMblBi/XEBzVY=";
    };
    x86_64-darwin = {
      platform = "darwin-x64";
      hash = "sha256-ZBXUpeE1bkpCYt1M/L9L7CxKEx0RckIUE+WWRAIVJuI=";
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

    install -Dm755 bin/opencode $out/bin/opencode2
    wrapProgram $out/bin/opencode2 --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ripgrep ]}

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
    mainProgram = "opencode2";
    platforms = builtins.attrNames sources;
  };
}
