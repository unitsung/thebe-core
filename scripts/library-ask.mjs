import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { createThebeAgent } from "../dist/index.js";

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

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("pong")]);

const thebe = createThebeAgent({
  models,
  model: faux.getModel(),
  streamFn: models.streamSimple.bind(models),
  provider,
});

const reply = await thebe.ask("ping");
if (reply !== "pong") {
  throw new Error(`expected pong, got ${JSON.stringify(reply)}`);
}
console.log("LIBRARY_ASK_OK", reply, thebe.toolNames().join(","));
