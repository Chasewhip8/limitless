{ self }:
{ config, lib, ... }:
{
  imports = [
    (import ./opencode.nix { inherit self; })
    ./service.nix
    ./lsp.nix
    ./mcp.nix
  ];

  options.programs.limitless = {
    enable = lib.mkEnableOption "the Limitless OpenCode workspace";
    git.ignoreStorage = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Add .limitless/ to Git's global ignore file through Home Manager.";
    };
  };

  config =
    lib.mkIf (config.programs.limitless.enable && config.programs.limitless.git.ignoreStorage)
      {
        programs.git = {
          enable = lib.mkDefault true;
          ignores = [ ".limitless/" ];
        };
      };
}
