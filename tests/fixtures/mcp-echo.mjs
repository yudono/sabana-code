// Fixture server MCP minimal (NDJSON over stdio): initialize, tools/list, tools/call.
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined || msg.id === null) return;
  const respond = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
  if (msg.method === "initialize") {
    respond({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "0.0.1" } });
  } else if (msg.method === "tools/list") {
    respond({
      tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    });
  } else if (msg.method === "tools/call") {
    respond({ content: [{ type: "text", text: `echo:${msg.params?.arguments?.text ?? ""}` }] });
  }
});
