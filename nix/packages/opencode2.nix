{ pkgs }:
let
  version = "2.0.2";
  sources = {
    x86_64-linux = {
      platform = "linux-x64";
      hash = "sha256-xwftn/GsI1bINgP0ACeZhV01dh/A8QM2q4ud9WbNRGc=";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      hash = "sha256-RutVLJu7bP1NlXlNUo0HvsAoye6w9gFIurl6sjQLP7Y=";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
      hash = "sha256-xSUttUpCUgGbFRVEbPFdJDrOiS/jX/cTqcjvK2olDzk=";
    };
    x86_64-darwin = {
      platform = "darwin-x64";
      hash = "sha256-4rWxz2Pca1npBp+5+N8Pk7orSG3VcnpdrXqbQj5rejk=";
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
