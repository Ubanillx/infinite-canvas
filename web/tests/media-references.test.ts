import { expect, test } from "bun:test";
import { extractMediaReferences } from "../src/server/media-references";

const node = (metadata: unknown) => ({ id: "node", metadata });
const canvas = (nodes: unknown[] = [], chatSessions: unknown[] = []) => ({ version: 0, state: { projects: [{ id: "canvas", nodes, connections: [], chatSessions }] } });

test("canvas references include node media, batch outputs and chat attachments with owner and JSON pointers", () => {
    const payload = canvas([node({ storageKey: "image:main", content: "image:main", images: [{ storageKey: "image:batch" }], references: ["video:ref", "audio:ref", "template-input:empty", "https://example.com/a.png"] })], [{ messages: [{ references: [{ storageKey: "image:chat" }] }] }]);
    const refs = extractMediaReferences("canvas", payload);
    expect(new Set(refs.map((ref) => ref.storageKey))).toEqual(new Set(["image:main", "image:batch", "video:ref", "audio:ref", "image:chat"]));
    expect(refs.filter((ref) => ref.storageKey === "image:main")).toHaveLength(2);
    expect(refs.every((ref) => ref.ownerKind === "canvas" && ref.ownerId === "canvas")).toBe(true);
    expect(refs[0].path).toBe("/state/projects/0/nodes/0/metadata/storageKey");
});

test("template cover and nodes have separate owners and inputs without examples add no reference", () => {
    const refs = extractMediaReferences("canvas-templates", { version: 1, templates: [{ id: "template", cover: { storageKey: "image:cover" }, content: { nodes: [node({ templateInput: { required: true }, content: "", references: ["template-input:empty"] }), node({ storageKey: "image:result" })], connections: [] } }] });
    expect(refs.map((ref) => [ref.storageKey, ref.ownerKind, ref.ownerId])).toEqual([["image:cover", "template-cover", "template"], ["image:result", "template", "template"]]);
});

test("assets and workbench logs protect image, video, audio and distinct cover references", () => {
    expect(extractMediaReferences("assets", { version: 0, state: { assets: [{ id: "asset", kind: "video", coverUrl: "image:cover", data: { storageKey: "video:result" } }] } }).map((ref) => ref.storageKey)).toEqual(["image:cover", "video:result"]);
    for (const domain of ["image-workbench", "video-workbench"]) {
        const refs = extractMediaReferences(domain, { logs: [{ id: "log", images: [{ storageKey: "image:result" }], references: [{ storageKey: "image:ref" }], video: { storageKey: "video:result" }, audioReferences: [{ storageKey: "audio:ref" }] }] });
        expect(refs).toHaveLength(4);
        expect(refs.every((ref) => ref.ownerId === "log")).toBe(true);
    }
});

test("external URLs, data URLs, blob URLs, prose and template input placeholders are not objects", () => {
    const payload = canvas([node({ content: "blob:example", prompt: "Generate image:example", references: ["data:image/png;base64,AAAA", "https://example.com/image:foo", "template-input:node"] })]);
    expect(extractMediaReferences("canvas", payload)).toEqual([]);
});

test("plugin storageKey fields are retained, escaped paths are unambiguous", () => {
    const refs = extractMediaReferences("canvas", canvas([node({ plugin: { "a/b~c": { storageKey: "plugin-media:asset" } } })]));
    expect(refs[0].storageKey).toBe("plugin-media:asset");
    expect(refs[0].path).toEndWith("/plugin/a~1b~0c/storageKey");
});

test("unknown domains, versions and malformed collections fail closed", () => {
    for (const [domain, payload] of [["new-domain", {}], ["canvas", { version: 99, state: { projects: [] } }], ["canvas", { state: { projects: [null] } }], ["assets", { state: { assets: {} } }], ["canvas-templates", { version: 2, templates: [] }], ["image-workbench", {}], ["canvas", null]] as const) {
        expect(() => extractMediaReferences(domain, payload)).toThrow();
    }
});

test("unknown media-bearing fields, root references and malformed storage keys block inventory", () => {
    expect(() => extractMediaReferences("canvas", canvas([node({ futureMedia: "image:unknown" })]))).toThrow();
    expect(() => extractMediaReferences("canvas", { ...canvas(), storageKey: "image:root" })).toThrow();
    for (const storageKey of ["https://example.com/file", 123, false, {}, ["image:array"]]) expect(() => extractMediaReferences("canvas", canvas([node({ storageKey })]))).toThrow();
});

test("duplicate owners and unversioned nonempty Agent data are not interpreted as empty", () => {
    const payload = canvas();
    payload.state.projects.push(payload.state.projects[0]);
    expect(() => extractMediaReferences("canvas", payload)).toThrow();
    expect(extractMediaReferences("agent-sessions", { version: 1, sessions: [] })).toEqual([]);
    expect(() => extractMediaReferences("agent-sessions", { sessions: [] })).toThrow();
    expect(() => extractMediaReferences("agent-sessions", { sessions: [{ id: "session", storageKey: "image:attachment" }] })).toThrow();
    expect(() => extractMediaReferences("agent-sessions", { messages: [] })).toThrow();
});

test("versioned standalone Agent attachments retain message scope and reject transient payloads", () => {
    const attachment = { id: "file", name: "File", storageKey: "image:agent", type: "image/png", size: 2, width: 1, height: 1, purpose: "attachment" };
    const payload = { version: 1, sessions: [{ id: "session", engine: "pi", threadId: "thread", messages: [{ id: "message", clientMessageId: "message", turnId: "turn", itemId: "item", attachments: [attachment] }] }] };
    expect(extractMediaReferences("agent-sessions", payload)).toEqual([{ storageKey: "image:agent", ownerKind: "agent-session", ownerId: "session", path: "/sessions/0/messages/0/attachments/0/storageKey" }]);
    for (const invalid of [{ ...attachment, url: "blob:transient" }, { ...attachment, dataUrl: "data:image/png;base64,AAAA" }, { ...attachment, storageKey: "agent-asset:old/file.png" }]) {
        expect(() => extractMediaReferences("agent-sessions", { ...payload, sessions: [{ ...payload.sessions[0], messages: [{ ...payload.sessions[0].messages[0], attachments: [invalid] }] }] })).toThrow();
    }
    expect(() => extractMediaReferences("agent-sessions", { ...payload, version: 2 })).toThrow();
});
