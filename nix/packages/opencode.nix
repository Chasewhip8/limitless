{ pkgs }:
let
  version = "2.0.19";
  sources = {
    x86_64-linux = {
      platform = "linux-x64";
      hash = "sha256-EEHlpqy0slgXQGTZleo3XTv6qCFSrtPAlgiU5ljWJ+8=";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      hash = "sha256-/ShmzYVNwVBY7Q/mwxpmU90S7+uWZAA6mic58/zz/SE=";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
      hash = "sha256-uA7T4+KFZE6bPT5PGc8QTDotV7qOyEAfkyXRUyBrgiU=";
    };
    x86_64-darwin = {
      platform = "darwin-x64";
      hash = "sha256-6KiScjoiJjCZ4L6/lf3y3/Bg7Kore6HKwdbOQ2x+R40=";
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
