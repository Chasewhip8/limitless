{ pkgs, package }:
let
  inherit (pkgs) lib;
  system = pkgs.stdenv.hostPlatform.system;
  # These archives must match apps/server/src/preview/PreviewBrowser.ts in T3.
  version = "157.0.8103.38";
  source =
    {
      x86_64-linux = {
        platform = "linux64";
        sha256 = "deafffa74660b34853a4119c361fd427ac8c9fcb62db51ddb8a797cd83a4ba2d";
      };
      aarch64-linux = {
        platform = "linux-arm64";
        sha256 = "b9b910a57b2a15eb3e55000a2339f93a973934a413ebfc6e585a50ec6c42fd6c";
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
