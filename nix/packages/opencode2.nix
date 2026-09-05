{ pkgs }:
let
  version = "0.0.0-beta-19124";
  sources = {
    x86_64-linux = {
      platform = "linux-x64";
      hash = "sha256-QupPYnchJeRZlHkZusA4/stLb3S1u+wMMwZlh1BiJj4=";
    };
    aarch64-linux = {
      platform = "linux-arm64";
      hash = "sha256-3hgsOM+HQqIPmNgCmjyYZ4RJi+dNITjXb9/e9NmAj/U=";
    };
    aarch64-darwin = {
      platform = "darwin-arm64";
      hash = "sha256-gUcbaXLipWPUdxwBvkCiEA9rX+xZ4jDsPfKrqa+3Ih8=";
    };
    x86_64-darwin = {
      platform = "darwin-x64";
      hash = "sha256-g2rZN8fqv3rDTXa7hnSq/WdaiLnW3217abAyGeVET9Q=";
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
