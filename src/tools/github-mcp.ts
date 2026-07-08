import { connectMcpServer, defineTool } from "@flue/runtime";
import { Octokit } from "@octokit/rest";
import * as v from "valibot";

// ---------------------------------------------------------------------------
// Direct Octokit-based tools (recommended approach per Flue docs)
// ---------------------------------------------------------------------------

const token = process.env.PAT_TOKEN;
if (!token) {
  throw new Error(
    "PAT_TOKEN is required. Set it to a GitHub personal access token.",
  );
}
// Narrowed constant after the guard above
const githubToken: string = token;

const octokit = new Octokit({ auth: githubToken });

/**
 * List pull requests for a repository.
 */
export const listPullRequests = defineTool({
  name: "list_pull_requests",
  description:
    "List open pull requests for a GitHub repository. Returns PR number, title, author, branch, URL, and creation date.",
  input: v.object({
    owner: v.pipe(
      v.string(),
      v.description("Repository owner (user or organization)"),
    ),
    repo: v.pipe(v.string(), v.description("Repository name")),
    state: v.optional(
      v.pipe(
        v.string(),
        v.description("PR state: open, closed, or all (default: open)"),
      ),
    ),
  }),
  async run({ input, signal }) {
    const { data } = await octokit.rest.pulls.list({
      owner: input.owner,
      repo: input.repo,
      state: (input.state as "open" | "closed" | "all") ?? "open",
      sort: "updated",
      direction: "desc",
      per_page: 30,
      request: { signal },
    });

    return {
      total: data.length,
      pull_requests: data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        author: pr.user?.login ?? "unknown",
        head: pr.head?.ref ?? "",
        base: pr.base?.ref ?? "",
        state: pr.state,
        draft: pr.draft ?? false,
        html_url: pr.html_url,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        body: pr.body ? pr.body.slice(0, 500) : null,
      })),
    };
  },
});

/**
 * Get detailed information about a specific pull request including its diff.
 */
export const getPullRequest = defineTool({
  name: "get_pull_request",
  description:
    "Get detailed information about a specific pull request including its description, file changes, and diff.",
  input: v.object({
    owner: v.pipe(
      v.string(),
      v.description("Repository owner (user or organization)"),
    ),
    repo: v.pipe(v.string(), v.description("Repository name")),
    pullNumber: v.pipe(v.number(), v.description("Pull request number")),
  }),
  async run({ input, signal }) {
    const [prResult, filesResult] = await Promise.all([
      octokit.rest.pulls.get({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        request: { signal },
      }),
      octokit.rest.pulls.listFiles({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        per_page: 100,
        request: { signal },
      }),
    ]);

    const pr = prResult.data;
    const files = filesResult.data;

    return {
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? "unknown",
      head: pr.head.ref,
      base: pr.base.ref,
      state: pr.state,
      mergeable: pr.mergeable ?? null,
      draft: pr.draft ?? false,
      html_url: pr.html_url,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
      body: pr.body ?? "",
      changed_files: files.length,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      files: files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch ? f.patch.slice(0, 2000) : null,
      })),
    };
  },
});

/**
 * Get the diff for a specific pull request.
 */
export const getPullRequestDiff = defineTool({
  name: "get_pull_request_diff",
  description:
    "Get the raw unified diff for a pull request. Useful for reviewing code changes.",
  input: v.object({
    owner: v.pipe(
      v.string(),
      v.description("Repository owner (user or organization)"),
    ),
    repo: v.pipe(v.string(), v.description("Repository name")),
    pullNumber: v.pipe(v.number(), v.description("Pull request number")),
  }),
  async run({ input, signal }) {
    const { data } = await octokit.rest.pulls.get({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
      mediaType: { format: "diff" },
      request: { signal },
    });

    // The diff is returned as a string when using the diff media type
    const diff = typeof data === "string" ? data : JSON.stringify(data);
    return {
      diff: diff.slice(0, 8000), // Truncate very large diffs
      truncated: diff.length > 8000,
    };
  },
});

/**
 * Get reviews and review comments on a pull request.
 */
export const getPullRequestReviews = defineTool({
  name: "get_pull_request_reviews",
  description:
    "Get all reviews and review comments on a pull request. Returns review summaries and inline comments.",
  input: v.object({
    owner: v.pipe(
      v.string(),
      v.description("Repository owner (user or organization)"),
    ),
    repo: v.pipe(v.string(), v.description("Repository name")),
    pullNumber: v.pipe(v.number(), v.description("Pull request number")),
  }),
  async run({ input, signal }) {
    const [reviews, comments] = await Promise.all([
      octokit.rest.pulls.listReviews({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        per_page: 50,
        request: { signal },
      }),
      octokit.rest.pulls.listReviewComments({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        per_page: 100,
        request: { signal },
      }),
    ]);

    return {
      reviews: reviews.data.map((r) => ({
        id: r.id,
        user: r.user?.login ?? "unknown",
        state: r.state, // APPROVED, CHANGES_REQUESTED, COMMENTED
        body: r.body ? r.body.slice(0, 1000) : null,
        submitted_at: r.submitted_at ?? "",
      })),
      review_comments: comments.data.map((c) => ({
        id: c.id,
        user: c.user?.login ?? "unknown",
        path: c.path,
        line: c.line ?? 0,
        body: c.body.slice(0, 500),
        created_at: c.created_at,
      })),
    };
  },
});

/**
 * Inline comment on a specific line of a file in a pull request.
 */
export const createReviewComment = defineTool({
  name: "create_review_comment",
  description:
    "Post an inline review comment on a specific line of a file in a pull request. Use this for individual code suggestions.",
  input: v.object({
    owner: v.pipe(
      v.string(),
      v.description("Repository owner (user or organization)"),
    ),
    repo: v.pipe(v.string(), v.description("Repository name")),
    pullNumber: v.pipe(v.number(), v.description("Pull request number")),
    commitId: v.pipe(
      v.string(),
      v.description(
        "The SHA of the commit to comment on (from the PR's head commit)",
      ),
    ),
    path: v.pipe(v.string(), v.description("File path to comment on")),
    line: v.pipe(v.number(), v.description("Line number in the diff")),
    body: v.pipe(
      v.string(),
      v.description("The comment body (Markdown supported)"),
    ),
    side: v.optional(
      v.pipe(
        v.string(),
        v.description("RIGHT (new file) or LEFT (old file). Default: RIGHT"),
      ),
    ),
  }),
  async run({ input, signal }) {
    const { data } = await octokit.rest.pulls.createReviewComment({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
      commit_id: input.commitId,
      path: input.path,
      line: input.line,
      body: input.body,
      side: (input.side as "LEFT" | "RIGHT") ?? "RIGHT",
      request: { signal },
    });

    return {
      id: data.id,
      path: data.path,
      line: data.line ?? 0,
      html_url: data.html_url,
    };
  },
});

/**
 * Submit a full PR review with an approval decision and optional summary.
 */
export const submitPullRequestReview = defineTool({
  name: "submit_pull_request_review",
  description:
    "Submit a full pull request review with a decision: APPROVE (allow merge), REQUEST_CHANGES (block merge), or COMMENT (neutral feedback). Also accepts a summary body in Markdown.",
  input: v.object({
    owner: v.pipe(
      v.string(),
      v.description("Repository owner (user or organization)"),
    ),
    repo: v.pipe(v.string(), v.description("Repository name")),
    pullNumber: v.pipe(v.number(), v.description("Pull request number")),
    body: v.pipe(v.string(), v.description("Review summary body in Markdown")),
    event: v.pipe(
      v.string(),
      v.description("Review decision: APPROVE, REQUEST_CHANGES, or COMMENT"),
    ),
  }),
  async run({ input, signal }) {
    const { data } = await octokit.rest.pulls.createReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.pullNumber,
      body: input.body,
      event: input.event as "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
      request: { signal },
    });

    return {
      id: data.id,
      state: data.state,
      html_url: data.html_url,
    };
  },
});

/**
 * Read the contents of a file from the repository (Issue #1, #3, #7, #8).
 * Use this to fetch related files, configs, and documentation for full context.
 */
export const readRepoFile = defineTool({
  name: "read_repo_file",
  description:
    "Read the full contents of a file from the repository at a specific ref (branch/commit). Use this to understand related code, imports, configurations, documentation, and coding guidelines that are not in the diff.",
  input: v.object({
    owner: v.pipe(
      v.string(),
      v.description("Repository owner (user or organization)"),
    ),
    repo: v.pipe(v.string(), v.description("Repository name")),
    path: v.pipe(v.string(), v.description("File path relative to repo root")),
    ref: v.optional(
      v.pipe(
        v.string(),
        v.description(
          "Branch name or commit SHA. Default: the repo's default branch",
        ),
      ),
    ),
    maxLines: v.optional(
      v.pipe(
        v.number(),
        v.description(
          "Maximum lines to return (default 500). Large files are truncated.",
        ),
      ),
    ),
  }),
  async run({ input, signal }) {
    const { data } = await octokit.rest.repos.getContent({
      owner: input.owner,
      repo: input.repo,
      path: input.path,
      ref: input.ref,
      request: { signal },
    });

    // getContent returns an array for directories, a single object for files
    if (Array.isArray(data)) {
      return {
        type: "directory",
        path: input.path,
        entries: data.map((e) => ({
          name: e.name,
          path: e.path,
          type: e.type,
          size: e.size,
        })),
        content: null,
        size: 0,
        total_lines: 0,
        truncated: false,
      };
    }

    if (data.type !== "file" || !("content" in data)) {
      return {
        type: data.type,
        path: input.path,
        content: null,
        entries: [],
        size: 0,
        total_lines: 0,
        truncated: false,
      };
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const max = input.maxLines ?? 500;
    const lines = content.split("\n");
    const truncated = lines.length > max;

    return {
      type: "file",
      path: data.path,
      size: data.size ?? 0,
      truncated,
      total_lines: lines.length,
      content: truncated ? lines.slice(0, max).join("\n") : content,
      entries: [],
    };
  },
});

/**
 * List files in a repository directory (Issue #3).
 * Helps the agent discover related files and project structure.
 */
export const listRepoFiles = defineTool({
  name: "list_repo_files",
  description:
    "List files and directories at a given path in the repository. Use this to explore project structure, discover related source files, configs, and documentation.",
  input: v.object({
    owner: v.pipe(
      v.string(),
      v.description("Repository owner (user or organization)"),
    ),
    repo: v.pipe(v.string(), v.description("Repository name")),
    path: v.optional(
      v.pipe(
        v.string(),
        v.description("Directory path relative to repo root. Default: root"),
      ),
    ),
    ref: v.optional(
      v.pipe(
        v.string(),
        v.description(
          "Branch name or commit SHA. Default: the repo's default branch",
        ),
      ),
    ),
  }),
  async run({ input, signal }) {
    const { data } = await octokit.rest.repos.getContent({
      owner: input.owner,
      repo: input.repo,
      path: input.path ?? "",
      ref: input.ref,
      request: { signal },
    });

    const entries = Array.isArray(data) ? data : [data];

    return {
      path: input.path ?? "/",
      entries: entries.map((e) => ({
        name: e.name,
        path: e.path,
        type: e.type,
        size: e.size,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Aggregate all tools
// ---------------------------------------------------------------------------
export const githubTools = [
  listPullRequests,
  getPullRequest,
  getPullRequestDiff,
  getPullRequestReviews,
  readRepoFile,
  listRepoFiles,
  createReviewComment,
  submitPullRequestReview,
];

// ---------------------------------------------------------------------------
// MCP connection (optional — kept for reference but not used by default)
// ---------------------------------------------------------------------------
export async function createGitHubMcpConnection() {
  const url = process.env.GITHUB_MCP_URL;
  const apiKey = process.env.OPENCODE_API_KEY;

  if (!url) {
    throw new Error(
      "GITHUB_MCP_URL is required. Set it to your GitHub MCP server endpoint.",
    );
  }

  // Use API key for MCP proxy auth; fall back to direct token auth.
  // GitHub token is always passed as X-GitHub-Token for the downstream server.
  const authToken = apiKey ?? githubToken;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${authToken}`,
    "X-GitHub-Token": githubToken,
  };

  return connectMcpServer("github", { url, headers });
}
