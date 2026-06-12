/**
 * Factory over the concrete git-provider implementations. The interface
 * + shared shapes live in `provider-types.ts` (which imports no
 * implementation); this module is the single dispatch point that pulls
 * the impls in.
 */

import type { GitProviderClient, GitRepoConfig } from './provider-types'
import { GitHubProvider } from './github'
import { GitLabProvider } from './gitlab'
import { AzureDevOpsProvider } from './azure'

/**
 * Build the provider client for a source. All three providers ship end-to-end
 * over the same interface; each is raw-fetch REST (no clone).
 */
export function createGitProvider(config: GitRepoConfig, token: string): GitProviderClient {
  switch (config.provider) {
    case 'github':
      return new GitHubProvider(config, token)
    case 'gitlab':
      return new GitLabProvider(config, token)
    case 'azure':
      return new AzureDevOpsProvider(config, token)
    default:
      throw new Error(`git_provider_unknown:${String(config.provider)}`)
  }
}
