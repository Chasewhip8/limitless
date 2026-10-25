{ pkgs, source }:
# opencode-paseo and the `paseo` plugin reimplement Paseo's OpenCode V2
# integration against Paseo internals that carry no version. When the Paseo
# input changes any of these files, review the listed assumptions, then record
# the new hash.
let
  agent = "packages/server/src/server/agent";
  reviewed = {
    "${agent}/providers/opencode/v2/bridge-plugin.mjs" = {
      sha256 = "68611ef23db20bbb194882170cad15aadcf0e7749769251e46004837af5d7e9c";
      review = "paseo/plugin.ts mirrors this plugin: tool names, binding walk, content mapping";
    };
    "${agent}/providers/opencode/bridge.ts" = {
      sha256 = "2287e65dee997c4abd7c6a0ed27573b1e4cf5c5d43881be0d64dfcd04b23e1eb";
      review = "paseo/tool-bridge.ts speaks /_internal/opencode; registration.ts parses the plugin entry";
    };
    "${agent}/providers/opencode/v2/readiness.ts" = {
      sha256 = "5c0eeb88c4f71522a8a249e3227940728137d0f2903198c2af6143fa53cf94ed";
      review = "the managed service must still pass Paseo's plugin readiness check";
    };
    "${agent}/providers/opencode/v2/runtime.ts" = {
      sha256 = "797a2b74a8df3ae0403bf8c7e45f4731669080bca06722c12ce85505bfbfd52a";
      review = "opencode-paseo's serve contract: arguments, environment, listening line, shutdown";
    };
    "${agent}/providers/opencode/v2/agent.ts" = {
      sha256 = "7a9f696a0e568b4695ef9b30592f8d86a3e82fd2c92e948b4115ed82751ed21e";
      review = "paseo/rewrites.ts: session creation defaults and permissions";
    };
    "${agent}/providers/opencode/v2/session.ts" = {
      sha256 = "644b52e5554fc2d29443cbbae189d203124dd0b6d2f10d0f4c220041859577e3";
      review = "requests through the bridge: environment, instructions, MCP registration, close";
    };
    "${agent}/providers/opencode/v2/configuration.ts" = {
      sha256 = "92d6a02ecedcf327285a1f99c5f2d3fb931e11c4fa0107f8c277fbe1323c7643";
      review = "session permission rules the bridge drops; dedicated-server triggers";
    };
    "${agent}/tools/paseo-tools.ts" = {
      sha256 = "4801b6d4f63793ceccceeca38edbde39d0d733e659c52a5045f4935b87a68760";
      review = "the tool catalog: unit's allowlist and support agents' denial in opencode/agents";
    };
    "packages/server/src/server/persisted-config.ts" = {
      sha256 = "8b05b353adcbe97ea2f7eb9d9621ae15a6b5f632e8d270385f907b0e97a669a5";
      review = "nix/packages/paseo-settings.mjs: the managed keys, version and strict sections";
    };
    "packages/protocol/src/provider-config.ts" = {
      sha256 = "15ec7e73cdb9f1129700cca5e77ec0934a364b64849d546185ea950665ef08d4";
      review = "nix/packages/paseo-settings.mjs: the OpenCode provider's command shape";
    };
    "packages/server/src/server/pid-lock.ts" = {
      sha256 = "0760bb070fb44b0e0b5041cde45a9d4b2bf9cc5b8d4d6aceded9508693e41f04";
      review = "nix/packages/paseo-settings.mjs: the paseo.pid format and its boot check";
    };
  };
in
pkgs.runCommand "limitless-paseo-protocol-check" { } ''
  failed=0
  ${pkgs.lib.concatStringsSep "\n" (
    pkgs.lib.mapAttrsToList (path: expected: ''
      actual="$(sha256sum ${source}/${path} | cut -d' ' -f1)"
      if [ "$actual" != ${expected.sha256} ]; then
        echo "Paseo changed ${path} ($actual): review ${expected.review}" >&2
        failed=1
      fi
    '') reviewed
  )}
  [ "$failed" = 0 ]
  touch "$out"
''
