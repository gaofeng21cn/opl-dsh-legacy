/** Startup shell selection for the shipped profiles, before settings services mount. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Native Windows Agent shell choices. */
export const AGENT_SHELL_SELECTIONS = ['powershell', 'git-bash'] as const
/** One supported Native Windows Agent shell. */
export type AgentShellSelection = typeof AGENT_SHELL_SELECTIONS[number]
/** Existing Windows installations keep PowerShell unless explicitly changed. */
export const DEFAULT_AGENT_SHELL_SELECTION: AgentShellSelection = 'powershell'
/** Immutable settings captured before the shipped composition mounts. */
export interface AgentShellStartup {
  readonly agentShell: AgentShellSelection
  readonly gitBashPath?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the shipped profiles' settings document once. Invalid stored choices fail
 * startup rather than silently executing commands in another language.
 * @param home - harness home containing settings.yaml.
 * @returns the selected shell and optional Git for Windows executable.
 */
export function readAgentShellStartup(home: string = resolveDshHome()): AgentShellStartup {
  let text: string
  try {
    text = readFileSync(join(home, 'settings.yaml'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { agentShell: DEFAULT_AGENT_SHELL_SELECTION }
    throw error
  }
  const document: unknown = yaml.load(text)
  if (document === undefined || document === null) return { agentShell: DEFAULT_AGENT_SHELL_SELECTION }
  if (!isRecord(document)) throw new Error('settings.yaml must contain a mapping')
  const shell = document.shell
  if (shell === undefined) return { agentShell: DEFAULT_AGENT_SHELL_SELECTION }
  if (!isRecord(shell)) throw new Error('settings.yaml shell must contain a mapping')
  const agentShell = shell.agentShell === undefined ? DEFAULT_AGENT_SHELL_SELECTION : shell.agentShell
  if (agentShell !== 'powershell' && agentShell !== 'git-bash') {
    throw new Error('shell.agentShell must be powershell or git-bash')
  }
  if (shell.gitBashPath !== undefined && typeof shell.gitBashPath !== 'string') {
    throw new Error('shell.gitBashPath must be a string')
  }
  return Object.freeze({ agentShell, ...(shell.gitBashPath === undefined ? {} : { gitBashPath: shell.gitBashPath }) })
}

/**
 * Read the persisted shell choice; boot captures it for all later preset mounts.
 * @param home - harness home containing settings.yaml.
 * @returns the selected shell, defaulting only when no choice was stored.
 */
export function readAgentShellSelection(home: string = resolveDshHome()): AgentShellSelection {
  return readAgentShellStartup(home).agentShell
}
