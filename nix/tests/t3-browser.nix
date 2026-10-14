{ pkgs, package }:
let
  inherit (pkgs) lib;
  system = pkgs.stdenv.hostPlatform.system;
  # These archives must match apps/server/src/preview/PreviewBrowser.ts in T3.
  version = "154.0.8037.92";
  source =
    {
      x86_64-linux = {
        platform = "linux64";
        sha256 = "636aa5c79f2693632e9921b8bbb050038ba11672e02346c06c20f991aed096f9";
      };
      aarch64-linux = {
        platform = "linux-arm64";
        sha256 = "0ed0e47d9e9f639197f508d62ada09e5c6b4c4c60edab3160a9312a733091df6";
      };
    }
    .${system};
  archive = pkgs.fetchurl {
    url = "https://storage.googleapis.com/chrome-for-testing-public/${version}/${source.platform}/chrome-headless-shell-${source.platform}.zip";
    inherit (source) sha256;
  };
  browser = pkgs.runCommand "t3-browser-fixture-${version}" { nativeBuildInputs = [ pkgs.unzip ]; } ''
    mkdir -p "$out"
    unzip -q ${archive} -d "$out"
  '';
  arguments = lib.escapeShellArgs [
    (toString package)
    "${browser}/chrome-headless-shell-${source.platform}/chrome-headless-shell"
    system
    (lib.getExe pkgs.strace)
    pkgs.stdenv.cc.bintools.dynamicLinker
    version
  ];
  runner = pkgs.writeShellApplication {
    name = "validate-t3-browser";
    text = ''
      exec ${lib.getExe pkgs.nodejs} ${./validate-t3-browser.mjs} ${arguments} "$@"
    '';
  };
in
pkgs.runCommand "limitless-t3-browser-check" { meta.mainProgram = "validate-t3-browser"; } ''
  # Fail a T3 upgrade that leaves this fixture testing a different browser pin.
  grep -qaF ${lib.escapeShellArg version} ${package}/lib/t3/t3
  grep -qaF ${lib.escapeShellArg source.sha256} ${package}/lib/t3/t3
  # Build sandboxes lack the host's /lib*/nix-ld interpreter and user-namespace
  # setup. Check the wrapper and loader here; the runner tests that host boundary.
  ${lib.getExe runner} --loader-only
  mkdir -p "$out"
  ln -s ${runner}/bin "$out/bin"
''
