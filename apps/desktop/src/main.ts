/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */

import { readFile, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  protocol,
  type IpcMainInvokeEvent,
} from 'electron'
import { resolveDesktopPaths } from './paths.ts'
import { resolveDesktopDshHome } from './dsh-home.ts'
import {
  type ExecutionEnvironment,
  executionEnvironmentId,
  resolveRunningEnvironment,
} from './execution-environment.ts'
import { readStoredEnvironment, writeStoredEnvironment } from './execution-environment-store.ts'
import {
  applyDesktopPreferencesUpdate,
  readDesktopPreferences,
  writeDesktopPreferences,
  type DesktopPreferences,
} from './desktop-preferences.ts'
import { closeDecisionFromResult, desktopClosePrompt } from './close-prompt.ts'
import { createDesktopTray, type DesktopTray } from './tray.ts'
import {
  DesktopNotificationCenter,
  DesktopNotificationLifetime,
  parseDesktopNotificationReport,
} from './notifications.ts'
import { resolveDesktopAppId } from './app-identity.ts'
import {
  assertWslPayloadPresent,
  listWslDistributions,
  probeWslDistribution,
  resolveWslLaunchPlan,
  selectWslDistribution,
  wslLauncherEnvironment,
  wslPayloadRoot,
} from './wsl.ts'
import { DesktopProjectManager, type DesktopProjectHooks } from './project-manager.ts'
import { DesktopHostProcess } from './host-process.ts'
import { WslDesktopHost } from './wsl-host.ts'
import { DesktopBackendController, type DesktopBackendState } from './backend-controller.ts'
import {
  DESKTOP_IPC,
  type DesktopEnvironmentState,
  type DesktopUpdateState,
  type DesktopWslDistribution,
} from './ipc.ts'
import { formatDesktopMessage, resolveDesktopLocale } from './locale.ts'
import { desktopApplicationMenuTemplate, installDesktopContextMenu } from './menus.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import { DesktopUpdateCoordinator } from './update-coordinator.ts'
import { desktopErrorState } from './startup-error.ts'
import { startupFailureDocument } from './startup-document.ts'

const SCHEME = 'dsh-app'
let currentDesktopLocale = resolveDesktopLocale('en')
let focusPrimaryWindow = (): void => {}
type RecoveryAction = 'restart' | 'plugins' | 'reset'
let profileRecoveryAvailable = (): boolean => false
const emergencyPages = new WeakMap<BrowserWindow, { url: string; message: string; busy: boolean }>()
let recoverApplication = (action: RecoveryAction): Promise<void> => {
  if (action !== 'restart') return Promise.reject(new Error('Desktop recovery could not initialize; reinstall the application'))
  app.relaunch()
  app.quit()
  return Promise.resolve()
}

async function showEmergencyDocument(window: BrowserWindow, message: string): Promise<void> {
  const document = startupFailureDocument(resolveDesktopLocale(app.getLocale()), message, profileRecoveryAvailable())
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(document)}`
  emergencyPages.set(window, { url, message, busy: false })
  await window.loadURL(url)
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    stream: true,
    codeCache: true,
  },
}])

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

interface RuntimeResources {
  readonly node: string
  readonly pnpm: string
  readonly dsh: string
  readonly profileResolution?: 'runtime'
}

/** Binding file the Linux Host publishes and this shell reads. */
const WSL_BINDING_FILENAME = 'wsl-transport.json'

function runtimeResources(): RuntimeResources {
  const development = !app.isPackaged
  const node = development
    ? process.env.DSH_DESKTOP_NODE_BINARY
      ?? join(process.resourcesPath, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
    : process.execPath
  const pnpm = (development ? process.env.DSH_DESKTOP_PNPM_ENTRY : undefined)
    ?? join(process.resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  const dsh = (development ? process.env.DSH_DESKTOP_DSH_DIR : undefined)
    ?? (development ? join(process.resourcesPath, 'dsh') : join(app.getAppPath(), 'dsh'))
  return { node, pnpm, dsh, ...(development ? {} : { profileResolution: 'runtime' }) }
}

function developmentHostInspectPort(enabled: boolean): number | undefined {
  const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT
  if (!enabled || configured === undefined || configured === '') return undefined
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('dsh desktop: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535')
  }
  return port
}

function createWindow(preload: string, show = false): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  installDesktopContextMenu(window, () => currentDesktopLocale.messages)
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).protocol !== `${SCHEME}:`) event.preventDefault()
    const page = emergencyPages.get(window)
    if (page === undefined || page.busy || window.webContents.getURL() !== page.url) return
    const action = new URL(url)
    if (action.protocol !== 'dsh-recovery:' || !['restart', 'plugins', 'reset'].includes(action.hostname)) return
    if (action.hostname !== 'restart' && !profileRecoveryAvailable()) return
    page.busy = true
    void recoverApplication(action.hostname as RecoveryAction).catch(async (error: unknown) => {
      if (!window.isDestroyed()) await showEmergencyDocument(window, `${page.message}\n${desktopErrorState(error).message}`)
    }).catch((error: unknown) => { console.error(error) }).finally(() => { page.busy = false })
  })
  return window
}

function assertDesktopSender(event: IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}

async function serveShellAsset(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  const root = resolve(app.getAppPath(), 'renderer')
  const url = new URL(request.url)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response(null, { status: 400 })
  }
  const target = resolve(normalize(join(root, pathname)))
  if (target !== root && !target.startsWith(root + sep)) return new Response(null, { status: 403 })
  try {
    const body = request.method === 'HEAD' ? null : await readFile(target)
    return new Response(body, { headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' } })
  } catch {
    return new Response(null, { status: 404 })
  }
}

/**
 * Read this application's own manifest, which packaging fills with the release
 * AppUserModelID the installer registered on the Start Menu shortcut.
 * @returns the parsed manifest, or undefined when it cannot be read or parsed.
 */
async function readApplicationManifest(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(app.getAppPath(), 'package.json'), 'utf8')) as unknown
  } catch (error: unknown) {
    // An application directory without its own manifest is the ordinary
    // development layout; a manifest that exists but cannot be read is worth
    // reporting, because Windows then applies an implicit toast identity.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('desktop application manifest could not be read', error)
    }
    return undefined
  }
}

async function main(): Promise<void> {
  const resources = runtimeResources()
  // macOS receives this home from the bundle's LSEnvironment; Windows has no
  // equivalent, so resolve it here and pass it to every child we spawn. The Host
  // and the Desktop project profile must agree on one directory or the profile
  // the shell stages is not the profile the Host loads.
  const dshHome = resolveDesktopDshHome({
    platform: process.platform,
    env: process.env,
    userDataPath: app.getPath('userData'),
  })
  // The bundled Host and every pnpm transaction read the Harness home from the
  // environment, which is also how the macOS bundle delivers it through
  // LSEnvironment. Publishing it here gives Windows and Linux the same source of
  // truth, so the profile the shell stages is the profile the Host loads.
  process.env.DSH_HOME = dshHome
  const paths = resolveDesktopPaths(dshHome)
  const development = app.isPackaged ? undefined : join(app.getAppPath(), '.desktop-build', 'development', 'project')
  const activeProject = development ?? paths.profile
  const manager = new DesktopProjectManager(paths, resources)
  profileRecoveryAvailable = () => development === undefined && manager.canRecoverProfile()
  // The persisted selection is what the user chose, so it decides the
  // environment this launch runs in; an explicit process-environment override
  // wins over it as a deliberate per-launch choice. A persisted WSL2 selection
  // is never downgraded to Windows Native: falling back would run the user on
  // an environment they did not choose, where their sessions and plugins are
  // not, and would hide a broken selection behind an apparently healthy start.
  const storedEnvironment: ExecutionEnvironment = readStoredEnvironment(paths.root)
  const runningEnvironment: ExecutionEnvironment = resolveRunningEnvironment(process.env, storedEnvironment)
  // Preferences are shell-owned, so they are read once at launch and kept in
  // memory: the close handler and every notification report read the settings
  // the settings surface just wrote.
  let preferences: DesktopPreferences = readDesktopPreferences(paths.root)
  // Windows attributes a toast to an application through the AppUserModelID the
  // NSIS installer wrote onto the Start Menu shortcut, so the shell publishes
  // the same packaged identity before any window opens.
  if (process.platform === 'win32') {
    const appId = resolveDesktopAppId({
      packaged: app.isPackaged,
      environment: process.env,
      manifest: await readApplicationManifest(),
    })
    if (appId !== undefined) app.setAppUserModelId(appId)
  }
  // The settings surface reports the running and next-launch environments
  // separately. They start equal and diverge when the user saves a change,
  // which is what makes the restart prompt meaningful.
  let selectedEnvironment: ExecutionEnvironment = runningEnvironment
  let pageError: Extract<DesktopBackendState, { phase: 'error' }> | undefined
  let quitting = false
  let startup: Promise<void> | undefined
  let mainWindow: BrowserWindow | undefined
  let pluginWindow: BrowserWindow | undefined
  let shellInstallerOwnsQuit = false
  let tray: DesktopTray | undefined
  let closePrompt: Promise<void> | undefined
  let updateState: DesktopUpdateState = { phase: 'idle' }
  let locale = resolveDesktopLocale(app.getLocale())
  currentDesktopLocale = locale
  let messages = locale.messages
  const appPreload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  const managementPreload = fileURLToPath(new URL('./preload.cjs', import.meta.url))
  const startupUrl = `${SCHEME}://shell/startup.html`
  const applicationUrl = `${SCHEME}://app/index.html`
  let navigation: { window: BrowserWindow; url: string; promise: Promise<void> } | undefined
  let emergencyDocument = false

  const showEmergencyError = async (error: unknown): Promise<void> => {
    if (quitting || emergencyDocument) return
    emergencyDocument = true
    const diagnostic = desktopErrorState(error).message
    pageError = { phase: 'error', message: diagnostic }
    if (mainWindow !== undefined) await showEmergencyDocument(mainWindow, diagnostic)
  }

  const navigateMain = (url: string): Promise<void> => {
    const window = mainWindow
    if (quitting || emergencyDocument || window === undefined || window.isDestroyed()) return Promise.resolve()
    if (navigation?.window === window && navigation.url === url) return navigation.promise
    const next = { window, url, promise: Promise.resolve() }
    next.promise = window.loadURL(url).catch((error: unknown) => {
      if (quitting || window.isDestroyed() || navigation !== next) return
      navigation = undefined
      throw error
    })
    navigation = next
    return next.promise
  }
  const backendState = (): DesktopBackendState => {
    const state = pageError ?? backend.state
    return state.phase === 'error' ? { ...state, profileRecovery: profileRecoveryAvailable() } : state
  }
  const publishBackend = (state: DesktopBackendState): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.backendState, state)
    }
  }
  const backend = new DesktopBackendController((onFailure) => {
    if (development === undefined) manager.assertProfileRuntime(activeProject)
    const hostInspectPort = developmentHostInspectPort(development !== undefined)
    // WSL2 launches the same installed dsh Host inside the distribution and
    // reaches it over the authenticated loopback transport; the byte-pipe
    // child remains the Windows Native path. Both expose `fetch`, so the
    // controller and every renderer route are transport-independent.
    if (runningEnvironment.kind === 'wsl2') {
      // A selection that cannot be honored fails here, visibly, instead of
      // falling back to Native.
      if (process.platform !== 'win32') {
        throw new Error('dsh desktop: the WSL2 execution environment is available only on Windows')
      }
      assertWslPayloadPresent(wslPayloadRoot(process.resourcesPath))
      const plan = resolveWslLaunchPlan({
        environment: runningEnvironment,
        payloadRoot: wslPayloadRoot(process.resourcesPath),
        // The binding file lives in the Desktop state directory on the shared
        // Windows drive, so the Linux writer and this reader name one file.
        bindingFile: join(paths.root, WSL_BINDING_FILENAME),
      })
      const host = new WslDesktopHost(
        plan.invocation,
        plan.bindingFile,
        wslLauncherEnvironment(process.env),
        {},
        onFailure,
      )
      return {
        start: () => host.start(),
        stop: () => host.stop(),
        fetch: (request: Request) => host.fetch(request),
      }
    }
    const host = new DesktopHostProcess(resources.node, development ?? resources.dsh, activeProject,
      hostInspectPort, process.env, onFailure)
    return {
      start: () => host.start(),
      stop: () => host.stop(),
      fetch: (request: Request) => host.fetch(request),
    }
  }, (state) => {
    if (state.phase === 'starting' && !emergencyDocument) pageError = undefined
    publishBackend(backendState())
    if (state.phase === 'error') void navigateMain(startupUrl).catch((error: unknown) => { console.error(error) })
  })

  const publishUpdate = (state: DesktopUpdateState): DesktopUpdateState => {
    updateState = state
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.updatesState, state)
    }
    return state
  }

  /**
   * Describe the environment to the settings surface.
   *
   * The running and selected environments are reported separately because a
   * switch is only a saved intent until the application restarts, and the
   * surface must be able to say so rather than implying a live change. A
   * distribution is only offered when it can actually host the Harness, so a
   * user cannot select one that would fail at the next launch.
   */
  const environmentState = async (): Promise<DesktopEnvironmentState> => {
    const restartRequired = executionEnvironmentId(runningEnvironment) !== executionEnvironmentId(selectedEnvironment)
    const base = {
      current: runningEnvironment.kind,
      ...(runningEnvironment.kind === 'wsl2' ? { currentDistro: runningEnvironment.distro } : {}),
      selected: selectedEnvironment.kind,
      ...(selectedEnvironment.kind === 'wsl2' ? { selectedDistro: selectedEnvironment.distro } : {}),
      restartRequired,
    } as const
    if (process.platform !== 'win32') {
      return { ...base, distributions: [], unavailable: 'not-windows' }
    }
    const installed = await listWslDistributions()
    if (installed.length === 0) return { ...base, distributions: [], unavailable: 'not-installed' }
    const probed = await Promise.all(installed.map(async (entry): Promise<DesktopWslDistribution> => {
      if (entry.version !== 2) return { name: entry.name, isDefault: entry.isDefault, problem: 'not-wsl2' }
      const result = await probeWslDistribution(entry.name)
      return {
        name: entry.name,
        isDefault: entry.isDefault,
        ...(result.nodeVersion === undefined ? {} : { nodeVersion: result.nodeVersion }),
        ...(result.problem === undefined ? {} : { problem: result.problem }),
      }
    }))
    const usable = probed.filter(entry => entry.problem === undefined)
    return {
      ...base,
      distributions: probed,
      ...(usable.length === 0 ? { unavailable: 'no-usable-distribution' } : {}),
    }
  }

  const hooks: DesktopProjectHooks = {
    beforeChange: () => backend.stop(),
    afterChange: () => backend.start(async () => {}),
  }

  recoverApplication = async (action): Promise<void> => {
    await startup?.catch(() => undefined)
    await backend.stop()
    if (action === 'restart') {
      app.relaunch()
      app.quit()
      return
    }
    if (!profileRecoveryAvailable()) throw new Error(messages.startupReinstallAdvice)
    if (action === 'reset') await manager.resetConfiguration(hooks)
    else await manager.mutate({ type: 'plugins-disable-all' }, hooks)
    emergencyDocument = false
    pageError = undefined
    navigation = undefined
    await navigateMain(applicationUrl)
  }

  const showStartupError = async (error: unknown): Promise<void> => {
    if (quitting) return
    pageError = desktopErrorState(error)
    try { await navigateMain(startupUrl) }
    catch (navigationError) {
      await showEmergencyError(new AggregateError([error, navigationError], messages.startupFailed))
    }
    publishBackend(backendState())
  }
  const reconcileBackend = (): Promise<void> => {
    startup ??= (async () => {
      pageError = undefined
      await navigateMain(startupUrl)
      await backend.start(async () => {
        if (development === undefined) {
          await manager.applyRelease()
        }
      })
      if (backend.host !== undefined) await navigateMain(applicationUrl)
    })().catch(async (error: unknown) => {
      await showStartupError(error)
      throw error
    }).finally(() => { startup = undefined })
    return startup
  }

  const updates = new DesktopUpdateCoordinator(
    publishUpdate,
    async () => {
      shellInstallerOwnsQuit = true
      await backend.stop()
    },
  )

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'shell') return serveShellAsset(request).then((response) => {
      if (response.status >= 400 && ['/startup.html', '/startup.js', '/startup.css'].includes(url.pathname)) {
        void showEmergencyError(new Error(`Desktop recovery resource could not be loaded: ${url.pathname} (HTTP ${response.status})`))
          .catch((error: unknown) => { console.error(error) })
      }
      return response
    })
    if (url.hostname !== 'app') return Promise.resolve(new Response(null, { status: 404 }))
    const active = backend.host
    if (active === undefined) return Promise.resolve(new Response('backend unavailable', { status: 503 }))
    return active.fetch(request)
  })

  const mutate = async (event: IpcMainInvokeEvent, mutation: Parameters<DesktopProjectManager['mutate']>[0]): Promise<void> => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) {
      throw new Error('dsh desktop: plugin package changes require a packaged application')
    }
    await startup?.catch(() => undefined)
    pageError = undefined
    await navigateMain(startupUrl)
    try {
      await manager.mutate(mutation, hooks)
      await navigateMain(applicationUrl)
    } catch (error) {
      await showStartupError(error)
      throw error
    }
  }
  ipcMain.handle(DESKTOP_IPC.localeGet, (event) => {
    assertDesktopSender(event, ['shell'])
    return locale
  })
  ipcMain.handle(DESKTOP_IPC.pluginsList, (event) => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) return []
    return manager.listPlugins()
  })
  ipcMain.handle(DESKTOP_IPC.pluginsAdd, (event, spec: unknown) => {
    if (typeof spec !== 'string') throw new Error('dsh desktop: plugin spec must be a string')
    return mutate(event, { type: 'plugin-add', spec })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsRemove, (event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('dsh desktop: plugin name must be a string')
    return mutate(event, { type: 'plugin-remove', name })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsUpdate, (event, name: unknown, version: unknown) => {
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error('dsh desktop: plugin name and version must be strings')
    }
    return mutate(event, { type: 'plugin-update', name, version })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsToggle, (event, name: unknown, enabled: unknown) => {
    if (typeof name !== 'string' || typeof enabled !== 'boolean') throw new Error('dsh desktop: invalid plugin activation request')
    return mutate(event, { type: 'plugin-toggle', name, enabled })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsDisableAll, event => mutate(event, { type: 'plugins-disable-all' }))
  ipcMain.handle(DESKTOP_IPC.backendStatus, (event) => {
    assertDesktopSender(event, ['shell'])
    return backendState()
  })
  ipcMain.handle(DESKTOP_IPC.backendRetry, async (event) => {
    assertDesktopSender(event, ['shell'])
    await reconcileBackend()
    focusPrimaryWindow()
  })
  ipcMain.handle(DESKTOP_IPC.applicationRestart, async (event) => {
    assertDesktopSender(event, ['shell'])
    try {
      await recoverApplication('restart')
    } catch (error) {
      await showStartupError(error)
    }
  })
  ipcMain.handle(DESKTOP_IPC.configurationReset, async (event) => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) throw new Error('Desktop configuration reset requires a packaged application')
    const failure = backendState()
    if (failure.phase !== 'error') {
      throw new Error('Desktop profile reset requires a startup failure')
    }
    await startup?.catch(() => undefined)
    try {
      await recoverApplication('reset')
    } catch (error) {
      await showStartupError(error)
    }
  })
  ipcMain.handle(DESKTOP_IPC.updatesCheck, async (event) => {
    assertDesktopSender(event, ['shell'])
    return updates.check()
  })
  ipcMain.handle(DESKTOP_IPC.updatesInstall, async (event) => {
    assertDesktopSender(event, ['shell'])
    await updates.install()
  })
  ipcMain.handle(DESKTOP_IPC.environmentStatus, async (event) => {
    assertDesktopSender(event, ['shell'])
    return environmentState()
  })
  ipcMain.handle(DESKTOP_IPC.environmentSelect, async (event, selection: unknown) => {
    assertDesktopSender(event, ['shell'])
    if (typeof selection !== 'object' || selection === null) {
      throw new Error('dsh desktop: invalid execution environment selection')
    }
    // The renderer is a separate process, so the value is validated before it
    // is treated as a selection rather than cast into one.
    const raw = selection as Record<string, unknown>
    if (raw.environment === 'windows-native') {
      selectedEnvironment = { kind: 'windows-native' }
    } else if (raw.environment !== 'wsl2') {
      throw new Error(`dsh desktop: unknown execution environment ${JSON.stringify(raw.environment)}`)
    } else {
      // Only a distribution that proved usable may be selected: persisting an
      // unusable one would break the NEXT launch, and the running shell could
      // not then report why. The choice is checked against the same probe the
      // settings surface rendered, so the two can never disagree.
      const requested = typeof raw.distro === 'string' ? raw.distro : undefined
      const state = await environmentState()
      const usable = state.distributions.filter(entry => entry.problem === undefined)
      if (usable.length === 0) {
        throw new Error(messages.environmentUnavailableNoUsable.replace('{detail}', messages.environmentProblemUnreachable))
      }
      const chosen = selectWslDistribution(
        usable.map(entry => ({ name: entry.name, version: 2, isDefault: entry.isDefault })),
        requested,
      )
      selectedEnvironment = { kind: 'wsl2', distro: chosen.name }
    }
    writeStoredEnvironment(paths.root, selectedEnvironment)
    return environmentState()
  })
  ipcMain.handle(DESKTOP_IPC.preferencesGet, (event) => {
    assertDesktopSender(event, ['shell'])
    return preferences
  })
  ipcMain.handle(DESKTOP_IPC.preferencesSet, (event, update: unknown) => {
    assertDesktopSender(event, ['shell'])
    if (typeof update !== 'object' || update === null) {
      throw new Error('dsh desktop: invalid preferences update')
    }
    const raw = update as { notificationsEnabled?: unknown; closeBehavior?: unknown }
    preferences = applyDesktopPreferencesUpdate(preferences, raw)
    writeDesktopPreferences(paths.root, preferences)
    notificationCenter.setEnabled(preferences.notificationsEnabled)
    // The close decision reads the same value, so a change applies to the next
    // close without a restart.
    publishPreferences()
    return preferences
  })
  ipcMain.handle(DESKTOP_IPC.notificationsReport, (event, report: unknown) => {
    assertDesktopSender(event, ['app'])
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('dsh desktop: task notifications require the primary application frame')
    }
    const parsed = parseDesktopNotificationReport(report)
    if (parsed === undefined) throw new Error('dsh desktop: invalid task notification report')
    notificationCenter.report(parsed)
  })

  const checkAndPrompt = async (manual: boolean): Promise<void> => {
    const state = await updates.check()
    if (state.phase === 'error') {
      if (manual) {
        await dialog.showMessageBox({
          type: 'error',
          title: messages.updateCheckFailedTitle,
          message: state.message ?? messages.unknownError,
        })
      }
      return
    }
    if (state.phase !== 'available') {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: messages.updateCheckTitle,
          message: state.message ?? messages.updateCurrent,
        })
      }
      return
    }
    const result = await dialog.showMessageBox({
      type: 'info',
      title: messages.updateTitle,
      message: messages.updateAvailable,
      detail: formatDesktopMessage(messages.updateDetail, { version: state.version ?? '' }),
      buttons: [messages.installAndRestart, messages.later],
      defaultId: 0,
      cancelId: 1,
    })
    if (result.response !== 0) return
    const installed = await updates.install()
    if (installed.phase === 'error') {
      await dialog.showMessageBox({
        type: 'error',
        title: messages.updateFailedTitle,
        message: installed.message ?? messages.unknownError,
      })
    }
  }

  const openPluginWindow = (): void => {
    if (pluginWindow !== undefined && !pluginWindow.isDestroyed()) {
      pluginWindow.focus()
      return
    }
    pluginWindow = createWindow(managementPreload)
    pluginWindow.setSize(900, 620)
    pluginWindow.setTitle(messages.pluginWindowTitle)
    pluginWindow.once('ready-to-show', () => { pluginWindow?.show() })
    pluginWindow.once('closed', () => { pluginWindow = undefined })
    void pluginWindow.loadURL(`${SCHEME}://shell/plugin-manager.html`)
  }

  const refreshMenu = (): void => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(desktopApplicationMenuTemplate(
    process.platform === 'darwin' ? app.name : messages.application,
    [
      {
        label: development === undefined ? messages.pluginsMenu : messages.pluginsMenuPackagedOnly,
        ...(process.platform === 'win32' ? {} : { accelerator: 'CmdOrCtrl+,' }),
        enabled: development === undefined,
        click: openPluginWindow,
      },
      { label: messages.checkUpdatesMenu, click: () => { void checkAndPrompt(true) } },
      { type: 'separator' },
      { role: 'quit', label: messages.quit },
    ],
    messages,
  )))
  }
  refreshMenu()
  ipcMain.handle(DESKTOP_IPC.localeSet, (event, language: unknown) => {
    assertDesktopSender(event, ['app'])
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('dsh desktop: language updates require the primary application frame')
    }
    if (typeof language !== 'string' || language.length > 64 || !/^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/.test(language)) {
      throw new Error('dsh desktop: invalid application language')
    }
    const next = resolveDesktopLocale(language)
    if (next.id === locale.id) return
    locale = next
    currentDesktopLocale = next
    messages = next.messages
    refreshMenu()
    tray?.refresh()
    if (pluginWindow !== undefined && !pluginWindow.isDestroyed()) pluginWindow.setTitle(messages.pluginWindowTitle)
  })

  const publishPreferences = (): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.preferencesState, preferences)
    }
  }
  /** The session a notification click must open, held until a document can take it. */
  let pendingActivation: string | undefined
  const deliverActivation = (): void => {
    const sessionId = pendingActivation
    const window = mainWindow
    if (sessionId === undefined || window === undefined || window.isDestroyed()) return
    // Only the application document owns session navigation; a startup or
    // emergency document has no session list to open into.
    if (!window.webContents.getURL().startsWith(applicationUrl)) return
    pendingActivation = undefined
    window.webContents.send(DESKTOP_IPC.notificationsActivate, sessionId)
  }
  /** Raised notifications the shell keeps referenced until they settle. */
  const notificationLifetime = new DesktopNotificationLifetime()
  const notificationCenter = new DesktopNotificationCenter({
    ports: {
      isSupported: () => Notification.isSupported(),
      // A focused window already shows the state the notification would carry.
      isForeground: () => {
        const window = mainWindow
        return window !== undefined && !window.isDestroyed() && window.isFocused()
      },
      show({ title, body }, onActivate) {
        const notification = new Notification({ title, body })
        notificationLifetime.hold(notification, onActivate)
        notification.show()
      },
    },
    messages: () => messages,
    onActivate: (sessionId) => {
      pendingActivation = sessionId
      focusPrimaryWindow()
      deliverActivation()
    },
  })
  notificationCenter.setEnabled(preferences.notificationsEnabled)

  const hideMainWindow = (): void => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) return
    window.hide()
  }

  /**
   * Answer one close with the tray or the exit path.
   *
   * The remembered answer is written immediately, so a choice made here also
   * reaches the settings surface without a restart. The remembered behavior is
   * a preference, never a lock: the settings surface can restore the prompt.
   */
  const requestCloseDecision = async (): Promise<void> => {
    const window = mainWindow
    const prompt = desktopClosePrompt(messages)
    const result = window === undefined || window.isDestroyed()
      ? await dialog.showMessageBox(prompt)
      : await dialog.showMessageBox(window, prompt)
    const decision = closeDecisionFromResult(result)
    if (decision.remember) {
      preferences = { ...preferences, closeBehavior: decision.action === 'tray' ? 'tray' : 'exit' }
      writeDesktopPreferences(paths.root, preferences)
      publishPreferences()
    }
    if (decision.action === 'tray') hideMainWindow()
    else app.quit()
  }

  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, true)
    mainWindow = window
    window.on('closed', () => { if (mainWindow === window) mainWindow = undefined })
    // Closing the primary window is the shell's decision, not the renderer's:
    // a tray answer hides the window while the Host and its tasks keep running,
    // and an exit answer goes through the single quit path that stops them.
    // Without a tray there is no way back to a hidden window, so the historical
    // close-means-quit behavior stays in force.
    window.on('close', (event) => {
      if (quitting || shellInstallerOwnsQuit || tray === undefined) return
      event.preventDefault()
      if (preferences.closeBehavior === 'exit') {
        app.quit()
        return
      }
      if (preferences.closeBehavior === 'tray') {
        hideMainWindow()
        return
      }
      // One prompt per close request: a second click cannot stack dialogs.
      if (closePrompt !== undefined) return
      closePrompt = requestCloseDecision().catch((error: unknown) => {
        console.error('desktop close prompt failed', error)
      }).finally(() => { closePrompt = undefined })
    })
    // A notification click may arrive while the window is still loading the
    // application document; the pending identity is delivered once it is there.
    window.webContents.on('did-finish-load', () => { deliverActivation() })
    window.webContents.on('preload-error', (_event, _path, error) => {
      void showEmergencyError(error).catch((failure: unknown) => { console.error(failure) })
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      navigation = undefined
      emergencyDocument = false
      void showStartupError(new Error(`Desktop renderer exited: ${details.reason}`))
        .catch((failure: unknown) => { console.error(failure) })
    })
    return window
  }
  focusPrimaryWindow = () => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) {
      createMainWindow()
      void navigateMain(backendState().phase === 'ready' ? applicationUrl : startupUrl)
        .catch((error: unknown) => { console.error(error) })
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  // The tray is the way back to a window the close prompt hid. Electron exposes
  // the same Tray API on Windows, macOS, and Linux; a platform without a usable
  // notification area is handled by createDesktopTray's undefined result and
  // keeps the close path on its safe exit behavior.
  tray = createDesktopTray({
    iconPath: join(app.getAppPath(), 'renderer', 'tray-icon.png'),
    messages: () => messages,
    onOpen: () => { focusPrimaryWindow() },
    onExit: () => { app.quit() },
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) focusPrimaryWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('will-quit', () => {
    // The icon must leave the notification area before the process does, or
    // Windows keeps drawing it until the user hovers over it.
    tray?.dispose()
    tray = undefined
    notificationLifetime.releaseAll()
  })
  app.on('before-quit', (event) => {
    if (shellInstallerOwnsQuit || quitting) return
    event.preventDefault()
    quitting = true
    void backend.close().catch((error: unknown) => { console.error(error) }).finally(() => { app.quit() })
  })

  mainWindow = createMainWindow()
  await reconcileBackend().catch(() => undefined)
  // Window lifecycle callbacks run while backend startup is pending.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (quitting) return
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (mainWindow !== undefined && development !== undefined && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }
  publishUpdate(updateState)
  setTimeout(() => { void checkAndPrompt(false) }, 10_000)
}

const ownsDesktopInstance = claimDesktopSingleInstance(app, () => { focusPrimaryWindow() })

if (ownsDesktopInstance) void app.whenReady().then(main).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error)
  const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE
  if (diagnosticFile !== undefined) {
    await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => undefined)
  }
  const window = BrowserWindow.getAllWindows()[0] ?? createWindow(fileURLToPath(new URL('./preload-app.cjs', import.meta.url)), true)
  window.once('closed', () => { app.quit() })
  await showEmergencyDocument(window, message)
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
