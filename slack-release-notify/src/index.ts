import * as core from '@actions/core';
import * as github from '@actions/github';

const FIRST_PUSH_SHA = '0'.repeat(40);

interface Change {
  prNumber: number | null;
  prUrl: string | null;
  label: string;
}

interface Categorized {
  features: Change[];
  fixes: Change[];
  others: Change[];
}

function categorize(changes: Change[]): Categorized {
  const features: Change[] = [];
  const fixes: Change[] = [];
  const others: Change[] = [];

  for (const change of changes) {
    if (/^feat(ure)?[(!:]/i.test(change.label)) {
      features.push(change);
    } else if (/^fix[(!:]|^Fix\/|^bugfix[(!:]/i.test(change.label)) {
      fixes.push(change);
    } else {
      others.push(change);
    }
  }

  return { features, fixes, others };
}

function formatChange(change: Change): string {
  return change.prNumber && change.prUrl
    ? `• <${change.prUrl}|#${change.prNumber}> ${change.label}`
    : `• ${change.label}`;
}

function buildBody({ features, fixes, others }: Categorized): string {
  const sections: string[] = [];

  if (features.length > 0) {
    sections.push('*Features*\n' + features.map(formatChange).join('\n'));
  }
  if (fixes.length > 0) {
    sections.push('*Bug Fixes*\n' + fixes.map(formatChange).join('\n'));
  }
  if (others.length > 0) {
    sections.push('*Other*\n' + others.map(formatChange).join('\n'));
  }

  return sections.join('\n\n');
}

async function run(): Promise<void> {
  const webhookUrl = core.getInput('webhook', { required: true });
  const token = core.getInput('github-token', { required: true });
  const beforeSha = core.getInput('before-sha', { required: true });

  if (beforeSha === FIRST_PUSH_SHA) {
    core.info('First push to main — skipping notification');
    return;
  }

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  // Single API call to get all commits in this push
  const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${beforeSha}...HEAD`,
  });

  const commits = comparison.commits.filter(
    (commit) => !commit.commit.message.startsWith('Merge '),
  );

  if (commits.length === 0) {
    core.info('No new commits — skipping notification');
    return;
  }

  // Parallel PR lookups — one per commit, all in flight at once
  const changes = await Promise.all(
    commits.map(async (commit): Promise<Change> => {
      const { data: prs } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
        owner,
        repo,
        commit_sha: commit.sha,
      });

      const pr = prs[0] ?? null;
      return {
        prNumber: pr?.number ?? null,
        prUrl: pr?.html_url ?? null,
        label: pr?.title ?? commit.commit.message.split('\n')[0],
      };
    }),
  );

  const categorized = categorize(changes);
  const count = changes.length;
  const noun = count === 1 ? 'change' : 'changes';
  const date = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

  const payload = {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `[${repo}] → \`main\`  ·  ${count} ${noun}  ·  ${date}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: buildBody(categorized),
        },
      },
      { type: 'divider' },
    ],
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook responded with ${response.status}: ${await response.text()}`);
  }

  core.info(`Slack notified — ${count} ${noun} shipped`);
}

run().catch(core.setFailed);
