# Limitless Anthropic authentication

Private OpenCode V2 port of
[`ex-machina-co/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth)
at commit `1488bd85abb51ce3e71333ba391c4aa65d6ef0e7`. The upstream MIT license is
preserved in this directory.

This port uses OpenCode's native Anthropic protocol and V2 Effect plugin APIs. It intentionally
supports only Claude Pro/Max OAuth, keeps OpenCode's existing key and environment methods, stores
namespaced Max metadata, and omits the V1 create-key flow. It also uses only the configured native
`providers.anthropic.settings.baseURL`; the upstream base-URL environment override and insecure TLS
mode are intentionally absent.

Unmarked OAuth credentials, including credentials from the earlier experimental Limitless
integration, are blocked rather than sent through standard Anthropic key routing. Reconnect Max once
after upgrading so OpenCode replaces the legacy credential with this package's namespaced marker.

Using consumer OAuth credentials outside Anthropic's official clients may violate Anthropic's terms
or policies. Users are responsible for reviewing the applicable terms and accepting that risk.
