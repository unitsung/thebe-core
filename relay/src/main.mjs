import { createApnsClient } from "./apns.mjs";
import { createRelay } from "./relay.mjs";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required. See relay/README.md.`);
    process.exit(1);
  }
  return value;
};

const apns = createApnsClient({
  keyFile: required("APNS_KEY_FILE"),
  keyId: required("APNS_KEY_ID"),
  teamId: required("APNS_TEAM_ID"),
  topic: process.env.APNS_TOPIC?.trim() || "com.unitsung.thebe",
});
const relay = createRelay({
  dataDir: process.env.RELAY_DATA_DIR?.trim() || "./data",
  apns,
});
const port = Number(process.env.RELAY_PORT ?? 8788);
relay.server.listen(port, "127.0.0.1", () => {
  console.log(
    `Thebe Push Relay listening on 127.0.0.1:${port}. Put TLS in front of it.`
  );
});
