{ pkgs }:
let
  inherit (pkgs) lib;
  evaluate =
    settings: extra:
    lib.evalModules {
      modules = [
        ../modules/darwin.nix
        {
          options = {
            assertions = lib.mkOption {
              type = lib.types.listOf lib.types.attrs;
              default = [ ];
            };
            homebrew = {
              enable = lib.mkOption {
                type = lib.types.bool;
                default = false;
              };
              casks = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
              };
            };
          };
        }
        { programs.limitless = settings; }
        extra
      ];
    };
  clients = {
    opencode = "opencode-desktop";
    t3 = "t3-code";
  };
  settings = lib.mapAttrs (_: _: { desktop.enable = true; }) clients;
  defaults = (evaluate { } { }).config;
  all = (evaluate settings { homebrew.casks = [ "existing-app" ]; }).config;
  disabledHomebrew = (evaluate settings { homebrew.enable = false; }).config;
  valid = config: lib.all (entry: entry.assertion) config.assertions;
in
assert lib.assertMsg (
  !defaults.homebrew.enable && defaults.homebrew.casks == [ ] && valid defaults
) "Desktop casks must be opt-in";
assert lib.assertMsg (
  all.homebrew.enable
  && valid all
  &&
    lib.sort builtins.lessThan all.homebrew.casks == [
      "existing-app"
      "opencode-desktop"
      "t3-code"
    ]
) "Desktop flags must add the stable casks and preserve existing applications";
assert lib.assertMsg (lib.all (
  name:
  let
    inherit (evaluate { ${name}.desktop.enable = true; } { }) config;
  in
  valid config && config.homebrew.enable && config.homebrew.casks == [ clients.${name} ]
) (builtins.attrNames clients)) "Each desktop flag must install only its own cask";
assert lib.assertMsg (
  !valid disabledHomebrew
) "Explicitly disabled Homebrew must reject enabled desktops";
pkgs.runCommand "limitless-darwin-desktops-check" { } ''
  touch "$out"
''
