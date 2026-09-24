/** Project-membership action; its destination dialog outlives this menu. */
import { IconBranchOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MoveSessionInjected, SessionMenuItemProps } from '../contract/slots.ts'

/**
 * Open the project destination chooser for a Session.
 * @param props - row identity, menu state, locale, and move command.
 * @returns the menu row.
 */
export function MoveSessionMenuItem({ sessionId, useMenuOpenState, requestSessionMove, t }: SessionMenuItemProps<MoveSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton icon={<IconBranchOutlineRegular />} onSelect={() => {
      setMenuOpen(false)
      requestSessionMove(sessionId)
    }}>
      {t('menu.moveSession')}
    </MenuItemButton>
  )
}
