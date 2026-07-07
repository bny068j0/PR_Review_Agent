import { defineAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import instructions from "./pr_review_instructions.md" with { type: "markdown" };
import { githubTools } from "../tools/github-mcp.ts";

export default defineAgent(() => ({
  model: "opencode-go/deepseek-v4-pro",
  instructions,
  sandbox: local(),
  tools: githubTools,
}));
