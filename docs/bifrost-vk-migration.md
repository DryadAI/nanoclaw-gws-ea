# Nanoclaw Bifrost identity migration

The proxy can send a scoped Bifrost virtual key in `x-bf-vk`. Set
`BIFROST_VIRTUAL_KEY` only through the existing secret delivery path for the
host service. `BIFROST_API_KEY`, if still needed during a transition, remains
in `Authorization`. Never put either value in this repository, a shell command
line, or a container agent environment. This PR does not create a key or change
the running systemd unit.

The default gateway URL now names the existing HTTPS Caddy entry. An explicit
`BIFROST_URL` still overrides it; the current deployed unit has that override,
so an operator must migrate the unit separately. The model remains whatever
`BIFROST_MODEL` selects (`vllm/kimi-k2.6` in the observed unit). An Ollama-only
DRUID pilot key cannot authorize that model.

Before changing the unit, issue a dedicated key for the actual model/provider,
prove that this installed Bifrost build accepts the selected authentication
headers, test one bounded inference request and the wrong-model denial, then
switch the URL and credential together. Confirm old and new endpoint behavior
and keep a rollback path. Gateway-wide authentication and port binding are
separate changes tracked in DryadAI/dryad-tracker#445.
# Local-only pilot update

The proxy now permits only `ollama/qwen3.5:2b`, requires
`BIFROST_VIRTUAL_KEY`, and refuses any HTTP bearer (including the legacy
shared master key). The old
`vllm/kimi-k2.6` launcher default is removed. An existing systemd unit that
still sets the paid model will fail closed **after** a code deployment; update
the unit and install a scoped VK before restarting it. This repository change
does not modify the running unit or gateway configuration.
