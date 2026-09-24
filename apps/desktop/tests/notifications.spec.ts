import { describe, expect, it, vi } from 'vitest'
import { en, zh, type DesktopMessages } from '../src/locale.ts'
import {
  DesktopNotificationCenter,
  DesktopNotificationLifetime,
  NOTIFICATION_LIFETIME_LIMIT,
  NOTIFICATION_TITLE_CODE_POINTS,
  parseDesktopNotificationReport,
  sanitizeSessionTitle,
  type DesktopNotificationPorts,
  type DesktopNotificationReport,
  type HeldDesktopNotification,
} from '../src/notifications.ts'

function report(overrides: Partial<DesktopNotificationReport> = {}): DesktopNotificationReport {
  return { id: 'run-1', kind: 'finished', sessionId: 'session-1', title: 'Release notes', ...overrides }
}

function ports(overrides: Partial<DesktopNotificationPorts> = {}): DesktopNotificationPorts & {
  readonly show: ReturnType<typeof vi.fn>
} {
  return {
    isSupported: () => true,
    isForeground: () => false,
    show: vi.fn(),
    ...overrides,
  } as DesktopNotificationPorts & { readonly show: ReturnType<typeof vi.fn> }
}

function center(
  native: DesktopNotificationPorts,
  onActivate = vi.fn(),
  messages: () => DesktopMessages = () => en,
): DesktopNotificationCenter {
  return new DesktopNotificationCenter({ ports: native, messages, onActivate })
}

describe('desktop notification report validation', () => {
  it('accepts a complete report and rejects anything else', () => {
    expect(parseDesktopNotificationReport(report())).toEqual(report())
    for (const invalid of [
      undefined,
      null,
      'finished',
      {},
      { ...report(), id: '' },
      { ...report(), sessionId: '' },
      { ...report(), kind: 'done' },
      { ...report(), title: 7 },
      { ...report(), id: 'x'.repeat(201) },
      { ...report(), title: 'x'.repeat(4097) },
    ]) {
      expect(parseDesktopNotificationReport(invalid)).toBeUndefined()
    }
  })
})

describe('desktop notification title', () => {
  it('collapses control characters and whitespace into one line', () => {
    expect(sanitizeSessionTitle('  Fix\u0000the\n\nparser\trun  ')).toBe('Fix the parser run')
  })

  it('bounds the title on code points without splitting a surrogate pair', () => {
    const title = '🐋'.repeat(NOTIFICATION_TITLE_CODE_POINTS + 5)
    const bounded = sanitizeSessionTitle(title)
    expect(Array.from(bounded)).toHaveLength(NOTIFICATION_TITLE_CODE_POINTS)
    expect(bounded.endsWith('🐋')).toBe(true)
  })
})

describe('desktop notification center', () => {
  it('shows localized status copy for every kind and drops message content', () => {
    for (const [kind, copy] of [
      ['finished', en.notificationFinished],
      ['failed', en.notificationFailed],
      ['approval', en.notificationApproval],
      ['input', en.notificationInput],
    ] as const) {
      const native = ports()
      expect(center(native).report(report({ id: `id-${kind}`, kind }))).toBe('shown')
      expect(native.show).toHaveBeenCalledWith(
        { title: en.notificationTitle, body: `${copy}\nRelease notes` },
        expect.any(Function),
      )
    }
  })

  it('speaks the requested language', () => {
    const native = ports()
    center(native, vi.fn(), () => zh).report(report())
    expect(native.show).toHaveBeenCalledWith(
      { title: zh.notificationTitle, body: `${zh.notificationFinished}\nRelease notes` },
      expect.any(Function),
    )
  })

  it('omits the title line when the session has no display title', () => {
    const native = ports()
    center(native).report(report({ title: '   ' }))
    expect(native.show).toHaveBeenCalledWith(
      { title: en.notificationTitle, body: en.notificationFinished },
      expect.any(Function),
    )
  })

  it('opens the reported session when the notification is clicked', () => {
    const native = ports()
    const onActivate = vi.fn()
    center(native, onActivate).report(report({ sessionId: 'session-42' }))
    const onClick = native.show.mock.calls[0]?.[1] as () => void
    onClick()
    expect(onActivate).toHaveBeenCalledWith('session-42')
  })

  it('drops a repeat of one event and remembers a bounded window of identities', () => {
    const native = ports()
    const notifications = center(native)
    expect(notifications.report(report())).toBe('shown')
    expect(notifications.report(report())).toBe('duplicate')
    expect(native.show).toHaveBeenCalledOnce()

    for (let index = 0; index < 200; index += 1) {
      notifications.report(report({ id: `run-${String(index + 2)}` }))
    }
    // The first identity aged out of the bounded window, so re-reporting it is
    // a new event again rather than a silent drop forever.
    expect(notifications.report(report())).toBe('shown')
  })

  it('stays silent while disabled, unsupported, or already in the foreground', () => {
    const disabled = ports()
    const notifications = center(disabled)
    notifications.setEnabled(false)
    expect(notifications.isEnabled).toBe(false)
    expect(notifications.report(report({ id: 'a' }))).toBe('disabled')
    expect(notifications.report(report({ id: 'b' }))).toBe('disabled')
    notifications.setEnabled(true)
    expect(notifications.isEnabled).toBe(true)
    expect(notifications.report(report({ id: 'c' }))).toBe('shown')

    const unsupported = ports({ isSupported: () => false })
    expect(center(unsupported).report(report())).toBe('unsupported')

    const foreground = ports({ isForeground: () => true })
    expect(center(foreground).report(report())).toBe('suppressed')
    expect(foreground.show).not.toHaveBeenCalled()
  })

  it('contains a platform failure so one notification cannot break the shell', () => {
    const failing = ports({ show: vi.fn(() => { throw new Error('no notification service') }) })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(center(failing).report(report())).toBe('unsupported')
    expect(logged).toHaveBeenCalledWith('desktop notification could not be raised', expect.any(Error))
    logged.mockRestore()
  })
})

describe('desktop notification lifetime', () => {
  /** One raised notification double that reports the events it receives. */
  function raised(): HeldDesktopNotification & { readonly events: string[]; fire(event: 'click' | 'close'): void } {
    const listeners = new Map<string, () => void>()
    return {
      events: [],
      on(event, listener) { listeners.set(event, listener); this.events.push(event) },
      fire(event) { listeners.get(event)?.() },
    }
  }

  it('holds a raised notification until it is clicked or closed', () => {
    const lifetime = new DesktopNotificationLifetime()
    const onActivate = vi.fn()
    const first = raised()
    const second = raised()
    lifetime.hold(first, onActivate)
    lifetime.hold(second, vi.fn())
    expect(lifetime.held).toBe(2)
    // Both settle paths release the reference, so a long-lived process does not
    // accumulate notifications the user has already dealt with.
    second.fire('close')
    expect(lifetime.held).toBe(1)
    first.fire('click')
    expect(onActivate).toHaveBeenCalledOnce()
    expect(lifetime.held).toBe(0)
  })

  it('bounds what it holds when a platform never reports a close', () => {
    const lifetime = new DesktopNotificationLifetime()
    const first = raised()
    lifetime.hold(first, vi.fn())
    for (let index = 0; index < NOTIFICATION_LIFETIME_LIMIT; index += 1) {
      lifetime.hold(raised(), vi.fn())
    }
    expect(lifetime.held).toBe(NOTIFICATION_LIFETIME_LIMIT)
    lifetime.releaseAll()
    expect(lifetime.held).toBe(0)
  })
})
