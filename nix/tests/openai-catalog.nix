{
  pkgs,
  opencode,
  limitless,
}:
pkgs.runCommand "openai-catalog-check" { } ''
  ${pkgs.lib.getExe pkgs.nodejs} ${./validate-openai-catalog.mjs} \
    ${pkgs.lib.getExe opencode} ${limitless} ${./fixtures/models-dev-openai.json}
  touch "$out"
''
