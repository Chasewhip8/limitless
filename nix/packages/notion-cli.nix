{
  pkgs,
  self,
  system,
}:
let
  version = "0.22.11";
  sources = {
    x86_64-linux = {
      target = "x86_64-unknown-linux-musl";
      sha256 = "05fdbd24da2c34a0d1843e26b1c3dd51628b7ebd790630f4d8e5a6ef0076481a";
    };
    aarch64-linux = {
      target = "aarch64-unknown-linux-musl";
      sha256 = "ba532e57011a03bd43eb3077a53c3581c8ad5fc73d96ff16aa406c7252d6e69d";
    };
    x86_64-darwin = {
      target = "x86_64-apple-darwin";
      sha256 = "edfb67c02a15b44d2023107ae5e123c208a6b69acd0e5a1f270db572d1a19544";
    };
    aarch64-darwin = {
      target = "aarch64-apple-darwin";
      sha256 = "c2419042c3a0c8111e8b4f84a4b5f7d75bf5a8558ec9b2d6b87f611037e1b1ba";
    };
  };
  source = sources.${system} or (throw "Unsupported system for Notion CLI: ${system}");
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "notion-cli";
  inherit version;

  src = pkgs.fetchurl {
    url = "https://ntn.dev/releases/v${version}/ntn-${source.target}.tar.gz";
    inherit (source) sha256;
  };

  nativeBuildInputs = [ pkgs.gnutar ];

  dontUnpack = true;

  installPhase = ''
    package_dir="$TMPDIR/ntn-${source.target}"
    mkdir -p "$out/bin" "$out/share/doc/notion-cli" "$out/share/skills"
    tar -xzf "$src" -C "$TMPDIR"
    install -m755 "$package_dir/ntn" "$out/bin/ntn"
    install -m644 "$package_dir/LICENSE.md" "$out/share/doc/notion-cli/LICENSE.md"
    install -m644 "$package_dir/README.md" "$out/share/doc/notion-cli/README.md"
    cp -r ${self}/nix/skills/notion-cli "$out/share/skills/notion-cli"
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    version_output="$($out/bin/ntn --version)"
    if [ "$version_output" != "ntn ${version}" ]; then
      printf 'Unexpected Notion CLI version: %s\n' "$version_output" >&2
      exit 1
    fi

    $out/bin/ntn pages get --help | grep -F 'Retrieve a page as Markdown' >/dev/null
  '';

  meta = with pkgs.lib; {
    description = "Official command-line interface for Notion";
    homepage = "https://developers.notion.com/cli/get-started/overview";
    license = licenses.mit;
    mainProgram = "ntn";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
}
