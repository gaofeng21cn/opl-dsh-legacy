/**
 * Default responses for every Remote endpoint the web assembly calls while
 * booting and rendering with no sessions, no workspaces, and default settings.
 * The comment above each row names the plugin that calls it; endpoints boot
 * never touches stay absent so a new call fails loud. `$events` is built into
 * `RemoteMock`.
 * @module @deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses
 */
import { ok, openStream, type RemoteTable } from '@deepseek-ai/dsh-remote-mock'

/** Id the startup landing Session is created with; the follow stream answers for the same blank Session. */
const STARTUP_SESSION_ID = 'mock-session-1'

/** Default responses of the boot-time Remote endpoints; a spec loads it first and layers its own table on top. */
export const remoteDefaultResponses: RemoteTable = {
  unary: {
    // api-session-controller `sessions.handleConnected()` on `connection/reset`.
    'session/list': ok({ items: [] }),
    // ui-workspace `openChat()`: the startup landing creates one blank Session when no Session is current.
    'session/create': ok({ sessionId: STARTUP_SESSION_ID }),
    // api-session-controller `SessionManager.refreshSubagents()` when the startup landing Session opens.
    'subagents/list': ok({ entries: [], parentAvailable: true }),
    // ui-commands `CommandDirectory` warming the startup landing Session's slash menu.
    'commands/list': ok([]),
    // ui-skill lexicon fetch for the startup landing Session.
    'skills/list': ok({ skills: [] }),
    // ui-settings `mirror.ensure()` at apply and again on `connection/reset`.
    'settings/describe': ok({ writable: true, hasDocument: false, namespaces: [] }),
    // ui-model-selection `ModelDirectoryResolver` constructor.
    'session/modelCatalog': ok({
      default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      routableProviders: [],
      groups: [],
      failures: [],
    }),
    // ui-agent-preset hero chip and header label on first mount.
    'agentPresets/list': ok({ presets: [], authorable: false }),
    // cordis-client-runner `ClientCordisInspectRegistry.sync` at apply and on `connection/reset`.
    'dynamicCordisRunner/syncInspectManifest': ok(null),
    // ui-cordis inventory at apply and on `connection/reset`.
    'dynamicCordisRunner/inventory': ok([]),
    // ui-settings-plugins web-search card `readCredential()` when the settings mirror first publishes.
    'credentials/describe': ok({}),
    // ui-permission-presets `PermissionCatalogDirectory` on its first read for a connection generation.
    'permissionPresets/catalog': ok({ options: [] }),
    // ui-settings-account refreshes details after a stored-grant snapshot.
    'account/getProfile': ok(null),
    'account/getBalance': ok(null),
    // ui-settings-account bonus notice read and acknowledgement at signing in.
    'account/getUnnotifiedBonuses': ok(null),
    'account/ackBonusNotified': ok(true),
  },
  stream: {
    // api-session-controller client `apply`: the control stream's opening baseline, then open.
    'session/control': openStream([{ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } }]),
    // api-session-controller `SessionEventStream.follow` for the startup landing Session: the blank log's opening window, then open.
    'session/follow': openStream([{
      type: 'snapshot',
      header: { version: 3, id: STARTUP_SESSION_ID, createdAt: 0, isSeeded: false },
      cursor: -1,
      records: [],
      hasMore: false,
      projections: { asOfSeq: -1, values: {} },
      assistantStream: { revision: 0 },
    }]),
    // api-workspace-controller client `apply`: the follow stream's opening baseline, then open.
    'workspace/follow': openStream([{ type: 'baseline', value: { items: [], archivedSessionIds: [] } }]),
  },
}
