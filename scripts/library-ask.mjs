import { createFakeRuntime, createThebeAgent } from "../dist/index.js";

const provider = {
  listContainers: async () => [],
  inspectContainer: async () => {
    throw new Error("unused");
  },
  getContainerLogs: async () => {
    throw new Error("unused");
  },
  getStatusSummary: async () => {
    throw new Error("unused");
  },
};

const fake = createFakeRuntime();
fake.queueTurns([{ kind: "text", text: "pong" }]);

const thebe = createThebeAgent({
  runtime: fake.runtime,
  provider,
});

const reply = await thebe.ask("ping");
if (reply !== "pong") {
  throw new Error(`expected pong, got ${JSON.stringify(reply)}`);
}
console.log("LIBRARY_ASK_OK", reply, thebe.toolNames().join(","));
