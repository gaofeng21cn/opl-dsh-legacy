import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/locale.ts'
import { closeDecisionFromResult, desktopClosePrompt, CLOSE_PROMPT_TRAY_ANSWER } from '../src/close-prompt.ts'

describe('desktop close prompt', () => {
  it('offers the tray answer first and as the escape answer', () => {
    const prompt = desktopClosePrompt(en)
    expect(prompt.buttons).toEqual(['Keep in Tray', 'Exit'])
    expect(prompt.defaultId).toBe(CLOSE_PROMPT_TRAY_ANSWER)
    expect(prompt.cancelId).toBe(CLOSE_PROMPT_TRAY_ANSWER)
    expect(prompt.checkboxLabel).toBe(en.closePromptRemember)
    expect(prompt.checkboxChecked).toBe(false)
    expect(prompt.detail).toContain('tray')
  })

  it('carries the Chinese copy from the shipped dictionary', () => {
    const prompt = desktopClosePrompt(zh)
    expect(prompt.buttons).toEqual(['收进托盘', '退出'])
    expect(prompt.message).toBe(zh.closePromptMessage)
  })

  it('reads the tray answer and the remembered flag', () => {
    expect(closeDecisionFromResult({ response: 0, checkboxChecked: true }))
      .toEqual({ action: 'tray', remember: true })
    expect(closeDecisionFromResult({ response: 0, checkboxChecked: false }))
      .toEqual({ action: 'tray', remember: false })
    expect(closeDecisionFromResult({ response: 1, checkboxChecked: true }))
      .toEqual({ action: 'exit', remember: true })
    // An answer the platform never offered still resolves to a real behavior
    // rather than leaving the window in an undecided state.
    expect(closeDecisionFromResult({ response: 7, checkboxChecked: false }))
      .toEqual({ action: 'exit', remember: false })
  })
})
