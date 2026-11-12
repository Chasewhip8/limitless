{ pkgs, package }:
let
  inherit (pkgs) lib;
  arguments = lib.escapeShellArgs [
    (lib.getExe package)
    package.runtimeConfig
    "${pkgs.path}"
    pkgs.stdenv.hostPlatform.system
  ];
  runner = pkgs.writeShellApplication {
    name = "validate-capsule";
    text = ''
      exec ${lib.getExe package.node} ${./validate-capsule.mjs} ${arguments} "$@"
    '';
  };
in
pkgs.runCommand "limitless-capsule-check" { meta.mainProgram = "validate-capsule"; } ''
  if [ -n "$(find ${package.dependencies} -type d -path '*/node_modules/.bin' -print -quit)" ]; then
    echo "Capsule dependencies contain nondeterministic executable links" >&2
    exit 1
  fi
  test "$(readlink ${package}/share/capsule/runtime.json)" = ${package.runtimeConfig}
  grep -qF "CAPSULE_RUNTIME_CONFIG='${package.runtimeConfig}'" ${lib.getExe package}
  # GitHub credentials are runtime inputs; the store holds only the gh binary.
  if grep -qE 'GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR|GH_ENTERPRISE_TOKEN' ${lib.getExe package} ${package.runtimeConfig}; then
    echo "Capsule packaging must not configure GitHub credentials" >&2
    exit 1
  fi
  test "$(${lib.getExe pkgs.jq} -r .gh ${package.runtimeConfig})" = ${lib.getExe pkgs.gh}
  test "$(${lib.getExe pkgs.jq} -r .node ${package.runtimeConfig})" = ${lib.getExe package.node}
  # Build sandboxes cannot create user namespaces or reach the Nix daemon; the
  # runner exercises Bubblewrap and project environments on the host.
  ${lib.getExe runner} --without-namespaces
  mkdir -p "$out"
  ln -s ${runner}/bin "$out/bin"
''
