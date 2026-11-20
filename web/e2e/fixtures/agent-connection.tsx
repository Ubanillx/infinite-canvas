import { createRoot } from "react-dom/client";
import { App } from "antd";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { LocalAgentPanel } from "@/components/agent/local-agent-panel";
import { useAgentStore } from "@/stores/use-agent-store";

// Loaded only by scripts/dev-agent-context-qa.mjs in an isolated browser context.
useAgentStore.setState({ url: `${location.origin}/mock-agent`, token: "test", enabled: true });
Object.assign(window, { agentStore: useAgentStore });
createRoot(document.getElementById("root")!).render(
    <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
            <App><LocalAgentPanel embedded /></App>
        </QueryClientProvider>
    </MemoryRouter>,
);
