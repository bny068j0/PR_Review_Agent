import { connectMcpServer, defineTool } from "@flue/runtime";
import { Octokit } from "@octokit/rest";
import * as v from "valibot";

// ---------------------------------------------------------------------------
// Direct Octokit-based tools (recommended approach per Flue docs)
// ---------------------------------------------------------------------------

const token = process.env.GITHUB_TOKEN;
if (!token) {
  throw new Error(
    "GITHUB_TOKEN is required. Set it to a GitHub personal access token.",
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

// ---------------------------------------------------------------------------
// Aggregate all tools
// ---------------------------------------------------------------------------
export const githubTools = [
  listPullRequests,
  getPullRequest,
  getPullRequestDiff,
  getPullRequestReviews,
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
