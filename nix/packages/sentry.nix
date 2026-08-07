{
  pkgs,
  self,
}:
let
  version = "0.41.0";
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "sentry";
  inherit version;

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/sentry/-/sentry-${version}.tgz";
    hash = "sha256-h6yET2skRoEd52SyhdRLgEoyXE1sIiW9mvVUEI72qRQ=";
  };

  nativeBuildInputs = [
    pkgs.gnutar
    pkgs.makeWrapper
  ];

  dontUnpack = true;

  installPhase = ''
    package_dir="$TMPDIR/sentry-package"
    mkdir -p "$package_dir" "$out/bin" "$out/lib/sentry" "$out/share/doc/sentry" "$out/share/skills"
    tar -xzf "$src" -C "$package_dir"
    cp -r "$package_dir/package"/. "$out/lib/sentry/"
    install -m644 ${self}/nix/packages/sentry-scrub-child-env.cjs "$out/lib/sentry/scrub-child-env.cjs"

    makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/sentry" \
      --add-flags "--require" \
      --add-flags "$out/lib/sentry/scrub-child-env.cjs" \
      --add-flags "$out/lib/sentry/dist/bin.cjs"

    cp -r ${self}/nix/skills/sentry-cli "$out/share/skills/sentry-cli"

    install -m644 "$out/lib/sentry/LICENSE.md" "$out/share/doc/sentry/LICENSE.md"
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    export SENTRY_CONFIG_DIR="$TMPDIR/sentry-config"
    mkdir -p "$SENTRY_CONFIG_DIR"

    version_output="$(
      SENTRY_CLI_NO_TELEMETRY=1 \
      SENTRY_CLI_NO_UPDATE_CHECK=1 \
      "$out/bin/sentry" --version
    )"

    case "$version_output" in
      *"${version}"*) ;;
      *)
        printf 'Unexpected Sentry CLI version: %s\n' "$version_output" >&2
        exit 1
        ;;
    esac

    SENTRY_AUTH_TOKEN=install-check-token \
      ${pkgs.nodejs_22}/bin/node \
      --require "$out/lib/sentry/scrub-child-env.cjs" \
      -e '
        const { execFileSync } = require("node:child_process")
        if (process.env.SENTRY_AUTH_TOKEN !== "install-check-token") process.exit(1)
        const childToken = execFileSync(
          process.execPath,
          ["-p", "process.env.SENTRY_AUTH_TOKEN || String()"],
          { encoding: "utf8" },
        ).trim()
        if (childToken !== "") process.exit(1)
      '
  '';

  meta = with pkgs.lib; {
    description = "Agent-friendly command-line interface for Sentry";
    homepage = "https://cli.sentry.dev";
    license = licenses.fsl11Asl20;
    mainProgram = "sentry";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
}
