{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.limitless;
  enabled = cfg.enable && cfg.desktop.enable;
  isLinux = pkgs.stdenv.hostPlatform.isLinux;
  desktopPackage = import ../packages/opencode-desktop.nix {
    inherit pkgs;
    opencode = cfg._generated.opencodePackage;
  };
  runtimeVersion = lib.getVersion cfg.opencode.package;
in
{
  options.programs.limitless.desktop.enable =
    lib.mkEnableOption "the OpenCode desktop app on Limitless's OpenCode runtime (Linux only)";

  config = lib.mkIf enabled (
    lib.mkMerge [
      {
        assertions = [
          {
            assertion = isLinux;
            message = "programs.limitless.desktop requires Linux.";
          }
        ];
      }
      (lib.mkIf isLinux {
        assertions = [
          {
            assertion = runtimeVersion == desktopPackage.version;
            message = "programs.limitless.desktop packages OpenCode Desktop ${desktopPackage.version}, but opencode.package is ${runtimeVersion}. The desktop app replaces background services of any other version.";
          }
        ];
        home.packages = [ desktopPackage ];
      })
    ]
  );
}
