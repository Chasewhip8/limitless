{
  pkgs,
  self,
  system,
}:
let
  version = "0.4.13";
  binaryName =
    {
      x86_64-linux = "effect-solutions-linux-x64";
      aarch64-linux = "effect-solutions-linux-arm64";
      x86_64-darwin = "effect-solutions-darwin-x64";
      aarch64-darwin = "effect-solutions-darwin-arm64";
    }
    .${system} or (throw "Unsupported system for effect-solutions: ${system}");
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "effect-solutions";
  inherit version;

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/effect-solutions/-/effect-solutions-${version}.tgz";
    hash = "sha256-6zfIFaSgrQz0VMg117OtOq7Mgxqs0UD6S2Cd6/QAxhA=";
  };

  dontUnpack = true;

  installPhase = ''
    tmpdir=$(mktemp -d)
    mkdir -p "$out/bin" "$out/share/skills"
    ${pkgs.gnutar}/bin/tar -xzf "$src" -C "$tmpdir"
    install -m755 "$tmpdir/package/dist/${binaryName}" "$out/bin/effect-solutions"
    cp -r ${self}/nix/skills/effect-patterns "$out/share/skills/effect-patterns"
  '';

  meta = with pkgs.lib; {
    description = "Docs and helper CLI for Effect TypeScript best practices";
    homepage = "https://github.com/kitlangton/effect-solutions";
    license = licenses.mit;
    mainProgram = "effect-solutions";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
}
