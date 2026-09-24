const api = window.dshDesktop

async function main() {
  const locale = await api.locale()
  const messages = locale.messages
  const message = (key, values = {}) => messages[key].replaceAll(/\{([^{}]+)\}/gu, (placeholder, name) => values[name] ?? placeholder)
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.pluginManagerTitle
  document.querySelector('#title').textContent = messages.pluginManagerTitle
  document.querySelector('#description').textContent = messages.pluginManagerDescription
  document.querySelector('#refresh').textContent = messages.refresh
  document.querySelector('#package-label').textContent = messages.npmPackage
  document.querySelector('#install').textContent = messages.install
  document.querySelector('#installed-heading').textContent = messages.installed
  document.querySelector('#empty').textContent = messages.noPlugins

  document.querySelector('#recovery-description').textContent = messages.recoveryDescription
  document.querySelector('#retry').textContent = messages.retry
  document.querySelector('#disable-all').textContent = messages.disableAll

  document.querySelector('#environment-heading').textContent = messages.environmentTitle
  document.querySelector('#environment-intro').textContent = messages.environmentIntro
  document.querySelector('#environment-current-label').textContent = messages.environmentCurrent.replace('{name}', '')
  document.querySelector('#environment-selected-label').textContent = messages.environmentSelected.replace('{name}', '')
  document.querySelector('#environment-restart').textContent = messages.environmentRestartRequired
  document.querySelector('#environment-distribution-label').textContent = messages.environmentDistribution
  document.querySelector('#environment-distribution-hint').textContent = messages.environmentDistributionHint
  document.querySelector('#environment-reload').textContent = messages.environmentLoadDistributions
  document.querySelector('#environment-apply').textContent = messages.environmentApply

  document.querySelector('#window-settings-heading').textContent = messages.windowSettingsTitle
  document.querySelector('#window-settings-intro').textContent = messages.windowSettingsIntro
  document.querySelector('#close-behavior-label').textContent = messages.closeBehaviorLabel
  document.querySelector('#notifications-label').textContent = messages.notificationsLabel
  document.querySelector('#notifications-description').textContent = messages.notificationsDescription

  const list = document.querySelector('#plugins')
  const empty = document.querySelector('#empty')
  const status = document.querySelector('#status')
  const form = document.querySelector('#install-form')
  const input = document.querySelector('#package-spec')
  const refresh = document.querySelector('#refresh')
  const distribution = document.querySelector('#environment-distribution')
  const closeBehavior = document.querySelector('#close-behavior')
  const notificationsEnabled = document.querySelector('#notifications-enabled')
  const windowSettingsStatus = document.querySelector('#window-settings-status')
  closeBehavior.replaceChildren(...[
    ['ask', messages.closeBehaviorAsk],
    ['tray', messages.closeBehaviorTray],
    ['exit', messages.closeBehaviorExit],
  ].map(([value, label]) => {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    return option
  }))

  /** Show the preferences the shell currently has in effect. */
  function renderPreferences(preferences) {
    closeBehavior.value = preferences.closeBehavior
    notificationsEnabled.checked = preferences.notificationsEnabled
  }

  /**
   * Apply one preference change.
   *
   * The shell owns the stored value and answers with it, so a rejected change
   * leaves the controls showing what is actually in effect.
   */
  async function savePreferences(update) {
    try {
      renderPreferences(await api.preferences.set(update))
      windowSettingsStatus.textContent = messages.preferencesSaved
    } catch (error) {
      renderPreferences(await api.preferences.get())
      windowSettingsStatus.textContent = error instanceof Error ? error.message : String(error)
    }
  }

  closeBehavior.addEventListener('change', () => void savePreferences({ closeBehavior: closeBehavior.value }))
  notificationsEnabled.addEventListener('change', () => void savePreferences({
    notificationsEnabled: notificationsEnabled.checked,
  }))
  // A remembered close answer is written by the shell, not this window, so the
  // open surface follows it.
  api.preferences.subscribe(renderPreferences)

  /** Name one environment the way the locale describes it. */
  function environmentName(kind, distro) {
    if (kind !== 'wsl2') return messages.environmentWindowsNative
    return message('environmentWsl2', { distro: distro ?? '' })
  }

  /** Describe why one distribution cannot host the Harness. */
  function problemText(problem, nodeVersion) {
    switch (problem) {
      case 'not-wsl2': return messages.environmentProblemNotWsl2
      case 'unreachable': return messages.environmentProblemUnreachable
      case 'node-missing': return messages.environmentProblemNodeMissing
      case 'node-too-old': return messages.environmentProblemNodeTooOld
      case 'host-missing': return messages.environmentProblemHostMissing
      default: return nodeVersion === undefined ? '' : messages.environmentNode.replace('{version}', nodeVersion)
    }
  }

  function renderEnvironment(state) {
    document.querySelector('#environment-current').textContent = environmentName(state.current, state.currentDistro)
    document.querySelector('#environment-selected').textContent = environmentName(state.selected, state.selectedDistro)
    document.querySelector('#environment-restart').hidden = !state.restartRequired
    const unavailable = document.querySelector('#environment-unavailable')
    unavailable.hidden = state.unavailable === undefined
    unavailable.textContent = state.unavailable === undefined ? '' : unavailableText(state)
    document.querySelector('#environment-distribution').disabled = state.distributions.length === 0
    const nativeOption = document.createElement('option')
    nativeOption.value = ''
    nativeOption.textContent = messages.environmentWindowsNative
    nativeOption.selected = state.selected !== 'wsl2'
    distribution.replaceChildren(nativeOption, ...state.distributions.map(entry => {
      const option = document.createElement('option')
      option.value = entry.name
      const detail = problemText(entry.problem, entry.nodeVersion)
      option.textContent = detail === '' ? entry.name : `${entry.name} — ${detail}`
      option.disabled = entry.problem !== undefined
      option.selected = entry.name === state.selectedDistro
      return option
    }))
  }

  /** Explain why WSL2 cannot be offered here. */
  function unavailableText(state) {
    switch (state.unavailable) {
      case 'not-windows': return messages.environmentUnavailableNotWindows
      case 'not-installed': return messages.environmentUnavailableNotInstalled
      case 'no-usable-distribution':
        return message('environmentUnavailableNoUsable', {
          detail: state.distributions.map(entry => `${entry.name}: ${problemText(entry.problem, entry.nodeVersion)}`).join('; '),
        })
      default: return ''
    }
  }

  async function loadEnvironment(statusMessage) {
    if (statusMessage !== undefined) status.textContent = statusMessage
    renderEnvironment(await api.environment.status())
  }

  function setBusy(busy, statusMessage = '') {
    for (const control of document.querySelectorAll('button, input')) control.disabled = busy
    status.textContent = statusMessage
  }

  async function render() {
    const backend = await api.backend.status()
    document.querySelector('#recovery').hidden = backend.phase !== 'error'
    document.querySelector('#startup-error').textContent = backend.phase === 'error' ? backend.message : ''
    const plugins = await api.plugins.list()
    list.replaceChildren(...plugins.map(plugin => {
      const item = document.createElement('li')
      const identity = document.createElement('span')
      const version = document.createElement('span')
      version.className = 'package-version'
      version.textContent = plugin.enabled ? plugin.version : `${plugin.version} · ${messages.disabled}`
      identity.append(document.createTextNode(plugin.name), version)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = messages.remove
      remove.addEventListener('click', () => void run(
        () => api.plugins.remove(plugin.name),
        message('removing', { name: plugin.name }),
      ))
      const update = document.createElement('button')
      update.type = 'button'
      update.textContent = messages.update
      update.addEventListener('click', () => {
        const next = window.prompt(message('targetVersion', { name: plugin.name }), plugin.version)?.trim()
        if (next === undefined || next === '' || next === plugin.version) return
        void run(() => api.plugins.update(plugin.name, next), message('updating', { name: plugin.name }))
      })
      const actions = document.createElement('span')
      actions.className = 'package-actions'
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.textContent = plugin.enabled ? messages.disable : messages.enable
      toggle.addEventListener('click', () => void run(
        () => api.plugins.toggle(plugin.name, !plugin.enabled), messages.changingActivation,
      ))
      actions.append(toggle, update, remove)
      item.append(identity, actions)
      return item
    }))
    empty.hidden = plugins.length !== 0
  }

  async function run(operation, statusMessage) {
    setBusy(true, statusMessage)
    try {
      await operation()
      await render()
      status.textContent = messages.operationComplete
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  async function load(statusMessage, success) {
    setBusy(true, statusMessage)
    try {
      await render()
      status.textContent = success
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const spec = input.value.trim()
    if (spec === '') return
    void run(async () => {
      await api.plugins.add(spec)
      input.value = ''
    }, message('installing', { spec }))
  })
  document.querySelector('#retry').addEventListener('click', () => void run(() => api.backend.retry(), messages.retry))
  document.querySelector('#disable-all').addEventListener('click', () => void run(() => api.plugins.disableAll(), messages.changingActivation))
  refresh.addEventListener('click', () => void load(messages.refreshing, messages.refreshed))
  document.querySelector('#environment-reload').addEventListener('click', () => void run(
    () => loadEnvironment(), messages.environmentLoading,
  ))
  document.querySelector('#environment-apply').addEventListener('click', () => void run(async () => {
    // The empty value is the Windows Native entry; any other value names an
    // installed distribution that already passed its usability probe.
    const selection = distribution.value === ''
      ? { environment: 'windows-native' }
      : { environment: 'wsl2', distro: distribution.value }
    renderEnvironment(await api.environment.select(selection))
  }, messages.environmentApplied))

  await loadEnvironment()
  renderPreferences(await api.preferences.get())
  await load(messages.loadingPlugins, '')
}

void main()
