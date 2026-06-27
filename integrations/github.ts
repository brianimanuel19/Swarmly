import { Octokit } from '@octokit/rest';
import type { FileChange } from '../types/index.js';
import { config } from '../config/config.js';

// ─── Class ────────────────────────────────────────────────────────────────────

export class GitHubIntegration {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;

  constructor(token?: string, owner?: string, repo?: string) {
    this.octokit = new Octokit({
      auth: token ?? config.github.token,
      userAgent: 'swarmly-agent/1.0',
    });
    this.owner = owner ?? config.github.owner;
    this.repo = repo ?? config.github.repo ?? '';
  }

  // ─── Repo creation ────────────────────────────────────────────────────────

  /**
   * Create a new GitHub repository under the configured owner.
   * Returns a GitHubIntegration instance scoped to the new repo.
   */
  async createRepo(params: { name: string; description?: string; isPrivate?: boolean }): Promise<{
    owner: string;
    repo: string;
    htmlUrl: string;
    cloneUrl: string;
    integration: GitHubIntegration;
  }> {
    const repoParams = {
      name: params.name,
      description: params.description ?? '',
      private: params.isPrivate ?? true,
      auto_init: true, // creates initial commit so branch operations work immediately
    };

    let owner: string;
    let repo: string;
    let htmlUrl: string;
    let cloneUrl: string;

    try {
      // Try org repo first (works when GITHUB_OWNER is an organisation)
      const { data } = await this.octokit.repos.createInOrg({
        org: this.owner,
        ...repoParams,
      });
      owner = data.owner.login;
      repo = data.name;
      htmlUrl = data.html_url;
      cloneUrl = data.clone_url;
    } catch {
      // Fall back to personal repo (when GITHUB_OWNER is a user account)
      const { data } = await this.octokit.repos.createForAuthenticatedUser(repoParams);
      owner = data.owner?.login ?? this.owner;
      repo = data.name;
      htmlUrl = data.html_url;
      cloneUrl = data.clone_url;
    }

    return { owner, repo, htmlUrl, cloneUrl, integration: this.forRepo(repo, owner) };
  }

  /**
   * Return a new GitHubIntegration instance pointing at a different repo.
   * Reuses the same token and owner (unless overridden).
   */
  forRepo(repo: string, owner?: string): GitHubIntegration {
    return new GitHubIntegration(config.github.token, owner ?? this.owner, repo);
  }

  // ─── Branch helpers ───────────────────────────────────────────────────────

  /**
   * Create a new branch from `fromBranch` (defaults to the repo default branch).
   */
  async createBranch(branchName: string, fromBranch?: string): Promise<void> {
    // Resolve the source branch SHA
    const sourceBranch = fromBranch ?? (await this.getDefaultBranch());

    const refData = await this.octokit.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${sourceBranch}`,
    });

    const sha = refData.data.object.sha;

    await this.octokit.git.createRef({
      owner: this.owner,
      repo: this.repo,
      ref: `refs/heads/${branchName}`,
      sha,
    });
  }

  /**
   * Return true if the branch already exists in the remote.
   */
  async branchExists(branchName: string): Promise<boolean> {
    try {
      await this.octokit.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${branchName}`,
      });
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return false;
      throw err;
    }
  }

  /**
   * Return a list of all branch names in the repo.
   */
  async listBranches(): Promise<string[]> {
    const branches: string[] = [];
    let page = 1;

    while (true) {
      const { data } = await this.octokit.repos.listBranches({
        owner: this.owner,
        repo: this.repo,
        per_page: 100,
        page,
      });
      branches.push(...data.map((b) => b.name));
      if (data.length < 100) break;
      page++;
    }

    return branches;
  }

  // ─── File operations ──────────────────────────────────────────────────────

  /**
   * Retrieve the decoded content of a single file, or null if it doesn't exist.
   */
  async getFileContent(path: string, branch: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref: branch,
      });

      if (Array.isArray(data)) {
        throw new Error(`Path "${path}" is a directory, not a file.`);
      }

      if (data.type !== 'file' || !('content' in data)) {
        return null;
      }

      return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  /**
   * Commit one or more file changes to `branch` in a single atomic commit.
   * Returns the URL of the created commit.
   *
   * Strategy:
   *  1. Get the current HEAD commit SHA for the branch.
   *  2. For each file (create/modify/delete), create a blob or null SHA.
   *  3. Build a new tree on top of the base tree.
   *  4. Create a new commit pointing at that tree.
   *  5. Update the branch ref.
   */
  async commitFiles(files: FileChange[], message: string, branch: string): Promise<string> {
    // 1. Get current HEAD for the branch
    const { data: refData } = await this.octokit.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${branch}`,
    });
    const headSha = refData.object.sha;

    // Get the base tree SHA from the HEAD commit
    const { data: headCommit } = await this.octokit.git.getCommit({
      owner: this.owner,
      repo: this.repo,
      commit_sha: headSha,
    });
    const baseTreeSha = headCommit.tree.sha;

    // 2 & 3. Build the tree entries
    const treeItems: Array<{
      path: string;
      mode: '100644' | '100755' | '040000' | '160000' | '120000';
      type: 'blob' | 'tree' | 'commit';
      sha?: string | null;
      content?: string;
    }> = [];

    for (const file of files) {
      if (file.action === 'delete') {
        // Deleting a file: set sha to null
        treeItems.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: null,
        });
      } else {
        // Create or modify: use content directly (avoids a separate blob API call)
        treeItems.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          content: file.content,
        });
      }
    }

    const { data: newTree } = await this.octokit.git.createTree({
      owner: this.owner,
      repo: this.repo,
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    // 4. Create the commit
    const { data: newCommit } = await this.octokit.git.createCommit({
      owner: this.owner,
      repo: this.repo,
      message,
      tree: newTree.sha,
      parents: [headSha],
    });

    // 5. Fast-forward the branch ref
    await this.octokit.git.updateRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
      force: false,
    });

    return newCommit.html_url;
  }

  // ─── Pull Requests ────────────────────────────────────────────────────────

  /**
   * Open a pull request and return its HTML URL.
   */
  async createPR(
    title: string,
    body: string,
    branch: string,
    baseBranch?: string,
  ): Promise<string> {
    const base = baseBranch ?? (await this.getDefaultBranch());

    const { data } = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title,
      body,
      head: branch,
      base,
      maintainer_can_modify: true,
    });

    return data.html_url;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async getDefaultBranch(): Promise<string> {
    const { data } = await this.octokit.repos.get({
      owner: this.owner,
      repo: this.repo,
    });
    return data.default_branch;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const githubIntegration = new GitHubIntegration();
