# Thebe Push Relay

An optional, separately deployed service. It holds the APNs credentials so a self-hosted Thebe Core does not have to. It has no dependencies; it needs Node 22 or newer.

## How it works

1. The App registers its APNs token with the relay together with the public key of the Core it trusts (`POST /v1/registrations`). The relay returns a `relayDeviceId`.
2. Core signs each event with its Ed25519 key and sends it (`POST /v1/events`). The relay checks the signature against the key registered for that device, drops stale (over 5 minutes), repeated and over-rate (30 per minute) events, and sends the alert to APNs over HTTP/2.
3. An event holds a short generic line, a category and a `thebe://` deep link. Nothing else reaches Apple.
4. A token APNs reports as gone (410, `Unregistered`, `BadDeviceToken`) is dropped.

## Configuration

| Variable         | Meaning                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `APNS_KEY_FILE`  | Path to the `.p8` key from the Apple Developer account (Keys, with Apple Push Notifications service enabled) |
| `APNS_KEY_ID`    | The key's 10-character ID                                                                                    |
| `APNS_TEAM_ID`   | The team ID (`5PY7FY4MQK`)                                                                                   |
| `APNS_TOPIC`     | The bundle ID, default `com.unitsung.thebe`                                                                  |
| `RELAY_DATA_DIR` | Where registrations are kept, default `./data`                                                               |
| `RELAY_PORT`     | Port on `127.0.0.1`, default 8788                                                                            |

The relay listens on loopback only. Put TLS in front of it (Tailscale Serve, Caddy, a reverse proxy) and give that HTTPS address to Core as `THEBE_PUSH_RELAY_URL`. The App only accepts an `https` relay address (or localhost for testing).

```bash
APNS_KEY_FILE=/secrets/AuthKey_ABC123DEFG.p8 APNS_KEY_ID=ABC123DEFG APNS_TEAM_ID=5PY7FY4MQK npm start
```

## Tests

```bash
npm test
```

The tests run the relay against a local HTTP/2 server that stands in for APNs. Real delivery needs the APNs key and a device build that carries the Push entitlement; it has not been tried.
