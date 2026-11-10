import { useWorkbenchAgentStore } from "../../src/stores/use-workbench-agent-store";
console.log(useWorkbenchAgentStore.getState().dispatchImage({ run: true, prompt: "fixture", workspaceId: "workspace", requestId: "request" }));
