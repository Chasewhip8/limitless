{ pkgs }:
let
  version = "1.4.4";
  sources = {
    x86_64-linux = {
      platform = "linux-x64";
      hash = "sha256-k8paKr5F87ysbdVbr/i7BsSsgktw+JZQtU5ci4Db7xg=";
    };
    aarch64-linux = {
      platform = "linux-aarch64";
      hash = "sha256-q5Xn5pKlPSWhuqmO45Whf18mSu37PLFYEUMtVBQvcOs=";
    };
    aarch64-darwin = {
      platform = "darwin-aarch64";
      hash = "sha256-vl8X1jbWmbLqosGorIAsh/CBXMtf4my+Y9I5U1SuXQ0=";
    };
    x86_64-darwin = {
      platform = "darwin-x64";
      hash = "sha256-sm3lY57cb3++mcbc+AFuqnXFuGzM/oPbMKoEu+rej34=";
    };
  };
  source = sources.${pkgs.stdenv.hostPlatform.system};
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "opencode-build-bun";
  inherit version;
  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@oven/bun-${source.platform}/-/bun-${source.platform}-${version}.tgz";
    inherit (source) hash;
  };
  sourceRoot = "package";
  nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
  buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.stdenv.cc.cc.lib ];
  dontBuild = true;
  dontStrip = true;
  installPhase = ''
    runHook preInstall
    install -Dm755 bin/bun "$out/bin/bun"
    ln -s bun "$out/bin/bunx"
    runHook postInstall
  '';
  meta.platforms = builtins.attrNames sources;
}
