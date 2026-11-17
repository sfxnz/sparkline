# Alert notifications are the console's one outbound connection

Sparkline is LAN-only. Both services refuse to bind a public address, the browser's Content-Security-Policy allows connections to the console alone, and the LLM benchmarks refuse endpoints outside the LAN. Until now the console connected only to its own agents. Alert notifications break that on purpose: an alert that only shows in an open browser tab does not tell the owner that a node died overnight, and ntfy.sh, Discord and Slack are on the internet.

So the console may connect to a host that is not an agent, under these rules. `server/sparkline/console/egress.py` is the only code that does it, and `server/tests/test_console_egress.py` holds the console to each rule.

## The rules

- **Only hosts the operator wrote in `console.toml`.** Channels are `[[notify]]` tables. No API route and no web form can add or change one, so signing in to the console never lets anyone point it at a new host. With no `[[notify]]` table the console builds no sender and opens no such connection.
- **The console connects to the address it checked.** For every send it resolves the name, checks every address in the answer, and connects to a checked address by IP. The name goes in the `Host` header and in the TLS handshake, so the certificate is still verified against the name. No connection is kept between sends, so no send uses an address checked earlier. This closes DNS rebinding, where a name answers with a harmless address for the check and another one for the connection.
- **`http://` only to private addresses.** If any address in the answer is public, the send is refused whole. `https://` may reach any address, because the certificate check is what makes a public address safe.
- **No redirect is followed.** A 3xx answer is a failed delivery. A redirect would send the alert to a host the operator did not write down.
- **No proxy from the environment.** `HTTPS_PROXY` would make the console connect somewhere other than the checked address.
- **The url and the token are credentials.** A Discord or Slack webhook URL is its own password, and so is an ntfy topic. They are `SecretStr` in the config model and only `egress.py` unwraps them. A delivery outcome is one word from a closed list (`NotifyFailure`) plus an HTTP status, so no error text, response body or URL has a field to travel in. The API returns a channel's name, kind and host. While a send is in flight the HTTP library's debug log of the service's answer is switched off, because a redirect's `Location` can repeat the url. A test in `test_console_egress.py` fails when `get_secret_value` appears in any other file.

## Considered options

- **A channel editor in the web app.** It would store webhook URLs in `console.sqlite`, which the console treats as less private than `console.toml`, and it would let anyone with the console token aim the console at a host of their choice. The file is the boundary.
- **`httpx.AsyncClient` with a check before the request.** The client resolves the name itself after the check, so it cannot pin the address. It also logs every request URL at INFO, which would write a Discord token to the journal.
- **Apprise.** One dependency covers over 100 services. It sends through its own HTTP stack, where the console cannot pin the address or keep the URL out of a log, and `server/requirements.lock` is hash-pinned and kept small. Four kinds written against `Egress` cover ntfy, Discord, Slack and anything that takes a JSON webhook.
- **A stored queue of notices.** After a restart the alert engine starts empty and fires again whatever still holds, so a stored queue would mostly deliver stale duplicates.

## What this does not cover

Nothing notifies when the console itself is down. A start-up message and a dead-man's switch were left out. Networks that need an HTTP proxy to reach the internet cannot deliver, because a proxy breaks address pinning.
