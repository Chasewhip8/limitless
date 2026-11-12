{
  pkgs,
  opencode,
  capsule,
}:
let
  inherit (pkgs) lib;
  arguments = lib.escapeShellArgs [
    (lib.getExe opencode)
    capsule.runtimeConfig
    pkgs.stdenv.hostPlatform.system
  ];
  runner = pkgs.writeShellApplication {
    name = "validate-opencode-capsule";
    text = ''
      exec ${lib.getExe capsule.node} --disable-warning=ExperimentalWarning \
        ${./validate-opencode-capsule.mjs} ${arguments} "$@"
    '';
  };
in
pkgs.runCommand "opencode-capsule-check" { meta.mainProgram = "validate-opencode-capsule"; } ''
  # Build sandboxes cannot create user namespaces or reach the Nix daemon; the
  # runner exercises managed Capsules and workspace placement on the host.
  ${lib.getExe runner} --without-namespaces
  mkdir -p "$out"
  ln -s ${runner}/bin "$out/bin"
''
