/** Installation state supplied by the local desktop, never the remote Host. */
export interface CodexSkillStatus {
  readonly state: 'missing' | 'current' | 'update' | 'modified' | 'unmanaged' | 'unavailable'
  readonly directory: string
  readonly autoStart: boolean
}

/** Desktop-only capability; installation always follows a user action. */
export interface CodexSkillBridge {
  status(): Promise<CodexSkillStatus>
  install(options: { autoStart: boolean }): Promise<CodexSkillStatus>
}
