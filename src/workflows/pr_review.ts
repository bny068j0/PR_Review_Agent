import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";
import pr_review_agent from "../agents/pr_review_agent";

// ---------------------------------------------------------------------------
// Slack notification helper
// ---------------------------------------------------------------------------
async function sendSlackAlert(summary: string, criticalIssues: string[]) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("SLACK_WEBHOOK_URL not set — skipping Slack notification.");
    return;
  }

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: "🚨 Critical PR Review Findings" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Summary:* ${summary}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Critical Issues:*\n${criticalIssues.map((i) => `• ${i}`).join("\n")}`,
      },
    },
  ];

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocks }),
  });

  if (!response.ok) {
    console.error(
      `Slack notification failed: ${response.status} ${response.statusText}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Review result schema (what the agent returns)
// ---------------------------------------------------------------------------
const reviewResultSchema = v.object({
  decision: v.pipe(
    v.string(),
    v.description("Review decision: APPROVE, REQUEST_CHANGES, or COMMENT"),
  ),
  summary: v.pipe(
    v.string(),
    v.description("Brief 1-2 sentence summary of the review"),
  ),
  critical_issues: v.pipe(
    v.array(v.string()),
    v.description("List of critical/blocking issues found"),
  ),
  files_reviewed: v.pipe(v.number(), v.description("Number of files reviewed")),
  comments_posted: v.pipe(
    v.number(),
    v.description("Number of inline comments posted"),
  ),
});

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------
export default defineWorkflow({
  agent: pr_review_agent,
  input: v.object({
    owner: v.pipe(
      v.string(),
      v.description("Repository owner (user or organization)"),
    ),
    repo: v.pipe(v.string(), v.description("Repository name")),
    pullNumber: v.pipe(
      v.number(),
      v.description("Pull request number to review"),
    ),
  }),

  async run({ harness, input }) {
    const { owner, repo, pullNumber } = input;

    // Step 1+2+3+4: Have the agent fetch the PR, analyze it, and post
    // inline comments + a final review decision via the GitHub tools.
    const session = await harness.session();
    const { data: review } = await session.prompt(
      `Review pull request #${pullNumber} in ${owner}/${repo}.

1. Fetch the full PR details and diff.
2. Analyze each changed file for bugs, security, performance, and code quality issues.
3. Post inline comments for issues you find using create_review_comment.
4. Submit a final review with your decision using submit_pull_request_review.
   - APPROVE if the code looks good.
   - REQUEST_CHANGES if there are blocking issues.
   - COMMENT for neutral feedback.

After completing the review, return the structured summary.`,
      { result: reviewResultSchema },
    );

    // Step 5: Send Slack notification for critical issues
    if (review.critical_issues.length > 0) {
      await sendSlackAlert(review.summary, review.critical_issues);
    }

    return {
      ...review,
      owner,
      repo,
      pull_number: pullNumber,
    };
  },
});
