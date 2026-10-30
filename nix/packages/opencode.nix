{ pkgs }:
let
  version = "2.1.4";
  sources = {
    x86_64-linux = {
      platform = "linux-x64";
      hash = "sha256-zgWr4tzhBBORyOyM242gZvZA/UcecqyEbcsInEQeEeE=";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      hash = "sha256-6ay04jqaxDITlpOqFmRVpq3YlGUzOUy+CDRZpI54iGE=";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
      hash = "sha256-2qL+BPJ4hQkNzK7tng1lFLyAp4ScywqdlFIbODhRv6U=";
    };
    x86_64-darwin = {
      platform = "darwin-x64";
      hash = "sha256-WGd/nKsM+680Cn7r9DQDUYO/Hab7ajpBNERKMgbWs/4=";
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
  # `opencode --version` creates its log directory under HOME. The Darwin sandbox
  # sets HOME to the read-only /var/empty, and the hook otherwise scrubs the
  # environment, so supply a writable HOME explicitly.
  preInstallCheck = ''
    export HOME="$(mktemp -d)"
  '';
  versionCheckKeepEnvironment = [ "HOME" ];
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
